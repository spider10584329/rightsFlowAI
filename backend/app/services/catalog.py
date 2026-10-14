"""Music catalog business rules.

Covers parties, works, recordings and releases (CRUD with nested
contributors / links / tracks), bulk actions, deterministic metadata
validation, duplicate detection and completeness scoring.

Every query is scoped by ``organization_id``; ids received in payloads are
verified to belong to the same organization (404 otherwise).

Deletion policy: an item that other records depend on is never deleted.
- Parties: contributors, ownership shares, payees, contracts, contract terms,
  royalty allocations, recordings (primary artist) and releases (label).
- Works: ownership shares, split sheets, contract assets, statement lines,
  royalty allocations. Recording links are metadata and are removed with
  the work.
- Recordings: release tracks, ownership shares, contract assets, statement
  lines, royalty allocations.
- Releases: nothing depends on them; tracks are removed with the release.
Referenced items can be archived instead.
"""

import difflib
import re
import unicodedata
from collections import Counter, defaultdict
from collections.abc import Iterable
from itertools import combinations
from typing import Any

from fastapi import Request
from sqlalchemy import Select, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.errors import ConflictError, NotFoundError, ValidationFailedError
from app.core.permissions import OrgContext
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
from app.models.platform import AuditLog
from app.models.rights import OwnershipShare, SplitSheet
from app.models.royalty import Payee, RoyaltyAllocation, StatementLine
from app.models.user import User
from app.schemas.catalog import (
    PUBLISHER_ROLES,
    RECORDING_CONTRIBUTOR_ROLES,
    WORK_CONTRIBUTOR_ROLES,
    WRITER_ROLES,
    PartyCreate,
    PartyUpdate,
    RecordingContributorIn,
    RecordingCreate,
    RecordingUpdate,
    ReleaseCreate,
    ReleaseTrackIn,
    ReleaseUpdate,
    WorkContributorIn,
    WorkCreate,
    WorkUpdate,
)
from app.schemas.common import PageParams, paginate
from app.services import billing, identifiers
from app.services.audit import diff, record_audit, snapshot

ENTITY_MODELS: dict[str, type] = {
    "party": Party,
    "work": Work,
    "recording": Recording,
    "release": Release,
}
ENTITY_ORDER = ("work", "recording", "release", "party")
ENTITY_ALIASES = {
    "party": "party", "parties": "party",
    "work": "work", "works": "work",
    "recording": "recording", "recordings": "recording",
    "release": "release", "releases": "release",
}
ENTITY_LABELS = {"party": "Party", "work": "Work", "recording": "Recording", "release": "Release"}
# Entity types counted against the ``max_catalog_items`` plan limit.
LIMITED_TYPES = frozenset({"work", "recording", "release"})
WRITER_PARTY_ROLES = ("songwriter", "composer", "lyricist")

PARTY_FIELDS = [
    "name", "party_type", "roles", "legal_name", "email", "country_code", "ipi_number",
    "isni", "pro_affiliation", "is_internal", "external_ids", "notes", "status",
]
WORK_FIELDS = [
    "title", "alternate_titles", "iswc", "internal_code", "language", "genre",
    "creation_year", "lyrics_excerpt", "external_ids", "notes", "status",
    "verification_status",
]
RECORDING_FIELDS = [
    "title", "version_title", "isrc", "internal_code", "primary_artist_id", "display_artist",
    "duration_seconds", "recording_date", "p_line", "is_explicit", "external_ids", "notes",
    "status", "verification_status",
]
RELEASE_FIELDS = [
    "title", "release_type", "upc", "catalog_number", "label_id", "display_artist",
    "release_date", "c_line", "external_ids", "notes", "status",
]


def canonical_entity_type(value: str, allowed: Iterable[str] = ENTITY_ORDER) -> str:
    entity_type = ENTITY_ALIASES.get((value or "").strip().lower())
    if entity_type is None or entity_type not in allowed:
        raise ValidationFailedError(
            f"Unknown catalog entity type '{value}'",
            code="invalid_entity_type",
            details={"allowed": list(allowed)},
        )
    return entity_type


def entity_title(entity: Any) -> str:
    return entity.name if isinstance(entity, Party) else entity.title


# --------------------------------------------------------------------------- lookups


def _get(db: Session, model: type, organization_id: str, entity_id: str, label: str) -> Any:
    row = db.scalar(
        select(model).where(model.id == entity_id, model.organization_id == organization_id)
    )
    if row is None:
        raise NotFoundError(f"{label} not found")
    return row


def get_party(db: Session, organization_id: str, party_id: str) -> Party:
    return _get(db, Party, organization_id, party_id, "Party")


def get_work(db: Session, organization_id: str, work_id: str) -> Work:
    return _get(db, Work, organization_id, work_id, "Work")


def get_recording(db: Session, organization_id: str, recording_id: str) -> Recording:
    return _get(db, Recording, organization_id, recording_id, "Recording")


def get_release(db: Session, organization_id: str, release_id: str) -> Release:
    return _get(db, Release, organization_id, release_id, "Release")


def require_ids(db: Session, model: type, organization_id: str, ids: Iterable[str],
                label: str) -> dict[str, Any]:
    """Load rows by id within the organization; 404 listing any missing id."""
    unique = list(dict.fromkeys(i for i in ids if i))
    if not unique:
        return {}
    rows = db.scalars(
        select(model).where(model.organization_id == organization_id, model.id.in_(unique))
    ).all()
    found = {row.id: row for row in rows}
    missing = [i for i in unique if i not in found]
    if missing:
        raise NotFoundError(f"{label} not found", details={"ids": missing})
    return found


# --------------------------------------------------------------------------- query helpers


def _apply_status(stmt: Select, model: type, status: str | None, include_archived: bool) -> Select:
    if status:
        return stmt.where(model.status == status)
    if not include_archived:
        return stmt.where(model.status != "archived")
    return stmt


def _compact(value: str) -> str:
    return re.sub(r"[\s\-.]", "", value or "").upper()


def _has_value(column: Any, wanted: bool) -> Any:
    present = (column.is_not(None)) & (column != "")
    return present if wanted else ~present


def _upc_variants(upc: str) -> list[str]:
    core = upc.lstrip("0") or "0"
    return sorted({core.zfill(n) for n in (12, 13, 14) if len(core) <= n} | {upc})


# --------------------------------------------------------------------------- completeness

WORK_WEIGHTS = {
    "iswc": 30, "writers": 30, "publisher": 15, "language": 10, "genre": 5,
    "creation_year": 5, "internal_code": 5,
}
RECORDING_WEIGHTS = {
    "isrc": 25, "artist": 15, "linked_work": 20, "duration": 10, "contributors": 10,
    "p_line": 10, "recording_date": 5, "internal_code": 5,
}
RELEASE_WEIGHTS = {
    "upc": 25, "tracks": 25, "label": 15, "release_date": 15, "display_artist": 10,
    "c_line": 5, "catalog_number": 5,
}


def _score(weights: dict[str, int], present: dict[str, bool]) -> dict[str, Any]:
    missing = [key for key in weights if not present.get(key)]
    score = sum(weight for key, weight in weights.items() if present.get(key))
    return {"score": int(score), "missing": missing}


