"""What organization admins see and do in managed mode (Settings > Automation).

Admins switch automations on and off, change their settings and start them
now; provisioning in n8n happens in the background
(``app/services/automation/provisioner.py``). They also see each run's
results: the statements it processed, the review tasks it raised, the
notifications it sent and the report files it produced.
"""

from typing import Any

from fastapi import Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import ConflictError, NotFoundError, RateLimitedError, ServiceUnavailableError
from app.core.permissions import OrgContext
from app.core.rate_limit import limiter
from app.db.mixins import utc_now
from app.models.automation import (
    AutomationDelivery,
    AutomationReviewTask,
    AutomationRun,
    IntegrationCredential,
    OrganizationAutomation,
)
from app.models.platform import StoredFile
from app.models.royalty import RoyaltyStatement
from app.services.audit import record_audit
from app.services.automation import catalog, provisioner, records
from app.services.automation.credentials import TOKEN_PREFIX, credential_state, expiry_level
from app.services.automation.n8n_client import N8nError, N8nNotConfigured, n8n_available
from app.services.reports import REPORT_TYPES

RUN_NOW_LIMIT = 6
RUN_NOW_WINDOW_SECONDS = 60


def _require_managed() -> None:
    if not provisioner.managed_mode():
        raise ConflictError("This server connects automation by hand (self-hosted mode)",
                            code="automation_not_managed")


def _require_available() -> None:
    if not n8n_available():
        raise ConflictError("Automation isn't set up on this server yet. Ask your RightsFlow administrator "
                            "to configure it.", code="automation_unavailable")


# --------------------------------------------------------------------------- payloads


def _latest_runs(db: Session, organization_id: str) -> dict[str, AutomationRun]:
    latest: dict[str, AutomationRun] = {}
    for key in catalog.USER_AUTOMATIONS:
        run = db.scalar(select(AutomationRun).where(
            AutomationRun.organization_id == organization_id,
            AutomationRun.workflow == catalog.DEFINITIONS[key].workflow,
        ).order_by(AutomationRun.started_at.desc()).limit(1))
        if run is not None:
            latest[key] = run
    return latest


def automation_payload(row: OrganizationAutomation, last_run: AutomationRun | None) -> dict[str, Any]:
    definition = catalog.DEFINITIONS[row.automation]
    values = catalog.stored_settings(row.automation, row.settings)
    cron, description = catalog.schedule(row.automation, values, row.organization_id)
    running = row.enabled and row.status == "active"
    return {
        "key": row.automation,
        "label": definition.label,
        "description": definition.description,
        "enabled": row.enabled,
        "status": row.status,
        "settings": values,
        "schedule": {"cron": cron, "description": description},
        "next_run_at": catalog.next_run(cron, utc_now()) if running else None,
        "last_run": records.run_payload(last_run) if last_run is not None else None,
        "last_error": row.last_error,
        "provisioned_at": row.provisioned_at,
        "last_triggered_at": row.last_triggered_at,
        "updated_at": row.updated_at,
        "can_run_now": running,
    }


def _key_payload(credential: IntegrationCredential | None) -> dict[str, Any] | None:
    if credential is None:
        return None
    return {
        "key_hint": f"{TOKEN_PREFIX}{credential.key_id}_…",
        "state": credential_state(credential),
        "expiry_level": expiry_level(credential)[0],
        "expires_at": credential.expires_at,
        "last_used_at": credential.last_used_at,
        "scopes": credential.scopes,
    }


def overview(db: Session, organization_id: str) -> dict[str, Any]:
    managed = provisioner.managed_mode()
    payload: dict[str, Any] = {
        "mode": settings.automation_mode,
        "available": managed and n8n_available(),
        "connection": None,
        "automations": [],
        "manual_keys": 0,
        "report_types": [{"value": k, "label": v} for k, v in REPORT_TYPES.items()],
    }
    payload["manual_keys"] = len([c for c in db.scalars(select(IntegrationCredential).where(
        IntegrationCredential.organization_id == organization_id, IntegrationCredential.managed.is_(False),
        IntegrationCredential.revoked_at.is_(None))).all() if credential_state(c) == "active"])
    if not managed:
        return payload
    rows = provisioner.automation_rows(db, organization_id)
    connection = provisioner.get_connection(db, organization_id)
    db.commit()
    credential = db.get(IntegrationCredential, connection.credential_id) if connection and connection.credential_id \
        else None
    payload["connection"] = {
        "status": connection.status if connection else "disabled",
        "last_error": connection.last_error if connection else None,
        "last_reconciled_at": connection.last_reconciled_at if connection else None,
        "key": _key_payload(credential),
    }
    latest = _latest_runs(db, organization_id)
    payload["automations"] = [automation_payload(rows[key], latest.get(key)) for key in catalog.USER_AUTOMATIONS]
    return payload


