"""Audit trail helpers. Entries are added to the caller's transaction so the
audit record commits (or rolls back) together with the change it describes."""

from datetime import date, datetime
from decimal import Decimal
from typing import Any

from fastapi import Request
from sqlalchemy import inspect
from sqlalchemy.orm import Session

from app.core.logging import request_id_var
from app.core.request_context import client_ip, user_agent
from app.models.platform import AuditLog


def _jsonable(value: Any) -> Any:
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    return value


SENSITIVE_FIELDS = {"hashed_password", "token_hash", "payment_reference"}


def snapshot(obj: Any, fields: list[str] | None = None) -> dict[str, Any]:
    """Serializable column snapshot of an ORM object."""
    mapper = inspect(obj).mapper
    names = fields or [c.key for c in mapper.column_attrs]
    return {
        name: _jsonable(getattr(obj, name))
        for name in names
        if name not in SENSITIVE_FIELDS
    }


def diff(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    changes = {}
    for key in set(before) | set(after):
        if key in ("updated_at",):
            continue
        if before.get(key) != after.get(key):
            changes[key] = {"from": before.get(key), "to": after.get(key)}
    return changes


def record_audit(
    db: Session,
    *,
    action: str,
    actor_user_id: str | None = None,
    organization_id: str | None = None,
    entity_type: str | None = None,
    entity_id: str | None = None,
    summary: str | None = None,
    changes: dict[str, Any] | None = None,
    request: Request | None = None,
) -> AuditLog:
    entry = AuditLog(
        organization_id=organization_id,
        actor_user_id=actor_user_id,
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        summary=(summary or "")[:500] or None,
        changes=_jsonable(changes) if changes else None,
        ip_address=client_ip(request) if request else None,
        user_agent=user_agent(request) if request else None,
        request_id=request_id_var.get(),
    )
    db.add(entry)
    return entry