def completeness_score(entity: Any) -> dict[str, Any]:
    """Deterministic 0-100 metadata completeness for a work, recording or
    release, with the list of missing elements (highest weight first)."""
    if isinstance(entity, Work):
        roles = {c.role for c in entity.contributors}
        return _score(WORK_WEIGHTS, {
            "iswc": identifiers.is_valid_iswc(entity.iswc),
            "writers": bool(roles & WRITER_ROLES),
            "publisher": bool(roles & PUBLISHER_ROLES),
            "language": bool(entity.language),
            "genre": bool(entity.genre),
            "creation_year": entity.creation_year is not None,
            "internal_code": bool(entity.internal_code),
        })
    if isinstance(entity, Recording):
        return _score(RECORDING_WEIGHTS, {
            "isrc": identifiers.is_valid_isrc(entity.isrc),
            "artist": bool(entity.primary_artist_id or entity.display_artist),
            "linked_work": bool(entity.work_links),
            "duration": bool(entity.duration_seconds),
            "contributors": bool(entity.contributors),
            "p_line": bool(entity.p_line),
            "recording_date": entity.recording_date is not None,
            "internal_code": bool(entity.internal_code),
        })
    if isinstance(entity, Release):
        return _score(RELEASE_WEIGHTS, {
            "upc": identifiers.is_valid_upc(entity.upc),
            "tracks": bool(entity.tracks),
            "label": bool(entity.label_id),
            "release_date": entity.release_date is not None,
            "display_artist": bool(entity.display_artist),
            "c_line": bool(entity.c_line),
            "catalog_number": bool(entity.catalog_number),
        })
    raise TypeError(f"Completeness is not defined for {type(entity).__name__}")


# --------------------------------------------------------------------------- payloads


def party_payload(party: Party) -> dict[str, Any]:
    data = {field: getattr(party, field) for field in PARTY_FIELDS}
    data.update(
        id=party.id,
        organization_id=party.organization_id,
        roles=list(party.roles or []),
        created_at=party.created_at,
        updated_at=party.updated_at,
    )
    return data


def _role_index(roles: tuple[str, ...], role: str) -> int:
    return roles.index(role) if role in roles else len(roles)


def _work_contributors(work: Work) -> list[dict[str, Any]]:
    items = [
        {"id": c.id, "party_id": c.party_id, "party_name": c.party.name if c.party else None,
         "role": c.role}
        for c in work.contributors
    ]
    return sorted(items, key=lambda c: (_role_index(WORK_CONTRIBUTOR_ROLES, c["role"]),
                                        (c["party_name"] or "").casefold(), c["party_id"]))


def work_payload(work: Work) -> dict[str, Any]:
    data = {field: getattr(work, field) for field in WORK_FIELDS}
    data.update(
        id=work.id,
        organization_id=work.organization_id,
        iswc_display=identifiers.format_iswc(work.iswc) if work.iswc else None,
        contributors=_work_contributors(work),
        completeness=completeness_score(work),
        created_at=work.created_at,
        updated_at=work.updated_at,
    )
    return data


def _recording_artist(recording: Recording) -> str | None:
    if recording.display_artist:
        return recording.display_artist
    return recording.primary_artist.name if recording.primary_artist else None


def work_detail_payload(db: Session, work: Work) -> dict[str, Any]:
    data = work_payload(work)
    recordings = db.scalars(
        select(Recording)
        .join(RecordingWork, RecordingWork.recording_id == Recording.id)
        .where(RecordingWork.work_id == work.id, Recording.organization_id == work.organization_id)
        .order_by(Recording.title, Recording.id)
    ).unique().all()
    data["recordings"] = [
        {"id": r.id, "title": r.title, "version_title": r.version_title, "isrc": r.isrc,
         "artist": _recording_artist(r), "status": r.status}
        for r in recordings
    ]
    return data


def recording_payload(recording: Recording) -> dict[str, Any]:
    data = {field: getattr(recording, field) for field in RECORDING_FIELDS}
    contributors = [
        {"id": c.id, "party_id": c.party_id, "party_name": c.party.name if c.party else None,
         "role": c.role, "instrument": c.instrument}
        for c in recording.contributors
    ]
    contributors.sort(key=lambda c: (_role_index(RECORDING_CONTRIBUTOR_ROLES, c["role"]),
                                     (c["party_name"] or "").casefold(), c["party_id"]))
    works = [
        {"id": link.work.id, "title": link.work.title, "iswc": link.work.iswc,
         "status": link.work.status}
        for link in recording.work_links if link.work is not None
    ]
    works.sort(key=lambda w: (w["title"].casefold(), w["id"]))
    data.update(
        id=recording.id,
        organization_id=recording.organization_id,
        primary_artist_name=recording.primary_artist.name if recording.primary_artist else None,
        artist=_recording_artist(recording),
        contributors=contributors,
        works=works,
        completeness=completeness_score(recording),
        created_at=recording.created_at,
        updated_at=recording.updated_at,
    )
    return data


def recording_detail_payload(db: Session, recording: Recording) -> dict[str, Any]:
    data = recording_payload(recording)
    rows = db.execute(
        select(Release, ReleaseTrack.disc_number, ReleaseTrack.track_number)
        .join(ReleaseTrack, ReleaseTrack.release_id == Release.id)
        .where(ReleaseTrack.recording_id == recording.id,
               Release.organization_id == recording.organization_id)
        .order_by(Release.title, Release.id, ReleaseTrack.disc_number, ReleaseTrack.track_number)
    ).unique().all()
    data["releases"] = [
        {"id": rel.id, "title": rel.title, "upc": rel.upc, "disc_number": disc,
         "track_number": track, "status": rel.status}
        for rel, disc, track in rows
    ]
    return data


def release_payload(release: Release) -> dict[str, Any]:
    data = {field: getattr(release, field) for field in RELEASE_FIELDS}
    tracks = []
    for t in release.tracks:
        rec = t.recording
        tracks.append({
            "id": t.id,
            "recording_id": t.recording_id,
            "recording_title": rec.title if rec else None,
            "version_title": rec.version_title if rec else None,
            "isrc": rec.isrc if rec else None,
            "artist": _recording_artist(rec) if rec else None,
            "duration_seconds": rec.duration_seconds if rec else None,
            "disc_number": t.disc_number,
            "track_number": t.track_number,
        })
    tracks.sort(key=lambda t: (t["disc_number"], t["track_number"]))
    data.update(
        id=release.id,
        organization_id=release.organization_id,
        label_name=release.label.name if release.label else None,
        tracks=tracks,
        track_count=len(tracks),
        completeness=completeness_score(release),
        created_at=release.created_at,
        updated_at=release.updated_at,
    )
    return data


# --------------------------------------------------------------------------- shared rules


def _audit(db: Session, ctx: OrgContext | None, action: str, entity_type: str, entity_id: str,
           summary: str, changes: dict | None = None, request: Request | None = None,
           *, organization_id: str | None = None, actor_user_id: str | None = None) -> None:
    record_audit(
        db,
        action=action,
        actor_user_id=ctx.user.id if ctx else actor_user_id,
        organization_id=ctx.organization_id if ctx else organization_id,
        entity_type=entity_type,
        entity_id=entity_id,
        summary=summary,
        changes=changes or None,
        request=request,
    )


def check_internal_code(db: Session, model: type, organization_id: str, code: str | None,
                        exclude_id: str | None = None) -> None:
    if not code:
        return
    stmt = select(model.id).where(model.organization_id == organization_id,
                                  model.internal_code == code)
    if exclude_id:
        stmt = stmt.where(model.id != exclude_id)
    if db.scalar(stmt.limit(1)) is not None:
        raise ConflictError(
            f"Internal code '{code}' is already used in this catalog",
            code="duplicate_internal_code",
            details={"field": "internal_code"},
        )


