"""Subscription plans, entitlements, usage measurement and limit enforcement.

Plans below are DEVELOPMENT plans: limits are sensible defaults and prices
are intentionally unset until commercial pricing is approved. No payment
provider is contacted unless BILLING_PROVIDER=stripe and keys are configured.
"""

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any, Protocol

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import LimitExceededError, NotFoundError, ServiceUnavailableError
from app.db.mixins import utc_now
from app.models.billing import AIUsageRecord, Plan, Subscription
from app.models.catalog import Recording, Release, Work
from app.models.invitation import OrganizationInvitation
from app.models.organization_membership import OrganizationMembership
from app.models.platform import StoredFile
from app.models.royalty import RoyaltyStatement

DEFAULT_PLAN_CODE = "dev-professional"

PLAN_CATALOG: list[dict[str, Any]] = [
    {
        "code": "dev-starter",
        "name": "Starter (Development)",
        "description": "Small catalogs and solo administrators.",
        "sort_order": 1,
        "limits": {
            "max_users": 3,
            "max_catalog_items": 500,
            "max_statement_imports_per_month": 5,
            "max_ai_requests_per_month": 50,
            "max_storage_mb": 1024,
            "advanced_reporting": False,
            "ai_features": True,
        },
    },
    {
        "code": "dev-professional",
        "name": "Professional (Development)",
        "description": "Independent publishers and labels.",
        "sort_order": 2,
        "limits": {
            "max_users": 10,
            "max_catalog_items": 10000,
            "max_statement_imports_per_month": 50,
            "max_ai_requests_per_month": 500,
            "max_storage_mb": 10240,
            "advanced_reporting": True,
            "ai_features": True,
        },
    },
    {
        "code": "dev-business",
        "name": "Business (Development)",
        "description": "Growing rights teams with multiple administrators.",
        "sort_order": 3,
        "limits": {
            "max_users": 50,
            "max_catalog_items": 100000,
            "max_statement_imports_per_month": 500,
            "max_ai_requests_per_month": 5000,
            "max_storage_mb": 102400,
            "advanced_reporting": True,
            "ai_features": True,
        },
    },
    {
        "code": "dev-enterprise",
        "name": "Enterprise (Development)",
        "description": "Custom limits for large catalogs.",
        "sort_order": 4,
        "limits": {
            "max_users": None,
            "max_catalog_items": None,
            "max_statement_imports_per_month": None,
            "max_ai_requests_per_month": None,
            "max_storage_mb": None,
            "advanced_reporting": True,
            "ai_features": True,
        },
    },
]

LIMIT_LABELS = {
    "max_users": "team members",
    "max_catalog_items": "catalog items",
    "max_statement_imports_per_month": "statement imports this month",
    "max_ai_requests_per_month": "AI requests this month",
    "max_storage_mb": "MB of storage",
}


def ensure_plans(db: Session) -> None:
    """Idempotently create the development plans."""
    existing = {p.code: p for p in db.scalars(select(Plan)).all()}
    for spec in PLAN_CATALOG:
        plan = existing.get(spec["code"])
        if plan is None:
            db.add(Plan(is_development=True, is_public=True, currency="USD", **spec))
    db.commit()


def get_plan_by_code(db: Session, code: str) -> Plan:
    plan = db.scalar(select(Plan).where(Plan.code == code))
    if plan is None:
        ensure_plans(db)
        plan = db.scalar(select(Plan).where(Plan.code == code))
    if plan is None:
        raise NotFoundError("Plan not found")
    return plan


def get_subscription(db: Session, organization_id: str) -> Subscription:
    """Return the organization's subscription, creating the default
    development subscription for organizations that predate billing."""
    subscription = db.scalar(
        select(Subscription).where(Subscription.organization_id == organization_id)
    )
    if subscription is None:
        plan = get_plan_by_code(db, DEFAULT_PLAN_CODE)
        subscription = Subscription(
            organization_id=organization_id,
            plan_id=plan.id,
            status="active",
            provider="manual",
        )
        try:
            # Savepoint: a concurrent request may create it first; losing that
            # race must not abort the caller's transaction (audit D-09).
            with db.begin_nested():
                db.add(subscription)
        except IntegrityError:
            subscription = db.scalar(
                select(Subscription).where(Subscription.organization_id == organization_id)
            )
            if subscription is None:
                raise
    return subscription


def get_plan_for_org(db: Session, organization_id: str) -> Plan:
    subscription = get_subscription(db, organization_id)
    plan = db.get(Plan, subscription.plan_id)
    assert plan is not None
    return plan


