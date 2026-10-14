from datetime import date
from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, File, Form, Query, Request, UploadFile, status
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool
from pydantic import ValidationError
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.api.v1.files import build_download_response
from app.core.errors import NotFoundError, ValidationFailedError
from app.core.permissions import OrgAdmin, OrgManager, OrgViewer
from app.db.session import get_db
from app.models.catalog import Party, Recording, Work
from app.models.platform import BackgroundJob
from app.models.royalty import RoyaltyAllocation, RoyaltyRun, RoyaltyStatement, StatementLine
from app.schemas.common import MessageResponse, Page, PageParams, page_of, paginate
from app.schemas.royalty import (
    AllocationResponse,
    BulkMatchRequest,
    LineMatchUpdate,
    ManualStatementCreate,
    MappingUpdate,
    ReasonRequest,
    ReconciliationResponse,
    RunResponse,
    RunSummaryRow,
    StatementLineResponse,
    StatementMeta,
    StatementPreview,
    StatementResponse,
    StatementUpdate,
    UnmatchedGroup,
)
from app.services import jobs, reports, royalty_import, royalty_runs, storage
from app.services.statement_parsing import ADAPTERS, CANONICAL_FIELDS

router = APIRouter(prefix="/organizations/{organization_id}/royalties", tags=["Royalties"])


def _statement_payload(statement: RoyaltyStatement) -> dict:
    data = StatementResponse.model_validate(statement).model_dump()
    data["file_name"] = statement.file.original_filename if statement.file else None
    return data


def _run_payload(db: Session, run: RoyaltyRun) -> dict:
    data = RunResponse.model_validate(run).model_dump()
    statement = db.get(RoyaltyStatement, run.statement_id)
    if statement:
        data["statement_source"] = statement.source_name
        data["statement_period_end"] = statement.period_end
    return data


# --------------------------------------------------------------------------- statements


@router.get("/adapters")
def list_adapters(ctx: OrgViewer):
    """Supported statement formats and the canonical fields columns map to."""
    return {
        "adapters": [{"key": a.key, "label": a.label, "description": a.description}
                     for a in ADAPTERS.values()],
        "canonical_fields": CANONICAL_FIELDS,
    }


@router.post("/statements", response_model=StatementResponse, status_code=status.HTTP_201_CREATED)
async def upload_statement(
    ctx: OrgManager,
    request: Request,
    file: UploadFile = File(...),
    source_name: str = Form(...),
    source_category: str = Form(...),
    period_start: date = Form(...),
    period_end: date = Form(...),
    currency: str = Form("USD"),
    default_rights_type: str | None = Form(None),
    reported_total: str | None = Form(None),
    notes: str | None = Form(None),
    allow_duplicate: bool = Form(False),
    db: Session = Depends(get_db),
):
    """Upload a CSV/XLSX statement. Identical files are rejected (409) to
    prevent double counting. Returns the statement with a suggested mapping."""
    try:
        meta = StatementMeta(
            source_name=source_name, source_category=source_category, period_start=period_start,
            period_end=period_end, currency=currency, default_rights_type=default_rights_type or None,
            reported_total=Decimal(reported_total) if reported_total else None, notes=notes,
        )
    except (ValidationError, ArithmeticError) as exc:
        details = (exc.errors(include_url=False, include_input=False, include_context=False)
                   if isinstance(exc, ValidationError) else None)
        raise ValidationFailedError("Invalid statement details", details=details) from exc
    data = await storage.read_upload(file)
    # Parsing and DB work are synchronous: run them off the event loop so a
    # large or hostile file can't stall every other request (audit AF-01).
    statement = await run_in_threadpool(
        royalty_import.create_from_upload, db, ctx, meta, file.filename, data, request,
        allow_duplicate=allow_duplicate,
    )
    return _statement_payload(statement)


@router.post("/statements/manual", response_model=StatementResponse, status_code=status.HTTP_201_CREATED)
def create_manual_statement(payload: ManualStatementCreate, ctx: OrgManager, request: Request,
                            db: Session = Depends(get_db)):
    """Record manual adjustments or licensing income without a file."""
    return _statement_payload(royalty_import.create_manual(db, ctx, payload, request))


