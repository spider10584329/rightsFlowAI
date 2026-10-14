"""Merge duplicate catalog items.

The duplicate is folded into the survivor:

- Operational references move to the survivor: contributors, recording↔work
  links, ownership shares, split sheets, contract links, release tracks, and
  statement lines of statements that are not yet posted. Rows that would
  become exact duplicates are dropped.
- Empty fields on the survivor are filled from the duplicate (identifiers,
  alternate titles, external ids).
- Financial history is NOT rewritten. Posted statement lines, royalty
  allocations and ledger entries keep pointing at what they referenced when
  they were posted.
- The duplicate is archived, never deleted, with a note pointing at the
  survivor. The audit log records exactly what moved.
"""

from datetime import datetime
from typing import Any

from fastapi import Request
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.errors import ConflictError, NotFoundError, ValidationFailedError
from app.core.permissions import OrgContext
from app.db.mixins import utc_now
from app.models.catalog import (
    Party,
    Recording,
    RecordingContributor,
    RecordingWork,
    Release,
    ReleaseTrack,
    Work,
    WorkContributor,
)
from app.models.contract import ContractAsset, ContractParty, ContractRoyaltyTerm
from app.models.rights import OwnershipShare, SplitSheet
from app.models.royalty import Payee, RoyaltyRun, RoyaltyStatement, StatementLine
from app.services.audit import record_audit

MODELS = {"party": Party, "work": Work, "recording": Recording, "release": Release}


def _load(db: Session, model, organization_id: str, item_id: str):
    item = db.scalar(select(model).where(model.id == item_id, model.organization_id == organization_id)
                     .with_for_update().execution_options(populate_existing=True))
    if item is None:
        raise NotFoundError(f"{model.__name__} not found")
    return item


def _merge_note(survivor: Any, user_name: str, now: datetime) -> str:
    label = getattr(survivor, "title", None) or getattr(survivor, "name", "")
    return f"Merged into {label} ({survivor.id}) on {now:%Y-%m-%d} by {user_name}."


def _fill(survivor: Any, duplicate: Any, fields: list[str], filled: list[str]) -> None:
    for field in fields:
        if getattr(survivor, field) in (None, "") and getattr(duplicate, field) not in (None, ""):
            setattr(survivor, field, getattr(duplicate, field))
            filled.append(field)


def _merge_external_ids(survivor: Any, duplicate: Any, filled: list[str]) -> None:
    if duplicate.external_ids:
        merged = {**duplicate.external_ids, **(survivor.external_ids or {})}
        if merged != (survivor.external_ids or {}):
            survivor.external_ids = merged
            filled.append("external_ids")


def _unposted_line_filter(organization_id: str):
    posted = select(RoyaltyRun.statement_id).where(RoyaltyRun.status == "posted")
    return (
        StatementLine.organization_id == organization_id,
        StatementLine.statement_id.not_in(posted),
        StatementLine.statement_id.in_(
            select(RoyaltyStatement.id).where(RoyaltyStatement.status != "posted")
        ),
    )


def _discard_stale_runs(db: Session, organization_id: str, statement_ids: set[str]) -> None:
    if not statement_ids:
        return
    db.execute(update(RoyaltyRun).where(RoyaltyRun.statement_id.in_(statement_ids),
                                        RoyaltyRun.status == "calculated").values(status="discarded"))
    db.execute(update(RoyaltyStatement).where(RoyaltyStatement.id.in_(statement_ids),
                                              RoyaltyStatement.organization_id == organization_id,
                                              RoyaltyStatement.status == "calculated")
               .values(status="processed"))


def _move_lines(db: Session, organization_id: str, column, old: str, new: str) -> int:
    affected = set(db.scalars(select(StatementLine.statement_id).where(
        column == old, *_unposted_line_filter(organization_id))).all())
    result = db.execute(update(StatementLine).where(column == old, *_unposted_line_filter(organization_id))
                        .values({column.key: new}))
    _discard_stale_runs(db, organization_id, affected)
    return result.rowcount or 0


