"""Royalty statements, calculation runs, the payee ledger and payouts.

Financial history is append-only: posted statement lines, allocations and
ledger entries are never updated or deleted. Corrections are made with
reversal or adjustment entries.
"""

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
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.mysql import DATETIME
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
from app.models.catalog import Party
from app.models.platform import StoredFile

SOURCE_CATEGORIES = (
    "streaming",
    "distributor",
    "publishing_admin",
    "pro",
    "mechanical",
    "licensing",
    "manual_adjustment",
)
STATEMENT_STATUSES = (
    "uploaded",
    "queued",
    "processing",
    "processed",
    "failed",
    "calculated",
    "posted",
)


class RoyaltyStatement(UUIDPrimaryKeyMixin, TenantMixin, CreatedByMixin, TimestampMixin, Base):
    __tablename__ = "royalty_statements"
    __table_args__ = (
        CheckConstraint(
            "source_category IN ('streaming', 'distributor', 'publishing_admin', 'pro', "
            "'mechanical', 'licensing', 'manual_adjustment')",
            name="ck_statement_source_category",
        ),
        CheckConstraint(
            "status IN ('uploaded', 'queued', 'processing', 'processed', 'failed', "
            "'calculated', 'posted')",
            name="ck_statement_status",
        ),
        UniqueConstraint("organization_id", "file_sha256", name="uq_statement_file_hash"),
        Index("ix_statements_org_period", "organization_id", "period_end"),
        Index("ix_statements_org_content", "organization_id", "content_sha256"),
    )

    source_name: Mapped[str] = mapped_column(String(120), nullable=False)
    source_category: Mapped[str] = mapped_column(String(30), nullable=False)
    default_rights_type: Mapped[str | None] = mapped_column(String(20))
    period_start: Mapped[date] = mapped_column(Date, nullable=False)
    period_end: Mapped[date] = mapped_column(Date, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    file_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("stored_files.id", ondelete="SET NULL")
    )
    file_sha256: Mapped[str | None] = mapped_column(String(64))
    # Hash of the parsed rows (encoding, line endings, cell padding and row
    # order normalised) or of manual lines, to catch re-imports of the same
    # data in a different file (audit F-H5).
    content_sha256: Mapped[str | None] = mapped_column(String(64))
    adapter: Mapped[str] = mapped_column(String(50), default="generic", nullable=False)
    column_mapping: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(20), default="uploaded", nullable=False)
    job_id: Mapped[str | None] = mapped_column(String(36))
    total_rows: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    valid_rows: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    error_rows: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    matched_rows: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    total_amount: Mapped[Decimal] = mapped_column(MONEY, default=Decimal("0"), nullable=False)
    reported_total: Mapped[Decimal | None] = mapped_column(MONEY)
    errors: Mapped[list[dict[str, Any]] | None] = mapped_column(JSON)
    notes: Mapped[str | None] = mapped_column(Text)
    processed_at: Mapped[datetime | None] = mapped_column(DateTime)
    # Set when a person confirms the column mapping (saving it or processing the
    # statement). Automation never processes an app upload before this is set.
    mapping_confirmed_at: Mapped[datetime | None] = mapped_column(DateTime)
    mapping_confirmed_by_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL", name="fk_statement_mapping_confirmed_by")
    )

    file: Mapped[StoredFile | None] = relationship(lazy="joined")


class StatementLine(UUIDPrimaryKeyMixin, TenantMixin, Base):
    __tablename__ = "statement_lines"
    __table_args__ = (
        CheckConstraint(
            "match_status IN ('matched', 'unmatched', 'ignored', 'invalid')",
            name="ck_line_match_status",
        ),
        UniqueConstraint("statement_id", "row_number", name="uq_line_row"),
        Index("ix_lines_statement_match", "statement_id", "match_status"),
        Index("ix_lines_org_match", "organization_id", "match_status"),
        Index("ix_lines_recording", "recording_id"),
        Index("ix_lines_work", "work_id"),
    )

    statement_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("royalty_statements.id", ondelete="CASCADE"), nullable=False
    )
    row_number: Mapped[int] = mapped_column(Integer, nullable=False)
    raw: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    title: Mapped[str | None] = mapped_column(String(255))
    artist: Mapped[str | None] = mapped_column(String(255))
    isrc: Mapped[str | None] = mapped_column(String(12))
    iswc: Mapped[str | None] = mapped_column(String(15))
    upc: Mapped[str | None] = mapped_column(String(14))
    territory: Mapped[str | None] = mapped_column(String(10))
    usage_type: Mapped[str | None] = mapped_column(String(60))
    rights_type: Mapped[str | None] = mapped_column(String(20))
    store: Mapped[str | None] = mapped_column(String(120))
    quantity: Mapped[Decimal | None] = mapped_column(Numeric(20, 4))
    gross_amount: Mapped[Decimal | None] = mapped_column(MONEY)
    amount: Mapped[Decimal | None] = mapped_column(MONEY)
    currency: Mapped[str | None] = mapped_column(String(3))
    transaction_date: Mapped[date | None] = mapped_column(Date)
    source_reference: Mapped[str | None] = mapped_column(String(120))
    is_valid: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    validation_errors: Mapped[list[str] | None] = mapped_column(JSON)
    match_status: Mapped[str] = mapped_column(String(20), default="unmatched", nullable=False)
    match_method: Mapped[str | None] = mapped_column(String(20))
    match_confidence: Mapped[Decimal | None] = mapped_column(Numeric(5, 4))
    recording_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("recordings.id", ondelete="SET NULL")
    )
    work_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("works.id", ondelete="SET NULL")
    )
    matched_by_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL")
    )