@router.get("/statements", response_model=Page[StatementResponse])
def list_statements(
    ctx: OrgViewer,
    db: Session = Depends(get_db),
    params: PageParams = Depends(),
    status_filter: Annotated[str | None, Query(alias="status", max_length=20)] = None,
    source_category: Annotated[str | None, Query(max_length=30)] = None,
    q: Annotated[str | None, Query(max_length=120)] = None,
    period_from: date | None = None,
    period_to: date | None = None,
):
    stmt = select(RoyaltyStatement).where(RoyaltyStatement.organization_id == ctx.organization_id)
    if status_filter:
        stmt = stmt.where(RoyaltyStatement.status == status_filter)
    if source_category:
        stmt = stmt.where(RoyaltyStatement.source_category == source_category)
    if q:
        stmt = stmt.where(RoyaltyStatement.source_name.contains(q))
    if period_from:
        stmt = stmt.where(RoyaltyStatement.period_end >= period_from)
    if period_to:
        stmt = stmt.where(RoyaltyStatement.period_end <= period_to)
    rows, total = paginate(
        db, stmt, params,
        sortable={"period_end": RoyaltyStatement.period_end, "created_at": RoyaltyStatement.created_at,
                  "source_name": RoyaltyStatement.source_name, "total_amount": RoyaltyStatement.total_amount},
        default_sort=RoyaltyStatement.created_at.desc(),
    )
    return page_of([_statement_payload(s) for s in rows], total, params)


@router.get("/statements/{statement_id}", response_model=StatementResponse)
def get_statement(statement_id: str, ctx: OrgViewer, db: Session = Depends(get_db)):
    return _statement_payload(royalty_import.get_statement(db, ctx.organization_id, statement_id))


@router.get("/statements/{statement_id}/preview", response_model=StatementPreview)
def preview_statement(statement_id: str, ctx: OrgViewer, db: Session = Depends(get_db)):
    return royalty_import.preview(royalty_import.get_statement(db, ctx.organization_id, statement_id))


@router.put("/statements/{statement_id}/mapping", response_model=StatementResponse)
def update_mapping(statement_id: str, payload: MappingUpdate, ctx: OrgManager, request: Request,
                   db: Session = Depends(get_db)):
    statement = royalty_import.get_statement(db, ctx.organization_id, statement_id)
    return _statement_payload(royalty_import.update_mapping(
        db, ctx, statement, payload.adapter, payload.column_mapping, request))


@router.post("/statements/{statement_id}/process", response_model=StatementResponse,
             status_code=status.HTTP_202_ACCEPTED)
def process_statement(statement_id: str, ctx: OrgManager, request: Request, db: Session = Depends(get_db)):
    """Queue parsing, validation and matching as a background job."""
    statement = royalty_import.get_statement(db, ctx.organization_id, statement_id, lock=True)
    return _statement_payload(royalty_import.request_processing(db, ctx, statement, request))


@router.patch("/statements/{statement_id}", response_model=StatementResponse)
def update_statement(statement_id: str, payload: StatementUpdate, ctx: OrgManager, request: Request,
                     db: Session = Depends(get_db)):
    """Edit statement details. Locked once royalties are posted; changing the
    category, default rights type or period discards unposted calculations."""
    statement = royalty_import.get_statement(db, ctx.organization_id, statement_id, lock=True)
    return _statement_payload(royalty_import.update_metadata(db, ctx, statement, payload, request))


@router.post("/statements/{statement_id}/cancel", response_model=StatementResponse)
def cancel_statement_processing(statement_id: str, ctx: OrgManager, request: Request,
                                db: Session = Depends(get_db)):
    """Cancel queued processing (not possible once the worker has started)."""
    statement = royalty_import.get_statement(db, ctx.organization_id, statement_id, lock=True)
    return _statement_payload(royalty_import.cancel_processing(db, ctx, statement, request))


@router.delete("/statements/{statement_id}", response_model=MessageResponse)
def delete_statement(statement_id: str, ctx: OrgAdmin, request: Request, db: Session = Depends(get_db)):
    statement = royalty_import.get_statement(db, ctx.organization_id, statement_id, lock=True)
    royalty_import.delete_statement(db, ctx, statement, request)
    return MessageResponse(message="Statement deleted")