def find_by_identifier(db: Session, organization_id: str, entity_type: str, value: str,
                       exclude_id: str | None = None) -> Any:
    """Existing work/recording/release with the same ISWC/ISRC/UPC."""
    if entity_type == "work":
        model, condition = Work, Work.iswc == value
    elif entity_type == "recording":
        model, condition = Recording, Recording.isrc == value
    else:
        model, condition = Release, Release.upc.in_(_upc_variants(value))
    stmt = select(model).where(model.organization_id == organization_id, condition)
    if exclude_id:
        stmt = stmt.where(model.id != exclude_id)
    return db.scalars(stmt.order_by(model.created_at, model.id).limit(1)).first()


IDENTIFIER_LABELS = {"work": "ISWC", "recording": "ISRC", "release": "UPC"}


def check_identifier_duplicate(db: Session, organization_id: str, entity_type: str,
                               value: str | None, exclude_id: str | None = None) -> None:
    if not value:
        return
    existing = find_by_identifier(db, organization_id, entity_type, value, exclude_id)
    if existing is not None:
        label = IDENTIFIER_LABELS[entity_type]
        raise ConflictError(
            f"A {entity_type} with {label} {value} already exists "
            f"('{existing.title}', status {existing.status}). "
            "Pass allow_duplicate=true to create it anyway.",
            code="duplicate_identifier",
            details={"field": label.lower(), "existing_id": existing.id},
        )


def _commit(db: Session) -> None:
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise ConflictError("The change conflicts with existing catalog data") from exc


def _check_restore_limit(db: Session, organization_id: str, entity_type: str,
                         current_status: str, new_status: str | None) -> None:
    if (entity_type in LIMITED_TYPES and current_status == "archived"
            and new_status in ("active", "draft")):
        billing.check_limit(db, organization_id, "max_catalog_items")


# --------------------------------------------------------------------------- references


def reference_counts(db: Session, organization_id: str, entity_type: str,
                     entity_id: str) -> dict[str, int]:
    """Non-zero counts of records that prevent deleting an entity."""
    checks: list[tuple[str, type, Any]] = []
    if entity_type == "party":
        checks = [
            ("work_contributors", WorkContributor, WorkContributor.party_id),
            ("recording_contributors", RecordingContributor, RecordingContributor.party_id),
            ("ownership_shares", OwnershipShare, OwnershipShare.party_id),
            ("payees", Payee, Payee.party_id),
            ("contracts", ContractParty, ContractParty.party_id),
            ("contract_terms", ContractRoyaltyTerm, ContractRoyaltyTerm.payee_party_id),
            ("royalty_allocations", RoyaltyAllocation, RoyaltyAllocation.party_id),
            ("recordings_as_primary_artist", Recording, Recording.primary_artist_id),
            ("releases_as_label", Release, Release.label_id),
        ]
    elif entity_type == "work":
        checks = [
            ("ownership_shares", OwnershipShare, OwnershipShare.work_id),
            ("split_sheets", SplitSheet, SplitSheet.work_id),
            ("contracts", ContractAsset, ContractAsset.work_id),
            ("statement_lines", StatementLine, StatementLine.work_id),
            ("royalty_allocations", RoyaltyAllocation, RoyaltyAllocation.work_id),
        ]
    elif entity_type == "recording":
        checks = [
            ("release_tracks", ReleaseTrack, ReleaseTrack.recording_id),
            ("ownership_shares", OwnershipShare, OwnershipShare.recording_id),
            ("contracts", ContractAsset, ContractAsset.recording_id),
            ("statement_lines", StatementLine, StatementLine.recording_id),
            ("royalty_allocations", RoyaltyAllocation, RoyaltyAllocation.recording_id),
        ]
    counts: dict[str, int] = {}
    for name, model, column in checks:
        count = db.scalar(
            select(func.count()).select_from(model).where(
                model.organization_id == organization_id, column == entity_id
            )
        ) or 0
        if count:
            counts[name] = int(count)
    if entity_type == "party":
        # Split-sheet parties live in a JSON list, out of reach of foreign keys:
        # deleting such a party left sheets pointing at nothing (audit D-12).
        sheets = sum(
            1
            for entries in db.scalars(select(SplitSheet.entries).where(SplitSheet.organization_id == organization_id))
            if any(isinstance(e, dict) and e.get("party_id") == entity_id for e in entries or [])
        )
        if sheets:
            counts["split_sheets"] = sheets
    return counts


def _describe_references(refs: dict[str, int]) -> str:
    return ", ".join(f"{name.replace('_', ' ')} ({count})" for name, count in refs.items())


def delete_entity(db: Session, ctx: OrgContext, entity_type: str, entity: Any,
                  request: Request | None) -> None:
    refs = reference_counts(db, ctx.organization_id, entity_type, entity.id)
    if refs:
        raise ConflictError(
            f"{ENTITY_LABELS[entity_type]} is referenced by {_describe_references(refs)} "
            "and cannot be deleted. Archive it instead.",
            code=f"{entity_type}_in_use",
            details={"references": refs, "suggestion": "archive"},
        )
    title = entity_title(entity)
    entity_id = entity.id
    db.delete(entity)
    _audit(db, ctx, f"{entity_type}.deleted", entity_type, entity_id,
           f"Deleted {entity_type} {title}", request=request)
    _commit(db)


# --------------------------------------------------------------------------- parties


def list_parties(db: Session, organization_id: str, params: PageParams, *, q: str | None = None,
                 role: str | None = None, party_type: str | None = None,
                 status: str | None = None, include_archived: bool = False,
                 is_internal: bool | None = None) -> tuple[list[Party], int]:
    stmt = select(Party).where(Party.organization_id == organization_id)
    stmt = _apply_status(stmt, Party, status, include_archived)
    if role:
        stmt = stmt.where(func.json_contains(Party.roles, f'"{role}"') == 1)
    if party_type:
        stmt = stmt.where(Party.party_type == party_type)
    if is_internal is not None:
        stmt = stmt.where(Party.is_internal.is_(is_internal))
    if q and q.strip():
        q = q.strip()
        conditions = [
            Party.name.contains(q, autoescape=True),
            Party.legal_name.contains(q, autoescape=True),
        ]
        digits = re.sub(r"\D", "", q)
        if len(digits) >= 3:
            conditions.append(Party.ipi_number.contains(digits, autoescape=True))
        compact = _compact(q)
        if len(compact) >= 3:
            conditions.append(Party.isni.contains(compact, autoescape=True))
        stmt = stmt.where(or_(*conditions))
    sortable = {
        "name": Party.name, "party_type": Party.party_type, "status": Party.status,
        "created_at": Party.created_at, "updated_at": Party.updated_at,
    }
    return paginate(db, stmt, params, sortable=sortable, default_sort=Party.name.asc())


def party_detail_payload(db: Session, party: Party) -> dict[str, Any]:
    data = party_payload(party)
    org = party.organization_id
    data["work_count"] = db.scalar(
        select(func.count(func.distinct(WorkContributor.work_id))).where(
            WorkContributor.organization_id == org, WorkContributor.party_id == party.id)
    ) or 0
    contributed = select(RecordingContributor.recording_id).where(
        RecordingContributor.organization_id == org, RecordingContributor.party_id == party.id)
    data["recording_count"] = db.scalar(
        select(func.count()).select_from(Recording).where(
            Recording.organization_id == org,
            or_(Recording.primary_artist_id == party.id, Recording.id.in_(contributed)))
    ) or 0
    data["release_count"] = db.scalar(
        select(func.count()).select_from(Release).where(
            Release.organization_id == org, Release.label_id == party.id)
    ) or 0
    refs = reference_counts(db, org, "party", party.id)
    data["references"] = refs
    data["is_referenced"] = bool(refs)
    return data


