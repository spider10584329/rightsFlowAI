"""Transactional outbox for automation events.

``emit_event`` only *adds* a row to the caller's session: the event becomes
visible exactly when the business transaction commits, and disappears with it
on rollback. n8n pulls events:

1. ``claim_events``: atomically leases up to N due events (conditional UPDATE,
   so two pollers can never claim the same event) and returns a lease token.
2. The workflow processes the event through the API.
3. ``ack_event`` with the lease token: ``completed``; ``retry`` (back off
   exponentially, dead after ``max_attempts``); or ``failed`` (dead immediately).

If n8n stops mid-processing the lease expires and the event is claimed again
(the attempt counter still advances, so a poison event ends up dead).
Dead events are listed for admins and can be requeued.
"""

import secrets
from datetime import timedelta
from typing import Any

from fastapi import Request
from sqlalchemy import and_, delete, func, or_, select, update
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import ConflictError, NotFoundError, ValidationFailedError
from app.core.permissions import OrgContext
from app.db.mixins import new_uuid, utc_now
from app.models.automation import AutomationEvent
from app.services.audit import record_audit
from app.services.automation.credentials import redact

EVENT_TYPES = {
    "statement.uploaded": "A royalty statement was uploaded by a user and awaits processing",
    "statement.ready": "A person confirmed a statement's column mapping or retried it; automation may process it",
    "work.created": "A work was created in the catalog",
    "recording.created": "A recording was created in the catalog",
    "rights_conflict.opened": "A new high-severity rights conflict was detected",
    "review.requested": "A user asked for an automated metadata/rights review",
}
MAX_CLAIM = 25
BACKOFF_BASE_SECONDS = 30
BACKOFF_MAX_SECONDS = 3600


def emit_event(db: Session, *, organization_id: str, event_type: str, payload: dict[str, Any],
               dedupe_key: str | None = None, correlation_id: str | None = None) -> AutomationEvent | None:
    """Add an outbox event to the current transaction (no commit). Returns None
    when an event with the same dedupe key already exists."""
    if event_type not in EVENT_TYPES:
        raise ValueError(f"Unknown automation event type {event_type!r}")
    key = (dedupe_key or f"{event_type}:{new_uuid()}")[:191]
    exists = db.scalar(select(AutomationEvent.id).where(
        AutomationEvent.organization_id == organization_id, AutomationEvent.dedupe_key == key))
    if exists:
        return None
    event = AutomationEvent(organization_id=organization_id, event_type=event_type, payload=payload,
                            dedupe_key=key, correlation_id=correlation_id)
    db.add(event)
    # Managed mode: start the automation that handles this event right away
    # (same transaction, so nothing starts if the business change rolls back).
    from app.services.automation.provisioner import on_event

    on_event(db, organization_id, event_type)
    return event


EXPIRY_BATCH = 500


def automation_enabled(db: Session, organization_id: str) -> bool:
    """True when the organization has a non-revoked automation key that consumes
    events. Expired keys still count, so events survive a rotation or renewal
    gap instead of being lost (N8N-05)."""
    from app.models.automation import IntegrationCredential

    for scopes in db.scalars(select(IntegrationCredential.scopes).where(
            IntegrationCredential.organization_id == organization_id,
            IntegrationCredential.revoked_at.is_(None))).all():
        if "events:consume" in (scopes or []):
            return True
    return False


def emit_event_if_enabled(db: Session, *, organization_id: str, event_type: str, payload: dict[str, Any],
                          dedupe_key: str | None = None) -> AutomationEvent | None:
    """Business hooks call this: organizations that don't use automation get no
    outbox rows at all, so nothing accumulates for them (N8N-05)."""
    if not automation_enabled(db, organization_id):
        return None
    return emit_event(db, organization_id=organization_id, event_type=event_type, payload=payload,
                      dedupe_key=dedupe_key)