@router.get("/statements/{statement_id}/download")
def download_statement_file(statement_id: str, ctx: OrgViewer, db: Session = Depends(get_db)):
    statement = royalty_import.get_statement(db, ctx.organization_id, statement_id)
    if statement.file is None:
        raise NotFoundError("This statement has no source file")
    return build_download_response(statement.file)


# --------------------------------------------------------------------------- lines & matching


@router.get("/statements/{statement_id}/lines", response_model=Page[StatementLineResponse])
def list_lines(
    statement_id: str,
    ctx: OrgViewer,
    db: Session = Depends(get_db),
    params: PageParams = Depends(),
    match_status: Annotated[str | None, Query(max_length=20)] = None,
    valid: bool | None = None,
    q: Annotated[str | None, Query(max_length=120)] = None,
):
    royalty_import.get_statement(db, ctx.organization_id, statement_id)
    stmt = select(StatementLine).where(StatementLine.statement_id == statement_id,
                                       StatementLine.organization_id == ctx.organization_id)
    if match_status:
        stmt = stmt.where(StatementLine.match_status == match_status)
    if valid is not None:
        stmt = stmt.where(StatementLine.is_valid.is_(valid))
    if q:
        stmt = stmt.where(or_(StatementLine.title.contains(q), StatementLine.isrc == q.upper(),
                              StatementLine.artist.contains(q), StatementLine.iswc == q.upper()))
    rows, total = paginate(
        db, stmt, params,
        sortable={"row_number": StatementLine.row_number, "amount": StatementLine.amount,
                  "title": StatementLine.title},
        default_sort=StatementLine.row_number.asc(),
    )
    rec_ids = {r.recording_id for r in rows if r.recording_id}
    work_ids = {r.work_id for r in rows if r.work_id}
    rec_titles = dict(db.execute(select(Recording.id, Recording.title).where(Recording.id.in_(rec_ids))).all()) if rec_ids else {}
    work_titles = dict(db.execute(select(Work.id, Work.title).where(Work.id.in_(work_ids))).all()) if work_ids else {}
    items = []
    for row in rows:
        data = StatementLineResponse.model_validate(row).model_dump()
        data["matched_title"] = rec_titles.get(row.recording_id) or work_titles.get(row.work_id)
        items.append(data)
    return page_of(items, total, params)


@router.patch("/statements/{statement_id}/lines/{line_id}", response_model=StatementLineResponse)
def match_line(statement_id: str, line_id: str, payload: LineMatchUpdate, ctx: OrgManager,
               request: Request, db: Session = Depends(get_db)):
    statement = royalty_import.get_statement(db, ctx.organization_id, statement_id, lock=True)
    line = db.scalar(select(StatementLine).where(StatementLine.id == line_id,
                                                 StatementLine.statement_id == statement.id))
    if line is None:
        raise NotFoundError("Statement line not found")
    if not line.is_valid:
        raise ValidationFailedError("Invalid lines cannot be matched; fix the source file and reprocess")
    royalty_import.apply_match(db, ctx, statement, [line], payload.action, payload.recording_id,
                               payload.work_id, request)
    db.refresh(line)
    return line


@router.post("/statements/{statement_id}/lines/bulk-match")
def bulk_match(statement_id: str, payload: BulkMatchRequest, ctx: OrgManager, request: Request,
               db: Session = Depends(get_db)):
    """Match many lines at once — either explicit ids or every unmatched line
    sharing the ISRC / title (/ artist) of ``key_line_id``."""
    statement = royalty_import.get_statement(db, ctx.organization_id, statement_id, lock=True)
    stmt = select(StatementLine).where(StatementLine.statement_id == statement.id,
                                       StatementLine.is_valid.is_(True))
    if payload.line_ids:
        stmt = stmt.where(StatementLine.id.in_(payload.line_ids))
    else:
        key = db.scalar(select(StatementLine).where(StatementLine.id == payload.key_line_id,
                                                    StatementLine.statement_id == statement.id))
        if key is None:
            raise NotFoundError("Key line not found")
        stmt = stmt.where(StatementLine.match_status == "unmatched")
        if payload.match_key == "isrc":
            if not key.isrc:
                raise ValidationFailedError("The key line has no ISRC")
            stmt = stmt.where(StatementLine.isrc == key.isrc)
        else:
            stmt = stmt.where(StatementLine.title == key.title)
            if payload.match_key == "title_artist":
                stmt = stmt.where(StatementLine.artist == key.artist)
    lines = list(db.scalars(stmt).all())
    changed = royalty_import.apply_match(db, ctx, statement, lines, payload.action,
                                         payload.recording_id, payload.work_id, request)
    return {"updated": changed}


