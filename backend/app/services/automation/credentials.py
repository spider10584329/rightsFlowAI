"""Organization-scoped automation credentials (API keys for n8n).

Token format: ``rfa_<key_id>_<secret>``. ``key_id`` is public (16 hex chars,
used for lookup and shown in the UI); ``secret`` is 256 bits of randomness and
is only ever returned once, at creation or rotation. The database stores
``HMAC-SHA256(pepper, key_id:secret)``, so a database leak does not reveal
usable keys.

Every credential acts as its own service user: a real ``users`` row (so audit
logs and ``created_by`` columns attribute automated changes) flagged
``is_service_account``, which can't sign in, receive email links or be
notified. It is not an organization member, so it uses no seat and never
appears in team lists.
"""

import hashlib
import hmac
import re
import secrets
from dataclasses import dataclass
from datetime import timedelta

from fastapi import Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import ConflictError, NotFoundError, ValidationFailedError
from app.core.permissions import OrgContext
from app.core.security import hash_password
from app.db.mixins import utc_now
from app.models.automation import IntegrationCredential
from app.models.user import User
from app.services.audit import record_audit

TOKEN_PREFIX = "rfa_"
_TOKEN_RE = re.compile(r"^rfa_([0-9a-f]{16})_([A-Za-z0-9_\-]{40,64})$")
# Anything that looks like an automation key, for log/error redaction.
_TOKEN_SCAN_RE = re.compile(r"rfa_[0-9a-f]{16}_[A-Za-z0-9_\-]{8,}")
_BEARER_RE = re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._\-]{8,}")

# Least-privilege scopes. None of them allows posting runs, reversing, or
# approving / paying payouts: those endpoints are not exposed to automation.
AUTOMATION_SCOPES: dict[str, str] = {
    "automation:read": "Identify the credential, read health and run history",
    "runs:write": "Record workflow runs and raise automation alerts",
    "events:consume": "Claim and acknowledge outbox events",
    "statements:import": "Upload royalty statements and start processing",
    "statements:review": "Read processing results, calculate draft (unposted) runs, raise review tasks",
    "contracts:read": "List contracts approaching expiration",
    "notifications:send": "Send contract reminders and review notifications to members",
    "reports:deliver": "Generate monthly reports and notify authorized members",
    "ai:review": "Request AI suggestions, stored as pending human review",
}
DEFAULT_SCOPES = sorted(AUTOMATION_SCOPES)
MAX_LIFETIME_DAYS = 365
DEFAULT_LIFETIME_DAYS = 90
ROTATION_GRACE_HOURS_MAX = 168
ACTIVE_CREDENTIALS_PER_ORG = 20


@dataclass
class IssuedCredential:
    credential: IntegrationCredential
    token: str  # shown once


def _pepper() -> bytes:
    return (settings.automation_key_pepper or settings.jwt_secret_key).encode("utf-8")


def hash_secret(key_id: str, secret: str) -> str:
    return hmac.new(_pepper(), f"{key_id}:{secret}".encode("utf-8"), hashlib.sha256).hexdigest()


def parse_token(raw: str) -> tuple[str, str] | None:
    match = _TOKEN_RE.match(raw.strip()) if raw else None
    return (match.group(1), match.group(2)) if match else None


def redact(text: str | None, limit: int = 500) -> str | None:
    """Strip automation keys and bearer tokens from free text (errors, logs)."""
    if text is None:
        return None
    from app.services.email import redact_secrets

    cleaned = _BEARER_RE.sub(r"\1[redacted]", _TOKEN_SCAN_RE.sub("rfa_[redacted]", text))
    return redact_secrets(cleaned)[:limit]


def _new_token() -> tuple[str, str, str]:
    key_id = secrets.token_hex(8)
    secret = secrets.token_urlsafe(32)
    return key_id, secret, f"{TOKEN_PREFIX}{key_id}_{secret}"


def _validate_scopes(scopes: list[str] | None) -> list[str]:
    chosen = sorted(set(scopes)) if scopes else DEFAULT_SCOPES
    unknown = [s for s in chosen if s not in AUTOMATION_SCOPES]
    if unknown:
        raise ValidationFailedError("Unknown automation scope", code="invalid_scope",
                                    details={"unknown": unknown, "allowed": DEFAULT_SCOPES})
    return chosen


