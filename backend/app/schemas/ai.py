"""AI intelligence schemas.

Two families live here:

* **AI output models** (``AssistantAnswer``, ``CatalogSearchPlan``...): the
  JSON schema the provider must satisfy. They forbid extra keys and declare
  every field as required (nullable where optional) so they work with strict
  structured-output modes. Their class name is the schema title, which the
  test ``FakeAIProvider`` keys responses by.
* **API request/response models** used by ``app.api.v1.ai``.

Monetary values are always strings.
"""

from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schemas.common import DecimalStr, ORMModel, Page

AIEntityType = Literal["work", "recording", "release", "party", "contract"]
CleanupEntityType = Literal["work", "recording", "party"]
DuplicateEntityType = Literal["work", "recording", "release", "party"]
Confidence = Literal["low", "medium", "high"]
SourceCategory = Literal[
    "streaming", "distributor", "publishing_admin", "pro", "mechanical", "licensing",
    "manual_adjustment",
]
CanonicalField = Literal[
    "isrc", "iswc", "upc", "title", "artist", "territory", "usage_type", "rights_type",
    "store", "quantity", "gross_amount", "amount", "currency", "transaction_date",
    "source_reference",
]
CANONICAL_FIELDS: tuple[str, ...] = CanonicalField.__args__  # type: ignore[attr-defined]
CleanupField = Literal[
    "title", "alternate_titles", "iswc", "language", "genre",
    "version_title", "isrc", "display_artist",
    "name", "legal_name", "ipi_number", "isni", "country_code",
]
SearchStatus = Literal[
    "active", "draft", "archived", "pending_signature", "expired", "terminated"
]


class _AIOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")


# =========================================================================== AI output models


class CitedRecord(_AIOutput):
    entity_type: AIEntityType = Field(description="Type of the cited record.")
    id: str = Field(description="Exact id of a record that appeared in the supplied context.")


class AssistantAnswer(_AIOutput):
    answer: str = Field(description="Answer grounded only in the supplied catalog context.")
    cited_records: list[CitedRecord] = Field(
        description="Records from the supplied context that support the answer. Only ids that "
        "appear in the context are allowed."
    )
    follow_up_questions: list[str] = Field(
        description="Up to three useful follow-up questions the user could ask."
    )
    insufficient_data: bool = Field(
        description="True when the supplied context does not contain enough information."
    )


class CatalogSearchPlan(_AIOutput):
    entity_type: AIEntityType = Field(description="Which kind of record the user is looking for.")
    title_contains: str | None = Field(description="Substring of the title/name, or null.")
    artist_contains: str | None = Field(description="Substring of an artist name, or null.")
    writer_contains: str | None = Field(
        description="Substring of a songwriter/contributor/contract party name, or null."
    )
    identifier: str | None = Field(
        description="An exact identifier (ISRC, ISWC, UPC, IPI, ISNI, internal code or contract "
        "reference) mentioned by the user, or null."
    )
    missing_fields: list[str] = Field(
        description="Fields the records must be missing. Works: iswc, writers, shares, language, "
        "genre, recordings. Recordings: isrc, work, primary_artist, duration, display_artist. "
        "Releases: upc, release_date, tracks, label. Parties: ipi_number, isni, country_code, "
        "email. Contracts: start_date, end_date, parties, assets."
    )
    status: SearchStatus | None = Field(
        description="Record status filter, or null. Catalog: active/draft/archived. Contracts: "
        "draft/pending_signature/active/expired/terminated."
    )
    created_after: str | None = Field(description="ISO date YYYY-MM-DD, or null.")
    created_before: str | None = Field(description="ISO date YYYY-MM-DD, or null.")
    explanation: str = Field(description="One sentence describing how the query was interpreted.")


