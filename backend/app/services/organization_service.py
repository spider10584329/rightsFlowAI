"""Organization, membership and invitation business rules."""

from datetime import timedelta
from typing import Any

from fastapi import Request
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import (
    ConflictError,
    NotFoundError,
    PermissionDeniedError,
    ValidationFailedError,
)
from app.core.permissions import ROLE_RANK, OrgContext
from app.core.security import generate_opaque_token, hash_token, verify_password
from app.db.mixins import utc_now
from app.models.invitation import OrganizationInvitation
from app.models.organization import Organization
from app.models.organization_membership import OrganizationMembership
from app.models.user import User
from app.schemas.organization import OrganizationSettings
from app.services import billing
from app.services.audit import record_audit
from app.services.email import frontend_link, send_email
from app.services.notifications import notify_user


def org_settings(org: Organization) -> OrganizationSettings:
    return OrganizationSettings.model_validate(org.settings or {})


def membership_payload(membership: OrganizationMembership) -> dict[str, Any]:
    return {
        "id": membership.id,
        "organization_id": membership.organization_id,
        "user_id": membership.user_id,
        "role": membership.role,
        "is_active": membership.is_active,
        "created_at": membership.created_at,
        "updated_at": membership.updated_at,
        "user_email": membership.user.email if membership.user else None,
        "user_full_name": membership.user.full_name if membership.user else None,
    }


def create_organization(db: Session, user: User, name: str, slug: str, currency: str,
                        request: Request | None) -> Organization:
    if db.scalar(select(Organization.id).where(Organization.slug == slug)) is not None:
        raise ConflictError("Organization slug is already taken")
    organization = Organization(name=name, slug=slug, default_currency=currency,
                                settings=OrganizationSettings().model_dump())
    db.add(organization)
    db.flush()
    db.add(OrganizationMembership(organization_id=organization.id, user_id=user.id, role="owner"))
    billing.get_subscription(db, organization.id)
    if user.last_organization_id is None:
        user.last_organization_id = organization.id
    record_audit(
        db,
        action="organization.created",
        actor_user_id=user.id,
        organization_id=organization.id,
        entity_type="organization",
        entity_id=organization.id,
        summary=f"Created organization {name}",
        request=request,
    )
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise ConflictError("Organization slug is already taken") from exc
    db.refresh(organization)
    return organization


def get_target_membership(db: Session, organization_id: str, membership_id: str) -> OrganizationMembership:
    target = db.scalar(
        select(OrganizationMembership).where(
            OrganizationMembership.id == membership_id,
            OrganizationMembership.organization_id == organization_id,
        )
    )
    if target is None:
        raise NotFoundError("Organization membership not found")
    return target


def assert_can_manage(ctx: OrgContext, target: OrganizationMembership) -> None:
    """Owners manage everyone but themselves through these endpoints; admins
    manage managers and viewers only."""
    if target.role == "owner":
        raise PermissionDeniedError("Owner memberships can only change through ownership transfer")
    if target.user_id == ctx.user.id:
        raise PermissionDeniedError("You cannot change your own membership here")
    if ctx.role == "admin" and target.role == "admin":
        raise PermissionDeniedError("Admins cannot manage other admins")
    if not ctx.has_role("admin"):
        raise PermissionDeniedError("Insufficient organization permissions")


def assert_can_assign(ctx: OrgContext, role: str) -> None:
    if role == "admin" and ctx.role != "owner":
        raise PermissionDeniedError("Only organization owners can assign admin roles")


def change_role(db: Session, ctx: OrgContext, membership_id: str, role: str,
                request: Request | None) -> OrganizationMembership:
    target = get_target_membership(db, ctx.organization_id, membership_id)
    if not target.is_active:
        raise ConflictError("Reactivate the membership before changing its role")
    assert_can_manage(ctx, target)
    assert_can_assign(ctx, role)
    previous = target.role
    target.role = role
    record_audit(
        db,
        action="membership.role_changed",
        actor_user_id=ctx.user.id,
        organization_id=ctx.organization_id,
        entity_type="membership",
        entity_id=target.id,
        summary=f"{target.user.email}: {previous} → {role}",
        changes={"role": {"from": previous, "to": role}},
        request=request,
    )
    db.commit()
    db.refresh(target)
    return target


