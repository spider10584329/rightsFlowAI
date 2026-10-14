"""Regression tests for issues found in the pre-launch audit (docs/FINAL_AUDIT_REPORT.md)."""

import re

from sqlalchemy import select

from app.models.platform import EmailMessage
from app.models.user import User
from app.core.config import settings
from tests.conftest import DEFAULT_PASSWORD, email_token


def _verify_email(client, db, email):
    token = email_token(db, email, "email_verification")
    assert client.post("/api/v1/auth/email/verify", json={"token": token}).status_code == 200


# --------------------------------------------------------------------------- A-01


def test_unverified_squatter_cannot_take_an_invitation_by_id(api, client, team, db):
    """A-01: registering an invitee's email must not grant access to the invite
    unless mailbox ownership is proven (verified email or the emailed token)."""
    org = f"/api/v1/organizations/{team['org_id']}"
    invite = client.post(f"{org}/invitations", json={"email": "newhire@victim.example", "role": "admin"},
                         headers=team["owner"]["headers"]).json()

    squatter = api.user("newhire@victim.example", "Squatter")
    mine = client.get("/api/v1/invitations/mine", headers=squatter["headers"])
    assert mine.status_code == 403 and mine.json()["error"]["code"] == "email_verification_required"
    for action in ("accept", "decline"):
        r = client.post(f"/api/v1/invitations/{invite['id']}/{action}", headers=squatter["headers"])
        assert r.status_code == 403, (action, r.text)
    assert client.get(org, headers=squatter["headers"]).status_code == 404
    db.expire_all()
    assert db.scalar(select(User.email_verified_at).where(User.email == "newhire@victim.example")) is None

    # Proving mailbox ownership unlocks the id-based flow.
    _verify_email(client, db, "newhire@victim.example")
    assert len(client.get("/api/v1/invitations/mine", headers=squatter["headers"]).json()) == 1
    assert client.post(f"/api/v1/invitations/{invite['id']}/accept", headers=squatter["headers"]).status_code == 200


def test_invitation_token_proves_mailbox_and_verifies_email(api, client, team, db):
    org = f"/api/v1/organizations/{team['org_id']}"
    invite = client.post(f"{org}/invitations", json={"email": "tokenholder@example.com", "role": "viewer"},
                         headers=team["owner"]["headers"]).json()
    token = re.search(r"token=([\w\-]+)", invite["invite_url"]).group(1)
    user = api.user("tokenholder@example.com")
    assert client.post("/api/v1/invitations/accept", json={"token": token}, headers=user["headers"]).status_code == 200
    db.expire_all()
    assert db.scalar(select(User.email_verified_at).where(User.email == "tokenholder@example.com")) is not None


# --------------------------------------------------------------------------- A-07 / A-08 rate limits


def test_attacker_cannot_lock_victim_out_of_login(api, client, monkeypatch):
    """A-08: failed logins from one IP must not block the account owner
    logging in from elsewhere."""
    monkeypatch.setattr(settings, "trusted_proxy_count", 1)
    api.register("victim@example.com")
    attacker = {"X-Forwarded-For": "198.51.100.1"}
    codes = [
        client.post("/api/v1/auth/login", json={"email": "victim@example.com", "password": "wrong"},
                    headers=attacker).status_code
        for _ in range(settings.auth_rate_limit_attempts + 1)
    ]
    assert codes[-1] == 429
    ok = client.post("/api/v1/auth/login", json={"email": "victim@example.com", "password": DEFAULT_PASSWORD},
                     headers={"X-Forwarded-For": "203.0.113.5"})
    assert ok.status_code == 200, ok.text


def test_password_confirmation_is_rate_limited(api, client, team):
    """A-07: archive / transfer-ownership password checks are throttled per user."""
    url = f"/api/v1/organizations/{team['org_id']}/archive"
    headers = team["owner"]["headers"]
    codes = [
        client.post(url, json={"password": "wrong", "confirm_slug": "acme-music"}, headers=headers).status_code
        for _ in range(5)
    ]
    assert set(codes) == {422}
    blocked = client.post(url, json={"password": DEFAULT_PASSWORD, "confirm_slug": "acme-music"}, headers=headers)
    assert blocked.status_code == 429
    transfer = client.post(
        f"/api/v1/organizations/{team['org_id']}/transfer-ownership",
        json={"new_owner_membership_id": "x", "password": DEFAULT_PASSWORD, "confirm_slug": "acme-music"},
        headers=headers,
    )
    assert transfer.status_code == 429


