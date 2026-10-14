"""AI-powered rights intelligence.

AI endpoints (manager+) return ``503 ai_not_configured`` when no provider is
configured, ``402`` when the plan's monthly AI allowance is used up and
``502`` on provider errors. Their responses always carry ``ai_generated`` and
``advisory_notice``. Deterministic endpoints (status, usage, suggestions,
duplicate candidates, anomalies, completeness) work without a provider.
"""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Path, Query, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.permissions import OrgAdmin, OrgManager, OrgViewer
from app.db.session import get_db
from app.models.billing import AISuggestion, AIUsageRecord
from app.schemas.ai import (
    AISuggestionResponse,
    AIStatusResponse,
    AIUsagePage,
    AnomalyReport,
    AnomalySummaryRequest,
    AnomalySummaryResponse,
    AssistantRequest,
    AssistantResponse,
    CompletenessResponse,
    ConflictExplainResponse,
    DuplicateEntityType,
    DuplicateExplainRequest,
    DuplicateExplainResponse,
    DuplicateListResponse,
    MetadataSuggestionRequest,
    MetadataSuggestionResponse,
    ReportSummaryRequest,
    ReportSummaryResponse,
    SearchRequest,
    SearchResponse,
    StatementClassifyRequest,
    StatementClassifyResponse,
    SuggestionApplyResponse,
    SuggestionReviewRequest,
)
from app.schemas.common import Page, PageParams, page_of, paginate
from app.services.ai import features as svc
from app.services.ai.anomalies import detect_anomalies

router = APIRouter(prefix="/organizations/{organization_id}/ai", tags=["AI"])


# --------------------------------------------------------------------------- status & usage


@router.get("/status", response_model=AIStatusResponse)
def ai_status(ctx: OrgViewer, db: Session = Depends(get_db)):
    """Provider configuration, plan entitlement and this month's usage."""
    return svc.ai_status(db, ctx.organization_id)


@router.post("/status/check", response_model=AIStatusResponse)
def ai_connection_check(ctx: OrgAdmin, db: Session = Depends(get_db)):
    """Admin: send one minimal real request to verify the provider (counts as one AI request).
    Fails with the same classified errors as other AI endpoints."""
    return svc.check_connection(db, ctx.organization_id, ctx.user.id)


@router.get("/usage", response_model=AIUsagePage)
def ai_usage(
    ctx: OrgViewer,
    db: Session = Depends(get_db),
    params: PageParams = Depends(),
    feature: Annotated[str | None, Query(max_length=50)] = None,
    status_filter: Annotated[str | None, Query(alias="status", max_length=20)] = None,
):
    stmt = select(AIUsageRecord).where(AIUsageRecord.organization_id == ctx.organization_id)
    if feature:
        stmt = stmt.where(AIUsageRecord.feature == feature)
    if status_filter:
        stmt = stmt.where(AIUsageRecord.status == status_filter)
    rows, total = paginate(
        db, stmt, params,
        sortable={
            "created_at": AIUsageRecord.created_at,
            "feature": AIUsageRecord.feature,
            "estimated_cost_usd": AIUsageRecord.estimated_cost_usd,
        },
        default_sort=AIUsageRecord.created_at.desc(),
    )
    return {**page_of(rows, total, params), **svc.monthly_usage_by_feature(db, ctx.organization_id)}


# --------------------------------------------------------------------------- AI features


@router.post("/assistant", response_model=AssistantResponse)
def catalog_assistant(payload: AssistantRequest, ctx: OrgManager, db: Session = Depends(get_db)):
    """Answer a question grounded in the organization's catalog records."""
    return svc.run_assistant(
        db, ctx.organization_id, ctx.user.id, payload.question,
        [turn.model_dump() for turn in payload.history],
    )


@router.post("/search", response_model=SearchResponse)
def natural_language_search(payload: SearchRequest, ctx: OrgManager,
                            db: Session = Depends(get_db)):
    """Interpret a natural-language query as filters and run a real database query."""
    return svc.natural_language_search(
        db, ctx.organization_id, ctx.user.id, payload.query, payload.limit
    )


@router.post("/metadata-suggestions", response_model=MetadataSuggestionResponse, status_code=201)
def metadata_suggestions(payload: MetadataSuggestionRequest, ctx: OrgManager, request: Request,
                         db: Session = Depends(get_db)):
    """Ask the AI for metadata cleanups; valid proposals become pending suggestions."""
    return svc.propose_metadata_cleanup(
        db, ctx.organization_id, ctx.user.id, payload.entity_type, payload.entity_id, request
    )


@router.post("/duplicates/explain", response_model=DuplicateExplainResponse)
def explain_duplicate(payload: DuplicateExplainRequest, ctx: OrgManager,
                      db: Session = Depends(get_db)):
    """Compare two records. Advisory only: nothing is merged."""
    return svc.explain_duplicate(
        db, ctx.organization_id, ctx.user.id, payload.entity_type, payload.ids
    )


