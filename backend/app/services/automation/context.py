"""Authentication for the automation API (``/api/v1/automation/...``).

``require_scope(scope)`` is a FastAPI dependency that:

1. reads ``Authorization: Bearer rfa_<key_id>_<secret>``;
2. looks the key up by ``key_id`` and compares the secret's HMAC in constant time;
3. rejects revoked or expired keys, inactive organizations and disabled service users;
4. checks the required scope;
5. builds an ``OrgContext`` for the credential's organization only, with a
   transient manager-level membership (never admin/owner), so existing
   services can be reused while posting/approval stays out of reach.

Failures return 401 (403 for a missing scope), are audited without the secret,
and are rate limited per client IP.
"""

import hmac
import re
from dataclasses import dataclass
from datetime import timedelta

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.dependencies import bearer_scheme
from app.core.errors import AuthenticationError, ConflictError, PermissionDeniedError, RateLimitedError
from app.core.permissions import OrgContext
from app.core.rate_limit import limiter
from app.core.request_context import client_ip
from app.db.mixins import utc_now
from app.db.session import get_db
from app.models.automation import IntegrationCredential
from app.models.organization import Organization
from app.models.organization_membership import OrganizationMembership
from app.models.user import User
from app.services.audit import record_audit
from app.services.automation.credentials import AUTOMATION_SCOPES, credential_state, hash_secret, parse_token

AUTOMATION_ROLE = "manager"
_CORRELATION_RE = re.compile(r"^[A-Za-z0-9._:\-]{1,100}$")
AUTH_FAILURE_LIMIT = 20
AUTH_FAILURE_WINDOW_SECONDS = 300


INSTANCE_HEADER = "x-automation-instance"
_INSTANCE_RE = re.compile(r"^[A-Za-z0-9\-]{8,64}$")


@dataclass
class AutomationContext:
    credential: IntegrationCredential
    org: OrgContext
    correlation_id: str | None
    instance_id: str | None = None

    @property
    def organization_id(self) -> str:
        return self.org.organization_id

    @property
    def service_user(self) -> User:
        return self.org.user

    def has_scope(self, scope: str) -> bool:
        return scope in (self.credential.scopes or [])


def _fail(db: Session, request: Request, reason: str, credential: IntegrationCredential | None) -> None:
    allowed, retry_after = limiter.hit(f"automation_auth_fail:{client_ip(request)}",
                                       AUTH_FAILURE_LIMIT, AUTH_FAILURE_WINDOW_SECONDS)
    record_audit(
        db, action="automation.auth_failed",
        organization_id=credential.organization_id if credential else None,
        entity_type="integration_credential" if credential else None,
        entity_id=credential.id if credential else None,
        summary=f"Automation authentication failed: {reason}"
                + (f" (key {credential.key_id})" if credential else ""),
        request=request,
    )
    db.commit()
    if not allowed:
        raise RateLimitedError("Too many failed automation authentication attempts",
                               details={"retry_after_seconds": retry_after})
    raise AuthenticationError("Invalid or missing automation credentials", code="invalid_automation_key")


def authenticate_automation(request: Request, credentials: HTTPAuthorizationCredentials | None,
                            db: Session) -> AutomationContext:
    if credentials is None or credentials.scheme.lower() != "bearer":
        _fail(db, request, "missing credentials", None)
    parsed = parse_token(credentials.credentials)
    if parsed is None:
        _fail(db, request, "malformed key", None)
    key_id, secret = parsed
    credential = db.scalar(select(IntegrationCredential).where(IntegrationCredential.key_id == key_id))
    if credential is None:
        _fail(db, request, "unknown key", None)
    if not hmac.compare_digest(credential.secret_hash, hash_secret(key_id, secret)):
        _fail(db, request, "wrong secret", credential)
    state = credential_state(credential)
    if state != "active":
        _fail(db, request, f"{state} key", credential)
    organization = db.get(Organization, credential.organization_id)
    user = db.get(User, credential.service_user_id)
    if organization is None or not organization.is_active:
        _fail(db, request, "organization inactive", credential)
    if user is None or not user.is_active or not user.is_service_account:
        _fail(db, request, "service account disabled", credential)

    allowed, retry_after = limiter.hit(f"automation:{credential.id}",
                                       settings.automation_rate_limit_per_minute, 60)
    if not allowed:
        raise RateLimitedError("Automation rate limit exceeded",
                               details={"retry_after_seconds": retry_after})

    now = utc_now()
    instance_id = _check_instance(db, request, credential, now)
    if credential.last_used_at is None or now - credential.last_used_at > timedelta(seconds=60):
        credential.last_used_at = now
        credential.last_used_ip = client_ip(request)[:64]
        db.commit()

    # Transient membership: never persisted, so the service user holds no seat
    # and is invisible to member lists; the role caps what reused services allow.
    membership = OrganizationMembership(organization_id=organization.id, user_id=user.id,
                                        role=AUTOMATION_ROLE, is_active=True)
    correlation = request.headers.get("x-correlation-id")
    if correlation is not None and not _CORRELATION_RE.match(correlation):
        correlation = None
    return AutomationContext(credential=credential,
                             org=OrgContext(user=user, membership=membership, organization=organization),
                             correlation_id=correlation, instance_id=instance_id)