def set_active(db: Session, ctx: OrgContext, membership_id: str, active: bool,
               request: Request | None) -> OrganizationMembership:
    target = get_target_membership(db, ctx.organization_id, membership_id)
    assert_can_manage(ctx, target)
    if target.is_active == active:
        raise ConflictError(
            "Organization membership is already active" if active
            else "Organization membership is already inactive"
        )
    if active:
        billing.check_limit(db, ctx.organization_id, "max_users")
    target.is_active = active
    record_audit(
        db,
        action="membership.reactivated" if active else "membership.deactivated",
        actor_user_id=ctx.user.id,
        organization_id=ctx.organization_id,
        entity_type="membership",
        entity_id=target.id,
        summary=f"{'Reactivated' if active else 'Deactivated'} {target.user.email}",
        request=request,
    )
    db.commit()
    db.refresh(target)
    return target


def remove_member(db: Session, ctx: OrgContext, membership_id: str, request: Request | None) -> None:
    target = get_target_membership(db, ctx.organization_id, membership_id)
    assert_can_manage(ctx, target)
    email = target.user.email
    db.delete(target)
    record_audit(
        db,
        action="membership.removed",
        actor_user_id=ctx.user.id,
        organization_id=ctx.organization_id,
        entity_type="membership",
        entity_id=membership_id,
        summary=f"Removed {email}",
        request=request,
    )
    db.commit()


def leave_organization(db: Session, ctx: OrgContext, request: Request | None) -> None:
    if ctx.role == "owner":
        raise PermissionDeniedError(
            "Owners must transfer ownership before leaving the organization",
            code="ownership_transfer_required",
        )
    ctx.membership.is_active = False
    if ctx.user.last_organization_id == ctx.organization_id:
        ctx.user.last_organization_id = None
    record_audit(
        db,
        action="membership.left",
        actor_user_id=ctx.user.id,
        organization_id=ctx.organization_id,
        entity_type="membership",
        entity_id=ctx.membership.id,
        summary=f"{ctx.user.email} left the organization",
        request=request,
    )
    db.commit()


def transfer_ownership(db: Session, ctx: OrgContext, membership_id: str, password: str,
                       confirm_slug: str, request: Request | None) -> OrganizationMembership:
    if ctx.role != "owner":
        raise PermissionDeniedError("Only the owner can transfer ownership")
    if confirm_slug != ctx.organization.slug:
        raise ValidationFailedError("Confirmation does not match the organization slug")
    if not verify_password(password, ctx.user.hashed_password):
        raise ValidationFailedError("Password is incorrect", code="invalid_password")
    target = get_target_membership(db, ctx.organization_id, membership_id)
    if target.id == ctx.membership.id:
        raise ValidationFailedError("You already own this organization")
    if not target.is_active or not target.user.is_active:
        raise ValidationFailedError("The new owner must be an active member")
    if target.role != "admin":
        raise ValidationFailedError("Promote the member to admin before transferring ownership")

    target.role = "owner"
    ctx.membership.role = "admin"
    record_audit(
        db,
        action="organization.ownership_transferred",
        actor_user_id=ctx.user.id,
        organization_id=ctx.organization_id,
        entity_type="membership",
        entity_id=target.id,
        summary=f"Ownership transferred from {ctx.user.email} to {target.user.email}",
        request=request,
    )
    notify_user(
        db,
        user_id=target.user_id,
        organization_id=ctx.organization_id,
        type="ownership_transferred",
        title=f"You are now the owner of {ctx.organization.name}",
        link="/settings/organization",
    )
    db.commit()
    db.refresh(target)
    return target


# --------------------------------------------------------------------------- invitations


