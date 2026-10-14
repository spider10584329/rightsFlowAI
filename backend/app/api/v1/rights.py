"""Rights ownership & publishing: shares, splits, split rules, split sheets,
ownership summaries and conflict review.

Roles: read = viewer; share / split sheet / conflict writes = manager;
split rules = admin.
"""

from datetime import date
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Path, Query, Request, status
from sqlalchemy import case, select
from sqlalchemy.orm import Session

from app.core.errors import ValidationFailedError
from app.core.permissions import OrgAdmin, OrgManager, OrgViewer
from app.db.mixins import utc_now
from app.db.session import get_db
from app.models.platform import AuditLog
from app.models.rights import OwnershipShare, RightsConflict, SplitRule, SplitSheet
from app.models.user import User
from app.schemas.common import MessageResponse, Page, PageParams, page_of, paginate
from app.schemas.organization import AuditLogResponse
from app.schemas.rights import (
    AssetType,
    ConflictAction,
    ConflictResponse,
    ConflictScanRequest,
    ConflictScanResponse,
    ConflictSeverity,
    ConflictStatus,
    ConflictType,
    OwnershipSummary,
    RightsSummary,
    RightsType,
    ShareCreate,
    ShareDispute,
    ShareMutationResponse,
    ShareResponse,
    ShareStatus,
    ShareSupersede,
    ShareUpdate,
    ShareVerify,
    SplitRuleCreate,
    SplitRuleResponse,
    SplitRuleUpdate,
    SplitSheetApply,
    SplitSheetApplyResponse,
    SplitSheetCreate,
    SplitSheetResponse,
    SplitSheetStatus,
    SplitSheetUpdate,
    SplitsReplace,
    SplitsReplaceResponse,
    ValidateRequest,
    ValidationResult,
    VerificationStatus,
)
from app.services import rights as svc
from app.services.rights_jobs import queue_rights_rescan
from app.services.reference import normalize_territory

router = APIRouter(prefix="/organizations/{organization_id}/rights", tags=["Rights"])

IdPath = Annotated[str, Path(max_length=36)]
IdQuery = Annotated[str | None, Query(max_length=36)]


def _territory_param(value: str | None) -> str | None:
    if value is None or not value.strip():
        return None
    code = normalize_territory(value)
    if code is None:
        raise ValidationFailedError(f"Unknown territory code: {value!r}", code="invalid_territory")
    return code


# --------------------------------------------------------------------------- shares


@router.get("/shares", response_model=Page[ShareResponse])
def list_shares(
    ctx: OrgViewer,
    db: Session = Depends(get_db),
    params: PageParams = Depends(),
    work_id: IdQuery = None,
    recording_id: IdQuery = None,
    party_id: IdQuery = None,
    rights_type: RightsType | None = None,
    status_filter: Annotated[ShareStatus | None, Query(alias="status")] = None,
    verification_status: VerificationStatus | None = None,
    territory: Annotated[str | None, Query(max_length=10)] = None,
):
    """List ownership shares with filters. ``territory`` returns shares whose
    scope covers that country (WORLD-wide shares included unless excluded)."""
    stmt = select(OwnershipShare).where(OwnershipShare.organization_id == ctx.organization_id)
    if work_id:
        stmt = stmt.where(OwnershipShare.work_id == work_id)
    if recording_id:
        stmt = stmt.where(OwnershipShare.recording_id == recording_id)
    if party_id:
        stmt = stmt.where(OwnershipShare.party_id == party_id)
    if rights_type:
        stmt = stmt.where(OwnershipShare.rights_type == rights_type)
    if status_filter:
        stmt = stmt.where(OwnershipShare.status == status_filter)
    if verification_status:
        stmt = stmt.where(OwnershipShare.verification_status == verification_status)
    code = _territory_param(territory)
    if code:
        stmt = stmt.where(svc.territory_filter(code))
    rows, total = paginate(
        db, stmt, params,
        sortable={
            "created_at": OwnershipShare.created_at,
            "share_percent": OwnershipShare.share_percent,
            "rights_type": OwnershipShare.rights_type,
            "effective_from": OwnershipShare.effective_from,
            "status": OwnershipShare.status,
        },
        default_sort=OwnershipShare.created_at.desc(),
    )
    return page_of([svc.share_payload(s) for s in rows], total, params)


@router.post("/shares", response_model=ShareMutationResponse, status_code=status.HTTP_201_CREATED)
def create_share(payload: ShareCreate, ctx: OrgManager, request: Request, db: Session = Depends(get_db)):
    """Create a share. Returns the share, the asset's validation summary and
    the conflicts currently detected for the asset. Rejected (422) when it
    would violate a blocking split rule."""
    return svc.create_share(db, ctx, payload, request)


