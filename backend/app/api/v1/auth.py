import time

from fastapi import APIRouter, Depends, Request, status

from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.dependencies import bearer_scheme, get_current_user
from app.core.errors import NotFoundError
from app.core.permissions import load_membership
from app.core.rate_limit import auth_rate_limit, enforce_rate_limit
from app.core.request_context import client_ip
from app.core.security import decode_access_token
from app.db.mixins import utc_now
from app.db.session import get_db
from app.models.auth_tokens import RefreshToken
from app.models.user import User
from app.schemas.auth import (
    ForgotPasswordRequest,
    LoginRequest,
    LogoutRequest,
    RefreshRequest,
    ResetPasswordRequest,
    TokenResponse,
    VerifyEmailRequest,
)
from app.schemas.common import MessageResponse
from app.schemas.user import (
    ActiveOrganizationUpdate,
    NotificationPreferencesResponse,
    NotificationPreferencesUpdate,
    PasswordChange,
    SessionResponse,
    UserProfileUpdate,
    UserRegister,
    UserResponse,
)
from app.core.config import settings
from app.core.errors import ValidationFailedError
from app.services import auth_service
from app.services.notifications import EMAIL_NOTIFICATION_TYPES, effective_preferences
from app.services.audit import diff, record_audit, snapshot

FORGOT_PASSWORD_MIN_SECONDS = 0.35

router = APIRouter(prefix="/auth", tags=["Authentication"])


def _token_response(tokens: auth_service.IssuedTokens) -> TokenResponse:
    return TokenResponse(
        access_token=tokens.access_token,
        token_type="bearer",
        expires_in=tokens.expires_in,
        refresh_token=tokens.refresh_token,
        refresh_expires_in=tokens.refresh_expires_in,
    )


@router.post(
    "/register",
    response_model=UserResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(auth_rate_limit("register"))],
)
def register_user(payload: UserRegister, request: Request, db: Session = Depends(get_db)):
    """Create an account and send an email-verification link."""
    user = auth_service.register_user(
        db, str(payload.email), payload.full_name, payload.password, request
    )
    db.commit()
    db.refresh(user)
    return user


@router.post("/login", response_model=TokenResponse)
def login_user(payload: LoginRequest, request: Request, db: Session = Depends(get_db)):
    """Authenticate and issue an access token plus a rotating refresh token."""
    email = str(payload.email).lower()
    # Per IP + per (account, IP): an attacker elsewhere can't lock a user out.
    # A looser per-account ceiling still slows distributed guessing (audit A-08).
    enforce_rate_limit(request, "login", extra_key=f"{email}|{client_ip(request)}")
    enforce_rate_limit(request, "login_account", extra_key=email, limit=50, window_seconds=900,
                       include_ip=False)
    tokens = auth_service.authenticate(db, str(payload.email), payload.password, request)
    return _token_response(tokens)


@router.post(
    "/refresh",
    response_model=TokenResponse,
    dependencies=[Depends(auth_rate_limit("refresh"))],
)
def refresh_tokens(payload: RefreshRequest, request: Request, db: Session = Depends(get_db)):
    """Rotate a refresh token. Each refresh token can be used exactly once."""
    return _token_response(auth_service.rotate_refresh_token(db, payload.refresh_token, request))


@router.post("/logout", response_model=MessageResponse)
def logout(
    request: Request,
    payload: LogoutRequest | None = None,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
):
    """Revoke the current session. Accepts the refresh token, the access
    token, or both."""
    claims = decode_access_token(credentials.credentials) if credentials else None
    auth_service.logout(
        db,
        payload.refresh_token if payload else None,
        claims.session_id if claims else None,
        claims.user_id if claims else None,
        request,
    )
    return MessageResponse(message="Signed out")


@router.post("/logout-all", response_model=MessageResponse)
def logout_everywhere(
    request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    count = auth_service.revoke_all_sessions(db, current_user.id, "logout_all")
    record_audit(
        db,
        action="auth.logout_all",
        actor_user_id=current_user.id,
        entity_type="user",
        entity_id=current_user.id,
        summary=f"Revoked {count} session token(s)",
        request=request,
    )
    db.commit()
    return MessageResponse(message="All sessions signed out")


@router.post(
    "/password/forgot",
    response_model=MessageResponse,
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(auth_rate_limit("password_forgot"))],
)
def forgot_password(payload: ForgotPasswordRequest, request: Request, db: Session = Depends(get_db)):
    enforce_rate_limit(request, "password_forgot_email", extra_key=str(payload.email), limit=3,
                       window_seconds=900)
    # Known and unknown addresses take the same time, so response latency
    # doesn't reveal which emails have accounts (audit A-05).
    started = time.perf_counter()
    auth_service.request_password_reset(db, str(payload.email), request)
    remaining = FORGOT_PASSWORD_MIN_SECONDS - (time.perf_counter() - started)
    if remaining > 0:
        time.sleep(remaining)
    return MessageResponse(
        message="If an account exists for that email, a reset link has been sent."
    )


@router.post(
    "/password/reset",
    response_model=MessageResponse,
    dependencies=[Depends(auth_rate_limit("password_reset"))],
)
def reset_password(payload: ResetPasswordRequest, request: Request, db: Session = Depends(get_db)):
    auth_service.reset_password(db, payload.token, payload.new_password, request)
    return MessageResponse(message="Password updated. Please sign in.")