class RoyaltyRun(UUIDPrimaryKeyMixin, TenantMixin, CreatedByMixin, TimestampMixin, Base):
    """A reproducible calculation over one statement."""

    __tablename__ = "royalty_runs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('calculated', 'posted', 'reversed', 'discarded')",
            name="ck_run_status",
        ),
        # Holds the statement id while the run is posted; guarantees at most
        # one posted run per statement at the database level.
        UniqueConstraint("posting_key", name="uq_run_posting_key"),
    )

    statement_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("royalty_statements.id", ondelete="RESTRICT"), nullable=False,
        index=True,
    )
    status: Mapped[str] = mapped_column(String(20), default="calculated", nullable=False)
    calculation_version: Mapped[str] = mapped_column(String(20), nullable=False)
    allocation_basis: Mapped[str] = mapped_column(String(30), nullable=False)
    inputs_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    total_input: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    total_payable: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    total_retained: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    total_unallocated: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    line_count: Mapped[int] = mapped_column(Integer, nullable=False)
    warnings: Mapped[list[dict[str, Any]] | None] = mapped_column(JSON)
    posting_key: Mapped[str | None] = mapped_column(String(36))
    posted_by_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL")
    )
    posted_at: Mapped[datetime | None] = mapped_column(DateTime)
    reversed_by_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL")
    )
    reversed_at: Mapped[datetime | None] = mapped_column(DateTime)
    reversal_reason: Mapped[str | None] = mapped_column(Text)


class RoyaltyAllocation(UUIDPrimaryKeyMixin, TenantMixin, Base):
    __tablename__ = "royalty_allocations"
    __table_args__ = (
        CheckConstraint(
            "allocation_type IN ('payable', 'retained', 'unallocated')",
            name="ck_allocation_type",
        ),
        Index("ix_allocations_run", "run_id"),
        Index("ix_allocations_payee", "payee_id"),
        Index("ix_allocations_line", "line_id"),
    )

    run_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("royalty_runs.id", ondelete="CASCADE"), nullable=False
    )
    line_id: Mapped[str] = mapped_column(
        # RESTRICT: allocations are the audit trail of posted royalties; their
        # statement lines must never disappear underneath them.
        String(36), ForeignKey("statement_lines.id", ondelete="RESTRICT", name="fk_allocations_line"),
        nullable=False,
    )
    allocation_type: Mapped[str] = mapped_column(String(20), nullable=False)
    ownership_share_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("ownership_shares.id", ondelete="SET NULL")
    )
    contract_term_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("contract_royalty_terms.id", ondelete="RESTRICT",
                               name="fk_allocations_contract_term")
    )
    party_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("parties.id", ondelete="SET NULL")
    )
    payee_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("payees.id", ondelete="SET NULL")
    )
    work_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("works.id", ondelete="RESTRICT", name="fk_allocations_work"), index=True
    )
    recording_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("recordings.id", ondelete="RESTRICT", name="fk_allocations_recording"),
        index=True,
    )
    rights_type: Mapped[str | None] = mapped_column(String(20))
    territory: Mapped[str | None] = mapped_column(String(10))
    share_percent: Mapped[Decimal | None] = mapped_column(PERCENT)
    rate_percent: Mapped[Decimal | None] = mapped_column(PERCENT)
    base_amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    reason: Mapped[str | None] = mapped_column(String(60))
    explanation: Mapped[dict[str, Any] | None] = mapped_column(JSON)


class Payee(UUIDPrimaryKeyMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "payees"
    __table_args__ = (
        UniqueConstraint("organization_id", "party_id", name="uq_payee_party"),
        CheckConstraint(
            "payment_method IN ('bank_transfer', 'paypal', 'check', 'wire', 'other')",
            name="ck_payee_method",
        ),
    )

    party_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("parties.id", ondelete="RESTRICT"), nullable=False
    )
    display_name: Mapped[str] = mapped_column(String(255), nullable=False)
    email: Mapped[str | None] = mapped_column(String(255))
    payment_method: Mapped[str] = mapped_column(
        String(20), default="bank_transfer", nullable=False
    )
    # Non-sensitive reference details only (e.g. bank name, last 4 digits).
    payment_reference: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    currency: Mapped[str] = mapped_column(String(3), default="USD", nullable=False)
    minimum_payout: Mapped[Decimal] = mapped_column(
        Numeric(20, 2), default=Decimal("0"), nullable=False
    )
    hold_payments: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    tax_form_status: Mapped[str | None] = mapped_column(String(30))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    notes: Mapped[str | None] = mapped_column(Text)

    party: Mapped[Party] = relationship(lazy="joined")


LEDGER_ENTRY_TYPES = (
    "earning",
    "advance",
    "adjustment",
    "reversal",
    "payout",
)


class LedgerEntry(UUIDPrimaryKeyMixin, TenantMixin, CreatedByMixin, Base):
    """Immutable payee ledger entry. Positive amounts increase what the
    organization owes the payee; negative amounts decrease it."""

    __tablename__ = "ledger_entries"
    __table_args__ = (
        CheckConstraint(
            "entry_type IN ('earning', 'advance', 'adjustment', 'reversal', 'payout')",
            name="ck_ledger_entry_type",
        ),
        UniqueConstraint("reversal_of_id", name="uq_ledger_single_reversal"),
        Index("ix_ledger_payee_currency", "payee_id", "currency"),
        Index("ix_ledger_org_date", "organization_id", "effective_date"),
    )

    payee_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("payees.id", ondelete="RESTRICT"), nullable=False
    )
    entry_type: Mapped[str] = mapped_column(String(20), nullable=False)
    amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    effective_date: Mapped[date] = mapped_column(Date, nullable=False)
    description: Mapped[str] = mapped_column(String(500), nullable=False)
    run_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("royalty_runs.id", ondelete="RESTRICT")
    )
    payout_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("payouts.id", ondelete="RESTRICT")
    )
    contract_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("contracts.id", ondelete="SET NULL")
    )
    reversal_of_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("ledger_entries.id", ondelete="RESTRICT")
    )
    # Microseconds: remittance advice orders entries against payouts posted in
    # the same second (audit F-M4).
    created_at: Mapped[datetime] = mapped_column(
        DateTime().with_variant(DATETIME(fsp=6), "mysql", "mariadb"), default=utc_now, nullable=False
    )

    payee: Mapped[Payee] = relationship(lazy="joined")


class PayoutBatch(UUIDPrimaryKeyMixin, TenantMixin, CreatedByMixin, TimestampMixin, Base):
    __tablename__ = "payout_batches"
    __table_args__ = (
        CheckConstraint(
            "status IN ('draft', 'pending_approval', 'approved', 'paid', 'cancelled')",
            name="ck_payout_batch_status",
        ),
        UniqueConstraint("organization_id", "reference", name="uq_payout_batch_reference"),
    )

    reference: Mapped[str] = mapped_column(String(40), nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="draft", nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    total_amount: Mapped[Decimal] = mapped_column(
        Numeric(20, 2), default=Decimal("0"), nullable=False
    )
    payout_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    provider: Mapped[str] = mapped_column(String(30), default="internal", nullable=False)
    notes: Mapped[str | None] = mapped_column(Text)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime)
    approved_by_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL")
    )
    approved_at: Mapped[datetime | None] = mapped_column(DateTime)
    paid_by_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL")
    )
    paid_at: Mapped[datetime | None] = mapped_column(DateTime)
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime)

    payouts: Mapped[list["Payout"]] = relationship(
        back_populates="batch", cascade="all, delete-orphan", lazy="selectin"
    )


class Payout(UUIDPrimaryKeyMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "payouts"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'paid', 'cancelled', 'failed')", name="ck_payout_status"
        ),
        CheckConstraint("amount > 0", name="ck_payout_positive"),
        UniqueConstraint("batch_id", "payee_id", name="uq_payout_batch_payee"),
    )

    batch_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("payout_batches.id", ondelete="CASCADE"), nullable=False
    )
    payee_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("payees.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    amount: Mapped[Decimal] = mapped_column(Numeric(20, 2), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="pending", nullable=False)
    external_reference: Mapped[str | None] = mapped_column(String(120))

    batch: Mapped[PayoutBatch] = relationship(back_populates="payouts")
    payee: Mapped[Payee] = relationship(lazy="joined")
