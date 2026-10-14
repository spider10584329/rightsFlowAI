"""Rights ownership: shares, configurable split rules, split sheets, conflicts."""

from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.db.mixins import (
    PERCENT,
    CreatedByMixin,
    TenantMixin,
    TimestampMixin,
    UUIDPrimaryKeyMixin,
)
from app.models.catalog import Party

WORK_RIGHTS_TYPES = ("performance", "mechanical", "sync", "print")
RECORDING_RIGHTS_TYPES = ("master", "neighbouring", "sync")
RIGHTS_TYPES = ("performance", "mechanical", "sync", "print", "master", "neighbouring")
SHARE_ROLES = (
    "writer",
    "publisher",
    "administrator",
    "sub_publisher",
    "label",
    "artist",
    "producer",
    "other",
)
_RIGHTS_CHECK = (
    "rights_type IN ('performance', 'mechanical', 'sync', 'print', 'master', 'neighbouring')"
)


class SplitRule(UUIDPrimaryKeyMixin, TenantMixin, TimestampMixin, Base):
    """Configurable validation rule for ownership totals.

    The most specific rule wins: (asset_type, rights_type, territory) beats
    (asset_type, rights_type, NULL). Without a rule, totals must equal 100%
    and violations are reported as warnings.
    """

    __tablename__ = "split_rules"
    __table_args__ = (
        CheckConstraint("asset_type IN ('work', 'recording')", name="ck_split_rule_asset"),
        CheckConstraint(_RIGHTS_CHECK, name="ck_split_rule_rights_type"),
        CheckConstraint("enforcement IN ('warn', 'block')", name="ck_split_rule_enforcement"),
        UniqueConstraint(
            "organization_id",
            "asset_type",
            "rights_type",
            "territory",
            name="uq_split_rule_scope",
        ),
    )

    asset_type: Mapped[str] = mapped_column(String(20), nullable=False)
    rights_type: Mapped[str] = mapped_column(String(20), nullable=False)
    territory: Mapped[str | None] = mapped_column(String(10))
    expected_total: Mapped[Decimal] = mapped_column(PERCENT, nullable=False)
    tolerance: Mapped[Decimal] = mapped_column(PERCENT, default=Decimal("0.01"), nullable=False)
    allow_under_allocation: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    enforcement: Mapped[str] = mapped_column(String(10), default="warn", nullable=False)
    description: Mapped[str | None] = mapped_column(String(500))


class SplitSheet(UUIDPrimaryKeyMixin, TenantMixin, CreatedByMixin, TimestampMixin, Base):
    __tablename__ = "split_sheets"
    __table_args__ = (
        CheckConstraint(
            "status IN ('draft', 'signed', 'verified', 'disputed')",
            name="ck_split_sheet_status",
        ),
    )

    work_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("works.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    agreed_date: Mapped[date | None] = mapped_column(Date)
    status: Mapped[str] = mapped_column(String(20), default="draft", nullable=False)
    # [{party_id, role, share_percent}] as recorded on the sheet.
    entries: Mapped[list[dict[str, Any]]] = mapped_column(JSON, nullable=False)
    document_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("stored_files.id", ondelete="SET NULL")
    )
    notes: Mapped[str | None] = mapped_column(Text)


class OwnershipShare(UUIDPrimaryKeyMixin, TenantMixin, CreatedByMixin, TimestampMixin, Base):
    """One party's share of one rights type in one asset, for a set of
    territories and an effective date range."""

    __tablename__ = "ownership_shares"
    __table_args__ = (
        CheckConstraint(
            "(work_id IS NULL) <> (recording_id IS NULL)",
            name="ck_share_exactly_one_asset",
        ),
        CheckConstraint(_RIGHTS_CHECK, name="ck_share_rights_type"),
        CheckConstraint(
            "share_percent > 0 AND share_percent <= 100", name="ck_share_percent_range"
        ),
        CheckConstraint(
            "status IN ('active', 'superseded', 'disputed', 'archived')",
            name="ck_share_status",
        ),
        CheckConstraint(
            "verification_status IN ('unverified', 'verified', 'disputed')",
            name="ck_share_verification",
        ),
        CheckConstraint(
            "effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from",
            name="ck_share_effective_range",
        ),
        Index("ix_shares_work", "work_id", "rights_type"),
        Index("ix_shares_recording", "recording_id", "rights_type"),
        Index("ix_shares_party", "party_id"),
    )

    work_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("works.id", ondelete="CASCADE")
    )
    recording_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("recordings.id", ondelete="CASCADE")
    )
    party_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("parties.id", ondelete="RESTRICT"), nullable=False
    )
    role: Mapped[str] = mapped_column(String(20), nullable=False)
    rights_type: Mapped[str] = mapped_column(String(20), nullable=False)
    share_percent: Mapped[Decimal] = mapped_column(PERCENT, nullable=False)
    # ISO 3166-1 alpha-2 codes, or ["WORLD"].
    territories: Mapped[list[str]] = mapped_column(JSON, nullable=False)
    excluded_territories: Mapped[list[str] | None] = mapped_column(JSON)
    effective_from: Mapped[date | None] = mapped_column(Date)
    effective_to: Mapped[date | None] = mapped_column(Date)
    is_controlled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    source: Mapped[str] = mapped_column(String(20), default="manual", nullable=False)
    contract_id: Mapped[str | None] = mapped_column(
        # RESTRICT: removing a governing contract must be an explicit decision
        # (it changes royalty rates); see contracts.delete_contract.
        String(36), ForeignKey("contracts.id", ondelete="RESTRICT", name="fk_shares_contract"), index=True
    )
    split_sheet_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("split_sheets.id", ondelete="SET NULL")
    )
    status: Mapped[str] = mapped_column(String(20), default="active", nullable=False)
    verification_status: Mapped[str] = mapped_column(
        String(20), default="unverified", nullable=False
    )
    verified_by_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL")
    )
    verified_at: Mapped[datetime | None] = mapped_column(DateTime)
    supersedes_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("ownership_shares.id", ondelete="SET NULL")
    )
    notes: Mapped[str | None] = mapped_column(Text)

    party: Mapped[Party] = relationship(lazy="joined")


class RightsConflict(UUIDPrimaryKeyMixin, TenantMixin, TimestampMixin, Base):
    """A detected ownership problem. Never auto-resolved: a human decides."""

    __tablename__ = "rights_conflicts"
    __table_args__ = (
        CheckConstraint(
            "status IN ('open', 'acknowledged', 'resolved', 'dismissed')",
            name="ck_conflict_status",
        ),
        CheckConstraint(
            "severity IN ('low', 'medium', 'high', 'critical')", name="ck_conflict_severity"
        ),
        UniqueConstraint("organization_id", "fingerprint", name="uq_conflict_fingerprint"),
        Index("ix_conflicts_org_status", "organization_id", "status"),
    )

    conflict_type: Mapped[str] = mapped_column(String(40), nullable=False)
    severity: Mapped[str] = mapped_column(String(10), nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="open", nullable=False)
    work_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("works.id", ondelete="CASCADE")
    )
    recording_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("recordings.id", ondelete="CASCADE")
    )
    rights_type: Mapped[str | None] = mapped_column(String(20))
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    explanation: Mapped[str] = mapped_column(Text, nullable=False)
    details: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    last_detected_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    resolved_by_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL")
    )
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime)
    resolution_notes: Mapped[str | None] = mapped_column(Text)
