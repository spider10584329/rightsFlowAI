import re
from datetime import datetime, timedelta, timezone

import jwt
from sqlalchemy import select

from app.core.config import settings
from app.models.platform import AuditLog, EmailMessage
from tests.conftest import DEFAULT_PASSWORD, email_token


def _token_from_latest_email(db, template: str) -> str:
    message = db.scalars(
        select(EmailMessage).where(EmailMessage.template == template).order_by(EmailMessage.created_at.desc())
    ).first()
    assert message is not None
    # The stored body is redacted (audit A-06); the token is only in the dev preview.
    assert "token=[redacted]" in message.body_text
    return email_token(db, message.to_email, template)


def test_register_login_and_me(api, client):
    profile = api.register("Jane@Example.com", "Jane Doe")
    assert profile["email"] == "jane@example.com"
    assert profile["email_verified"] is False
    assert "hashed_password" not in profile

    tokens = api.login("jane@example.com")
    assert tokens["token_type"] == "bearer"
    assert tokens["refresh_token"]
    me = client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {tokens['access_token']}"})
    assert me.status_code == 200
    assert me.json()["full_name"] == "Jane Doe"


def test_register_rejects_duplicates_and_weak_passwords(api, client):
    api.register("dup@example.com")
    response = client.post(
        "/api/v1/auth/register",
        json={"email": "DUP@example.com", "full_name": "Again", "password": DEFAULT_PASSWORD},
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "conflict"

    weak = client.post(
        "/api/v1/auth/register",
        json={"email": "weak@example.com", "full_name": "Weak", "password": "aaaaaaaaaaaa"},
    )
    assert weak.status_code == 422
    assert weak.json()["error"]["code"] == "validation_failed"


def test_login_failures_are_generic_and_audited(api, client, db):
    api.register("someone@example.com")
    wrong = client.post("/api/v1/auth/login", json={"email": "someone@example.com", "password": "nope"})
    unknown = client.post("/api/v1/auth/login", json={"email": "ghost@example.com", "password": "nope"})
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json()["detail"] == unknown.json()["detail"] == "Invalid email or password"
    actions = db.scalars(select(AuditLog.action)).all()
    assert actions.count("auth.login_failed") == 2


def test_login_rate_limit(api, client):
    api.register("ratelimit@example.com")
    codes = [
        client.post(
            "/api/v1/auth/login", json={"email": "ratelimit@example.com", "password": "wrong"}
        ).status_code
        for _ in range(settings.auth_rate_limit_attempts + 1)
    ]
    assert codes[-1] == 429
    assert set(codes[:-1]) == {401}


def test_invalid_and_tampered_tokens(api, client):
    user = api.user("tamper@example.com")
    assert client.get("/api/v1/auth/me").status_code == 401
    assert client.get("/api/v1/auth/me", headers={"Authorization": "Bearer garbage"}).status_code == 401

    forged = jwt.encode(
        {"sub": user["id"], "iat": datetime.now(timezone.utc), "exp": datetime.now(timezone.utc) + timedelta(minutes=5), "type": "access"},
        "x" * 40,
        algorithm="HS256",
    )
    assert client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {forged}"}).status_code == 401

    expired = jwt.encode(
        {"sub": user["id"], "iat": datetime.now(timezone.utc) - timedelta(hours=2), "exp": datetime.now(timezone.utc) - timedelta(hours=1), "type": "access"},
        settings.jwt_secret_key,
        algorithm="HS256",
    )
    assert client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {expired}"}).status_code == 401

    wrong_type = jwt.encode(
        {"sub": user["id"], "iat": datetime.now(timezone.utc), "exp": datetime.now(timezone.utc) + timedelta(minutes=5), "type": "refresh"},
        settings.jwt_secret_key,
        algorithm="HS256",
    )
    assert client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {wrong_type}"}).status_code == 401


def test_refresh_rotation_and_reuse_detection(api, client):
    api.register("rotate@example.com")
    first = api.login("rotate@example.com")
    second = client.post("/api/v1/auth/refresh", json={"refresh_token": first["refresh_token"]})
    assert second.status_code == 200
    second = second.json()
    assert second["refresh_token"] != first["refresh_token"]

    # Re-using the rotated token revokes the whole session family.
    reuse = client.post("/api/v1/auth/refresh", json={"refresh_token": first["refresh_token"]})
    assert reuse.status_code == 401
    after = client.post("/api/v1/auth/refresh", json={"refresh_token": second["refresh_token"]})
    assert after.status_code == 401
    me = client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {second['access_token']}"})
    assert me.status_code == 401


def test_logout_revokes_session_and_access_token(api, client):
    user = api.user("logout@example.com")
    response = client.post(
        "/api/v1/auth/logout",
        json={"refresh_token": user["tokens"]["refresh_token"]},
        headers=user["headers"],
    )
    assert response.status_code == 200
    assert client.get("/api/v1/auth/me", headers=user["headers"]).status_code == 401
    assert client.post(
        "/api/v1/auth/refresh", json={"refresh_token": user["tokens"]["refresh_token"]}
    ).status_code == 401


def test_password_reset_flow_is_single_use(api, client, db):
    user = api.user("reset@example.com")
    response = client.post("/api/v1/auth/password/forgot", json={"email": "reset@example.com"})
    assert response.status_code == 202
    unknown = client.post("/api/v1/auth/password/forgot", json={"email": "nobody@example.com"})
    assert unknown.status_code == 202 and unknown.json() == response.json()

    token = _token_from_latest_email(db, "password_reset")
    new_password = "Brand-New-Passw0rd"
    ok = client.post("/api/v1/auth/password/reset", json={"token": token, "new_password": new_password})
    assert ok.status_code == 200
    again = client.post("/api/v1/auth/password/reset", json={"token": token, "new_password": "Another-Passw0rd!"})
    assert again.status_code == 422

    # Old sessions are revoked; old password no longer works.
    assert client.get("/api/v1/auth/me", headers=user["headers"]).status_code == 401
    assert client.post("/api/v1/auth/login", json={"email": "reset@example.com", "password": DEFAULT_PASSWORD}).status_code == 401
    api.login("reset@example.com", new_password)


def test_dev_email_is_logged_not_sent(api, db):
    api.register("outbox@example.com")
    message = db.scalars(select(EmailMessage)).first()
    assert message.status == "logged"
    assert message.provider == "console"
    assert message.preview_path


def test_email_verification(api, client, db):
    user = api.user("verify@example.com")
    token = _token_from_latest_email(db, "email_verification")
    response = client.post("/api/v1/auth/email/verify", json={"token": token})
    assert response.status_code == 200
    assert response.json()["email_verified"] is True
    assert client.post("/api/v1/auth/email/verify", json={"token": token}).status_code == 422
    me = client.get("/api/v1/auth/me", headers=user["headers"]).json()
    assert me["email_verified_at"] is not None


def test_profile_update_and_password_change(api, client):
    user = api.user("profile@example.com")
    response = client.patch(
        "/api/v1/auth/me", json={"full_name": "New Name", "job_title": "Royalty Analyst"}, headers=user["headers"]
    )
    assert response.status_code == 200
    assert response.json()["job_title"] == "Royalty Analyst"

    bad = client.post(
        "/api/v1/auth/password/change",
        json={"current_password": "wrong-password", "new_password": "Totally-New-Pass9"},
        headers=user["headers"],
    )
    assert bad.status_code == 422
    good = client.post(
        "/api/v1/auth/password/change",
        json={"current_password": DEFAULT_PASSWORD, "new_password": "Totally-New-Pass9"},
        headers=user["headers"],
    )
    assert good.status_code == 200
    new_headers = {"Authorization": f"Bearer {good.json()['access_token']}"}
    assert client.get("/api/v1/auth/me", headers=new_headers).status_code == 200
    assert client.get("/api/v1/auth/me", headers=user["headers"]).status_code == 401


def test_sessions_listing_and_revocation(api, client):
    user = api.user("sessions@example.com")
    api.login("sessions@example.com")
    sessions = client.get("/api/v1/auth/me/sessions", headers=user["headers"]).json()
    assert len(sessions) == 2
    current = [s for s in sessions if s["is_current"]]
    assert len(current) == 1
    other = [s for s in sessions if not s["is_current"]][0]
    assert client.delete(f"/api/v1/auth/me/sessions/{other['id']}", headers=user["headers"]).status_code == 200
    assert len(client.get("/api/v1/auth/me/sessions", headers=user["headers"]).json()) == 1


def test_error_envelope_shape(client):
    response = client.get("/api/v1/auth/me")
    body = response.json()
    assert set(body) >= {"error", "detail", "request_id"}
    assert body["error"]["code"] == "unauthorized"
    assert response.headers["X-Request-ID"]