def _move_unique(db: Session, model, key_column, old: str, new: str, other_columns: list) -> int:
    """Re-point rows from old to new, deleting rows that would duplicate an
    existing survivor row (same values in ``other_columns``)."""
    moved = 0
    for row in db.scalars(select(model).where(key_column == old)).all():
        clash = db.scalar(select(model.id).where(
            key_column == new, *[col == getattr(row, col.key) for col in other_columns]))
        if clash:
            db.delete(row)
        else:
            setattr(row, key_column.key, new)
            moved += 1
    db.flush()
    return moved


def merge(db: Session, ctx: OrgContext, entity_type: str, survivor_id: str, duplicate_id: str,
          request: Request | None) -> tuple[Any, dict[str, Any]]:
    if entity_type not in MODELS:
        raise ValidationFailedError("Unknown entity type", details={"allowed": list(MODELS)})
    if survivor_id == duplicate_id:
        raise ValidationFailedError("Choose two different items to merge")
    model = MODELS[entity_type]
    # Lock in a stable order to avoid deadlocks between concurrent merges.
    first, second = sorted([survivor_id, duplicate_id])
    locked = {first: _load(db, model, ctx.organization_id, first),
              second: _load(db, model, ctx.organization_id, second)}
    survivor, duplicate = locked[survivor_id], locked[duplicate_id]
    if duplicate.status == "archived" and (duplicate.notes or "").startswith("Merged into"):
        raise ConflictError("That item was already merged into another item")
    if survivor.status == "archived":
        raise ConflictError("Restore the surviving item before merging into it")

    now = utc_now()
    moved: dict[str, int] = {}
    filled: list[str] = []
    org = ctx.organization_id

    if entity_type == "party":
        dup_payee = db.scalar(select(Payee).where(Payee.organization_id == org, Payee.party_id == duplicate.id))
        sur_payee = db.scalar(select(Payee).where(Payee.organization_id == org, Payee.party_id == survivor.id))
        if dup_payee and sur_payee:
            raise ConflictError(
                "Both parties have payee profiles with their own ledgers. Settle and deactivate one "
                "payee before merging.", code="merge_payee_conflict")
        if dup_payee:
            dup_payee.party_id = survivor.id
            moved["payee"] = 1
        moved["work_contributions"] = _move_unique(db, WorkContributor, WorkContributor.party_id, duplicate.id,
                                                   survivor.id, [WorkContributor.work_id, WorkContributor.role])
        moved["recording_contributions"] = _move_unique(
            db, RecordingContributor, RecordingContributor.party_id, duplicate.id, survivor.id,
            [RecordingContributor.recording_id, RecordingContributor.role])
        moved["contract_parties"] = _move_unique(db, ContractParty, ContractParty.party_id, duplicate.id,
                                                 survivor.id, [ContractParty.contract_id, ContractParty.role])
        moved["primary_artist_of"] = db.execute(update(Recording).where(
            Recording.organization_id == org, Recording.primary_artist_id == duplicate.id)
            .values(primary_artist_id=survivor.id)).rowcount or 0
        moved["label_of"] = db.execute(update(Release).where(
            Release.organization_id == org, Release.label_id == duplicate.id)
            .values(label_id=survivor.id)).rowcount or 0
        moved["royalty_terms"] = db.execute(update(ContractRoyaltyTerm).where(
            ContractRoyaltyTerm.organization_id == org, ContractRoyaltyTerm.payee_party_id == duplicate.id)
            .values(payee_party_id=survivor.id)).rowcount or 0
        moved["ownership_shares"] = db.execute(update(OwnershipShare).where(
            OwnershipShare.organization_id == org, OwnershipShare.party_id == duplicate.id)
            .values(party_id=survivor.id)).rowcount or 0
        sheets = 0
        for sheet in db.scalars(select(SplitSheet).where(SplitSheet.organization_id == org)).all():
            entries = sheet.entries or []
            if any(e.get("party_id") == duplicate.id for e in entries):
                sheet.entries = [{**e, "party_id": survivor.id} if e.get("party_id") == duplicate.id else e
                                 for e in entries]
                sheets += 1
        moved["split_sheets"] = sheets
        _fill(survivor, duplicate, ["legal_name", "email", "country_code", "ipi_number", "isni",
                                    "pro_affiliation"], filled)
        roles = sorted(set(survivor.roles or []) | set(duplicate.roles or []))
        if roles != sorted(survivor.roles or []):
            survivor.roles = roles
            filled.append("roles")
        _merge_external_ids(survivor, duplicate, filled)

    elif entity_type == "work":
        moved["contributors"] = _move_unique(db, WorkContributor, WorkContributor.work_id, duplicate.id,
                                             survivor.id, [WorkContributor.party_id, WorkContributor.role])
        moved["recording_links"] = _move_unique(db, RecordingWork, RecordingWork.work_id, duplicate.id,
                                                survivor.id, [RecordingWork.recording_id])
        moved["contract_links"] = _move_unique(db, ContractAsset, ContractAsset.work_id, duplicate.id,
                                               survivor.id, [ContractAsset.contract_id])
        moved["ownership_shares"], moved["duplicate_shares_superseded"] = _move_shares(
            db, org, "work", survivor, duplicate)
        moved["split_sheets"] = db.execute(update(SplitSheet).where(
            SplitSheet.organization_id == org, SplitSheet.work_id == duplicate.id)
            .values(work_id=survivor.id)).rowcount or 0
        moved["unposted_statement_lines"] = _move_lines(db, org, StatementLine.work_id, duplicate.id, survivor.id)
        _take_internal_code(db, survivor, duplicate, filled)
        _fill(survivor, duplicate, ["iswc", "language", "genre", "creation_year", "lyrics_excerpt"], filled)
        alternates = list(dict.fromkeys([*(survivor.alternate_titles or []),
                                         *([duplicate.title] if duplicate.title != survivor.title else []),
                                         *(duplicate.alternate_titles or [])]))
        if alternates != (survivor.alternate_titles or []):
            survivor.alternate_titles = alternates
            filled.append("alternate_titles")
        _merge_external_ids(survivor, duplicate, filled)

    elif entity_type == "recording":
        moved["contributors"] = _move_unique(
            db, RecordingContributor, RecordingContributor.recording_id, duplicate.id, survivor.id,
            [RecordingContributor.party_id, RecordingContributor.role])
        moved["work_links"] = _move_unique(db, RecordingWork, RecordingWork.recording_id, duplicate.id,
                                           survivor.id, [RecordingWork.work_id])
        moved["contract_links"] = _move_unique(db, ContractAsset, ContractAsset.recording_id, duplicate.id,
                                               survivor.id, [ContractAsset.contract_id])
        moved["release_tracks"] = db.execute(update(ReleaseTrack).where(
            ReleaseTrack.organization_id == org, ReleaseTrack.recording_id == duplicate.id)
            .values(recording_id=survivor.id)).rowcount or 0
        moved["ownership_shares"], moved["duplicate_shares_superseded"] = _move_shares(
            db, org, "recording", survivor, duplicate)
        moved["unposted_statement_lines"] = _move_lines(db, org, StatementLine.recording_id,
                                                        duplicate.id, survivor.id)
        _take_internal_code(db, survivor, duplicate, filled)
        _fill(survivor, duplicate, ["isrc", "version_title", "primary_artist_id", "display_artist",
                                    "duration_seconds", "recording_date", "p_line"], filled)
        _merge_external_ids(survivor, duplicate, filled)

    else:  # release
        existing = {t.recording_id for t in survivor.tracks}
        disc_max: dict[int, int] = {}
        for t in survivor.tracks:
            disc_max[t.disc_number] = max(disc_max.get(t.disc_number, 0), t.track_number)
        added = 0
        for track in sorted(duplicate.tracks, key=lambda t: (t.disc_number, t.track_number)):
            if track.recording_id in existing:
                continue
            disc_max[track.disc_number] = disc_max.get(track.disc_number, 0) + 1
            survivor.tracks.append(ReleaseTrack(organization_id=org, recording_id=track.recording_id,
                                                disc_number=track.disc_number,
                                                track_number=disc_max[track.disc_number]))
            existing.add(track.recording_id)
            added += 1
        moved["tracks_added"] = added
        _fill(survivor, duplicate, ["upc", "catalog_number", "label_id", "display_artist",
                                    "release_date", "c_line"], filled)
        _merge_external_ids(survivor, duplicate, filled)

    # Identifier fields copied above must be removed from the archived duplicate
    # so lookups (ISRC/ISWC/UPC matching, duplicate checks) resolve to the survivor.
    for field in ("isrc", "iswc", "upc", "ipi_number", "isni"):
        if field in filled and hasattr(duplicate, field):
            setattr(duplicate, field, None)
    duplicate.status = "archived"
    note = _merge_note(survivor, ctx.user.full_name, now)
    duplicate.notes = f"{note}\n{duplicate.notes}" if duplicate.notes else note
    db.flush()

    summary = {"moved": {k: v for k, v in moved.items() if v}, "filled_fields": filled}
    label = getattr(duplicate, "title", None) or getattr(duplicate, "name", "")
    for item, action in ((survivor, "catalog.merged_into"), (duplicate, "catalog.merged_away")):
        record_audit(db, action=action, actor_user_id=ctx.user.id, organization_id=org,
                     entity_type=entity_type, entity_id=item.id,
                     summary=f"Merged {entity_type} '{label}' ({duplicate.id}) into {survivor.id}",
                     changes=summary, request=request)

    if entity_type in ("work", "recording"):
        from app.services.rights import detect_conflicts

        detect_conflicts(db, org, **{f"{entity_type}_id": survivor.id})
    elif entity_type == "party" and moved.get("ownership_shares"):
        # Shares of many assets may now name the same party twice: re-scan.
        from app.services.rights_jobs import queue_rights_rescan

        queue_rights_rescan(db, org, ctx.user.id, reason="party_merge")
    db.commit()
    db.refresh(survivor)
    return survivor, summary