class MetadataFieldChange(_AIOutput):
    field: CleanupField = Field(description="The field to change. Must apply to the entity type.")
    proposed_value: str | None = Field(
        description="New value for scalar fields; null when proposing alternate_titles."
    )
    proposed_values: list[str] = Field(
        description="Complete new list for alternate_titles; empty for other fields."
    )
    reason: str = Field(description="Why the change improves the metadata.")


class MetadataCleanupProposal(_AIOutput):
    changes: list[MetadataFieldChange] = Field(
        description="Proposed cleanups (capitalization, identifier format, alternate titles, "
        "consistent artist names). Empty when nothing should change."
    )
    summary: str = Field(description="Short overall summary of the proposal.")


class DuplicateAssessment(_AIOutput):
    likely_duplicate: bool = Field(description="True if the two records describe the same thing.")
    confidence: Confidence = Field(description="Confidence in the assessment.")
    explanation: str = Field(description="Evidence for and against the records being duplicates.")
    recommended_action: str = Field(
        description="What a human administrator should do next (never an automatic merge)."
    )


class ConflictPartyNote(_AIOutput):
    party_id: str = Field(description="Exact id of a party that appears in the supplied context.")
    note: str = Field(description="How this party is involved in the conflict.")


class ConflictExplanation(_AIOutput):
    summary: str = Field(description="Plain-language explanation of the conflict.")
    likely_causes: list[str] = Field(description="Plausible causes based only on the data.")
    suggested_next_steps: list[str] = Field(description="Concrete steps for a human to take.")
    parties_involved: list[ConflictPartyNote] = Field(
        description="Parties from the context relevant to resolving the conflict."
    )


class AnomalySummary(_AIOutput):
    overview: str = Field(description="Executive summary of the detected anomalies.")
    key_findings: list[str] = Field(description="Most important findings, highest impact first.")
    recommended_checks: list[str] = Field(description="Checks a royalty analyst should perform.")


class ColumnMappingEntry(_AIOutput):
    canonical_field: CanonicalField = Field(description="Canonical statement field.")
    header: str = Field(description="Exact header text from the provided header list.")


class StatementClassification(_AIOutput):
    source_category: SourceCategory = Field(description="Most likely income source category.")
    source_name_guess: str | None = Field(
        description="Likely name of the reporting source (e.g. a DSP or society), or null."
    )
    column_mapping: list[ColumnMappingEntry] = Field(
        description="Mapping of canonical fields to provided headers. Omit fields with no header."
    )
    confidence: Confidence = Field(description="Confidence in the classification.")
    notes: str = Field(description="Caveats, ambiguities or data-quality observations.")


class ReportNarrative(_AIOutput):
    headline: str = Field(description="One-line headline.")
    narrative: str = Field(
        description="Executive narrative that only uses the supplied figures; no new numbers."
    )
    key_points: list[str] = Field(description="Key takeaways.")
    caveats: list[str] = Field(description="Data limitations the reader should know about.")


# =========================================================================== shared response bits


class AIResponseMeta(BaseModel):
    ai_generated: bool = True
    advisory_notice: str
    provider: str | None = None
    model: str | None = None


class RecordRef(BaseModel):
    entity_type: str
    id: str
    title: str | None = None


# =========================================================================== status & usage


class AIConnectivity(BaseModel):
    """Whether the provider actually answered, judged from this organization's own requests.
    ``configured`` only means settings are present."""

    state: Literal["verified", "failing", "unverified"]
    last_success_at: datetime | None
    last_error_code: str | None
    last_error_message: str | None
    last_error_at: datetime | None


class AIStatusResponse(BaseModel):
    configured: bool
    provider: str | None
    model: str | None
    connectivity: AIConnectivity
    plan_allows_ai: bool
    requests_this_month: int
    monthly_limit: int | None
    tokens_this_month: int
    estimated_cost_this_month: str
    advisory_notice: str