def create_party(db: Session, ctx: OrgContext, payload: PartyCreate,
                 request: Request | None) -> Party:
    party = Party(organization_id=ctx.organization_id, created_by_id=ctx.user.id,
                  **payload.model_dump())
    db.add(party)
    db.flush()
    _audit(db, ctx, "party.created", "party", party.id, f"Created party {party.name}",
           request=request)
    _commit(db)
    db.refresh(party)
    return party


def update_party(db: Session, ctx: OrgContext, party: Party, payload: PartyUpdate,
                 request: Request | None) -> Party:
    before = snapshot(party, PARTY_FIELDS)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(party, field, list(value) if field == "roles" else value)
    changes = diff(before, snapshot(party, PARTY_FIELDS))
    if changes:
        _audit(db, ctx, "party.updated", "party", party.id, f"Updated party {party.name}",
               changes, request)
    _commit(db)
    db.refresh(party)
    return party


# --------------------------------------------------------------------------- works


def _work_snapshot(work: Work) -> dict[str, Any]:
    data = snapshot(work, WORK_FIELDS)
    data["contributors"] = sorted(f"{c.party_id}:{c.role}" for c in work.contributors)
    return data


def sync_work_contributors(db: Session, work: Work, items: list[WorkContributorIn]) -> None:
    """Replace the contributor set (diff-based, so unchanged rows are kept)."""
    require_ids(db, Party, work.organization_id, [i.party_id for i in items], "Party")
    wanted = list(dict.fromkeys((i.party_id, i.role) for i in items))
    existing = {(c.party_id, c.role): c for c in work.contributors}
    for key, contributor in existing.items():
        if key not in wanted:
            work.contributors.remove(contributor)
    for party_id, role in wanted:
        if (party_id, role) not in existing:
            work.contributors.append(WorkContributor(
                organization_id=work.organization_id, party_id=party_id, role=role))


def list_works(db: Session, organization_id: str, params: PageParams, *, q: str | None = None,
               status: str | None = None, verification_status: str | None = None,
               has_iswc: bool | None = None, party_id: str | None = None,
               recording_id: str | None = None, language: str | None = None,
               genre: str | None = None, include_archived: bool = False) -> tuple[list[Work], int]:
    stmt = select(Work).where(Work.organization_id == organization_id)
    stmt = _apply_status(stmt, Work, status, include_archived)
    if verification_status:
        stmt = stmt.where(Work.verification_status == verification_status)
    if has_iswc is not None:
        stmt = stmt.where(_has_value(Work.iswc, has_iswc))
    if party_id:
        stmt = stmt.where(Work.id.in_(select(WorkContributor.work_id).where(
            WorkContributor.organization_id == organization_id,
            WorkContributor.party_id == party_id)))
    if recording_id:
        stmt = stmt.where(Work.id.in_(select(RecordingWork.work_id).where(
            RecordingWork.organization_id == organization_id,
            RecordingWork.recording_id == recording_id)))
    if language:
        stmt = stmt.where(Work.language == language)
    if genre:
        stmt = stmt.where(Work.genre == genre)
    if q and q.strip():
        q = q.strip()
        conditions = [
            Work.title.contains(q, autoescape=True),
            Work.internal_code.contains(q, autoescape=True),
        ]
        compact = _compact(q)
        if len(compact) >= 3:
            conditions.append(Work.iswc.contains(compact, autoescape=True))
        stmt = stmt.where(or_(*conditions))
    sortable = {
        "title": Work.title, "iswc": Work.iswc, "creation_year": Work.creation_year,
        "status": Work.status, "verification_status": Work.verification_status,
        "created_at": Work.created_at, "updated_at": Work.updated_at,
    }
    return paginate(db, stmt, params, sortable=sortable, default_sort=Work.title.asc())


def _emit_created(db: Session, ctx: OrgContext, event_type: str, entity_type: str, entity_id: str) -> None:
    """Outbox event for the automation metadata review (same transaction)."""
    if ctx.user.is_service_account:
        return
    from app.services.automation.events import emit_event_if_enabled

    emit_event_if_enabled(db, organization_id=ctx.organization_id, event_type=event_type,
               payload={"entity_type": entity_type, "entity_id": entity_id},
               dedupe_key=f"{event_type}:{entity_id}")


def create_work(db: Session, ctx: OrgContext, payload: WorkCreate, request: Request | None,
                allow_duplicate: bool = False) -> Work:
    org = ctx.organization_id
    billing.check_limit(db, org, "max_catalog_items")
    check_internal_code(db, Work, org, payload.internal_code)
    if not allow_duplicate:
        check_identifier_duplicate(db, org, "work", payload.iswc)
    work = Work(organization_id=org, created_by_id=ctx.user.id,
                **payload.model_dump(exclude={"contributors"}))
    db.add(work)
    sync_work_contributors(db, work, payload.contributors)
    db.flush()
    _audit(db, ctx, "work.created", "work", work.id, f"Created work {work.title}",
           request=request)
    _emit_created(db, ctx, "work.created", "work", work.id)
    _commit(db)
    db.refresh(work)
    return work


def update_work(db: Session, ctx: OrgContext, work: Work, payload: WorkUpdate,
                request: Request | None, allow_duplicate: bool = False) -> Work:
    org = ctx.organization_id
    values = payload.model_dump(exclude_unset=True, exclude={"contributors"})
    if "internal_code" in values and values["internal_code"] != work.internal_code:
        check_internal_code(db, Work, org, values["internal_code"], exclude_id=work.id)
    if values.get("iswc") and values["iswc"] != work.iswc and not allow_duplicate:
        check_identifier_duplicate(db, org, "work", values["iswc"], exclude_id=work.id)
    _check_restore_limit(db, org, "work", work.status, values.get("status"))
    before = _work_snapshot(work)
    for field, value in values.items():
        setattr(work, field, value)
    if payload.contributors is not None:
        sync_work_contributors(db, work, payload.contributors)
    db.flush()
    changes = diff(before, _work_snapshot(work))
    if changes:
        _audit(db, ctx, "work.updated", "work", work.id, f"Updated work {work.title}",
               changes, request)
    _commit(db)
    db.refresh(work)
    return work


# --------------------------------------------------------------------------- recordings


def _recording_snapshot(recording: Recording) -> dict[str, Any]:
    data = snapshot(recording, RECORDING_FIELDS)
    data["contributors"] = sorted(
        f"{c.party_id}:{c.role}:{c.instrument or ''}" for c in recording.contributors)
    data["work_ids"] = sorted(link.work_id for link in recording.work_links)
    return data


def sync_recording_contributors(db: Session, recording: Recording,
                                items: list[RecordingContributorIn]) -> None:
    require_ids(db, Party, recording.organization_id, [i.party_id for i in items], "Party")
    wanted: dict[tuple[str, str], str | None] = {}
    for item in items:
        wanted.setdefault((item.party_id, item.role), item.instrument)
    existing = {(c.party_id, c.role): c for c in recording.contributors}
    for key, contributor in existing.items():
        if key not in wanted:
            recording.contributors.remove(contributor)
        elif contributor.instrument != wanted[key]:
            contributor.instrument = wanted[key]
    for (party_id, role), instrument in wanted.items():
        if (party_id, role) not in existing:
            recording.contributors.append(RecordingContributor(
                organization_id=recording.organization_id, party_id=party_id, role=role,
                instrument=instrument))


