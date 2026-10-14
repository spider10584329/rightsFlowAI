"""Rights ownership, split rules, split sheets and conflicts: API schemas."""

from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.schemas.common import DecimalStr, OptionalDecimalStr
from app.services.reference import is_valid_territory, normalize_territory

RightsType = Literal["performance", "mechanical", "sync", "print", "master", "neighbouring"]
ShareRole = Literal[
    "writer", "publisher", "administrator", "sub_publisher", "label", "artist", "producer", "other"
]
AssetType = Literal["work", "recording"]
ShareStatus = Literal["active", "superseded", "disputed", "archived"]
VerificationStatus = Literal["unverified", "verified", "disputed"]
ConflictStatus = Literal["open", "acknowledged", "resolved", "dismissed"]
ConflictSeverity = Literal["low", "medium", "high", "critical"]
ConflictType = Literal[
    "over_allocation",
    "under_allocation",
    "overlapping_claims",
    "duplicate_entry",
    "missing_ownership",
    "invalid_metadata",
]
SplitSheetStatus = Literal["draft", "signed", "verified", "disputed"]

# A share percentage: 0 < x <= 100 with at most 6 decimal places (DECIMAL(9,6)).
SharePercent = Annotated[Decimal, Field(gt=0, le=100, max_digits=9, decimal_places=6)]
RulePercent = Annotated[Decimal, Field(ge=0, le=100, max_digits=9, decimal_places=6)]


def _normalize_territories(values: list[str] | None, *, allow_empty: bool) -> list[str] | None:
    if values is None:
        return None
    result: list[str] = []
    for raw in values:
        code = normalize_territory(raw) if isinstance(raw, str) else None
        if code is None:
            raise ValueError(f"Unknown territory code: {raw!r}")
        if code not in result:
            result.append(code)
    if not result and not allow_empty:
        raise ValueError("At least one territory is required")
    if "WORLD" in result and len(result) > 1:
        raise ValueError("WORLD cannot be combined with individual territories")
    return result


class _TerritoryScope(BaseModel):
    """Shared territory / date validation for share-like payloads."""

    @field_validator("territories", check_fields=False)
    @classmethod
    def _check_territories(cls, value: list[str] | None) -> list[str] | None:
        return _normalize_territories(value, allow_empty=False)

    @field_validator("excluded_territories", check_fields=False)
    @classmethod
    def _check_excluded(cls, value: list[str] | None) -> list[str] | None:
        result = _normalize_territories(value, allow_empty=True)
        if result and "WORLD" in result:
            raise ValueError("WORLD cannot be excluded")
        return result or None

    @model_validator(mode="after")
    def _check_dates(self):
        start = getattr(self, "effective_from", None)
        end = getattr(self, "effective_to", None)
        if start and end and end < start:
            raise ValueError("effective_to must be on or after effective_from")
        return self


# --------------------------------------------------------------------------- shares


class ShareScopeFields(_TerritoryScope):
    party_id: str = Field(min_length=1, max_length=36)
    role: ShareRole
    share_percent: SharePercent
    territories: list[str] = Field(default_factory=lambda: ["WORLD"], max_length=300)
    excluded_territories: list[str] | None = Field(default=None, max_length=300)
    effective_from: date | None = None
    effective_to: date | None = None
    is_controlled: bool = True
    contract_id: str | None = Field(default=None, max_length=36)
    notes: str | None = Field(default=None, max_length=5000)


class ShareCreate(ShareScopeFields):
    work_id: str | None = Field(default=None, max_length=36)
    recording_id: str | None = Field(default=None, max_length=36)
    rights_type: RightsType
    source: Literal["manual", "contract", "import"] = "manual"

    @model_validator(mode="after")
    def _exactly_one_asset(self):
        if bool(self.work_id) == bool(self.recording_id):
            raise ValueError("Provide exactly one of work_id or recording_id")
        return self


class ShareUpdate(_TerritoryScope):
    """In-place edit. Material fields of a verified share cannot change here;
    use the supersede endpoint instead."""

    party_id: str | None = Field(default=None, min_length=1, max_length=36)
    role: ShareRole | None = None
    share_percent: SharePercent | None = None
    territories: list[str] | None = Field(default=None, max_length=300)
    excluded_territories: list[str] | None = Field(default=None, max_length=300)
    effective_from: date | None = None
    effective_to: date | None = None
    is_controlled: bool | None = None
    contract_id: str | None = Field(default=None, max_length=36)
    notes: str | None = Field(default=None, max_length=5000)


class ShareSupersede(ShareUpdate):
    reason: str | None = Field(default=None, max_length=2000)


class ShareVerify(BaseModel):
    notes: str | None = Field(default=None, max_length=2000)


