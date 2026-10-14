"""Workflow run tracking, review tasks and deduplicated deliveries."""

import json
import re
from datetime import timedelta
from typing import Any

from fastapi import Request
from sqlalchemy import exists, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, aliased

from app.core.errors import ConflictError, NotFoundError, ValidationFailedError
from app.core.permissions import OrgContext
from app.db.mixins import utc_now
from app.models.automation import AutomationDelivery, AutomationReviewTask, AutomationRun
from app.services.audit import record_audit
from app.services.automation.context import AutomationContext
from app.services.automation.credentials import redact

WORKFLOW_RE = re.compile(r"^[a-z0-9][a-z0-9\-]{2,99}$")
TRIGGER_TYPES = ("manual", "schedule", "event", "file", "error_handler")
FINAL_STATUSES = ("succeeded", "failed", "partial", "skipped")
SUMMARY_MAX_BYTES = 4000


# --------------------------------------------------------------------------- runs


def _clean_summary(summary: dict[str, Any] | None) -> dict[str, Any] | None:
    if summary is None:
        return None
    if not isinstance(summary, dict):
        raise ValidationFailedError("summary must be an object")
    encoded = json.dumps(summary, default=str)
    if len(encoded) > SUMMARY_MAX_BYTES:
        raise ValidationFailedError(f"summary must be at most {SUMMARY_MAX_BYTES} bytes of JSON",
                                    code="summary_too_large")
    # Drop anything that looks like a key or bearer token before storing.
    cleaned = redact(encoded, limit=SUMMARY_MAX_BYTES * 2) or "{}"
    return json.loads(cleaned) if cleaned != encoded else summary


def get_run(db: Session, organization_id: str, run_id: str, *, lock: bool = False) -> AutomationRun:
    stmt = select(AutomationRun).where(AutomationRun.id == run_id, AutomationRun.organization_id == organization_id)
    if lock:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    run = db.scalar(stmt)
    if run is None:
        raise NotFoundError("Automation run not found")
    return run


def start_run(db: Session, actx: AutomationContext, *, workflow: str, trigger_type: str,
              execution_id: str | None, idempotency_key: str | None, event_id: str | None) -> tuple[AutomationRun, bool]:
    """Start (or resume) a run. With an idempotency key, a run that already
    succeeded is returned as-is (``replayed=True``) so the workflow can skip
    duplicate work (e.g. a monthly report); a failed one is restarted with
    ``retry_count`` incremented."""
    if not WORKFLOW_RE.match(workflow):
        raise ValidationFailedError("Invalid workflow name", code="invalid_workflow")
    if trigger_type not in TRIGGER_TYPES:
        raise ValidationFailedError("Invalid trigger type", details={"allowed": list(TRIGGER_TYPES)})
    if event_id:
        from app.services.automation.events import get_event

        get_event(db, actx.organization_id, event_id)
    if idempotency_key:
        existing = db.scalar(select(AutomationRun).where(
            AutomationRun.organization_id == actx.organization_id, AutomationRun.workflow == workflow,
            AutomationRun.idempotency_key == idempotency_key).with_for_update())
        if existing is not None:
            if existing.status == "failed":
                existing.status = "running"
                existing.retry_count += 1
                existing.error_code = None
                existing.error_message = None
                existing.finished_at = None
            if existing.status == "running" and execution_id:
                existing.execution_id = execution_id[:100]
            db.commit()
            return existing, True
    run = AutomationRun(
        organization_id=actx.organization_id, credential_id=actx.credential.id, workflow=workflow,
        execution_id=(execution_id or None) and execution_id[:100], trigger_type=trigger_type,
        idempotency_key=idempotency_key, correlation_id=actx.correlation_id, event_id=event_id,
    )
    db.add(run)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        return start_run(db, actx, workflow=workflow, trigger_type=trigger_type, execution_id=execution_id,
                         idempotency_key=idempotency_key, event_id=event_id)
    db.refresh(run)
    return run, False