def sync_recording_works(db: Session, recording: Recording, work_ids: list[str]) -> None:
    require_ids(db, Work, recording.organization_id, work_ids, "Work")
    wanted = list(dict.fromkeys(work_ids))
    existing = {link.work_id: link for link in recording.work_links}
    for work_id, link in existing.items():
        if work_id not in wanted:
            recording.work_links.remove(link)
    for work_id in wanted:
        if work_id not in existing:
            recording.work_links.append(RecordingWork(
                organization_id=recording.organization_id, work_id=work_id))


def _check_party(db: Session, organization_id: str, party_id: str | None, label: str) -> None:
    if party_id:
        require_ids(db, Party, organization_id, [party_id], label)


def list_recordings(db: Session, organization_id: str, params: PageParams, *,
                    q: str | None = None, status: str | None = None,
                    verification_status: str | None = None, has_isrc: bool | None = None,
                    has_work: bool | None = None, party_id: str | None = None,
                    work_id: str | None = None, release_id: str | None = None,
                    is_explicit: bool | None = None,
                    include_archived: bool = False) -> tuple[list[Recording], int]:
    stmt = select(Recording).where(Recording.organization_id == organization_id)
    stmt = _apply_status(stmt, Recording, status, include_archived)
    if verification_status:
        stmt = stmt.where(Recording.verification_status == verification_status)
    if has_isrc is not None:
        stmt = stmt.where(_has_value(Recording.isrc, has_isrc))
    linked = select(RecordingWork.recording_id).where(
        RecordingWork.organization_id == organization_id)
    if has_work is not None:
        stmt = stmt.where(Recording.id.in_(linked) if has_work else Recording.id.not_in(linked))
    if work_id:
        stmt = stmt.where(Recording.id.in_(linked.where(RecordingWork.work_id == work_id)))
    if party_id:
        stmt = stmt.where(or_(
            Recording.primary_artist_id == party_id,
            Recording.id.in_(select(RecordingContributor.recording_id).where(
                RecordingContributor.organization_id == organization_id,
                RecordingContributor.party_id == party_id)),
        ))
    if release_id:
        stmt = stmt.where(Recording.id.in_(select(ReleaseTrack.recording_id).where(
            ReleaseTrack.organization_id == organization_id,
            ReleaseTrack.release_id == release_id)))
    if is_explicit is not None:
        stmt = stmt.where(Recording.is_explicit.is_(is_explicit))
    if q and q.strip():
        q = q.strip()
        conditions = [
            Recording.title.contains(q, autoescape=True),
            Recording.version_title.contains(q, autoescape=True),
            Recording.display_artist.contains(q, autoescape=True),
            Recording.internal_code.contains(q, autoescape=True),
            Recording.primary_artist_id.in_(select(Party.id).where(
                Party.organization_id == organization_id,
                Party.name.contains(q, autoescape=True))),
        ]
        compact = _compact(q)
        if len(compact) >= 3:
            conditions.append(Recording.isrc.contains(compact, autoescape=True))
        stmt = stmt.where(or_(*conditions))
    sortable = {
        "title": Recording.title, "isrc": Recording.isrc,
        "duration_seconds": Recording.duration_seconds,
        "recording_date": Recording.recording_date, "status": Recording.status,
        "verification_status": Recording.verification_status,
        "created_at": Recording.created_at, "updated_at": Recording.updated_at,
    }
    return paginate(db, stmt, params, sortable=sortable, default_sort=Recording.title.asc())


def create_recording(db: Session, ctx: OrgContext, payload: RecordingCreate,
                     request: Request | None, allow_duplicate: bool = False) -> Recording:
    org = ctx.organization_id
    billing.check_limit(db, org, "max_catalog_items")
    _check_party(db, org, payload.primary_artist_id, "Primary artist")
    check_internal_code(db, Recording, org, payload.internal_code)
    if not allow_duplicate:
        check_identifier_duplicate(db, org, "recording", payload.isrc)
    recording = Recording(organization_id=org, created_by_id=ctx.user.id,
                          **payload.model_dump(exclude={"contributors", "work_ids"}))
    db.add(recording)
    sync_recording_contributors(db, recording, payload.contributors)
    sync_recording_works(db, recording, payload.work_ids)
    db.flush()
    _audit(db, ctx, "recording.created", "recording", recording.id,
           f"Created recording {recording.title}", request=request)
    _emit_created(db, ctx, "recording.created", "recording", recording.id)
    _commit(db)
    db.refresh(recording)
    return recording


def update_recording(db: Session, ctx: OrgContext, recording: Recording,
                     payload: RecordingUpdate, request: Request | None,
                     allow_duplicate: bool = False) -> Recording:
    org = ctx.organization_id
    values = payload.model_dump(exclude_unset=True, exclude={"contributors", "work_ids"})
    if values.get("primary_artist_id"):
        _check_party(db, org, values["primary_artist_id"], "Primary artist")
    if "internal_code" in values and values["internal_code"] != recording.internal_code:
        check_internal_code(db, Recording, org, values["internal_code"], exclude_id=recording.id)
    if values.get("isrc") and values["isrc"] != recording.isrc and not allow_duplicate:
        check_identifier_duplicate(db, org, "recording", values["isrc"], exclude_id=recording.id)
    _check_restore_limit(db, org, "recording", recording.status, values.get("status"))
    before = _recording_snapshot(recording)
    for field, value in values.items():
        setattr(recording, field, value)
    if payload.contributors is not None:
        sync_recording_contributors(db, recording, payload.contributors)
    if payload.work_ids is not None:
        sync_recording_works(db, recording, payload.work_ids)
    db.flush()
    changes = diff(before, _recording_snapshot(recording))
    if changes:
        _audit(db, ctx, "recording.updated", "recording", recording.id,
               f"Updated recording {recording.title}", changes, request)
    _commit(db)
    db.refresh(recording)
    return recording


# --------------------------------------------------------------------------- releases


def _release_snapshot(release: Release) -> dict[str, Any]:
    data = snapshot(release, RELEASE_FIELDS)
    data["tracks"] = sorted(
        f"{t.disc_number}-{t.track_number}:{t.recording_id}" for t in release.tracks)
    return data


def sync_release_tracks(db: Session, release: Release, items: list[ReleaseTrackIn]) -> None:
    require_ids(db, Recording, release.organization_id, [i.recording_id for i in items],
                "Recording")
    wanted = {(i.disc_number, i.track_number): i.recording_id for i in items}
    existing = {(t.disc_number, t.track_number): t for t in release.tracks}
    for position, track in existing.items():
        if position not in wanted:
            release.tracks.remove(track)
        elif track.recording_id != wanted[position]:
            track.recording_id = wanted[position]
    for (disc, number), recording_id in wanted.items():
        if (disc, number) not in existing:
            release.tracks.append(ReleaseTrack(
                organization_id=release.organization_id, recording_id=recording_id,
                disc_number=disc, track_number=number))


