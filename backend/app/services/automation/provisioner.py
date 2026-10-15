"""Managed mode: provisions each organization's automations in the platform n8n.

RightsFlow owns everything it creates in n8n. People only say which
automations are on and how they are configured (``organization_automations``);
reconciliation makes n8n match:

1. With nothing switched on (or the organization archived) everything is torn
   down: workflows and n8n credentials deleted, managed keys revoked.
2. Otherwise the organization gets a managed automation key carrying exactly the
   scopes its automations need. It is replaced when the scopes change, when it
   nears expiry or when its n8n credential is missing; the old key keeps
   working for a short grace period. Nobody ever sees the token: it goes
   straight into an n8n credential.
3. A second n8n credential authenticates the "Run on request" webhooks. Its
   secret is derived from the server's key, so it is never stored.
4. The error handler is provisioned first (the other workflows point at it),
   then the health check and every enabled automation, each rendered from its
   template with the organization's settings and published. A workflow is only
   updated when the rendered body changes; one missing in n8n is recreated.

Reconciliation runs as a background job, after every settings change and
hourly for every connected organization, so drift (a deleted workflow, a reset
n8n, an expiring key) heals by itself. A lease on ``automation_connections``
keeps two runs for the same organization from interleaving; progress is
committed after every n8n change so ids are never lost.
"""

import hashlib
import json
import secrets
from datetime import timedelta
from typing import Any
from uuid import NAMESPACE_URL, uuid4, uuid5

from sqlalchemy import or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.logging import get_logger
from app.db.mixins import utc_now
from app.models.automation import AutomationConnection, IntegrationCredential, OrganizationAutomation
from app.models.organization import Organization
from app.models.platform import BackgroundJob
from app.services import jobs
from app.services.automation import catalog
from app.services.automation.credentials import (
    credential_state,
    derive_secret,
    issue_managed_credential,
    redact,
    revoke_managed_credentials,
)
from app.services.automation.n8n_client import N8nApi, N8nError, N8nNotConfigured, get_n8n_client

logger = get_logger(__name__)

RECONCILE_JOB = "automation_reconcile"
RECONCILE_ALL_JOB = "automation_reconcile_all"
TRIGGER_JOB = "automation_trigger"
TRIGGER_HEADER = "X-RightsFlow-Trigger"
LEASE = timedelta(minutes=5)
KEY_GRACE = timedelta(hours=1)
RECONCILE_RETRY_DELAY = timedelta(seconds=30)
EVENT_TRIGGER_DELAY = timedelta(seconds=10)


def managed_mode() -> bool:
    return settings.automation_mode == "managed"


# --------------------------------------------------------------------------- state


def get_connection(db: Session, organization_id: str, *, create: bool = False) -> AutomationConnection | None:
    connection = db.scalar(select(AutomationConnection).where(
        AutomationConnection.organization_id == organization_id))
    if connection is None and create:
        connection = AutomationConnection(organization_id=organization_id, status="disabled")
        db.add(connection)
        try:
            db.flush()
        except IntegrityError:
            db.rollback()
            connection = db.scalar(select(AutomationConnection).where(
                AutomationConnection.organization_id == organization_id))
    return connection


def automation_rows(db: Session, organization_id: str) -> dict[str, OrganizationAutomation]:
    """Every automation's row for the organization, creating missing ones
    (switched off, default settings). Flushes."""
    rows = {row.automation: row for row in db.scalars(select(OrganizationAutomation).where(
        OrganizationAutomation.organization_id == organization_id)).all()}
    missing = [key for key in catalog.DEFINITIONS if key not in rows]
    for key in missing:
        rows[key] = OrganizationAutomation(organization_id=organization_id, automation=key, enabled=False,
                                           settings=catalog.default_settings(key), status="disabled")
        db.add(rows[key])
    if missing:
        try:
            db.flush()
        except IntegrityError:
            # Created concurrently; read them back.
            db.rollback()
            return automation_rows(db, organization_id)
    return rows