def expire_stale_events(db: Session, *, batch_size: int = EXPIRY_BATCH) -> int:
    """Retention: pending events older than ``automation_pending_event_retention_days``,
    and events left behind in organizations that no longer have an automation
    key, become ``expired``. They are kept for history, never delivered, never
    deleted here. Works in bounded batches. Commits."""
    from app.models.automation import IntegrationCredential

    now = utc_now()
    cutoff = now - timedelta(days=settings.automation_pending_event_retention_days)
    consumers = select(IntegrationCredential.organization_id).where(IntegrationCredential.revoked_at.is_(None))
    total = 0
    for condition, reason in (
        (AutomationEvent.created_at < cutoff, "expired: not consumed within the retention period"),
        (AutomationEvent.organization_id.not_in(consumers), "expired: organization has no automation key"),
    ):
        while True:
            ids = db.scalars(select(AutomationEvent.id).where(
                condition, or_(AutomationEvent.status == "pending",
                               and_(AutomationEvent.status == "claimed", AutomationEvent.lease_expires_at < now)))
                .limit(batch_size)).all()
            if not ids:
                break
            result = db.execute(update(AutomationEvent).where(AutomationEvent.id.in_(ids))
                                .values(status="expired", lease_token=None, lease_expires_at=None, last_error=reason))
            db.commit()
            total += result.rowcount or 0
            if len(ids) < batch_size:
                break
    return total


def _due(now):
    return and_(
        AutomationEvent.available_at <= now,
        or_(AutomationEvent.status == "pending",
            and_(AutomationEvent.status == "claimed", AutomationEvent.lease_expires_at < now)),
    )


def claim_events(db: Session, *, organization_id: str, credential_id: str, event_types: list[str],
                 limit: int, lease_seconds: int) -> tuple[str | None, list[AutomationEvent]]:
    unknown = [t for t in event_types if t not in EVENT_TYPES]
    if unknown or not event_types:
        raise ValidationFailedError("Unknown or missing event types", code="invalid_event_type",
                                    details={"unknown": unknown, "allowed": sorted(EVENT_TYPES)})
    if not 1 <= limit <= MAX_CLAIM:
        raise ValidationFailedError(f"limit must be between 1 and {MAX_CLAIM}")
    if not 30 <= lease_seconds <= 900:
        raise ValidationFailedError("lease_seconds must be between 30 and 900")
    now = utc_now()
    candidates = db.execute(
        select(AutomationEvent.id, AutomationEvent.status, AutomationEvent.attempts,
               AutomationEvent.max_attempts)
        .where(AutomationEvent.organization_id == organization_id,
               AutomationEvent.event_type.in_(event_types), _due(now))
        .order_by(AutomationEvent.available_at, AutomationEvent.created_at)
        .limit(limit * 3)
    ).all()
    token = secrets.token_hex(16)
    claimed_ids: list[str] = []
    for event_id, status, attempts, max_attempts in candidates:
        if len(claimed_ids) >= limit:
            break
        if status == "claimed" and attempts >= max_attempts:
            # Lease expired on its final attempt (e.g. n8n died while processing).
            db.execute(update(AutomationEvent).where(AutomationEvent.id == event_id, _due(now))
                       .values(status="dead", lease_token=None, lease_expires_at=None,
                               last_error="Lease expired on the final attempt"))
            continue
        result = db.execute(
            update(AutomationEvent)
            .where(AutomationEvent.id == event_id, _due(now))
            .values(status="claimed", lease_token=token, lease_expires_at=now + timedelta(seconds=lease_seconds),
                    attempts=AutomationEvent.attempts + 1, claimed_by_credential_id=credential_id)
        )
        if result.rowcount == 1:
            claimed_ids.append(event_id)
    db.commit()
    if not claimed_ids:
        return None, []
    events = list(db.scalars(select(AutomationEvent).where(AutomationEvent.id.in_(claimed_ids))
                             .order_by(AutomationEvent.created_at)).all())
    return token, events


def get_event(db: Session, organization_id: str, event_id: str, *, lock: bool = False) -> AutomationEvent:
    stmt = select(AutomationEvent).where(AutomationEvent.id == event_id,
                                         AutomationEvent.organization_id == organization_id)
    if lock:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    event = db.scalar(stmt)
    if event is None:
        raise NotFoundError("Event not found")
    return event