@router.post("/statements/{statement_id}/rematch")
def rematch_statement(statement_id: str, ctx: OrgManager, request: Request, db: Session = Depends(get_db)):
    """Re-run automatic matching for unmatched lines (e.g. after adding catalog items)."""
    statement = royalty_import.get_statement(db, ctx.organization_id, statement_id, lock=True)
    return {"newly_matched": royalty_import.rematch(db, ctx, statement, request)}


@router.get("/unmatched", response_model=Page[UnmatchedGroup])
def unmatched_transactions(ctx: OrgViewer, db: Session = Depends(get_db), params: PageParams = Depends()):
    """Unmatched lines across unposted statements, grouped by identifier/title."""
    stmt = (
        select(StatementLine.statement_id, RoyaltyStatement.source_name, StatementLine.isrc,
               StatementLine.iswc, StatementLine.title, StatementLine.artist, func.count(),
               func.sum(StatementLine.amount), StatementLine.currency, func.min(StatementLine.id))
        .join(RoyaltyStatement, RoyaltyStatement.id == StatementLine.statement_id)
        .where(StatementLine.organization_id == ctx.organization_id,
               StatementLine.match_status == "unmatched", StatementLine.is_valid.is_(True),
               RoyaltyStatement.status != "posted")
        .group_by(StatementLine.statement_id, RoyaltyStatement.source_name, StatementLine.isrc,
                  StatementLine.iswc, StatementLine.title, StatementLine.artist, StatementLine.currency)
    )
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = db.execute(stmt.order_by(func.sum(StatementLine.amount).desc())
                      .offset(params.offset).limit(params.page_size)).all()
    items = [
        {"statement_id": r[0], "statement_source": r[1], "isrc": r[2], "iswc": r[3], "title": r[4],
         "artist": r[5], "line_count": r[6], "amount": r[7] or Decimal("0"), "currency": r[8],
         "sample_line_id": r[9]}
        for r in rows
    ]
    return page_of(items, total, params)


@router.get("/statements/{statement_id}/reconciliation", response_model=ReconciliationResponse)
def reconciliation(statement_id: str, ctx: OrgViewer, db: Session = Depends(get_db)):
    statement = royalty_import.get_statement(db, ctx.organization_id, statement_id)
    line_currency = func.coalesce(StatementLine.currency, statement.currency)
    rows = db.execute(
        select(StatementLine.is_valid, StatementLine.match_status, line_currency, func.count(),
               func.coalesce(func.sum(StatementLine.amount), 0))
        .where(StatementLine.statement_id == statement.id)
        .group_by(StatementLine.is_valid, StatementLine.match_status, line_currency)
    ).all()
    counts = {"valid": 0, "invalid": 0, "ignored": 0, "matched": 0, "unmatched": 0}
    amounts = {"matched": Decimal("0"), "unmatched": Decimal("0"), "ignored": Decimal("0")}
    other: dict[str, Decimal] = {}
    for is_valid, match_status, currency, count, subtotal in rows:
        subtotal = Decimal(subtotal)
        if not is_valid:
            counts["invalid"] += count
            continue
        counts["valid"] += count
        counts[match_status] = counts.get(match_status, 0) + count
        if currency != statement.currency:
            if match_status != "ignored":
                other[currency] = other.get(currency, Decimal("0")) + subtotal
            continue
        if match_status in amounts:
            amounts[match_status] += subtotal
    total = amounts["matched"] + amounts["unmatched"]
    latest = db.scalar(select(RoyaltyRun).where(RoyaltyRun.statement_id == statement.id,
                                                RoyaltyRun.status.in_(("calculated", "posted")))
                       .order_by(RoyaltyRun.created_at.desc()))
    return {
        "statement_id": statement.id, "currency": statement.currency,
        "total_rows": counts["valid"] + counts["invalid"], "valid_rows": counts["valid"],
        "invalid_rows": counts["invalid"], "ignored_rows": counts["ignored"],
        "matched_rows": counts["matched"], "unmatched_rows": counts["unmatched"],
        "statement_total": total, "matched_amount": amounts["matched"],
        "unmatched_amount": amounts["unmatched"], "ignored_amount": amounts["ignored"],
        "reported_total": statement.reported_total,
        "reported_difference": (total - statement.reported_total) if statement.reported_total is not None else None,
        "other_currency_totals": {k: format(v, "f") for k, v in sorted(other.items())},
        "latest_run": None if latest is None else {
            "id": latest.id, "status": latest.status, "total_payable": format(latest.total_payable, "f"),
            "total_retained": format(latest.total_retained, "f"),
            "total_unallocated": format(latest.total_unallocated, "f"),
        },
    }


