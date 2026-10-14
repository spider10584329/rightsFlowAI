"""Password hashing, JWT access tokens and opaque one-time tokens."""

import hashlib
import hmac
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import jwt
from jwt.exceptions import InvalidTokenError
from pwdlib import PasswordHash

from app.core.config import settings

JWT_SECRET_KEY = settings.jwt_secret_key
JWT_ALGORITHM = settings.jwt_algorithm
ACCESS_TOKEN_EXPIRE_MINUTES = settings.access_token_expire_minutes
JWT_ISSUER = "rightsflow-ai"

password_hash = PasswordHash.recommended()

# Pre-computed hash used to equalize timing when a login email is unknown.
_DUMMY_HASH = password_hash.hash("rightsflow-timing-equalizer")


def hash_password(password: str) -> str:
    """Hash a plaintext password using Argon2."""
    return password_hash.hash(password)


def verify_password(password: str, hashed_password: str) -> bool:
    """Verify a plaintext password against its stored hash."""
    return password_hash.verify(password, hashed_password)


def burn_password_check(password: str) -> None:
    """Spend the same time as a real check so unknown emails aren't detectable."""
    password_hash.verify(password, _DUMMY_HASH)


@dataclass(frozen=True)
class AccessTokenClaims:
    user_id: str
    session_id: str | None
    issued_at: datetime


def create_access_token(user_id: str, session_id: str | None = None) -> str:
    """Create a signed JWT access token.

    ``session_id`` is the refresh-token family id; revoking the family (logout)
    invalidates access tokens that carry it.
    """
    now = datetime.now(timezone.utc)
    payload: dict[str, object] = {
        "sub": user_id,
        "iat": now,
        "exp": now + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES),
        "type": "access",
        "iss": JWT_ISSUER,
    }
    if session_id:
        payload["sid"] = session_id
    return jwt.encode(payload, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)


def decode_access_token(token: str) -> AccessTokenClaims | None:
    try:
        payload = jwt.decode(
            token,
            JWT_SECRET_KEY,
            algorithms=[JWT_ALGORITHM],
            options={"require": ["sub", "iat", "exp", "type"]},
        )
    except InvalidTokenError:
        return None

    if payload.get("type") != "access":
        return None
    issuer = payload.get("iss")
    if issuer is not None and issuer != JWT_ISSUER:
        return None
    user_id = payload.get("sub")
    if not isinstance(user_id, str) or not user_id:
        return None
    session_id = payload.get("sid")
    if session_id is not None and not isinstance(session_id, str):
        return None
    issued_at = datetime.fromtimestamp(int(payload["iat"]), tz=timezone.utc)
    return AccessTokenClaims(user_id=user_id, session_id=session_id, issued_at=issued_at)


def verify_access_token(token: str) -> str | None:
    """Return the user ID if the token is valid, otherwise None."""
    claims = decode_access_token(token)
    return claims.user_id if claims else None


def generate_opaque_token() -> str:
    return secrets.token_urlsafe(48)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def constant_time_equals(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))