def _check_instance(db: Session, request: Request, credential: IntegrationCredential, now) -> str | None:
    """Bind a key to the first n8n instance that presents it (N8N-07).

    Workflows send ``X-Automation-Instance`` (a stable id stored in the n8n data
    folder). A different instance using the same key gets 409 ``instance_conflict``
    instead of double-processing; nothing is taken over automatically, even when
    the bound instance looks stale. An admin releases the binding (or rotates the
    key) to move automation to a new instance. Requests without the header
    (local diagnostic scripts) are not bound."""
    raw = request.headers.get(INSTANCE_HEADER)
    if raw is None:
        return None
    if not _INSTANCE_RE.match(raw):
        raise AuthenticationError("Invalid automation instance id", code="invalid_instance_id")
    if credential.bound_instance_id is None:
        credential.bound_instance_id = raw
        credential.instance_bound_at = now
        credential.instance_last_seen_at = now
        record_audit(db, action="automation.instance_bound", organization_id=credential.organization_id,
                     entity_type="integration_credential", entity_id=credential.id,
                     summary=f"Key {credential.key_id} bound to n8n instance {raw[:8]}…", request=request)
        db.commit()
        return raw
    if credential.bound_instance_id != raw:
        last_seen = credential.instance_last_seen_at
        stale = last_seen is None or now - last_seen > timedelta(hours=settings.automation_instance_stale_hours)
        record_audit(db, action="automation.instance_conflict", organization_id=credential.organization_id,
                     entity_type="integration_credential", entity_id=credential.id,
                     summary=f"Key {credential.key_id} presented by instance {raw[:8]}… but bound to "
                             f"{credential.bound_instance_id[:8]}…", request=request)
        db.commit()
        raise ConflictError(
            "This automation key is bound to another n8n instance. An admin can release the binding in "
            "Settings > Automation (or rotate the key) after confirming the other instance is gone.",
            code="instance_conflict",
            details={"bound_instance": credential.bound_instance_id[:8] + "…",
                     "bound_instance_last_seen_at": last_seen.isoformat() if last_seen else None,
                     "bound_instance_stale": stale, "this_instance": raw[:8] + "…"})
    if credential.instance_last_seen_at is None or now - credential.instance_last_seen_at > timedelta(seconds=60):
        credential.instance_last_seen_at = now
        db.commit()
    return raw


def require_scope(scope: str):
    if scope not in AUTOMATION_SCOPES:
        raise ValueError(f"Unknown automation scope {scope!r}")

    def dependency(
        request: Request,
        credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
        db: Session = Depends(get_db),
    ) -> AutomationContext:
        context = authenticate_automation(request, credentials, db)
        if not context.has_scope(scope):
            record_audit(db, action="automation.scope_denied", organization_id=context.organization_id,
                         entity_type="integration_credential", entity_id=context.credential.id,
                         summary=f"Automation key {context.credential.key_id} lacks scope {scope}",
                         request=request)
            db.commit()
            raise PermissionDeniedError(f"This automation credential lacks the '{scope}' scope",
                                        code="missing_scope", details={"required_scope": scope})
        return context

    return dependency