# --------------------------------------------------------------------------- runs


@router.post("/statements/{statement_id}/calculate", response_model=RunResponse,
             status_code=status.HTTP_201_CREATED)
def calculate(statement_id: str, ctx: OrgManager, request: Request, db: Session = Depends(get_db)):
    """Calculate royalties for a processed statement (does not touch the ledger)."""
    return _run_payload(db, royalty_runs.calculate(db, ctx, statement_id, request))


@router.get("/runs", response_model=Page[RunResponse])
def list_runs(ctx: OrgViewer, db: Session = Depends(get_db), params: PageParams = Depends(),
              statement_id: Annotated[str | None, Query(max_length=36)] = None,
              status_filter: Annotated[str | None, Query(alias="status", max_length=20)] = None):
    stmt = select(RoyaltyRun).where(RoyaltyRun.organization_id == ctx.organization_id)
    if statement_id:
        stmt = stmt.where(RoyaltyRun.statement_id == statement_id)
    if status_filter:
        stmt = stmt.where(RoyaltyRun.status == status_filter)
    rows, total = paginate(db, stmt, params, sortable={"created_at": RoyaltyRun.created_at},
                           default_sort=RoyaltyRun.created_at.desc())
    return page_of([_run_payload(db, r) for r in rows], total, params)


@router.get("/runs/{run_id}", response_model=RunResponse)
def get_run(run_id: str, ctx: OrgViewer, db: Session = Depends(get_db)):
    return _run_payload(db, royalty_runs.get_run(db, ctx.organization_id, run_id))


@router.get("/runs/{run_id}/allocations", response_model=Page[AllocationResponse])
def list_allocations(
    run_id: str, ctx: OrgViewer, db: Session = Depends(get_db), params: PageParams = Depends(),
    allocation_type: Annotated[Literal["payable", "retained", "unallocated"] | None, Query()] = None,
    party_id: Annotated[str | None, Query(max_length=36)] = None,
    reason: Annotated[str | None, Query(max_length=60)] = None,
    line_id: Annotated[str | None, Query(max_length=36)] = None,
):
    run = royalty_runs.get_run(db, ctx.organization_id, run_id)
    stmt = select(RoyaltyAllocation).where(RoyaltyAllocation.run_id == run.id)
    if allocation_type:
        stmt = stmt.where(RoyaltyAllocation.allocation_type == allocation_type)
    if party_id:
        stmt = stmt.where(RoyaltyAllocation.party_id == party_id)
    if reason:
        stmt = stmt.where(RoyaltyAllocation.reason == reason)
    if line_id:
        stmt = stmt.where(RoyaltyAllocation.line_id == line_id)
    rows, total = paginate(db, stmt, params, sortable={"amount": RoyaltyAllocation.amount},
                           default_sort=RoyaltyAllocation.amount.desc())
    party_ids = {r.party_id for r in rows if r.party_id}
    names = dict(db.execute(select(Party.id, Party.name).where(Party.id.in_(party_ids))).all()) if party_ids else {}
    items = []
    for row in rows:
        data = AllocationResponse.model_validate(row).model_dump()
        data["party_name"] = names.get(row.party_id)
        items.append(data)
    return page_of(items, total, params)


