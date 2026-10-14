"""Machine-to-machine API used by n8n (``/api/v1/automation``).

Authentication: ``Authorization: Bearer rfa_<key_id>_<secret>`` (an
organization-scoped automation credential, see ``/organizations/{id}/automation``).
The organization is always the credential's own: there is no way to address
another tenant. Mutating calls (except ``events/claim``) require an
``Idempotency-Key`` header; replays return the stored response.

Deliberately absent: posting or reversing royalty runs, approving or paying
payouts, editing ownership shares. Those stay human-only on the JWT API.
"""

from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, Header, Query, Request, UploadFile, status
from pydantic import ValidationError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.core.errors import ConflictError, ValidationFailedError
from app.db.session import get_db
from app.schemas.automation import (
    AIReviewRequest,
    AlertRequest,
    ConflictReviewRequest,
    ContractReminderRequest,
    EventAck,
    EventClaim,
    MetadataReviewRequest,
    MonthlyReportRequest,
    ReportSendRequest,
    RunFinish,
    RunStart,
    StatementReviewRequest,
)
from app.schemas.royalty import StatementMeta
from app.services import royalty_import, storage
from app.services.automation import events, operations, records
from app.services.automation.context import AutomationContext, require_scope
from app.services.automation.idempotency import request_fingerprint, run_idempotent

router = APIRouter(prefix="/automation", tags=["Automation (n8n)"])

IdemKey = Annotated[str | None, Header(alias="Idempotency-Key")]


def _ctx(scope: str):
    return Annotated[AutomationContext, Depends(require_scope(scope))]


ReadCtx = _ctx("automation:read")
RunsCtx = _ctx("runs:write")
EventsCtx = _ctx("events:consume")
ImportCtx = _ctx("statements:import")
ReviewCtx = _ctx("statements:review")
ContractsCtx = _ctx("contracts:read")
NotifyCtx = _ctx("notifications:send")
ReportsCtx = _ctx("reports:deliver")
AICtx = _ctx("ai:review")


# --------------------------------------------------------------------------- identity / health


@router.get("/whoami")
def whoami(actx: ReadCtx):
    """Which organization and scopes this key grants. Workflows call this first
    instead of hard-coding an organization id."""
    return operations.whoami(actx)


@router.get("/health")
def health(actx: ReadCtx, db: Session = Depends(get_db)):
    """API, database, credential expiry, outbox backlog and recent failed runs."""
    return operations.health(db, actx)


# --------------------------------------------------------------------------- runs / alerts


@router.post("/runs", status_code=status.HTTP_201_CREATED)
def start_run(payload: RunStart, actx: RunsCtx, request: Request, idem: IdemKey = None,
              db: Session = Depends(get_db)):
    def handler():
        run, replayed = records.start_run(db, actx, workflow=payload.workflow, trigger_type=payload.trigger_type,
                                          execution_id=payload.execution_id,
                                          idempotency_key=payload.idempotency_key, event_id=payload.event_id)
        return (200 if replayed else 201), {**records.run_payload(run), "replayed": replayed}
    return run_idempotent(db, actx, request, idem, request_fingerprint(payload.model_dump()), handler)


@router.post("/runs/{run_id}/finish")
def finish_run(run_id: str, payload: RunFinish, actx: RunsCtx, request: Request, idem: IdemKey = None,
               db: Session = Depends(get_db)):
    def handler():
        run = records.finish_run(db, actx, run_id, status=payload.status, summary=payload.summary,
                                 error_code=payload.error_code, error_message=payload.error_message)
        return 200, records.run_payload(run)
    return run_idempotent(db, actx, request, idem, request_fingerprint(run_id, payload.model_dump()), handler)


@router.post("/alerts")
def raise_alert(payload: AlertRequest, actx: RunsCtx, request: Request, idem: IdemKey = None,
                db: Session = Depends(get_db)):
    """Record a workflow failure. Every failure is logged; admins are alerted once
    per incident (grouped by workflow, error category and resource) with a
    suppression window, escalation and a recovery notice (N8N-03)."""
    def handler():
        return 200, operations.raise_alert(db, actx, workflow=payload.workflow, execution_id=payload.execution_id,
                                           run_id=payload.run_id, error_code=payload.error_code,
                                           error_message=payload.error_message, resource=payload.resource)
    return run_idempotent(db, actx, request, idem, request_fingerprint(payload.model_dump()), handler)


