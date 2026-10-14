"""Subscription plans, plan changes and usage.

No money moves in ``manual`` mode: plan changes are recorded internally and
every response says ``charged: false``. A checkout session is only created
when ``BILLING_PROVIDER=stripe`` and its keys are explicitly configured, and
even then the charge happens at the provider after the customer confirms.
"""

from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import extract, func, select
from sqlalchemy.orm import Session

from app.core.dependencies import get_current_user
from app.core.errors import ConflictError, NotFoundError
from app.core.permissions import OrgAdmin, OrgOwner, OrgViewer
from app.db.mixins import utc_now
from app.db.session import get_db
from app.models.billing import AIUsageRecord, Plan, Subscription
from app.models.platform import StoredFile
from app.models.royalty import RoyaltyStatement
from app.models.user import User
from app.schemas.billing import (
    DEVELOPMENT_PLAN_NOTICE,
    MANUAL_BILLING_NOTICE,
    BillingOverview,
    BillingUpdate,
    CheckoutRequest,
    CheckoutResponse,
    PlanChangeRequest,
    PlanChangeResponse,
    PlanResponse,
    UsageHistoryResponse,
)
from app.services import billing
from app.services.audit import diff, record_audit, snapshot
from app.services.email import frontend_link
from app.services.notifications import notify_org

router = APIRouter(prefix="/organizations/{organization_id}/billing", tags=["Billing"])
plans_router = APIRouter(prefix="/billing", tags=["Billing"])

LIMIT_KEYS = list(billing.LIMIT_LABELS)
BILLING_RETURN_PATH = "/settings/billing"


# --------------------------------------------------------------------------- helpers


def _plan_payload(plan: Plan) -> dict:
    return {
        "id": plan.id,
        "code": plan.code,
        "name": plan.name,
        "description": plan.description,
        "is_development": plan.is_development,
        "is_public": plan.is_public,
        "sort_order": plan.sort_order,
        "monthly_price": plan.monthly_price,
        "currency": plan.currency,
        "price_display": billing.plan_price_display(plan),
        "price_configured": plan.monthly_price is not None,
        "limits": dict(plan.limits or {}),
        "notice": DEVELOPMENT_PLAN_NOTICE if plan.is_development else None,
    }


def _percentage(used: int, limit: int) -> Decimal:
    if limit <= 0:
        return Decimal("100.00") if used > 0 else Decimal("0.00")
    return (Decimal(used) * 100 / Decimal(limit)).quantize(Decimal("0.01"), ROUND_HALF_UP)


def _usage_items(plan: Plan, usage: dict[str, int]) -> list[dict]:
    items = []
    for key in LIMIT_KEYS:
        raw_limit = (plan.limits or {}).get(key)
        limit = None if raw_limit is None else int(raw_limit)
        used = int(usage.get(key, 0))
        items.append(
            {
                "key": key,
                "label": billing.LIMIT_LABELS[key],
                "used": used,
                "limit": limit,
                "unlimited": limit is None,
                "percentage": None if limit is None else _percentage(used, limit),
                "exceeded": limit is not None and used > limit,
            }
        )
    return items


def _provider_configured(provider: billing.BillingProvider) -> bool:
    return provider.name != "manual"


def _overview(db: Session, organization_id: str) -> dict:
    subscription = billing.get_subscription(db, organization_id)
    plan = db.get(Plan, subscription.plan_id)
    assert plan is not None
    provider = billing.get_billing_provider()
    configured = _provider_configured(provider)
    return {
        "subscription": {
            "id": subscription.id,
            "plan": _plan_payload(plan),
            "status": subscription.status,
            "provider": subscription.provider,
            "current_period_start": subscription.current_period_start,
            "current_period_end": subscription.current_period_end,
            "cancel_at_period_end": subscription.cancel_at_period_end,
            "billing_email": subscription.billing_email,
        },
        "usage": _usage_items(plan, billing.measure_usage(db, organization_id)),
        "features": {k: v for k, v in (plan.limits or {}).items() if isinstance(v, bool)},
        "provider": provider.name,
        "provider_configured": configured,
        "notice": None if configured else MANUAL_BILLING_NOTICE,
    }


def _public_plan(db: Session, code: str) -> Plan:
    plan = db.scalar(select(Plan).where(Plan.code == code, Plan.is_public.is_(True)))
    if plan is None:
        raise NotFoundError("Plan not found")
    return plan


def _exceeded_limits(plan: Plan, usage: dict[str, int]) -> list[dict]:
    exceeded = []
    for key in LIMIT_KEYS:
        limit = (plan.limits or {}).get(key)
        if limit is not None and usage.get(key, 0) > int(limit):
            exceeded.append(
                {
                    "limit": key,
                    "label": billing.LIMIT_LABELS[key],
                    "allowed": int(limit),
                    "current": usage.get(key, 0),
                }
            )
    return exceeded


