"""Organization-scoped authorization.

Role hierarchy: owner > admin > manager > viewer.

=========================  =====  =======  =====  =====
Capability                 owner  admin    mgr    viewer
=========================  =====  =======  =====  =====
Read organization data       x      x       x      x
Create/edit catalog, rights  x      x       x
Contracts, statements, AI    x      x       x
Post royalties / ledger      x      x
Approve payouts              x      x
Invite / manage members      x      x (non-admin targets)
Organization settings        x      x
Assign admin, billing plan   x
Transfer ownership           x
=========================  =====  =======  =====  =====
"""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Path
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.dependencies import get_current_user
from app.core.errors import NotFoundError, PermissionDeniedError
from app.db.session import get_db
from app.models.organization import Organization
from app.models.organization_membership import OrganizationMembership
from app.models.user import User

ROLES = frozenset({"owner", "admin", "manager", "viewer"})
ROLE_RANK = {"viewer": 1, "manager": 2, "admin": 3, "owner": 4}


@dataclass
class OrgContext:
    """The authenticated user acting inside one organization."""

    user: User
    membership: OrganizationMembership
    organization: Organization

    @property
    def organization_id(self) -> str:
        return self.organization.id

    @property
    def role(self) -> str:
        return self.membership.role

    def has_role(self, minimum: str) -> bool:
        return ROLE_RANK[self.role] >= ROLE_RANK[minimum]

    def require(self, minimum: str) -> None:
        if not self.has_role(minimum):
            raise PermissionDeniedError("Insufficient organization permissions")


def load_membership(
    db: Session, organization_id: str, user_id: str
) -> tuple[OrganizationMembership, Organization] | None:
    row = db.execute(
        select(OrganizationMembership, Organization)
        .join(Organization, Organization.id == OrganizationMembership.organization_id)
        .where(
            OrganizationMembership.organization_id == organization_id,
            OrganizationMembership.user_id == user_id,
            OrganizationMembership.is_active.is_(True),
            Organization.is_active.is_(True),
        )
    ).first()
    return (row[0], row[1]) if row else None


def require_org_role(minimum: str) -> Callable[..., OrgContext]:
    """Dependency: active membership in ``{organization_id}`` with at least
    ``minimum`` role. Non-members get 404 so organization ids aren't probeable."""

    if minimum not in ROLES:
        raise ValueError(f"Unknown role {minimum!r}")

    def dependency(
        organization_id: Annotated[str, Path(max_length=36)],
        current_user: User = Depends(get_current_user),
        db: Session = Depends(get_db),
    ) -> OrgContext:
        found = load_membership(db, organization_id, current_user.id)
        if found is None:
            raise NotFoundError("Organization not found")
        membership, organization = found
        context = OrgContext(user=current_user, membership=membership, organization=organization)
        context.require(minimum)
        return context

    return dependency


# Convenience aliases for route signatures.
OrgViewer = Annotated[OrgContext, Depends(require_org_role("viewer"))]
OrgManager = Annotated[OrgContext, Depends(require_org_role("manager"))]
OrgAdmin = Annotated[OrgContext, Depends(require_org_role("admin"))]
OrgOwner = Annotated[OrgContext, Depends(require_org_role("owner"))]


def require_organization_role(allowed_roles: set[str]) -> Callable[..., OrganizationMembership]:
    """Backward-compatible dependency returning the membership for an exact
    set of allowed roles."""

    if not allowed_roles or not allowed_roles.issubset(ROLES):
        raise ValueError("Invalid organization roles")

    def check_permission(
        organization_id: Annotated[str, Path(max_length=36)],
        current_user: User = Depends(get_current_user),
        db: Session = Depends(get_db),
    ) -> OrganizationMembership:
        found = load_membership(db, organization_id, current_user.id)
        if found is None:
            raise NotFoundError("Organization not found")
        membership, _ = found
        if membership.role not in allowed_roles:
            raise PermissionDeniedError("Insufficient organization permissions")
        return membership

    return check_permission