def _share_identity(share: OwnershipShare) -> tuple:
    return (share.party_id, share.role, share.rights_type, share.share_percent,
            tuple(sorted(share.territories or [])), tuple(sorted(share.excluded_territories or [])),
            share.effective_from, share.effective_to)


def _move_shares(db: Session, org: str, asset_type: str, survivor: Any, duplicate: Any) -> tuple[int, int]:
    """Move the duplicate's ownership shares onto the survivor (audit F-M5).

    Shares identical to an active survivor claim (the same split entered twice)
    are superseded rather than copied, which would double the claimed
    percentage. The result must still satisfy every blocking split rule; a
    merge that would break one is refused, like any other share write."""
    from app.services.rights import (
        CLAIM_STATUSES,
        _blocking_state,
        _enforce,
        analyze_asset,
    )

    column = OwnershipShare.work_id if asset_type == "work" else OwnershipShare.recording_id
    survivor_shares = db.scalars(select(OwnershipShare).where(
        OwnershipShare.organization_id == org, column == survivor.id,
        OwnershipShare.status.in_(CLAIM_STATUSES))).all()
    incoming = db.scalars(select(OwnershipShare).where(
        OwnershipShare.organization_id == org, column == duplicate.id)).all()
    rights_types = {s.rights_type for s in [*survivor_shares, *incoming]}
    # Violations the survivor already has may stay, but the merge must not add or worsen any.
    before = _blocking_state(analyze_asset(db, org, asset_type, survivor), rights_types)
    existing = {_share_identity(s) for s in survivor_shares}
    moved = superseded = 0
    for share in incoming:
        if share.status in CLAIM_STATUSES and _share_identity(share) in existing:
            share.status = "superseded"  # stays on the archived duplicate
            superseded += 1
            continue
        setattr(share, column.key, survivor.id)
        moved += 1
    db.flush()
    _enforce(db, before, analyze_asset(db, org, asset_type, survivor), rights_types)
    return moved, superseded


def _take_internal_code(db: Session, survivor: Any, duplicate: Any, filled: list[str]) -> None:
    if not survivor.internal_code and duplicate.internal_code:
        code = duplicate.internal_code
        duplicate.internal_code = None
        db.flush()  # free the unique (organization_id, internal_code) slot first
        survivor.internal_code = code
        filled.append("internal_code")


__all__ = ["MODELS", "merge"]
