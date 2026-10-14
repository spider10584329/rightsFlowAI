"""Dashboard and analytics. Every figure is computed from the organization's
own data (see ``app.services.analytics`` for definitions); no FX conversion."""

from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.permissions import OrgContext, OrgViewer
from app.db.session import get_db
from app.schemas.dashboard import (
    CatalogGrowth,
    DashboardSummary,
    OwnershipDistribution,
    RevenueBySource,
    RevenueByTerritory,
    RoyaltiesOverTime,
    TopRecordings,
    TopWorks,
)
from app.services import analytics

router = APIRouter(prefix="/organizations/{organization_id}/dashboard", tags=["Dashboard"])

Currency = Annotated[str | None, Query(pattern=r"^[A-Z]{3}$")]
PeriodStart = Annotated[date | None, Query()]
PeriodEnd = Annotated[date | None, Query()]
Limit = Annotated[int, Query(ge=1, le=100)]
Months = Annotated[int, Query(ge=1, le=60)]


def _currencies(ctx: OrgContext, currency: str | None) -> dict:
    primary = ctx.organization.default_currency
    return {"currency": currency or primary, "primary_currency": primary}


@router.get("/summary", response_model=DashboardSummary)
def dashboard_summary(ctx: OrgViewer, db: Session = Depends(get_db)):
    return analytics.summary(db, ctx.organization_id, ctx.organization.default_currency)


@router.get("/royalties-over-time", response_model=RoyaltiesOverTime)
def royalties_over_time(
    ctx: OrgViewer, db: Session = Depends(get_db), months: Months = 12, currency: Currency = None
):
    """Reported royalties per month of ``statement.period_end``; months without
    data are zero."""
    return analytics.royalties_over_time(
        db, ctx.organization_id, months=months, **_currencies(ctx, currency)
    )


@router.get("/revenue-by-source", response_model=RevenueBySource)
def revenue_by_source(
    ctx: OrgViewer,
    db: Session = Depends(get_db),
    currency: Currency = None,
    period_start: PeriodStart = None,
    period_end: PeriodEnd = None,
):
    return analytics.revenue_by_source(
        db, ctx.organization_id, period_start=period_start, period_end=period_end,
        **_currencies(ctx, currency),
    )


@router.get("/revenue-by-territory", response_model=RevenueByTerritory)
def revenue_by_territory(
    ctx: OrgViewer,
    db: Session = Depends(get_db),
    currency: Currency = None,
    period_start: PeriodStart = None,
    period_end: PeriodEnd = None,
):
    return analytics.revenue_by_territory(
        db, ctx.organization_id, period_start=period_start, period_end=period_end,
        **_currencies(ctx, currency),
    )


@router.get("/top-works", response_model=TopWorks)
def top_works(
    ctx: OrgViewer,
    db: Session = Depends(get_db),
    limit: Limit = 10,
    currency: Currency = None,
    period_start: PeriodStart = None,
    period_end: PeriodEnd = None,
):
    return analytics.top_works(
        db, ctx.organization_id, limit=limit, period_start=period_start,
        period_end=period_end, **_currencies(ctx, currency),
    )


@router.get("/top-recordings", response_model=TopRecordings)
def top_recordings(
    ctx: OrgViewer,
    db: Session = Depends(get_db),
    limit: Limit = 10,
    currency: Currency = None,
    period_start: PeriodStart = None,
    period_end: PeriodEnd = None,
):
    return analytics.top_recordings(
        db, ctx.organization_id, limit=limit, period_start=period_start,
        period_end=period_end, **_currencies(ctx, currency),
    )


@router.get("/ownership-distribution", response_model=OwnershipDistribution)
def ownership_distribution(ctx: OrgViewer, db: Session = Depends(get_db), limit: Limit = 10):
    return analytics.ownership_distribution(db, ctx.organization_id, limit=limit)


@router.get("/catalog-growth", response_model=CatalogGrowth)
def catalog_growth(ctx: OrgViewer, db: Session = Depends(get_db), months: Months = 12):
    return analytics.catalog_growth(db, ctx.organization_id, months)
