"""In-app notifications, with optional email copies per user preference."""

from collections.abc import Iterable
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.permissions import ROLE_RANK
from app.models.organization_membership import OrganizationMembership
from app.models.platform import Notification
from app.models.user import User

# Notification types that may also be emailed, with their default setting.
# "invitation" is excluded because invitations already send their own email.
EMAIL_NOTIFICATION_TYPES: dict[str, dict[str, Any]] = {
    "payout_approval_request": {"label": "Payout batches awaiting approval", "default": True},
    "contract_expiration": {"label": "Contract expirations and renewals", "default": True},
    "rights_conflict": {"label": "New rights conflicts", "default": True},
    "import_failed": {"label": "Failed statement or catalog imports", "default": True},
    "contract_analysis_failed": {"label": "Failed contract analyses", "default": True},
    "ownership_transferred": {"label": "Organization ownership changes", "default": True},
    "import_completed": {"label": "Completed imports", "default": False},
    "royalty_processing_completed": {"label": "Royalties posted to the ledger", "default": False},
    "contract_analysis_completed": {"label": "Completed contract analyses", "default": False},
    "invitation_accepted": {"label": "Accepted invitations", "default": False},
    "report_ready": {"label": "Report exports ready", "default": False},
    "automation_review": {"label": "Items automation flagged for review", "default": True},
    "automation_failed": {"label": "Failed automation workflows (admins)", "default": True},
    "monthly_report": {"label": "Monthly royalty reports ready (admins)", "default": True},
}


def effective_preferences(user: User) -> dict[str, Any]:
    stored = user.notification_preferences or {}
    types = stored.get("email_types") or {}
    return {
        "email_enabled": bool(stored.get("email_enabled", True)),
        "email_types": {
            key: bool(types.get(key, meta["default"])) for key, meta in EMAIL_NOTIFICATION_TYPES.items()
        },
    }


def wants_email(user: User, notification_type: str) -> bool:
    if notification_type not in EMAIL_NOTIFICATION_TYPES or not user.is_active:
        return False
    prefs = effective_preferences(user)
    return prefs["email_enabled"] and prefs["email_types"].get(notification_type, False)


def notify_user(
    db: Session,
    *,
    user_id: str,
    type: str,
    title: str,
    body: str | None = None,
    link: str | None = None,
    organization_id: str | None = None,
    severity: str = "info",
) -> Notification | None:
    """Notify a user. Organization-scoped notifications are dropped for users
    who are no longer active members: removed members must not keep learning
    about the organization's activity (audit A-11). Invitations are exempt —
    their recipient is not a member yet."""
    user = db.get(User, user_id)
    if user is None or not user.is_active or user.is_service_account:
        return None
    if organization_id and type != "invitation" and not _is_active_member(db, organization_id, user_id):
        return None
    notification = Notification(
        user_id=user_id,
        organization_id=organization_id,
        type=type,
        title=title[:255],
        body=body,
        link=link,
        severity=severity,
    )
    db.add(notification)
    if wants_email(user, type):
        from app.services.email import frontend_link, send_email

        lines = [title]
        if body:
            lines += ["", body]
        if link:
            lines += ["", f"Open in RightsFlow: {frontend_link(link)}"]
        lines += ["", "You can change which notifications are emailed in your profile settings."]
        send_email(db, to=user.email, subject=f"RightsFlow: {title}"[:255], body="\n".join(lines),
                   template=f"notification:{type}"[:50], organization_id=organization_id)
    return notification


def _is_active_member(db: Session, organization_id: str, user_id: str) -> bool:
    return (
        db.scalar(
            select(OrganizationMembership.id).where(
                OrganizationMembership.organization_id == organization_id,
                OrganizationMembership.user_id == user_id,
                OrganizationMembership.is_active.is_(True),
            )
        )
        is not None
    )


def org_member_ids(db: Session, organization_id: str, minimum_role: str = "viewer") -> list[str]:
    rows = db.execute(
        select(OrganizationMembership.user_id, OrganizationMembership.role).where(
            OrganizationMembership.organization_id == organization_id,
            OrganizationMembership.is_active.is_(True),
        )
    ).all()
    return [uid for uid, role in rows if ROLE_RANK[role] >= ROLE_RANK[minimum_role]]


def notify_org(
    db: Session,
    *,
    organization_id: str,
    type: str,
    title: str,
    body: str | None = None,
    link: str | None = None,
    minimum_role: str = "manager",
    severity: str = "info",
    exclude_user_ids: Iterable[str] = (),
) -> int:
    excluded = set(exclude_user_ids)
    count = 0
    for user_id in org_member_ids(db, organization_id, minimum_role):
        if user_id in excluded:
            continue
        notify_user(
            db,
            user_id=user_id,
            type=type,
            title=title,
            body=body,
            link=link,
            organization_id=organization_id,
            severity=severity,
        )
        count += 1
    return count
