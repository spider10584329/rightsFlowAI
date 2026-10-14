"""Human-facing administration of workflow automation (JWT auth).

Admins manage automation credentials and inspect the outbox and run history;
managers work the review queue and can request an automated review.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.permissions import OrgAdmin, OrgManager, OrgViewer
from app.db.session import get_db
from app.models.automation import AutomationEvent, AutomationReviewTask, AutomationRun
from app.schemas.automation import (
    CredentialCreate,
    CredentialResponse,
    CredentialRevoke,
    CredentialRotate,
    IssuedCredentialResponse,
    ReviewRequestCreate,
    ReviewTaskClose,
)
from app.services.automation import credentials, events, operations, records

router = APIRouter(prefix="/organizations/{organization_id}/automation", tags=["Automation admin"])

Limit = Annotated[int, Query(ge=1, le=200)]


@router.get("/scopes")
def list_scopes(ctx: OrgAdmin):
    return [{"scope": k, "description": v} for k, v in sorted(credentials.AUTOMATION_SCOPES.items())]


@router.get("/credentials", response_model=list[CredentialResponse])
def list_credentials(ctx: OrgAdmin, db: Session = Depends(get_db)):
    return [credentials.credential_payload(c) for c in credentials.list_credentials(db, ctx.organization_id)]


@router.post("/credentials", response_model=IssuedCredentialResponse, status_code=status.HTTP_201_CREATED)
def create_credential(payload: CredentialCreate, ctx: OrgAdmin, request: Request, db: Session = Depends(get_db)):
    """Create an automation API key for this organization. The returned token
    is shown once; only its HMAC is stored."""
    issued = credentials.create_credential(db, ctx, name=payload.name, scopes=payload.scopes,
                                           expires_in_days=payload.expires_in_days, request=request)
    return {"credential": credentials.credential_payload(issued.credential), "token": issued.token}


@router.post("/credentials/{credential_id}/rotate", response_model=IssuedCredentialResponse)
def rotate_credential(credential_id: str, payload: CredentialRotate, ctx: OrgAdmin, request: Request,
                      db: Session = Depends(get_db)):
    issued = credentials.rotate_credential(db, ctx, credential_id, grace_hours=payload.grace_hours,
                                           request=request)
    return {"credential": credentials.credential_payload(issued.credential), "token": issued.token}


@router.post("/credentials/{credential_id}/release-instance", response_model=CredentialResponse)
def release_instance(credential_id: str, ctx: OrgAdmin, request: Request, db: Session = Depends(get_db)):
    """Recovery after the n8n data folder was reset or moved: forget the bound
    instance so the new one can use the key. Confirm the old instance is gone
    first; otherwise rotate the key instead (N8N-07)."""
    return credentials.credential_payload(credentials.release_instance(db, ctx, credential_id, request=request))


@router.post("/credentials/{credential_id}/revoke", response_model=CredentialResponse)
def revoke_credential(credential_id: str, payload: CredentialRevoke, ctx: OrgAdmin, request: Request,
                      db: Session = Depends(get_db)):
    return credentials.credential_payload(
        credentials.revoke_credential(db, ctx, credential_id, reason=payload.reason, request=request))


@router.get("/overview")
def overview(ctx: OrgAdmin, db: Session = Depends(get_db)):
    creds = credentials.list_credentials(db, ctx.organization_id)
    open_tasks = db.scalars(select(AutomationReviewTask.id).where(
        AutomationReviewTask.organization_id == ctx.organization_id,
        AutomationReviewTask.status == "open")).all()
    return {
        "active_credentials": sum(1 for c in creds if credentials.credential_state(c) == "active"),
        "expiring_credentials": sum(1 for c in creds if credentials.expiry_level(c)[0] in ("warning", "critical")),
        "outbox": events.outbox_stats(db, ctx.organization_id),
        "failed_runs_24h": records.recent_failures(db, ctx.organization_id),
        "open_incidents": records.open_incidents(db, ctx.organization_id),
        "open_review_tasks": len(open_tasks),
        "automation_enabled": events.automation_enabled(db, ctx.organization_id),
    }


@router.get("/events")
def list_events(ctx: OrgAdmin, db: Session = Depends(get_db),
                status_filter: Annotated[str | None, Query(alias="status", max_length=20)] = None,
                limit: Limit = 50):
    stmt = select(AutomationEvent).where(AutomationEvent.organization_id == ctx.organization_id)
    if status_filter:
        stmt = stmt.where(AutomationEvent.status == status_filter)
    rows = db.scalars(stmt.order_by(AutomationEvent.created_at.desc()).limit(limit)).all()
    return [events.event_payload(e) for e in rows]


@router.post("/events/{event_id}/requeue")
def requeue_event(event_id: str, ctx: OrgAdmin, request: Request, db: Session = Depends(get_db)):
    """Dead-letter recovery: put a dead event back in the queue."""
    return events.event_payload(events.requeue_event(db, ctx, event_id, request))


@router.get("/runs")
def list_runs(ctx: OrgAdmin, db: Session = Depends(get_db),
              status_filter: Annotated[str | None, Query(alias="status", max_length=20)] = None,
              workflow: Annotated[str | None, Query(max_length=100)] = None, limit: Limit = 50):
    stmt = select(AutomationRun).where(AutomationRun.organization_id == ctx.organization_id)
    if status_filter:
        stmt = stmt.where(AutomationRun.status == status_filter)
    if workflow:
        stmt = stmt.where(AutomationRun.workflow == workflow)
    rows = db.scalars(stmt.order_by(AutomationRun.started_at.desc()).limit(limit)).all()
    return [records.run_payload(r) for r in rows]


@router.get("/incidents")
def list_incidents(ctx: OrgAdmin, db: Session = Depends(get_db),
                   status_filter: Annotated[str | None, Query(alias="status", max_length=20)] = None,
                   limit: Limit = 50):
    from app.models.automation import AutomationIncident
    from app.services.automation.incidents import incident_payload

    stmt = select(AutomationIncident).where(AutomationIncident.organization_id == ctx.organization_id)
    if status_filter:
        stmt = stmt.where(AutomationIncident.status == status_filter)
    rows = db.scalars(stmt.order_by(AutomationIncident.last_seen_at.desc()).limit(limit)).all()
    return [incident_payload(i) for i in rows]


@router.post("/incidents/{incident_id}/resolve")
def resolve_incident(incident_id: str, payload: ReviewTaskClose, ctx: OrgAdmin, request: Request,
                     db: Session = Depends(get_db)):
    """Close an incident by hand (e.g. the workflow was retired). A new failure opens a new one."""
    from app.core.errors import ConflictError, NotFoundError
    from app.db.mixins import utc_now
    from app.models.automation import AutomationIncident
    from app.services.audit import record_audit
    from app.services.automation.incidents import incident_payload

    incident = db.scalar(select(AutomationIncident).where(AutomationIncident.id == incident_id,
                                                          AutomationIncident.organization_id == ctx.organization_id)
                         .with_for_update())
    if incident is None:
        raise NotFoundError("Incident not found")
    if incident.status != "open":
        raise ConflictError("Incident is already resolved")
    incident.status = "resolved"
    incident.resolved_at = utc_now()
    incident.resolution = (f"Resolved by {ctx.user.full_name}" + (f": {payload.note}" if payload.note else ""))[:255]
    record_audit(db, action="automation.incident_resolved", actor_user_id=ctx.user.id,
                 organization_id=ctx.organization_id, entity_type="automation_incident", entity_id=incident.id,
                 summary=incident.title, request=request)
    db.commit()
    return incident_payload(incident)


@router.get("/statements")
def list_statement_states(ctx: OrgViewer, db: Session = Depends(get_db),
                          state: Annotated[str | None, Query(max_length=30)] = None, limit: Limit = 100):
    """Automation processing state per statement (retry_waiting, needs_manual_review, ...)."""
    from app.models.automation import AutomationStatementState
    from app.models.royalty import RoyaltyStatement
    from app.services.automation.statement_flow import state_payload

    stmt = (select(AutomationStatementState, RoyaltyStatement.source_name, RoyaltyStatement.status)
            .join(RoyaltyStatement, RoyaltyStatement.id == AutomationStatementState.statement_id)
            .where(AutomationStatementState.organization_id == ctx.organization_id))
    if state:
        stmt = stmt.where(AutomationStatementState.state == state)
    rows = db.execute(stmt.order_by(AutomationStatementState.updated_at.desc()).limit(limit)).all()
    return [{**state_payload(s), "source_name": name, "statement_status": status} for s, name, status in rows]


@router.post("/statements/{statement_id}/retry")
def retry_statement(statement_id: str, ctx: OrgManager, request: Request, db: Session = Depends(get_db)):
    """Manual retry: reset automation's attempt counter and process the statement now."""
    from app.services import royalty_import
    from app.services.automation.statement_flow import manual_retry

    statement = royalty_import.get_statement(db, ctx.organization_id, statement_id, lock=True)
    return manual_retry(db, ctx, statement, request)