@router.get("/shares/{share_id}", response_model=ShareResponse)
def get_share(share_id: IdPath, ctx: OrgViewer, db: Session = Depends(get_db)):
    return svc.share_payload(svc.get_share(db, ctx.organization_id, share_id))


@router.patch("/shares/{share_id}", response_model=ShareMutationResponse)
def update_share(
    share_id: IdPath, payload: ShareUpdate, ctx: OrgManager, request: Request,
    db: Session = Depends(get_db),
):
    """Edit an unverified share in place. Verified shares only accept notes /
    contract changes; anything material requires ``/supersede``."""
    return svc.update_share(db, ctx, share_id, payload, request)


@router.delete("/shares/{share_id}", response_model=ShareMutationResponse)
def archive_share(share_id: IdPath, ctx: OrgManager, request: Request, db: Session = Depends(get_db)):
    """Archive a share (shares are never hard-deleted)."""
    return svc.archive_share(db, ctx, share_id, request)


@router.post(
    "/shares/{share_id}/supersede",
    response_model=ShareMutationResponse,
    status_code=status.HTTP_201_CREATED,
)
def supersede_share(
    share_id: IdPath, payload: ShareSupersede, ctx: OrgManager, request: Request,
    db: Session = Depends(get_db),
):
    """Create a new share replacing this one (old status -> superseded)."""
    return svc.supersede_share(db, ctx, share_id, payload, request)


@router.post("/shares/{share_id}/verify", response_model=ShareMutationResponse)
def verify_share(
    share_id: IdPath, ctx: OrgManager, request: Request, db: Session = Depends(get_db),
    payload: ShareVerify | None = None,
):
    return svc.verify_share(db, ctx, share_id, payload.notes if payload else None, request)


@router.post("/shares/{share_id}/dispute", response_model=ShareMutationResponse)
def dispute_share(
    share_id: IdPath, payload: ShareDispute, ctx: OrgManager, request: Request,
    db: Session = Depends(get_db),
):
    return svc.dispute_share(db, ctx, share_id, payload.reason, request)


# --------------------------------------------------------------------------- assets


@router.put("/assets/{asset_type}/{asset_id}/splits", response_model=SplitsReplaceResponse)
def replace_splits(
    asset_type: AssetType, asset_id: IdPath, payload: SplitsReplace, ctx: OrgManager,
    request: Request, db: Session = Depends(get_db),
):
    """Atomically replace the active share set of one rights type. The new set
    is validated as a whole; blocking rule violations reject everything."""
    return svc.replace_splits(db, ctx, asset_type, asset_id, payload, request)


@router.get("/assets/{asset_type}/{asset_id}/ownership", response_model=OwnershipSummary)
def asset_ownership(
    asset_type: AssetType,
    asset_id: IdPath,
    ctx: OrgViewer,
    db: Session = Depends(get_db),
    on_date: date | None = None,
    territory: Annotated[str | None, Query(max_length=10)] = None,
):
    """Effective ownership per rights type on a date (default today), with
    totals per territory group, controlled vs non-controlled percentages and
    validation issues."""
    code = _territory_param(territory)
    if code == "WORLD":
        code = None
    return svc.ownership_summary(
        db, ctx.organization_id, asset_type, asset_id, on_date or utc_now().date(), code
    )


@router.get("/assets/{asset_type}/{asset_id}/history", response_model=Page[AuditLogResponse])
def asset_history(
    asset_type: AssetType,
    asset_id: IdPath,
    ctx: OrgViewer,
    db: Session = Depends(get_db),
    params: PageParams = Depends(),
):
    """Rights history: audit entries for every share (any status) of the asset."""
    asset = svc.get_asset(db, ctx.organization_id, asset_type, asset_id)
    column = OwnershipShare.work_id if asset_type == "work" else OwnershipShare.recording_id
    share_ids = select(OwnershipShare.id).where(
        OwnershipShare.organization_id == ctx.organization_id, column == asset.id
    )
    stmt = select(AuditLog).where(
        AuditLog.organization_id == ctx.organization_id,
        AuditLog.entity_type == "ownership_share",
        AuditLog.entity_id.in_(share_ids),
    )
    rows, total = paginate(
        db, stmt, params, sortable={"created_at": AuditLog.created_at},
        default_sort=AuditLog.created_at.desc(),
    )
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


@router.post("/validate", response_model=ValidationResult)
def validate_shares(payload: ValidateRequest, ctx: OrgViewer, db: Session = Depends(get_db)):
    """Dry-run validation of a proposed share set. Nothing is written."""
    return svc.validate_proposal(db, ctx.organization_id, payload)


