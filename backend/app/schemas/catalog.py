"""Request/response models for the music catalog (parties, works,
recordings, releases) and catalog tooling (bulk actions, validation,
duplicates, completeness, imports)."""

from datetime import date, datetime
from typing import Annotated, Any, ClassVar, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    EmailStr,
    Field,
    field_validator,
    model_validator,
)

from app.services import identifiers

# --------------------------------------------------------------------------- vocabularies

PARTY_ROLES: tuple[str, ...] = (
    "artist", "songwriter", "composer", "lyricist", "producer", "publisher",
    "label", "performer", "engineer", "administrator", "other",
)
PARTY_TYPES: tuple[str, ...] = ("person", "company")
WORK_CONTRIBUTOR_ROLES: tuple[str, ...] = (
    "composer", "lyricist", "composer_lyricist", "arranger", "adapter", "translator",
    "original_publisher", "sub_publisher", "administrator",
)
# Roles that make someone a writer of the composition.
WRITER_ROLES: frozenset[str] = frozenset(
    {"composer", "lyricist", "composer_lyricist", "arranger", "adapter", "translator"}
)
PUBLISHER_ROLES: frozenset[str] = frozenset({"original_publisher", "sub_publisher", "administrator"})
RECORDING_CONTRIBUTOR_ROLES: tuple[str, ...] = (
    "main_artist", "featured_artist", "producer", "co_producer", "mixer", "engineer",
    "mastering_engineer", "musician", "vocalist", "label",
)
RELEASE_TYPES: tuple[str, ...] = ("album", "ep", "single", "compilation", "other")
CATALOG_STATUSES: tuple[str, ...] = ("active", "draft", "archived")
VERIFICATION_STATUSES: tuple[str, ...] = ("unverified", "verified", "disputed")
CATALOG_ENTITY_TYPES: tuple[str, ...] = ("work", "recording", "release", "party")

PartyRole = Literal[
    "artist", "songwriter", "composer", "lyricist", "producer", "publisher",
    "label", "performer", "engineer", "administrator", "other",
]
PartyType = Literal["person", "company"]
WorkContributorRole = Literal[
    "composer", "lyricist", "composer_lyricist", "arranger", "adapter", "translator",
    "original_publisher", "sub_publisher", "administrator",
]
RecordingContributorRole = Literal[
    "main_artist", "featured_artist", "producer", "co_producer", "mixer", "engineer",
    "mastering_engineer", "musician", "vocalist", "label",
]
ReleaseType = Literal["album", "ep", "single", "compilation", "other"]
CreateStatus = Literal["active", "draft"]
CatalogStatus = Literal["active", "draft", "archived"]
VerificationStatus = Literal["unverified", "verified", "disputed"]
CatalogEntityType = Literal["work", "recording", "release", "party"]


# --------------------------------------------------------------------------- field helpers


def _blank_to_none(value: Any) -> Any:
    if isinstance(value, str):
        value = value.strip()
        return value or None
    return value


def _required_text(value: str) -> str:
    value = value.strip()
    if not value:
        raise ValueError("This field is required")
    return value


def _iswc(value: str | None) -> str | None:
    if value is None:
        return None
    if not identifiers.is_valid_iswc(value):
        raise ValueError("Invalid ISWC (expected T-123.456.789-C with a valid check digit)")
    return identifiers.normalize_iswc(value)


def _isrc(value: str | None) -> str | None:
    if value is None:
        return None
    if not identifiers.is_valid_isrc(value):
        raise ValueError("Invalid ISRC (expected CC-XXX-YY-NNNNN)")
    return identifiers.normalize_isrc(value)


def _upc(value: str | None) -> str | None:
    if value is None:
        return None
    if not identifiers.is_valid_upc(value):
        raise ValueError("Invalid UPC/EAN (12-14 digits with a valid GS1 check digit)")
    return identifiers.normalize_upc(value)


def _ipi(value: str | None) -> str | None:
    if value is None:
        return None
    if not identifiers.is_valid_ipi(value):
        raise ValueError("Invalid IPI name number (expected 9-11 digits)")
    return identifiers.normalize_ipi(value)


def _isni(value: str | None) -> str | None:
    if value is None:
        return None
    if not identifiers.is_valid_isni(value):
        raise ValueError("Invalid ISNI (16 characters with a valid check character)")
    return identifiers.normalize_isni(value)


def _upper(value: str | None) -> str | None:
    return value.upper() if value else value


