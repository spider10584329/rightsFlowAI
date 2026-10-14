"""Authentication business logic: sessions, refresh rotation, password reset
and email verification."""

from dataclasses import dataclass
from datetime import timedelta
from uuid import uuid4

from fastapi import Request
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import AuthenticationError, ConflictError, ValidationFailedError
from app.core.request_context import client_ip, user_agent
from app.core.security import (
    burn_password_check,
    create_access_token,
    generate_opaque_token,
    hash_password,
    hash_token,
    verify_password,
)
from app.db.mixins import utc_now
from app.models.auth_tokens import RefreshToken, UserActionToken
from app.models.user import User
from app.services.audit import record_audit
from app.services.email import frontend_link, send_email


@dataclass
class IssuedTokens:
    access_token: str
    refresh_token: str
    expires_in: int
    refresh_expires_in: int
    session_id: str


def normalize_email(email: str) -> str:
    return email.strip().lower()


def get_user_by_email(db: Session, email: str) -> User | None:
    return db.scalar(select(User).where(User.email == normalize_email(email)))


# --------------------------------------------------------------------------- sessions


def _issue_refresh(
    db: Session, user: User, family_id: str, request: Request | None
) -> tuple[RefreshToken, str]:
    raw = generate_opaque_token()
    token = RefreshToken(
        user_id=user.id,
        token_hash=hash_token(raw),
        family_id=family_id,
        expires_at=utc_now() + timedelta(days=settings.refresh_token_expire_days),
        created_ip=client_ip(request) if request else None,
        user_agent=user_agent(request) if request else None,
    )
    db.add(token)
    db.flush()
    return token, raw


def _tokens_for(user: User, family_id: str, raw_refresh: str) -> IssuedTokens:
    return IssuedTokens(
        access_token=create_access_token(user.id, session_id=family_id),
        refresh_token=raw_refresh,
        expires_in=settings.access_token_expire_minutes * 60,
        refresh_expires_in=settings.refresh_token_expire_days * 86400,
        session_id=family_id,
    )


def authenticate(db: Session, email: str, password: str, request: Request | None) -> IssuedTokens:
    user = get_user_by_email(db, email)
    if user is None:
        burn_password_check(password)
        record_audit(
            db,
            action="auth.login_failed",
            summary=f"Failed login for unknown email {normalize_email(email)}",
            request=request,
        )
        db.commit()
        raise AuthenticationError("Invalid email or password")

    # Service accounts (automation credentials) never sign in interactively.
    if not user.is_active or user.is_service_account or not verify_password(password, user.hashed_password):
        record_audit(
            db,
            action="auth.login_failed",
            actor_user_id=user.id,
            entity_type="user",
            entity_id=user.id,
            summary="Failed login",
            request=request,
        )
        db.commit()
        raise AuthenticationError("Invalid email or password")

    if settings.require_email_verification and user.email_verified_at is None:
        raise AuthenticationError(
            "Email address not verified", code="email_not_verified"
        )

    family_id = str(uuid4())
    _, raw = _issue_refresh(db, user, family_id, request)
    user.last_login_at = utc_now()
    record_audit(
        db,
        action="auth.login",
        actor_user_id=user.id,
        entity_type="user",
        entity_id=user.id,
        summary="Signed in",
        request=request,
    )
    db.commit()
    return _tokens_for(user, family_id, raw)


def revoke_family(db: Session, family_id: str, reason: str) -> int:
    result = db.execute(
        update(RefreshToken)
        .where(RefreshToken.family_id == family_id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=utc_now(), revoked_reason=reason)
    )
    return result.rowcount or 0


def revoke_all_sessions(db: Session, user_id: str, reason: str) -> int:
    result = db.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=utc_now(), revoked_reason=reason)
    )
    return result.rowcount or 0


def rotate_refresh_token(db: Session, raw_token: str, request: Request | None) -> IssuedTokens:
    """Exchange a refresh token for a new pair. Re-use of a rotated token
    revokes the whole session family (likely token theft)."""
    token = db.scalar(
        select(RefreshToken).where(RefreshToken.token_hash == hash_token(raw_token))
        .with_for_update().execution_options(populate_existing=True)
    )
    invalid = AuthenticationError("Invalid or expired refresh token")
    if token is None:
        raise invalid

    if token.revoked_at is not None:
        if token.revoked_reason == "rotated":
            revoke_family(db, token.family_id, "reuse_detected")
            record_audit(
                db,
                action="auth.refresh_reuse_detected",
                actor_user_id=token.user_id,
                entity_type="user",
                entity_id=token.user_id,
                summary="Refresh token reuse detected; session revoked",
                request=request,
            )
            db.commit()
        raise invalid

    if token.expires_at <= utc_now():
        raise invalid

    user = db.get(User, token.user_id)
    if user is None or not user.is_active or user.is_service_account:
        raise invalid

    new_token, raw = _issue_refresh(db, user, token.family_id, request)
    token.revoked_at = utc_now()
    token.revoked_reason = "rotated"
    token.replaced_by_id = new_token.id
    token.last_used_at = utc_now()
    db.commit()
    return _tokens_for(user, token.family_id, raw)


def logout(db: Session, raw_refresh: str | None, session_id: str | None, user_id: str | None,
           request: Request | None) -> None:
    families: set[str] = set()
    if raw_refresh:
        token = db.scalar(select(RefreshToken).where(RefreshToken.token_hash == hash_token(raw_refresh)))
        if token is not None:
            families.add(token.family_id)
            user_id = user_id or token.user_id
    if session_id:
        families.add(session_id)
    for family in families:
        revoke_family(db, family, "logout")
    if user_id:
        record_audit(
            db,
            action="auth.logout",
            actor_user_id=user_id,
            entity_type="user",
            entity_id=user_id,
            summary="Signed out",
            request=request,
        )
    db.commit()


