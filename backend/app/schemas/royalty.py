from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, field_validator, model_validator

from app.schemas.common import DecimalStr, OptionalDecimalStr

SourceCategory = Literal[
    "streaming", "distributor", "publishing_admin", "pro", "mechanical", "licensing",
    "manual_adjustment",
]
RightsType = Literal["performance", "mechanical", "sync", "print", "master", "neighbouring"]


def _currency(value: str) -> str:
    value = value.strip().upper()
    if len(value) != 3 or not value.isalpha():
        raise ValueError("Currency must be a 3-letter ISO code")
    return value


Currency = Annotated[str, AfterValidator(_currency)]


class StatementMeta(BaseModel):
    source_name: str = Field(min_length=1, max_length=120)
    source_category: SourceCategory
    period_start: date
    period_end: date
    currency: Currency = "USD"
    default_rights_type: RightsType | None = None
    reported_total: Decimal | None = Field(default=None, max_digits=20, decimal_places=8)
    notes: str | None = Field(default=None, max_length=5000)

    @model_validator(mode="after")
    def check_period(self):
        if self.period_end < self.period_start:
            raise ValueError("period_end must be on or after period_start")
        return self


class StatementUpdate(BaseModel):
    """Editable statement details. Currency can only change before processing
    (lines inherit it); every field is locked once royalties are posted."""

    source_name: str | None = Field(default=None, min_length=1, max_length=120)
    source_category: SourceCategory | None = None
    default_rights_type: RightsType | None = None
    clear_default_rights_type: bool = False
    period_start: date | None = None
    period_end: date | None = None
    currency: Currency | None = None
    reported_total: Decimal | None = Field(default=None, max_digits=20, decimal_places=8)
    clear_reported_total: bool = False
    notes: str | None = Field(default=None, max_length=5000)


class ManualLine(BaseModel):
    title: str | None = Field(default=None, max_length=255)
    isrc: str | None = Field(default=None, max_length=20)
    iswc: str | None = Field(default=None, max_length=20)
    recording_id: str | None = Field(default=None, max_length=36)
    work_id: str | None = Field(default=None, max_length=36)
    territory: str | None = Field(default=None, max_length=10)
    rights_type: RightsType | None = None
    usage_type: str | None = Field(default=None, max_length=60)
    amount: Decimal = Field(max_digits=20, decimal_places=8)
    transaction_date: date | None = None
    description: str | None = Field(default=None, max_length=255)


class ManualStatementCreate(StatementMeta):
    source_category: SourceCategory = "manual_adjustment"
    lines: list[ManualLine] = Field(min_length=1, max_length=5000)
    # Explicitly confirm an intentional duplicate (same source, period and lines).
    allow_duplicate: bool = False


class StatementResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    organization_id: str
    source_name: str
    source_category: str
    default_rights_type: str | None
    period_start: date
    period_end: date
    currency: str
    file_id: str | None
    file_name: str | None = None
    adapter: str
    column_mapping: dict[str, str] | None
    status: str
    job_id: str | None
    total_rows: int
    valid_rows: int
    error_rows: int
    matched_rows: int
    total_amount: DecimalStr
    reported_total: OptionalDecimalStr
    errors: list[dict[str, Any]] | None
    notes: str | None
    processed_at: datetime | None
    created_by_id: str | None
    created_at: datetime
    updated_at: datetime


class StatementPreview(BaseModel):
    statement_id: str
    headers: list[str]
    sample_rows: list[dict[str, str]]
    total_rows: int
    detected_adapter: str
    suggested_mapping: dict[str, str]
    current_mapping: dict[str, str] | None
    canonical_fields: dict[str, str]
    adapters: list[dict[str, str]]


class MappingUpdate(BaseModel):
    adapter: str = Field(max_length=50)
    column_mapping: dict[str, str]


class StatementLineResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    statement_id: str
    row_number: int
    title: str | None
    artist: str | None
    isrc: str | None
    iswc: str | None
    upc: str | None
    territory: str | None
    usage_type: str | None
    rights_type: str | None
    store: str | None
    quantity: OptionalDecimalStr
    gross_amount: OptionalDecimalStr
    amount: OptionalDecimalStr
    currency: str | None
    transaction_date: date | None
    is_valid: bool
    validation_errors: list[str] | None
    match_status: str
    match_method: str | None
    match_confidence: OptionalDecimalStr
    recording_id: str | None
    work_id: str | None
    matched_title: str | None = None