def list_releases(db: Session, organization_id: str, params: PageParams, *,
                  q: str | None = None, status: str | None = None,
                  release_type: str | None = None, has_upc: bool | None = None,
                  label_id: str | None = None, recording_id: str | None = None,
                  include_archived: bool = False) -> tuple[list[Release], int]:
    stmt = select(Release).where(Release.organization_id == organization_id)
    stmt = _apply_status(stmt, Release, status, include_archived)
    if release_type:
        stmt = stmt.where(Release.release_type == release_type)
    if has_upc is not None:
        stmt = stmt.where(_has_value(Release.upc, has_upc))
    if label_id:
        stmt = stmt.where(Release.label_id == label_id)
    if recording_id:
        stmt = stmt.where(Release.id.in_(select(ReleaseTrack.release_id).where(
            ReleaseTrack.organization_id == organization_id,
            ReleaseTrack.recording_id == recording_id)))
    if q and q.strip():
        q = q.strip()
        conditions = [
            Release.title.contains(q, autoescape=True),
            Release.display_artist.contains(q, autoescape=True),
            Release.catalog_number.contains(q, autoescape=True),
        ]
        digits = re.sub(r"\D", "", q)
        if len(digits) >= 3:
            conditions.append(Release.upc.contains(digits, autoescape=True))
        stmt = stmt.where(or_(*conditions))
    sortable = {
        "title": Release.title, "release_date": Release.release_date, "upc": Release.upc,
        "release_type": Release.release_type, "status": Release.status,
        "created_at": Release.created_at, "updated_at": Release.updated_at,
    }
    return paginate(db, stmt, params, sortable=sortable, default_sort=Release.title.asc())


def create_release(db: Session, ctx: OrgContext, payload: ReleaseCreate,
                   request: Request | None, allow_duplicate: bool = False) -> Release:
    org = ctx.organization_id
    billing.check_limit(db, org, "max_catalog_items")
    _check_party(db, org, payload.label_id, "Label")
    if not allow_duplicate:
        check_identifier_duplicate(db, org, "release", payload.upc)
    release = Release(organization_id=org, created_by_id=ctx.user.id,
                      **payload.model_dump(exclude={"tracks"}))
    db.add(release)
    sync_release_tracks(db, release, payload.tracks)
    db.flush()
    _audit(db, ctx, "release.created", "release", release.id,
           f"Created release {release.title}", request=request)
    _commit(db)
    db.refresh(release)
    return release


def update_release(db: Session, ctx: OrgContext, release: Release, payload: ReleaseUpdate,
                   request: Request | None, allow_duplicate: bool = False) -> Release:
    org = ctx.organization_id
    values = payload.model_dump(exclude_unset=True, exclude={"tracks"})
    if values.get("label_id"):
        _check_party(db, org, values["label_id"], "Label")
    if values.get("upc") and values["upc"] != release.upc and not allow_duplicate:
        check_identifier_duplicate(db, org, "release", values["upc"], exclude_id=release.id)
    _check_restore_limit(db, org, "release", release.status, values.get("status"))
    before = _release_snapshot(release)
    for field, value in values.items():
        setattr(release, field, value)
    if payload.tracks is not None:
        sync_release_tracks(db, release, payload.tracks)
    db.flush()
    changes = diff(before, _release_snapshot(release))
    if changes:
        _audit(db, ctx, "release.updated", "release", release.id,
               f"Updated release {release.title}", changes, request)
    _commit(db)
    db.refresh(release)
    return release


# --------------------------------------------------------------------------- bulk actions


def bulk_action(db: Session, ctx: OrgContext, entity_type: str, action: str, ids: list[str],
                request: Request | None) -> dict[str, Any]:
    """Archive, restore or delete many items. Deleting requires admin and
    skips referenced items; every skip is reported with a reason."""
    if action == "delete":
        ctx.require("admin")
    org = ctx.organization_id
    model = ENTITY_MODELS[entity_type]
    ids = list(dict.fromkeys(ids))
    rows = {
        row.id: row
        for row in db.scalars(
            select(model).where(model.organization_id == org, model.id.in_(ids))
        ).unique().all()
    }
    if action == "restore" and entity_type in LIMITED_TYPES:
        restorable = sum(1 for row in rows.values() if row.status == "archived")
        if restorable:
            billing.check_limit(db, org, "max_catalog_items", increment=restorable)

    affected: list[str] = []
    skipped: list[dict[str, str]] = []
    for entity_id in ids:
        row = rows.get(entity_id)
        if row is None:
            skipped.append({"id": entity_id, "reason": "Not found"})
            continue
        title = entity_title(row)
        if action == "archive":
            if row.status == "archived":
                skipped.append({"id": entity_id, "reason": "Already archived"})
                continue
            previous, row.status = row.status, "archived"
            _audit(db, ctx, f"{entity_type}.archived", entity_type, entity_id,
                   f"Archived {entity_type} {title}",
                   {"status": {"from": previous, "to": "archived"}}, request)
        elif action == "restore":
            if row.status != "archived":
                skipped.append({"id": entity_id, "reason": "Not archived"})
                continue
            row.status = "active"
            _audit(db, ctx, f"{entity_type}.restored", entity_type, entity_id,
                   f"Restored {entity_type} {title}",
                   {"status": {"from": "archived", "to": "active"}}, request)
        else:
            refs = reference_counts(db, org, entity_type, entity_id)
            if refs:
                skipped.append({"id": entity_id,
                                "reason": f"Referenced by {_describe_references(refs)}"})
                continue
            db.delete(row)
            db.flush()
            _audit(db, ctx, f"{entity_type}.deleted", entity_type, entity_id,
                   f"Deleted {entity_type} {title}", request=request)
        affected.append(entity_id)
    _commit(db)
    return {
        "entity_type": entity_type,
        "action": action,
        "affected": len(affected),
        "affected_ids": affected,
        "skipped": skipped,
    }


# --------------------------------------------------------------------------- validation


def _active(db: Session, model: type, organization_id: str) -> list[Any]:
    order = model.name if model is Party else model.title
    return list(db.scalars(
        select(model).where(model.organization_id == organization_id,
                            model.status != "archived").order_by(order, model.id)
    ).unique().all())


ISSUE_SEVERITY_ORDER = {"error": 0, "warning": 1, "info": 2}