class AIUsageRecordResponse(ORMModel):
    id: str
    user_id: str | None
    feature: str
    provider: str
    model: str
    status: str
    input_tokens: int
    output_tokens: int
    estimated_cost_usd: DecimalStr
    latency_ms: int
    error: str | None
    created_at: datetime


class AIFeatureUsage(BaseModel):
    feature: str
    requests: int
    errors: int
    input_tokens: int
    output_tokens: int
    estimated_cost_usd: str


class AIUsagePage(Page[AIUsageRecordResponse]):
    month_start: datetime
    month_by_feature: list[AIFeatureUsage]
    month_total_requests: int
    month_total_cost_usd: str


# =========================================================================== assistant


class ChatTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=4000)


class AssistantRequest(BaseModel):
    question: str = Field(min_length=2, max_length=2000)
    history: list[ChatTurn] = Field(default_factory=list, max_length=10)

    @field_validator("question")
    @classmethod
    def _strip(cls, value: str) -> str:
        value = value.strip()
        if len(value) < 2:
            raise ValueError("Question is too short")
        return value


class AssistantResponse(AIResponseMeta):
    answer: str
    cited_records: list[RecordRef]
    follow_up_questions: list[str]
    insufficient_data: bool
    dropped_citations: int
    context_records: int


# =========================================================================== search


class SearchRequest(BaseModel):
    query: str = Field(min_length=2, max_length=500)
    limit: int = Field(default=25, ge=1, le=100)


class SearchResult(BaseModel):
    entity_type: str
    id: str
    title: str
    subtitle: str | None = None
    identifier: str | None = None
    status: str | None = None
    created_at: datetime | None = None


class SearchResponse(AIResponseMeta):
    query: str
    interpreted_plan: dict[str, Any]
    ignored_filters: list[str]
    results: list[SearchResult]
    total: int
    results_source: str = "database"


# =========================================================================== suggestions


class MetadataSuggestionRequest(BaseModel):
    entity_type: CleanupEntityType
    entity_id: str = Field(min_length=1, max_length=36)


class AISuggestionResponse(ORMModel):
    id: str
    kind: str
    source: str
    entity_type: str
    entity_id: str
    title: str
    rationale: str | None
    proposed_changes: dict[str, Any]
    status: str
    created_by_id: str | None
    reviewed_by_id: str | None
    reviewed_at: datetime | None
    created_at: datetime
    updated_at: datetime


class DiscardedChange(BaseModel):
    field: str
    value: Any = None
    reason: str


class MetadataSuggestionResponse(AIResponseMeta):
    summary: str
    suggestions: list[AISuggestionResponse]
    discarded: list[DiscardedChange]


class SuggestionReviewRequest(BaseModel):
    reason: str | None = Field(default=None, max_length=500)


class SuggestionApplyResponse(BaseModel):
    suggestion: AISuggestionResponse
    applied_changes: dict[str, Any]
    skipped: list[DiscardedChange]


# =========================================================================== duplicates


class DuplicateCandidate(BaseModel):
    entity_type: str
    ids: list[str]
    titles: list[str | None]
    score: float
    reasons: list[str]


class DuplicateListResponse(BaseModel):
    entity_type: str
    candidates: list[DuplicateCandidate]
    deterministic: bool = True


class DuplicateExplainRequest(BaseModel):
    entity_type: DuplicateEntityType
    ids: list[str] = Field(min_length=2, max_length=2)

    @field_validator("ids")
    @classmethod
    def _distinct(cls, value: list[str]) -> list[str]:
        if any(not v or len(v) > 36 for v in value):
            raise ValueError("Invalid id")
        if value[0] == value[1]:
            raise ValueError("The two ids must differ")
        return value


class DuplicateExplainResponse(AIResponseMeta):
    records: list[RecordRef]
    likely_duplicate: bool
    confidence: Confidence
    explanation: str
    recommended_action: str
    automatic_merge: bool = False


# =========================================================================== conflicts


