"""Daily automation housekeeping (platform job, scheduled with storage purge).

- Purges stored idempotency responses and completed events past retention.
- Expires stale pending events (kept for history; never deleted here) (N8N-05).
- Warns admins about automation keys that are about to expire or have expired.
  This runs in the backend, independently of n8n, so the warning arrives even
  when n8n is down or its key is already rejected (N8N-04).
"""

from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.mixins import utc_now
from app.models.automation import IntegrationCredential
from app.services import jobs
from app.services.automation import records
from app.services.automation.credentials import expiry_level
from app.services.automation.events import expire_stale_events, purge_completed
from app.services.automation.idempotency import purge_expired
from app.services.notifications import notify_user, org_member_ids

AUTOMATION_MAINTENANCE_JOB = "automation_maintenance"
EXPIRED_NOTICE_WINDOW = timedelta(days=7)


def notify_expiring_credentials(db: Session) -> int:
    """One notice per (key, level) to the organization's admins. Commits."""
    sent = 0
    now = utc_now()
    for credential in db.scalars(select(IntegrationCredential).where(
            IntegrationCredential.revoked_at.is_(None),
            IntegrationCredential.expires_at.is_not(None),
            IntegrationCredential.expires_at > now - EXPIRED_NOTICE_WINDOW)).all():
        level, days_left = expiry_level(credential)
        if level not in ("warning", "critical", "expired"):
            continue
        delivery, created = records.reserve_delivery(
            db, organization_id=credential.organization_id, kind="credential_expiry",
            dedupe_key=f"credential-expiry:{credential.id}:{level}", subject_type="integration_credential",
            subject_id=credential.id)
        if not created:
            continue
        if level == "expired":
            title = f"Automation key '{credential.name}' has expired: n8n workflows are failing"
            body = "Create or rotate a key in Settings > Automation and update n8n (scripts\\setup-n8n-automation.ps1)."
        else:
            title = f"Automation key '{credential.name}' expires in {days_left} day(s)"
            body = ("Rotate it in Settings > Automation (the old key keeps working during the grace period), "
                    "then update n8n with scripts\\setup-n8n-automation.ps1.")
        notified = []
        for user_id in org_member_ids(db, credential.organization_id, minimum_role="admin"):
            if notify_user(db, user_id=user_id, organization_id=credential.organization_id, type="automation_failed",
                           title=title[:255], body=body, link="/settings/automation?tab=keys",
                           severity="error" if level in ("critical", "expired") else "warning") is not None:
                notified.append(user_id)
        delivery.recipient_user_ids = notified
        delivery.status = "sent" if notified else "skipped"
        delivery.sent_at = now if notified else None
        delivery.detail = {"level": level, "days_until_expiry": days_left, "key_id": credential.key_id}
        sent += 1
    db.commit()
    return sent


@jobs.job_handler(AUTOMATION_MAINTENANCE_JOB)
def automation_maintenance(db: Session, ctx: jobs.JobContext) -> dict:
    idempotency = purge_expired(db)
    completed_events = purge_completed(db)
    db.commit()
    expired_events = expire_stale_events(db)
    credential_notices = notify_expiring_credentials(db)
    return {"idempotency_keys_purged": idempotency, "completed_events_purged": completed_events,
            "pending_events_expired": expired_events, "credential_notices": credential_notices}
