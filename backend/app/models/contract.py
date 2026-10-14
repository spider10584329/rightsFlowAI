"""Contract administration."""

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
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.db.mixins import (
    MONEY,
    PERCENT,
    CreatedByMixin,
    TenantMixin,
    TimestampMixin,
    UUIDPrimaryKeyMixin,
    utc_now,
)
from app.models.catalog import Party, Recording, Work
from app.models.platform import StoredFile

CONTRACT_TYPES = (
    "publishing",
    "administration",
    "licensing",
    "distribution",
    "recording",
    "producer",
    "collaboration",
)
CONTRACT_STATUSES = ("draft", "pending_signature", "active", "expired", "terminated")


class Contract(UUIDPrimaryKeyMixin, TenantMixin, CreatedByMixin, TimestampMixin, Base):
    __tablename__ = "contracts"
    __table_args__ = (
        CheckConstraint(
            "contract_type IN ('publishing', 'administration', 'licensing', "
            "'distribution', 'recording', 'producer', 'collaboration')",
            name="ck_contract_type",
        ),
        CheckConstraint(
            "status IN ('draft', 'pending_signature', 'active', 'expired', 'terminated')",
            name="ck_contract_status",
        ),
        CheckConstraint(
            "end_date IS NULL OR start_date IS NULL OR end_date >= start_date",
            name="ck_contract_dates",
        ),
        UniqueConstraint("organization_id", "reference", name="uq_contract_reference"),
        Index("ix_contracts_org_status", "organization_id", "status"),
        Index("ix_contracts_org_end", "organization_id", "end_date"),
    )

    title: Mapped[str] = mapped_column(String(255), nullable=False)
    reference: Mapped[str | None] = mapped_column(String(60))
    contract_type: Mapped[str] = mapped_column(String(30), nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="draft", nullable=False)
    start_date: Mapped[date | None] = mapped_column(Date)
    end_date: Mapped[date | None] = mapped_column(Date)
    renewal_date: Mapped[date | None] = mapped_column(Date)
    auto_renew: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    notice_period_days: Mapped[int | None] = mapped_column(Integer)
    territories: Mapped[list[str]] = mapped_column(JSON, nullable=False)
    rights_granted: Mapped[list[str]] = mapped_column(JSON, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), default="USD", nullable=False)
    advance_amount: Mapped[Decimal | None] = mapped_column(MONEY)
    is_recoupable: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    summary: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)
    expiry_notified_at: Mapped[datetime | None] = mapped_column(DateTime)

    parties: Mapped[list["ContractParty"]] = relationship(
        back_populates="contract", cascade="all, delete-orphan", lazy="selectin"
    )
    royalty_terms: Mapped[list["ContractRoyaltyTerm"]] = relationship(
        back_populates="contract", cascade="all, delete-orphan", lazy="selectin"
    )
    assets: Mapped[list["ContractAsset"]] = relationship(
        back_populates="contract", cascade="all, delete-orphan", lazy="selectin"
    )
    documents: Mapped[list["ContractDocument"]] = relationship(
        back_populates="contract", cascade="all, delete-orphan", lazy="selectin"
    )