class LineMatchUpdate(BaseModel):
    action: Literal["match", "ignore", "unmatch"]
    recording_id: str | None = Field(default=None, max_length=36)
    work_id: str | None = Field(default=None, max_length=36)

    @model_validator(mode="after")
    def check_target(self):
        if self.action == "match" and not (self.recording_id or self.work_id):
            raise ValueError("Provide recording_id or work_id to match")
        return self


class BulkMatchRequest(LineMatchUpdate):
    line_ids: list[str] | None = Field(default=None, max_length=5000)
    # Apply to every unmatched line of the statement sharing this key.
    match_key: Literal["isrc", "title", "title_artist"] | None = None
    key_line_id: str | None = Field(default=None, max_length=36)

    @model_validator(mode="after")
    def check_scope(self):
        if not self.line_ids and not (self.match_key and self.key_line_id):
            raise ValueError("Provide line_ids or match_key with key_line_id")
        return self


class UnmatchedGroup(BaseModel):
    statement_id: str
    statement_source: str
    isrc: str | None
    iswc: str | None
    title: str | None
    artist: str | None
    line_count: int
    amount: DecimalStr
    currency: str | None
    sample_line_id: str


class ReconciliationResponse(BaseModel):
    statement_id: str
    currency: str
    total_rows: int
    valid_rows: int
    invalid_rows: int
    ignored_rows: int
    matched_rows: int
    unmatched_rows: int
    statement_total: DecimalStr
    matched_amount: DecimalStr
    unmatched_amount: DecimalStr
    ignored_amount: DecimalStr
    reported_total: OptionalDecimalStr
    reported_difference: OptionalDecimalStr
    other_currency_totals: dict[str, str]
    latest_run: dict[str, Any] | None


class RunResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    statement_id: str
    status: str
    calculation_version: str
    allocation_basis: str
    inputs_hash: str
    currency: str
    total_input: DecimalStr
    total_payable: DecimalStr
    total_retained: DecimalStr
    total_unallocated: DecimalStr
    line_count: int
    warnings: list[dict[str, Any]] | None
    created_by_id: str | None
    created_at: datetime
    posted_by_id: str | None
    posted_at: datetime | None
    reversed_by_id: str | None
    reversed_at: datetime | None
    reversal_reason: str | None
    statement_source: str | None = None
    statement_period_end: date | None = None


class AllocationResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    line_id: str
    allocation_type: str
    ownership_share_id: str | None
    contract_term_id: str | None
    party_id: str | None
    party_name: str | None = None
    payee_id: str | None
    work_id: str | None
    recording_id: str | None
    rights_type: str | None
    territory: str | None
    share_percent: OptionalDecimalStr
    rate_percent: OptionalDecimalStr
    base_amount: DecimalStr
    amount: DecimalStr
    currency: str
    reason: str | None
    explanation: dict[str, Any] | None


class RunSummaryRow(BaseModel):
    key: str | None
    label: str | None
    allocation_type: str
    currency: str
    amount: DecimalStr
    count: int


class ReasonRequest(BaseModel):
    reason: str = Field(min_length=3, max_length=2000)


# --------------------------------------------------------------------------- payees & ledger


class PayeeBase(BaseModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=255)
    email: str | None = Field(default=None, max_length=255)
    payment_method: Literal["bank_transfer", "paypal", "check", "wire", "other"] = "bank_transfer"
    payment_reference: dict[str, str] | None = None
    currency: Currency = "USD"
    minimum_payout: Decimal = Field(default=Decimal("0"), ge=0, max_digits=20, decimal_places=2)
    hold_payments: bool = False
    tax_form_status: str | None = Field(default=None, max_length=30)
    notes: str | None = Field(default=None, max_length=5000)

    @field_validator("payment_reference")
    @classmethod
    def no_full_account_numbers(cls, value: dict[str, str] | None) -> dict[str, str] | None:
        if not value:
            return value
        allowed = {"bank_name", "account_last4", "paypal_email", "reference", "country"}
        unknown = set(value) - allowed
        if unknown:
            raise ValueError(f"Unsupported payment reference fields: {sorted(unknown)}")
        last4 = value.get("account_last4")
        if last4 is not None and (len(last4) != 4 or not last4.isdigit()):
            raise ValueError("account_last4 must be exactly 4 digits; never store full numbers")
        return value


