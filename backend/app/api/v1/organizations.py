from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.dependencies import get_current_user
from app.core.errors import ConflictError, NotFoundError, ValidationFailedError
from app.core.permissions import OrgAdmin, OrgOwner, OrgViewer
from app.core.rate_limit import enforce_rate_limit
from app.core.security import verify_password
from app.db.mixins import utc_now
from app.db.session import get_db
from app.models.invitation import OrganizationInvitation
from app.models.organization import Organization
from app.models.organization_membership import OrganizationMembership
from app.models.platform import AuditLog
from app.models.user import User
from app.schemas.common import MessageResponse, Page, PageParams, page_of, paginate
from app.schemas.organization import (
    AuditLogResponse,
    InvitationCreate,
    InvitationCreatedResponse,
    InvitationResponse,
    InvitationTokenRequest,
    OrganizationArchiveRequest,
    OrganizationCreate,
    OrganizationDetailResponse,
    OrganizationMemberRoleUpdate,
    OrganizationMembershipResponse,
    OrganizationResponse,
    OrganizationSettings,
    OrganizationUpdate,
    OwnershipTransferRequest,
)
from app.services import organization_service as svc
from app.services.audit import diff, record_audit, snapshot

router = APIRouter(prefix="/organizations", tags=["Organizations"])
invitations_router = APIRouter(prefix="/invitations", tags=["Invitations"])

ORG_PROFILE_FIELDS = [
    "name", "legal_name", "description", "website", "country_code",
    "default_currency", "timezone", "brand_color", "logo_url",
]


def _org_payload(org: Organization, role: str | None = None) -> dict:
    data = OrganizationResponse.model_validate(org).model_dump()
    data["role"] = role
    return data


def _invitation_payload(inv: OrganizationInvitation) -> dict:
    data = InvitationResponse.model_validate(inv).model_dump()
    data["organization_name"] = inv.organization.name if inv.organization else None
    return data


# --------------------------------------------------------------------------- organizations