def finish_run(db: Session, actx: AutomationContext, run_id: str, *, status: str,
               summary: dict[str, Any] | None, error_code: str | None, error_message: str | None) -> AutomationRun:
    if status not in FINAL_STATUSES:
        raise ValidationFailedError("Invalid final status", details={"allowed": list(FINAL_STATUSES)})
    run = get_run(db, actx.organization_id, run_id, lock=True)
    if run.status != "running":
        if run.status == status:
            return run  # repeated finish (retry of the same call)
        raise ConflictError(f"Run already finished as {run.status}", code="run_finished")
    run.status = status
    run.finished_at = utc_now()
    run.summary = _clean_summary(summary)
    if status == "succeeded":
        # The workflow works again: close its incidents and say so once (N8N-03).
        from app.services.automation.incidents import resolve_for_workflow

        resolve_for_workflow(db, organization_id=actx.organization_id, workflow=run.workflow,
                             execution_id=run.execution_id)
    run.error_code = (error_code or None) and error_code[:80]
    run.error_message = redact(error_message)
    db.commit()
    db.refresh(run)
    return run


def run_payload(run: AutomationRun) -> dict[str, Any]:
    return {
        "id": run.id, "workflow": run.workflow, "execution_id": run.execution_id,
        "trigger_type": run.trigger_type, "status": run.status, "idempotency_key": run.idempotency_key,
        "correlation_id": run.correlation_id, "event_id": run.event_id, "retry_count": run.retry_count,
        "summary": run.summary, "error_code": run.error_code, "error_message": run.error_message,
        "started_at": run.started_at, "finished_at": run.finished_at,
    }


def recent_failures(db: Session, organization_id: str, hours: int = 24) -> int:
    since = utc_now() - timedelta(hours=hours)
    return int(db.scalar(select(func.count()).select_from(AutomationRun).where(
        AutomationRun.organization_id == organization_id, AutomationRun.status == "failed",
        AutomationRun.started_at >= since)) or 0)


def unrecovered_failures(db: Session, organization_id: str, hours: int = 24) -> int:
    """Failed runs in the window with no later successful run of the same workflow."""
    since = utc_now() - timedelta(hours=hours)
    later = aliased(AutomationRun)
    return int(db.scalar(select(func.count()).select_from(AutomationRun).where(
        AutomationRun.organization_id == organization_id, AutomationRun.status == "failed",
        AutomationRun.started_at >= since,
        ~exists().where(later.organization_id == AutomationRun.organization_id,
                        later.workflow == AutomationRun.workflow, later.status == "succeeded",
                        later.started_at >= AutomationRun.started_at, later.id != AutomationRun.id))) or 0)


def open_incidents(db: Session, organization_id: str, *, exclude_workflow: str | None = None) -> int:
    from app.models.automation import AutomationIncident

    query = select(func.count()).select_from(AutomationIncident).where(
        AutomationIncident.organization_id == organization_id, AutomationIncident.status == "open")
    if exclude_workflow:
        query = query.where(AutomationIncident.workflow != exclude_workflow)
    return int(db.scalar(query) or 0)


def stale_running(db: Session, organization_id: str, hours: int = 6) -> int:
    since = utc_now() - timedelta(hours=hours)
    return int(db.scalar(select(func.count()).select_from(AutomationRun).where(
        AutomationRun.organization_id == organization_id, AutomationRun.status == "running",
        AutomationRun.started_at < since)) or 0)


# --------------------------------------------------------------------------- review tasks


def upsert_review_task(db: Session, *, organization_id: str, kind: str, dedupe_key: str, title: str,
                       subject_type: str | None, subject_id: str | None, link: str | None,
                       details: dict[str, Any], run_id: str | None = None,
                       ai_suggestion_id: str | None = None) -> tuple[AutomationReviewTask, str]:
    """Create or refresh a review task. Returns (task, change) where change is
    ``created``, ``updated`` (details changed; reopened if it was closed) or
    ``unchanged``. Does not commit."""
    def find():
        return db.scalar(select(AutomationReviewTask).where(
            AutomationReviewTask.organization_id == organization_id,
            AutomationReviewTask.dedupe_key == dedupe_key[:191]).with_for_update()
            .execution_options(populate_existing=True))

    task = find()
    if task is None:
        task = AutomationReviewTask(organization_id=organization_id, kind=kind, dedupe_key=dedupe_key[:191],
                                    title=title[:255], subject_type=subject_type, subject_id=subject_id,
                                    link=link, details=details, run_id=run_id,
                                    ai_suggestion_id=ai_suggestion_id)
        try:
            # Savepoint: two concurrent calls for the same subject (n8n sends a node's
            # items in parallel) must not fail; the loser updates the winner's task.
            with db.begin_nested():
                db.add(task)
            return task, "created"
        except IntegrityError:
            task = find()
            if task is None:
                raise
    if task.details == details and task.title == title[:255]:
        return task, "unchanged"
    task.details = details
    task.title = title[:255]
    task.run_id = run_id or task.run_id
    task.ai_suggestion_id = ai_suggestion_id or task.ai_suggestion_id
    if task.status != "open":
        task.status = "open"
        task.resolved_at = None
        task.resolved_by_id = None
    return task, "updated"