class PayeeCreate(PayeeBase):
    party_id: str = Field(max_length=36)


class PayeeUpdate(BaseModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=255)
    email: str | None = Field(default=None, max_length=255)
    payment_method: Literal["bank_transfer", "paypal", "check", "wire", "other"] | None = None
    payment_reference: dict[str, str] | None = None
    currency: str | None = None
    minimum_payout: Decimal | None = Field(default=None, ge=0, max_digits=20, decimal_places=2)
    hold_payments: bool | None = None
    tax_form_status: str | None = Field(default=None, max_length=30)
    notes: str | None = Field(default=None, max_length=5000)
    is_active: bool | None = None

    _ref = field_validator("payment_reference")(PayeeBase.no_full_account_numbers.__func__)  # type: ignore[attr-defined]

    @field_validator("currency")
    @classmethod
    def check_currency(cls, value: str | None) -> str | None:
        return _currency(value) if value else value


class BalanceRow(BaseModel):
    currency: str
    balance: DecimalStr
    pending_payouts: DecimalStr
    available: DecimalStr
    unrecouped_advances: DecimalStr
    lifetime_earnings: DecimalStr
    lifetime_payouts: DecimalStr


class PayeeResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    party_id: str
    party_name: str | None = None
    display_name: str
    email: str | None
    payment_method: str
    payment_reference: dict[str, Any] | None
    currency: str
    minimum_payout: DecimalStr
    hold_payments: bool
    tax_form_status: str | None
    is_active: bool
    notes: str | None
    created_at: datetime
    updated_at: datetime
    balances: list[BalanceRow] = []


class LedgerEntryResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    payee_id: str
    payee_name: str | None = None
    entry_type: str
    amount: DecimalStr
    currency: str
    effective_date: date
    description: str
    run_id: str | None
    payout_id: str | None
    contract_id: str | None
    reversal_of_id: str | None
    reversed: bool = False
    created_by_id: str | None
    created_at: datetime
    running_balance: OptionalDecimalStr = None


class AdjustmentCreate(BaseModel):
    payee_id: str = Field(max_length=36)
    amount: Decimal = Field(max_digits=20, decimal_places=8)
    currency: Currency
    description: str = Field(min_length=3, max_length=500)
    effective_date: date | None = None

    @field_validator("amount")
    @classmethod
    def non_zero(cls, value: Decimal) -> Decimal:
        if value == 0:
            raise ValueError("Amount must not be zero")
        return value


class AdvanceCreate(BaseModel):
    payee_id: str = Field(max_length=36)
    amount: Decimal = Field(gt=0, max_digits=20, decimal_places=8)
    currency: Currency
    contract_id: str | None = Field(default=None, max_length=36)
    description: str = Field(min_length=3, max_length=500)
    effective_date: date | None = None


# --------------------------------------------------------------------------- payouts


class PayoutBatchCreate(BaseModel):
    currency: Currency
    payee_ids: list[str] | None = Field(default=None, max_length=5000)
    notes: str | None = Field(default=None, max_length=5000)


class PayoutResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    batch_id: str
    payee_id: str
    payee_name: str | None = None
    payment_method: str | None = None
    amount: DecimalStr
    currency: str
    status: str
    external_reference: str | None


class PayoutBatchResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    reference: str
    status: str
    currency: str
    total_amount: DecimalStr
    payout_count: int
    provider: str
    notes: str | None
    created_by_id: str | None
    created_at: datetime
    submitted_at: datetime | None
    approved_by_id: str | None
    approved_at: datetime | None
    paid_by_id: str | None
    paid_at: datetime | None
    cancelled_at: datetime | None
    payouts: list[PayoutResponse] = []


class PayoutAmountUpdate(BaseModel):
    amount: Decimal = Field(gt=0, max_digits=20, decimal_places=2)


class MarkPaidRequest(BaseModel):
    confirm: Literal[True]
    payment_date: date | None = None
    external_references: dict[str, str] | None = None  # payout_id -> reference
    notes: str | None = Field(default=None, max_length=2000)