# --------------------------------------------------------------------------- outbox


@router.get("/statements/{statement_id}/automation")
def statement_automation_state(statement_id: str, actx: ReviewCtx, db: Session = Depends(get_db)):
    """Automation's processing state for one statement (attempts, retry time, category)."""
    from app.services.automation import statement_flow

    statement = royalty_import.get_statement(db, actx.organization_id, statement_id)
    return statement_flow.state_payload(statement_flow.get_state(db, statement, lock=False))


@router.post("/events/claim")
def claim_events(payload: EventClaim, actx: EventsCtx, db: Session = Depends(get_db)):
    """Lease up to ``limit`` due events. Acknowledge each with the returned
    ``lease_token`` before the lease expires, or it becomes claimable again."""
    token, claimed = events.claim_events(
        db, organization_id=actx.organization_id, credential_id=actx.credential.id,
        event_types=payload.event_types, limit=payload.limit, lease_seconds=payload.lease_seconds)
    return {"lease_token": token, "count": len(claimed),
            "events": [events.event_payload(e, include_lease=True) for e in claimed]}


@router.post("/events/{event_id}/ack")
def ack_event(event_id: str, payload: EventAck, actx: EventsCtx, request: Request, idem: IdemKey = None,
              db: Session = Depends(get_db)):
    def handler():
        event = events.ack_event(db, organization_id=actx.organization_id, event_id=event_id,
                                 lease_token=payload.lease_token, outcome=payload.outcome, error=payload.error,
                                 correlation_id=actx.correlation_id)
        return 200, events.event_payload(event)
    return run_idempotent(db, actx, request, idem, request_fingerprint(event_id, payload.model_dump()), handler)


# --------------------------------------------------------------------------- statements (Workflow A)


@router.post("/statements", status_code=status.HTTP_201_CREATED)
async def upload_statement(
    actx: ImportCtx,
    request: Request,
    file: UploadFile = File(...),
    source_name: str = Form(..., max_length=255),
    source_category: str = Form(...),
    period_start: date = Form(...),
    period_end: date = Form(...),
    currency: str = Form("USD"),
    default_rights_type: str | None = Form(None),
    reported_total: str | None = Form(None),
    idem: IdemKey = None,
    db: Session = Depends(get_db),
):
    """Upload a statement through the same validation as the app (file type,
    size, archive safety, parsing). Every distinct file (by SHA-256) gets an
    explicit outcome: ``imported``, ``duplicate`` (200 with the existing
    statement; automation can't override duplicate protection) or ``rejected``
    (4xx, recorded once with a review task)."""
    from app.core.errors import AppError
    from app.services.automation import statement_flow

    filename = file.filename
    read_error: AppError | None = None
    try:
        data = await storage.read_upload(file)
    except AppError as exc:
        data, read_error = None, exc
    digest = statement_flow.sha256(data) if data is not None else statement_flow.sha256(
        b"unreadable:" + (filename or "").encode("utf-8"))

    def handler():
        if read_error is not None:
            return operations.inbox_rejected(db, actx, digest=digest, file_name=filename, exc=read_error)
        try:
            meta = StatementMeta(
                source_name=source_name, source_category=source_category, period_start=period_start,
                period_end=period_end, currency=currency, default_rights_type=default_rights_type or None,
                reported_total=Decimal(reported_total) if reported_total else None,
                notes="Imported by automation",
            )
        except (ValidationError, InvalidOperation, ArithmeticError) as exc:
            details = (exc.errors(include_url=False, include_input=False, include_context=False)
                       if isinstance(exc, ValidationError) else None)
            invalid = ValidationFailedError("Invalid statement details (check the file name convention)",
                                            details=details)
            return operations.inbox_rejected(db, actx, digest=digest, file_name=filename, exc=invalid)
        try:
            statement = royalty_import.create_from_upload(db, actx.org, meta, filename, data, request)
        except ConflictError as exc:
            if exc.code != "duplicate_statement":
                return operations.inbox_rejected(db, actx, digest=digest, file_name=filename, exc=exc)
            # Already imported (same bytes or same rows): report it instead of failing,
            # so a re-run of the workflow just continues with the existing statement.
            db.rollback()
            existing = (exc.details or {}).get("statement_id")
            inbox = operations.inbox_accepted(db, actx, digest=digest, file_name=filename,
                                              statement_id=existing, duplicate=True)
            return 200, {**operations.statement_status(db, actx, existing), "duplicate": True,
                         "duplicate_match": (exc.details or {}).get("match", "file"), "inbox_file": inbox}
        except AppError as exc:
            return operations.inbox_rejected(db, actx, digest=digest, file_name=filename, exc=exc)
        inbox = operations.inbox_accepted(db, actx, digest=digest, file_name=filename,
                                          statement_id=statement.id, duplicate=False)
        return 201, {**operations.statement_status(db, actx, statement.id), "duplicate": False, "inbox_file": inbox}

    fingerprint = request_fingerprint(data if data is not None else (filename or ""), source_name, source_category,
                                      str(period_start), str(period_end), currency, default_rights_type,
                                      reported_total, filename)
    return await run_in_threadpool(run_idempotent, db, actx, request, idem, fingerprint, handler)