# --------------------------------------------------------------------------- A-03 / A-05 / A-10 / A-11


def test_production_rejects_placeholder_jwt_secret():
    import pytest
    from pydantic import ValidationError

    from app.core.config import Settings

    base = {"database_url": "mysql+pymysql://u:p@localhost/x", "app_env": "production"}
    for weak in ("change-me-to-a-long-random-secret-at-least-32-chars", "a" * 64, "ab" * 20):
        with pytest.raises(ValidationError):
            Settings(**base, jwt_secret_key=weak)
    strong = Settings(**base, jwt_secret_key="Zq3v9-Lr8sT2xY7kP0mW4nB6cH1dF5gJ_aE9uR2iO")
    assert strong.api_docs_enabled is False
    import secrets

    Settings(**base, jwt_secret_key=secrets.token_hex(32))  # 256-bit hex secrets are fine
    # Development keeps working with the example secret.
    Settings(database_url=base["database_url"], app_env="development",
             jwt_secret_key="change-me-to-a-long-random-secret-at-least-32-chars")


def test_forgot_password_takes_the_same_minimum_time(api, client):
    import time

    from app.api.v1.auth import FORGOT_PASSWORD_MIN_SECONDS

    api.register("known@example.com")
    for email in ("known@example.com", "unknown@example.com"):
        started = time.perf_counter()
        response = client.post("/api/v1/auth/password/forgot", json={"email": email})
        assert response.status_code == 202
        assert time.perf_counter() - started >= FORGOT_PASSWORD_MIN_SECONDS


def test_removed_member_gets_no_org_notifications(api, team, db):
    from app.models.organization_membership import OrganizationMembership
    from app.models.platform import Notification
    from app.services.notifications import notify_user

    membership = db.scalars(
        select(OrganizationMembership).where(
            OrganizationMembership.organization_id == team["org_id"],
            OrganizationMembership.user_id == team["viewer"]["id"],
        )
    ).one()
    membership.is_active = False
    db.commit()
    assert notify_user(db, user_id=team["viewer"]["id"], organization_id=team["org_id"],
                       type="import_failed", title="Import failed") is None
    # Invitations still reach non-members; active members still get notified.
    assert notify_user(db, user_id=team["viewer"]["id"], organization_id=team["org_id"],
                       type="invitation", title="Invited") is not None
    assert notify_user(db, user_id=team["manager"]["id"], organization_id=team["org_id"],
                       type="import_failed", title="Import failed") is not None
    db.commit()
    titles = db.scalars(select(Notification.title).where(Notification.user_id == team["viewer"]["id"])).all()
    assert "Import failed" not in titles


def test_members_join_only_through_invitations(client, team):
    """A-04: no direct add-by-email endpoint (account enumeration / forced membership)."""
    response = client.post(
        f"/api/v1/organizations/{team['org_id']}/members",
        json={"email": "outsider@example.com", "role": "viewer"},
        headers=team["owner"]["headers"],
    )
    assert response.status_code == 405


def test_unexpected_500_keeps_request_id_and_security_headers(client):
    """AF-15: the 500 body and headers carry the request id support needs."""
    from app.main import app

    def boom():
        raise RuntimeError("kaboom")

    app.add_api_route("/__audit_boom", boom, methods=["GET"])
    try:
        response = client.get("/__audit_boom", headers={"X-Request-ID": "audit-req-0001"})
    finally:
        app.router.routes = [r for r in app.router.routes if getattr(r, "path", "") != "/__audit_boom"]
    assert response.status_code == 500
    assert response.headers["X-Request-ID"] == "audit-req-0001"
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    body = response.json()
    assert body["request_id"] == "audit-req-0001" and body["error"]["code"] == "internal_error"
    assert "kaboom" not in response.text