@router.get("/runs/{run_id}/summary", response_model=list[RunSummaryRow])
def run_summary(run_id: str, ctx: OrgViewer, db: Session = Depends(get_db),
                group_by: Literal["party", "reason", "rights_type"] = "party"):
    run = royalty_runs.get_run(db, ctx.organization_id, run_id)
    column = {"party": RoyaltyAllocation.party_id, "reason": RoyaltyAllocation.reason,
              "rights_type": RoyaltyAllocation.rights_type}[group_by]
    rows = db.execute(
        select(column, RoyaltyAllocation.allocation_type, RoyaltyAllocation.currency,
               func.sum(RoyaltyAllocation.amount), func.count())
        .where(RoyaltyAllocation.run_id == run.id)
        .group_by(column, RoyaltyAllocation.allocation_type, RoyaltyAllocation.currency)
    ).all()
    names: dict[str, str] = {}
    if group_by == "party":
        ids = {r[0] for r in rows if r[0]}
        names = dict(db.execute(select(Party.id, Party.name).where(Party.id.in_(ids))).all()) if ids else {}
    result = [
        {"key": r[0], "label": names.get(r[0], r[0]) if group_by == "party" else r[0],
         "allocation_type": r[1], "currency": r[2], "amount": r[3], "count": r[4]}
        for r in rows
    ]
    return sorted(result, key=lambda r: Decimal(r["amount"]), reverse=True)


@router.post("/runs/{run_id}/verify")
def verify_run(run_id: str, ctx: OrgViewer, db: Session = Depends(get_db)):
    """Recompute the run from current data and report whether it reproduces."""
    return royalty_runs.verify(db, ctx, run_id)


@router.post("/runs/{run_id}/post", response_model=RunResponse)
def post_run(run_id: str, ctx: OrgAdmin, request: Request, db: Session = Depends(get_db)):
    """Post payable allocations to the payee ledger (admin)."""
    return _run_payload(db, royalty_runs.post(db, ctx, run_id, request))


@router.post("/runs/{run_id}/reverse", response_model=RunResponse)
def reverse_run(run_id: str, payload: ReasonRequest, ctx: OrgAdmin, request: Request,
                db: Session = Depends(get_db)):
    """Reverse a posted run with offsetting ledger entries (history is kept)."""
    return _run_payload(db, royalty_runs.reverse(db, ctx, run_id, payload.reason, request))


@router.post("/runs/{run_id}/discard", response_model=RunResponse)
def discard_run(run_id: str, ctx: OrgManager, request: Request, db: Session = Depends(get_db)):
    return _run_payload(db, royalty_runs.discard(db, ctx, run_id, request))


# --------------------------------------------------------------------------- reports


@router.get("/reports/types")
def report_types(ctx: OrgViewer):
    return reports.REPORT_TYPES


@router.get("/reports/{report_type}")
def run_report(report_type: str, ctx: OrgViewer, db: Session = Depends(get_db),
               period_start: date | None = None, period_end: date | None = None,
               currency: Annotated[str | None, Query(min_length=3, max_length=3)] = None,
               limit: Annotated[int, Query(ge=1, le=1000)] = 200):
    return reports.run_report(db, ctx.organization_id, report_type, start=period_start, end=period_end,
                              currency=currency.upper() if currency else None, limit=limit)


@router.post("/reports/{report_type}/export", status_code=status.HTTP_202_ACCEPTED)
def export_report(report_type: str, ctx: OrgViewer, db: Session = Depends(get_db),
                  period_start: date | None = None, period_end: date | None = None,
                  currency: Annotated[str | None, Query(min_length=3, max_length=3)] = None):
    if report_type not in reports.REPORT_TYPES:
        raise ValidationFailedError("Unknown report type")
    job = jobs.enqueue(
        db, organization_id=ctx.organization_id, job_type="report_generation",
        created_by_id=ctx.user.id, max_attempts=2,
        payload={"report_type": report_type,
                 "period_start": period_start.isoformat() if period_start else None,
                 "period_end": period_end.isoformat() if period_end else None,
                 "currency": currency.upper() if currency else None},
    )
    return {"job_id": job.id, "status": job.status}


@router.get("/reports/exports/{job_id}/download")
def download_export(job_id: str, ctx: OrgViewer, db: Session = Depends(get_db)):
    job = db.scalar(select(BackgroundJob).where(BackgroundJob.id == job_id,
                                                BackgroundJob.organization_id == ctx.organization_id,
                                                BackgroundJob.job_type == "report_generation"))
    if job is None:
        raise NotFoundError("Export not found")
    if job.status != "succeeded" or not job.result:
        raise ValidationFailedError(f"Export is {job.status}", code="export_not_ready")
    record = storage.get_org_file(db, ctx.organization_id, job.result["file_id"])
    return build_download_response(record)
