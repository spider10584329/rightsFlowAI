from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.mixins import UUIDPrimaryKeyMixin, utc_now


class RefreshToken(UUIDPrimaryKeyMixin, Base):
    """Opaque, rotating refresh tokens. Only a SHA-256 hash is stored.

    Tokens issued from the same login share a ``family_id``. Presenting an
    already-rotated token revokes the entire family (reuse detection).
    """

    __tablename__ = "refresh_tokens"
    __table_args__ = (Index("ix_refresh_tokens_family", "family_id"),)

    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    family_id: Mapped[str] = mapped_column(String(36), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime)
    revoked_reason: Mapped[str | None] = mapped_column(String(50))
    replaced_by_id: Mapped[str | None] = mapped_column(String(36))
    created_ip: Mapped[str | None] = mapped_column(String(64))
    user_agent: Mapped[str | None] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime)


class UserActionToken(UUIDPrimaryKeyMixin, Base):
    """Single-use, expiring tokens for password reset and email verification."""

    __tablename__ = "user_action_tokens"
    __table_args__ = (
        CheckConstraint(
            "purpose IN ('password_reset', 'email_verification')",
            name="ck_user_action_token_purpose",
        ),
    )

    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    purpose: Mapped[str] = mapped_column(String(32), nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