def validation_issues(db: Session, organization_id: str,
                      entity_type: str | None = None) -> list[dict[str, Any]]:
    """Deterministic metadata problems for non-archived catalog items."""
    types = [entity_type] if entity_type else list(ENTITY_ORDER)
    issues: list[dict[str, Any]] = []

    def add(kind: str, entity: Any, code: str, severity: str, message: str) -> None:
        issues.append({"entity_type": kind, "entity_id": entity.id,
                       "title": entity_title(entity), "code": code,
                       "severity": severity, "message": message})

    if "work" in types:
        linked = set(db.scalars(select(RecordingWork.work_id).where(
            RecordingWork.organization_id == organization_id)).all())
        for work in _active(db, Work, organization_id):
            if not work.iswc:
                add("work", work, "missing_iswc", "warning", "Work has no ISWC")
            elif not identifiers.is_valid_iswc(work.iswc):
                add("work", work, "invalid_iswc", "error", f"ISWC '{work.iswc}' is invalid")
            roles = {c.role for c in work.contributors}
            if not roles:
                add("work", work, "missing_contributors", "error", "Work has no contributors")
            elif not roles & WRITER_ROLES:
                add("work", work, "no_writers", "error",
                    "Work has no writers (composer, lyricist or arranger)")
            if work.id not in linked:
                add("work", work, "no_recordings", "info", "Work is not linked to any recording")

    if "recording" in types:
        for rec in _active(db, Recording, organization_id):
            if not rec.isrc:
                add("recording", rec, "missing_isrc", "warning", "Recording has no ISRC")
            elif not identifiers.is_valid_isrc(rec.isrc):
                add("recording", rec, "invalid_isrc", "error", f"ISRC '{rec.isrc}' is invalid")
            if not rec.work_links:
                add("recording", rec, "no_linked_work", "warning",
                    "Recording is not linked to a work")
            if not rec.primary_artist_id and not rec.display_artist:
                add("recording", rec, "missing_artist", "error", "Recording has no artist")
            if not rec.contributors:
                add("recording", rec, "missing_contributors", "info",
                    "Recording has no contributors")
            if not rec.duration_seconds:
                add("recording", rec, "missing_duration", "info", "Recording has no duration")

    if "release" in types:
        for rel in _active(db, Release, organization_id):
            if not rel.upc:
                add("release", rel, "missing_upc", "warning", "Release has no UPC/EAN")
            elif not identifiers.is_valid_upc(rel.upc):
                add("release", rel, "invalid_upc", "error", f"UPC '{rel.upc}' is invalid")
            if not rel.tracks:
                add("release", rel, "no_tracks", "error", "Release has no tracks")
            if not rel.label_id:
                add("release", rel, "missing_label", "info", "Release has no label")
            if rel.release_date is None:
                add("release", rel, "missing_release_date", "info", "Release has no release date")

    if "party" in types:
        for party in _active(db, Party, organization_id):
            roles = set(party.roles or [])
            if party.ipi_number and not identifiers.is_valid_ipi(party.ipi_number):
                add("party", party, "invalid_ipi", "error",
                    f"IPI '{party.ipi_number}' is invalid")
            elif not party.ipi_number and roles & {*WRITER_PARTY_ROLES, "publisher"}:
                add("party", party, "missing_ipi", "warning",
                    "Writer or publisher has no IPI name number")
            if party.isni and not identifiers.is_valid_isni(party.isni):
                add("party", party, "invalid_isni", "error", f"ISNI '{party.isni}' is invalid")
            if not roles:
                add("party", party, "missing_roles", "info", "Party has no roles")

    issues.sort(key=lambda i: (ENTITY_ORDER.index(i["entity_type"]),
                               ISSUE_SEVERITY_ORDER[i["severity"]], i["title"].casefold(),
                               i["entity_id"], i["code"]))
    return issues


# --------------------------------------------------------------------------- duplicates

DUPLICATE_THRESHOLD = 0.85
_FEAT_BRACKET = re.compile(r"\s*[(\[]\s*(?:feat\.?|ft\.?|featuring)\s[^)\]]*[)\]]", re.I)
_REMASTER_BRACKET = re.compile(r"\s*[(\[][^)\]]*\bre-?master(?:ed)?\b[^)\]]*[)\]]", re.I)
_REMASTER_DASH = re.compile(r"\s+[-–—]\s+[^-–—]*\bre-?master(?:ed)?\b.*$", re.I)
_FEAT_TRAILING = re.compile(r"\s+(?:feat\.?|ft\.?|featuring)\s.*$", re.I)


