"""Music catalog API: parties, works, recordings, releases and catalog tools
(bulk actions, validation, duplicates, completeness, import/export, history).

Roles: reads need viewer; create/update/archive need manager; deletes and
bulk deletes need admin.
"""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, File, Form, Query, Request, UploadFile, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.permissions import OrgAdmin, OrgManager, OrgViewer
from app.db.session import get_db
from app.schemas.catalog import (
    CatalogActivityResponse,
    CatalogBulkRequest,
    CatalogBulkResult,
    CatalogStatus,
    CatalogSummary,
    CompletenessSummary,
    DuplicateCandidate,
    ImportJobResponse,
    PartyCreate,
    PartyDetailResponse,
    PartyResponse,
    PartyRole,
    PartyType,
    RecordingCreate,
    RecordingDetailResponse,
    RecordingResponse,
    RecordingUpdate,
    ReleaseCreate,
    ReleaseResponse,
    ReleaseType,
    ReleaseUpdate,
    PartyUpdate,
    ValidationIssuesResponse,
    VerificationStatus,
    WorkCreate,
    WorkDetailResponse,
    WorkResponse,
    WorkUpdate,
)
from app.schemas.common import MessageResponse, Page, PageParams, page_of
from app.services import catalog as svc
from app.services import catalog_io
from app.services.audit import record_audit

ORG = "/organizations/{organization_id}"

parties_router = APIRouter(prefix=f"{ORG}/parties", tags=["Catalog: Parties"])
works_router = APIRouter(prefix=f"{ORG}/works", tags=["Catalog: Works"])
recordings_router = APIRouter(prefix=f"{ORG}/recordings", tags=["Catalog: Recordings"])
releases_router = APIRouter(prefix=f"{ORG}/releases", tags=["Catalog: Releases"])
router = APIRouter(prefix=f"{ORG}/catalog", tags=["Catalog"])

Q = Annotated[str | None, Query(max_length=200)]
IdQuery = Annotated[str | None, Query(max_length=36)]
AllowDuplicate = Annotated[
    bool, Query(description="Create/update even when another item has the same identifier")
]
EntityTypeParam = Literal["work", "works", "recording", "recordings", "release", "releases",
                          "party", "parties"]


# --------------------------------------------------------------------------- parties


@parties_router.get("", response_model=Page[PartyResponse])
def list_parties(
    ctx: OrgViewer,
    db: Session = Depends(get_db),
    params: PageParams = Depends(),
    q: Q = None,
    role: PartyRole | None = None,
    party_type: PartyType | None = None,
    status_filter: Annotated[CatalogStatus | None, Query(alias="status")] = None,
    include_archived: bool = False,
    is_internal: bool | None = None,
):
    """Search parties by name, legal name, IPI or ISNI; filter by role and type."""
    rows, total = svc.list_parties(
        db, ctx.organization_id, params, q=q, role=role, party_type=party_type,
        status=status_filter, include_archived=include_archived, is_internal=is_internal,
    )
    return page_of([svc.party_payload(p) for p in rows], total, params)


@parties_router.post("", response_model=PartyDetailResponse, status_code=status.HTTP_201_CREATED)
def create_party(payload: PartyCreate, ctx: OrgManager, request: Request,
                 db: Session = Depends(get_db)):
    party = svc.create_party(db, ctx, payload, request)
    return svc.party_detail_payload(db, party)


@parties_router.get("/{party_id}", response_model=PartyDetailResponse)
def get_party(party_id: str, ctx: OrgViewer, db: Session = Depends(get_db)):
    return svc.party_detail_payload(db, svc.get_party(db, ctx.organization_id, party_id))


@parties_router.patch("/{party_id}", response_model=PartyDetailResponse)
def update_party(party_id: str, payload: PartyUpdate, ctx: OrgManager, request: Request,
                 db: Session = Depends(get_db)):
    party = svc.get_party(db, ctx.organization_id, party_id)
    party = svc.update_party(db, ctx, party, payload, request)
    return svc.party_detail_payload(db, party)


@parties_router.delete("/{party_id}", response_model=MessageResponse)
def delete_party(party_id: str, ctx: OrgAdmin, request: Request, db: Session = Depends(get_db)):
    """Delete an unreferenced party. Referenced parties return 409; archive them instead."""
    party = svc.get_party(db, ctx.organization_id, party_id)
    svc.delete_entity(db, ctx, "party", party, request)
    return MessageResponse(message="Party deleted")


# --------------------------------------------------------------------------- works