def _ensure_usage_fits(db: Session, organization_id: str, plan: Plan) -> None:
    exceeded = _exceeded_limits(plan, billing.measure_usage(db, organization_id))
    if exceeded:
        described = ", ".join(
            f"{e['current']} {e['label']} (allowed {e['allowed']})" for e in exceeded
        )
        raise ConflictError(
            f"Current usage exceeds the {plan.name} plan limits: {described}. "
            "Reduce usage before changing to this plan.",
            code="plan_limits_exceeded",
            details={"plan_code": plan.code, "exceeded": exceeded},
        )


def _checkout(subscription: Subscription, plan: Plan) -> billing.CheckoutSession:
    provider = billing.get_billing_provider()
    return provider.create_checkout(subscription, plan, frontend_link(BILLING_RETURN_PATH))


# --------------------------------------------------------------------------- plans


@plans_router.get("/plans", response_model=list[PlanResponse])
def list_plans(
    current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    """Public plans ordered by ``sort_order``. Development plans are marked
    and have no price until commercial pricing is configured."""
    plans = db.scalars(
        select(Plan).where(Plan.is_public.is_(True)).order_by(Plan.sort_order, Plan.code)
    ).all()
    if not plans:
        billing.ensure_plans(db)
        plans = db.scalars(
            select(Plan).where(Plan.is_public.is_(True)).order_by(Plan.sort_order, Plan.code)
        ).all()
    return [_plan_payload(p) for p in plans]


# --------------------------------------------------------------------------- organization billing


@router.get("", response_model=BillingOverview)
def get_billing(ctx: OrgViewer, db: Session = Depends(get_db)):
    """Subscription, usage against plan limits and feature flags."""
    data = _overview(db, ctx.organization_id)
    db.commit()  # persists a default subscription for organizations that predate billing
    return data


@router.patch("", response_model=BillingOverview)
def update_billing(
    payload: BillingUpdate, ctx: OrgOwner, request: Request, db: Session = Depends(get_db)
):
    subscription = billing.get_subscription(db, ctx.organization_id)
    before = snapshot(subscription, ["billing_email"])
    if "billing_email" in payload.model_fields_set:
        subscription.billing_email = (
            str(payload.billing_email).lower() if payload.billing_email else None
        )
    changes = diff(before, snapshot(subscription, ["billing_email"]))
    if changes:
        record_audit(
            db,
            action="billing.updated",
            actor_user_id=ctx.user.id,
            organization_id=ctx.organization_id,
            entity_type="subscription",
            entity_id=subscription.id,
            changes=changes,
            summary="Updated billing details",
            request=request,
        )
    db.commit()
    return _overview(db, ctx.organization_id)


@router.put("/plan", response_model=PlanChangeResponse)
def change_plan(
    payload: PlanChangeRequest, ctx: OrgOwner, request: Request, db: Session = Depends(get_db)
):
    """Change the subscription plan (owner only).

    Manual provider: applied immediately once current usage fits the new
    limits; nothing is charged. Configured payment provider: returns a
    checkout URL; the plan changes when the provider confirms payment."""
    subscription = billing.get_subscription(db, ctx.organization_id)
    current = db.get(Plan, subscription.plan_id)
    target = _public_plan(db, payload.plan_code)
    provider = billing.get_billing_provider()

    if current is not None and current.id == target.id:
        db.commit()
        return {
            "status": "unchanged",
            "charged": False,
            "provider": provider.name,
            "message": f"The organization is already on the {target.name} plan.",
            "billing": _overview(db, ctx.organization_id),
        }

    _ensure_usage_fits(db, ctx.organization_id, target)

    if _provider_configured(provider):
        session = _checkout(subscription, target)
        record_audit(
            db,
            action="billing.checkout_started",
            actor_user_id=ctx.user.id,
            organization_id=ctx.organization_id,
            entity_type="subscription",
            entity_id=subscription.id,
            summary=f"Started {session.provider} checkout for {target.code}",
            request=request,
        )
        db.commit()
        return {
            "status": "checkout_required",
            "charged": False,
            "provider": session.provider,
            "checkout_url": session.url,
            "message": (
                "Complete checkout with the payment provider to change the plan. "
                "Nothing has been charged yet."
            ),
        }

    subscription.plan_id = target.id
    record_audit(
        db,
        action="billing.plan_changed",
        actor_user_id=ctx.user.id,
        organization_id=ctx.organization_id,
        entity_type="subscription",
        entity_id=subscription.id,
        changes={"plan": {"from": current.code if current else None, "to": target.code}},
        summary=f"Changed plan to {target.name} (manual, not charged)",
        request=request,
    )
    notify_org(
        db,
        organization_id=ctx.organization_id,
        type="billing.plan_changed",
        title=f"Plan changed to {target.name}",
        body="The plan was changed manually. No payment was taken.",
        link=BILLING_RETURN_PATH,
        minimum_role="admin",
        exclude_user_ids=[ctx.user.id],
    )
    db.commit()
    return {
        "status": "changed",
        "charged": False,
        "provider": provider.name,
        "message": (
            f"Plan changed to {target.name}. No payment provider is configured, "
            "so nothing was charged."
        ),
        "billing": _overview(db, ctx.organization_id),
    }


@router.post("/checkout", response_model=CheckoutResponse)
def create_checkout(
    ctx: OrgOwner,
    request: Request,
    db: Session = Depends(get_db),
    payload: CheckoutRequest | None = None,
):
    """Start a payment-provider checkout. Returns ``503 billing_not_configured``
    when no provider is configured."""
    subscription = billing.get_subscription(db, ctx.organization_id)
    if payload and payload.plan_code:
        plan = _public_plan(db, payload.plan_code)
        _ensure_usage_fits(db, ctx.organization_id, plan)
    else:
        plan = db.get(Plan, subscription.plan_id)
        assert plan is not None
    session = _checkout(subscription, plan)
    record_audit(
        db,
        action="billing.checkout_started",
        actor_user_id=ctx.user.id,
        organization_id=ctx.organization_id,
        entity_type="subscription",
        entity_id=subscription.id,
        summary=f"Started {session.provider} checkout for {plan.code}",
        request=request,
    )
    db.commit()
    return {
        "provider": session.provider,
        "checkout_url": session.url,
        "charged": False,
        "message": "Complete checkout with the payment provider. Nothing has been charged yet.",
    }


def _month_key(year: int, month: int) -> str:
    return f"{int(year):04d}-{int(month):02d}"


def _months_ago_start(months: int) -> datetime:
    now = utc_now()
    year, month = now.year, now.month - (months - 1)
    while month <= 0:
        month += 12
        year -= 1
    return datetime(year, month, 1)


@router.get("/usage", response_model=UsageHistoryResponse)
def usage_history(
    ctx: OrgAdmin,
    db: Session = Depends(get_db),
    months: Annotated[int, Query(ge=1, le=36)] = 12,
):
    """AI usage (tokens, estimated cost) by month and feature, statement
    imports by month, and current storage."""
    org_id = ctx.organization_id
    since = _months_ago_start(months)

    ai_year = extract("year", AIUsageRecord.created_at)
    ai_month = extract("month", AIUsageRecord.created_at)
    ai_rows = db.execute(
        select(
            ai_year,
            ai_month,
            AIUsageRecord.feature,
            func.count(),
            func.coalesce(func.sum(AIUsageRecord.input_tokens), 0),
            func.coalesce(func.sum(AIUsageRecord.output_tokens), 0),
            func.coalesce(func.sum(AIUsageRecord.estimated_cost_usd), 0),
        )
        .where(AIUsageRecord.organization_id == org_id, AIUsageRecord.created_at >= since)
        .group_by(ai_year, ai_month, AIUsageRecord.feature)
        .order_by(ai_year, ai_month, AIUsageRecord.feature)
    ).all()
    ai_usage = [
        {
            "month": _month_key(y, m),
            "feature": feature,
            "requests": int(count),
            "input_tokens": int(tin),
            "output_tokens": int(tout),
            "estimated_cost_usd": Decimal(cost),
        }
        for y, m, feature, count, tin, tout, cost in ai_rows
    ]
    ai_totals = {
        "requests": sum(r["requests"] for r in ai_usage),
        "input_tokens": sum(r["input_tokens"] for r in ai_usage),
        "output_tokens": sum(r["output_tokens"] for r in ai_usage),
        "estimated_cost_usd": sum((r["estimated_cost_usd"] for r in ai_usage), Decimal("0")),
    }

    st_year = extract("year", RoyaltyStatement.created_at)
    st_month = extract("month", RoyaltyStatement.created_at)
    import_rows = db.execute(
        select(st_year, st_month, func.count())
        .where(RoyaltyStatement.organization_id == org_id, RoyaltyStatement.created_at >= since)
        .group_by(st_year, st_month)
        .order_by(st_year, st_month)
    ).all()

    storage_rows = db.execute(
        select(StoredFile.category, func.count(), func.coalesce(func.sum(StoredFile.size_bytes), 0))
        .where(StoredFile.organization_id == org_id, StoredFile.is_deleted.is_(False))
        .group_by(StoredFile.category)
        .order_by(StoredFile.category)
    ).all()
    by_category = [
        {"category": c, "files": int(n), "bytes": int(b)} for c, n, b in storage_rows
    ]
    total_bytes = sum(c["bytes"] for c in by_category)
    plan = billing.get_plan_for_org(db, org_id)
    limit_mb = (plan.limits or {}).get("max_storage_mb")
    db.commit()
    return {
        "months": months,
        "since": since,
        "ai_usage": ai_usage,
        "ai_totals": ai_totals,
        "statement_imports": [
            {"month": _month_key(y, m), "statements": int(n)} for y, m, n in import_rows
        ],
        "storage": {
            "files": sum(c["files"] for c in by_category),
            "bytes": total_bytes,
            "megabytes": -(-total_bytes // (1024 * 1024)),
            "limit_mb": None if limit_mb is None else int(limit_mb),
            "by_category": by_category,
        },
    }