def create_invitation(db: Session, ctx: OrgContext, email: str, role: str, message: str | None,
                      request: Request | None) -> tuple[OrganizationInvitation, str, str]:
    assert_can_assign(ctx, role)
    email = email.strip().lower()
    existing_user = db.scalar(select(User).where(User.email == email))
    if existing_user is not None:
        membership = db.scalar(
            select(OrganizationMembership).where(
                OrganizationMembership.organization_id == ctx.organization_id,
                OrganizationMembership.user_id == existing_user.id,
            )
        )
        if membership is not None:
            raise ConflictError(
                "This person already has a membership"
                + ("" if membership.is_active else " (inactive — reactivate it instead)")
            )
    # Supersede earlier pending invitations to the same address.
    for pending in db.scalars(
        select(OrganizationInvitation).where(
            OrganizationInvitation.organization_id == ctx.organization_id,
            OrganizationInvitation.email == email,
            OrganizationInvitation.status == "pending",
        )
    ):
        pending.status = "revoked"
        pending.responded_at = utc_now()
    db.flush()
    billing.check_limit(db, ctx.organization_id, "max_users")

    raw = generate_opaque_token()
    invitation = OrganizationInvitation(
        organization_id=ctx.organization_id,
        email=email,
        role=role,
        token_hash=hash_token(raw),
        invited_by_id=ctx.user.id,
        expires_at=utc_now() + timedelta(days=settings.invitation_expire_days),
        message=message,
    )
    db.add(invitation)
    db.flush()
    url = frontend_link(f"/invitations/accept?token={raw}")
    sent = send_email(
        db,
        to=email,
        organization_id=ctx.organization_id,
        subject=f"You're invited to join {ctx.organization.name} on RightsFlow AI",
        template="invitation",
        body=(
            f"{ctx.user.full_name} invited you to join {ctx.organization.name} as {role}.\n\n"
            + (f"Message: {message}\n\n" if message else "")
            + f"Accept the invitation:\n{url}\n\n"
            f"This invitation expires in {settings.invitation_expire_days} days."
        ),
    )
    if existing_user is not None:
        notify_user(
            db,
            user_id=existing_user.id,
            organization_id=ctx.organization_id,
            type="invitation",
            title=f"Invitation to join {ctx.organization.name}",
            body=f"{ctx.user.full_name} invited you as {role}.",
            link="/onboarding",
        )
    record_audit(
        db,
        action="invitation.created",
        actor_user_id=ctx.user.id,
        organization_id=ctx.organization_id,
        entity_type="invitation",
        entity_id=invitation.id,
        summary=f"Invited {email} as {role}",
        request=request,
    )
    db.commit()
    db.refresh(invitation)
    return invitation, url, sent.status


def resend_invitation(db: Session, ctx: OrgContext, invitation_id: str,
                      request: Request | None) -> tuple[OrganizationInvitation, str, str]:
    """Issue a fresh link for a pending (or expired) invitation. The previous
    link stops working because only the new token's hash is stored."""
    invitation = db.scalar(
        select(OrganizationInvitation).where(
            OrganizationInvitation.id == invitation_id,
            OrganizationInvitation.organization_id == ctx.organization_id,
        ).with_for_update().execution_options(populate_existing=True)
    )
    if invitation is None:
        raise NotFoundError("Invitation not found")
    if invitation.status not in ("pending", "expired"):
        raise ConflictError(f"Invitation is {invitation.status}; create a new invitation instead")
    assert_can_assign(ctx, invitation.role)
    raw = generate_opaque_token()
    invitation.token_hash = hash_token(raw)
    invitation.status = "pending"
    invitation.expires_at = utc_now() + timedelta(days=settings.invitation_expire_days)
    url = frontend_link(f"/invitations/accept?token={raw}")
    sent = send_email(
        db,
        to=invitation.email,
        organization_id=ctx.organization_id,
        subject=f"Reminder: you're invited to join {ctx.organization.name} on RightsFlow AI",
        template="invitation",
        body=(
            f"{ctx.user.full_name} invited you to join {ctx.organization.name} as {invitation.role}.\n\n"
            f"Accept the invitation:\n{url}\n\n"
            f"This invitation expires in {settings.invitation_expire_days} days. Earlier links no "
            "longer work."
        ),
    )
    record_audit(
        db, action="invitation.resent", actor_user_id=ctx.user.id,
        organization_id=ctx.organization_id, entity_type="invitation", entity_id=invitation.id,
        summary=f"Resent invitation to {invitation.email}", request=request,
    )
    db.commit()
    db.refresh(invitation)
    return invitation, url, sent.status


