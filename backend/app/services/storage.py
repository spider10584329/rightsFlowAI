"""Private file storage with local and S3-compatible backends.

Security properties:
- Storage keys are generated server-side (``<org>/<category>/<uuid><ext>``);
  user-supplied filenames are never used as paths.
- Local paths are resolved and verified to stay inside the storage root.
- Extensions and content signatures are validated per category.
- Files are only ever served through authorized API endpoints.
"""

import hashlib
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Protocol
from uuid import uuid4

from fastapi import UploadFile
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import AppError, NotFoundError, ValidationFailedError
from app.models.platform import StoredFile
from app.services import billing

CATEGORY_EXTENSIONS: dict[str, set[str]] = {
    "contract": {".pdf", ".docx", ".txt", ".png", ".jpg", ".jpeg"},
    "statement": {".csv", ".xlsx", ".txt", ".tsv"},
    "import": {".csv", ".xlsx"},
    "export": {".csv", ".xlsx", ".pdf", ".txt"},
    "other": {".pdf", ".csv", ".xlsx", ".txt", ".png", ".jpg", ".jpeg", ".docx"},
}

CONTENT_TYPES = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".csv": "text/csv",
    ".tsv": "text/tab-separated-values",
    ".txt": "text/plain",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
}

# Magic-number checks for binary formats.
SIGNATURES = {
    ".pdf": [b"%PDF-"],
    ".docx": [b"PK\x03\x04"],
    ".xlsx": [b"PK\x03\x04"],
    ".png": [b"\x89PNG\r\n\x1a\n"],
    ".jpg": [b"\xff\xd8\xff"],
    ".jpeg": [b"\xff\xd8\xff"],
}
TEXT_EXTENSIONS = {".csv", ".tsv", ".txt"}


def safe_filename(name: str | None, fallback: str = "file") -> str:
    """Display-safe filename: strips directories, control and unusual chars."""
    name = (name or "").replace("\\", "/").split("/")[-1]
    name = unicodedata.normalize("NFKC", name)
    name = re.sub(r"[^\w.\- ()]", "_", name).strip(" .")
    return (name or fallback)[:200]


class StorageBackend(Protocol):
    name: str

    def save(self, key: str, data: bytes, content_type: str) -> None: ...

    def open(self, key: str) -> bytes: ...

    def delete(self, key: str) -> None: ...


class LocalStorage:
    name = "local"

    def __init__(self, root: Path) -> None:
        self.root = root.resolve()

    def _path(self, key: str) -> Path:
        path = (self.root / key).resolve()
        if not path.is_relative_to(self.root):
            raise ValidationFailedError("Invalid storage key")
        return path

    def save(self, key: str, data: bytes, content_type: str) -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".part")
        tmp.write_bytes(data)
        tmp.replace(path)

    def open(self, key: str) -> bytes:
        path = self._path(key)
        if not path.is_file():
            raise NotFoundError("File content not found")
        return path.read_bytes()

    def delete(self, key: str) -> None:
        path = self._path(key)
        if path.is_file():
            path.unlink()


class S3Storage:
    """S3-compatible backend (AWS S3, MinIO, Cloudflare R2...). Requires
    ``pip install boto3``. Objects are private; access goes through the API."""

    name = "s3"

    def __init__(self) -> None:
        try:
            import boto3  # type: ignore[import-not-found]
        except ImportError as exc:  # pragma: no cover - optional dependency
            raise AppError("boto3 is required for STORAGE_BACKEND=s3", status_code=500) from exc
        if not settings.s3_bucket:
            raise AppError("S3_BUCKET is not configured", status_code=500)
        self.bucket = settings.s3_bucket
        self.client = boto3.client(
            "s3",
            region_name=settings.s3_region,
            endpoint_url=settings.s3_endpoint_url,
            aws_access_key_id=settings.s3_access_key_id,
            aws_secret_access_key=settings.s3_secret_access_key,
        )

    def save(self, key: str, data: bytes, content_type: str) -> None:
        self.client.put_object(
            Bucket=self.bucket, Key=key, Body=data, ContentType=content_type,
            ServerSideEncryption="AES256",
        )

    def open(self, key: str) -> bytes:
        try:
            return self.client.get_object(Bucket=self.bucket, Key=key)["Body"].read()
        except self.client.exceptions.NoSuchKey as exc:  # pragma: no cover
            raise NotFoundError("File content not found") from exc

    def delete(self, key: str) -> None:
        self.client.delete_object(Bucket=self.bucket, Key=key)


_backend: StorageBackend | None = None


def get_storage() -> StorageBackend:
    global _backend
    if _backend is None:
        _backend = S3Storage() if settings.storage_backend == "s3" else LocalStorage(
            settings.storage_local_path
        )
    return _backend


def set_storage(backend: StorageBackend | None) -> None:
    """Override the backend (tests)."""
    global _backend
    _backend = backend


@dataclass
class ValidatedUpload:
    filename: str
    extension: str
    content_type: str
    data: bytes
    sha256: str