def _service_user(db: Session, ctx: OrgContext, name: str, key_id: str) -> User:
    user = User(
        email=f"automation+{key_id}@automation.rightsflow.invalid",
        full_name=f"Automation: {name}"[:255],
        # A random, discarded password: the account has no usable password and
        # sign-in is refused for service accounts anyway.
        hashed_password=hash_password(secrets.token_urlsafe(48)),
        is_active=True,
        is_service_account=True,
    )
    db.add(user)
    db.flush()
    return user


def list_credentials(db: Session, organization_id: str) -> list[IntegrationCredential]:
    return list(db.scalars(
        select(IntegrationCredential).where(IntegrationCredential.organization_id == organization_id)
        .order_by(IntegrationCredential.created_at.desc())
    ).all())


def get_credential(db: Session, organization_id: str, credential_id: str, *,
                   lock: bool = False) -> IntegrationCredential:
    stmt = select(IntegrationCredential).where(
        IntegrationCredential.id == credential_id, IntegrationCredential.organization_id == organization_id)
    if lock:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    credential = db.scalar(stmt)
    if credential is None:
        raise NotFoundError("Automation credential not found")
    return credential


def credential_state(credential: IntegrationCredential) -> str:
    if credential.revoked_at is not None:
        return "revoked"
    if credential.expires_at is not None and credential.expires_at <= utc_now():
        return "expired"
    return "active"


def create_credential(db: Session, ctx: OrgContext, *, name: str, scopes: list[str] | None,
                      expires_in_days: int | None, request: Request | None) -> IssuedCredential:
    chosen = _validate_scopes(scopes)
    lifetime = DEFAULT_LIFETIME_DAYS if expires_in_days is None else expires_in_days
    if not 1 <= lifetime <= MAX_LIFETIME_DAYS:
        raise ValidationFailedError(f"Credentials expire after 1 to {MAX_LIFETIME_DAYS} days",
                                    code="invalid_expiry")
    active = sum(1 for c in list_credentials(db, ctx.organization_id) if credential_state(c) == "active")
    if active >= ACTIVE_CREDENTIALS_PER_ORG:
        raise ConflictError("Too many active automation credentials; revoke unused ones first",
                            code="credential_limit")
    key_id, secret, token = _new_token()
    user = _service_user(db, ctx, name, key_id)
    credential = IntegrationCredential(
        organization_id=ctx.organization_id, name=name.strip()[:100], key_id=key_id,
        secret_hash=hash_secret(key_id, secret), scopes=chosen, service_user_id=user.id,
        expires_at=utc_now() + timedelta(days=lifetime), created_by_id=ctx.user.id,
    )
    db.add(credential)
    db.flush()
    record_audit(db, action="automation.credential_created", actor_user_id=ctx.user.id,
                 organization_id=ctx.organization_id, entity_type="integration_credential",
                 entity_id=credential.id,
                 summary=f"Created automation credential '{credential.name}' (key {key_id})",
                 changes={"scopes": chosen, "expires_at": credential.expires_at.isoformat()},
                 request=request)
    db.commit()
    db.refresh(credential)
    return IssuedCredential(credential=credential, token=token)


def rotate_credential(db: Session, ctx: OrgContext, credential_id: str, *, grace_hours: int,
                      request: Request | None) -> IssuedCredential:
    """Issue a replacement key (same scopes and service user). The old key keeps
    working for ``grace_hours`` so running workflows can switch over."""
    if not 0 <= grace_hours <= ROTATION_GRACE_HOURS_MAX:
        raise ValidationFailedError(f"Grace period must be 0 to {ROTATION_GRACE_HOURS_MAX} hours",
                                    code="invalid_grace_period")
    old = get_credential(db, ctx.organization_id, credential_id, lock=True)
    if credential_state(old) != "active":
        raise ConflictError(f"Credential is {credential_state(old)}", code="credential_not_active")
    key_id, secret, token = _new_token()
    now = utc_now()
    lifetime = (old.expires_at - old.created_at) if old.expires_at else timedelta(days=DEFAULT_LIFETIME_DAYS)
    replacement = IntegrationCredential(
        organization_id=ctx.organization_id, name=old.name, key_id=key_id,
        secret_hash=hash_secret(key_id, secret), scopes=list(old.scopes),
        service_user_id=old.service_user_id, expires_at=now + lifetime, rotated_from_id=old.id,
        created_by_id=ctx.user.id,
    )
    db.add(replacement)
    grace_end = now + timedelta(hours=grace_hours)
    if grace_hours == 0:
        old.revoked_at = now
        old.revoked_reason = "rotated"
    elif old.expires_at is None or old.expires_at > grace_end:
        old.expires_at = grace_end
    db.flush()
    record_audit(db, action="automation.credential_rotated", actor_user_id=ctx.user.id,
                 organization_id=ctx.organization_id, entity_type="integration_credential",
                 entity_id=replacement.id,
                 summary=f"Rotated automation credential '{old.name}': key {old.key_id} -> {key_id}",
                 changes={"old_key_valid_until": (old.revoked_at or old.expires_at).isoformat()},
                 request=request)
    db.commit()
    db.refresh(replacement)
    return IssuedCredential(credential=replacement, token=token)


