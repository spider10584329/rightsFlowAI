"""In-app notification and email log schemas."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict

from app.schemas.common import Page


class NotificationResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    organization_id: str | None = None
    type: str
    title: str
    body: str | None = None
    link: str | None = None
    severity: str
    is_read: bool
    read_at: datetime | None = None
    created_at: datetime


class NotificationPage(Page[NotificationResponse]):
    unread_count: int


class UnreadCountResponse(BaseModel):
    unread_count: int


class ReadAllResponse(BaseModel):
    affected: int
    unread_count: int


class EmailLogResponse(BaseModel):
    """Outbound email record. Bodies are not exposed: they can contain
    single-use links (invitations, password resets)."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    to_email: str
    subject: str
    template: str
    provider: str
    status: str
    # True only when a real provider accepted the message (status "sent").
    # "logged" means the console provider wrote a preview and did NOT deliver.
    delivered: bool
    error: str | None = None
    created_at: datetime
    sent_at: datetime | None = None