def _basic_normalize(value: str | None) -> str:
    text = unicodedata.normalize("NFKD", value or "")
    text = "".join(ch for ch in text if not unicodedata.combining(ch)).casefold()
    text = text.replace("&", " and ")
    text = re.sub(r"[\W_]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def normalize_title(title: str | None) -> str:
    """Casefold, strip accents, "feat." credits, remaster suffixes and
    punctuation: ``"Song (feat. X) - 2011 Remaster"`` -> ``"song"``."""
    text = title or ""
    for pattern in (_FEAT_BRACKET, _REMASTER_BRACKET, _REMASTER_DASH, _FEAT_TRAILING):
        text = pattern.sub("", text)
    return _basic_normalize(text)


def _ratio(a: str, b: str) -> float:
    if a == b:
        return 1.0
    return difflib.SequenceMatcher(None, a, b).ratio()


def _duplicate_items(db: Session, organization_id: str, entity_type: str) -> list[dict[str, Any]]:
    model = ENTITY_MODELS[entity_type]
    rows = db.scalars(
        select(model).where(model.organization_id == organization_id,
                            model.status != "archived").order_by(model.created_at, model.id)
    ).unique().all()
    items = []
    for row in rows:
        item: dict[str, Any] = {"id": row.id, "title": entity_title(row), "idents": {},
                                "artist": "", "contributors": set()}
        if entity_type == "party":
            item["norm"] = _basic_normalize(row.name)
            if row.ipi_number:
                item["idents"]["ipi"] = identifiers.normalize_ipi(row.ipi_number)
            if row.isni:
                item["idents"]["isni"] = row.isni
        else:
            item["norm"] = normalize_title(row.title)
        if entity_type == "work":
            if row.iswc:
                item["idents"]["iswc"] = row.iswc
            item["contributors"] = {c.party_id for c in row.contributors
                                    if c.role in WRITER_ROLES} or {c.party_id for c in row.contributors}
        elif entity_type == "recording":
            if row.isrc:
                item["idents"]["isrc"] = row.isrc
            item["artist"] = _basic_normalize(_recording_artist(row))
        elif entity_type == "release":
            if row.upc:
                item["idents"]["upc"] = row.upc.lstrip("0")
            item["artist"] = _basic_normalize(row.display_artist)
        items.append(item)
    return items


def _similarity(entity_type: str, a: dict[str, Any], b: dict[str, Any]) -> tuple[float, list[str]]:
    title_score = _ratio(a["norm"], b["norm"])
    label = "name" if entity_type == "party" else "title"
    reasons = [f"Same normalized {label}" if title_score == 1.0
               else f"Similar {label} ({title_score:.2f})"]
    score = title_score
    if entity_type in ("recording", "release") and a["artist"] and b["artist"]:
        artist_score = _ratio(a["artist"], b["artist"])
        score = 0.7 * title_score + 0.3 * artist_score
        if artist_score == 1.0:
            reasons.append("Same artist")
        elif artist_score >= 0.8:
            reasons.append(f"Similar artist ({artist_score:.2f})")
        else:
            reasons.append("Different artist")
    elif entity_type == "work" and a["contributors"] and b["contributors"]:
        shared = a["contributors"] & b["contributors"]
        jaccard = len(shared) / len(a["contributors"] | b["contributors"])
        score = 0.7 * title_score + 0.3 * jaccard
        reasons.append(f"Shared writers ({len(shared)})" if shared else "No shared writers")
    for key, value in a["idents"].items():
        other = b["idents"].get(key)
        if other and other != value:
            score -= 0.2
            reasons.append(f"Different {key.upper()}s")
            break
    return max(0.0, min(1.0, score)), reasons


def find_duplicate_candidates(db: Session, organization_id: str, entity_type: str,
                              limit: int = 100) -> list[dict]:
    """Deterministic duplicate candidates among non-archived items.

    Identical ISRC/ISWC/UPC (IPI/ISNI for parties) scores 1.0. Otherwise
    titles are normalized (casefold, accents, punctuation, "feat." and
    remaster suffixes removed) and compared with ``difflib.SequenceMatcher``,
    blended with artist (recordings/releases) or shared-writer (works)
    similarity. Pairs with different identifiers of the same kind are
    penalized. Pairs scoring at least 0.85 are returned, best first.
    """
    entity_type = canonical_entity_type(entity_type)
    items = _duplicate_items(db, organization_id, entity_type)
    pairs: dict[tuple[str, str], dict[str, Any]] = {}

    def add(a: dict, b: dict, score: float, reasons: list[str]) -> None:
        key = (a["id"], b["id"])
        current = pairs.get(key)
        if current is None or score > current["score"]:
            pairs[key] = {"entity_type": entity_type, "ids": [a["id"], b["id"]],
                          "titles": [a["title"], b["title"]], "score": round(score, 4),
                          "reasons": reasons}

    # 1. Exact identifier matches.
    groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for item in items:
        for key, value in item["idents"].items():
            groups[(key, value)].append(item)
    for (key, value), group in sorted(groups.items()):
        display = value
        if key == "iswc":
            display = identifiers.format_iswc(value) or value
        for a, b in combinations(group, 2):
            add(a, b, 1.0, [f"Same {key.upper()} {display}"])

    # 2. Title similarity, blocked by the first character of the normalized title.
    buckets: dict[str, list[dict]] = defaultdict(list)
    for item in items:
        if item["norm"]:
            buckets[item["norm"][0]].append(item)
    min_title = 0.78
    for bucket_key in sorted(buckets):
        for a, b in combinations(buckets[bucket_key], 2):
            if (a["id"], b["id"]) in pairs and pairs[(a["id"], b["id"])]["score"] >= 1.0:
                continue
            if a["norm"] != b["norm"]:
                matcher = difflib.SequenceMatcher(None, a["norm"], b["norm"])
                if matcher.real_quick_ratio() < min_title or matcher.quick_ratio() < min_title:
                    continue
            score, reasons = _similarity(entity_type, a, b)
            if score >= DUPLICATE_THRESHOLD:
                add(a, b, score, reasons)

    results = sorted(pairs.values(),
                     key=lambda p: (-p["score"], p["titles"][0].casefold(),
                                    p["titles"][1].casefold(), p["ids"]))
    return results[: max(0, limit)]


# --------------------------------------------------------------------------- completeness summary

COMPLETENESS_BANDS = ("complete", "high", "medium", "low")


def completeness_band(score: int) -> str:
    if score >= 100:
        return "complete"
    if score >= 80:
        return "high"
    if score >= 50:
        return "medium"
    return "low"


def completeness_summary(db: Session, organization_id: str,
                         entity_type: str | None = None, top: int = 20) -> dict[str, Any]:
    types = [entity_type] if entity_type else ["work", "recording", "release"]
    items: list[dict[str, Any]] = []
    by_type: dict[str, dict[str, Any]] = {}
    for kind in types:
        scores = []
        for entity in _active(db, ENTITY_MODELS[kind], organization_id):
            result = completeness_score(entity)
            scores.append(result["score"])
            items.append({"entity_type": kind, "id": entity.id, "title": entity.title, **result})
        by_type[kind] = {
            "count": len(scores),
            "average_score": round(sum(scores) / len(scores), 1) if scores else 0.0,
        }
    bands = {band: 0 for band in COMPLETENESS_BANDS}
    for item in items:
        bands[completeness_band(item["score"])] += 1
    least = sorted(items, key=lambda i: (i["score"], ENTITY_ORDER.index(i["entity_type"]),
                                         i["title"].casefold(), i["id"]))[:top]
    total = len(items)
    return {
        "count": total,
        "average_score": round(sum(i["score"] for i in items) / total, 1) if total else 0.0,
        "bands": bands,
        "by_entity_type": by_type,
        "least_complete": least,
    }


# --------------------------------------------------------------------------- overview


def catalog_summary(db: Session, organization_id: str, recent: int = 10) -> dict[str, Any]:
    counts: dict[str, int] = {}
    archived: dict[str, int] = {}
    for kind in ENTITY_ORDER:
        model = ENTITY_MODELS[kind]
        rows = db.execute(
            select(model.status, func.count()).where(model.organization_id == organization_id)
            .group_by(model.status)
        ).all()
        by_status = {status: int(n) for status, n in rows}
        archived[kind] = by_status.get("archived", 0)
        counts[kind] = sum(n for status, n in by_status.items() if status != "archived")

    role_counter: Counter[str] = Counter()
    for roles in db.scalars(select(Party.roles).where(
            Party.organization_id == organization_id, Party.status != "archived")).all():
        role_counter.update(set(roles or []))

    def count(model: type, *conditions: Any) -> int:
        return int(db.scalar(select(func.count()).select_from(model).where(
            model.organization_id == organization_id, model.status != "archived",
            *conditions)) or 0)

    writers = select(WorkContributor.work_id).where(
        WorkContributor.organization_id == organization_id,
        WorkContributor.role.in_(sorted(WRITER_ROLES)))
    linked = select(RecordingWork.recording_id).where(
        RecordingWork.organization_id == organization_id)
    tracked = select(ReleaseTrack.release_id).where(
        ReleaseTrack.organization_id == organization_id)
    writer_party = or_(*[func.json_contains(Party.roles, f'"{r}"') == 1
                         for r in WRITER_PARTY_ROLES])
    missing = {
        "works_without_iswc": count(Work, _has_value(Work.iswc, False)),
        "works_without_writers": count(Work, Work.id.not_in(writers)),
        "recordings_without_isrc": count(Recording, _has_value(Recording.isrc, False)),
        "recordings_without_work": count(Recording, Recording.id.not_in(linked)),
        "releases_without_upc": count(Release, _has_value(Release.upc, False)),
        "releases_without_tracks": count(Release, Release.id.not_in(tracked)),
        "writers_without_ipi": count(Party, writer_party, _has_value(Party.ipi_number, False)),
    }

    recent_items: list[dict[str, Any]] = []
    for kind in ENTITY_ORDER:
        model = ENTITY_MODELS[kind]
        for row in db.scalars(select(model).where(model.organization_id == organization_id)
                              .order_by(model.updated_at.desc(), model.id).limit(recent)
                              ).unique().all():
            recent_items.append({"entity_type": kind, "id": row.id, "title": entity_title(row),
                                 "status": row.status, "updated_at": row.updated_at})
    recent_items.sort(key=lambda i: (i["updated_at"], i["id"]), reverse=True)

    return {
        "works": counts["work"],
        "recordings": counts["recording"],
        "releases": counts["release"],
        "parties": counts["party"],
        "archived": archived,
        "parties_by_role": dict(sorted(role_counter.items())),
        "missing_identifiers": missing,
        "recently_updated": recent_items[:recent],
    }


# --------------------------------------------------------------------------- activity


def entity_activity(db: Session, organization_id: str, entity_type: str, entity_id: str,
                    params: PageParams) -> tuple[list[dict[str, Any]], int]:
    """Audit history for one catalog entity. Deleted entities keep their
    history; ids unknown to the organization are 404."""
    stmt = select(AuditLog).where(
        AuditLog.organization_id == organization_id,
        AuditLog.entity_type == entity_type,
        AuditLog.entity_id == entity_id,
    )
    model = ENTITY_MODELS[entity_type]
    exists_now = db.scalar(select(model.id).where(
        model.id == entity_id, model.organization_id == organization_id)) is not None
    rows, total = paginate(db, stmt, params, sortable={"created_at": AuditLog.created_at},
                           default_sort=AuditLog.created_at.desc())
    if not exists_now and total == 0:
        raise NotFoundError(f"{ENTITY_LABELS[entity_type]} not found")
    actor_ids = {r.actor_user_id for r in rows if r.actor_user_id}
    names = (dict(db.execute(select(User.id, User.full_name).where(User.id.in_(actor_ids))).all())
             if actor_ids else {})
    items = [
        {"id": r.id, "actor_user_id": r.actor_user_id, "actor_name": names.get(r.actor_user_id),
         "action": r.action, "entity_type": r.entity_type, "entity_id": r.entity_id,
         "summary": r.summary, "changes": r.changes, "created_at": r.created_at}
        for r in rows
    ]
    return items, total
