"""Periodic jobs.

The worker calls :func:`schedule_periodic_jobs` roughly every hour. It queues
one ``contract_expiry_check`` per active organization per UTC day; the
idempotency key makes repeated calls (and several workers) harmless.
"""

from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.logging import get_logger
from app.db.mixins import utc_now
from app.models.contract import Contract
from app.models.organization import Organization
from app.models.platform import AuditLog, BackgroundJob
from app.services.audit import record_audit
from app.services.jobs import JobContext, enqueue, job_handler
from app.services.notifications import notify_org
from app.services.organization_service import org_settings

logger = get_logger(__name__)

CONTRACT_EXPIRY_JOB = "contract_expiry_check"
RENEWAL_DUE_ACTION = "contract.renewal_due"


def expiry_job_key(organization_id: str, day: str) -> str:
    return f"contract_expiry:{organization_id}:{day}"


def schedule_periodic_jobs(db: Session, now: datetime | None = None) -> int:
    """Queue today's periodic jobs; returns how many new jobs were created."""
    day = (now or utc_now()).date().isoformat()
    org_ids = list(db.scalars(select(Organization.id).where(Organization.is_active.is_(True))))
    keys = {expiry_job_key(org_id, day): org_id for org_id in org_ids}
    existing: set[str] = set()
    key_list = list(keys)
    for i in range(0, len(key_list), 500):
        existing.update(db.scalars(
            select(BackgroundJob.idempotency_key).where(
                BackgroundJob.idempotency_key.in_(key_list[i:i + 500])
            )
        ))
    created = 0
    for key, org_id in keys.items():
        if key in existing:
            continue
        enqueue(db, organization_id=org_id, job_type=CONTRACT_EXPIRY_JOB,
                payload={"date": day}, idempotency_key=key)
        created += 1
    if created:
        logger.info("Scheduled %s contract expiry checks for %s", created, day)

    # Platform-wide daily maintenance (no organization).
    purge_key = f"storage_purge:{day}"
    if db.scalar(select(BackgroundJob.id).where(BackgroundJob.idempotency_key == purge_key)) is None:
        enqueue(db, organization_id=None, job_type="storage_purge", payload={"date": day},
                idempotency_key=purge_key, max_attempts=2)
        created += 1
    automation_key = f"automation_maintenance:{day}"
    if db.scalar(select(BackgroundJob.id).where(BackgroundJob.idempotency_key == automation_key)) is None:
        enqueue(db, organization_id=None, job_type="automation_maintenance", payload={"date": day},
                idempotency_key=automation_key, max_attempts=2)
        created += 1
    return created


def _link(contract: Contract) -> str:
    return f"/contracts/{contract.id}"


@job_handler(CONTRACT_EXPIRY_JOB)
def contract_expiry_check(db: Session, ctx: JobContext) -> dict[str, Any]:
    org = db.get(Organization, ctx.organization_id)
    if org is None or not org.is_active:
        return {"skipped": "organization inactive"}
    now = utc_now()
    today = now.date()
    warning_days = org_settings(org).contract_expiry_warning_days
    base = (Contract.organization_id == org.id, Contract.status == "active")

    # 1. Fixed-term contracts past their end date become expired.
    expired = 0
    for contract in db.scalars(select(Contract).where(
        *base, Contract.auto_renew.is_(False), Contract.end_date < today
    )):
        contract.status = "expired"
        contract.expiry_notified_at = contract.expiry_notified_at or now
        record_audit(
            db, action="contract.expired", organization_id=org.id, entity_type="contract",
            entity_id=contract.id,
            summary=f"Contract {contract.title} expired on {contract.end_date.isoformat()}",
            changes={"status": {"from": "active", "to": "expired"}},
        )
        notify_org(
            db, organization_id=org.id, type="contract_expiration",
            title=f"Contract expired: {contract.title}",
            body=f"The contract ended on {contract.end_date.isoformat()} and is now marked "
                 "expired.",
            link=_link(contract), severity="warning",
        )
        expired += 1

    # 2. One warning per contract when it enters the warning window.
    warned = 0
    for contract in db.scalars(select(Contract).where(
        *base,
        Contract.expiry_notified_at.is_(None),
        Contract.end_date >= today,
        Contract.end_date <= today + timedelta(days=warning_days),
    )):
        days = (contract.end_date - today).days
        renewal = (
            " It renews automatically unless notice is given"
            + (f" ({contract.notice_period_days} days' notice)."
               if contract.notice_period_days else ".")
            if contract.auto_renew else ""
        )
        notify_org(
            db, organization_id=org.id, type="contract_expiration",
            title=f"Contract expiring in {days} day{'s' if days != 1 else ''}: {contract.title}",
            body=f"The contract ends on {contract.end_date.isoformat()}.{renewal}",
            link=_link(contract), severity="warning",
        )
        contract.expiry_notified_at = now
        warned += 1

    # 3. Auto-renewing contracts past their renewal point: notify once, never
    #    change dates automatically.
    renewal_candidates = [
        c for c in db.scalars(select(Contract).where(*base, Contract.auto_renew.is_(True)))
        if (c.renewal_date or c.end_date) and (c.renewal_date or c.end_date) < today
    ]
    renewals = 0
    if renewal_candidates:
        already = {
            (entry.entity_id, (entry.changes or {}).get("renewal_point"))
            for entry in db.scalars(select(AuditLog).where(
                AuditLog.organization_id == org.id,
                AuditLog.action == RENEWAL_DUE_ACTION,
                AuditLog.entity_id.in_([c.id for c in renewal_candidates]),
            ))
        }
        for contract in renewal_candidates:
            point = (contract.renewal_date or contract.end_date).isoformat()
            if (contract.id, point) in already:
                continue
            record_audit(
                db, action=RENEWAL_DUE_ACTION, organization_id=org.id, entity_type="contract",
                entity_id=contract.id,
                summary=f"Auto-renewal point {point} passed for {contract.title}",
                changes={"renewal_point": point},
            )
            notify_org(
                db, organization_id=org.id, type="contract_expiration",
                title=f"Auto-renewal date passed: {contract.title}",
                body=f"The renewal date {point} has passed. Dates are not changed "
                     "automatically; confirm the renewal and update the contract term.",
                link=_link(contract), severity="warning",
            )
            renewals += 1

    return {"date": today.isoformat(), "expired": expired, "warned": warned,
            "renewal_notices": renewals}