@works_router.get("", response_model=Page[WorkResponse])
def list_works(
    ctx: OrgViewer,
    db: Session = Depends(get_db),
    params: PageParams = Depends(),
    q: Q = None,
    status_filter: Annotated[CatalogStatus | None, Query(alias="status")] = None,
    verification_status: VerificationStatus | None = None,
    has_iswc: bool | None = None,
    party_id: IdQuery = None,
    recording_id: IdQuery = None,
    language: Annotated[str | None, Query(max_length=10)] = None,
    genre: Annotated[str | None, Query(max_length=100)] = None,
    include_archived: bool = False,
):
    rows, total = svc.list_works(
        db, ctx.organization_id, params, q=q, status=status_filter,
        verification_status=verification_status, has_iswc=has_iswc, party_id=party_id,
        recording_id=recording_id, language=language, genre=genre,
        include_archived=include_archived,
    )
    return page_of([svc.work_payload(w) for w in rows], total, params)


@works_router.post("", response_model=WorkDetailResponse, status_code=status.HTTP_201_CREATED)
def create_work(payload: WorkCreate, ctx: OrgManager, request: Request,
                db: Session = Depends(get_db), allow_duplicate: AllowDuplicate = False):
    work = svc.create_work(db, ctx, payload, request, allow_duplicate)
    return svc.work_detail_payload(db, work)


@works_router.get("/{work_id}", response_model=WorkDetailResponse)
def get_work(work_id: str, ctx: OrgViewer, db: Session = Depends(get_db)):
    """Work with contributors (party names), linked recordings and completeness."""
    return svc.work_detail_payload(db, svc.get_work(db, ctx.organization_id, work_id))


@works_router.patch("/{work_id}", response_model=WorkDetailResponse)
def update_work(work_id: str, payload: WorkUpdate, ctx: OrgManager, request: Request,
                db: Session = Depends(get_db), allow_duplicate: AllowDuplicate = False):
    work = svc.get_work(db, ctx.organization_id, work_id)
    work = svc.update_work(db, ctx, work, payload, request, allow_duplicate)
    return svc.work_detail_payload(db, work)


@works_router.delete("/{work_id}", response_model=MessageResponse)
def delete_work(work_id: str, ctx: OrgAdmin, request: Request, db: Session = Depends(get_db)):
    work = svc.get_work(db, ctx.organization_id, work_id)
    svc.delete_entity(db, ctx, "work", work, request)
    return MessageResponse(message="Work deleted")


# --------------------------------------------------------------------------- recordings


@recordings_router.get("", response_model=Page[RecordingResponse])
def list_recordings(
    ctx: OrgViewer,
    db: Session = Depends(get_db),
    params: PageParams = Depends(),
    q: Q = None,
    status_filter: Annotated[CatalogStatus | None, Query(alias="status")] = None,
    verification_status: VerificationStatus | None = None,
    has_isrc: bool | None = None,
    has_work: bool | None = None,
    party_id: IdQuery = None,
    work_id: IdQuery = None,
    release_id: IdQuery = None,
    is_explicit: bool | None = None,
    include_archived: bool = False,
):
    rows, total = svc.list_recordings(
        db, ctx.organization_id, params, q=q, status=status_filter,
        verification_status=verification_status, has_isrc=has_isrc, has_work=has_work,
        party_id=party_id, work_id=work_id, release_id=release_id, is_explicit=is_explicit,
        include_archived=include_archived,
    )
    return page_of([svc.recording_payload(r) for r in rows], total, params)


@recordings_router.post("", response_model=RecordingDetailResponse,
                        status_code=status.HTTP_201_CREATED)
def create_recording(payload: RecordingCreate, ctx: OrgManager, request: Request,
                     db: Session = Depends(get_db), allow_duplicate: AllowDuplicate = False):
    recording = svc.create_recording(db, ctx, payload, request, allow_duplicate)
    return svc.recording_detail_payload(db, recording)


@recordings_router.get("/{recording_id}", response_model=RecordingDetailResponse)
def get_recording(recording_id: str, ctx: OrgViewer, db: Session = Depends(get_db)):
    return svc.recording_detail_payload(
        db, svc.get_recording(db, ctx.organization_id, recording_id))


@recordings_router.patch("/{recording_id}", response_model=RecordingDetailResponse)
def update_recording(recording_id: str, payload: RecordingUpdate, ctx: OrgManager,
                     request: Request, db: Session = Depends(get_db),
                     allow_duplicate: AllowDuplicate = False):
    recording = svc.get_recording(db, ctx.organization_id, recording_id)
    recording = svc.update_recording(db, ctx, recording, payload, request, allow_duplicate)
    return svc.recording_detail_payload(db, recording)