def validate_bytes(filename: str | None, data: bytes, category: str) -> ValidatedUpload:
    clean = safe_filename(filename)
    extension = Path(clean).suffix.lower()
    allowed = CATEGORY_EXTENSIONS.get(category, set())
    if extension not in allowed:
        raise ValidationFailedError(
            f"File type '{extension or 'unknown'}' is not allowed here",
            code="unsupported_file_type",
            details={"allowed": sorted(allowed)},
        )
    if not data:
        raise ValidationFailedError("The uploaded file is empty")
    if len(data) > settings.max_upload_bytes:
        raise ValidationFailedError(
            f"File exceeds the {settings.storage_max_upload_mb} MB limit", code="file_too_large"
        )
    signatures = SIGNATURES.get(extension)
    if signatures and not any(data.startswith(sig) for sig in signatures):
        raise ValidationFailedError(
            "File content does not match its extension", code="file_signature_mismatch"
        )
    if extension in (".xlsx", ".docx"):
        from app.services.file_safety import check_office_archive

        check_office_archive(data)
    if extension in TEXT_EXTENSIONS:
        if b"\x00" in data[:8192]:
            raise ValidationFailedError("Text file contains binary data")
    return ValidatedUpload(
        filename=clean,
        extension=extension,
        content_type=CONTENT_TYPES.get(extension, "application/octet-stream"),
        data=data,
        sha256=hashlib.sha256(data).hexdigest(),
    )


async def read_upload(upload: UploadFile) -> bytes:
    limit = settings.max_upload_bytes
    chunks: list[bytes] = []
    size = 0
    while True:
        chunk = await upload.read(1024 * 1024)
        if not chunk:
            break
        size += len(chunk)
        if size > limit:
            raise ValidationFailedError(
                f"File exceeds the {settings.storage_max_upload_mb} MB limit", code="file_too_large"
            )
        chunks.append(chunk)
    return b"".join(chunks)


def store_file(
    db: Session,
    *,
    organization_id: str,
    category: str,
    upload: ValidatedUpload,
    created_by_id: str | None,
) -> StoredFile:
    billing.check_limit(
        db, organization_id, "max_storage_mb", increment=-(-len(upload.data) // (1024 * 1024))
    )
    key = f"{organization_id}/{category}/{uuid4().hex}{upload.extension}"
    get_storage().save(key, upload.data, upload.content_type)
    record = StoredFile(
        organization_id=organization_id,
        category=category,
        storage_backend=get_storage().name,
        storage_key=key,
        original_filename=upload.filename,
        content_type=upload.content_type,
        size_bytes=len(upload.data),
        sha256=upload.sha256,
        created_by_id=created_by_id,
    )
    db.add(record)
    db.flush()
    return record


def store_generated(db: Session, *, organization_id: str, category: str, filename: str,
                    data: bytes, created_by_id: str | None) -> StoredFile:
    return store_file(
        db,
        organization_id=organization_id,
        category=category,
        upload=validate_bytes(filename, data, category),
        created_by_id=created_by_id,
    )


def read_file(record: StoredFile) -> bytes:
    if record.is_deleted:
        raise NotFoundError("File not found")
    return get_storage().open(record.storage_key)


def get_org_file(db: Session, organization_id: str, file_id: str) -> StoredFile:
    record = db.get(StoredFile, file_id)
    if record is None or record.organization_id != organization_id or record.is_deleted:
        raise NotFoundError("File not found")
    return record


def stream_bytes(data: bytes) -> BinaryIO:
    import io

    return io.BytesIO(data)


# --------------------------------------------------------------------------- purge

STORAGE_PURGE_JOB = "storage_purge"


def purge_deleted_files(db: Session, now=None, batch_size: int = 500) -> dict[str, int]:
    """Remove the stored bytes of files deleted more than FILE_PURGE_AFTER_DAYS
    ago. Metadata rows stay (they may be referenced by audit history)."""
    from datetime import timedelta

    from sqlalchemy import select

    from app.core.logging import get_logger
    from app.db.mixins import utc_now

    logger = get_logger(__name__)
    if settings.file_purge_after_days <= 0:
        return {"purged": 0, "failed": 0}
    now = now or utc_now()
    cutoff = now - timedelta(days=settings.file_purge_after_days)
    candidates = db.scalars(
        select(StoredFile).where(
            StoredFile.is_deleted.is_(True),
            StoredFile.purged_at.is_(None),
            StoredFile.deleted_at.is_not(None),
            StoredFile.deleted_at <= cutoff,
        ).limit(batch_size)
    ).all()
    purged = failed = 0
    backend = get_storage()
    for record in candidates:
        try:
            backend.delete(record.storage_key)
        except Exception:  # noqa: BLE001 - keep purging the rest
            logger.exception("Failed to purge stored file %s", record.id)
            failed += 1
            continue
        record.purged_at = now
        purged += 1
    db.commit()
    return {"purged": purged, "failed": failed}


def _register_purge_job() -> None:
    from app.services import jobs

    @jobs.job_handler(STORAGE_PURGE_JOB)
    def storage_purge(db: Session, ctx: "jobs.JobContext") -> dict:
        return purge_deleted_files(db)


_register_purge_job()