def _external_ids(value: dict[str, Any] | None) -> dict[str, Any] | None:
    if value is None:
        return None
    if len(value) > 50:
        raise ValueError("At most 50 external ids are allowed")
    clean: dict[str, Any] = {}
    for key, item in value.items():
        if not isinstance(key, str) or not key.strip() or len(key) > 50:
            raise ValueError("External id keys must be 1-50 characters")
        if item is not None and not isinstance(item, (str, int)):
            raise ValueError("External id values must be strings or integers")
        if isinstance(item, str) and len(item) > 255:
            raise ValueError("External id values must be at most 255 characters")
        clean[key.strip()] = item
    return clean


Title = Annotated[str, BeforeValidator(_blank_to_none), Field(min_length=1, max_length=255),
                  AfterValidator(_required_text)]
def _opt(max_length: int, *validators: Any, pattern: str | None = None) -> Any:
    """Optional trimmed string: blank -> None, constraints on the string only."""
    inner = Annotated[str, Field(max_length=max_length, pattern=pattern), *validators]
    return Annotated[inner | None, BeforeValidator(_blank_to_none)]


OptStr = _opt(255)
OptCode = _opt(50)
OptText = _opt(10000)
ISWC = _opt(32, AfterValidator(_iswc))
ISRC = _opt(32, AfterValidator(_isrc))
UPC = _opt(32, AfterValidator(_upc))
IPI = _opt(32, AfterValidator(_ipi))
ISNI = _opt(32, AfterValidator(_isni))
CountryCode = _opt(2, AfterValidator(_upper), pattern=r"^[A-Za-z]{2}$")
Language = _opt(10, pattern=r"^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,4})?$")
ExternalIds = Annotated[dict[str, Any] | None, AfterValidator(_external_ids)]
EntityId = Annotated[str, Field(min_length=1, max_length=36)]


class _NoNullRequired(BaseModel):
    """Update models: fields listed in ``required_fields`` may be omitted but never
    explicitly set to null."""

    required_fields: ClassVar[tuple[str, ...]] = ()

    @model_validator(mode="after")
    def _reject_nulls(self):
        for name in self.required_fields:
            if name in self.model_fields_set and getattr(self, name) is None:
                raise ValueError(f"'{name}' cannot be null")
        return self


# --------------------------------------------------------------------------- shared output


class Completeness(BaseModel):
    score: int
    missing: list[str]


class PartyRef(BaseModel):
    id: str
    name: str


# --------------------------------------------------------------------------- parties


def _dedupe_roles(value: list[str] | None) -> list[str] | None:
    if value is None:
        return None
    seen: list[str] = []
    for role in value:
        if role not in seen:
            seen.append(role)
    return seen


class PartyBase(BaseModel):
    legal_name: OptStr = None
    email: Annotated[EmailStr | None, BeforeValidator(_blank_to_none)] = None
    country_code: CountryCode = None
    ipi_number: IPI = None
    isni: ISNI = None
    pro_affiliation: _opt(100) = None
    external_ids: ExternalIds = None
    notes: OptText = None


class PartyCreate(PartyBase):
    name: Title
    party_type: PartyType = "person"
    roles: Annotated[list[PartyRole], Field(max_length=11), AfterValidator(_dedupe_roles)] = []
    is_internal: bool = False
    status: CreateStatus = "active"


class PartyUpdate(PartyBase, _NoNullRequired):
    required_fields: ClassVar[tuple[str, ...]] = ("name", "party_type", "roles", "is_internal", "status")

    name: Title | None = None
    party_type: PartyType | None = None
    roles: Annotated[list[PartyRole] | None, Field(max_length=11),
                     AfterValidator(_dedupe_roles)] = None
    is_internal: bool | None = None
    status: CatalogStatus | None = None


class PartyResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    organization_id: str
    name: str
    party_type: str
    roles: list[str]
    legal_name: str | None = None
    email: str | None = None
    country_code: str | None = None
    ipi_number: str | None = None
    isni: str | None = None
    pro_affiliation: str | None = None
    is_internal: bool
    external_ids: dict[str, Any] | None = None
    notes: str | None = None
    status: str
    created_at: datetime
    updated_at: datetime


class PartyDetailResponse(PartyResponse):
    work_count: int = 0
    recording_count: int = 0
    release_count: int = 0
    references: dict[str, int] = {}
    is_referenced: bool = False


# --------------------------------------------------------------------------- works


class WorkContributorIn(BaseModel):
    party_id: EntityId
    role: WorkContributorRole


class WorkContributorResponse(BaseModel):
    id: str
    party_id: str
    party_name: str | None
    role: str


class WorkBase(BaseModel):
    alternate_titles: Annotated[list[Annotated[str, Field(min_length=1, max_length=255)]] | None,
                                Field(max_length=50)] = None
    iswc: ISWC = None
    internal_code: OptCode = None
    language: Language = None
    genre: _opt(100) = None
    creation_year: Annotated[int | None, Field(ge=1000, le=2100)] = None
    lyrics_excerpt: _opt(5000) = None
    external_ids: ExternalIds = None
    notes: OptText = None


