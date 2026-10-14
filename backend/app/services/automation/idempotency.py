"""Idempotency for mutating automation requests.

Every mutating automation endpoint requires an ``Idempotency-Key`` header.

- First request: a reservation row is committed, the handler runs, and its 2xx
  response is stored.
- Replay with the same key and the same request: the stored response is
  returned (``Idempotent-Replayed: true``) without running the handler again.
- Same key, different request: 422 ``idempotency_key_reused``.
- Same key while the first request is still running: 409 ``idempotency_in_progress``.
- Handler error: the reservation is released so the caller can retry.

If the process dies after the business transaction commits but before the
response is stored, the retry re-runs the handler; every handler is also
idempotent at the business level (duplicate statement detection, delivery
dedupe keys, unique run keys), so this cannot duplicate records.
"""

import hashlib
import json
import re
from collections.abc import Callable
from datetime import timedelta
from typing import Any

from fastapi import Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import ConflictError, ValidationFailedError
from app.db.mixins import utc_now
from app.models.automation import AutomationIdempotencyKey
from app.services.automation.context import AutomationContext

_KEY_RE = re.compile(r"^[A-Za-z0-9._:\-]{8,128}$")
REPLAY_HEADER = "Idempotent-Replayed"


def request_fingerprint(*parts: Any) -> str:
    digest = hashlib.sha256()
    for part in parts:
        if isinstance(part, bytes):
            digest.update(hashlib.sha256(part).digest())
        else:
            digest.update(json.dumps(jsonable_encoder(part), sort_keys=True, default=str).encode("utf-8"))
        digest.update(b"\x1f")
    return digest.hexdigest()


def _find(db: Session, organization_id: str, key: str) -> AutomationIdempotencyKey | None:
    return db.scalar(select(AutomationIdempotencyKey).where(
        AutomationIdempotencyKey.organization_id == organization_id,
        AutomationIdempotencyKey.idempotency_key == key,
    ).execution_options(populate_existing=True))


def _replay(record: AutomationIdempotencyKey, request_hash: str) -> JSONResponse:
    if record.request_hash != request_hash:
        raise ValidationFailedError(
            "This Idempotency-Key was already used for a different request",
            code="idempotency_key_reused")
    if record.status_code is None:
        raise ConflictError("A request with this Idempotency-Key is still being processed",
                            code="idempotency_in_progress")
    return JSONResponse(status_code=record.status_code, content=record.response_body,
                        headers={REPLAY_HEADER: "true"})


def run_idempotent(db: Session, actx: AutomationContext, request: Request, key: str | None,
                   fingerprint: str, handler: Callable[[], tuple[int, Any]]) -> JSONResponse:
    if not key or not _KEY_RE.match(key):
        raise ValidationFailedError(
            "Idempotency-Key header is required (8-128 characters: letters, digits, . _ : -)",
            code="idempotency_key_required")
    request_hash = request_fingerprint(request.method, request.url.path, fingerprint)
    existing = _find(db, actx.organization_id, key)
    if existing is not None:
        return _replay(existing, request_hash)

    reservation = AutomationIdempotencyKey(
        organization_id=actx.organization_id, idempotency_key=key, credential_id=actx.credential.id,
        method=request.method, path=request.url.path[:255], request_hash=request_hash,
    )
    db.add(reservation)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        concurrent = _find(db, actx.organization_id, key)
        if concurrent is None:
            raise
        return _replay(concurrent, request_hash)
    reservation_id = reservation.id

    try:
        status_code, body = handler()
    except BaseException:
        db.rollback()
        db.execute(delete(AutomationIdempotencyKey).where(AutomationIdempotencyKey.id == reservation_id))
        db.commit()
        raise

    content = jsonable_encoder(body)
    record = db.get(AutomationIdempotencyKey, reservation_id, populate_existing=True)
    if record is not None:
        record.status_code = status_code
        record.response_body = content
        db.commit()
    return JSONResponse(status_code=status_code, content=content)


def purge_expired(db: Session) -> int:
    cutoff = utc_now() - timedelta(days=settings.automation_idempotency_retention_days)
    result = db.execute(delete(AutomationIdempotencyKey).where(AutomationIdempotencyKey.created_at < cutoff))
    return result.rowcount or 0