def revoke_credential(db: Session, ctx: OrgContext, credential_id: str, *, reason: str | None,
                      request: Request | None) -> IntegrationCredential:
    credential = get_credential(db, ctx.organization_id, credential_id, lock=True)
    if credential.revoked_at is None:
        credential.revoked_at = utc_now()
        credential.revoked_reason = (reason or "revoked")[:200]
        record_audit(db, action="automation.credential_revoked", actor_user_id=ctx.user.id,
                     organization_id=ctx.organization_id, entity_type="integration_credential",
                     entity_id=credential.id,
                     summary=f"Revoked automation credential '{credential.name}' (key {credential.key_id})",
                     request=request)
        db.commit()
        db.refresh(credential)
    return credential


def release_instance(db: Session, ctx: OrgContext, credential_id: str, *, request: Request | None) -> IntegrationCredential:
    """Admin recovery after an n8n data reset or move (N8N-07): forget the bound
    instance so the next instance that uses the key binds instead."""
    credential = get_credential(db, ctx.organization_id, credential_id, lock=True)
    if credential.bound_instance_id is not None:
        previous = credential.bound_instance_id
        credential.bound_instance_id = None
        credential.instance_bound_at = None
        credential.instance_last_seen_at = None
        record_audit(db, action="automation.instance_released", actor_user_id=ctx.user.id,
                     organization_id=ctx.organization_id, entity_type="integration_credential",
                     entity_id=credential.id,
                     summary=f"Released key {credential.key_id} from n8n instance {previous[:8]}…", request=request)
        db.commit()
        db.refresh(credential)
    return credential


def instance_payload(credential: IntegrationCredential) -> dict:
    from app.core.config import settings as cfg

    last_seen = credential.instance_last_seen_at
    return {
        "bound_instance": (credential.bound_instance_id[:8] + "…") if credential.bound_instance_id else None,
        "instance_bound_at": credential.instance_bound_at,
        "instance_last_seen_at": last_seen,
        "instance_stale": bool(credential.bound_instance_id) and (
            last_seen is None or utc_now() - last_seen > timedelta(hours=cfg.automation_instance_stale_hours)),
    }


def expiry_level(credential: IntegrationCredential) -> tuple[str, int | None]:
    """(level, days_left): ok | warning | critical | expired | revoked (N8N-04)."""
    if credential.revoked_at is not None:
        return "revoked", None
    if credential.expires_at is None:
        return "ok", None
    remaining = credential.expires_at - utc_now()
    days_left = remaining.days
    if remaining.total_seconds() <= 0:
        return "expired", days_left
    if days_left < settings.automation_credential_critical_days:
        return "critical", days_left
    if days_left < settings.automation_credential_warning_days:
        return "warning", days_left
    return "ok", days_left


def credential_payload(credential: IntegrationCredential) -> dict:
    return {
        "id": credential.id,
        "name": credential.name,
        "key_id": credential.key_id,
        "key_hint": f"{TOKEN_PREFIX}{credential.key_id}_…",
        "scopes": credential.scopes,
        "state": credential_state(credential),
        "expires_at": credential.expires_at,
        "revoked_at": credential.revoked_at,
        "revoked_reason": credential.revoked_reason,
        "rotated_from_id": credential.rotated_from_id,
        "last_used_at": credential.last_used_at,
        "created_by_id": credential.created_by_id,
        "created_at": credential.created_at,
        "expiry_level": expiry_level(credential)[0],
        **instance_payload(credential),
    }
