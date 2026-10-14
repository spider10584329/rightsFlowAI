import hashlib
import hmac
import json
import time

import pytest
from sqlalchemy import select

from app.api.v1.billing_webhooks import verify_stripe_signature
from app.core.config import settings
from app.core.errors import AuthenticationError
from app.models.billing import Plan, Subscription


def sign(payload: bytes, secret: str, ts: int | None = None) -> str:
    ts = ts or int(time.time())
    sig = hmac.new(secret.encode(), f"{ts}.".encode() + payload, hashlib.sha256).hexdigest()
    return f"t={ts},v1={sig}"


def test_signature_verification():
    payload = b'{"a":1}'
    verify_stripe_signature(payload, sign(payload, "whsec_x"), "whsec_x")
    with pytest.raises(AuthenticationError):
        verify_stripe_signature(payload, sign(payload, "other"), "whsec_x")
    with pytest.raises(AuthenticationError):
        verify_stripe_signature(payload, sign(payload, "whsec_x", ts=int(time.time()) - 3600), "whsec_x")
    with pytest.raises(AuthenticationError):
        verify_stripe_signature(payload, "garbage", "whsec_x")


def test_webhook_disabled_without_stripe(client):
    assert client.post("/api/v1/billing/webhooks/stripe", content=b"{}").status_code == 404


def test_checkout_completed_applies_plan(client, team, db, monkeypatch):
    monkeypatch.setattr(settings, "billing_provider", "stripe")
    monkeypatch.setattr(settings, "stripe_webhook_secret", "whsec_test")
    event = {"type": "checkout.session.completed", "data": {"object": {
        "client_reference_id": team["org_id"], "metadata": {"plan_code": "dev-business"},
        "customer": "cus_1", "subscription": "sub_1"}}}
    payload = json.dumps(event).encode()
    bad = client.post("/api/v1/billing/webhooks/stripe", content=payload,
                      headers={"stripe-signature": sign(payload, "wrong")})
    assert bad.status_code == 401
    ok = client.post("/api/v1/billing/webhooks/stripe", content=payload,
                     headers={"stripe-signature": sign(payload, "whsec_test")})
    assert ok.json() == {"received": True, "handled": True}
    sub = db.scalar(select(Subscription).where(Subscription.organization_id == team["org_id"]))
    plan = db.get(Plan, sub.plan_id)
    assert plan.code == "dev-business" and sub.provider_subscription_id == "sub_1"
