"""Contract administration schemas: contracts, documents, clause scans and
AI-assisted (advisory) contract analyses."""

from datetime import date, datetime
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.models.contract import CONTRACT_STATUSES, CONTRACT_TYPES
from app.schemas.common import DecimalStr, OptionalDecimalStr
from app.services.reference import (
    CURRENCIES,
    RIGHTS_TYPES,
    SOURCE_CATEGORIES,
    WORLD,
    normalize_territory,
)

ContractType = Literal[
    "publishing", "administration", "licensing", "distribution", "recording", "producer",
    "collaboration",
]
ContractStatus = Literal["draft", "pending_signature", "active", "expired", "terminated"]
PartyRole = Literal[
    "licensor", "licensee", "publisher", "writer", "administrator", "label", "artist",
    "producer", "distributor", "other",
]
ExpiryState = Literal["none", "upcoming", "expired"]

# Fields an accepted AI analysis may copy onto the contract, when listed explicitly.
AI_APPLICABLE_FIELDS = (
    "title", "contract_type", "start_date", "end_date", "renewal_date", "territories",
    "rights_granted", "currency", "advance_amount", "summary",
)
AIApplicableField = Literal[
    "title", "contract_type", "start_date", "end_date", "renewal_date", "territories",
    "rights_granted", "currency", "advance_amount", "summary",
]

assert set(ContractType.__args__) == set(CONTRACT_TYPES)  # type: ignore[attr-defined]
assert set(ContractStatus.__args__) == set(CONTRACT_STATUSES)  # type: ignore[attr-defined]


# --------------------------------------------------------------------------- validators


def clean_territories(values: list[str] | None, *, allow_empty: bool) -> list[str] | None:
    """Normalize territory codes (aliases such as UK -> GB); WORLD absorbs the rest."""
    if values is None:
        return None
    codes: list[str] = []
    invalid: list[str] = []
    for value in values:
        code = normalize_territory(value) if isinstance(value, str) else None
        if code is None:
            invalid.append(str(value)[:20])
        elif code not in codes:
            codes.append(code)
    if invalid:
        raise ValueError(f"Unknown territory code(s): {', '.join(invalid)}")
    if not codes:
        if allow_empty:
            return None
        raise ValueError("At least one territory (or WORLD) is required")
    return [WORLD] if WORLD in codes else codes


def clean_rights(values: list[str] | None) -> list[str] | None:
    if values is None:
        return None
    out: list[str] = []
    for value in values:
        key = str(value).strip().lower()
        if key not in RIGHTS_TYPES:
            raise ValueError(
                f"Unknown rights type {str(value)[:30]!r}; allowed: {', '.join(RIGHTS_TYPES)}"
            )
        if key not in out:
            out.append(key)
    return out


def clean_currency(value: str | None) -> str | None:
    if value is None:
        return None
    code = value.strip().upper()
    if code not in CURRENCIES:
        raise ValueError(f"Unsupported currency {value[:10]!r}")
    return code