class ContractParty(UUIDPrimaryKeyMixin, TenantMixin, Base):
    __tablename__ = "contract_parties"
    __table_args__ = (
        UniqueConstraint("contract_id", "party_id", "role", name="uq_contract_party_role"),
    )

    contract_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("contracts.id", ondelete="CASCADE"), nullable=False
    )
    party_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("parties.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    # licensor, licensee, publisher, writer, administrator, label, artist,
    # producer, distributor, other
    role: Mapped[str] = mapped_column(String(30), nullable=False)
    signed_at: Mapped[date | None] = mapped_column(Date)

    contract: Mapped[Contract] = relationship(back_populates="parties")
    party: Mapped[Party] = relationship(lazy="joined")


class ContractRoyaltyTerm(UUIDPrimaryKeyMixin, TenantMixin, Base):
    """Royalty rate paid to ``payee_party_id`` (or every payee on the
    contract when null) for a rights type / income source."""

    __tablename__ = "contract_royalty_terms"
    __table_args__ = (
        CheckConstraint("rate_percent >= 0 AND rate_percent <= 100", name="ck_term_rate"),
        CheckConstraint("basis IN ('gross', 'net')", name="ck_term_basis"),
    )

    contract_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("contracts.id", ondelete="CASCADE"), nullable=False, index=True
    )
    payee_party_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("parties.id", ondelete="SET NULL")
    )
    rights_type: Mapped[str | None] = mapped_column(String(20))
    source_category: Mapped[str | None] = mapped_column(String(30))
    territories: Mapped[list[str] | None] = mapped_column(JSON)
    rate_percent: Mapped[Decimal] = mapped_column(PERCENT, nullable=False)
    basis: Mapped[str] = mapped_column(String(10), default="net", nullable=False)
    description: Mapped[str | None] = mapped_column(String(255))

    contract: Mapped[Contract] = relationship(back_populates="royalty_terms")


class ContractAsset(UUIDPrimaryKeyMixin, TenantMixin, Base):
    __tablename__ = "contract_assets"
    __table_args__ = (
        CheckConstraint(
            "(work_id IS NULL) <> (recording_id IS NULL)",
            name="ck_contract_asset_exactly_one",
        ),
        # Two keys: a single (contract, work, recording) key never fires on
        # MariaDB because one of the two ids is always NULL.
        UniqueConstraint("contract_id", "work_id", name="uq_contract_asset_work"),
        UniqueConstraint("contract_id", "recording_id", name="uq_contract_asset_recording"),
    )

    contract_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("contracts.id", ondelete="CASCADE"), nullable=False
    )
    work_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("works.id", ondelete="CASCADE"), index=True
    )
    recording_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("recordings.id", ondelete="CASCADE"), index=True
    )

    contract: Mapped[Contract] = relationship(back_populates="assets")
    work: Mapped[Work | None] = relationship(lazy="joined")
    recording: Mapped[Recording | None] = relationship(lazy="joined")


class ContractDocument(UUIDPrimaryKeyMixin, TenantMixin, Base):
    __tablename__ = "contract_documents"

    contract_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("contracts.id", ondelete="CASCADE"), nullable=False, index=True
    )
    file_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("stored_files.id", ondelete="RESTRICT"), nullable=False
    )
    label: Mapped[str | None] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)

    contract: Mapped[Contract] = relationship(back_populates="documents")
    file: Mapped[StoredFile] = relationship(lazy="joined")


class ContractAnalysis(UUIDPrimaryKeyMixin, TenantMixin, CreatedByMixin, TimestampMixin, Base):
    """Advisory AI extraction from a contract document. Requires human review."""

    __tablename__ = "contract_analyses"
    __table_args__ = (
        CheckConstraint(
            "status IN ('queued', 'running', 'completed', 'failed')",
            name="ck_contract_analysis_status",
        ),
        CheckConstraint(
            "review_status IN ('pending_review', 'accepted', 'rejected')",
            name="ck_contract_analysis_review",
        ),
    )

    contract_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("contracts.id", ondelete="CASCADE"), nullable=False, index=True
    )
    document_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("contract_documents.id", ondelete="SET NULL")
    )
    status: Mapped[str] = mapped_column(String(20), default="queued", nullable=False)
    provider: Mapped[str | None] = mapped_column(String(30))
    model: Mapped[str | None] = mapped_column(String(100))
    extracted: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    flagged_clauses: Mapped[list[dict[str, Any]] | None] = mapped_column(JSON)
    error: Mapped[str | None] = mapped_column(Text)
    review_status: Mapped[str] = mapped_column(
        String(20), default="pending_review", nullable=False
    )
    reviewed_by_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL")
    )
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime)
    review_notes: Mapped[str | None] = mapped_column(Text)