@router.post("/conflicts/{conflict_id}/explain", response_model=ConflictExplainResponse)
def explain_conflict(conflict_id: Annotated[str, Path(max_length=36)], ctx: OrgManager,
                     db: Session = Depends(get_db)):
    """Plain-language explanation of a rights conflict. The conflict is not changed."""
    return svc.explain_conflict(db, ctx.organization_id, ctx.user.id, conflict_id)


@router.post("/anomalies/summary", response_model=AnomalySummaryResponse)
def anomaly_summary(payload: AnomalySummaryRequest, ctx: OrgManager,
                    db: Session = Depends(get_db)):
    """AI summary of the deterministically detected anomalies."""
    return svc.summarize_anomalies(
        db, ctx.organization_id, ctx.user.id, payload.statement_id, payload.months
    )


@router.post("/statements/classify", response_model=StatementClassifyResponse)
def classify_statement(payload: StatementClassifyRequest, ctx: OrgManager,
                       db: Session = Depends(get_db)):
    """Suggest a source category and column mapping for a statement export."""
    return svc.classify_statement(
        db, ctx.organization_id, ctx.user.id, payload.headers, payload.sample_rows,
        payload.filename,
    )


@router.post("/reports/summary", response_model=ReportSummaryResponse)
def report_summary(payload: ReportSummaryRequest, ctx: OrgManager,
                   db: Session = Depends(get_db)):
    """Figures computed from the database plus an AI executive narrative."""
    return svc.report_summary(
        db, ctx.organization_id, ctx.user.id, payload.report_type,
        payload.period_start, payload.period_end,
    )


# --------------------------------------------------------------------------- suggestions


@router.get("/suggestions", response_model=Page[AISuggestionResponse])
def list_suggestions(
    ctx: OrgViewer,
    db: Session = Depends(get_db),
    params: PageParams = Depends(),
    status_filter: Annotated[
        Literal["pending", "approved", "rejected", "applied"] | None, Query(alias="status")
    ] = None,
    kind: Annotated[str | None, Query(max_length=50)] = None,
    entity_type: Annotated[str | None, Query(max_length=50)] = None,
    entity_id: Annotated[str | None, Query(max_length=36)] = None,
):
    stmt = select(AISuggestion).where(AISuggestion.organization_id == ctx.organization_id)
    if status_filter:
        stmt = stmt.where(AISuggestion.status == status_filter)
    if kind:
        stmt = stmt.where(AISuggestion.kind == kind)
    if entity_type:
        stmt = stmt.where(AISuggestion.entity_type == entity_type)
    if entity_id:
        stmt = stmt.where(AISuggestion.entity_id == entity_id)
    rows, total = paginate(
        db, stmt, params,
        sortable={"created_at": AISuggestion.created_at, "status": AISuggestion.status},
        default_sort=AISuggestion.created_at.desc(),
    )
    return page_of(rows, total, params)


@router.post("/suggestions/{suggestion_id}/approve", response_model=SuggestionApplyResponse)
def approve_suggestion(suggestion_id: Annotated[str, Path(max_length=36)], ctx: OrgManager, request: Request,
                       db: Session = Depends(get_db)):
    """Apply a pending suggestion's whitelisted, re-validated changes."""
    return svc.approve_suggestion(db, ctx.organization_id, ctx.user.id, suggestion_id, request)


@router.post("/suggestions/{suggestion_id}/reject", response_model=AISuggestionResponse)
def reject_suggestion(suggestion_id: Annotated[str, Path(max_length=36)], ctx: OrgManager, request: Request,
                      payload: SuggestionReviewRequest | None = None,
                      db: Session = Depends(get_db)):
    return svc.reject_suggestion(
        db, ctx.organization_id, ctx.user.id, suggestion_id,
        payload.reason if payload else None, request,
    )


# --------------------------------------------------------------------------- deterministic


@router.get("/duplicates", response_model=DuplicateListResponse)
def duplicate_candidates(
    ctx: OrgViewer,
    entity_type: DuplicateEntityType,
    db: Session = Depends(get_db),
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
):
    """Deterministic duplicate candidates from the catalog module."""
    return {
        "entity_type": entity_type,
        "candidates": svc.list_duplicate_candidates(db, ctx.organization_id, entity_type, limit),
        "deterministic": True,
    }


@router.get("/anomalies", response_model=AnomalyReport)
def royalty_anomalies(
    ctx: OrgViewer,
    db: Session = Depends(get_db),
    statement_id: Annotated[str | None, Query(max_length=36)] = None,
    months: Annotated[int, Query(ge=1, le=60)] = 12,
):
    """Rule-based royalty anomaly detection (no AI)."""
    return detect_anomalies(db, ctx.organization_id, statement_id=statement_id, months=months)


@router.get("/completeness", response_model=CompletenessResponse)
def catalog_completeness(ctx: OrgViewer, db: Session = Depends(get_db)):
    """Deterministic metadata completeness scores for works, recordings and releases."""
    return svc.compute_completeness(db, ctx.organization_id)
