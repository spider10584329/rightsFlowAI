"""Contract administration API: contracts, documents, clause scans, AI-assisted
analyses (advisory, human-reviewed), expiry tracking and activity."""

from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, Path, Query, Request, UploadFile, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.permissions import OrgAdmin, OrgManager, OrgViewer
from app.db.session import get_db
from app.models.platform import AuditLog
from app.models.user import User
from app.schemas.common import MessageResponse, Page, PageParams, page_of, paginate
from app.schemas.contract import (
    ClauseScanResponse,
    ContractAnalysisCreate,
    ContractAnalysisOut,
    ContractAnalysisReview,
    ContractCreate,
    ContractDetail,
    ContractDocumentOut,
    ContractListItem,
    ContractStatus,
    ContractSummary,
    ContractType,
    ContractUpdate,
)
from app.schemas.organization import AuditLogResponse
from app.services import contracts as svc
from app.services.storage import read_upload

from .files import audit_download, build_download_response

router = APIRouter(prefix="/organizations/{organization_id}/contracts", tags=["Contracts"])

ContractId = Annotated[str, Path(max_length=36)]
DocumentId = Annotated[str, Path(max_length=36)]
AnalysisId = Annotated[str, Path(max_length=36)]


async def _uploaded_file(file: UploadFile = File(...)) -> tuple[str | None, bytes]:
    """Read the multipart file with the configured size cap."""
    try:
        return file.filename, await read_upload(file)
    finally:
        await file.close()


# --------------------------------------------------------------------------- collection


@router.get("", response_model=Page[ContractListItem])
def list_contracts(
    ctx: OrgViewer,
    db: Session = Depends(get_db),
    params: PageParams = Depends(),
    q: Annotated[str | None, Query(max_length=200)] = None,
    contract_type: Annotated[ContractType | None, Query(alias="type")] = None,
    contract_status: Annotated[ContractStatus | None, Query(alias="status")] = None,
    party_id: Annotated[str | None, Query(max_length=36)] = None,
    work_id: Annotated[str | None, Query(max_length=36)] = None,
    recording_id: Annotated[str | None, Query(max_length=36)] = None,
    expiring_within_days: Annotated[int | None, Query(ge=0, le=3650)] = None,
):
    """Search (title, reference, party name), filter, sort (title, end_date,
    start_date, created_at) and paginate contracts."""
    rows, total = svc.list_contracts(
        db, ctx.organization_id, params, q=q, contract_type=contract_type,
        status=contract_status, party_id=party_id, work_id=work_id, recording_id=recording_id,
        expiring_within_days=expiring_within_days,
    )
    warning_days = svc.warning_days_for(ctx.organization)
    today = svc.today_utc()
    return page_of([svc.contract_list_payload(c, warning_days, today) for c in rows], total,
                   params)


@router.post("", response_model=ContractDetail, status_code=status.HTTP_201_CREATED)
def create_contract(payload: ContractCreate, ctx: OrgManager, request: Request,
                    db: Session = Depends(get_db)):
    contract = svc.create_contract(db, ctx, payload, request)
    return svc.contract_detail_payload(db, contract, svc.warning_days_for(ctx.organization))


@router.get("/summary", response_model=ContractSummary)
def contracts_summary(ctx: OrgViewer, db: Session = Depends(get_db)):
    return svc.contracts_summary(db, ctx.organization_id)


@router.get("/expiring", response_model=list[ContractListItem])
def expiring_contracts(
    ctx: OrgViewer,
    db: Session = Depends(get_db),
    within_days: Annotated[int | None, Query(ge=0, le=3650)] = None,
):
    """Active / pending-signature contracts ending within ``within_days``
    (default: the organization's warning window), soonest first. Includes
    contracts past their end date that have not been marked expired yet."""
    warning_days = svc.warning_days_for(ctx.organization)
    days = warning_days if within_days is None else within_days
    today = svc.today_utc()
    return [svc.contract_list_payload(c, warning_days, today)
            for c in svc.expiring_contracts(db, ctx.organization_id, days)]


# --------------------------------------------------------------------------- item


@router.get("/{contract_id}", response_model=ContractDetail)
def get_contract(contract_id: ContractId, ctx: OrgViewer, db: Session = Depends(get_db)):
    contract = svc.get_contract(db, ctx.organization_id, contract_id)
    return svc.contract_detail_payload(db, contract, svc.warning_days_for(ctx.organization))


@router.patch("/{contract_id}", response_model=ContractDetail)
def update_contract(contract_id: ContractId, payload: ContractUpdate, ctx: OrgManager,
                    request: Request, db: Session = Depends(get_db)):
    contract = svc.get_contract(db, ctx.organization_id, contract_id)
    contract = svc.update_contract(db, ctx, contract, payload, request)
    return svc.contract_detail_payload(db, contract, svc.warning_days_for(ctx.organization))


@router.delete("/{contract_id}", response_model=MessageResponse)
def delete_contract(contract_id: ContractId, ctx: OrgAdmin, request: Request,
                    db: Session = Depends(get_db)):
    contract = svc.get_contract(db, ctx.organization_id, contract_id)
    svc.delete_contract(db, ctx, contract, request)
    return {"message": "Contract deleted"}