@recordings_router.delete("/{recording_id}", response_model=MessageResponse)
def delete_recording(recording_id: str, ctx: OrgAdmin, request: Request,
                     db: Session = Depends(get_db)):
    recording = svc.get_recording(db, ctx.organization_id, recording_id)
    svc.delete_entity(db, ctx, "recording", recording, request)
    return MessageResponse(message="Recording deleted")


# --------------------------------------------------------------------------- releases


@releases_router.get("", response_model=Page[ReleaseResponse])
def list_releases(
    ctx: OrgViewer,
    db: Session = Depends(get_db),
    params: PageParams = Depends(),
    q: Q = None,
    status_filter: Annotated[CatalogStatus | None, Query(alias="status")] = None,
    release_type: ReleaseType | None = None,
    has_upc: bool | None = None,
    label_id: IdQuery = None,
    recording_id: IdQuery = None,
    include_archived: bool = False,
):
    rows, total = svc.list_releases(
        db, ctx.organization_id, params, q=q, status=status_filter, release_type=release_type,
        has_upc=has_upc, label_id=label_id, recording_id=recording_id,
        include_archived=include_archived,
    )
    return page_of([svc.release_payload(r) for r in rows], total, params)


@releases_router.post("", response_model=ReleaseResponse, status_code=status.HTTP_201_CREATED)
def create_release(payload: ReleaseCreate, ctx: OrgManager, request: Request,
                   db: Session = Depends(get_db), allow_duplicate: AllowDuplicate = False):
    return svc.release_payload(svc.create_release(db, ctx, payload, request, allow_duplicate))


@releases_router.get("/{release_id}", response_model=ReleaseResponse)
def get_release(release_id: str, ctx: OrgViewer, db: Session = Depends(get_db)):
    return svc.release_payload(svc.get_release(db, ctx.organization_id, release_id))


@releases_router.patch("/{release_id}", response_model=ReleaseResponse)
def update_release(release_id: str, payload: ReleaseUpdate, ctx: OrgManager, request: Request,
                   db: Session = Depends(get_db), allow_duplicate: AllowDuplicate = False):
    release = svc.get_release(db, ctx.organization_id, release_id)
    return svc.release_payload(
        svc.update_release(db, ctx, release, payload, request, allow_duplicate))


@releases_router.delete("/{release_id}", response_model=MessageResponse)
def delete_release(release_id: str, ctx: OrgAdmin, request: Request,
                   db: Session = Depends(get_db)):
    release = svc.get_release(db, ctx.organization_id, release_id)
    svc.delete_entity(db, ctx, "release", release, request)
    return MessageResponse(message="Release deleted")


# --------------------------------------------------------------------------- catalog tools


@router.post("/bulk", response_model=CatalogBulkResult)
def bulk_action(payload: CatalogBulkRequest, ctx: OrgManager, request: Request,
                db: Session = Depends(get_db)):
    """Archive/restore (manager) or delete (admin) many items at once.
    Missing, already-in-state and referenced items are skipped with a reason."""
    return svc.bulk_action(db, ctx, payload.entity_type, payload.action, payload.ids, request)


