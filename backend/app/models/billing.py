from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.mixins import (
    TenantMixin,
    TimestampMixin,
    UUIDPrimaryKeyMixin,
    utc_now,
)


class Plan(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A subscription plan and its entitlements.

    ``limits`` keys: max_users, max_catalog_items, max_statement_imports_per_month,
    max_ai_requests_per_month, max_storage_mb (``null`` = unlimited) and boolean
    feature flags such as advanced_reporting, ai_features, api_access.
    """

    __tablename__ = "plans"

    code: Mapped[str] = mapped_column(String(50), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    is_development: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    is_public: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # Commercial pricing is intentionally unset until approved.
    monthly_price: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))
    currency: Mapped[str] = mapped_column(String(3), default="USD", nullable=False)
    limits: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    provider_price_id: Mapped[str | None] = mapped_column(String(120))


class Subscription(UUIDPrimaryKeyMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "subscriptions"
    __table_args__ = (
        CheckConstraint(
            "status IN ('trialing', 'active', 'past_due', 'canceled', 'incomplete')",
            name="ck_subscription_status",
        ),
        UniqueConstraint("organization_id", name="uq_subscription_org"),
    )

    plan_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("plans.id", ondelete="RESTRICT"), nullable=False
    )
    status: Mapped[str] = mapped_column(String(20), default="active", nullable=False)
    provider: Mapped[str] = mapped_column(String(20), default="manual", nullable=False)
    provider_customer_id: Mapped[str | None] = mapped_column(String(120))
    provider_subscription_id: Mapped[str | None] = mapped_column(String(120))
    current_period_start: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, nullable=False
    )
    current_period_end: Mapped[datetime | None] = mapped_column(DateTime)
    cancel_at_period_end: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    billing_email: Mapped[str | None] = mapped_column(String(255))


class AIUsageRecord(UUIDPrimaryKeyMixin, TenantMixin, Base):
    __tablename__ = "ai_usage_records"

    user_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL")
    )
    feature: Mapped[str] = mapped_column(String(50), nullable=False)
    provider: Mapped[str] = mapped_column(String(30), nullable=False)
    model: Mapped[str] = mapped_column(String(100), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    input_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    estimated_cost_usd: Mapped[Decimal] = mapped_column(
        Numeric(12, 6), default=Decimal("0"), nullable=False
    )
    latency_ms: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    error: Mapped[str | None] = mapped_column(String(500))
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, nullable=False, index=True
    )


class AISuggestion(UUIDPrimaryKeyMixin, TenantMixin, TimestampMixin, Base):
    """AI- or rule-generated change proposal awaiting human review."""

    __tablename__ = "ai_suggestions"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'approved', 'rejected', 'applied')",
            name="ck_ai_suggestion_status",
        ),
    )

    kind: Mapped[str] = mapped_column(String(50), nullable=False)
    source: Mapped[str] = mapped_column(String(20), default="ai", nullable=False)
    entity_type: Mapped[str] = mapped_column(String(50), nullable=False)
    entity_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    rationale: Mapped[str | None] = mapped_column(Text)
    proposed_changes: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="pending", nullable=False)
    created_by_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL")
    )
    reviewed_by_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL")
    )
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime)