@router.post("/statements/{statement_id}/process", status_code=status.HTTP_202_ACCEPTED)
def process_statement(statement_id: str, actx: ImportCtx, request: Request, idem: IdemKey = None,
                      db: Session = Depends(get_db)):
    def handler():
        return 202, operations.start_processing(db, actx, statement_id, request)
    return run_idempotent(db, actx, request, idem, request_fingerprint(statement_id), handler)


@router.get("/statements/{statement_id}")
def statement_status(statement_id: str, actx: ReviewCtx, db: Session = Depends(get_db),
                     wait_seconds: int = Query(0, ge=0, le=60)):
    """With ``wait_seconds``, waits (bounded) until processing has finished."""
    return operations.statement_status(db, actx, statement_id, wait_seconds=wait_seconds)


@router.post("/statements/{statement_id}/review")
def review_statement(statement_id: str, payload: StatementReviewRequest, actx: ReviewCtx, request: Request,
                     idem: IdemKey = None, db: Session = Depends(get_db)):
    """Counts of unmatched/invalid lines and lines *held* by the royalty engine
    (missing or ambiguous contract terms, disputed ownership...). Raises or
    refreshes a review task and notifies managers once per finding set."""
    def handler():
        operations.check_event_lease(db, actx, payload.event_id, payload.lease_token)
        result = operations.review_statement(db, actx, statement_id, calculate=payload.calculate,
                                             run_id=payload.run_id, request=request)
        return 200, operations.complete_event(db, actx, result, payload.event_id, payload.lease_token)
    return run_idempotent(db, actx, request, idem, request_fingerprint(statement_id, payload.model_dump()), handler)


# --------------------------------------------------------------------------- contracts (Workflow B)


@router.get("/contracts/expiring")
def expiring_contracts(actx: ContractsCtx, within_days: int = Query(30, ge=1, le=365),
                       db: Session = Depends(get_db)):
    """Active/pending contracts ending within ``within_days`` (or already past
    their end date). Ids and dates only."""
    items = operations.expiring_contracts(db, actx, within_days)
    return {"within_days": within_days, "count": len(items), "items": items}


@router.post("/contracts/{contract_id}/reminders")
def contract_reminder(contract_id: str, payload: ContractReminderRequest, actx: NotifyCtx, request: Request,
                      idem: IdemKey = None, db: Session = Depends(get_db)):
    """Send one reminder per (contract, end date, threshold) to managers and
    above; repeats return ``duplicate: true`` without notifying again."""
    def handler():
        return 200, operations.contract_reminder(db, actx, contract_id, payload.threshold_days, payload.run_id)
    return run_idempotent(db, actx, request, idem, request_fingerprint(contract_id, payload.model_dump()), handler)