# --------------------------------------------------------------------------- changes


def update_automation(db: Session, ctx: OrgContext, key: str, *, enabled: bool | None,
                      values: dict[str, Any] | None, request: Request | None) -> dict[str, Any]:
    """Switch an automation on or off and/or change its settings; n8n is
    updated by a background reconciliation."""
    _require_managed()
    catalog.get_definition(key)
    if enabled:
        _require_available()
    rows = provisioner.automation_rows(db, ctx.organization_id)
    row = rows[key]
    before = {"enabled": row.enabled, "settings": catalog.stored_settings(key, row.settings)}
    if values is not None:
        row.settings = catalog.validate_settings(key, values, base=before["settings"])
    elif row.settings is None:
        row.settings = catalog.default_settings(key)
    if enabled is not None:
        row.enabled = enabled
    after = {"enabled": row.enabled, "settings": catalog.stored_settings(key, row.settings)}
    if after == before:
        return automation_payload(row, _latest_runs(db, ctx.organization_id).get(key))
    if row.enabled or row.n8n_workflow_id:
        row.status = "pending"
        row.last_error = None
    else:
        row.status = "disabled"
    row.updated_by_id = ctx.user.id
    connection = provisioner.get_connection(db, ctx.organization_id, create=True)
    if row.enabled and connection.status in ("disabled", "error"):
        connection.status = "provisioning"
    action = ("automation.enabled" if after["enabled"] and not before["enabled"]
              else "automation.disabled" if before["enabled"] and not after["enabled"]
              else "automation.settings_changed")
    changes = {field: {"from": before[field], "to": after[field]} for field in before if before[field] != after[field]}
    record_audit(db, action=action, actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
                 entity_type="organization_automation", entity_id=row.id,
                 summary=f"{catalog.DEFINITIONS[key].label}: "
                         + {"automation.enabled": "switched on", "automation.disabled": "switched off"}
                         .get(action, "settings changed"),
                 changes=changes, request=request)
    provisioner.request_reconcile(db, ctx.organization_id, commit=False)
    db.commit()
    db.refresh(row)
    return automation_payload(row, _latest_runs(db, ctx.organization_id).get(key))


def disable_all(db: Session, ctx: OrgContext, request: Request | None) -> dict[str, Any]:
    _require_managed()
    rows = provisioner.automation_rows(db, ctx.organization_id)
    switched = [key for key in catalog.USER_AUTOMATIONS if rows[key].enabled]
    for key in switched:
        rows[key].enabled = False
        rows[key].status = "pending" if rows[key].n8n_workflow_id else "disabled"
        rows[key].updated_by_id = ctx.user.id
    if switched:
        record_audit(db, action="automation.disabled_all", actor_user_id=ctx.user.id,
                     organization_id=ctx.organization_id, entity_type="organization",
                     entity_id=ctx.organization_id, summary="Switched every automation off",
                     changes={"automations": switched}, request=request)
    provisioner.request_reconcile(db, ctx.organization_id, commit=False)
    db.commit()
    return overview(db, ctx.organization_id)


def repair(db: Session, ctx: OrgContext, request: Request | None) -> dict[str, Any]:
    """Re-check everything in n8n now (the hourly check does the same)."""
    _require_managed()
    _require_available()
    record_audit(db, action="automation.repair_requested", actor_user_id=ctx.user.id,
                 organization_id=ctx.organization_id, entity_type="organization", entity_id=ctx.organization_id,
                 request=request)
    provisioner.request_reconcile(db, ctx.organization_id, commit=False)
    db.commit()
    return overview(db, ctx.organization_id)