class WorkCreate(WorkBase):
    title: Title
    status: CreateStatus = "active"
    verification_status: VerificationStatus = "unverified"
    contributors: Annotated[list[WorkContributorIn], Field(max_length=200)] = []


class WorkUpdate(WorkBase, _NoNullRequired):
    required_fields: ClassVar[tuple[str, ...]] = ("title", "status", "verification_status", "contributors")

    title: Title | None = None
    status: CatalogStatus | None = None
    verification_status: VerificationStatus | None = None
    # ``None``/omitted keeps contributors; a list replaces them.
    contributors: Annotated[list[WorkContributorIn] | None, Field(max_length=200)] = None


class LinkedRecording(BaseModel):
    id: str
    title: str
    version_title: str | None = None
    isrc: str | None = None
    artist: str | None = None
    status: str


class WorkResponse(BaseModel):
    id: str
    organization_id: str
    title: str
    alternate_titles: list[str] | None = None
    iswc: str | None = None
    iswc_display: str | None = None
    internal_code: str | None = None
    language: str | None = None
    genre: str | None = None
    creation_year: int | None = None
    lyrics_excerpt: str | None = None
    external_ids: dict[str, Any] | None = None
    notes: str | None = None
    status: str
    verification_status: str
    contributors: list[WorkContributorResponse]
    completeness: Completeness
    created_at: datetime
    updated_at: datetime


class WorkDetailResponse(WorkResponse):
    recordings: list[LinkedRecording] = []


# --------------------------------------------------------------------------- recordings


class RecordingContributorIn(BaseModel):
    party_id: EntityId
    role: RecordingContributorRole
    instrument: _opt(100) = None


class RecordingContributorResponse(BaseModel):
    id: str
    party_id: str
    party_name: str | None
    role: str
    instrument: str | None = None


class LinkedWork(BaseModel):
    id: str
    title: str
    iswc: str | None = None
    status: str


class RecordingBase(BaseModel):
    version_title: OptStr = None
    isrc: ISRC = None
    internal_code: OptCode = None
    primary_artist_id: _opt(36) = None
    display_artist: OptStr = None
    duration_seconds: Annotated[int | None, Field(ge=0, le=86400)] = None
    recording_date: date | None = None
    p_line: OptStr = None
    external_ids: ExternalIds = None
    notes: OptText = None


class RecordingCreate(RecordingBase):
    title: Title
    is_explicit: bool = False
    status: CreateStatus = "active"
    verification_status: VerificationStatus = "unverified"
    contributors: Annotated[list[RecordingContributorIn], Field(max_length=200)] = []
    work_ids: Annotated[list[EntityId], Field(max_length=100)] = []


class RecordingUpdate(RecordingBase, _NoNullRequired):
    required_fields: ClassVar[tuple[str, ...]] = ("title", "is_explicit", "status", "verification_status", "contributors", "work_ids")

    title: Title | None = None
    is_explicit: bool | None = None
    status: CatalogStatus | None = None
    verification_status: VerificationStatus | None = None
    contributors: Annotated[list[RecordingContributorIn] | None,
                            Field(max_length=200)] = None
    work_ids: Annotated[list[EntityId] | None, Field(max_length=100)] = None


class RecordingReleaseRef(BaseModel):
    id: str
    title: str
    upc: str | None = None
    disc_number: int
    track_number: int
    status: str


class RecordingResponse(BaseModel):
    id: str
    organization_id: str
    title: str
    version_title: str | None = None
    isrc: str | None = None
    internal_code: str | None = None
    primary_artist_id: str | None = None
    primary_artist_name: str | None = None
    display_artist: str | None = None
    artist: str | None = None
    duration_seconds: int | None = None
    recording_date: date | None = None
    p_line: str | None = None
    is_explicit: bool
    external_ids: dict[str, Any] | None = None
    notes: str | None = None
    status: str
    verification_status: str
    contributors: list[RecordingContributorResponse]
    works: list[LinkedWork]
    completeness: Completeness
    created_at: datetime
    updated_at: datetime


class RecordingDetailResponse(RecordingResponse):
    releases: list[RecordingReleaseRef] = []


# --------------------------------------------------------------------------- releases


class ReleaseTrackIn(BaseModel):
    recording_id: EntityId
    disc_number: Annotated[int, Field(ge=1, le=99)] = 1
    track_number: Annotated[int, Field(ge=1, le=999)]


