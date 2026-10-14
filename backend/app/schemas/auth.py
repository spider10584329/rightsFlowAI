from pydantic import BaseModel, EmailStr, Field, field_validator

from app.schemas.user import validate_password_strength


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    refresh_token: str | None = None
    refresh_expires_in: int | None = None


class RefreshRequest(BaseModel):
    refresh_token: str = Field(min_length=20, max_length=200)


class LogoutRequest(BaseModel):
    refresh_token: str | None = Field(default=None, max_length=200)


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    token: str = Field(min_length=20, max_length=200)
    new_password: str = Field(min_length=12, max_length=128)

    _check_password = field_validator("new_password")(validate_password_strength)


class VerifyEmailRequest(BaseModel):
    token: str = Field(min_length=20, max_length=200)
