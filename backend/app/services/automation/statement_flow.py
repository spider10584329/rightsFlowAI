"""Durable automation state for statement processing (audit N8N-02, N8N-06).

The statement's own status (uploaded/queued/processing/processed/failed/...)
stays authoritative. This module keeps automation's view in
``automation_statement_states`` so retries are bounded and survive restarts:

    pending ─► processing ─► completed
                   │
                   └─(failed)─► retry_waiting ─(due)─► processing ...
                                    └─(permanent or attempts exhausted)─► needs_manual_review
    awaiting_mapping: an app upload whose column mapping no person has confirmed,
    or any statement without a usable mapping. Automation never processes it.

A person can always retry (``manual_retry``): that resets the attempt counter
and processes the statement with their confirmation. Duplicate protection is
unchanged: retries reprocess the same statement; nothing is imported twice,
and statements with posted or reversed royalties can't be reprocessed at all.
"""

import hashlib
from datetime import timedelta
from typing import Any

from fastapi import Request
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import ConflictError
from app.core.permissions import OrgContext
from app.db.mixins import utc_now
from app.models.automation import AutomationInboxFile, AutomationStatementState
from app.models.platform import BackgroundJob
from app.models.royalty import RoyaltyStatement
from app.models.user import User
from app.services.audit import record_audit
from app.services.automation.credentials import redact

IDENTIFYING_FIELDS = ("isrc", "iswc", "upc", "title")
# Messages of failures that retrying can't fix (bad file, bad mapping, history).
PERMANENT_MARKERS = (
    "could not be read", "unable to read", "not a valid", "mapped columns not found", "missing required column",
    "posted or reversed", "changed while processing", "statement is ", "limited to", "no valid",
    "file_too_complex", "unsupported",
)


def source_of(db: Session, statement: RoyaltyStatement) -> str:
    """'inbox' for statements the automation uploaded, 'app' for people's uploads."""
    creator = db.get(User, statement.created_by_id) if statement.created_by_id else None
    return "inbox" if creator is not None and creator.is_service_account else "app"


def mapping_usable(statement: RoyaltyStatement) -> bool:
    mapping = statement.column_mapping or {}
    return bool(mapping.get("amount")) and any(mapping.get(f) for f in IDENTIFYING_FIELDS)


def get_state(db: Session, statement: RoyaltyStatement, *, lock: bool = True) -> AutomationStatementState:
    stmt = select(AutomationStatementState).where(
        AutomationStatementState.organization_id == statement.organization_id,
        AutomationStatementState.statement_id == statement.id)
    if lock:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    state = db.scalar(stmt)
    if state is None:
        state = AutomationStatementState(organization_id=statement.organization_id, statement_id=statement.id,
                                         source=source_of(db, statement), state="pending",
                                         max_attempts=settings.automation_statement_max_attempts)
        try:
            with db.begin_nested():
                db.add(state)
        except IntegrityError:
            state = db.scalar(stmt)
    return state


def classify_failure(db: Session, statement: RoyaltyStatement) -> tuple[str, bool, str]:
    """(category, retryable, message) for a failed statement."""
    job = db.get(BackgroundJob, statement.job_id) if statement.job_id else None
    message = (job.error if job and job.error else None) or ""
    if not message and statement.errors:
        first = statement.errors[0] or {}
        message = "; ".join(first.get("errors") or [])
    lowered = message.lower()
    if any(marker in lowered for marker in PERMANENT_MARKERS):
        return "invalid_input", False, message
    if any(k in lowered for k in ("timeout", "timed out", "deadlock", "lost connection", "operationalerror",
                                  "stale", "worker")):
        return "transient", True, message
    return "processing_error", True, message


def backoff(attempts: int) -> timedelta:
    return timedelta(minutes=settings.automation_statement_retry_base_minutes * 2 ** max(attempts - 1, 0))


