from decimal import Decimal

from sqlalchemy import select

from app.db.mixins import utc_now
from app.models.billing import AIUsageRecord, Plan, Subscription
from app.models.catalog import Work
from app.models.platform import AuditLog, StoredFile
from app.services import billing


def url(org_id: str, path: str = "") -> str:
    return f"/api/v1/organizations/{org_id}/billing{path}"


def test_plans_listing_marks_development_and_unpriced(client, api):
    user = api.user("plans@example.com")
    assert client.get("/api/v1/billing/plans").status_code == 401
    response = client.get("/api/v1/billing/plans", headers=user["headers"])
    assert response.status_code == 200
    plans = response.json()
    assert [p["code"] for p in plans] == [
        "dev-starter", "dev-professional", "dev-business", "dev-enterprise"
    ]
    for plan in plans:
        assert plan["is_development"] is True
        assert plan["monthly_price"] is None
        assert plan["price_configured"] is False
        assert plan["price_display"] == "Pricing not configured"
        assert "Development plan" in plan["notice"]
    assert plans[0]["limits"]["max_users"] == 3
    assert plans[3]["limits"]["max_users"] is None


def test_billing_overview_reports_usage_percentages(client, team, db):
    org_id = team["org_id"]
    for i in range(5):
        db.add(Work(organization_id=org_id, title=f"Song {i}"))
    db.add(Work(organization_id=org_id, title="Old", status="archived"))
    db.commit()

    response = client.get(url(org_id), headers=team["viewer"]["headers"])
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["subscription"]["plan"]["code"] == "dev-professional"
    assert data["subscription"]["provider"] == "manual"
    assert data["provider"] == "manual"
    assert data["provider_configured"] is False
    assert "nothing is charged" in data["notice"]
    usage = {u["key"]: u for u in data["usage"]}
    assert usage["max_users"]["used"] == 4
    assert usage["max_users"]["limit"] == 10
    assert usage["max_users"]["percentage"] == "40.00"
    assert usage["max_catalog_items"]["used"] == 5
    assert usage["max_catalog_items"]["percentage"] == "0.05"
    assert usage["max_ai_requests_per_month"]["used"] == 0
    assert usage["max_ai_requests_per_month"]["percentage"] == "0.00"
    assert all(u["exceeded"] is False for u in data["usage"])
    assert data["features"] == {"advanced_reporting": True, "ai_features": True}

    assert client.get(url(org_id), headers=team["outsider"]["headers"]).status_code == 404


def test_plan_change_is_owner_only_and_not_charged(client, team, db):
    org_id = team["org_id"]
    for role in ("viewer", "manager", "admin"):
        response = client.put(url(org_id, "/plan"), json={"plan_code": "dev-business"},
                              headers=team[role]["headers"])
        assert response.status_code == 403, role
    assert client.put(url(org_id, "/plan"), json={"plan_code": "dev-business"},
                      headers=team["outsider"]["headers"]).status_code == 404

    response = client.put(url(org_id, "/plan"), json={"plan_code": "dev-business"},
                          headers=team["owner"]["headers"])
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "changed"
    assert body["charged"] is False
    assert "nothing was charged" in body["message"]
    assert body["billing"]["subscription"]["plan"]["code"] == "dev-business"

    audit = db.scalar(select(AuditLog).where(AuditLog.action == "billing.plan_changed"))
    assert audit is not None and audit.organization_id == org_id
    assert audit.changes == {"plan": {"from": "dev-professional", "to": "dev-business"}}

    # Same plan again is a no-op.
    again = client.put(url(org_id, "/plan"), json={"plan_code": "dev-business"},
                       headers=team["owner"]["headers"]).json()
    assert again["status"] == "unchanged" and again["charged"] is False

    # Unknown or malformed plan codes.
    assert client.put(url(org_id, "/plan"), json={"plan_code": "gold"},
                      headers=team["owner"]["headers"]).status_code == 404
    assert client.put(url(org_id, "/plan"), json={"plan_code": "<script>"},
                      headers=team["owner"]["headers"]).status_code == 422


def test_downgrade_blocked_when_usage_exceeds_new_limits(client, team, db):
    org_id = team["org_id"]
    # Four active members, starter allows three.
    response = client.put(url(org_id, "/plan"), json={"plan_code": "dev-starter"},
                          headers=team["owner"]["headers"])
    assert response.status_code == 409, response.text
    error = response.json()["error"]
    assert error["code"] == "plan_limits_exceeded"
    exceeded = {e["limit"]: e for e in error["details"]["exceeded"]}
    assert set(exceeded) == {"max_users"}
    assert exceeded["max_users"] == {
        "limit": "max_users", "label": "team members", "allowed": 3, "current": 4
    }
    subscription = db.scalar(select(Subscription).where(Subscription.organization_id == org_id))
    plan = db.get(Plan, subscription.plan_id)
    assert plan.code == "dev-professional"


