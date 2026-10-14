from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator


def validate_password_strength(value: str) -> str:
    if value.strip() != value:
        raise ValueError("Password must not start or end with whitespace")
    if len(set(value)) < 5:
        raise ValueError("Password is too repetitive")
    if not any(c.isalpha() for c in value) or not any(not c.isalpha() for c in value):
        raise ValueError("Password must contain letters and at least one number or symbol")
    return value


class UserRegister(BaseModel):
    email: EmailStr
    full_name: str = Field(min_length=2, max_length=255)
    password: str = Field(min_length=12, max_length=128)

    _check_password = field_validator("password")(validate_password_strength)

    @field_validator("full_name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        value = value.strip()
        if len(value) < 2:
            raise ValueError("Full name is too short")
        return value


class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    email: EmailStr
    full_name: str
    is_active: bool
    created_at: datetime
    email_verified: bool = False
    email_verified_at: datetime | None = None
    last_login_at: datetime | None = None
    job_title: str | None = None
    timezone: str | None = None
    last_organization_id: str | None = None


class UserProfileUpdate(BaseModel):
    full_name: str | None = Field(default=None, min_length=2, max_length=255)
    job_title: str | None = Field(default=None, max_length=120)
    timezone: str | None = Field(default=None, max_length=64)


class PasswordChange(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=12, max_length=128)

    _check_password = field_validator("new_password")(validate_password_strength)


class ActiveOrganizationUpdate(BaseModel):
    organization_id: str = Field(max_length=36)


class SessionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    family_id: str
    created_at: datetime
    last_used_at: datetime | None
    expires_at: datetime
    created_ip: str | None
    user_agent: str | None
    is_current: bool = False


class NotificationPreferenceType(BaseModel):
    type: str
    label: str
    default: bool
    email: bool


class NotificationPreferencesResponse(BaseModel):
    email_enabled: bool
    types: list[NotificationPreferenceType]
    email_delivery: str  # "console" (dev preview, not delivered) | "smtp"


class NotificationPreferencesUpdate(BaseModel):
    email_enabled: bool
    email_types: dict[str, bool] = Field(default_factory=dict, max_length=50)