def _strip_or_none(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    return value or None


# --------------------------------------------------------------------------- nested inputs


class ContractPartyIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    party_id: str = Field(min_length=1, max_length=36)
    role: PartyRole
    signed_at: date | None = None


class RoyaltyTermIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Optional: an existing term id updates that term in place (keeps allocation lineage).
    id: str | None = Field(default=None, max_length=36)
    payee_party_id: str | None = Field(default=None, max_length=36)
    rights_type: str | None = Field(default=None, max_length=20)
    source_category: str | None = Field(default=None, max_length=30)
    territories: list[str] | None = Field(default=None, max_length=300)
    rate_percent: Decimal = Field(ge=0, le=100, max_digits=9, decimal_places=6)
    # "net" (applied to the amount actually received) is the safe default; "gross"
    # must be chosen explicitly (audit F-M6).
    basis: Literal["gross", "net"] = "net"
    description: str | None = Field(default=None, max_length=255)

    @field_validator("rights_type")
    @classmethod
    def _rights_type(cls, value: str | None) -> str | None:
        if value is None:
            return None
        rights = clean_rights([value])
        return rights[0] if rights else None

    @field_validator("source_category")
    @classmethod
    def _source_category(cls, value: str | None) -> str | None:
        if value is None:
            return None
        key = value.strip().lower()
        if key not in SOURCE_CATEGORIES:
            raise ValueError(
                f"Unknown source category; allowed: {', '.join(SOURCE_CATEGORIES)}"
            )
        return key

    @field_validator("territories")
    @classmethod
    def _territories(cls, value: list[str] | None) -> list[str] | None:
        return clean_territories(value, allow_empty=True)

    @field_validator("description")
    @classmethod
    def _description(cls, value: str | None) -> str | None:
        return _strip_or_none(value)


class ContractAssetIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    work_id: str | None = Field(default=None, max_length=36)
    recording_id: str | None = Field(default=None, max_length=36)

    @model_validator(mode="after")
    def _exactly_one(self) -> "ContractAssetIn":
        if bool(self.work_id) == bool(self.recording_id):
            raise ValueError("Each asset needs exactly one of work_id or recording_id")
        return self


def _check_nested(parties, terms, assets) -> None:
    if parties is not None:
        keys = [(p.party_id, p.role) for p in parties]
        if len(keys) != len(set(keys)):
            raise ValueError("The same party is listed twice with the same role")
    if terms is not None:
        ids = [t.id for t in terms if t.id]
        if len(ids) != len(set(ids)):
            raise ValueError("A royalty term id is listed twice")
    if assets is not None:
        keys = [(a.work_id, a.recording_id) for a in assets]
        if len(keys) != len(set(keys)):
            raise ValueError("The same work or recording is listed twice")


# --------------------------------------------------------------------------- contract inputs


class _ContractFields(BaseModel):
    model_config = ConfigDict(extra="forbid")

    @field_validator("title", "reference", "summary", "notes", check_fields=False)
    @classmethod
    def _strip(cls, value: str | None) -> str | None:
        return _strip_or_none(value)

    @field_validator("territories", check_fields=False)
    @classmethod
    def _territories(cls, value: list[str] | None) -> list[str] | None:
        return clean_territories(value, allow_empty=False)

    @field_validator("rights_granted", check_fields=False)
    @classmethod
    def _rights(cls, value: list[str] | None) -> list[str] | None:
        return clean_rights(value)

    @field_validator("currency", check_fields=False)
    @classmethod
    def _currency(cls, value: str | None) -> str | None:
        return clean_currency(value)


class ContractCreate(_ContractFields):
    title: str = Field(min_length=1, max_length=255)
    reference: str | None = Field(default=None, max_length=60)
    contract_type: ContractType
    status: Literal["draft", "pending_signature", "active"] = "draft"
    start_date: date | None = None
    end_date: date | None = None
    renewal_date: date | None = None
    auto_renew: bool = False
    notice_period_days: int | None = Field(default=None, ge=0, le=3650)
    territories: list[str] = Field(default_factory=lambda: [WORLD], max_length=300)
    rights_granted: list[str] = Field(default_factory=list, max_length=20)
    currency: str = "USD"
    advance_amount: Decimal | None = Field(default=None, ge=0, max_digits=20, decimal_places=8)
    is_recoupable: bool = False
    summary: str | None = Field(default=None, max_length=10_000)
    notes: str | None = Field(default=None, max_length=20_000)
    parties: list[ContractPartyIn] = Field(default_factory=list, max_length=100)
    royalty_terms: list[RoyaltyTermIn] = Field(default_factory=list, max_length=200)
    assets: list[ContractAssetIn] = Field(default_factory=list, max_length=5000)

    @model_validator(mode="after")
    def _validate(self) -> "ContractCreate":
        if not self.title:
            raise ValueError("Title is required")
        if self.start_date and self.end_date and self.end_date < self.start_date:
            raise ValueError("end_date must be on or after start_date")
        if any(t.id for t in self.royalty_terms):
            raise ValueError("Royalty term ids cannot be supplied when creating a contract")
        _check_nested(self.parties, self.royalty_terms, self.assets)
        return self


class ContractUpdate(_ContractFields):
    """Partial update. Nested lists, when present, replace the current set
    (royalty terms with a matching ``id`` are updated in place)."""

    title: str | None = Field(default=None, min_length=1, max_length=255)
    reference: str | None = Field(default=None, max_length=60)
    contract_type: ContractType | None = None
    status: ContractStatus | None = None
    start_date: date | None = None
    end_date: date | None = None
    renewal_date: date | None = None
    auto_renew: bool | None = None
    notice_period_days: int | None = Field(default=None, ge=0, le=3650)
    territories: list[str] | None = Field(default=None, max_length=300)
    rights_granted: list[str] | None = Field(default=None, max_length=20)
    currency: str | None = None
    advance_amount: Decimal | None = Field(default=None, ge=0, max_digits=20, decimal_places=8)
    is_recoupable: bool | None = None
    summary: str | None = Field(default=None, max_length=10_000)
    notes: str | None = Field(default=None, max_length=20_000)
    parties: list[ContractPartyIn] | None = Field(default=None, max_length=100)
    royalty_terms: list[RoyaltyTermIn] | None = Field(default=None, max_length=200)
    assets: list[ContractAssetIn] | None = Field(default=None, max_length=5000)

    @model_validator(mode="after")
    def _validate(self) -> "ContractUpdate":
        for name in ("title", "contract_type", "status", "auto_renew", "territories",
                     "rights_granted", "currency", "is_recoupable"):
            if name in self.model_fields_set and getattr(self, name) is None:
                raise ValueError(f"{name} cannot be null")
        _check_nested(self.parties, self.royalty_terms, self.assets)
        return self


# --------------------------------------------------------------------------- outputs


class ContractPartyOut(BaseModel):
    id: str
    party_id: str
    party_name: str | None = None
    role: str
    signed_at: date | None = None


class RoyaltyTermOut(BaseModel):
    id: str
    payee_party_id: str | None = None
    payee_name: str | None = None
    rights_type: str | None = None
    source_category: str | None = None
    territories: list[str] | None = None
    rate_percent: DecimalStr
    basis: str
    description: str | None = None


class ContractAssetOut(BaseModel):
    id: str
    asset_type: Literal["work", "recording"]
    work_id: str | None = None
    recording_id: str | None = None
    title: str | None = None
    code: str | None = None  # ISWC for works, ISRC for recordings


class StoredFileOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    category: str
    original_filename: str
    content_type: str
    size_bytes: int
    sha256: str
    created_by_id: str | None = None
    created_at: datetime


class ContractDocumentOut(BaseModel):
    id: str
    contract_id: str
    file_id: str
    label: str | None = None
    filename: str
    content_type: str
    size_bytes: int
    sha256: str
    uploaded_by_id: str | None = None
    created_at: datetime
    text_extractable: bool


class ContractListItem(BaseModel):
    id: str
    title: str
    reference: str | None = None
    contract_type: str
    status: str
    start_date: date | None = None
    end_date: date | None = None
    renewal_date: date | None = None
    auto_renew: bool
    currency: str
    advance_amount: OptionalDecimalStr = None
    party_names: list[str] = []
    days_until_expiry: int | None = None
    expiry_state: ExpiryState
    created_at: datetime
    updated_at: datetime


class ContractDetail(ContractListItem):
    notice_period_days: int | None = None
    territories: list[str]
    rights_granted: list[str]
    is_recoupable: bool
    summary: str | None = None
    notes: str | None = None
    expiry_notified_at: datetime | None = None
    created_by_id: str | None = None
    allowed_status_transitions: list[str]
    parties: list[ContractPartyOut]
    royalty_terms: list[RoyaltyTermOut]
    assets: list[ContractAssetOut]
    documents: list[ContractDocumentOut]


class ContractSummary(BaseModel):
    total: int
    by_status: dict[str, int]
    by_type: dict[str, int]
    active: int
    expiring_within_30_days: int
    expiring_within_60_days: int
    expiring_within_90_days: int
    advances_by_currency: dict[str, DecimalStr]


# --------------------------------------------------------------------------- clause scan


class ClauseFlag(BaseModel):
    category: str
    severity: Literal["low", "medium", "high"]
    excerpt: str
    source: Literal["rule", "ai"]
    match: str | None = None
    explanation: str | None = None


class ClauseScanResponse(BaseModel):
    document_id: str
    flags: list[ClauseFlag]
    categories: list[str]
    characters_scanned: int
    notice: str


# --------------------------------------------------------------------------- AI analysis


class ContractAnalysisCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    document_id: str = Field(min_length=1, max_length=36)


class ContractAnalysisReview(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decision: Literal["accepted", "rejected"]
    notes: str | None = Field(default=None, max_length=5000)
    apply_fields: list[AIApplicableField] = Field(default_factory=list, max_length=10)

    @model_validator(mode="after")
    def _validate(self) -> "ContractAnalysisReview":
        if self.decision == "rejected" and self.apply_fields:
            raise ValueError("apply_fields can only be used when accepting an analysis")
        if len(self.apply_fields) != len(set(self.apply_fields)):
            raise ValueError("apply_fields contains duplicates")
        return self


class ContractAnalysisOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    contract_id: str
    document_id: str | None = None
    status: str
    provider: str | None = None
    model: str | None = None
    extracted: dict[str, Any] | None = None
    flagged_clauses: list[dict[str, Any]] | None = None
    error: str | None = None
    review_status: str
    reviewed_by_id: str | None = None
    reviewed_at: datetime | None = None
    review_notes: str | None = None
    created_by_id: str | None = None
    created_at: datetime
    updated_at: datetime
    advisory_notice: str
    requires_human_review: Literal[True] = True


# Structured output requested from the AI provider. Every field is a
# *candidate* value for human review; nothing is applied automatically.
# All properties are required (nullable where a value may be absent) and
# extra keys are forbidden, so the JSON schema also satisfies strict
# structured-output modes (``additionalProperties: false``).


class _AIModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ExtractedParty(_AIModel):
    name: str
    role: str | None = Field(description="Role in the contract, e.g. writer, publisher, label")


class ExtractedRoyaltyRate(_AIModel):
    description: str
    rate_percent: str | None = Field(
        description="Decimal percentage as a string, e.g. '50' or '12.5'; null if unstated"
    )
    basis: str | None = Field(description="'gross', 'net' or null if unstated")


class ExtractedClause(_AIModel):
    category: str
    severity: Literal["low", "medium", "high"]
    quote: str = Field(description="Verbatim excerpt from the document")
    explanation: str


class ContractExtraction(_AIModel):
    """Candidate contract terms extracted from a document (advisory)."""

    title: str | None
    contract_type: str | None = Field(
        description=f"One of: {', '.join(CONTRACT_TYPES)}; null if unclear"
    )
    parties: list[ExtractedParty]
    start_date: str | None = Field(description="ISO date YYYY-MM-DD or null")
    end_date: str | None = Field(description="ISO date YYYY-MM-DD or null")
    renewal_date: str | None = Field(description="ISO date YYYY-MM-DD or null")
    renewal_terms: str | None
    territories: list[str] = Field(description="ISO 3166-1 alpha-2 codes, or WORLD")
    rights_granted: list[str] = Field(description=f"Subset of: {', '.join(RIGHTS_TYPES)}")
    royalty_rates: list[ExtractedRoyaltyRate]
    advance_amount: str | None = Field(description="Decimal string without symbols, or null")
    currency: str | None = Field(description="ISO 4217 code, or null")
    term_summary: str | None
    flagged_clauses: list[ExtractedClause]
    prompt_injection_suspected: bool
    confidence_notes: str | None