def test_downgrade_allowed_when_usage_fits(client, api):
    owner = api.user("solo@example.com")
    org = api.org(owner, slug="solo-label", name="Solo Label")
    response = client.put(url(org["id"], "/plan"), json={"plan_code": "dev-starter"},
                          headers=owner["headers"])
    assert response.status_code == 200, response.text
    assert response.json()["charged"] is False
    usage = {u["key"]: u for u in response.json()["billing"]["usage"]}
    assert usage["max_users"]["percentage"] == "33.33"


def test_checkout_unavailable_in_manual_mode(client, team):
    org_id = team["org_id"]
    response = client.post(url(org_id, "/checkout"), headers=team["owner"]["headers"])
    assert response.status_code == 503
    error = response.json()["error"]
    assert error["code"] == "billing_not_configured"
    assert "No billing provider is configured" in error["message"]
    assert client.post(url(org_id, "/checkout"), headers=team["admin"]["headers"]).status_code == 403


def test_configured_provider_returns_checkout_url_without_changing_plan(client, team, db, monkeypatch):
    calls = []

    class FakeStripe:
        name = "stripe"

        def create_checkout(self, subscription, plan, return_url):
            calls.append((subscription.organization_id, plan.code, return_url))
            return billing.CheckoutSession(url="https://checkout.example/session", provider="stripe")

    monkeypatch.setattr(billing, "get_billing_provider", lambda: FakeStripe())
    org_id = team["org_id"]
    response = client.put(url(org_id, "/plan"), json={"plan_code": "dev-business"},
                          headers=team["owner"]["headers"])
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "checkout_required"
    assert body["checkout_url"] == "https://checkout.example/session"
    assert body["charged"] is False
    assert calls[0][0] == org_id and calls[0][1] == "dev-business"
    assert calls[0][2].endswith("/settings/billing")
    subscription = db.scalar(select(Subscription).where(Subscription.organization_id == org_id))
    assert db.get(Plan, subscription.plan_id).code == "dev-professional"

    overview = client.get(url(org_id), headers=team["owner"]["headers"]).json()
    assert overview["provider_configured"] is True and overview["notice"] is None


def test_update_billing_email(client, team, db):
    org_id = team["org_id"]
    assert client.patch(url(org_id), json={"billing_email": "ap@acme-music.com"},
                        headers=team["admin"]["headers"]).status_code == 403
    response = client.patch(url(org_id), json={"billing_email": "AP@Acme-Music.com"},
                            headers=team["owner"]["headers"])
    assert response.status_code == 200, response.text
    assert response.json()["subscription"]["billing_email"] == "ap@acme-music.com"
    assert client.patch(url(org_id), json={"billing_email": "not-an-email"},
                        headers=team["owner"]["headers"]).status_code == 422
    assert db.scalar(select(AuditLog).where(AuditLog.action == "billing.updated")) is not None


def test_usage_history(client, team, db):
    org_id = team["org_id"]
    other_id = team["other_org"]["id"]
    now = utc_now()
    for feature, tin, tout, cost in [
        ("contract_analysis", 1000, 200, Decimal("0.012500")),
        ("contract_analysis", 500, 100, Decimal("0.006250")),
        ("matching", 300, 50, Decimal("0.001000")),
    ]:
        db.add(AIUsageRecord(organization_id=org_id, feature=feature, provider="anthropic",
                             model="m", status="success", input_tokens=tin, output_tokens=tout,
                             estimated_cost_usd=cost, created_at=now))
    db.add(AIUsageRecord(organization_id=other_id, feature="matching", provider="anthropic",
                         model="m", status="success", input_tokens=9999, output_tokens=9999,
                         estimated_cost_usd=Decimal("9"), created_at=now))
    db.add(StoredFile(organization_id=org_id, category="contract", storage_backend="local",
                      storage_key="k1", original_filename="a.pdf", content_type="application/pdf",
                      size_bytes=3 * 1024 * 1024 + 1, sha256="a" * 64))
    db.add(StoredFile(organization_id=org_id, category="statement", storage_backend="local",
                      storage_key="k2", original_filename="b.csv", content_type="text/csv",
                      size_bytes=1024, sha256="b" * 64, is_deleted=True))
    db.commit()

    assert client.get(url(org_id, "/usage"), headers=team["manager"]["headers"]).status_code == 403
    response = client.get(url(org_id, "/usage"), headers=team["admin"]["headers"])
    assert response.status_code == 200, response.text
    data = response.json()
    month = f"{now.year:04d}-{now.month:02d}"
    assert data["ai_usage"] == [
        {"month": month, "feature": "contract_analysis", "requests": 2, "input_tokens": 1500,
         "output_tokens": 300, "estimated_cost_usd": "0.018750"},
        {"month": month, "feature": "matching", "requests": 1, "input_tokens": 300,
         "output_tokens": 50, "estimated_cost_usd": "0.001000"},
    ]
    assert data["ai_totals"] == {"requests": 3, "input_tokens": 1800, "output_tokens": 350,
                                 "estimated_cost_usd": "0.019750"}
    assert data["statement_imports"] == []
    assert data["storage"]["files"] == 1
    assert data["storage"]["megabytes"] == 4
    assert data["storage"]["limit_mb"] == 10240
    assert data["storage"]["by_category"] == [
        {"category": "contract", "files": 1, "bytes": 3 * 1024 * 1024 + 1}
    ]
