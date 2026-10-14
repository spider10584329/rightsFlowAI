"""Incident-level alerting for automation failures (audit N8N-03).

Every failure is logged per execution (an ``automation.workflow_failed`` audit
entry, and the run is marked failed). Who gets told, and when, is decided per
*incident*: failures with the same organization, workflow, error category and
resource share one open incident.

- First failure: alert the organization's admins.
- Repeats within ``automation_alert_suppression_minutes``: counted, not alerted.
- Repeats after the window: one "still failing" reminder per window.
- ``automation_alert_escalation_occurrences`` reached: one escalation to owners.
- The workflow succeeds again: the incident is resolved and admins get a
  recovery notice. A later failure opens a new incident.

Distinct categories or resources never suppress each other. Alerts only go to
members of the incident's own organization.
"""

import hashlib
import re
from datetime import timedelta
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.mixins import utc_now
from app.models.automation import AutomationIncident
from app.services.audit import record_audit
from app.services.automation.credentials import redact
from app.services.notifications import notify_user, org_member_ids

# Ordered: first match wins.
_CATEGORY_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("authentication", re.compile(r"\b(401|403)\b|unauthori[sz]ed|forbidden|invalid_automation_key|missing_scope|instance_conflict", re.I)),
    ("connection", re.compile(r"ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|connection refused|socket hang up|unreachable", re.I)),
    ("timeout", re.compile(r"timed? ?out|ETIMEDOUT|ESOCKETTIMEDOUT|timeout", re.I)),
    ("rate_limited", re.compile(r"\b429\b|rate.?limit", re.I)),
    ("server_error", re.compile(r"\b5\d\d\b|internal server error|service unavailable", re.I)),
    ("client_error", re.compile(r"\b4\d\d\b|validation|unprocessable", re.I)),
]
KNOWN_CATEGORIES = {name for name, _ in _CATEGORY_PATTERNS} | {"health", "workflow_error"}


def classify(error_code: str | None, message: str | None) -> str:
    if error_code and error_code.startswith("health"):
        return "health"
    text = f"{error_code or ''} {message or ''}"
    for name, pattern in _CATEGORY_PATTERNS:
        if pattern.search(text):
            return name
    return "workflow_error"


def fingerprint(workflow: str, category: str, resource: str | None) -> str:
    return hashlib.sha256(f"{workflow}|{category}|{resource or ''}".encode()).hexdigest()


def _notify(db: Session, organization_id: str, *, minimum_role: str, title: str, body: str,
            severity: str, type: str = "automation_failed") -> int:
    count = 0
    for user_id in org_member_ids(db, organization_id, minimum_role=minimum_role):
        if notify_user(db, user_id=user_id, organization_id=organization_id, type=type, title=title[:255],
                       body=body, link="/settings/automation?tab=incidents", severity=severity) is not None:
            count += 1
    return count