# --------------------------------------------------------------------------- split rules


@router.get("/split-rules", response_model=list[SplitRuleResponse])
def list_split_rules(
    ctx: OrgViewer,
    db: Session = Depends(get_db),
    asset_type: AssetType | None = None,
    rights_type: RightsType | None = None,
):
    stmt = select(SplitRule).where(SplitRule.organization_id == ctx.organization_id)
    if asset_type:
        stmt = stmt.where(SplitRule.asset_type == asset_type)
    if rights_type:
        stmt = stmt.where(SplitRule.rights_type == rights_type)
    return db.scalars(
        stmt.order_by(SplitRule.asset_type, SplitRule.rights_type, SplitRule.territory)
    ).all()


@router.post("/split-rules", response_model=SplitRuleResponse, status_code=status.HTTP_201_CREATED)
def create_split_rule(payload: SplitRuleCreate, ctx: OrgAdmin, request: Request, db: Session = Depends(get_db)):
    """Create a rule; an org-wide conflict re-scan is queued in the background."""
    rule = svc.create_rule(db, ctx, payload, request)
    queue_rights_rescan(db, ctx.organization_id, ctx.user.id, "split_rule_created")
    return rule


@router.get("/split-rules/{rule_id}", response_model=SplitRuleResponse)
def get_split_rule(rule_id: IdPath, ctx: OrgViewer, db: Session = Depends(get_db)):
    return svc.get_rule(db, ctx.organization_id, rule_id)


@router.patch("/split-rules/{rule_id}", response_model=SplitRuleResponse)
def update_split_rule(
    rule_id: IdPath, payload: SplitRuleUpdate, ctx: OrgAdmin, request: Request,
    db: Session = Depends(get_db),
):
    rule = svc.update_rule(db, ctx, rule_id, payload, request)
    queue_rights_rescan(db, ctx.organization_id, ctx.user.id, "split_rule_updated")
    return rule


@router.delete("/split-rules/{rule_id}", response_model=MessageResponse)
def delete_split_rule(rule_id: IdPath, ctx: OrgAdmin, request: Request, db: Session = Depends(get_db)):
    svc.delete_rule(db, ctx, rule_id, request)
    queue_rights_rescan(db, ctx.organization_id, ctx.user.id, "split_rule_deleted")
    return MessageResponse(message="Split rule deleted; a conflict re-scan has been queued")


# --------------------------------------------------------------------------- split sheets


@router.get("/split-sheets", response_model=Page[SplitSheetResponse])
def list_split_sheets(
    ctx: OrgViewer,
    db: Session = Depends(get_db),
    params: PageParams = Depends(),
    work_id: IdQuery = None,
    status_filter: Annotated[SplitSheetStatus | None, Query(alias="status")] = None,
):
    stmt = select(SplitSheet).where(SplitSheet.organization_id == ctx.organization_id)
    if work_id:
        stmt = stmt.where(SplitSheet.work_id == work_id)
    if status_filter:
        stmt = stmt.where(SplitSheet.status == status_filter)
    rows, total = paginate(
        db, stmt, params,
        sortable={"created_at": SplitSheet.created_at, "title": SplitSheet.title,
                  "agreed_date": SplitSheet.agreed_date},
        default_sort=SplitSheet.created_at.desc(),
    )
    return page_of([svc.sheet_payload(db, s) for s in rows], total, params)


@router.post("/split-sheets", response_model=SplitSheetResponse, status_code=status.HTTP_201_CREATED)
def create_split_sheet(payload: SplitSheetCreate, ctx: OrgManager, request: Request, db: Session = Depends(get_db)):
    return svc.sheet_payload(db, svc.create_sheet(db, ctx, payload, request))


@router.get("/split-sheets/{sheet_id}", response_model=SplitSheetResponse)
def get_split_sheet(sheet_id: IdPath, ctx: OrgViewer, db: Session = Depends(get_db)):
    return svc.sheet_payload(db, svc.get_sheet(db, ctx.organization_id, sheet_id))


@router.patch("/split-sheets/{sheet_id}", response_model=SplitSheetResponse)
def update_split_sheet(
    sheet_id: IdPath, payload: SplitSheetUpdate, ctx: OrgManager, request: Request,
    db: Session = Depends(get_db),
):
    return svc.sheet_payload(db, svc.update_sheet(db, ctx, sheet_id, payload, request))


@router.delete("/split-sheets/{sheet_id}", response_model=MessageResponse)
def delete_split_sheet(sheet_id: IdPath, ctx: OrgManager, request: Request, db: Session = Depends(get_db)):
    svc.delete_sheet(db, ctx, sheet_id, request)
    return MessageResponse(message="Split sheet deleted")


