from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

ASSIGNABLE_ROLES = Literal["admin", "manager", "viewer"]


class OrganizationCreate(BaseModel):
    name: str = Field(min_length=2, max_length=255)
    slug: str = Field(
        min_length=3,
        max_length=100,
        pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$",
    )
    default_currency: str = Field(default="USD", pattern=r"^[A-Z]{3}$")

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        value = value.strip()
        if len(value) < 2:
            raise ValueError("Name is too short")
        return value


class OrganizationUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=255)
    legal_name: str | None = Field(default=None, max_length=255)
    description: str | None = Field(default=None, max_length=5000)
    website: str | None = Field(default=None, max_length=255, pattern=r"^https?://\S+$")
    country_code: str | None = Field(default=None, pattern=r"^[A-Z]{2}$")
    default_currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")
    timezone: str | None = Field(default=None, max_length=64)
    brand_color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    logo_url: str | None = Field(default=None, max_length=500, pattern=r"^https://\S+$")


class OrganizationSettings(BaseModel):
    """Behavioural settings stored on the organization."""

    allocation_basis: Literal["controlled_pro_rata", "gross_share"] = "controlled_pro_rata"
    require_distinct_payout_approver: bool = True
    contract_expiry_warning_days: int = Field(default=60, ge=1, le=365)
    auto_match_title_artist: bool = True
    ai_contract_analysis_enabled: bool = True


class OrganizationResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    slug: str
    is_active: bool
    created_at: datetime
    updated_at: datetime
    legal_name: str | None = None
    description: str | None = None
    website: str | None = None
    country_code: str | None = None
    default_currency: str = "USD"
    timezone: str = "UTC"
    brand_color: str | None = None
    logo_url: str | None = None
    role: str | None = None


class OrganizationDetailResponse(OrganizationResponse):
    settings: OrganizationSettings
    member_count: int = 0


class OrganizationMembershipResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    organization_id: str
    user_id: str
    role: str
    is_active: bool
    created_at: datetime
    updated_at: datetime
    user_email: str | None = None
    user_full_name: str | None = None


class OrganizationMemberAdd(BaseModel):
    """Request to add an existing user to an organization."""

    email: EmailStr
    role: ASSIGNABLE_ROLES


class OrganizationMemberRoleUpdate(BaseModel):
    """Request to update an organization member's role."""

    role: ASSIGNABLE_ROLES


class InvitationCreate(BaseModel):
    email: EmailStr
    role: ASSIGNABLE_ROLES
    message: str | None = Field(default=None, max_length=500)


class InvitationResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    organization_id: str
    email: str
    role: str
    status: str
    expires_at: datetime
    created_at: datetime
    responded_at: datetime | None = None
    invited_by_id: str | None = None
    message: str | None = None
    organization_name: str | None = None


class InvitationCreatedResponse(InvitationResponse):
    # Returned once so an admin can share the link manually when email
    # delivery isn't configured. Never retrievable again.
    invite_url: str
    email_delivery: str


class InvitationTokenRequest(BaseModel):
    token: str = Field(min_length=20, max_length=200)


class OwnershipTransferRequest(BaseModel):
    new_owner_membership_id: str = Field(max_length=36)
    password: str = Field(min_length=1, max_length=128)
    confirm_slug: str = Field(max_length=100)


class OrganizationArchiveRequest(BaseModel):
    password: str = Field(min_length=1, max_length=128)
    confirm_slug: str = Field(max_length=100)


class AuditLogResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    organization_id: str | None
    actor_user_id: str | None
    actor_name: str | None = None
    action: str
    entity_type: str | None
    entity_id: str | None
    summary: str | None
    changes: dict[str, Any] | None
    ip_address: str | None
    created_at: datetime