@router.get("/{contract_id}/activity", response_model=Page[AuditLogResponse])
def contract_activity(contract_id: ContractId, ctx: OrgViewer, db: Session = Depends(get_db),
                      params: PageParams = Depends()):
    contract = svc.get_contract(db, ctx.organization_id, contract_id)
    stmt = select(AuditLog).where(
        AuditLog.organization_id == ctx.organization_id,
        AuditLog.entity_type == "contract",
        AuditLog.entity_id == contract.id,
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


# --------------------------------------------------------------------------- documents


@router.get("/{contract_id}/documents", response_model=list[ContractDocumentOut])
def list_documents(contract_id: ContractId, ctx: OrgViewer, db: Session = Depends(get_db)):
    contract = svc.get_contract(db, ctx.organization_id, contract_id)
    docs = sorted(contract.documents, key=lambda d: d.created_at, reverse=True)
    return [svc.document_payload(d) for d in docs if d.file and not d.file.is_deleted]


@router.post("/{contract_id}/documents", response_model=ContractDocumentOut,
             status_code=status.HTTP_201_CREATED)
def upload_document(
    contract_id: ContractId,
    ctx: OrgManager,
    request: Request,
    upload: tuple[str | None, bytes] = Depends(_uploaded_file),
    label: Annotated[str | None, Form(max_length=255)] = None,
    db: Session = Depends(get_db),
):
    """Upload a contract document (pdf, docx, txt, png, jpg). The extension and
    file signature are validated; the stored name is generated server-side."""
    contract = svc.get_contract(db, ctx.organization_id, contract_id)
    filename, data = upload
    doc = svc.add_document(db, ctx, contract, filename=filename, data=data, label=label,
                           request=request)
    return svc.document_payload(doc)


@router.get("/{contract_id}/documents/{document_id}/download")
def download_document(contract_id: ContractId, document_id: DocumentId, ctx: OrgViewer,
                      request: Request, db: Session = Depends(get_db)):
    contract = svc.get_contract(db, ctx.organization_id, contract_id)
    doc = svc.get_document(db, ctx.organization_id, contract.id, document_id)
    response = build_download_response(doc.file)
    audit_download(db, doc.file, ctx.user.id, request, entity_type="contract",
                   entity_id=contract.id)
    return response


@router.delete("/{contract_id}/documents/{document_id}", response_model=MessageResponse)
def delete_document(contract_id: ContractId, document_id: DocumentId, ctx: OrgAdmin,
                    request: Request, db: Session = Depends(get_db)):
    contract = svc.get_contract(db, ctx.organization_id, contract_id)
    doc = svc.get_document(db, ctx.organization_id, contract.id, document_id)
    svc.delete_document(db, ctx, contract, doc, request)
    return {"message": "Document deleted"}


@router.post("/{contract_id}/documents/{document_id}/clause-scan",
             response_model=ClauseScanResponse)
def clause_scan(contract_id: ContractId, document_id: DocumentId, ctx: OrgManager,
                db: Session = Depends(get_db)):
    """Deterministic keyword/regex clause scan (works without AI)."""
    contract = svc.get_contract(db, ctx.organization_id, contract_id)
    doc = svc.get_document(db, ctx.organization_id, contract.id, document_id)
    return svc.clause_scan(doc)


# --------------------------------------------------------------------------- AI analyses


@router.post("/{contract_id}/analyses", response_model=ContractAnalysisOut,
             status_code=status.HTTP_202_ACCEPTED)
def request_analysis(contract_id: ContractId, payload: ContractAnalysisCreate, ctx: OrgManager,
                     request: Request, db: Session = Depends(get_db)):
    """Queue an AI-assisted extraction of a contract document. Returns 503
    ``ai_not_configured`` when no AI provider is configured."""
    contract = svc.get_contract(db, ctx.organization_id, contract_id)
    analysis = svc.request_analysis(db, ctx, contract, payload.document_id, request)
    return svc.analysis_payload(analysis)


@router.get("/{contract_id}/analyses", response_model=list[ContractAnalysisOut])
def list_analyses(contract_id: ContractId, ctx: OrgViewer, db: Session = Depends(get_db)):
    contract = svc.get_contract(db, ctx.organization_id, contract_id)
    return [svc.analysis_payload(a)
            for a in svc.list_analyses(db, ctx.organization_id, contract.id)]


@router.get("/{contract_id}/analyses/{analysis_id}", response_model=ContractAnalysisOut)
def get_analysis(contract_id: ContractId, analysis_id: AnalysisId, ctx: OrgViewer,
                 db: Session = Depends(get_db)):
    contract = svc.get_contract(db, ctx.organization_id, contract_id)
    return svc.analysis_payload(svc.get_analysis(db, ctx.organization_id, contract.id,
                                                 analysis_id))


@router.post("/{contract_id}/analyses/{analysis_id}/review", response_model=ContractAnalysisOut)
def review_analysis(contract_id: ContractId, analysis_id: AnalysisId,
                    payload: ContractAnalysisReview, ctx: OrgManager, request: Request,
                    db: Session = Depends(get_db)):
    """Accept or reject an analysis. On accept, only the fields listed in
    ``apply_fields`` are re-validated and copied onto the contract."""
    contract = svc.get_contract(db, ctx.organization_id, contract_id)
    analysis = svc.get_analysis(db, ctx.organization_id, contract.id, analysis_id)
    analysis = svc.review_analysis(
        db, ctx, contract, analysis, decision=payload.decision, notes=payload.notes,
        apply_fields=list(payload.apply_fields), request=request,
    )
    return svc.analysis_payload(analysis)
