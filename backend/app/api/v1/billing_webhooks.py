"""Stripe webhook receiver. Disabled (404) unless BILLING_PROVIDER=stripe and
STRIPE_WEBHOOK_SECRET are configured. Signatures are verified with the
Stripe-Signature scheme (HMAC-SHA256 over ``{timestamp}.{payload}``)."""

import hashlib
import hmac
import json
import time

from fastapi import APIRouter, Depends, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import AuthenticationError, NotFoundError
from app.core.logging import get_logger
from app.db.mixins import utc_now
from app.db.session import get_db
from app.models.billing import Plan, Subscription
from app.models.organization import Organization
from app.services import billing
from app.services.audit import record_audit

logger = get_logger(__name__)
router = APIRouter(prefix="/billing/webhooks", tags=["Billing"])
TOLERANCE_SECONDS = 300


def verify_stripe_signature(payload: bytes, header: str, secret: str, now: float | None = None) -> None:
    parts: dict[str, list[str]] = {}
    for item in header.split(","):
        key, _, value = item.strip().partition("=")
        parts.setdefault(key, []).append(value)
    try:
        timestamp = int(parts["t"][0])
    except (KeyError, ValueError) as exc:
        raise AuthenticationError("Invalid webhook signature") from exc
    if abs((now or time.time()) - timestamp) > TOLERANCE_SECONDS:
        raise AuthenticationError("Webhook timestamp outside tolerance")
    expected = hmac.new(secret.encode(), f"{timestamp}.".encode() + payload, hashlib.sha256).hexdigest()
    if not any(hmac.compare_digest(expected, sig) for sig in parts.get("v1", [])):
        raise AuthenticationError("Invalid webhook signature")


@router.post("/stripe")
async def stripe_webhook(request: Request, db: Session = Depends(get_db)):
    if settings.billing_provider != "stripe" or not settings.stripe_webhook_secret:
        raise NotFoundError("Not found")
    payload = await request.body()
    verify_stripe_signature(payload, request.headers.get("stripe-signature", ""),
                            settings.stripe_webhook_secret)
    event = json.loads(payload)
    if event.get("type") != "checkout.session.completed":
        return {"received": True, "handled": False}
    session = event.get("data", {}).get("object", {})
    org_id = session.get("client_reference_id")
    plan_code = (session.get("metadata") or {}).get("plan_code")
    org = db.get(Organization, org_id) if org_id else None
    plan = db.scalar(select(Plan).where(Plan.code == plan_code)) if plan_code else None
    if org is None or plan is None:
        logger.warning("Stripe webhook referenced unknown org/plan")
        return {"received": True, "handled": False}
    subscription: Subscription = billing.get_subscription(db, org.id)
    previous = subscription.plan_id
    subscription.plan_id = plan.id
    subscription.provider = "stripe"
    subscription.status = "active"
    subscription.provider_customer_id = session.get("customer") or subscription.provider_customer_id
    subscription.provider_subscription_id = session.get("subscription") or subscription.provider_subscription_id
    subscription.current_period_start = utc_now()
    record_audit(db, action="billing.plan_changed", organization_id=org.id, entity_type="subscription",
                 entity_id=subscription.id, summary=f"Plan changed to {plan.name} via Stripe checkout",
                 changes={"plan_id": {"from": previous, "to": plan.id}})
    db.commit()
    return {"received": True, "handled": True}