def run_now(db: Session, ctx: OrgContext, key: str, request: Request | None) -> dict[str, Any]:
    _require_managed()
    _require_available()
    definition = catalog.get_definition(key)
    row = provisioner.automation_rows(db, ctx.organization_id)[key]
    if not row.enabled:
        raise ConflictError(f"Switch on {definition.label} first", code="automation_disabled")
    if row.status != "active":
        raise ConflictError(f"{definition.label} is still being set up; try again in a moment",
                            code="automation_not_ready")
    allowed, retry_after = limiter.hit(f"automation_run_now:{ctx.organization_id}:{key}", RUN_NOW_LIMIT,
                                       RUN_NOW_WINDOW_SECONDS)
    if not allowed:
        raise RateLimitedError("This automation was started several times just now; wait a moment",
                               details={"retry_after_seconds": retry_after})
    try:
        provisioner.start_workflow(ctx.organization_id, key, trigger="manual")
    except N8nNotConfigured as exc:
        raise ConflictError(str(exc), code="automation_unavailable") from exc
    except N8nError as exc:
        # The workflow may be missing in n8n: let reconciliation check and repair it.
        provisioner.request_reconcile(db, ctx.organization_id)
        raise ServiceUnavailableError("The automation service didn't accept the request. RightsFlow is "
                                      "checking the connection; try again in a few minutes.",
                                      code="automation_unreachable") from exc
    row.last_triggered_at = utc_now()
    record_audit(db, action="automation.run_requested", actor_user_id=ctx.user.id,
                 organization_id=ctx.organization_id, entity_type="organization_automation", entity_id=row.id,
                 summary=f"{definition.label}: started by hand", request=request)
    db.commit()
    return {"automation": key, "status": "requested", "requested_at": row.last_triggered_at}


# --------------------------------------------------------------------------- run results


def run_detail(db: Session, organization_id: str, run_id: str) -> dict[str, Any]:
    """A run plus links to what it produced."""
    run = db.scalar(select(AutomationRun).where(AutomationRun.id == run_id,
                                                AutomationRun.organization_id == organization_id))
    if run is None:
        raise NotFoundError("Automation run not found")
    tasks = db.scalars(select(AutomationReviewTask).where(
        AutomationReviewTask.organization_id == organization_id, AutomationReviewTask.run_id == run.id)
        .order_by(AutomationReviewTask.created_at)).all()
    deliveries = db.scalars(select(AutomationDelivery).where(
        AutomationDelivery.organization_id == organization_id, AutomationDelivery.run_id == run.id)
        .order_by(AutomationDelivery.created_at)).all()

    statement_ids: list[str] = []
    for result in (run.summary or {}).get("results") or []:
        statement_id = result.get("statement_id") if isinstance(result, dict) else None
        if isinstance(statement_id, str) and len(statement_id) <= 36 and statement_id not in statement_ids:
            statement_ids.append(statement_id)
    statements = db.scalars(select(RoyaltyStatement).where(
        RoyaltyStatement.organization_id == organization_id, RoyaltyStatement.id.in_(statement_ids))).all() \
        if statement_ids else []
    by_id = {s.id: s for s in statements}

    file_ids = [d.detail.get("file_id") for d in deliveries if isinstance(d.detail, dict) and d.detail.get("file_id")]
    files = db.scalars(select(StoredFile).where(StoredFile.organization_id == organization_id,
                                                StoredFile.id.in_(file_ids),
                                                StoredFile.is_deleted.is_(False))).all() if file_ids else []
    return {
        **records.run_payload(run),
        "automation": catalog.automation_for_workflow(run.workflow),
        "outputs": {
            "statements": [{"id": s.id, "source_name": s.source_name, "status": s.status,
                            "period_start": s.period_start, "period_end": s.period_end}
                           for s in (by_id[i] for i in statement_ids if i in by_id)],
            "review_tasks": [records.review_task_payload(t) for t in tasks],
            "deliveries": [records.delivery_payload(d) for d in deliveries],
            "files": [{"id": f.id, "filename": f.original_filename, "size_bytes": f.size_bytes,
                       "created_at": f.created_at} for f in files],
        },
    }
