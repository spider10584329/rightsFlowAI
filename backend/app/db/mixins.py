"""Reusable column definitions for ORM models.

Conventions:
- Primary keys are UUID4 strings stored in ``CHAR/VARCHAR(36)``.
- Timestamps are naive ``DATETIME`` values that always represent UTC.
- Tenant-owned rows carry an indexed ``organization_id`` foreign key.
- Money uses ``DECIMAL(20, 8)``; percentages use ``DECIMAL(9, 6)``.
"""

from datetime import datetime, timezone
from decimal import Decimal
from uuid import uuid4

from sqlalchemy import DateTime, ForeignKey, Numeric, String
from sqlalchemy.orm import Mapped, declared_attr, mapped_column

MONEY = Numeric(20, 8)
PERCENT = Numeric(9, 6)


def utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def new_uuid() -> str:
    return str(uuid4())


def money(value: object = 0) -> Decimal:
    return Decimal(str(value))


class UUIDPrimaryKeyMixin:
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now, nullable=False
    )


class TenantMixin:
    """Marks a row as owned by exactly one organization."""

    @declared_attr
    def organization_id(cls) -> Mapped[str]:
        return mapped_column(
            String(36),
            ForeignKey("organizations.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        )


class CreatedByMixin:
    @declared_attr
    def created_by_id(cls) -> Mapped[str | None]:
        return mapped_column(
            String(36),
            ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        )