def backoff_seconds(attempts: int) -> int:
    return min(BACKOFF_BASE_SECONDS * 2 ** max(attempts - 1, 0), BACKOFF_MAX_SECONDS)


def ack_event(db: Session, *, organization_id: str, event_id: str, lease_token: str, outcome: str,
              error: str | None, correlation_id: str | None) -> AutomationEvent:
    if outcome not in ("completed", "retry", "failed"):
        raise ValidationFailedError("outcome must be completed, retry or failed")
    event = get_event(db, organization_id, event_id, lock=True)
    if event.status != "claimed" or event.lease_token != lease_token:
        raise ConflictError("The lease on this event is no longer held (it expired or was re-claimed)",
                            code="lease_lost", details={"status": event.status})
    now = utc_now()
    event.lease_token = None
    event.lease_expires_at = None
    if correlation_id:
        event.correlation_id = correlation_id[:100]
    if outcome == "completed":
        event.status = "completed"
        event.completed_at = now
        event.last_error = None
    elif outcome == "retry" and event.attempts < event.max_attempts:
        event.status = "pending"
        event.available_at = now + timedelta(seconds=backoff_seconds(event.attempts))
        event.last_error = redact(error) or "retry requested"
    else:
        event.status = "dead"
        event.last_error = redact(error) or ("permanent failure" if outcome == "failed" else "retries exhausted")
    db.commit()
    db.refresh(event)
    return event


def requeue_event(db: Session, ctx: OrgContext, event_id: str, request: Request | None) -> AutomationEvent:
    event = get_event(db, ctx.organization_id, event_id, lock=True)
    if event.status not in ("dead", "failed"):
        raise ConflictError(f"Only dead events can be requeued (event is {event.status})")
    event.status = "pending"
    event.attempts = 0
    event.available_at = utc_now()
    event.lease_token = None
    event.lease_expires_at = None
    record_audit(db, action="automation.event_requeued", actor_user_id=ctx.user.id,
                 organization_id=ctx.organization_id, entity_type="automation_event", entity_id=event.id,
                 summary=f"Requeued {event.event_type} event", request=request)
    db.commit()
    db.refresh(event)
    return event


def outbox_stats(db: Session, organization_id: str) -> dict[str, Any]:
    rows = db.execute(select(AutomationEvent.status, func.count()).where(
        AutomationEvent.organization_id == organization_id).group_by(AutomationEvent.status)).all()
    counts = {status: int(count) for status, count in rows}
    oldest = db.scalar(select(func.min(AutomationEvent.created_at)).where(
        AutomationEvent.organization_id == organization_id, AutomationEvent.status == "pending"))
    return {
        "pending": counts.get("pending", 0),
        "claimed": counts.get("claimed", 0),
        "completed": counts.get("completed", 0),
        "dead": counts.get("dead", 0),
        "expired": counts.get("expired", 0),
        "oldest_pending_seconds": int((utc_now() - oldest).total_seconds()) if oldest else None,
    }


def event_payload(event: AutomationEvent, *, include_lease: bool = False) -> dict[str, Any]:
    data = {
        "id": event.id,
        "event_type": event.event_type,
        "payload": event.payload,
        "status": event.status,
        "attempts": event.attempts,
        "max_attempts": event.max_attempts,
        "available_at": event.available_at,
        "created_at": event.created_at,
        "completed_at": event.completed_at,
        "last_error": event.last_error,
        "correlation_id": event.correlation_id,
    }
    if include_lease:
        data["lease_expires_at"] = event.lease_expires_at
    return data


def purge_completed(db: Session) -> int:
    cutoff = utc_now() - timedelta(days=settings.automation_event_retention_days)
    result = db.execute(delete(AutomationEvent).where(AutomationEvent.status == "completed",
                                                      AutomationEvent.completed_at < cutoff))
    return result.rowcount or 0