def record_failure(db: Session, *, organization_id: str, workflow: str, category: str, resource: str | None,
                   execution_id: str | None, message: str | None, actor_user_id: str | None) -> dict[str, Any]:
    """Log one failure and decide whether to alert. Does not commit."""
    now = utc_now()
    safe_message = redact(message, 300) or "No details"
    resource = (resource or None) and resource[:120]
    fp = fingerprint(workflow, category, resource)
    record_audit(db, action="automation.workflow_failed", actor_user_id=actor_user_id,
                 organization_id=organization_id, entity_type="automation_workflow", entity_id=None,
                 summary=f"{workflow} failed ({category}{', ' + resource if resource else ''}): {safe_message}"[:500],
                 changes={"execution_id": execution_id, "category": category, "resource": resource})
    incident = db.scalar(select(AutomationIncident).where(
        AutomationIncident.organization_id == organization_id, AutomationIncident.fingerprint == fp,
        AutomationIncident.status == "open").with_for_update())
    label = f"'{workflow}'" + (f" at '{resource}'" if resource else "")
    if incident is None:
        incident = AutomationIncident(
            organization_id=organization_id, fingerprint=fp, workflow=workflow[:100], category=category,
            resource=resource, title=f"Automation {label} failed: {category.replace('_', ' ')}"[:255],
            last_error=safe_message, last_execution_id=execution_id, occurrences=1, alerts_sent=1,
            first_seen_at=now, last_seen_at=now, last_alerted_at=now)
        db.add(incident)
        db.flush()
        recipients = _notify(db, organization_id, minimum_role="admin", title=incident.title,
                             body=f"{safe_message}\nFurther identical failures are grouped into this incident.",
                             severity="error")
        return {"incident_id": incident.id, "action": "alerted", "occurrences": 1, "recipient_count": recipients,
                "category": category}

    incident.occurrences += 1
    incident.last_seen_at = now
    incident.last_error = safe_message
    incident.last_execution_id = execution_id
    action, recipients = "suppressed", 0
    window = timedelta(minutes=settings.automation_alert_suppression_minutes)
    if incident.escalated_at is None and incident.occurrences >= settings.automation_alert_escalation_occurrences:
        incident.escalated_at = now
        incident.last_alerted_at = now
        incident.alerts_sent += 1
        action = "escalated"
        recipients = _notify(db, organization_id, minimum_role="owner",
                             title=f"Escalated: {incident.title}"[:255],
                             body=f"{incident.occurrences} failures since {incident.first_seen_at:%Y-%m-%d %H:%M} UTC. "
                                  f"Latest: {safe_message}", severity="error")
    elif incident.last_alerted_at is None or now - incident.last_alerted_at >= window:
        incident.last_alerted_at = now
        incident.alerts_sent += 1
        action = "reminded"
        recipients = _notify(db, organization_id, minimum_role="admin",
                             title=f"Still failing: {incident.title}"[:255],
                             body=f"{incident.occurrences} failures since {incident.first_seen_at:%Y-%m-%d %H:%M} UTC. "
                                  f"Latest: {safe_message}", severity="error")
    else:
        incident.suppressed += 1
    return {"incident_id": incident.id, "action": action, "occurrences": incident.occurrences,
            "recipient_count": recipients, "category": category}


def resolve_for_workflow(db: Session, *, organization_id: str, workflow: str, execution_id: str | None,
                         reason: str = "workflow succeeded") -> list[str]:
    """Close the workflow's open incidents and send one recovery notice each. Does not commit.

    Incidents last reported by this same execution stay open: a run that reports a problem
    (e.g. the health check) and then finishes normally has not recovered from it."""
    now = utc_now()
    resolved = []
    query = select(AutomationIncident).where(
        AutomationIncident.organization_id == organization_id, AutomationIncident.workflow == workflow,
        AutomationIncident.status == "open")
    if execution_id:
        query = query.where(or_(AutomationIncident.last_execution_id.is_(None),
                                AutomationIncident.last_execution_id != execution_id))
    for incident in db.scalars(query.with_for_update()).all():
        incident.status = "resolved"
        incident.resolved_at = now
        incident.resolution = f"{reason} (execution {execution_id})"[:255] if execution_id else reason
        _notify(db, organization_id, minimum_role="admin", title=f"Recovered: {incident.title}"[:255],
                body=f"Resolved after {incident.occurrences} failure(s) since "
                     f"{incident.first_seen_at:%Y-%m-%d %H:%M} UTC.", severity="success")
        resolved.append(incident.id)
    return resolved


def incident_payload(incident: AutomationIncident) -> dict[str, Any]:
    return {
        "id": incident.id, "workflow": incident.workflow, "category": incident.category,
        "resource": incident.resource, "status": incident.status, "title": incident.title,
        "last_error": incident.last_error, "last_execution_id": incident.last_execution_id,
        "occurrences": incident.occurrences, "alerts_sent": incident.alerts_sent,
        "suppressed": incident.suppressed, "escalated_at": incident.escalated_at,
        "first_seen_at": incident.first_seen_at, "last_seen_at": incident.last_seen_at,
        "last_alerted_at": incident.last_alerted_at, "resolved_at": incident.resolved_at,
        "resolution": incident.resolution,
    }
