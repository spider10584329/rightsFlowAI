"""The current user's in-app notifications, and the organization email log.

Notifications belong to a user (optionally tagged with an organization).
A notification owned by someone else is reported as 404.
"""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Path, Query
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.core.dependencies import get_current_user
from app.core.errors import NotFoundError
from app.core.permissions import OrgAdmin
from app.db.mixins import utc_now
from app.db.session import get_db
from app.models.platform import EmailMessage, Notification
from app.models.user import User
from app.schemas.common import MessageResponse, Page, PageParams, page_of, paginate
from app.schemas.notification import (
    EmailLogResponse,
    NotificationPage,
    NotificationResponse,
    ReadAllResponse,
    UnreadCountResponse,
)

router = APIRouter(prefix="/notifications", tags=["Notifications"])
email_log_router = APIRouter(prefix="/organizations/{organization_id}", tags=["Notifications"])

OrgFilter = Annotated[str | None, Query(max_length=36)]
NotificationId = Annotated[str, Path(max_length=36)]


def _unread_count(db: Session, user_id: str, organization_id: str | None = None) -> int:
    stmt = select(func.count()).select_from(Notification).where(
        Notification.user_id == user_id, Notification.is_read.is_(False)
    )
    if organization_id:
        stmt = stmt.where(Notification.organization_id == organization_id)
    return int(db.scalar(stmt) or 0)


def _own_notification(db: Session, notification_id: str, user: User) -> Notification:
    notification = db.scalar(
        select(Notification).where(
            Notification.id == notification_id, Notification.user_id == user.id
        )
    )
    if notification is None:
        raise NotFoundError("Notification not found")
    return notification


@router.get("", response_model=NotificationPage)
def list_notifications(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    params: PageParams = Depends(),
    unread_only: bool = False,
    organization_id: OrgFilter = None,
):
    """The current user's notifications, newest first."""
    stmt = select(Notification).where(Notification.user_id == current_user.id)
    if unread_only:
        stmt = stmt.where(Notification.is_read.is_(False))
    if organization_id:
        stmt = stmt.where(Notification.organization_id == organization_id)
    rows, total = paginate(
        db,
        stmt,
        params,
        sortable={"created_at": Notification.created_at},
        default_sort=Notification.created_at.desc(),
    )
    data = page_of([NotificationResponse.model_validate(r) for r in rows], total, params)
    data["unread_count"] = _unread_count(db, current_user.id, organization_id)
    return data


@router.get("/unread-count", response_model=UnreadCountResponse)
def unread_count(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    organization_id: OrgFilter = None,
):
    return {"unread_count": _unread_count(db, current_user.id, organization_id)}


@router.post("/read-all", response_model=ReadAllResponse)
def mark_all_read(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    organization_id: OrgFilter = None,
):
    """Mark every unread notification as read (optionally for one organization)."""
    stmt = (
        update(Notification)
        .where(Notification.user_id == current_user.id, Notification.is_read.is_(False))
        .values(is_read=True, read_at=utc_now())
    )
    if organization_id:
        stmt = stmt.where(Notification.organization_id == organization_id)
    result = db.execute(stmt)
    db.commit()
    return {
        "affected": int(result.rowcount or 0),
        "unread_count": _unread_count(db, current_user.id),
    }


@router.post("/{notification_id}/read", response_model=NotificationResponse)
def mark_read(
    notification_id: NotificationId,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    notification = _own_notification(db, notification_id, current_user)
    if not notification.is_read:
        notification.is_read = True
        notification.read_at = utc_now()
        db.commit()
    return notification


@router.post("/{notification_id}/unread", response_model=NotificationResponse)
def mark_unread(
    notification_id: NotificationId,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    notification = _own_notification(db, notification_id, current_user)
    if notification.is_read:
        notification.is_read = False
        notification.read_at = None
        db.commit()
    return notification


@router.delete("/{notification_id}", response_model=MessageResponse)
def delete_notification(
    notification_id: NotificationId,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    notification = _own_notification(db, notification_id, current_user)
    db.delete(notification)
    db.commit()
    return MessageResponse(message="Notification deleted")


# --------------------------------------------------------------------------- email log (admin)


@email_log_router.get("/email-log", response_model=Page[EmailLogResponse])
def email_log(
    ctx: OrgAdmin,
    db: Session = Depends(get_db),
    params: PageParams = Depends(),
    status: Annotated[Literal["queued", "sent", "logged", "failed"] | None, Query()] = None,
    template: Annotated[str | None, Query(max_length=50)] = None,
):
    """Outbound email for this organization, newest first. ``delivered`` is
    true only for ``sent``; ``logged`` emails were NOT delivered."""
    stmt = select(EmailMessage).where(EmailMessage.organization_id == ctx.organization_id)
    if status:
        stmt = stmt.where(EmailMessage.status == status)
    if template:
        stmt = stmt.where(EmailMessage.template == template)
    rows, total = paginate(
        db,
        stmt,
        params,
        sortable={"created_at": EmailMessage.created_at, "status": EmailMessage.status},
        default_sort=EmailMessage.created_at.desc(),
    )
    items = [
        EmailLogResponse(
            id=r.id,
            to_email=r.to_email,
            subject=r.subject,
            template=r.template,
            provider=r.provider,
            status=r.status,
            delivered=r.status == "sent",
            error=r.error,
            created_at=r.created_at,
            sent_at=r.sent_at,
        )
        for r in rows
    ]
    return page_of(items, total, params)