# --------------------------------------------------------------------------- reports (Workflow D)


@router.post("/reports/monthly", status_code=status.HTTP_202_ACCEPTED)
def monthly_report(payload: MonthlyReportRequest, actx: ReportsCtx, request: Request, idem: IdemKey = None,
                   db: Session = Depends(get_db)):
    """Queue the existing report job for a completed month (once per type and
    period). Poll ``GET /automation/jobs/{job_id}``, then send."""
    period = payload.period or operations.previous_month()

    def handler():
        return 202, operations.request_monthly_report(db, actx, period=period, report_type=payload.report_type,
                                                      run_id=payload.run_id)
    return run_idempotent(db, actx, request, idem, request_fingerprint(period, payload.model_dump()), handler)


@router.post("/reports/deliveries/{delivery_id}/send")
def send_report(delivery_id: str, payload: ReportSendRequest, actx: ReportsCtx, request: Request,
                idem: IdemKey = None, db: Session = Depends(get_db)):
    def handler():
        return 200, operations.send_monthly_report(db, actx, delivery_id, payload.recipient_user_id)
    return run_idempotent(db, actx, request, idem, request_fingerprint(delivery_id, payload.model_dump()), handler)


@router.get("/jobs/{job_id}")
def job_status(job_id: str, actx: ReadCtx, db: Session = Depends(get_db),
               wait_seconds: int = Query(0, ge=0, le=60)):
    return operations.job_status(db, actx, job_id, wait_seconds=wait_seconds)


# --------------------------------------------------------------------------- AI review (Workflow C)


@router.post("/ai/review")
def ai_review(payload: AIReviewRequest, actx: AICtx, request: Request, idem: IdemKey = None,
              db: Session = Depends(get_db)):
    """Review any subject (work, recording, party, rights conflict) and, if given,
    acknowledge the outbox event that asked for it."""
    def handler():
        operations.check_event_lease(db, actx, payload.event_id, payload.lease_token)
        result = operations.ai_review(db, actx, payload.subject_type, payload.subject_id, payload.run_id)
        return 200, operations.complete_event(db, actx, result, payload.event_id, payload.lease_token)
    return run_idempotent(db, actx, request, idem, request_fingerprint(payload.model_dump()), handler)


@router.post("/ai/metadata-review")
def metadata_review(payload: MetadataReviewRequest, actx: AICtx, request: Request, idem: IdemKey = None,
                    db: Session = Depends(get_db)):
    """Ask the AI layer for metadata cleanups. Results are stored as *pending*
    suggestions and a review task; nothing changes until a person approves."""
    def handler():
        return 200, operations.ai_metadata_review(db, actx, payload.entity_type, payload.entity_id, payload.run_id)
    return run_idempotent(db, actx, request, idem, request_fingerprint(payload.model_dump()), handler)


@router.post("/ai/conflict-review")
def conflict_review(payload: ConflictReviewRequest, actx: AICtx, request: Request, idem: IdemKey = None,
                    db: Session = Depends(get_db)):
    def handler():
        return 200, operations.ai_conflict_review(db, actx, payload.conflict_id, payload.run_id)
    return run_idempotent(db, actx, request, idem, request_fingerprint(payload.model_dump()), handler)


@router.post("/ai/sync-decisions")
def sync_decisions(actx: AICtx, request: Request, idem: IdemKey = None, db: Session = Depends(get_db)):
    """Close metadata review tasks whose suggestions a person has decided."""
    def handler():
        return 200, operations.sync_ai_decisions(db, actx)
    return run_idempotent(db, actx, request, idem, request_fingerprint("sync"), handler)


@router.get("/ai/suggestions/{suggestion_id}")
def suggestion_status(suggestion_id: str, actx: AICtx, db: Session = Depends(get_db)):
    return operations.ai_suggestion_status(db, actx, suggestion_id)