def get_review_task(db: Session, organization_id: str, task_id: str) -> AutomationReviewTask:
    task = db.scalar(select(AutomationReviewTask).where(AutomationReviewTask.id == task_id,
                                                        AutomationReviewTask.organization_id == organization_id))
    if task is None:
        raise NotFoundError("Review task not found")
    return task


def close_review_task(db: Session, ctx: OrgContext, task_id: str, *, status: str, note: str | None,
                      request: Request | None) -> AutomationReviewTask:
    if status not in ("resolved", "dismissed"):
        raise ValidationFailedError("status must be resolved or dismissed")
    task = get_review_task(db, ctx.organization_id, task_id)
    if task.status != "open":
        raise ConflictError(f"Review task is already {task.status}")
    task.status = status
    task.resolved_by_id = ctx.user.id
    task.resolved_at = utc_now()
    task.resolution_note = note
    record_audit(db, action=f"automation.review_task_{status}", actor_user_id=ctx.user.id,
                 organization_id=ctx.organization_id, entity_type="automation_review_task", entity_id=task.id,
                 summary=f"{status.capitalize()} review task: {task.title}", request=request)
    db.commit()
    db.refresh(task)
    return task


def review_task_payload(task: AutomationReviewTask) -> dict[str, Any]:
    return {
        "id": task.id, "kind": task.kind, "status": task.status, "title": task.title,
        "subject_type": task.subject_type, "subject_id": task.subject_id, "link": task.link,
        "details": task.details, "ai_suggestion_id": task.ai_suggestion_id, "run_id": task.run_id,
        "resolved_by_id": task.resolved_by_id, "resolved_at": task.resolved_at,
        "resolution_note": task.resolution_note, "created_at": task.created_at, "updated_at": task.updated_at,
    }


# --------------------------------------------------------------------------- deliveries


def find_delivery(db: Session, organization_id: str, dedupe_key: str, *, lock: bool = False) -> AutomationDelivery | None:
    stmt = select(AutomationDelivery).where(AutomationDelivery.organization_id == organization_id,
                                            AutomationDelivery.dedupe_key == dedupe_key)
    if lock:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    return db.scalar(stmt)


def reserve_delivery(db: Session, *, organization_id: str, kind: str, dedupe_key: str,
                     subject_type: str | None = None, subject_id: str | None = None,
                     run_id: str | None = None) -> tuple[AutomationDelivery, bool]:
    """Return (delivery, created). An existing delivery with the same key means
    this notification/report was already handled: callers must not send again.
    Uses a savepoint so a concurrent duplicate can't abort the caller."""
    existing = find_delivery(db, organization_id, dedupe_key, lock=True)
    if existing is not None:
        return existing, False
    delivery = AutomationDelivery(organization_id=organization_id, kind=kind, dedupe_key=dedupe_key[:191],
                                  subject_type=subject_type, subject_id=subject_id, run_id=run_id)
    try:
        with db.begin_nested():
            db.add(delivery)
    except IntegrityError:
        existing = find_delivery(db, organization_id, dedupe_key)
        if existing is None:
            raise
        return existing, False
    return delivery, True


def delivery_payload(delivery: AutomationDelivery, *, duplicate: bool = False) -> dict[str, Any]:
    return {
        "id": delivery.id, "kind": delivery.kind, "status": delivery.status,
        "dedupe_key": delivery.dedupe_key, "subject_type": delivery.subject_type,
        "subject_id": delivery.subject_id, "job_id": delivery.job_id,
        "recipient_count": len(delivery.recipient_user_ids or []), "detail": delivery.detail,
        "sent_at": delivery.sent_at, "created_at": delivery.created_at, "duplicate": duplicate,
    }