@router.get("/validation-issues", response_model=ValidationIssuesResponse)
def validation_issues(
    ctx: OrgViewer,
    db: Session = Depends(get_db),
    entity_type: EntityTypeParam | None = None,
    severity: Literal["error", "warning", "info"] | None = None,
    code: Annotated[str | None, Query(max_length=50)] = None,
    page: Annotated[int, Query(ge=1, le=100000)] = 1,
    page_size: Annotated[int, Query(ge=1, le=500)] = 100,
):
    """Deterministic metadata problems (invalid/missing identifiers, works
    without writers, recordings without ISRC or linked work, ...)."""
    kind = svc.canonical_entity_type(entity_type) if entity_type else None
    issues = svc.validation_issues(db, ctx.organization_id, kind)
    by_code: dict[str, int] = {}
    for issue in issues:
        by_code[issue["code"]] = by_code.get(issue["code"], 0) + 1
    if severity:
        issues = [i for i in issues if i["severity"] == severity]
    if code:
        issues = [i for i in issues if i["code"] == code]
    total = len(issues)
    start = (page - 1) * page_size
    return {
        "items": issues[start:start + page_size],
        "total": total,
        "page": page,
        "page_size": page_size,
        "pages": max(1, -(-total // page_size)),
        "by_code": dict(sorted(by_code.items())),
    }


@router.get("/duplicates", response_model=list[DuplicateCandidate])
def duplicates(
    ctx: OrgViewer,
    entity_type: EntityTypeParam,
    db: Session = Depends(get_db),
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
):
    """Likely duplicates (same identifier, or similar normalized titles)."""
    return svc.find_duplicate_candidates(db, ctx.organization_id, entity_type, limit)


@router.get("/completeness", response_model=CompletenessSummary)
def completeness(
    ctx: OrgViewer,
    db: Session = Depends(get_db),
    entity_type: Literal["work", "works", "recording", "recordings", "release",
                         "releases"] | None = None,
):
    kind = svc.canonical_entity_type(entity_type) if entity_type else None
    return svc.completeness_summary(db, ctx.organization_id, kind)


@router.get("/summary", response_model=CatalogSummary)
def summary(ctx: OrgViewer, db: Session = Depends(get_db)):
    return svc.catalog_summary(db, ctx.organization_id)


@router.get("/export", response_class=StreamingResponse,
            responses={200: {"content": {"text/csv": {}}}})
def export_catalog(
    ctx: OrgViewer,
    request: Request,
    entity_type: EntityTypeParam,
    db: Session = Depends(get_db),
    include_archived: bool = False,
):
    """CSV export. Cells that could be read as spreadsheet formulas are
    prefixed with an apostrophe."""
    content = catalog_io.export_csv(db, ctx.organization_id, entity_type, include_archived)
    filename = catalog_io.export_filename(entity_type)
    record_audit(
        db,
        action="catalog.exported",
        actor_user_id=ctx.user.id,
        organization_id=ctx.organization_id,
        entity_type="catalog",
        summary=f"Exported {svc.canonical_entity_type(entity_type)} catalog as CSV",
        request=request,
    )
    db.commit()
    return StreamingResponse(
        iter([content]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/imports/template", response_class=StreamingResponse,
            responses={200: {"content": {"text/csv": {}}}})
def import_template(
    ctx: OrgViewer,
    entity_type: Literal["work", "works", "recording", "recordings", "party", "parties"],
):
    """CSV template with the expected headers and one example row."""
    content = catalog_io.template_csv(entity_type)
    kind = catalog_io.canonical_import_type(entity_type)
    return StreamingResponse(
        iter([content]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition":
                 f'attachment; filename="rightsflow-{kind}-import-template.csv"'},
    )


@router.post("/imports", response_model=ImportJobResponse, status_code=status.HTTP_202_ACCEPTED)
def start_import(
    ctx: OrgManager,
    file: Annotated[UploadFile, File(description="CSV or XLSX file")],
    entity_type: Annotated[Literal["work", "recording", "party"], Form()],
    dry_run: Annotated[bool, Form()] = False,
    db: Session = Depends(get_db),
):
    """Upload a CSV/XLSX file and queue a background import. Re-uploading the
    same file returns the existing job (``deduplicated: true``)."""
    data = file.file.read(settings.max_upload_bytes + 1)
    job, deduplicated = catalog_io.start_import(
        db, ctx, filename=file.filename, data=data, entity_type=entity_type, dry_run=dry_run)
    return catalog_io.import_job_payload(job, deduplicated)


@router.get("/imports", response_model=list[ImportJobResponse])
def list_imports(ctx: OrgViewer, db: Session = Depends(get_db),
                 limit: Annotated[int, Query(ge=1, le=200)] = 50):
    return [catalog_io.import_job_payload(j)
            for j in catalog_io.list_import_jobs(db, ctx.organization_id, limit)]


@router.get("/imports/{job_id}", response_model=ImportJobResponse)
def get_import(job_id: str, ctx: OrgViewer, db: Session = Depends(get_db)):
    """Import status, progress and per-row results."""
    return catalog_io.import_job_payload(catalog_io.get_import_job(db, ctx.organization_id, job_id))


@router.get("/{entity_type}/{entity_id}/activity", response_model=Page[CatalogActivityResponse])
def entity_activity(
    entity_type: EntityTypeParam,
    entity_id: str,
    ctx: OrgViewer,
    db: Session = Depends(get_db),
    params: PageParams = Depends(),
):
    """Change history (audit log) of one party, work, recording or release."""
    kind = svc.canonical_entity_type(entity_type)
    items, total = svc.entity_activity(db, ctx.organization_id, kind, entity_id, params)
    return page_of(items, total, params)