@router.post("/password/change", response_model=TokenResponse)
def change_password(
    payload: PasswordChange,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Change password; all other sessions are revoked and a new pair issued."""
    enforce_rate_limit(request, "password_change", extra_key=current_user.id)
    tokens = auth_service.change_password(
        db, current_user, payload.current_password, payload.new_password, request
    )
    return _token_response(tokens)


@router.post(
    "/email/verify",
    response_model=UserResponse,
    dependencies=[Depends(auth_rate_limit("email_verify"))],
)
def verify_email(payload: VerifyEmailRequest, request: Request, db: Session = Depends(get_db)):
    return auth_service.verify_email(db, payload.token, request)


@router.post("/email/resend-verification", response_model=MessageResponse)
def resend_verification(
    request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    enforce_rate_limit(request, "email_resend", extra_key=current_user.id, limit=3,
                       window_seconds=900)
    if current_user.email_verified_at is not None:
        return MessageResponse(message="Email address is already verified")
    auth_service.send_verification_email(db, current_user)
    db.commit()
    return MessageResponse(message="Verification email queued")


@router.get("/me", response_model=UserResponse)
def get_my_profile(current_user: User = Depends(get_current_user)):
    """Return the currently authenticated user's profile."""
    return current_user


@router.patch("/me", response_model=UserResponse)
def update_my_profile(
    payload: UserProfileUpdate,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    before = snapshot(current_user, ["full_name", "job_title", "timezone"])
    for field, value in payload.model_dump(exclude_unset=True).items():
        if field == "full_name" and value is None:
            continue
        setattr(current_user, field, value.strip() if isinstance(value, str) else value)
    changes = diff(before, snapshot(current_user, ["full_name", "job_title", "timezone"]))
    if changes:
        record_audit(
            db,
            action="user.profile_updated",
            actor_user_id=current_user.id,
            entity_type="user",
            entity_id=current_user.id,
            changes=changes,
            request=request,
        )
    db.commit()
    db.refresh(current_user)
    return current_user


@router.put("/me/active-organization", response_model=UserResponse)
def switch_organization(
    payload: ActiveOrganizationUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Remember the organization the user is working in."""
    if load_membership(db, payload.organization_id, current_user.id) is None:
        raise NotFoundError("Organization not found")
    current_user.last_organization_id = payload.organization_id
    db.commit()
    db.refresh(current_user)
    return current_user


@router.get("/me/sessions", response_model=list[SessionResponse])
def list_my_sessions(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    claims = decode_access_token(credentials.credentials) if credentials else None
    tokens = db.scalars(
        select(RefreshToken)
        .where(
            RefreshToken.user_id == current_user.id,
            RefreshToken.revoked_at.is_(None),
            RefreshToken.expires_at > utc_now(),
        )
        .order_by(RefreshToken.created_at.desc())
    ).all()
    return [
        SessionResponse.model_validate(t).model_copy(
            update={"is_current": bool(claims and claims.session_id == t.family_id)}
        )
        for t in tokens
    ]


@router.delete("/me/sessions/{session_id}", response_model=MessageResponse)
def revoke_my_session(
    session_id: str,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    token = db.scalar(
        select(RefreshToken).where(
            RefreshToken.id == session_id, RefreshToken.user_id == current_user.id
        )
    )
    if token is None:
        raise NotFoundError("Session not found")
    auth_service.revoke_family(db, token.family_id, "revoked_by_user")
    record_audit(
        db,
        action="auth.session_revoked",
        actor_user_id=current_user.id,
        entity_type="user",
        entity_id=current_user.id,
        request=request,
    )
    db.commit()
    return MessageResponse(message="Session revoked")


def _preferences_payload(user: User) -> dict:
    prefs = effective_preferences(user)
    return {
        "email_enabled": prefs["email_enabled"],
        "types": [
            {"type": key, "label": meta["label"], "default": meta["default"],
             "email": prefs["email_types"][key]}
            for key, meta in EMAIL_NOTIFICATION_TYPES.items()
        ],
        "email_delivery": settings.email_provider,
    }


@router.get("/me/notification-preferences", response_model=NotificationPreferencesResponse)
def get_notification_preferences(current_user: User = Depends(get_current_user)):
    """Which notifications are also sent by email (in-app notifications are always kept)."""
    return _preferences_payload(current_user)


@router.put("/me/notification-preferences", response_model=NotificationPreferencesResponse)
def update_notification_preferences(
    payload: NotificationPreferencesUpdate,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    unknown = set(payload.email_types) - set(EMAIL_NOTIFICATION_TYPES)
    if unknown:
        raise ValidationFailedError("Unknown notification types",
                                    details={"unknown": sorted(unknown)})
    before = effective_preferences(current_user)
    current_user.notification_preferences = {
        "email_enabled": payload.email_enabled,
        "email_types": {**before["email_types"], **payload.email_types},
    }
    record_audit(db, action="user.notification_preferences_updated", actor_user_id=current_user.id,
                 entity_type="user", entity_id=current_user.id,
                 changes=diff(before, effective_preferences(current_user)), request=request)
    db.commit()
    db.refresh(current_user)
    return _preferences_payload(current_user)