def find_invitation_by_token(db: Session, raw: str) -> OrganizationInvitation:
    invitation = db.scalar(
        select(OrganizationInvitation).where(OrganizationInvitation.token_hash == hash_token(raw))
    )
    if invitation is None:
        raise NotFoundError("Invitation not found")
    return expire_if_needed(db, invitation)


def expire_if_needed(db: Session, invitation: OrganizationInvitation) -> OrganizationInvitation:
    if invitation.status == "pending" and invitation.expires_at <= utc_now():
        invitation.status = "expired"
        db.commit()
    return invitation


def _pending_for_user(invitation: OrganizationInvitation, user: User) -> None:
    if invitation.status != "pending":
        raise ConflictError(f"This invitation is {invitation.status}")
    if invitation.email != user.email:
        raise PermissionDeniedError("This invitation was sent to a different email address")


def require_verified_email(user: User) -> None:
    """Id-based invitation actions match on email address only, so the account
    must have proven it owns that mailbox (otherwise anyone could register an
    invitee's address and take the invitation)."""
    if user.email_verified_at is None:
        raise PermissionDeniedError(
            "Verify your email address to see and respond to invitations, or open the "
            "invitation link from your email.",
            code="email_verification_required",
        )


def accept_invitation(db: Session, invitation: OrganizationInvitation, user: User,
                      request: Request | None, *, via_token: bool) -> OrganizationMembership:
    """Accept an invitation. ``via_token`` means the caller presented the secret
    token from the invitation email, which proves mailbox ownership; otherwise
    the user's email must already be verified."""
    if not via_token:
        require_verified_email(user)
    _pending_for_user(invitation, user)
    existing = db.scalar(
        select(OrganizationMembership).where(
            OrganizationMembership.organization_id == invitation.organization_id,
            OrganizationMembership.user_id == user.id,
        )
    )
    if existing is not None and existing.is_active:
        raise ConflictError("You are already a member of this organization")
    # The invitation itself already counts toward the user limit, so the
    # membership replaces it rather than adding capacity.
    if existing is not None:
        existing.is_active = True
        existing.role = invitation.role
        membership = existing
    else:
        membership = OrganizationMembership(
            organization_id=invitation.organization_id, user_id=user.id, role=invitation.role
        )
        db.add(membership)
    invitation.status = "accepted"
    invitation.responded_at = utc_now()
    invitation.accepted_user_id = user.id
    # Only the emailed token proves mailbox ownership.
    if via_token and user.email_verified_at is None:
        user.email_verified_at = utc_now()
    user.last_organization_id = invitation.organization_id
    record_audit(
        db,
        action="invitation.accepted",
        actor_user_id=user.id,
        organization_id=invitation.organization_id,
        entity_type="invitation",
        entity_id=invitation.id,
        summary=f"{user.email} joined as {invitation.role}",
        request=request,
    )
    if invitation.invited_by_id:
        notify_user(
            db,
            user_id=invitation.invited_by_id,
            organization_id=invitation.organization_id,
            type="invitation_accepted",
            title=f"{user.full_name} accepted your invitation",
            link="/settings/team",
        )
    db.commit()
    db.refresh(membership)
    return membership


def decline_invitation(db: Session, invitation: OrganizationInvitation, user: User,
                       request: Request | None, *, via_token: bool) -> OrganizationInvitation:
    if not via_token:
        require_verified_email(user)
    _pending_for_user(invitation, user)
    invitation.status = "declined"
    invitation.responded_at = utc_now()
    record_audit(
        db,
        action="invitation.declined",
        actor_user_id=user.id,
        organization_id=invitation.organization_id,
        entity_type="invitation",
        entity_id=invitation.id,
        request=request,
    )
    db.commit()
    return invitation


def member_count(db: Session, organization_id: str) -> int:
    return db.scalar(
        select(func.count()).select_from(OrganizationMembership).where(
            OrganizationMembership.organization_id == organization_id,
            OrganizationMembership.is_active.is_(True),
        )
    ) or 0


def role_at_least(role: str, minimum: str) -> bool:
    return ROLE_RANK[role] >= ROLE_RANK[minimum]