class ConflictPartyResponse(BaseModel):
    party_id: str
    name: str | None
    note: str


class ConflictExplainResponse(AIResponseMeta):
    conflict_id: str
    conflict_status: str
    summary: str
    likely_causes: list[str]
    suggested_next_steps: list[str]
    parties_involved: list[ConflictPartyResponse]


# =========================================================================== anomalies


class Anomaly(BaseModel):
    type: str
    severity: Literal["low", "medium", "high"]
    statement_id: str | None
    line_ids: list[str]
    recording_id: str | None = None
    work_id: str | None = None
    isrc: str | None = None
    metrics: dict[str, str | None]
    explanation: str


class AnomalyReport(BaseModel):
    statement_id: str | None
    months: int
    scanned_statements: int
    scanned_lines: int
    truncated: bool
    counts_by_type: dict[str, int]
    anomalies: list[Anomaly]
    deterministic: bool = True


class AnomalySummaryRequest(BaseModel):
    statement_id: str | None = Field(default=None, max_length=36)
    months: int = Field(default=12, ge=1, le=60)


class AnomalySummaryResponse(BaseModel):
    ai_generated: bool
    advisory_notice: str | None
    provider: str | None = None
    model: str | None = None
    anomaly_count: int
    overview: str | None
    key_findings: list[str]
    recommended_checks: list[str]
    message: str | None = None


# =========================================================================== statement classify


Cell = str | int | float | bool | None


class StatementClassifyRequest(BaseModel):
    headers: list[str] = Field(min_length=1, max_length=100)
    sample_rows: list[list[Cell]] = Field(default_factory=list, max_length=20)
    filename: str | None = Field(default=None, max_length=255)

    @field_validator("headers")
    @classmethod
    def _headers(cls, value: list[str]) -> list[str]:
        if any(len(h) > 200 for h in value):
            raise ValueError("Header too long")
        return value

    @field_validator("sample_rows")
    @classmethod
    def _rows(cls, value: list[list[Cell]]) -> list[list[Cell]]:
        for row in value:
            if len(row) > 100:
                raise ValueError("Too many cells in a sample row")
            if any(isinstance(c, str) and len(c) > 500 for c in row):
                raise ValueError("Sample cell too long")
        return value


class StatementClassifyResponse(AIResponseMeta):
    source_category: str
    source_name_guess: str | None
    column_mapping: dict[str, str]
    dropped_mappings: list[dict[str, str]]
    unmapped_headers: list[str]
    confidence: Confidence
    notes: str


# =========================================================================== completeness


class CompletenessCheck(BaseModel):
    check: str
    present: int
    missing: int


class CompletenessIncompleteItem(BaseModel):
    id: str
    title: str
    missing: list[str]


class EntityCompleteness(BaseModel):
    entity_type: str
    total: int
    complete: int
    score_percent: str
    checks: list[CompletenessCheck]
    incomplete_sample: list[CompletenessIncompleteItem]


class CompletenessResponse(BaseModel):
    overall_score_percent: str
    entities: list[EntityCompleteness]
    source: str
    deterministic: bool = True


# =========================================================================== reports


class ReportSummaryRequest(BaseModel):
    report_type: Literal[
        "royalties_by_source", "royalties_by_territory", "catalog_health", "conflicts"
    ]
    period_start: date | None = None
    period_end: date | None = None

    @field_validator("period_end")
    @classmethod
    def _order(cls, value: date | None, info) -> date | None:
        start = info.data.get("period_start")
        if value and start and value < start:
            raise ValueError("period_end must be on or after period_start")
        return value


class ReportSummaryResponse(BaseModel):
    report_type: str
    period_start: date | None
    period_end: date | None
    figures: list[dict[str, Any]]
    totals: dict[str, Any]
    narrative: ReportNarrative | None
    ai_generated: bool
    advisory_notice: str | None
    provider: str | None = None
    model: str | None = None
    message: str | None = None
