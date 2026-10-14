"""Royalty statement intake: upload, preview, column mapping, parsing,
validation and catalog matching (background job ``royalty_import``)."""

import hashlib
import json
import re
import unicodedata
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path

from fastapi import Request
from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.orm import Session

from app.core.errors import ConflictError, NotFoundError, ValidationFailedError
from app.core.permissions import OrgContext
from app.db.mixins import utc_now
from app.models.catalog import Party, Recording, RecordingWork, Release, ReleaseTrack, Work
from app.models.organization import Organization
from app.models.platform import BackgroundJob
from app.models.royalty import RoyaltyAllocation, RoyaltyRun, RoyaltyStatement, StatementLine
from app.schemas.royalty import ManualStatementCreate, StatementMeta, StatementUpdate
from app.services import billing, jobs, storage
from app.services.audit import record_audit
from app.services.identifiers import (
    is_valid_isrc,
    is_valid_iswc,
    normalize_isrc,
    normalize_iswc,
    normalize_upc,
)
from app.services.notifications import notify_user
from app.services.organization_service import org_settings
from app.services.reference import normalize_territory
from app.services.statement_parsing import (
    ADAPTERS,
    detect_date_order,
    detect_decimal_separator,
    CANONICAL_FIELDS,
    IDENTIFYING_FIELDS,
    detect_adapter,
    parse_date,
    parse_decimal,
    parse_rights_type,
    read_table,
)

PREVIEW_ROWS = 20
INSERT_CHUNK = 1000
# Unposted states; reprocessing a calculated statement discards its unposted runs.
MUTABLE_STATUSES = ("uploaded", "processed", "failed", "calculated")


def get_statement(db: Session, organization_id: str, statement_id: str, *, lock: bool = False) -> RoyaltyStatement:
    stmt = select(RoyaltyStatement).where(
        RoyaltyStatement.id == statement_id, RoyaltyStatement.organization_id == organization_id
    )
    if lock:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    statement = db.scalar(stmt)
    if statement is None:
        raise NotFoundError("Statement not found")
    return statement


def _has_posted_run(db: Session, statement_id: str) -> bool:
    return db.scalar(
        select(RoyaltyRun.id).where(RoyaltyRun.statement_id == statement_id, RoyaltyRun.status == "posted")
    ) is not None


def _has_financial_history(db: Session, statement_id: str) -> bool:
    """Posted or reversed runs: their allocations explain ledger entries, so the
    statement lines they reference must never be deleted or replaced."""
    return db.scalar(
        select(RoyaltyRun.id).where(RoyaltyRun.statement_id == statement_id,
                                    RoyaltyRun.status.in_(("posted", "reversed")))
    ) is not None


# --------------------------------------------------------------------------- upload