@router.post("", response_model=OrganizationResponse, status_code=status.HTTP_201_CREATED)
def create_organization(
    payload: OrganizationCreate,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Create an organization and assign its creator as owner."""
    org = svc.create_organization(
        db, current_user, payload.name, payload.slug, payload.default_currency, request
    )
    return _org_payload(org, "owner")


@router.get("", response_model=list[OrganizationResponse])
def list_my_organizations(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """List active organizations the current user belongs to, with their role."""
    rows = db.execute(
        select(Organization, OrganizationMembership.role)
        .join(OrganizationMembership, OrganizationMembership.organization_id == Organization.id)
        .where(
            OrganizationMembership.user_id == current_user.id,
            OrganizationMembership.is_active.is_(True),
            Organization.is_active.is_(True),
        )
        .order_by(Organization.name)
    ).all()
    return [_org_payload(org, role) for org, role in rows]


@router.get("/{organization_id}", response_model=OrganizationDetailResponse)
def get_organization_details(ctx: OrgViewer, db: Session = Depends(get_db)):
    """Return organization details for an authorized member."""
    data = _org_payload(ctx.organization, ctx.role)
    data["settings"] = svc.org_settings(ctx.organization)
    data["member_count"] = svc.member_count(db, ctx.organization_id)
    return data


@router.patch("/{organization_id}", response_model=OrganizationDetailResponse)
def update_organization(
    payload: OrganizationUpdate, ctx: OrgAdmin, request: Request, db: Session = Depends(get_db)
):
    org = ctx.organization
    before = snapshot(org, ORG_PROFILE_FIELDS)
    for field, value in payload.model_dump(exclude_unset=True).items():
        if field == "name" and not value:
            continue
        setattr(org, field, value.strip() if isinstance(value, str) else value)
    changes = diff(before, snapshot(org, ORG_PROFILE_FIELDS))
    if changes:
        record_audit(
            db,
            action="organization.updated",
            actor_user_id=ctx.user.id,
            organization_id=org.id,
            entity_type="organization",
            entity_id=org.id,
            changes=changes,
            summary="Updated organization profile",
            request=request,
        )
    db.commit()
    db.refresh(org)
    return get_organization_details(ctx, db)


@router.get("/{organization_id}/settings", response_model=OrganizationSettings)
def get_settings(ctx: OrgViewer):
    return svc.org_settings(ctx.organization)


@router.put("/{organization_id}/settings", response_model=OrganizationSettings)
def update_settings(
    payload: OrganizationSettings, ctx: OrgAdmin, request: Request, db: Session = Depends(get_db)
):
    before = svc.org_settings(ctx.organization).model_dump()
    ctx.organization.settings = payload.model_dump()
    changes = diff(before, payload.model_dump())
    record_audit(
        db,
        action="organization.settings_updated",
        actor_user_id=ctx.user.id,
        organization_id=ctx.organization_id,
        entity_type="organization",
        entity_id=ctx.organization_id,
        changes=changes,
        request=request,
    )
    db.commit()
    return payload


@router.post("/{organization_id}/archive", response_model=MessageResponse)
def archive_organization(
    payload: OrganizationArchiveRequest, ctx: OrgOwner, request: Request, db: Session = Depends(get_db)
):
    """Deactivate the organization (data is retained). Owner only."""
    enforce_rate_limit(request, "password_confirm", extra_key=ctx.user.id, limit=5, window_seconds=900)
    if payload.confirm_slug != ctx.organization.slug:
        raise ValidationFailedError("Confirmation does not match the organization slug")
    if not verify_password(payload.password, ctx.user.hashed_password):
        raise ValidationFailedError("Password is incorrect", code="invalid_password")
    ctx.organization.is_active = False
    # Managed automation: remove the organization's workflows and keys from n8n.
    from app.services.automation.provisioner import managed_mode, request_reconcile

    if managed_mode():
        request_reconcile(db, ctx.organization_id, commit=False)
    record_audit(
        db,
        action="organization.archived",
        actor_user_id=ctx.user.id,
        organization_id=ctx.organization_id,
        entity_type="organization",
        entity_id=ctx.organization_id,
        request=request,
    )
    db.commit()
    return MessageResponse(message="Organization archived")


# --------------------------------------------------------------------------- members


@router.get("/{organization_id}/members", response_model=list[OrganizationMembershipResponse])
def list_organization_members(
    ctx: OrgViewer,
    db: Session = Depends(get_db),
    include_inactive: bool = False,
):
    """List organization members. Inactive members are visible to admins."""
    stmt = select(OrganizationMembership).where(
        OrganizationMembership.organization_id == ctx.organization_id
    )
    if not (include_inactive and ctx.has_role("admin")):
        stmt = stmt.where(OrganizationMembership.is_active.is_(True))
    members = db.scalars(stmt.order_by(OrganizationMembership.created_at)).all()
    return [svc.membership_payload(m) for m in members]


# Members join only through invitations: a direct "add by email" endpoint let
# admins enumerate registered accounts and enroll users without consent (audit A-04).


@router.patch(
    "/{organization_id}/members/{membership_id}/role",
    response_model=OrganizationMembershipResponse,
)
def update_organization_member_role(
    membership_id: str,
    payload: OrganizationMemberRoleUpdate,
    ctx: OrgAdmin,
    request: Request,
    db: Session = Depends(get_db),
):
    return svc.membership_payload(svc.change_role(db, ctx, membership_id, payload.role, request))


@router.patch(
    "/{organization_id}/members/{membership_id}/deactivate",
    response_model=OrganizationMembershipResponse,
)
def deactivate_organization_member(
    membership_id: str, ctx: OrgAdmin, request: Request, db: Session = Depends(get_db)
):
    return svc.membership_payload(svc.set_active(db, ctx, membership_id, False, request))


@router.patch(
    "/{organization_id}/members/{membership_id}/reactivate",
    response_model=OrganizationMembershipResponse,
)
def reactivate_organization_member(
    membership_id: str, ctx: OrgAdmin, request: Request, db: Session = Depends(get_db)
):
    return svc.membership_payload(svc.set_active(db, ctx, membership_id, True, request))


@router.delete("/{organization_id}/members/{membership_id}", response_model=MessageResponse)
def remove_organization_member(
    membership_id: str, ctx: OrgAdmin, request: Request, db: Session = Depends(get_db)
):
    svc.remove_member(db, ctx, membership_id, request)
    return MessageResponse(message="Member removed")


@router.post("/{organization_id}/leave", response_model=MessageResponse)
def leave_organization(ctx: OrgViewer, request: Request, db: Session = Depends(get_db)):
    svc.leave_organization(db, ctx, request)
    return MessageResponse(message="You left the organization")


@router.post(
    "/{organization_id}/transfer-ownership", response_model=OrganizationMembershipResponse
)
def transfer_ownership(
    payload: OwnershipTransferRequest, ctx: OrgOwner, request: Request, db: Session = Depends(get_db)
):
    """Transfer ownership to an active admin. Requires the owner's password
    and the organization slug as explicit confirmation. The previous owner
    becomes an admin."""
    # Password confirmation must not be a brute-force oracle (audit A-07).
    enforce_rate_limit(request, "password_confirm", extra_key=ctx.user.id, limit=5, window_seconds=900)
    target = svc.transfer_ownership(
        db, ctx, payload.new_owner_membership_id, payload.password, payload.confirm_slug, request
    )
    return svc.membership_payload(target)


# --------------------------------------------------------------------------- invitations (admin)


@router.get("/{organization_id}/invitations", response_model=list[InvitationResponse])
def list_invitations(
    ctx: OrgAdmin,
    db: Session = Depends(get_db),
    status_filter: Annotated[str | None, Query(alias="status", max_length=20)] = None,
):
    stmt = select(OrganizationInvitation).where(
        OrganizationInvitation.organization_id == ctx.organization_id
    )
    if status_filter:
        stmt = stmt.where(OrganizationInvitation.status == status_filter)
    invitations = db.scalars(stmt.order_by(OrganizationInvitation.created_at.desc())).all()
    return [_invitation_payload(i) for i in invitations]


@router.post(
    "/{organization_id}/invitations",
    response_model=InvitationCreatedResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_invitation(
    payload: InvitationCreate, ctx: OrgAdmin, request: Request, db: Session = Depends(get_db)
):
    invitation, url, delivery = svc.create_invitation(
        db, ctx, str(payload.email), payload.role, payload.message, request
    )
    data = _invitation_payload(invitation)
    data["invite_url"] = url
    data["email_delivery"] = delivery
    return data


@router.post(
    "/{organization_id}/invitations/{invitation_id}/revoke", response_model=InvitationResponse
)
def revoke_invitation(
    invitation_id: str, ctx: OrgAdmin, request: Request, db: Session = Depends(get_db)
):
    invitation = db.scalar(
        select(OrganizationInvitation).where(
            OrganizationInvitation.id == invitation_id,
            OrganizationInvitation.organization_id == ctx.organization_id,
        )
    )
    if invitation is None:
        raise NotFoundError("Invitation not found")
    if invitation.status != "pending":
        raise ConflictError(f"Invitation is already {invitation.status}")
    invitation.status = "revoked"
    invitation.responded_at = utc_now()
    record_audit(
        db,
        action="invitation.revoked",
        actor_user_id=ctx.user.id,
        organization_id=ctx.organization_id,
        entity_type="invitation",
        entity_id=invitation.id,
        summary=f"Revoked invitation for {invitation.email}",
        request=request,
    )
    db.commit()
    return _invitation_payload(invitation)


@router.post(
    "/{organization_id}/invitations/{invitation_id}/resend",
    response_model=InvitationCreatedResponse,
)
def resend_invitation(
    invitation_id: str, ctx: OrgAdmin, request: Request, db: Session = Depends(get_db)
):
    """Re-send a pending or expired invitation with a new link (old links stop working)."""
    invitation, url, delivery = svc.resend_invitation(db, ctx, invitation_id, request)
    data = _invitation_payload(invitation)
    data["invite_url"] = url
    data["email_delivery"] = delivery
    return data


# --------------------------------------------------------------------------- activity


@router.get("/{organization_id}/activity", response_model=Page[AuditLogResponse])
def organization_activity(
    ctx: OrgViewer,
    db: Session = Depends(get_db),
    params: PageParams = Depends(),
    entity_type: Annotated[str | None, Query(max_length=50)] = None,
    entity_id: Annotated[str | None, Query(max_length=36)] = None,
    action: Annotated[str | None, Query(max_length=80)] = None,
):
    """Organization activity history. Viewers and managers see business
    activity for a specific entity; the full security log requires admin."""
    stmt = select(AuditLog).where(AuditLog.organization_id == ctx.organization_id)
    if entity_type:
        stmt = stmt.where(AuditLog.entity_type == entity_type)
    if entity_id:
        stmt = stmt.where(AuditLog.entity_id == entity_id)
    if action:
        stmt = stmt.where(AuditLog.action.startswith(action))
    if not ctx.has_role("admin"):
        stmt = stmt.where(
            ~AuditLog.action.startswith("auth."),
            ~AuditLog.action.startswith("membership."),
            ~AuditLog.action.startswith("invitation."),
        )
    rows, total = paginate(db, stmt, params, sortable={"created_at": AuditLog.created_at},
                           default_sort=AuditLog.created_at.desc())
    actor_ids = {r.actor_user_id for r in rows if r.actor_user_id}
    names = (
        dict(db.execute(select(User.id, User.full_name).where(User.id.in_(actor_ids))).all())
        if actor_ids else {}
    )
    items = []
    for row in rows:
        data = AuditLogResponse.model_validate(row).model_dump()
        data["actor_name"] = names.get(row.actor_user_id)
        if not ctx.has_role("admin"):
            data["ip_address"] = None
        items.append(data)
    return page_of(items, total, params)


# --------------------------------------------------------------------------- invitations (invitee)


@invitations_router.get("/mine", response_model=list[InvitationResponse])
def my_invitations(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Pending invitations addressed to the user's (verified) email."""
    svc.require_verified_email(current_user)
    invitations = db.scalars(
        select(OrganizationInvitation).where(
            OrganizationInvitation.email == current_user.email,
            OrganizationInvitation.status == "pending",
            OrganizationInvitation.expires_at > utc_now(),
        )
    ).all()
    return [_invitation_payload(i) for i in invitations]


@invitations_router.post("/preview", response_model=InvitationResponse)
def preview_invitation(payload: InvitationTokenRequest, db: Session = Depends(get_db)):
    """Public: show which organization an invitation link is for."""
    return _invitation_payload(svc.find_invitation_by_token(db, payload.token))


@invitations_router.post("/accept", response_model=OrganizationMembershipResponse)
def accept_invitation(
    payload: InvitationTokenRequest,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    invitation = svc.find_invitation_by_token(db, payload.token)
    return svc.membership_payload(
        svc.accept_invitation(db, invitation, current_user, request, via_token=True))


@invitations_router.post("/decline", response_model=InvitationResponse)
def decline_invitation(
    payload: InvitationTokenRequest,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    invitation = svc.find_invitation_by_token(db, payload.token)
    return _invitation_payload(
        svc.decline_invitation(db, invitation, current_user, request, via_token=True))


def _my_invitation(db: Session, invitation_id: str, user: User) -> OrganizationInvitation:
    invitation = db.scalar(
        select(OrganizationInvitation).where(
            OrganizationInvitation.id == invitation_id,
            OrganizationInvitation.email == user.email,
        )
    )
    if invitation is None:
        raise NotFoundError("Invitation not found")
    return invitation


@invitations_router.post("/{invitation_id}/accept", response_model=OrganizationMembershipResponse)
def accept_invitation_by_id(
    invitation_id: str,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    svc.require_verified_email(current_user)
    invitation = _my_invitation(db, invitation_id, current_user)
    svc.expire_if_needed(db, invitation)
    return svc.membership_payload(
        svc.accept_invitation(db, invitation, current_user, request, via_token=False))


@invitations_router.post("/{invitation_id}/decline", response_model=InvitationResponse)
def decline_invitation_by_id(
    invitation_id: str,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    svc.require_verified_email(current_user)
    invitation = _my_invitation(db, invitation_id, current_user)
    return _invitation_payload(
        svc.decline_invitation(db, invitation, current_user, request, via_token=False))