def _unique_positions(tracks: list[ReleaseTrackIn] | None) -> list[ReleaseTrackIn] | None:
    if tracks is None:
        return None
    seen: set[tuple[int, int]] = set()
    for track in tracks:
        key = (track.disc_number, track.track_number)
        if key in seen:
            raise ValueError(f"Duplicate track position disc {key[0]} track {key[1]}")
        seen.add(key)
    return tracks


class ReleaseTrackResponse(BaseModel):
    id: str
    recording_id: str
    recording_title: str | None
    version_title: str | None = None
    isrc: str | None = None
    artist: str | None = None
    duration_seconds: int | None = None
    disc_number: int
    track_number: int


class ReleaseBase(BaseModel):
    upc: UPC = None
    catalog_number: OptCode = None
    label_id: _opt(36) = None
    display_artist: OptStr = None
    release_date: date | None = None
    c_line: OptStr = None
    external_ids: ExternalIds = None
    notes: OptText = None


class ReleaseCreate(ReleaseBase):
    title: Title
    release_type: ReleaseType = "album"
    status: CreateStatus = "active"
    tracks: Annotated[list[ReleaseTrackIn], Field(max_length=500),
                      AfterValidator(_unique_positions)] = []


class ReleaseUpdate(ReleaseBase, _NoNullRequired):
    required_fields: ClassVar[tuple[str, ...]] = ("title", "release_type", "status", "tracks")

    title: Title | None = None
    release_type: ReleaseType | None = None
    status: CatalogStatus | None = None
    tracks: Annotated[list[ReleaseTrackIn] | None, Field(max_length=500),
                      AfterValidator(_unique_positions)] = None


class ReleaseResponse(BaseModel):
    id: str
    organization_id: str
    title: str
    release_type: str
    upc: str | None = None
    catalog_number: str | None = None
    label_id: str | None = None
    label_name: str | None = None
    display_artist: str | None = None
    release_date: date | None = None
    c_line: str | None = None
    external_ids: dict[str, Any] | None = None
    notes: str | None = None
    status: str
    tracks: list[ReleaseTrackResponse]
    track_count: int
    completeness: Completeness
    created_at: datetime
    updated_at: datetime


# --------------------------------------------------------------------------- catalog tools


class CatalogBulkRequest(BaseModel):
    entity_type: CatalogEntityType
    action: Literal["archive", "restore", "delete"]
    ids: Annotated[list[EntityId], Field(min_length=1, max_length=500)]

    @field_validator("ids")
    @classmethod
    def _unique_ids(cls, value: list[str]) -> list[str]:
        return list(dict.fromkeys(value))


class BulkSkipped(BaseModel):
    id: str
    reason: str


class CatalogBulkResult(BaseModel):
    entity_type: str
    action: str
    affected: int
    affected_ids: list[str]
    skipped: list[BulkSkipped]


class ValidationIssue(BaseModel):
    entity_type: str
    entity_id: str
    title: str
    code: str
    severity: Literal["error", "warning", "info"]
    message: str


class ValidationIssuesResponse(BaseModel):
    items: list[ValidationIssue]
    total: int
    page: int
    page_size: int
    pages: int
    by_code: dict[str, int]


class DuplicateCandidate(BaseModel):
    entity_type: str
    ids: list[str]
    titles: list[str]
    score: float
    reasons: list[str]


class CompletenessItem(BaseModel):
    entity_type: str
    id: str
    title: str
    score: int
    missing: list[str]


class CompletenessGroup(BaseModel):
    count: int
    average_score: float


class CompletenessSummary(BaseModel):
    count: int
    average_score: float
    bands: dict[str, int]
    by_entity_type: dict[str, CompletenessGroup]
    least_complete: list[CompletenessItem]


class RecentItem(BaseModel):
    entity_type: str
    id: str
    title: str
    status: str
    updated_at: datetime


class CatalogSummary(BaseModel):
    works: int
    recordings: int
    releases: int
    parties: int
    archived: dict[str, int]
    parties_by_role: dict[str, int]
    missing_identifiers: dict[str, int]
    recently_updated: list[RecentItem]


class CatalogActivityResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    actor_user_id: str | None
    actor_name: str | None = None
    action: str
    entity_type: str | None
    entity_id: str | None
    summary: str | None
    changes: dict[str, Any] | None
    created_at: datetime


class ImportJobResponse(BaseModel):
    id: str
    job_type: str
    status: str
    progress: int
    entity_type: str | None = None
    dry_run: bool = False
    filename: str | None = None
    file_id: str | None = None
    result: dict[str, Any] | None = None
    error: str | None = None
    deduplicated: bool = False
    created_by_id: str | None = None
    created_at: datetime
    finished_at: datetime | None = None


# --------------------------------------------------------------------------- reference


class ReferenceItem(BaseModel):
    code: str
    name: str