def trigger_secret(organization_id: str) -> str:
    return derive_secret(f"automation-trigger:{organization_id}")


def _fingerprint(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def webhook_path(organization_id: str, key: str) -> str:
    return f"rightsflow/{organization_id}/{key.replace('_', '-')}"


def _credential_names(organization: Organization) -> tuple[str, str]:
    return (f"RightsFlow [{organization.slug}] automation key", f"RightsFlow [{organization.slug}] trigger")


# --------------------------------------------------------------------------- scheduling work


def request_reconcile(db: Session, organization_id: str, *, commit: bool = True,
                      delay: timedelta | None = None) -> BackgroundJob:
    """Queue a reconciliation unless one is already waiting for this organization."""
    prefix = f"{RECONCILE_JOB}:{organization_id}:"
    queued = db.scalar(select(BackgroundJob).where(
        BackgroundJob.job_type == RECONCILE_JOB, BackgroundJob.organization_id == organization_id,
        BackgroundJob.status == "queued", BackgroundJob.idempotency_key.startswith(prefix)))
    if queued is not None:
        return queued
    return jobs.enqueue(db, organization_id=organization_id, job_type=RECONCILE_JOB, payload={},
                        idempotency_key=prefix + uuid4().hex, max_attempts=5,
                        run_after=utc_now() + delay if delay else None, commit=commit)


def on_event(db: Session, organization_id: str, event_type: str) -> None:
    """Called when an outbox event is written: start the automation that handles
    it right away (e.g. process a statement just after its upload) instead of
    waiting for the next scheduled run. Joins the caller's transaction."""
    if not managed_mode():
        return
    for definition in catalog.DEFINITIONS.values():
        if event_type not in definition.trigger_events:
            continue
        row = db.scalar(select(OrganizationAutomation).where(
            OrganizationAutomation.organization_id == organization_id,
            OrganizationAutomation.automation == definition.key))
        if row is None or not row.enabled or row.status != "active":
            continue
        if not catalog.stored_settings(definition.key, row.settings).get("process_on_upload", True):
            continue
        prefix = f"{TRIGGER_JOB}:{organization_id}:{definition.key}:"
        if db.scalar(select(BackgroundJob.id).where(
                BackgroundJob.job_type == TRIGGER_JOB, BackgroundJob.organization_id == organization_id,
                BackgroundJob.status == "queued", BackgroundJob.idempotency_key.startswith(prefix))) is not None:
            continue  # one pending start covers every event that arrives meanwhile
        # A unique key (never a collision) so enqueue can't roll back the caller's transaction.
        jobs.enqueue(db, organization_id=organization_id, job_type=TRIGGER_JOB,
                     payload={"automation": definition.key, "trigger": "event"},
                     idempotency_key=prefix + uuid4().hex, max_attempts=3,
                     run_after=utc_now() + EVENT_TRIGGER_DELAY, commit=False)


def start_workflow(organization_id: str, key: str, *, trigger: str, client: N8nApi | None = None) -> None:
    """Call the automation's "Run on request" webhook. Raises N8nError."""
    (client or get_n8n_client()).trigger_webhook(
        webhook_path(organization_id, key), header_name=TRIGGER_HEADER, secret=trigger_secret(organization_id),
        payload={"trigger": trigger})


# --------------------------------------------------------------------------- reconciliation


def _acquire_lease(db: Session, organization_id: str) -> AutomationConnection | None:
    connection = get_connection(db, organization_id, create=True)
    db.commit()
    token = secrets.token_hex(16)
    now = utc_now()
    result = db.execute(update(AutomationConnection).where(
        AutomationConnection.id == connection.id,
        or_(AutomationConnection.lease_expires_at.is_(None), AutomationConnection.lease_expires_at < now),
    ).values(lease_token=token, lease_expires_at=now + LEASE))
    db.commit()
    if not result.rowcount:
        return None
    db.refresh(connection)
    return connection if connection.lease_token == token else None


def _release_lease(db: Session, connection: AutomationConnection) -> None:
    connection.lease_token = None
    connection.lease_expires_at = None
    db.commit()


def reconcile_organization(db: Session, organization_id: str, *, client: N8nApi | None = None) -> dict[str, Any]:
    """Make the platform n8n match the organization's automation settings.
    Returns ``{"deferred": True}`` when another reconciliation holds the lease.
    Failures (N8nError and anything unexpected) are recorded on the connection
    and the affected automations, then re-raised so the job is retried."""
    connection = _acquire_lease(db, organization_id)
    if connection is None:
        return {"deferred": True}
    try:
        result = _reconcile(db, connection, client)
        connection.last_error = None
        connection.last_reconciled_at = utc_now()
        db.commit()
        return result
    except Exception as exc:
        db.rollback()
        message = redact(str(exc) if isinstance(exc, N8nError) else f"Internal error ({exc.__class__.__name__})", 500)
        connection.status = "error"
        connection.last_error = message
        for row in automation_rows(db, organization_id).values():
            if row.enabled and row.status != "active":
                row.status = "error"
                row.last_error = message
        db.commit()
        logger.warning("Automation reconciliation failed for %s: %s", organization_id, message)
        raise
    finally:
        _release_lease(db, connection)


def _reconcile(db: Session, connection: AutomationConnection, client: N8nApi | None) -> dict[str, Any]:
    organization = db.get(Organization, connection.organization_id)
    rows = automation_rows(db, connection.organization_id)
    db.commit()
    wanted = set()
    if managed_mode() and organization is not None and organization.is_active:
        wanted = {key for key in catalog.USER_AUTOMATIONS if rows[key].enabled}
    if not wanted:
        if connection.status == "disabled" and not any(row.n8n_workflow_id for row in rows.values()) \
                and connection.n8n_credential_id is None and connection.n8n_trigger_credential_id is None:
            _revoke_keys(db, connection)
            return {"status": "disabled"}
        _teardown(db, connection, rows, client or get_n8n_client())
        return {"status": "disabled"}

    client = client or get_n8n_client()
    if connection.status != "active":
        connection.status = "provisioning"
        db.commit()
    provisioned = wanted | set(catalog.SYSTEM_AUTOMATIONS)
    _ensure_api_credential(db, connection, organization, catalog.required_scopes(provisioned), client)
    _ensure_trigger_credential(db, connection, organization, client)
    # The error handler first: every other workflow names it as its error workflow.
    _ensure_workflow(db, connection, organization, rows, catalog.ERROR_HANDLER, client)
    for key in catalog.DEFINITIONS:
        if key == catalog.ERROR_HANDLER:
            continue
        if key in provisioned:
            _ensure_workflow(db, connection, organization, rows, key, client)
        else:
            _remove_workflow(db, rows[key], client)
    # Keys replaced earlier whose grace period has ended.
    revoke_managed_credentials(db, connection.organization_id, keep_id=connection.credential_id,
                               reason="replaced", only_expired=True)
    connection.status = "active"
    db.commit()
    return {"status": "active", "automations": sorted(wanted)}


def _ensure_api_credential(db: Session, connection: AutomationConnection, organization: Organization,
                           scopes: list[str], client: N8nApi) -> None:
    current = db.get(IntegrationCredential, connection.credential_id) if connection.credential_id else None
    remote = client.get_credential(connection.n8n_credential_id) if connection.n8n_credential_id else None
    renew_by = utc_now() + timedelta(days=settings.automation_managed_rotate_before_days)
    if (current is not None and remote is not None and credential_state(current) == "active"
            and sorted(current.scopes or []) == scopes
            and (current.expires_at is None or current.expires_at > renew_by)):
        return
    # Only the token's hash is stored, so the n8n credential can only be
    # (re)written together with a newly issued key.
    issued = issue_managed_credential(db, organization.id, scopes=scopes, previous=current, grace=KEY_GRACE)
    name, _ = _credential_names(organization)
    data = {"name": "Authorization", "value": f"Bearer {issued.token}"}
    if remote is not None:
        client.update_credential(connection.n8n_credential_id, name=name, data=data)
    else:
        created = client.create_credential(name=name, credential_type="httpHeaderAuth", data=data)
        connection.n8n_credential_id = str(created["id"])
    connection.credential_id = issued.credential.id
    db.commit()


def _ensure_trigger_credential(db: Session, connection: AutomationConnection, organization: Organization,
                               client: N8nApi) -> None:
    secret = trigger_secret(organization.id)
    fingerprint = _fingerprint(secret)
    remote = (client.get_credential(connection.n8n_trigger_credential_id)
              if connection.n8n_trigger_credential_id else None)
    if remote is not None and connection.trigger_fingerprint == fingerprint:
        return
    _, name = _credential_names(organization)
    data = {"name": TRIGGER_HEADER, "value": secret}
    if remote is not None:
        client.update_credential(connection.n8n_trigger_credential_id, name=name, data=data)
    else:
        created = client.create_credential(name=name, credential_type="httpHeaderAuth", data=data)
        connection.n8n_trigger_credential_id = str(created["id"])
    connection.trigger_fingerprint = fingerprint
    db.commit()


def render_workflow(connection: AutomationConnection, organization: Organization,
                    rows: dict[str, OrganizationAutomation], key: str) -> dict[str, Any]:
    values = catalog.stored_settings(key, rows[key].settings)
    cron, _ = catalog.schedule(key, values, organization.id)
    api_name, trigger_name = _credential_names(organization)
    return catalog.render_template(key, {
        "__RF_API_URL__": settings.automation_api_url.rstrip("/"),
        "__RF_INSTANCE_ID__": settings.n8n_instance_id,
        "__RF_N8N_HEALTH_URL__": settings.n8n_health_check_url,
        "__RF_SETTINGS_JSON__": json.dumps(values, sort_keys=True),
        "__RF_CRON__": cron or "",
        "__RF_WEBHOOK_PATH__": webhook_path(organization.id, key),
        "__RF_WEBHOOK_ID__": str(uuid5(NAMESPACE_URL, f"rightsflow/{organization.id}/{key}")),
        "__RF_API_CREDENTIAL_ID__": connection.n8n_credential_id or "",
        "__RF_API_CREDENTIAL_NAME__": api_name,
        "__RF_TRIGGER_CREDENTIAL_ID__": connection.n8n_trigger_credential_id or "",
        "__RF_TRIGGER_CREDENTIAL_NAME__": trigger_name,
        "__RF_ERROR_WORKFLOW_ID__": rows[catalog.ERROR_HANDLER].n8n_workflow_id or "",
        "__RF_ORG_LABEL__": organization.slug,
    })


def _ensure_workflow(db: Session, connection: AutomationConnection, organization: Organization,
                     rows: dict[str, OrganizationAutomation], key: str, client: N8nApi) -> None:
    row = rows[key]
    body = render_workflow(connection, organization, rows, key)
    digest = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()
    remote = client.get_workflow(row.n8n_workflow_id) if row.n8n_workflow_id else None
    if remote is None:
        created = client.create_workflow(body)
        row.n8n_workflow_id = str(created["id"])
        row.config_hash = None
        db.commit()  # keep the id even if publishing fails
        client.publish_workflow(row.n8n_workflow_id)
    elif row.config_hash != digest:
        client.update_workflow(row.n8n_workflow_id, body)
        # Saving changes a draft in n8n 2.x; publishing makes it the running version.
        client.publish_workflow(row.n8n_workflow_id)
    elif not remote.get("active"):
        client.publish_workflow(row.n8n_workflow_id)
    row.config_hash = digest
    row.template_version = catalog.template_version(key)
    row.status = "active"
    row.last_error = None
    row.provisioned_at = utc_now()
    db.commit()


def _remove_workflow(db: Session, row: OrganizationAutomation, client: N8nApi) -> None:
    if row.n8n_workflow_id:
        client.unpublish_workflow(row.n8n_workflow_id)
        client.delete_workflow(row.n8n_workflow_id)
    row.n8n_workflow_id = None
    row.config_hash = None
    row.template_version = None
    row.status = "disabled"
    row.last_error = None
    db.commit()


def _teardown(db: Session, connection: AutomationConnection, rows: dict[str, OrganizationAutomation],
              client: N8nApi) -> None:
    for key in catalog.DEFINITIONS:
        if key != catalog.ERROR_HANDLER:
            _remove_workflow(db, rows[key], client)
    _remove_workflow(db, rows[catalog.ERROR_HANDLER], client)
    for credential_id in (connection.n8n_credential_id, connection.n8n_trigger_credential_id):
        if credential_id:
            client.delete_credential(credential_id)
    connection.n8n_credential_id = None
    connection.n8n_trigger_credential_id = None
    connection.trigger_fingerprint = None
    _revoke_keys(db, connection)


def _revoke_keys(db: Session, connection: AutomationConnection) -> None:
    revoke_managed_credentials(db, connection.organization_id, keep_id=None, reason="automation switched off")
    connection.credential_id = None
    connection.status = "disabled"
    db.commit()


# --------------------------------------------------------------------------- jobs


@jobs.job_handler(RECONCILE_JOB)
def reconcile_job(db: Session, ctx: jobs.JobContext) -> dict[str, Any]:
    if ctx.organization_id is None:
        raise jobs.PermanentJobError("Reconciliation needs an organization")
    try:
        result = reconcile_organization(db, ctx.organization_id)
    except N8nNotConfigured as exc:
        raise jobs.PermanentJobError(str(exc)) from exc
    if result.get("deferred"):
        request_reconcile(db, ctx.organization_id, delay=RECONCILE_RETRY_DELAY)
    return result


@jobs.job_handler(RECONCILE_ALL_JOB)
def reconcile_all_job(db: Session, ctx: jobs.JobContext) -> dict[str, Any]:
    """Hourly: heal drift and renew keys for every organization that uses
    managed automation (or still has something provisioned to clean up)."""
    if not managed_mode():
        return {"skipped": "not managed"}
    organization_ids = set(db.scalars(select(OrganizationAutomation.organization_id).where(
        or_(OrganizationAutomation.enabled.is_(True), OrganizationAutomation.n8n_workflow_id.is_not(None)))).all())
    organization_ids.update(db.scalars(select(AutomationConnection.organization_id).where(
        AutomationConnection.status != "disabled")).all())
    for organization_id in sorted(organization_ids):
        request_reconcile(db, organization_id)
    return {"organizations": len(organization_ids)}


@jobs.job_handler(TRIGGER_JOB)
def trigger_job(db: Session, ctx: jobs.JobContext) -> dict[str, Any]:
    key = ctx.payload.get("automation")
    if key not in catalog.USER_AUTOMATIONS or ctx.organization_id is None:
        raise jobs.PermanentJobError("Unknown automation")
    row = db.scalar(select(OrganizationAutomation).where(
        OrganizationAutomation.organization_id == ctx.organization_id, OrganizationAutomation.automation == key))
    if not managed_mode() or row is None or not row.enabled or row.status != "active":
        return {"skipped": "automation not active"}
    try:
        start_workflow(ctx.organization_id, key, trigger=str(ctx.payload.get("trigger") or "event"))
    except N8nNotConfigured as exc:
        raise jobs.PermanentJobError(str(exc)) from exc
    row.last_triggered_at = utc_now()
    db.commit()
    return {"triggered": key}