def content_fingerprint(headers: list[str], rows: list[dict[str, str]]) -> str:
    """Order-, encoding- and whitespace-insensitive hash of statement content."""
    normalized_headers = [h.strip().casefold() for h in headers]
    body = sorted(
        json.dumps([(row.get(h) or "").strip() for h in headers], ensure_ascii=False) for row in rows
    )
    payload = json.dumps([normalized_headers, body], ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _find_duplicate(db: Session, organization_id: str, *, file_sha256: str | None,
                    content_sha256: str) -> RoyaltyStatement | None:
    conditions = [RoyaltyStatement.content_sha256 == content_sha256]
    if file_sha256:
        conditions.append(RoyaltyStatement.file_sha256 == file_sha256)
    return db.scalar(select(RoyaltyStatement).where(
        RoyaltyStatement.organization_id == organization_id, or_(*conditions)).limit(1))


def create_from_upload(db: Session, ctx: OrgContext, meta: StatementMeta, filename: str | None,
                       data: bytes, request: Request | None, *,
                       allow_duplicate: bool = False) -> RoyaltyStatement:
    upload = storage.validate_bytes(filename, data, "statement")
    exact = db.scalar(select(RoyaltyStatement).where(
        RoyaltyStatement.organization_id == ctx.organization_id,
        RoyaltyStatement.file_sha256 == upload.sha256))
    if exact is not None:
        # Byte-identical files can never be re-imported (unique per org).
        raise ConflictError("This exact file was already imported", code="duplicate_statement",
                            details={"statement_id": exact.id, "status": exact.status})
    billing.check_limit(db, ctx.organization_id, "max_statement_imports_per_month")
    table = read_table(upload.data, upload.extension)
    content_hash = content_fingerprint(table.headers, table.rows)
    duplicate = _find_duplicate(db, ctx.organization_id, file_sha256=None, content_sha256=content_hash)
    if duplicate is not None and not allow_duplicate:
        raise ConflictError(
            "A statement with the same rows was already imported (the file differs only in "
            "formatting). Re-importing would count this income twice.",
            code="duplicate_statement",
            details={"statement_id": duplicate.id, "status": duplicate.status, "match": "content"},
        )
    adapter = detect_adapter(table.headers)
    stored = storage.store_file(
        db, organization_id=ctx.organization_id, category="statement", upload=upload,
        created_by_id=ctx.user.id,
    )
    statement = RoyaltyStatement(
        organization_id=ctx.organization_id,
        created_by_id=ctx.user.id,
        file_id=stored.id,
        file_sha256=upload.sha256,
        content_sha256=content_hash,
        adapter=adapter.key,
        column_mapping=adapter.suggest_mapping(table.headers),
        total_rows=len(table.rows),
        status="uploaded",
        **meta.model_dump(),
    )
    db.add(statement)
    db.flush()
    record_audit(
        db, action="statement.uploaded", actor_user_id=ctx.user.id,
        organization_id=ctx.organization_id, entity_type="statement", entity_id=statement.id,
        summary=f"Uploaded {upload.filename} ({len(table.rows)} rows) from {meta.source_name}"
                + (" — confirmed duplicate of an earlier statement" if duplicate is not None else ""),
        changes={"duplicate_override_of": duplicate.id} if duplicate is not None else None,
        request=request,
    )
    if not ctx.user.is_service_account:
        # Outbox event, committed atomically with the statement. Uploads made by
        # the automation itself already drive their own processing.
        from app.services.automation.events import emit_event_if_enabled

        emit_event_if_enabled(db, organization_id=ctx.organization_id, event_type="statement.uploaded",
                   payload={"statement_id": statement.id, "source_category": statement.source_category,
                            "uploaded_by_user_id": ctx.user.id},
                   dedupe_key=f"statement.uploaded:{statement.id}")
    db.commit()
    db.refresh(statement)
    return statement


def load_table(statement: RoyaltyStatement):
    if statement.file is None:
        raise ValidationFailedError("This statement has no source file")
    data = storage.read_file(statement.file)
    return read_table(data, Path(statement.file.original_filename).suffix)


def preview(statement: RoyaltyStatement) -> dict:
    table = load_table(statement)
    adapter = detect_adapter(table.headers)
    return {
        "statement_id": statement.id,
        "headers": table.headers,
        "sample_rows": table.rows[:PREVIEW_ROWS],
        "total_rows": len(table.rows),
        "detected_adapter": adapter.key,
        "suggested_mapping": adapter.suggest_mapping(table.headers),
        "current_mapping": statement.column_mapping,
        "canonical_fields": CANONICAL_FIELDS,
        "adapters": [{"key": a.key, "label": a.label, "description": a.description} for a in ADAPTERS.values()],
    }


def update_mapping(db: Session, ctx: OrgContext, statement: RoyaltyStatement, adapter_key: str,
                   mapping: dict[str, str], request: Request | None) -> RoyaltyStatement:
    if statement.status not in MUTABLE_STATUSES:
        raise ConflictError(f"Mapping cannot change while the statement is {statement.status}")
    if adapter_key not in ADAPTERS:
        raise ValidationFailedError("Unknown adapter", details={"adapters": list(ADAPTERS)})
    table = load_table(statement)
    clean = {k: v for k, v in mapping.items() if v}
    unknown_fields = set(clean) - set(CANONICAL_FIELDS)
    unknown_headers = {v for v in clean.values() if v not in table.headers}
    if unknown_fields or unknown_headers:
        raise ValidationFailedError(
            "Mapping references unknown fields or columns",
            details={"unknown_fields": sorted(unknown_fields), "unknown_columns": sorted(unknown_headers)},
        )
    if "amount" not in clean:
        raise ValidationFailedError("Map a column to 'amount' (net amount payable)")
    if not any(f in clean for f in IDENTIFYING_FIELDS):
        raise ValidationFailedError("Map at least one identifying column (ISRC, ISWC, UPC or title)")
    statement.adapter = adapter_key
    statement.column_mapping = clean
    _confirm_mapping(db, ctx, statement)
    record_audit(
        db, action="statement.mapping_updated", actor_user_id=ctx.user.id,
        organization_id=ctx.organization_id, entity_type="statement", entity_id=statement.id,
        changes={"mapping": clean, "adapter": adapter_key}, request=request,
    )
    db.commit()
    db.refresh(statement)
    return statement


def _confirm_mapping(db: Session, ctx: OrgContext, statement: RoyaltyStatement) -> None:
    """Record a person's mapping confirmation and tell automation it may proceed."""
    if ctx.user.is_service_account:
        return
    statement.mapping_confirmed_at = utc_now()
    statement.mapping_confirmed_by_id = ctx.user.id
    from app.services.automation.events import emit_event_if_enabled

    emit_event_if_enabled(db, organization_id=ctx.organization_id, event_type="statement.ready",
                          payload={"statement_id": statement.id, "reason": "mapping_confirmed"},
                          dedupe_key=f"statement.ready:{statement.id}:{statement.mapping_confirmed_at:%Y%m%d%H%M%S%f}")


def request_processing(db: Session, ctx: OrgContext, statement: RoyaltyStatement,
                       request: Request | None) -> RoyaltyStatement:
    if statement.status not in MUTABLE_STATUSES:
        raise ConflictError(f"Statement is {statement.status}; it cannot be (re)processed")
    if _has_financial_history(db, statement.id):
        raise ConflictError(
            "Royalties from this statement were posted (and possibly reversed). Its lines are part of "
            "the financial record and cannot be replaced; upload a corrected statement instead.",
            code="statement_has_history",
        )
    if not statement.column_mapping or "amount" not in statement.column_mapping:
        raise ValidationFailedError("Configure the column mapping before processing")
    job = jobs.enqueue(
        db,
        organization_id=ctx.organization_id,
        job_type="royalty_import",
        payload={"statement_id": statement.id},
        created_by_id=ctx.user.id,
        # One job per processing request; the status check above prevents double submits.
        idempotency_key=f"royalty_import:{statement.id}:{utc_now():%Y%m%d%H%M%S%f}",
        commit=False,
    )
    statement.status = "queued"
    statement.job_id = job.id
    if statement.mapping_confirmed_at is None:
        # A person processing the statement accepts its mapping (automation does not).
        _confirm_mapping(db, ctx, statement)
    record_audit(
        db, action="statement.processing_requested", actor_user_id=ctx.user.id,
        organization_id=ctx.organization_id, entity_type="statement", entity_id=statement.id,
        request=request,
    )
    db.commit()
    db.refresh(statement)
    return statement


# --------------------------------------------------------------------------- matching


def _norm_text(value: str | None) -> str:
    if not value:
        return ""
    value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode().lower()
    value = re.sub(r"\((feat|ft|with)\.?[^)]*\)|\[(feat|ft)\.?[^\]]*\]", "", value)
    value = re.sub(r"\s+(feat|ft)\.?\s+.*$", "", value)
    value = re.sub(r"\s*-\s*(remaster(ed)?|radio edit|single version).*$", "", value)
    return re.sub(r"[^a-z0-9]", "", value)


@dataclass
class CatalogIndex:
    by_isrc: dict[str, str]
    by_iswc: dict[str, str]
    release_tracks: dict[str, list[tuple[str, str]]]  # upc -> [(recording_id, norm title)]
    recordings_by_title: dict[str, list[tuple[str, str]]]  # norm title -> [(id, norm artist)]
    works_by_title: dict[str, list[str]]
    recording_titles: dict[str, str]
    work_titles: dict[str, str]
    linked_works: dict[str, list[str]]


def build_index(db: Session, organization_id: str) -> CatalogIndex:
    party_names = dict(db.execute(
        select(Party.id, Party.name).where(Party.organization_id == organization_id)
    ).all())
    by_isrc: dict[str, str] = {}
    recordings_by_title: dict[str, list[tuple[str, str]]] = {}
    recording_titles: dict[str, str] = {}
    for rid, title, isrc, artist, artist_id in db.execute(
        select(Recording.id, Recording.title, Recording.isrc, Recording.display_artist,
               Recording.primary_artist_id)
        .where(Recording.organization_id == organization_id, Recording.status != "archived")
    ).all():
        recording_titles[rid] = title
        if isrc:
            by_isrc.setdefault(normalize_isrc(isrc) or "", rid)
        artist_name = artist or party_names.get(artist_id) or ""
        recordings_by_title.setdefault(_norm_text(title), []).append((rid, _norm_text(artist_name)))
    by_iswc: dict[str, str] = {}
    works_by_title: dict[str, list[str]] = {}
    work_titles: dict[str, str] = {}
    for wid, title, iswc in db.execute(
        select(Work.id, Work.title, Work.iswc)
        .where(Work.organization_id == organization_id, Work.status != "archived")
    ).all():
        work_titles[wid] = title
        if iswc:
            by_iswc.setdefault(normalize_iswc(iswc) or "", wid)
        works_by_title.setdefault(_norm_text(title), []).append(wid)
    release_tracks: dict[str, list[tuple[str, str]]] = {}
    for upc, rec_id in db.execute(
        select(Release.upc, ReleaseTrack.recording_id)
        .join(ReleaseTrack, ReleaseTrack.release_id == Release.id)
        .where(Release.organization_id == organization_id, Release.upc.is_not(None))
    ).all():
        release_tracks.setdefault(normalize_upc(upc) or "", []).append(
            (rec_id, _norm_text(recording_titles.get(rec_id)))
        )
    linked: dict[str, list[str]] = {}
    for rec_id, work_id in db.execute(
        select(RecordingWork.recording_id, RecordingWork.work_id).where(
            RecordingWork.organization_id == organization_id
        )
    ).all():
        linked.setdefault(rec_id, []).append(work_id)
    return CatalogIndex(by_isrc, by_iswc, release_tracks, recordings_by_title, works_by_title,
                        recording_titles, work_titles, linked)


WORK_LEVEL_SOURCES = {"pro", "publishing_admin", "mechanical"}
WORK_LEVEL_RIGHTS = {"performance", "mechanical", "print"}


def match_line(line: StatementLine, index: CatalogIndex, *, work_level: bool,
               allow_title_match: bool) -> None:
    """Populate match fields on an unmatched line in place."""
    line.recording_id = line.work_id = None
    line.match_method = None
    line.match_confidence = None
    if line.isrc and line.isrc in index.by_isrc:
        line.recording_id = index.by_isrc[line.isrc]
        line.match_method, line.match_confidence = "isrc", Decimal("1")
    if line.iswc and line.iswc in index.by_iswc:
        line.work_id = index.by_iswc[line.iswc]
        if not line.match_method:
            line.match_method, line.match_confidence = "iswc", Decimal("1")
    if not line.match_method and line.upc and line.upc in index.release_tracks:
        tracks = index.release_tracks[line.upc]
        title = _norm_text(line.title)
        candidates = [r for r, t in tracks if t == title] if title else []
        if len(tracks) == 1:
            candidates = [tracks[0][0]]
        if len(candidates) == 1:
            line.recording_id = candidates[0]
            line.match_method, line.match_confidence = "upc", Decimal("0.95")
    if not line.match_method and allow_title_match and line.title:
        title, artist = _norm_text(line.title), _norm_text(line.artist)
        if work_level:
            works = index.works_by_title.get(title, [])
            if len(works) == 1:
                line.work_id = works[0]
                line.match_method, line.match_confidence = "title", Decimal("0.7")
        else:
            recordings = index.recordings_by_title.get(title, [])
            if artist:
                exact = [rid for rid, a in recordings if a and a == artist]
                if len(exact) == 1:
                    line.recording_id = exact[0]
                    line.match_method, line.match_confidence = "title_artist", Decimal("0.85")
            if not line.match_method and len(recordings) == 1 and not artist:
                line.recording_id = recordings[0][0]
                line.match_method, line.match_confidence = "title", Decimal("0.6")
    if line.is_valid:
        line.match_status = "matched" if line.match_method else "unmatched"


# --------------------------------------------------------------------------- parsing


def _clip(value: str | None, length: int) -> str | None:
    return value[:length] if value else None


@dataclass
class ColumnFormats:
    """Number and date conventions decided once per column (audit F-H2/F-M1):
    deciding per value made ``0,004`` read as 4 and ``202612`` as January."""

    decimal_separators: dict[str, str]
    date_order: str = "dmy"


NUMERIC_FIELDS = ("amount", "gross_amount", "quantity")


def detect_formats(table, mapping: dict[str, str]) -> ColumnFormats:
    separators = {}
    for field in NUMERIC_FIELDS:
        header = mapping.get(field)
        if header:
            separators[field] = detect_decimal_separator(
                [row.get(header) for row in table.rows], getattr(table, "delimiter", None))
    date_header = mapping.get("transaction_date")
    order = detect_date_order([row.get(date_header) for row in table.rows]) if date_header else "dmy"
    return ColumnFormats(decimal_separators=separators, date_order=order)


QUANTITY_LIMIT = Decimal("1e16")  # DECIMAL(20,4)


def build_line(statement: RoyaltyStatement, row_number: int, row: dict[str, str],
               mapping: dict[str, str], formats: ColumnFormats | None = None) -> StatementLine:
    formats = formats or ColumnFormats(decimal_separators={})

    def get(field: str) -> str | None:
        header = mapping.get(field)
        if not header:
            return None
        value = row.get(header)
        return value.strip() if isinstance(value, str) and value.strip() else None

    errors: list[str] = []
    warnings: list[str] = []

    def number(field: str) -> Decimal | None:
        try:
            value = parse_decimal(get(field), formats.decimal_separators.get(field))
        except (ValueError, ArithmeticError):
            errors.append(f"{field}: '{get(field)}' is not a number")
            return None
        if value is not None:
            if abs(value) >= Decimal("1e12"):
                errors.append(f"{field}: value out of range")
                return None
            return value.quantize(Decimal("0.00000001"))
        return None

    amount = number("amount")
    if get("amount") is None:
        errors.append("amount: missing")
    gross = number("gross_amount")
    quantity = None
    try:
        quantity = parse_decimal(get("quantity"), formats.decimal_separators.get("quantity"))
        if quantity is not None:
            if abs(quantity) >= QUANTITY_LIMIT:
                raise ArithmeticError("out of range")
            quantity = quantity.quantize(Decimal("0.0001"))
    except (ValueError, ArithmeticError):
        # Quantity is informational; a bad cell must never fail the import.
        warnings.append(f"quantity: '{get('quantity')}' is not a usable number")
        quantity = None

    isrc = normalize_isrc(get("isrc"))
    if isrc and not is_valid_isrc(isrc):
        warnings.append(f"isrc: '{get('isrc')}' is not a valid ISRC")
        isrc = isrc[:12]
    iswc = normalize_iswc(get("iswc"))
    if iswc and not is_valid_iswc(iswc):
        warnings.append(f"iswc: '{get('iswc')}' is not a valid ISWC")
        iswc = iswc[:15]
    upc = normalize_upc(get("upc"))
    if upc:
        upc = upc[:14]
    title = get("title")
    if not any([isrc, iswc, upc, title]):
        errors.append("No identifying value (ISRC, ISWC, UPC or title)")

    raw_territory = get("territory")
    territory = normalize_territory(raw_territory)
    if raw_territory and territory is None:
        warnings.append(f"territory: '{raw_territory}' is not a recognized ISO country code")

    currency = (get("currency") or statement.currency).upper()
    if len(currency) != 3 or not currency.isalpha():
        errors.append(f"currency: '{currency}' is not a valid ISO currency code")
        currency = statement.currency

    raw_rights = get("rights_type")
    rights_type = parse_rights_type(raw_rights)
    if raw_rights and rights_type is None:
        warnings.append(f"rights_type: '{raw_rights}' not recognized; statement default used")

    transaction_date = None
    try:
        transaction_date = parse_date(get("transaction_date"), formats.date_order)
    except ValueError:
        warnings.append(f"transaction_date: '{get('transaction_date')}' not recognized; period end used")

    is_valid = not errors
    return StatementLine(
        organization_id=statement.organization_id,
        statement_id=statement.id,
        row_number=row_number,
        raw={k: (v[:500] if isinstance(v, str) else v) for k, v in list(row.items())[:60]},
        title=title[:255] if title else None,
        artist=_clip(get("artist"), 255),
        isrc=isrc,
        iswc=iswc,
        upc=upc,
        territory=territory,
        usage_type=_clip(get("usage_type"), 60),
        rights_type=rights_type,
        store=_clip(get("store"), 120),
        quantity=quantity,
        gross_amount=gross,
        amount=amount,
        currency=currency,
        transaction_date=transaction_date,
        source_reference=_clip(get("source_reference"), 120),
        is_valid=is_valid,
        validation_errors=(errors + warnings) or None,
        match_status="unmatched" if is_valid else "invalid",
    )


def _is_work_level(statement: RoyaltyStatement, line: StatementLine) -> bool:
    rights = line.rights_type or statement.default_rights_type
    if rights:
        return rights in WORK_LEVEL_RIGHTS
    return statement.source_category in WORK_LEVEL_SOURCES


def finalize_counts(db: Session, statement: RoyaltyStatement) -> None:
    line_currency = func.coalesce(StatementLine.currency, statement.currency)
    rows = db.execute(
        select(StatementLine.match_status, StatementLine.is_valid, line_currency, func.count(),
               func.coalesce(func.sum(StatementLine.amount), 0))
        .where(StatementLine.statement_id == statement.id)
        .group_by(StatementLine.match_status, StatementLine.is_valid, line_currency)
    ).all()
    total_rows = valid = invalid = matched = 0
    amount = Decimal("0")
    for status, is_valid, currency, count, subtotal in rows:
        total_rows += count
        if is_valid:
            valid += count
            # Only the statement currency: never add amounts across currencies
            # (other currencies are reported separately by reconciliation).
            if status != "ignored" and currency == statement.currency:
                amount += Decimal(subtotal)
        else:
            invalid += count
        if status == "matched":
            matched += count
    statement.total_rows = total_rows
    statement.valid_rows = valid
    statement.error_rows = invalid
    statement.matched_rows = matched
    statement.total_amount = amount


@jobs.job_handler("royalty_import", on_failure=lambda db, ctx, msg: _mark_failed(db, ctx, msg))
def process_statement_job(db: Session, ctx: jobs.JobContext) -> dict:
    statement_id = ctx.payload["statement_id"]
    statement = get_statement(db, ctx.organization_id, statement_id, lock=True)
    if statement.status not in ("queued", "processing", *MUTABLE_STATUSES):
        raise jobs.PermanentJobError(f"Statement is {statement.status}")
    if _has_financial_history(db, statement.id):
        raise jobs.PermanentJobError("Statement has posted or reversed royalties and cannot be reprocessed")
    statement.status = "processing"
    db.commit()

    try:
        table = load_table(statement)
    except ValidationFailedError as exc:
        raise jobs.PermanentJobError(exc.message) from exc
    mapping = statement.column_mapping or {}
    missing = [h for h in mapping.values() if h not in table.headers]
    if missing:
        raise jobs.PermanentJobError(f"Mapped columns not found in file: {', '.join(missing)}")

    # Parsing released the lock; re-acquire it and re-check that nothing else
    # (a cancel, a post, another worker) changed the statement meanwhile.
    statement = get_statement(db, ctx.organization_id, statement_id, lock=True)
    if statement.status != "processing" or _has_financial_history(db, statement.id):
        raise jobs.PermanentJobError(
            f"Statement changed while processing (now {statement.status}); nothing was replaced")

    # Re-processing replaces unposted lines: discard unposted runs and remove
    # their allocations explicitly (allocations -> lines is ON DELETE RESTRICT).
    db.execute(update(RoyaltyRun).where(RoyaltyRun.statement_id == statement.id,
                                        RoyaltyRun.status == "calculated").values(status="discarded"))
    stale_runs = select(RoyaltyRun.id).where(RoyaltyRun.statement_id == statement.id,
                                             RoyaltyRun.status == "discarded")
    db.execute(delete(RoyaltyAllocation).where(RoyaltyAllocation.run_id.in_(stale_runs)))
    db.execute(delete(StatementLine).where(StatementLine.statement_id == statement.id))
    db.flush()

    organization = db.get(Organization, ctx.organization_id)
    allow_title = org_settings(organization).auto_match_title_artist if organization else True
    index = build_index(db, ctx.organization_id)
    error_samples: list[dict] = []
    batch: list[StatementLine] = []
    total = len(table.rows)
    formats = detect_formats(table, mapping)
    for i, row in enumerate(table.rows, start=1):
        line = build_line(statement, i + 1, row, mapping, formats)  # +1: header is row 1
        if line.is_valid:
            match_line(line, index, work_level=_is_work_level(statement, line),
                       allow_title_match=allow_title)
        elif len(error_samples) < 200:
            error_samples.append({"row": line.row_number, "errors": line.validation_errors})
        batch.append(line)
        if len(batch) >= INSERT_CHUNK:
            db.add_all(batch)
            db.flush()
            batch.clear()
            ctx.progress(int(i / max(total, 1) * 95))
    db.add_all(batch)
    db.flush()

    finalize_counts(db, statement)
    statement.errors = error_samples or None
    statement.status = "processed"
    statement.processed_at = utc_now()
    record_audit(
        db, action="statement.processed", actor_user_id=ctx.created_by_id,
        organization_id=ctx.organization_id, entity_type="statement", entity_id=statement.id,
        summary=f"{statement.valid_rows} valid, {statement.error_rows} invalid, "
                f"{statement.matched_rows} matched of {statement.total_rows} rows",
    )
    if ctx.created_by_id:
        notify_user(
            db, user_id=ctx.created_by_id, organization_id=ctx.organization_id,
            type="import_completed", title=f"Statement processed: {statement.source_name}",
            body=f"{statement.matched_rows} of {statement.valid_rows} valid lines matched; "
                 f"{statement.error_rows} rows had errors.",
            link=f"/royalties/statements/{statement.id}",
            severity="warning" if statement.error_rows else "success",
        )
    return {
        "statement_id": statement.id,
        "total_rows": statement.total_rows,
        "valid_rows": statement.valid_rows,
        "error_rows": statement.error_rows,
        "matched_rows": statement.matched_rows,
        "decimal_separators": formats.decimal_separators,
        "date_order": formats.date_order,
    }


def _mark_failed(db: Session, ctx: jobs.JobContext, message: str) -> None:
    statement = db.scalar(
        select(RoyaltyStatement).where(
            RoyaltyStatement.id == ctx.payload.get("statement_id"),
            RoyaltyStatement.organization_id == ctx.organization_id,
        )
    )
    if statement is None or statement.status not in ("queued", "processing"):
        # Only an in-flight import can fail; never overwrite a statement that
        # moved on (posted, cancelled, reprocessed) while the job was running.
        return
    statement.status = "failed"
    statement.errors = [{"row": None, "errors": [message]}]
    if ctx.created_by_id:
        notify_user(
            db, user_id=ctx.created_by_id, organization_id=ctx.organization_id,
            type="import_failed", title=f"Statement import failed: {statement.source_name}",
            body=message[:1000], link=f"/royalties/statements/{statement.id}", severity="error",
        )


# --------------------------------------------------------------------------- manual statements


def manual_fingerprint(payload: ManualStatementCreate) -> str:
    lines = sorted(json.dumps(line.model_dump(mode="json"), sort_keys=True) for line in payload.lines)
    head = [payload.source_name.strip().casefold(), payload.source_category, str(payload.period_start),
            str(payload.period_end), payload.currency]
    return hashlib.sha256(json.dumps([head, lines]).encode("utf-8")).hexdigest()


def create_manual(db: Session, ctx: OrgContext, payload: ManualStatementCreate,
                  request: Request | None) -> RoyaltyStatement:
    content_hash = manual_fingerprint(payload)
    duplicate = _find_duplicate(db, ctx.organization_id, file_sha256=None, content_sha256=content_hash)
    if duplicate is not None and not payload.allow_duplicate:
        raise ConflictError(
            "An identical manual statement (same source, period and lines) already exists.",
            code="duplicate_statement", details={"statement_id": duplicate.id, "match": "content"})
    billing.check_limit(db, ctx.organization_id, "max_statement_imports_per_month")
    meta = payload.model_dump(exclude={"lines", "allow_duplicate"})
    meta["content_sha256"] = content_hash
    statement = RoyaltyStatement(
        organization_id=ctx.organization_id, created_by_id=ctx.user.id, adapter="manual",
        status="processed", processed_at=utc_now(), **meta,
    )
    db.add(statement)
    db.flush()
    index = build_index(db, ctx.organization_id)
    for number, item in enumerate(payload.lines, start=1):
        territory = normalize_territory(item.territory) if item.territory else None
        if item.territory and territory is None:
            raise ValidationFailedError(f"Line {number}: unknown territory '{item.territory}'")
        line = StatementLine(
            organization_id=ctx.organization_id, statement_id=statement.id, row_number=number,
            raw=item.model_dump(mode="json"), title=item.title, isrc=normalize_isrc(item.isrc),
            iswc=normalize_iswc(item.iswc), territory=territory, rights_type=item.rights_type,
            usage_type=item.usage_type or "manual_adjustment",
            amount=item.amount.quantize(Decimal("0.00000001")), currency=statement.currency,
            transaction_date=item.transaction_date, is_valid=True,
            source_reference=_clip(item.description, 120),
        )
        if item.recording_id or item.work_id:
            _assign_target(db, ctx.organization_id, line, item.recording_id, item.work_id)
            line.match_method, line.match_status = "manual", "matched"
            line.match_confidence = Decimal("1")
            line.matched_by_id = ctx.user.id
        else:
            match_line(line, index, work_level=_is_work_level(statement, line), allow_title_match=True)
        db.add(line)
    db.flush()
    finalize_counts(db, statement)
    record_audit(
        db, action="statement.manual_created", actor_user_id=ctx.user.id,
        organization_id=ctx.organization_id, entity_type="statement", entity_id=statement.id,
        summary=f"Manual statement with {len(payload.lines)} line(s)", request=request,
    )
    db.commit()
    db.refresh(statement)
    return statement


# --------------------------------------------------------------------------- manual matching


def _assign_target(db: Session, organization_id: str, line: StatementLine,
                   recording_id: str | None, work_id: str | None) -> None:
    if recording_id:
        recording = db.scalar(select(Recording).where(
            Recording.id == recording_id, Recording.organization_id == organization_id))
        if recording is None:
            raise NotFoundError("Recording not found")
    if work_id:
        work = db.scalar(select(Work).where(Work.id == work_id, Work.organization_id == organization_id))
        if work is None:
            raise NotFoundError("Work not found")
    line.recording_id = recording_id
    line.work_id = work_id


def ensure_editable(db: Session, statement: RoyaltyStatement) -> None:
    if statement.status in ("queued", "processing"):
        raise ConflictError("Statement is being processed")
    if statement.status == "posted" or _has_posted_run(db, statement.id):
        raise ConflictError("Royalties for this statement are posted; lines are immutable",
                            code="statement_posted")


def apply_match(db: Session, ctx: OrgContext, statement: RoyaltyStatement, lines: list[StatementLine],
                action: str, recording_id: str | None, work_id: str | None,
                request: Request | None) -> int:
    ensure_editable(db, statement)
    changed = 0
    for line in lines:
        if not line.is_valid:
            continue
        if action == "ignore":
            line.match_status, line.match_method = "ignored", "manual"
            line.recording_id = line.work_id = None
        elif action == "unmatch":
            line.match_status, line.match_method, line.match_confidence = "unmatched", None, None
            line.recording_id = line.work_id = None
        else:
            _assign_target(db, ctx.organization_id, line, recording_id, work_id)
            line.match_status, line.match_method = "matched", "manual"
            line.match_confidence = Decimal("1")
        line.matched_by_id = ctx.user.id
        changed += 1
    _invalidate_calculations(db, statement)
    finalize_counts(db, statement)
    record_audit(
        db, action=f"statement.lines_{action}ed" if action != "match" else "statement.lines_matched",
        actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
        entity_type="statement", entity_id=statement.id,
        summary=f"{changed} line(s) {action}", changes={"recording_id": recording_id, "work_id": work_id},
        request=request,
    )
    db.commit()
    return changed


def rematch(db: Session, ctx: OrgContext, statement: RoyaltyStatement, request: Request | None) -> int:
    ensure_editable(db, statement)
    organization = ctx.organization
    index = build_index(db, ctx.organization_id)
    lines = db.scalars(select(StatementLine).where(
        StatementLine.statement_id == statement.id, StatementLine.match_status == "unmatched")).all()
    matched = 0
    for line in lines:
        match_line(line, index, work_level=_is_work_level(statement, line),
                   allow_title_match=org_settings(organization).auto_match_title_artist)
        matched += line.match_status == "matched"
    _invalidate_calculations(db, statement)
    finalize_counts(db, statement)
    record_audit(db, action="statement.rematched", actor_user_id=ctx.user.id,
                 organization_id=ctx.organization_id, entity_type="statement",
                 entity_id=statement.id, summary=f"{matched} additional line(s) matched",
                 request=request)
    db.commit()
    return matched


def _invalidate_calculations(db: Session, statement: RoyaltyStatement) -> None:
    """Matching changes make unposted calculations stale."""
    for run in db.scalars(select(RoyaltyRun).where(
            RoyaltyRun.statement_id == statement.id, RoyaltyRun.status == "calculated")):
        run.status = "discarded"
    if statement.status == "calculated":
        statement.status = "processed"


CALCULATION_FIELDS = ("source_category", "default_rights_type", "period_start", "period_end")


def update_metadata(db: Session, ctx: OrgContext, statement: RoyaltyStatement, payload: StatementUpdate,
                    request: Request | None) -> RoyaltyStatement:
    ensure_editable(db, statement)
    changes = payload.model_dump(exclude_unset=True)
    if changes.pop("clear_default_rights_type", False):
        changes["default_rights_type"] = None
    if changes.pop("clear_reported_total", False):
        changes["reported_total"] = None
    changes = {k: v for k, v in changes.items()
               if v is not None or k in ("default_rights_type", "reported_total", "notes")}
    if "source_name" in changes and changes["source_name"] is None:
        changes.pop("source_name")

    if "currency" in changes and changes["currency"] != statement.currency:
        has_lines = db.scalar(select(StatementLine.id).where(
            StatementLine.statement_id == statement.id).limit(1)) is not None
        if has_lines:
            raise ConflictError("Currency can only change before the statement is processed; "
                                "lines already carry the original currency",
                                code="currency_locked")
    start = changes.get("period_start", statement.period_start)
    end = changes.get("period_end", statement.period_end)
    if end < start:
        raise ValidationFailedError("period_end must be on or after period_start")

    before = {k: getattr(statement, k) for k in changes}
    for key, value in changes.items():
        setattr(statement, key, value)
    changed = {k: {"from": before[k], "to": v} for k, v in changes.items() if before[k] != v}
    if not changed:
        return statement
    if any(k in changed for k in CALCULATION_FIELDS):
        # Rights type / period / source drive the allocation, so unposted runs are stale.
        _invalidate_calculations(db, statement)
    record_audit(
        db, action="statement.updated", actor_user_id=ctx.user.id,
        organization_id=ctx.organization_id, entity_type="statement", entity_id=statement.id,
        summary=f"Updated {', '.join(sorted(changed))}", changes=changed, request=request,
    )
    db.commit()
    db.refresh(statement)
    return statement


def cancel_processing(db: Session, ctx: OrgContext, statement: RoyaltyStatement,
                      request: Request | None) -> RoyaltyStatement:
    """Cancel a statement whose processing job has not started yet."""
    if statement.status != "queued":
        raise ConflictError(
            "Only queued statements can be cancelled"
            + (" — processing has already started" if statement.status == "processing" else ""),
            code="not_cancellable",
        )
    job = db.get(BackgroundJob, statement.job_id) if statement.job_id else None
    if job is not None and job.status != "cancelled" and not jobs.cancel_job(db, job):
        raise ConflictError("Processing has already started and can no longer be cancelled",
                            code="not_cancellable")
    has_lines = db.scalar(select(StatementLine.id).where(
        StatementLine.statement_id == statement.id).limit(1)) is not None
    statement.status = "processed" if has_lines else "uploaded"
    record_audit(
        db, action="statement.processing_cancelled", actor_user_id=ctx.user.id,
        organization_id=ctx.organization_id, entity_type="statement", entity_id=statement.id,
        request=request,
    )
    db.commit()
    db.refresh(statement)
    return statement


def delete_statement(db: Session, ctx: OrgContext, statement: RoyaltyStatement,
                     request: Request | None) -> None:
    if _has_posted_run(db, statement.id) or db.scalar(select(RoyaltyRun.id).where(
            RoyaltyRun.statement_id == statement.id, RoyaltyRun.status == "reversed")):
        raise ConflictError("Statements with posted or reversed royalties are part of the financial "
                            "record and cannot be deleted", code="statement_posted")
    if statement.status in ("queued", "processing"):
        raise ConflictError("Statement is being processed")
    for run in db.scalars(select(RoyaltyRun).where(RoyaltyRun.statement_id == statement.id)):
        db.delete(run)
    db.flush()
    if statement.file is not None:
        statement.file.is_deleted = True
    summary = f"Deleted statement {statement.source_name} {statement.period_start}–{statement.period_end}"
    db.delete(statement)
    record_audit(db, action="statement.deleted", actor_user_id=ctx.user.id,
                 organization_id=ctx.organization_id, entity_type="statement",
                 entity_id=statement.id, summary=summary, request=request)
    db.commit()