# --------------------------------------------------------------------------- one-time tokens


def _create_action_token(db: Session, user: User, purpose: str, ttl: timedelta) -> str:
    # Invalidate older outstanding tokens for the same purpose.
    db.execute(
        update(UserActionToken)
        .where(
            UserActionToken.user_id == user.id,
            UserActionToken.purpose == purpose,
            UserActionToken.used_at.is_(None),
        )
        .values(used_at=utc_now())
    )
    raw = generate_opaque_token()
    db.add(
        UserActionToken(
            user_id=user.id,
            purpose=purpose,
            token_hash=hash_token(raw),
            expires_at=utc_now() + ttl,
        )
    )
    return raw


def _consume_action_token(db: Session, raw: str, purpose: str) -> User:
    token = db.scalar(
        select(UserActionToken)
        .where(UserActionToken.token_hash == hash_token(raw), UserActionToken.purpose == purpose)
        .with_for_update().execution_options(populate_existing=True)
    )
    if token is None or token.used_at is not None or token.expires_at <= utc_now():
        raise ValidationFailedError("This link is invalid or has expired", code="invalid_token")
    user = db.get(User, token.user_id)
    if user is None or not user.is_active or user.is_service_account:
        raise ValidationFailedError("This link is invalid or has expired", code="invalid_token")
    token.used_at = utc_now()
    return user


def register_user(db: Session, email: str, full_name: str, password: str,
                  request: Request | None) -> User:
    email = normalize_email(email)
    if get_user_by_email(db, email) is not None:
        raise ConflictError("Email is already registered")
    if password.lower() == email:
        raise ValidationFailedError("Password must not equal your email address")
    user = User(email=email, full_name=full_name.strip(), hashed_password=hash_password(password))
    db.add(user)
    db.flush()
    record_audit(
        db,
        action="auth.register",
        actor_user_id=user.id,
        entity_type="user",
        entity_id=user.id,
        summary="Account registered",
        request=request,
    )
    send_verification_email(db, user)
    return user


def send_verification_email(db: Session, user: User) -> None:
    raw = _create_action_token(
        db, user, "email_verification", timedelta(hours=settings.email_verification_expire_hours)
    )
    link = frontend_link(f"/verify-email?token={raw}")
    send_email(
        db,
        to=user.email,
        subject="Verify your RightsFlow AI email address",
        template="email_verification",
        body=(
            f"Hi {user.full_name},\n\nConfirm your email address for RightsFlow AI:\n{link}\n\n"
            f"This link expires in {settings.email_verification_expire_hours} hours."
        ),
    )


def verify_email(db: Session, raw: str, request: Request | None) -> User:
    user = _consume_action_token(db, raw, "email_verification")
    if user.email_verified_at is None:
        user.email_verified_at = utc_now()
    record_audit(
        db,
        action="auth.email_verified",
        actor_user_id=user.id,
        entity_type="user",
        entity_id=user.id,
        request=request,
    )
    db.commit()
    return user


def request_password_reset(db: Session, email: str, request: Request | None) -> None:
    """Always succeeds from the caller's perspective (no account enumeration)."""
    user = get_user_by_email(db, email)
    if user is None or not user.is_active or user.is_service_account:
        return
    raw = _create_action_token(
        db, user, "password_reset", timedelta(minutes=settings.password_reset_expire_minutes)
    )
    link = frontend_link(f"/reset-password?token={raw}")
    send_email(
        db,
        to=user.email,
        subject="Reset your RightsFlow AI password",
        template="password_reset",
        body=(
            f"Hi {user.full_name},\n\nUse this link to choose a new password:\n{link}\n\n"
            f"The link expires in {settings.password_reset_expire_minutes} minutes and can be "
            "used once. If you didn't request this, you can ignore this email."
        ),
    )
    record_audit(
        db,
        action="auth.password_reset_requested",
        actor_user_id=user.id,
        entity_type="user",
        entity_id=user.id,
        request=request,
    )
    db.commit()


def reset_password(db: Session, raw: str, new_password: str, request: Request | None) -> None:
    user = _consume_action_token(db, raw, "password_reset")
    _set_password(db, user, new_password)
    # A reset proves control of the mailbox.
    if user.email_verified_at is None:
        user.email_verified_at = utc_now()
    record_audit(
        db,
        action="auth.password_reset",
        actor_user_id=user.id,
        entity_type="user",
        entity_id=user.id,
        summary="Password reset; all sessions revoked",
        request=request,
    )
    db.commit()


def change_password(db: Session, user: User, current: str, new: str,
                    request: Request | None) -> IssuedTokens:
    if not verify_password(current, user.hashed_password):
        raise ValidationFailedError("Current password is incorrect", code="invalid_password")
    if current == new:
        raise ValidationFailedError("New password must differ from the current password")
    _set_password(db, user, new)
    family_id = str(uuid4())
    _, raw = _issue_refresh(db, user, family_id, request)
    record_audit(
        db,
        action="auth.password_changed",
        actor_user_id=user.id,
        entity_type="user",
        entity_id=user.id,
        summary="Password changed; other sessions revoked",
        request=request,
    )
    db.commit()
    return _tokens_for(user, family_id, raw)


def _set_password(db: Session, user: User, new_password: str) -> None:
    if new_password.lower() == user.email:
        raise ValidationFailedError("Password must not equal your email address")
    user.hashed_password = hash_password(new_password)
    user.password_changed_at = utc_now()
    revoke_all_sessions(db, user.id, "password_changed")