def _month_start() -> datetime:
    now = utc_now()
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def measure_usage(db: Session, organization_id: str) -> dict[str, int]:
    members = db.scalar(
        select(func.count()).select_from(OrganizationMembership).where(
            OrganizationMembership.organization_id == organization_id,
            OrganizationMembership.is_active.is_(True),
        )
    ) or 0
    pending_invites = db.scalar(
        select(func.count()).select_from(OrganizationInvitation).where(
            OrganizationInvitation.organization_id == organization_id,
            OrganizationInvitation.status == "pending",
            OrganizationInvitation.expires_at > utc_now(),
        )
    ) or 0
    catalog = 0
    for model in (Work, Recording, Release):
        catalog += db.scalar(
            select(func.count()).select_from(model).where(
                model.organization_id == organization_id, model.status != "archived"
            )
        ) or 0
    imports = db.scalar(
        select(func.count()).select_from(RoyaltyStatement).where(
            RoyaltyStatement.organization_id == organization_id,
            RoyaltyStatement.created_at >= _month_start(),
        )
    ) or 0
    ai_requests = db.scalar(
        select(func.count()).select_from(AIUsageRecord).where(
            AIUsageRecord.organization_id == organization_id,
            AIUsageRecord.created_at >= _month_start(),
        )
    ) or 0
    storage_bytes = db.scalar(
        select(func.coalesce(func.sum(StoredFile.size_bytes), 0)).where(
            StoredFile.organization_id == organization_id, StoredFile.is_deleted.is_(False)
        )
    ) or 0
    return {
        "max_users": int(members) + int(pending_invites),
        "max_catalog_items": int(catalog),
        "max_statement_imports_per_month": int(imports),
        "max_ai_requests_per_month": int(ai_requests),
        "max_storage_mb": int(-(-int(storage_bytes) // (1024 * 1024))),
    }


def check_limit(db: Session, organization_id: str, limit_key: str, increment: int = 1) -> None:
    """Raise ``LimitExceededError`` when adding ``increment`` would exceed
    the plan limit. ``None`` limits are unlimited."""
    plan = get_plan_for_org(db, organization_id)
    limit = plan.limits.get(limit_key)
    if limit is None:
        return
    usage = measure_usage(db, organization_id)[limit_key]
    if usage + increment > int(limit):
        raise LimitExceededError(
            f"Your {plan.name} plan allows {limit} {LIMIT_LABELS.get(limit_key, limit_key)}. "
            "Upgrade the plan or free up capacity to continue.",
            details={"limit": limit_key, "allowed": limit, "current": usage},
        )


def has_feature(db: Session, organization_id: str, feature: str) -> bool:
    return bool(get_plan_for_org(db, organization_id).limits.get(feature, False))


def require_feature(db: Session, organization_id: str, feature: str) -> None:
    if not has_feature(db, organization_id, feature):
        raise LimitExceededError(
            "This feature is not included in your current plan.",
            code="feature_not_available",
            details={"feature": feature},
        )


# --------------------------------------------------------------------------- providers


@dataclass
class CheckoutSession:
    url: str
    provider: str


class BillingProvider(Protocol):
    name: str

    def create_checkout(self, subscription: Subscription, plan: Plan, return_url: str) -> CheckoutSession: ...


class ManualBillingProvider:
    """Plan changes are recorded internally; nothing is charged."""

    name = "manual"

    def create_checkout(self, subscription: Subscription, plan: Plan, return_url: str) -> CheckoutSession:
        raise ServiceUnavailableError(
            "No billing provider is configured. Plans are changed manually by an owner.",
            code="billing_not_configured",
        )


class StripeBillingProvider:
    """Stripe Checkout adapter. Only used when BILLING_PROVIDER=stripe and
    STRIPE_SECRET_KEY are set, and only for plans with a provider_price_id."""

    name = "stripe"

    def create_checkout(self, subscription: Subscription, plan: Plan, return_url: str) -> CheckoutSession:
        import httpx

        if not settings.stripe_secret_key:
            raise ServiceUnavailableError("Stripe is not configured", code="billing_not_configured")
        if not plan.provider_price_id:
            raise ServiceUnavailableError(
                "This plan has no Stripe price configured", code="billing_not_configured"
            )
        response = httpx.post(
            "https://api.stripe.com/v1/checkout/sessions",
            auth=(settings.stripe_secret_key, ""),
            data={
                "mode": "subscription",
                "line_items[0][price]": plan.provider_price_id,
                "line_items[0][quantity]": "1",
                "success_url": return_url + "?billing=success",
                "cancel_url": return_url + "?billing=cancelled",
                "client_reference_id": subscription.organization_id,
                "metadata[plan_code]": plan.code,
                "subscription_data[metadata][organization_id]": subscription.organization_id,
            },
            timeout=20,
        )
        if response.status_code >= 400:
            raise ServiceUnavailableError("Stripe rejected the checkout request")
        return CheckoutSession(url=response.json()["url"], provider="stripe")


def get_billing_provider() -> BillingProvider:
    if settings.billing_provider == "stripe" and settings.stripe_secret_key:
        return StripeBillingProvider()
    return ManualBillingProvider()


def plan_price_display(plan: Plan) -> str:
    if plan.monthly_price is None:
        return "Pricing not configured"
    return f"{plan.currency} {plan.monthly_price.quantize(Decimal('0.01'))}/month"
