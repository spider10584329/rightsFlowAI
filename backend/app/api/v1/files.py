"""Authorized access to an organization's private files. There are no public
URLs: every byte is served through these endpoints after a membership check,
and files of other organizations are reported as 404."""

from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, Depends, Path, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.core.permissions import OrgViewer
from app.db.session import get_db
from app.models.platform import StoredFile
from app.schemas.contract import StoredFileOut
from app.services.audit import record_audit
from app.services.storage import get_org_file, read_file, safe_filename, stream_bytes

router = APIRouter(prefix="/organizations/{organization_id}/files", tags=["Files"])

FileId = Annotated[str, Path(max_length=36)]


def build_download_response(record: StoredFile) -> StreamingResponse:
    """Stream a stored file as an attachment with hardened headers."""
    data = read_file(record)
    filename = safe_filename(record.original_filename, fallback="download")
    ascii_name = filename.encode("ascii", "ignore").decode("ascii").replace('"', "") or "download"
    disposition = f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{quote(filename)}'
    return StreamingResponse(
        stream_bytes(data),
        media_type=record.content_type or "application/octet-stream",
        headers={
            "Content-Disposition": disposition,
            "Content-Length": str(len(data)),
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, no-store",
            "Content-Security-Policy": "default-src 'none'; sandbox",
        },
    )


def audit_download(db: Session, record: StoredFile, user_id: str, request: Request,
                   entity_type: str = "file", entity_id: str | None = None) -> None:
    record_audit(
        db, action="file.downloaded", actor_user_id=user_id,
        organization_id=record.organization_id, entity_type=entity_type,
        entity_id=entity_id or record.id,
        summary=f"Downloaded {record.original_filename}",
        changes={"file_id": record.id}, request=request,
    )
    db.commit()


@router.get("/{file_id}", response_model=StoredFileOut)
def get_file_metadata(file_id: FileId, ctx: OrgViewer, db: Session = Depends(get_db)):
    """File metadata (never the internal storage location)."""
    return get_org_file(db, ctx.organization_id, file_id)


@router.get("/{file_id}/download")
def download_file(file_id: FileId, ctx: OrgViewer, request: Request,
                  db: Session = Depends(get_db)):
    record = get_org_file(db, ctx.organization_id, file_id)
    response = build_download_response(record)
    audit_download(db, record, ctx.user.id, request)
    return response
