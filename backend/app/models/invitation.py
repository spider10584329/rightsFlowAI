from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.db.mixins import TenantMixin, TimestampMixin, UUIDPrimaryKeyMixin
from app.models.organization import Organization


class OrganizationInvitation(UUIDPrimaryKeyMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "organization_invitations"
    __table_args__ = (
        CheckConstraint(
            "role IN ('admin', 'manager', 'viewer')", name="ck_invitation_role"
        ),
        CheckConstraint(
            "status IN ('pending', 'accepted', 'declined', 'revoked', 'expired')",
            name="ck_invitation_status",
        ),
        Index("ix_invitations_email", "email"),
    )

    email: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[str] = mapped_column(String(20), nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="pending", nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    invited_by_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL")
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    responded_at: Mapped[datetime | None] = mapped_column(DateTime)
    accepted_user_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL")
    )
    message: Mapped[str | None] = mapped_column(String(500))

    organization: Mapped[Organization] = relationship(lazy="joined")