def advance(db: Session, org: OrgContext, statement: RoyaltyStatement, request: Request | None) -> dict[str, Any]:
    """Move one statement forward. Called (idempotently) on every workflow run.
    Returns ``{"outcome": ..., "state": ...}``. Commits."""
    from app.services.royalty_import import request_processing

    state = get_state(db, statement)
    now = utc_now()
    outcome = None
    if statement.status == "posted" or statement.status in ("processed", "calculated"):
        state.state, outcome = "completed", "completed"
    elif statement.status in ("queued", "processing"):
        state.state, outcome = "processing", "in_progress"
    elif statement.status == "uploaded":
        if state.source == "app" and statement.mapping_confirmed_at is None:
            state.state, outcome = "awaiting_mapping", "awaiting_mapping_confirmation"
        elif not mapping_usable(statement):
            state.state, outcome = "awaiting_mapping", "mapping_required"
        else:
            request_processing(db, org, statement, request)
            state.state, outcome = "processing", "started"
            state.attempts += 1
    elif statement.status == "failed":
        if state.state == "needs_manual_review":
            outcome = "needs_manual_review"
        elif state.state == "retry_waiting":
            if state.next_attempt_at and state.next_attempt_at > now:
                outcome = "retry_waiting"
            else:
                request_processing(db, org, statement, request)
                state.state, outcome = "processing", "retry_started"
                state.attempts += 1
                state.next_attempt_at = None
        else:
            # First time automation sees this failure: classify it.
            category, retryable, message = classify_failure(db, statement)
            state.error_category = category
            state.last_error = redact(message, 500)
            state.attempts = max(state.attempts, 1)
            if retryable and state.attempts < state.max_attempts:
                state.state, outcome = "retry_waiting", "retry_scheduled"
                state.next_attempt_at = now + backoff(state.attempts)
            else:
                state.state, outcome = "needs_manual_review", "needs_manual_review"
                state.next_attempt_at = None
                record_audit(db, action="automation.statement_needs_review", actor_user_id=org.user.id,
                             organization_id=org.organization_id, entity_type="statement", entity_id=statement.id,
                             summary=f"Automatic processing stopped after {state.attempts} attempt(s): {category}")
    else:
        outcome = statement.status
    db.commit()
    return {"outcome": outcome, **state_payload(state)}


def manual_retry(db: Session, ctx: OrgContext, statement: RoyaltyStatement, request: Request | None) -> dict[str, Any]:
    """A person retries: reset attempts and process now (their confirmation)."""
    from app.services.royalty_import import request_processing

    if statement.status not in ("failed", "uploaded", "processed", "calculated"):
        raise ConflictError(f"Statement is {statement.status}; it can't be retried now")
    state = get_state(db, statement)
    state.attempts, state.next_attempt_at = 0, None
    state.error_category = state.last_error = None
    if statement.mapping_confirmed_at is None:
        statement.mapping_confirmed_at = utc_now()
        statement.mapping_confirmed_by_id = ctx.user.id
    request_processing(db, ctx, statement, request)  # validates mapping and history; commits
    state = get_state(db, statement)
    state.state, state.attempts = "processing", 1
    record_audit(db, action="automation.statement_retried", actor_user_id=ctx.user.id,
                 organization_id=ctx.organization_id, entity_type="statement", entity_id=statement.id,
                 summary="Manual retry of statement processing", request=request)
    from app.services.automation.events import emit_event_if_enabled

    emit_event_if_enabled(db, organization_id=ctx.organization_id, event_type="statement.ready",
                          payload={"statement_id": statement.id, "reason": "manual_retry"},
                          dedupe_key=f"statement.ready:{statement.id}:{utc_now():%Y%m%d%H%M%S%f}")
    db.commit()
    return state_payload(state)


def state_payload(state: AutomationStatementState) -> dict[str, Any]:
    return {"statement_id": state.statement_id, "source": state.source, "state": state.state,
            "attempts": state.attempts, "max_attempts": state.max_attempts,
            "next_attempt_at": state.next_attempt_at, "error_category": state.error_category,
            "last_error": state.last_error, "updated_at": state.updated_at}


# --------------------------------------------------------------------------- inbox files (N8N-09)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def record_inbox_file(db: Session, *, organization_id: str, digest: str, file_name: str | None, state: str,
                      statement_id: str | None = None, error_code: str | None = None,
                      error_message: str | None = None) -> tuple[AutomationInboxFile, bool]:
    """Upsert the outcome for a file (by content hash). Returns (row, first_time). Does not commit."""
    now = utc_now()
    row = db.scalar(select(AutomationInboxFile).where(AutomationInboxFile.organization_id == organization_id,
                                                      AutomationInboxFile.sha256 == digest).with_for_update())
    if row is None:
        row = AutomationInboxFile(organization_id=organization_id, sha256=digest,
                                  file_name=(file_name or "unknown")[:255], state=state, statement_id=statement_id,
                                  error_code=error_code, error_message=redact(error_message, 500),
                                  first_seen_at=now, last_seen_at=now)
        try:
            with db.begin_nested():
                db.add(row)
            return row, True
        except IntegrityError:
            row = db.scalar(select(AutomationInboxFile).where(AutomationInboxFile.organization_id == organization_id,
                                                              AutomationInboxFile.sha256 == digest))
    row.times_seen += 1
    row.last_seen_at = now
    if state != "duplicate" or row.state != "imported":
        row.state = state
    row.statement_id = statement_id or row.statement_id
    row.error_code, row.error_message = error_code, redact(error_message, 500)
    return row, False


def inbox_payload(row: AutomationInboxFile) -> dict[str, Any]:
    return {"sha256": row.sha256[:16], "file_name": row.file_name, "state": row.state,
            "statement_id": row.statement_id, "error_code": row.error_code, "times_seen": row.times_seen,
            "first_seen_at": row.first_seen_at, "last_seen_at": row.last_seen_at}
