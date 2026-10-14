from datetime import timedelta

from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import AuthenticationError
from app.core.security import decode_access_token
from app.db.session import get_db
from app.models.auth_tokens import RefreshToken
from app.models.user import User

bearer_scheme = HTTPBearer(auto_error=False)


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> User:
    """Return the authenticated, active user.

    Rejects tokens whose session (refresh-token family) was revoked by logout
    and tokens issued before the user's last password change.
    """
    auth_error = AuthenticationError("Invalid or missing authentication credentials")

    if credentials is None or credentials.scheme.lower() != "bearer":
        raise auth_error

    claims = decode_access_token(credentials.credentials)
    if claims is None:
        raise auth_error

    user = db.get(User, claims.user_id)
    if user is None or not user.is_active or user.is_service_account:
        raise auth_error

    if user.password_changed_at is not None:
        # JWT iat has one-second resolution.
        issued = claims.issued_at.replace(tzinfo=None)
        if issued + timedelta(seconds=1) < user.password_changed_at:
            raise auth_error

    if claims.session_id is not None:
        active_session = db.scalar(
            select(RefreshToken.id)
            .where(
                RefreshToken.family_id == claims.session_id,
                RefreshToken.user_id == user.id,
                RefreshToken.revoked_at.is_(None),
            )
            .limit(1)
        )
        if active_session is None:
            # Allow the token only if the family was rotated, not revoked:
            # rotated tokens are revoked with reason "rotated" while the
            # newest token in the family stays active, so reaching here
            # means the whole session was terminated.
            raise auth_error

    return user
