"""Cross-cutting platform tables: audit, notifications, email, files, jobs."""

from datetime import datetime
from typing import Any

from sqlalchemy import (
    event,
    JSON,
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.mixins import (
    CreatedByMixin,
    TenantMixin,
    TimestampMixin,
    UUIDPrimaryKeyMixin,
    utc_now,
)


class AuditLog(UUIDPrimaryKeyMixin, Base):
    """Append-only record of security and business events."""

    __tablename__ = "audit_logs"
    __table_args__ = (
        Index("ix_audit_org_created", "organization_id", "created_at"),
        Index("ix_audit_entity", "entity_type", "entity_id"),
    )

    organization_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("organizations.id", ondelete="CASCADE")
    )
    actor_user_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    action: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    entity_type: Mapped[str | None] = mapped_column(String(50))
    entity_id: Mapped[str | None] = mapped_column(String(36))
    summary: Mapped[str | None] = mapped_column(String(500))
    changes: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    ip_address: Mapped[str | None] = mapped_column(String(64))
    user_agent: Mapped[str | None] = mapped_column(String(255))
    request_id: Mapped[str | None] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)


class Notification(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "notifications"
    __table_args__ = (
        Index("ix_notifications_user_read", "user_id", "is_read"),
        Index("ix_notifications_user_created", "user_id", "created_at"),
    )

    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    organization_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("organizations.id", ondelete="CASCADE"), index=True
    )
    type: Mapped[str] = mapped_column(String(50), nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    body: Mapped[str | None] = mapped_column(Text)
    link: Mapped[str | None] = mapped_column(String(500))
    severity: Mapped[str] = mapped_column(String(20), default="info", nullable=False)
    is_read: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    read_at: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)


class EmailMessage(UUIDPrimaryKeyMixin, Base):
    """Outbound email log. ``status='logged'`` means it was NOT delivered."""

    __tablename__ = "email_messages"
    __table_args__ = (
        CheckConstraint(
            "status IN ('queued', 'sent', 'logged', 'failed')", name="ck_email_status"
        ),
        Index("ix_email_org_created", "organization_id", "created_at"),
    )

    organization_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("organizations.id", ondelete="SET NULL"), index=True
    )
    to_email: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    subject: Mapped[str] = mapped_column(String(255), nullable=False)
    template: Mapped[str] = mapped_column(String(50), nullable=False)
    body_text: Mapped[str] = mapped_column(Text, nullable=False)
    provider: Mapped[str] = mapped_column(String(20), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    error: Mapped[str | None] = mapped_column(Text)
    preview_path: Mapped[str | None] = mapped_column(String(500))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime)


class StoredFile(UUIDPrimaryKeyMixin, TenantMixin, CreatedByMixin, Base):
    """Metadata for a private file held by the storage backend."""

    __tablename__ = "stored_files"
    __table_args__ = (
        CheckConstraint(
            "category IN ('contract', 'statement', 'import', 'export', 'other')",
            name="ck_stored_file_category",
        ),
        Index("ix_stored_files_org_sha", "organization_id", "sha256"),
    )

    category: Mapped[str] = mapped_column(String(20), nullable=False)
    storage_backend: Mapped[str] = mapped_column(String(20), nullable=False)
    storage_key: Mapped[str] = mapped_column(String(500), nullable=False, unique=True)
    original_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    content_type: Mapped[str] = mapped_column(String(120), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # Set automatically when is_deleted flips to True; bytes are purged after
    # FILE_PURGE_AFTER_DAYS by the ``storage_purge`` job.
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime)
    purged_at: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)


@event.listens_for(StoredFile.is_deleted, "set")
def _stamp_deleted_at(target: StoredFile, value: bool, oldvalue: object, _initiator: object) -> None:
    if value and oldvalue is not True and target.deleted_at is None:
        target.deleted_at = utc_now()


class BackgroundJob(UUIDPrimaryKeyMixin, CreatedByMixin, TimestampMixin, Base):
    __tablename__ = "background_jobs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')",
            name="ck_job_status",
        ),
        UniqueConstraint("idempotency_key", name="uq_job_idempotency_key"),
        Index("ix_jobs_status_run_after", "status", "run_after"),
    )

    # NULL for platform-level jobs (e.g. email delivery, storage purge).
    organization_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("organizations.id", ondelete="CASCADE"), index=True
    )
    job_type: Mapped[str] = mapped_column(String(50), nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="queued", nullable=False)
    progress: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    payload: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    result: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    error: Mapped[str | None] = mapped_column(Text)
    attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    max_attempts: Mapped[int] = mapped_column(Integer, default=3, nullable=False)
    idempotency_key: Mapped[str | None] = mapped_column(String(191))
    run_after: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    locked_by: Mapped[str | None] = mapped_column(String(100))
    started_at: Mapped[datetime | None] = mapped_column(DateTime)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime)