@router.get("/inbox-files")
def list_inbox_files(ctx: OrgAdmin, db: Session = Depends(get_db),
                     state: Annotated[str | None, Query(max_length=20)] = None, limit: Limit = 100):
    from app.models.automation import AutomationInboxFile
    from app.services.automation.statement_flow import inbox_payload

    stmt = select(AutomationInboxFile).where(AutomationInboxFile.organization_id == ctx.organization_id)
    if state:
        stmt = stmt.where(AutomationInboxFile.state == state)
    return [inbox_payload(r) for r in db.scalars(stmt.order_by(AutomationInboxFile.last_seen_at.desc()).limit(limit))]


@router.get("/review-tasks")
def list_review_tasks(ctx: OrgViewer, db: Session = Depends(get_db),
                      status_filter: Annotated[str | None, Query(alias="status", max_length=20)] = "open",
                      kind: Annotated[str | None, Query(max_length=40)] = None, limit: Limit = 100):
    stmt = select(AutomationReviewTask).where(AutomationReviewTask.organization_id == ctx.organization_id)
    if status_filter:
        stmt = stmt.where(AutomationReviewTask.status == status_filter)
    if kind:
        stmt = stmt.where(AutomationReviewTask.kind == kind)
    rows = db.scalars(stmt.order_by(AutomationReviewTask.updated_at.desc()).limit(limit)).all()
    return [records.review_task_payload(t) for t in rows]


@router.post("/review-tasks/{task_id}/resolve")
def resolve_review_task(task_id: str, payload: ReviewTaskClose, ctx: OrgManager, request: Request,
                        db: Session = Depends(get_db)):
    return records.review_task_payload(
        records.close_review_task(db, ctx, task_id, status="resolved", note=payload.note, request=request))


@router.post("/review-tasks/{task_id}/dismiss")
def dismiss_review_task(task_id: str, payload: ReviewTaskClose, ctx: OrgManager, request: Request,
                        db: Session = Depends(get_db)):
    return records.review_task_payload(
        records.close_review_task(db, ctx, task_id, status="dismissed", note=payload.note, request=request))


@router.post("/review-requests", status_code=status.HTTP_202_ACCEPTED)
def request_review(payload: ReviewRequestCreate, ctx: OrgManager, request: Request, db: Session = Depends(get_db)):
    """Queue an automated (AI-assisted) review of a catalog item or rights conflict."""
    return operations.request_review(db, ctx, payload.subject_type, payload.subject_id, request)