class ShareDispute(BaseModel):
    reason: str = Field(min_length=1, max_length=2000)

    @field_validator("reason")
    @classmethod
    def _strip(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("A reason is required")
        return value


class ShareResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    organization_id: str
    asset_type: AssetType
    work_id: str | None
    recording_id: str | None
    party_id: str
    party_name: str | None = None
    role: str
    rights_type: str
    share_percent: DecimalStr
    territories: list[str]
    excluded_territories: list[str] | None
    effective_from: date | None
    effective_to: date | None
    is_controlled: bool
    source: str
    contract_id: str | None
    split_sheet_id: str | None
    status: str
    verification_status: str
    verified_by_id: str | None
    verified_at: datetime | None
    supersedes_id: str | None
    notes: str | None
    created_by_id: str | None
    created_at: datetime
    updated_at: datetime


# --------------------------------------------------------------------------- validation


class TotalSegment(BaseModel):
    rights_type: str
    effective_from: date | None
    effective_to: date | None
    territories: list[str]
    excluded_territories: list[str] = []
    territory_label: str
    country_count: int
    total: DecimalStr
    controlled_total: DecimalStr
    expected_total: DecimalStr
    tolerance: DecimalStr
    status: Literal["ok", "over", "under", "under_allowed"]
    share_ids: list[str]


class ValidationIssue(BaseModel):
    type: str
    severity: str
    blocking: bool = False
    enforcement: str | None = None
    rights_type: str | None = None
    title: str
    message: str
    share_ids: list[str] = []
    details: dict[str, Any] = {}


class ValidationResult(BaseModel):
    valid: bool
    blocked: bool
    issues: list[ValidationIssue]
    totals: list[TotalSegment]


class ConflictBrief(BaseModel):
    id: str
    conflict_type: str
    severity: str
    status: str
    title: str


class ShareMutationResponse(BaseModel):
    share: ShareResponse
    validation: ValidationResult
    conflicts: list[ConflictBrief]


class SplitEntryIn(ShareScopeFields):
    pass


class SplitsReplace(BaseModel):
    rights_type: RightsType
    shares: list[SplitEntryIn] = Field(max_length=200)
    reason: str | None = Field(default=None, max_length=2000)


class SplitsReplaceResponse(BaseModel):
    shares: list[ShareResponse]
    superseded: int
    archived: int
    validation: ValidationResult
    conflicts: list[ConflictBrief]


class ProposedShare(ShareScopeFields):
    rights_type: RightsType


class ValidateRequest(BaseModel):
    asset_type: AssetType
    asset_id: str | None = Field(default=None, max_length=36)
    shares: list[ProposedShare] = Field(max_length=500)
    include_existing: bool = Field(
        default=False,
        description="Add the asset's current active shares (for the proposed rights types) "
        "to the proposed set instead of replacing them.",
    )


# --------------------------------------------------------------------------- ownership summary


class OwnershipShareLine(BaseModel):
    share_id: str
    party_id: str
    party_name: str | None
    role: str
    share_percent: DecimalStr
    territories: list[str]
    excluded_territories: list[str] | None
    effective_from: date | None
    effective_to: date | None
    is_controlled: bool
    status: str
    verification_status: str


class OwnershipTerritoryTotal(BaseModel):
    territories: list[str]
    excluded_territories: list[str] = []
    territory_label: str
    total: DecimalStr
    controlled_percent: DecimalStr
    non_controlled_percent: DecimalStr
    expected_total: DecimalStr
    status: str


class OwnershipRightsSummary(BaseModel):
    rights_type: str
    total: OptionalDecimalStr = None
    controlled_percent: OptionalDecimalStr = None
    non_controlled_percent: OptionalDecimalStr = None
    totals: list[OwnershipTerritoryTotal]
    shares: list[OwnershipShareLine]
    issues: list[ValidationIssue]


class OwnershipSummary(BaseModel):
    asset_type: AssetType
    asset_id: str
    asset_title: str
    on_date: date
    territory: str | None
    rights: list[OwnershipRightsSummary]
    open_conflicts: list[ConflictBrief]


# --------------------------------------------------------------------------- split rules


class SplitRuleCreate(BaseModel):
    asset_type: AssetType
    rights_type: RightsType
    territory: str | None = Field(default=None, max_length=10)
    expected_total: Annotated[Decimal, Field(gt=0, le=100, max_digits=9, decimal_places=6)] = Decimal("100")
    tolerance: RulePercent = Decimal("0.01")
    allow_under_allocation: bool = False
    enforcement: Literal["warn", "block"] = "warn"
    description: str | None = Field(default=None, max_length=500)

    @field_validator("territory")
    @classmethod
    def _territory(cls, value: str | None) -> str | None:
        if value is None or not value.strip():
            return None
        code = normalize_territory(value)
        if code is None or not is_valid_territory(code):
            raise ValueError(f"Unknown territory code: {value!r}")
        return code


class SplitRuleUpdate(BaseModel):
    expected_total: Annotated[Decimal, Field(gt=0, le=100, max_digits=9, decimal_places=6)] | None = None
    tolerance: RulePercent | None = None
    allow_under_allocation: bool | None = None
    enforcement: Literal["warn", "block"] | None = None
    description: str | None = Field(default=None, max_length=500)


class SplitRuleResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    organization_id: str
    asset_type: str
    rights_type: str
    territory: str | None
    expected_total: DecimalStr
    tolerance: DecimalStr
    allow_under_allocation: bool
    enforcement: str
    description: str | None
    created_at: datetime
    updated_at: datetime


# --------------------------------------------------------------------------- split sheets


class SplitSheetEntry(BaseModel):
    party_id: str = Field(min_length=1, max_length=36)
    role: ShareRole
    share_percent: SharePercent


class SplitSheetCreate(BaseModel):
    work_id: str = Field(min_length=1, max_length=36)
    title: str = Field(min_length=1, max_length=255)
    agreed_date: date | None = None
    status: SplitSheetStatus = "draft"
    entries: list[SplitSheetEntry] = Field(min_length=1, max_length=100)
    document_id: str | None = Field(default=None, max_length=36)
    notes: str | None = Field(default=None, max_length=5000)

    @field_validator("title")
    @classmethod
    def _strip_title(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Title is required")
        return value


class SplitSheetUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=255)
    agreed_date: date | None = None
    status: SplitSheetStatus | None = None
    entries: list[SplitSheetEntry] | None = Field(default=None, min_length=1, max_length=100)
    document_id: str | None = Field(default=None, max_length=36)
    notes: str | None = Field(default=None, max_length=5000)


class SplitSheetEntryOut(BaseModel):
    party_id: str
    party_name: str | None = None
    role: str
    share_percent: DecimalStr


class SplitSheetResponse(BaseModel):
    id: str
    organization_id: str
    work_id: str
    work_title: str | None = None
    title: str
    agreed_date: date | None
    status: str
    entries: list[SplitSheetEntryOut]
    entries_total: DecimalStr
    document_id: str | None
    notes: str | None
    created_by_id: str | None
    created_at: datetime
    updated_at: datetime


class SplitSheetApply(_TerritoryScope):
    rights_types: list[Literal["performance", "mechanical", "sync", "print"]] = Field(
        min_length=1, max_length=4
    )
    territories: list[str] = Field(default_factory=lambda: ["WORLD"], max_length=300)
    excluded_territories: list[str] | None = Field(default=None, max_length=300)
    effective_from: date | None = None
    effective_to: date | None = None
    mode: Literal["add", "replace"] = "add"
    controlled_party_ids: list[str] | None = Field(
        default=None,
        max_length=100,
        description="Parties whose shares are controlled by the organization. "
        "Defaults to every entry being controlled.",
    )


class SplitSheetApplyResponse(BaseModel):
    split_sheet_id: str
    shares: list[ShareResponse]
    superseded: int
    archived: int
    validation: ValidationResult
    conflicts: list[ConflictBrief]


# --------------------------------------------------------------------------- conflicts


class ConflictResponse(BaseModel):
    id: str
    organization_id: str
    conflict_type: str
    severity: str
    status: str
    asset_type: AssetType | None
    work_id: str | None
    recording_id: str | None
    rights_type: str | None
    title: str
    explanation: str
    details: dict[str, Any] | None
    fingerprint: str
    last_detected_at: datetime
    still_detected: bool
    resolved_by_id: str | None
    resolved_at: datetime | None
    resolution_notes: str | None
    created_at: datetime
    updated_at: datetime


class ConflictAction(BaseModel):
    notes: str | None = Field(default=None, max_length=5000)


class ConflictScanRequest(BaseModel):
    asset_type: AssetType | None = None
    asset_id: str | None = Field(default=None, max_length=36)

    @model_validator(mode="after")
    def _both_or_neither(self):
        if bool(self.asset_type) != bool(self.asset_id):
            raise ValueError("Provide both asset_type and asset_id, or neither")
        return self


class ConflictScanResponse(BaseModel):
    scanned_assets: int
    detected: int
    new: int
    no_longer_detected: int
    by_type: dict[str, int]
    by_severity: dict[str, int]
    scanned_at: datetime


# --------------------------------------------------------------------------- summary


class RightsSummary(BaseModel):
    shares_total: int
    shares_by_status: dict[str, int]
    active_shares: int
    verified_active_shares: int
    verified_percent: DecimalStr
    unresolved_conflicts: int
    unresolved_conflicts_by_severity: dict[str, int]
    conflicts_by_status: dict[str, int]
    works_missing_ownership: int
    recordings_missing_ownership: int
    assets_missing_ownership: int