@router.post("/split-sheets/{sheet_id}/apply", response_model=SplitSheetApplyResponse)
def apply_split_sheet(
    sheet_id: IdPath, payload: SplitSheetApply, ctx: OrgManager, request: Request,
    db: Session = Depends(get_db),
):
    """Create shares from the sheet's entries for the given rights types,
    territories and dates (source = split_sheet)."""
    return svc.apply_sheet(db, ctx, sheet_id, payload, request)


# --------------------------------------------------------------------------- conflicts

_SEVERITY_ORDER = case(
    {"low": 1, "medium": 2, "high": 3, "critical": 4}, value=RightsConflict.severity, else_=0
)


@router.get("/conflicts", response_model=Page[ConflictResponse])
def list_conflicts(
    ctx: OrgViewer,
    db: Session = Depends(get_db),
    params: PageParams = Depends(),
    status_filter: Annotated[ConflictStatus | None, Query(alias="status")] = None,
    severity: ConflictSeverity | None = None,
    conflict_type: Annotated[ConflictType | None, Query(alias="type")] = None,
    work_id: IdQuery = None,
    recording_id: IdQuery = None,
    rights_type: RightsType | None = None,
):
    stmt = select(RightsConflict).where(RightsConflict.organization_id == ctx.organization_id)
    if status_filter:
        stmt = stmt.where(RightsConflict.status == status_filter)
    if severity:
        stmt = stmt.where(RightsConflict.severity == severity)
    if conflict_type:
        stmt = stmt.where(RightsConflict.conflict_type == conflict_type)
    if work_id:
        stmt = stmt.where(RightsConflict.work_id == work_id)
    if recording_id:
        stmt = stmt.where(RightsConflict.recording_id == recording_id)
    if rights_type:
        stmt = stmt.where(RightsConflict.rights_type == rights_type)
    rows, total = paginate(
        db, stmt, params,
        sortable={
            "created_at": RightsConflict.created_at,
            "last_detected_at": RightsConflict.last_detected_at,
            "severity": _SEVERITY_ORDER,
        },
        default_sort=_SEVERITY_ORDER.desc(),
    )
    return page_of([svc.conflict_payload(c) for c in rows], total, params)


@router.post("/conflicts/scan", response_model=ConflictScanResponse)
def scan_conflicts(
    ctx: OrgManager, request: Request, db: Session = Depends(get_db),
    payload: ConflictScanRequest | None = None,
):
    """Re-run detection for one asset or the whole organization. Conflicts
    that are no longer detected keep their status (never auto-resolved)."""
    if payload and payload.asset_type and payload.asset_id:
        asset = svc.get_asset(db, ctx.organization_id, payload.asset_type, payload.asset_id)
        result = svc.detect_for_asset(
            db, ctx.organization_id, payload.asset_type, asset,
            actor_user_id=ctx.user.id, request=request,
        )
    else:
        result = svc.scan_organization(db, ctx.organization_id, actor_user_id=ctx.user.id, request=request)
    db.commit()
    by_type: dict[str, int] = {}
    by_severity: dict[str, int] = {}
    for conflict in result.detected:
        by_type[conflict.conflict_type] = by_type.get(conflict.conflict_type, 0) + 1
        by_severity[conflict.severity] = by_severity.get(conflict.severity, 0) + 1
    return {
        "scanned_assets": result.scanned_assets,
        "detected": len(result.detected),
        "new": len(result.new),
        "no_longer_detected": len(result.no_longer_detected),
        "by_type": by_type,
        "by_severity": by_severity,
        "scanned_at": result.scanned_at,
    }


@router.get("/conflicts/{conflict_id}", response_model=ConflictResponse)
def get_conflict(conflict_id: IdPath, ctx: OrgViewer, db: Session = Depends(get_db)):
    return svc.conflict_payload(svc.get_conflict(db, ctx.organization_id, conflict_id))


@router.post("/conflicts/{conflict_id}/{action}", response_model=ConflictResponse)
def transition_conflict(
    conflict_id: IdPath,
    action: Literal["acknowledge", "resolve", "dismiss", "reopen"],
    ctx: OrgManager,
    request: Request,
    db: Session = Depends(get_db),
    payload: ConflictAction | None = None,
):
    """Human review of a conflict. ``resolve`` and ``dismiss`` require notes."""
    conflict = svc.transition_conflict(
        db, ctx, conflict_id, action, payload.notes if payload else None, request
    )
    return svc.conflict_payload(conflict)


# --------------------------------------------------------------------------- summary


@router.get("/summary", response_model=RightsSummary)
def rights_summary(ctx: OrgViewer, db: Session = Depends(get_db)):
    return svc.rights_summary(db, ctx.organization_id)
