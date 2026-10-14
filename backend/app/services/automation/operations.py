"""Business operations exposed to n8n. Each one reuses an existing service and
returns ids, statuses and counts rather than amounts or document text, so n8n
execution logs never hold confidential royalty data.

Guarantees:
- No posting, reversal or payout operation exists here: automation can at most
  calculate a *draft* run, which never touches the ledger.
- Every notification goes through a delivery record with a dedupe key, so a
  retried or re-run workflow never notifies twice.
- AI output is stored as pending suggestions or advisory review notes; it never
  changes rights, contracts or financial records.
"""

import hashlib
import json
import re
from datetime import date, timedelta
from typing import Any

from fastapi import Request
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import AppError, ConflictError, LimitExceededError, NotFoundError, PermissionDeniedError, ValidationFailedError
from app.core.permissions import ROLE_RANK, OrgContext
from app.db.mixins import utc_now
from app.models.automation import AutomationReviewTask
from app.models.billing import AISuggestion
from app.models.organization_membership import OrganizationMembership
from app.models.platform import BackgroundJob
from app.models.royalty import RoyaltyRun, StatementLine
from app.models.user import User
from app.services import jobs
from app.services.audit import record_audit
from app.services.automation import records
from app.services.automation.context import AutomationContext
from app.services.automation.credentials import credential_state, redact
from app.services.automation.events import automation_enabled, emit_event, outbox_stats
from app.services.notifications import notify_user, org_member_ids

REVIEW_REASONS_HELD = (
    "missing_ownership", "disputed_ownership", "over_allocated_ownership", "unassigned_share",
    "no_controlled_shares", "non_controlled_share", "no_applicable_contract_term",
    "ambiguous_contract_terms", "gross_net_sign_mismatch",
)
REPORT_TYPES_MONTHLY = ("revenue_by_source", "revenue_by_territory", "revenue_by_work",
                        "revenue_by_recording", "earnings_by_payee")
REPORT_RECIPIENT_MIN_ROLE = "admin"
_PERIOD_RE = re.compile(r"^(\d{4})-(0[1-9]|1[0-2])$")


def _hash(data: Any) -> str:
    return hashlib.sha256(json.dumps(data, sort_keys=True, default=str).encode("utf-8")).hexdigest()[:16]


def _notify_members(db: Session, actx: AutomationContext, *, minimum_role: str, type: str, title: str,
                    body: str | None, link: str | None, severity: str = "info",
                    only_user_ids: list[str] | None = None) -> list[str]:
    """Notify active members with at least ``minimum_role``; returns who was
    actually notified (inactive or departed users are skipped by notify_user)."""
    candidates = only_user_ids if only_user_ids is not None else org_member_ids(
        db, actx.organization_id, minimum_role=minimum_role)
    notified: list[str] = []
    for user_id in candidates:
        if notify_user(db, user_id=user_id, organization_id=actx.organization_id, type=type,
                       title=title, body=body, link=link, severity=severity) is not None:
            notified.append(user_id)
    return notified


def _send_once(db: Session, actx: AutomationContext, *, kind: str, dedupe_key: str, subject_type: str | None,
               subject_id: str | None, run_id: str | None, minimum_role: str, type: str, title: str,
               body: str | None, link: str | None, severity: str = "info") -> dict[str, Any]:
    delivery, created = records.reserve_delivery(
        db, organization_id=actx.organization_id, kind=kind, dedupe_key=dedupe_key,
        subject_type=subject_type, subject_id=subject_id, run_id=run_id)
    if not created:
        return records.delivery_payload(delivery, duplicate=True)
    notified = _notify_members(db, actx, minimum_role=minimum_role, type=type, title=title, body=body,
                               link=link, severity=severity)
    delivery.recipient_user_ids = notified
    delivery.status = "sent" if notified else "skipped"
    delivery.detail = None if notified else {"reason": "no_recipients",
                                             "message": f"No active member with role {minimum_role} or higher"}
    delivery.sent_at = utc_now() if notified else None
    return records.delivery_payload(delivery)



def _lock_subject(db: Session, subject_type: str, subject_id: str) -> None:
    """Serialize automation writes about one subject (review task + notification).

    n8n sends a node's items in parallel, so two events about the same work can be
    reviewed at the same instant. Locking the subject's own (existing) row first
    avoids InnoDB gap-lock deadlocks on the review task's unique key."""
    from app.models.catalog import Party, Recording, Work
    from app.models.rights import RightsConflict
    from app.models.contract import Contract
    from app.models.organization import Organization
    from app.models.royalty import RoyaltyStatement

    model = {"work": Work, "recording": Recording, "party": Party, "rights_conflict": RightsConflict,
             "statement": RoyaltyStatement, "contract": Contract, "organization": Organization}[subject_type]
    db.execute(select(model.id).where(model.id == subject_id).with_for_update())


# --------------------------------------------------------------------------- identity / health


def whoami(actx: AutomationContext) -> dict[str, Any]:
    from app.services.automation.credentials import expiry_level, instance_payload

    credential = actx.credential
    level, days_left = expiry_level(credential)
    return {
        "organization_id": actx.organization_id,
        "organization_name": actx.org.organization.name,
        "credential_id": credential.id,
        "credential_name": credential.name,
        "key_id": credential.key_id,
        "scopes": credential.scopes,
        "expires_at": credential.expires_at,
        "expiry_level": level,
        "days_until_expiry": days_left,
        "acts_as_role": actx.org.role,
        "this_instance_matches": actx.instance_id is not None
        and actx.instance_id == credential.bound_instance_id,
        **instance_payload(credential),
    }


SEVERITY_RANK = {"healthy": 0, "warning": 1, "critical": 2}


def health(db: Session, actx: AutomationContext) -> dict[str, Any]:
    """Healthy / warning / critical with one entry per issue (N8N-04).

    The key that made this request is necessarily valid; an expired or revoked
    key never reaches here (401), which the health workflow and
    scripts/check-n8n.ps1 report as critical on their side."""
    from app.services.automation.credentials import expiry_level

    started = utc_now()
    try:
        db.execute(text("SELECT 1"))
        database = {"ok": True, "latency_ms": round((utc_now() - started).total_seconds() * 1000, 1)}
    except Exception:  # noqa: BLE001 - reported, not raised
        database = {"ok": False, "latency_ms": None}
    credential = actx.credential
    level, days_left = expiry_level(credential)
    failed = records.recent_failures(db, actx.organization_id)
    stale = records.stale_running(db, actx.organization_id)
    outbox = outbox_stats(db, actx.organization_id)
    open_incidents = records.open_incidents(db, actx.organization_id)
    # The health workflow's own incidents mirror these checks; counting them would keep
    # health from ever recovering.
    other_incidents = records.open_incidents(db, actx.organization_id, exclude_workflow="automation-health")
    unrecovered = records.unrecovered_failures(db, actx.organization_id)
    last_runs = db.execute(text(
        "SELECT workflow, status, MAX(started_at) FROM automation_runs WHERE organization_id = :org "
        "GROUP BY workflow, status ORDER BY workflow"), {"org": actx.organization_id}).all()
    latest: dict[str, dict[str, Any]] = {}
    for workflow, status, started_at in last_runs:
        current = latest.get(workflow)
        if current is None or started_at > current["started_at"]:
            latest[workflow] = {"workflow": workflow, "status": status, "started_at": started_at}

    issues: list[dict[str, Any]] = []

    def issue(code: str, severity: str, message: str) -> None:
        issues.append({"code": code, "severity": severity, "message": message})

    if not database["ok"]:
        issue("database_unavailable", "critical", "The API cannot reach its database.")
    if level == "critical":
        issue("credential_expiring", "critical",
              f"The automation key expires in {days_left} day(s): rotate it now (Settings > Automation).")
    elif level == "warning":
        issue("credential_expiring", "warning",
              f"The automation key expires in {days_left} day(s): plan a rotation (Settings > Automation).")
    if unrecovered:
        issue("recent_failed_runs", "warning",
              f"{unrecovered} workflow run(s) failed in the last 24 hours with no successful run since.")
    if outbox["dead"]:
        issue("dead_events", "warning", f"{outbox['dead']} event(s) exhausted their retries; requeue after fixing.")
    if stale:
        issue("stuck_runs", "warning", f"{stale} run(s) have been running for more than 6 hours.")
    if other_incidents:
        issue("open_incidents", "warning", f"{other_incidents} automation incident(s) are open.")
    status = "healthy"
    for item in issues:
        if SEVERITY_RANK[item["severity"]] > SEVERITY_RANK[status]:
            status = item["severity"]
    return {
        "status": status,
        "issues": issues,
        "problems": [item["code"] for item in issues],
        "api": {"ok": True, "checked_at": utc_now()},
        "database": database,
        "credential": {"id": credential.id, "key_id": credential.key_id, "state": credential_state(credential),
                       "expires_at": credential.expires_at, "days_until_expiry": days_left,
                       "expiry_level": level, "rotation_recommended": level in ("warning", "critical"),
                       "warning_days": settings.automation_credential_warning_days,
                       "critical_days": settings.automation_credential_critical_days,
                       "scopes": credential.scopes},
        "outbox": outbox,
        "runs": {"failed_last_24h": failed, "running_over_6h": stale, "open_incidents": open_incidents,
                 "latest_by_workflow": sorted(latest.values(), key=lambda r: r["workflow"])},
    }


# --------------------------------------------------------------------------- statements (Workflow A)


WAIT_POLL_SECONDS = 1.0
IN_FLIGHT_STATEMENT = ("queued", "processing")
IN_FLIGHT_JOB = ("queued", "running")


def _wait_until(db: Session, check, wait_seconds: int) -> None:
    """Bounded long-poll so workflows don't need polling loops: re-read until
    ``check()`` is true or ``wait_seconds`` (max 60) pass."""
    import time

    deadline = time.monotonic() + max(0, min(wait_seconds, 60))
    while not check() and time.monotonic() < deadline:
        db.rollback()  # end the read so the next one sees the worker's commits
        time.sleep(WAIT_POLL_SECONDS)


def statement_status(db: Session, actx: AutomationContext, statement_id: str, *,
                     wait_seconds: int = 0) -> dict[str, Any]:
    from app.services.royalty_import import get_statement

    if wait_seconds:
        _wait_until(db, lambda: get_statement(db, actx.organization_id, statement_id).status
                    not in IN_FLIGHT_STATEMENT, wait_seconds)
    statement = get_statement(db, actx.organization_id, statement_id)
    return {
        "id": statement.id, "status": statement.status, "source_category": statement.source_category,
        "period_start": statement.period_start, "period_end": statement.period_end,
        "currency": statement.currency, "adapter": statement.adapter, "job_id": statement.job_id,
        "total_rows": statement.total_rows, "valid_rows": statement.valid_rows,
        "error_rows": statement.error_rows, "matched_rows": statement.matched_rows,
        "has_amount_mapping": bool((statement.column_mapping or {}).get("amount")),
        "mapping_confirmed": statement.mapping_confirmed_at is not None,
    }


def start_processing(db: Session, actx: AutomationContext, statement_id: str, request: Request | None) -> dict[str, Any]:
    """Advance the statement's automation state (N8N-02, N8N-06): start processing
    only when its mapping is usable (and, for app uploads, confirmed by a person);
    retry failures with bounded exponential backoff; stop for manual review."""
    from app.services.automation import statement_flow
    from app.services.royalty_import import get_statement

    statement = get_statement(db, actx.organization_id, statement_id, lock=True)
    progress = statement_flow.advance(db, actx.org, statement, request)
    return {**statement_status(db, actx, statement_id), "automation": progress,
            "already_started": progress["outcome"] not in ("started", "retry_started")}


def _line_counts(db: Session, statement_id: str) -> dict[str, int]:
    counts = {"valid": 0, "invalid": 0, "matched": 0, "unmatched": 0, "ignored": 0}
    for is_valid, match_status, count in db.execute(
        select(StatementLine.is_valid, StatementLine.match_status, func.count())
        .where(StatementLine.statement_id == statement_id)
        .group_by(StatementLine.is_valid, StatementLine.match_status)
    ).all():
        if not is_valid:
            counts["invalid"] += count
            continue
        counts["valid"] += count
        counts[match_status] = counts.get(match_status, 0) + count
    return counts


def review_statement(db: Session, actx: AutomationContext, statement_id: str, *, calculate: bool,
                     run_id: str | None, request: Request | None) -> dict[str, Any]:
    """Summarize a processed statement for human review: unmatched lines and
    money the engine *held* (missing/ambiguous contract terms, disputed or
    missing ownership...). Optionally calculates a draft run so holds are
    visible; never posts. Creates/updates a review task and notifies managers
    once per distinct finding set."""
    from app.services import royalty_runs
    from app.services.royalty_import import get_statement

    from app.services.automation import statement_flow

    statement = get_statement(db, actx.organization_id, statement_id)
    flow = statement_flow.get_state(db, statement, lock=False)
    if statement.status == "uploaded" and flow.source == "app" and statement.mapping_confirmed_at is None \
            and statement_flow.mapping_usable(statement):
        # Waiting for the uploader to confirm the mapping: nothing to raise yet (N8N-06).
        db.commit()
        return {"statement_id": statement.id, "status": statement.status, "needs_review": False,
                "outcome": "awaiting_mapping_confirmation", "findings": {"status": statement.status},
                "review_task_id": None, "task_change": None, "notification": None}
    if statement.status == "failed" and flow.state == "retry_waiting":
        # Bounded automatic retries are pending: don't alarm anyone yet (N8N-02).
        db.commit()
        return {"statement_id": statement.id, "status": statement.status, "needs_review": False,
                "outcome": "retry_waiting", "automation": statement_flow.state_payload(flow),
                "findings": {"status": statement.status}, "review_task_id": None, "task_change": None,
                "notification": None}
    if statement.status == "uploaded" and not statement_flow.mapping_usable(statement):
        # Automatic mapping failed: a person has to confirm the columns before processing.
        _lock_subject(db, "statement", statement.id)
        task, change = records.upsert_review_task(
            db, organization_id=actx.organization_id, kind="statement_mapping",
            dedupe_key=f"statement-mapping:{statement.id}",
            title=f"Confirm the column mapping for statement '{statement.source_name}'",
            subject_type="statement", subject_id=statement.id, link=f"/royalties/statements/{statement.id}",
            details={"status": statement.status, "adapter": statement.adapter,
                     "reason": "No amount column and identifying column (ISRC, ISWC, UPC or title) could be "
                               "identified automatically"}, run_id=run_id)
        notification = None
        if change == "created":
            notification = _send_once(
                db, actx, kind="statement_review", dedupe_key=f"statement-mapping:{statement.id}",
                subject_type="statement", subject_id=statement.id, run_id=run_id, minimum_role="manager",
                type="automation_review", title=task.title,
                body="Automation could not map this statement's columns. Confirm the mapping, then process it.",
                link=f"/royalties/statements/{statement.id}", severity="warning")
        db.commit()
        return {"statement_id": statement.id, "status": statement.status, "needs_review": True,
                "findings": {"status": statement.status, "mapping_required": True},
                "review_task_id": task.id, "task_change": change, "notification": notification}
    if statement.status in ("uploaded", "queued", "processing"):
        raise ConflictError(f"Statement is {statement.status}; wait for processing to finish",
                            code="statement_not_processed", details={"status": statement.status})
    if statement.status == "posted":
        return {"statement_id": statement.id, "status": "posted", "needs_review": False,
                "message": "Already posted; nothing to review automatically"}

    findings: dict[str, Any] = {"status": statement.status, "lines": _line_counts(db, statement.id),
                                "held": [], "run_id": None, "calculation_error": None,
                                "import_errors": statement.error_rows or 0}
    if statement.status == "failed":
        findings["automation_state"] = flow.state
        findings["failure_category"] = flow.error_category
        findings["attempts"] = flow.attempts
    run = None
    if statement.status in ("processed", "calculated"):
        if calculate and statement.status == "processed":
            try:
                run = royalty_runs.calculate(db, actx.org, statement.id, request)
            except AppError as exc:
                db.rollback()
                findings["calculation_error"] = exc.code
        if run is None:
            run = db.scalar(select(RoyaltyRun).where(RoyaltyRun.statement_id == statement.id,
                                                     RoyaltyRun.status == "calculated")
                            .order_by(RoyaltyRun.created_at.desc()))
    if run is not None:
        findings["run_id"] = run.id
        findings["held"] = sorted(
            ({"reason": w["reason"], "count": int(w.get("count") or 0)} for w in (run.warnings or [])
             if w.get("type") == "unallocated" and w.get("reason") in REVIEW_REASONS_HELD),
            key=lambda item: item["reason"])
        findings["other_currencies"] = any(w.get("type") == "other_currencies" for w in (run.warnings or []))
    # Status after any calculation, so re-running the review reports the same findings.
    findings["status"] = statement.status

    lines = findings["lines"]
    needs_review = bool(statement.status == "failed" or lines["unmatched"] or lines["invalid"]
                        or findings["held"] or findings["calculation_error"])
    result: dict[str, Any] = {"statement_id": statement.id, "status": statement.status,
                              "needs_review": needs_review, "findings": findings,
                              "review_task_id": None, "task_change": None, "notification": None}
    if not needs_review:
        db.commit()
        return result

    held_lines = sum(item["count"] for item in findings["held"])
    title = (f"Review royalty statement '{statement.source_name}' "
             f"({statement.period_start:%Y-%m-%d} to {statement.period_end:%Y-%m-%d})")
    _lock_subject(db, "statement", statement.id)
    task, change = records.upsert_review_task(
        db, organization_id=actx.organization_id, kind="statement_review",
        dedupe_key=f"statement-review:{statement.id}", title=title, subject_type="statement",
        subject_id=statement.id, link=f"/royalties/statements/{statement.id}", details=findings, run_id=run_id)
    result["review_task_id"] = task.id
    result["task_change"] = change
    if change != "unchanged":
        parts = []
        if statement.status == "failed":
            parts.append(f"the import failed ({flow.error_category or 'unknown cause'}) and automatic "
                         f"processing stopped after {flow.attempts} attempt(s): retry it from the statement page")
        if lines["unmatched"]:
            parts.append(f"{lines['unmatched']} unmatched line(s)")
        if lines["invalid"]:
            parts.append(f"{lines['invalid']} invalid line(s)")
        if held_lines:
            reasons = ", ".join(item["reason"].replace("_", " ") for item in findings["held"])
            parts.append(f"{held_lines} line(s) held for review ({reasons})")
        if findings["calculation_error"]:
            parts.append(f"calculation could not complete ({findings['calculation_error']})")
        result["notification"] = _send_once(
            db, actx, kind="statement_review", dedupe_key=f"statement-review:{statement.id}:{_hash(findings)}",
            subject_type="statement", subject_id=statement.id, run_id=run_id, minimum_role="manager",
            type="automation_review", title=title,
            body="Automated check found: " + "; ".join(parts) + ". Nothing has been posted.",
            link=f"/royalties/statements/{statement.id}", severity="warning")
    db.commit()
    return result


# --------------------------------------------------------------------------- contracts (Workflow B)


def expiring_contracts(db: Session, actx: AutomationContext, within_days: int) -> list[dict[str, Any]]:
    from app.services import contracts as contract_service

    if not 1 <= within_days <= 365:
        raise ValidationFailedError("within_days must be between 1 and 365")
    today = contract_service.today_utc()
    items = []
    for contract in contract_service.expiring_contracts(db, actx.organization_id, within_days):
        days = (contract.end_date - today).days
        items.append({"contract_id": contract.id, "status": contract.status, "end_date": contract.end_date,
                      "days_until_expiry": days, "expired": days < 0, "auto_renew": contract.auto_renew,
                      "notice_period_days": contract.notice_period_days})
    return items


def contract_reminder(db: Session, actx: AutomationContext, contract_id: str, threshold_days: int,
                      run_id: str | None) -> dict[str, Any]:
    """Send one reminder for (contract, end date, threshold). ``threshold_days``
    0 means "has expired". The server re-checks that the reminder is actually
    due, so a misconfigured workflow can't send misleading reminders."""
    from app.services import contracts as contract_service

    if not 0 <= threshold_days <= 365:
        raise ValidationFailedError("threshold_days must be 0 (expired) to 365")
    contract = contract_service.get_contract(db, actx.organization_id, contract_id)
    if contract.end_date is None:
        raise ValidationFailedError("Contract has no end date", code="reminder_not_due")
    days = (contract.end_date - contract_service.today_utc()).days
    if threshold_days == 0:
        due = days < 0 and contract.status in ("active", "pending_signature", "expired")
    else:
        due = 0 <= days <= threshold_days and contract.status in contract_service.TRACKED_STATUSES
    if not due:
        raise ValidationFailedError("This reminder is not due for the contract", code="reminder_not_due",
                                    details={"days_until_expiry": days, "status": contract.status})
    if threshold_days == 0:
        title = f"Contract '{contract.title}' has expired"
        body = f"It ended on {contract.end_date:%Y-%m-%d}. Renew, extend or close it out."
    else:
        title = f"Contract '{contract.title}' expires in {days} day(s)"
        body = f"End date {contract.end_date:%Y-%m-%d}."
        if contract.auto_renew:
            body += " It renews automatically."
        if contract.notice_period_days:
            body += f" Notice period: {contract.notice_period_days} days."
    _lock_subject(db, "contract", contract.id)
    delivery = _send_once(
        db, actx, kind="contract_reminder",
        dedupe_key=f"contract-reminder:{contract.id}:{contract.end_date:%Y%m%d}:{threshold_days}",
        subject_type="contract", subject_id=contract.id, run_id=run_id, minimum_role="manager",
        type="contract_expiration", title=title[:255], body=body, link=f"/contracts/{contract.id}",
        severity="warning")
    db.commit()
    return {**delivery, "contract_id": contract.id, "threshold_days": threshold_days, "days_until_expiry": days}


# --------------------------------------------------------------------------- reports (Workflow D)


def previous_month(today: date | None = None) -> str:
    today = today or utc_now().date()
    first = today.replace(day=1)
    last_month = first - timedelta(days=1)
    return f"{last_month:%Y-%m}"


def _period_bounds(period: str) -> tuple[date, date]:
    match = _PERIOD_RE.match(period or "")
    if not match:
        raise ValidationFailedError("period must be YYYY-MM", code="invalid_period")
    start = date(int(match.group(1)), int(match.group(2)), 1)
    end = (start.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
    if end >= utc_now().date():
        raise ValidationFailedError("Only completed months can be reported", code="period_not_complete")
    return start, end


def request_monthly_report(db: Session, actx: AutomationContext, *, period: str, report_type: str,
                           run_id: str | None) -> dict[str, Any]:
    if report_type not in REPORT_TYPES_MONTHLY:
        raise ValidationFailedError("Unsupported report type", details={"allowed": list(REPORT_TYPES_MONTHLY)})
    start, end = _period_bounds(period)
    _lock_subject(db, "organization", actx.organization_id)  # one report per period, even if runs overlap
    delivery, created = records.reserve_delivery(
        db, organization_id=actx.organization_id, kind="monthly_report",
        dedupe_key=f"monthly-report:{report_type}:{period}", subject_type="report", subject_id=None,
        run_id=run_id)
    if not created:
        db.commit()
        return records.delivery_payload(delivery, duplicate=True)
    # The existing report job computes the figures from posted/processed data;
    # n8n never sees or computes them.
    job = jobs.enqueue(
        db, organization_id=actx.organization_id, job_type="report_generation",
        payload={"report_type": report_type, "period_start": start.isoformat(), "period_end": end.isoformat(),
                 "currency": None},
        created_by_id=actx.service_user.id, max_attempts=2,
        idempotency_key=f"automation-report:{actx.organization_id}:{report_type}:{period}", commit=False)
    delivery.job_id = job.id
    delivery.detail = {"period": period, "report_type": report_type}
    db.commit()
    return records.delivery_payload(delivery)


def job_status(db: Session, actx: AutomationContext, job_id: str, *, wait_seconds: int = 0) -> dict[str, Any]:
    def load():
        found = db.scalar(select(BackgroundJob).where(BackgroundJob.id == job_id,
                                                      BackgroundJob.organization_id == actx.organization_id)
                          .execution_options(populate_existing=True))
        if found is None:
            raise NotFoundError("Job not found")
        return found

    if wait_seconds:
        _wait_until(db, lambda: load().status not in IN_FLIGHT_JOB, wait_seconds)
    job = load()
    return {"id": job.id, "job_type": job.job_type, "status": job.status, "progress": job.progress,
            "attempts": job.attempts, "max_attempts": job.max_attempts, "error": redact(job.error, 300),
            "finished_at": job.finished_at}


def _authorized_report_recipient(db: Session, organization_id: str, user_id: str) -> bool:
    row = db.execute(select(OrganizationMembership.role, User.is_active, User.is_service_account)
                     .join(User, User.id == OrganizationMembership.user_id)
                     .where(OrganizationMembership.organization_id == organization_id,
                            OrganizationMembership.user_id == user_id,
                            OrganizationMembership.is_active.is_(True))).first()
    return bool(row and row[1] and not row[2] and ROLE_RANK[row[0]] >= ROLE_RANK[REPORT_RECIPIENT_MIN_ROLE])


def send_monthly_report(db: Session, actx: AutomationContext, delivery_id: str,
                        recipient_user_id: str | None) -> dict[str, Any]:
    """Tell authorized members (admins/owners) the report is ready. The email
    and notification contain a link into the app, never the figures."""
    delivery = db.scalar(select(records.AutomationDelivery).where(
        records.AutomationDelivery.id == delivery_id,
        records.AutomationDelivery.organization_id == actx.organization_id,
        records.AutomationDelivery.kind == "monthly_report").with_for_update())
    if delivery is None:
        raise NotFoundError("Report delivery not found")
    if delivery.status in ("sent", "skipped"):
        db.commit()
        return records.delivery_payload(delivery, duplicate=True)
    job = db.get(BackgroundJob, delivery.job_id) if delivery.job_id else None
    if job is None or job.status != "succeeded" or not job.result:
        db.commit()
        raise ConflictError(f"The report is not ready (job {job.status if job else 'missing'})",
                            code="report_not_ready", details={"job_status": job.status if job else None})
    if recipient_user_id is not None and not _authorized_report_recipient(db, actx.organization_id, recipient_user_id):
        db.commit()
        raise PermissionDeniedError("That recipient is not an active admin or owner of this organization",
                                    code="recipient_not_authorized")
    detail = delivery.detail or {}
    period = detail.get("period", "")
    report_label = str(detail.get("report_type", "report")).replace("_", " ")
    title = f"Monthly royalty report ready: {report_label}, {period}"
    body = (f"The {report_label} report for {period} has been generated from RightsFlow data. "
            "Open RightsFlow to download it (Settings > Jobs, or Royalties > Reports).")
    notified = _notify_members(db, actx, minimum_role=REPORT_RECIPIENT_MIN_ROLE, type="monthly_report",
                               title=title, body=body, link="/settings/jobs",
                               only_user_ids=[recipient_user_id] if recipient_user_id else None)
    delivery.recipient_user_ids = notified
    delivery.status = "sent" if notified else "skipped"
    delivery.sent_at = utc_now() if notified else None
    delivery.detail = {**detail, "rows": job.result.get("rows"), "file_id": job.result.get("file_id"),
                       **({} if notified else {"reason": "no_recipients"})}
    db.commit()
    return records.delivery_payload(delivery)


# --------------------------------------------------------------------------- event acknowledgement


def check_event_lease(db: Session, actx: AutomationContext, event_id: str | None, lease_token: str | None) -> None:
    """Fail fast (409 lease_lost) before doing work for an event this caller no longer holds."""
    if not event_id:
        return
    from app.services.automation.events import get_event

    event = get_event(db, actx.organization_id, event_id)
    if event.status != "claimed" or event.lease_token != lease_token:
        raise ConflictError("The lease on this event is no longer held", code="lease_lost",
                            details={"status": event.status})


def complete_event(db: Session, actx: AutomationContext, result: dict[str, Any], event_id: str | None,
                   lease_token: str | None) -> dict[str, Any]:
    if not event_id:
        return result
    from app.services.automation.events import ack_event

    ack_event(db, organization_id=actx.organization_id, event_id=event_id, lease_token=lease_token or "",
              outcome="completed", error=None, correlation_id=actx.correlation_id)
    return {**result, "event_id": event_id, "event_status": "completed"}


# --------------------------------------------------------------------------- AI review (Workflow C)

_ENTITY_GETTERS = {"work": "get_work", "recording": "get_recording", "party": "get_party"}
_ENTITY_PATHS = {"work": "works", "recording": "recordings", "party": "parties"}


def _entity_link(entity_type: str, entity_id: str) -> str:
    return f"/catalog/{_ENTITY_PATHS[entity_type]}/{entity_id}"


def _ai_outcome(exc: Exception) -> str:
    from app.services.ai.provider import AINotConfiguredError, AIProviderError

    if isinstance(exc, AINotConfiguredError) or getattr(exc, "code", "") == "feature_not_available":
        return "ai_unavailable"
    if isinstance(exc, LimitExceededError):
        return "ai_limit_reached"
    if isinstance(exc, AIProviderError):
        return "ai_error"
    return "ai_error"


def ai_metadata_review(db: Session, actx: AutomationContext, entity_type: str, entity_id: str,
                       run_id: str | None) -> dict[str, Any]:
    from app.services import catalog
    from app.services.ai.features import propose_metadata_cleanup

    if entity_type not in _ENTITY_GETTERS:
        raise ValidationFailedError("entity_type must be work, recording or party")
    getattr(catalog, _ENTITY_GETTERS[entity_type])(db, actx.organization_id, entity_id)
    issues = [{"code": i["code"], "severity": i["severity"], "message": i["message"]}
              for i in catalog.validation_issues(db, actx.organization_id, entity_type)
              if i["entity_id"] == entity_id]
    outcome, suggestion_ids, proposed_fields, error_code = "no_changes", [], [], None
    try:
        proposal = propose_metadata_cleanup(db, actx.organization_id, actx.service_user.id,
                                            entity_type, entity_id)
        suggestion_ids = [s.id for s in proposal["suggestions"]]
        proposed_fields = sorted({f for s in proposal["suggestions"] for f in (s.proposed_changes or {})})
        if suggestion_ids:
            outcome = "suggested"
    except (AppError, LimitExceededError) as exc:
        db.rollback()
        outcome, error_code = _ai_outcome(exc), getattr(exc, "code", None)
    result: dict[str, Any] = {"entity_type": entity_type, "entity_id": entity_id, "outcome": outcome,
                              "error_code": error_code, "suggestion_ids": suggestion_ids,
                              "proposed_fields": proposed_fields, "deterministic_issues": issues,
                              "review_task_id": None, "notification": None}
    if not suggestion_ids and not issues:
        db.commit()
        return result
    details = {"outcome": outcome, "suggestion_ids": suggestion_ids, "proposed_fields": proposed_fields,
               "deterministic_issues": issues, "ai_generated": bool(suggestion_ids),
               "note": "AI suggestions are pending human approval and change nothing until approved."}
    _lock_subject(db, entity_type, entity_id)
    task, change = records.upsert_review_task(
        db, organization_id=actx.organization_id, kind="ai_metadata",
        dedupe_key=f"ai-metadata:{entity_type}:{entity_id}",
        title=f"Metadata review for {entity_type} {entity_id[:8]}: {len(suggestion_ids)} AI suggestion(s), "
              f"{len(issues)} issue(s)",
        subject_type=entity_type, subject_id=entity_id, link=_entity_link(entity_type, entity_id),
        details=details, run_id=run_id, ai_suggestion_id=suggestion_ids[0] if suggestion_ids else None)
    result["review_task_id"] = task.id
    if change != "unchanged":
        result["notification"] = _send_once(
            db, actx, kind="ai_review", dedupe_key=f"ai-metadata:{entity_type}:{entity_id}:{_hash(details)}",
            subject_type=entity_type, subject_id=entity_id, run_id=run_id, minimum_role="manager",
            type="automation_review", title=task.title,
            body="Review the suggested metadata changes; nothing is applied until someone approves them.",
            link=_entity_link(entity_type, entity_id))
    db.commit()
    return result


def ai_conflict_review(db: Session, actx: AutomationContext, conflict_id: str, run_id: str | None) -> dict[str, Any]:
    from app.services import rights
    from app.services.ai.features import explain_conflict

    conflict = rights.get_conflict(db, actx.organization_id, conflict_id)
    if conflict.status not in ("open", "acknowledged"):
        return {"conflict_id": conflict.id, "outcome": "not_open", "status": conflict.status,
                "review_task_id": None, "notification": None}
    details: dict[str, Any] = {"conflict_type": conflict.conflict_type, "severity": conflict.severity,
                               "system_explanation": conflict.explanation, "ai_generated": False,
                               "note": "Advisory only: conflicts are resolved by a person in Rights > Conflicts."}
    outcome, error_code = "explained", None
    try:
        explanation = explain_conflict(db, actx.organization_id, actx.service_user.id, conflict.id)
        details.update({
            "ai_generated": True,
            "ai_summary": str(explanation["summary"])[:4000],
            "likely_causes": [str(c)[:500] for c in explanation["likely_causes"][:10]],
            "suggested_next_steps": [str(s)[:500] for s in explanation["suggested_next_steps"][:10]],
        })
    except (AppError, LimitExceededError) as exc:
        db.rollback()
        outcome, error_code = _ai_outcome(exc), getattr(exc, "code", None)
    details["outcome"] = outcome
    _lock_subject(db, "rights_conflict", conflict.id)
    task, change = records.upsert_review_task(
        db, organization_id=actx.organization_id, kind="ai_conflict", dedupe_key=f"ai-conflict:{conflict.id}",
        title=f"Rights conflict needs review: {conflict.title}", subject_type="rights_conflict",
        subject_id=conflict.id, link=f"/rights/conflicts/{conflict.id}", details=details, run_id=run_id)
    notification = None
    if change != "unchanged":
        notification = _send_once(
            db, actx, kind="ai_review", dedupe_key=f"ai-conflict:{conflict.id}:{_hash(details)}",
            subject_type="rights_conflict", subject_id=conflict.id, run_id=run_id, minimum_role="manager",
            type="automation_review", title=task.title[:255],
            body="A rights conflict was flagged for review" + (" with an AI explanation." if details["ai_generated"]
                                                                else "."),
            link=f"/rights/conflicts/{conflict.id}", severity="warning")
    db.commit()
    return {"conflict_id": conflict.id, "outcome": outcome, "error_code": error_code,
            "review_task_id": task.id, "notification": notification}


def ai_review(db: Session, actx: AutomationContext, subject_type: str, subject_id: str,
              run_id: str | None) -> dict[str, Any]:
    if subject_type == "rights_conflict":
        return {"subject_type": subject_type, "subject_id": subject_id,
                **ai_conflict_review(db, actx, subject_id, run_id)}
    return {"subject_type": subject_type, "subject_id": subject_id,
            **ai_metadata_review(db, actx, subject_type, subject_id, run_id)}


def sync_ai_decisions(db: Session, actx: AutomationContext) -> dict[str, Any]:
    """Close metadata review tasks once a person has decided every suggestion
    (approval applies the change through the existing, validated service)."""
    decided: list[dict[str, Any]] = []
    waiting = 0
    tasks = db.scalars(select(AutomationReviewTask).where(
        AutomationReviewTask.organization_id == actx.organization_id,
        AutomationReviewTask.kind == "ai_metadata", AutomationReviewTask.status == "open")).all()
    for task in tasks:
        ids = (task.details or {}).get("suggestion_ids") or []
        if not ids:
            continue
        suggestions = db.scalars(select(AISuggestion).where(AISuggestion.id.in_(ids),
                                                            AISuggestion.organization_id == actx.organization_id)).all()
        if not suggestions or any(s.status == "pending" for s in suggestions):
            waiting += 1
            continue
        latest = max(suggestions, key=lambda s: s.reviewed_at or s.created_at)
        counts: dict[str, int] = {}
        for s in suggestions:
            counts[s.status] = counts.get(s.status, 0) + 1
        task.status = "resolved"
        task.resolved_at = utc_now()
        task.resolved_by_id = latest.reviewed_by_id
        task.resolution_note = "Suggestions decided: " + ", ".join(f"{n} {k}" for k, n in sorted(counts.items()))
        record_audit(db, action="automation.review_task_resolved", actor_user_id=actx.service_user.id,
                     organization_id=actx.organization_id, entity_type="automation_review_task",
                     entity_id=task.id, summary=task.resolution_note)
        decided.append({"review_task_id": task.id, "decisions": counts})
    db.commit()
    return {"resolved": decided, "still_waiting": waiting}


def ai_suggestion_status(db: Session, actx: AutomationContext, suggestion_id: str) -> dict[str, Any]:
    suggestion = db.scalar(select(AISuggestion).where(AISuggestion.id == suggestion_id,
                                                      AISuggestion.organization_id == actx.organization_id))
    if suggestion is None:
        raise NotFoundError("Suggestion not found")
    return {"id": suggestion.id, "status": suggestion.status, "kind": suggestion.kind,
            "entity_type": suggestion.entity_type, "entity_id": suggestion.entity_id,
            "reviewed_at": suggestion.reviewed_at}


# --------------------------------------------------------------------------- alerts / review requests


def raise_alert(db: Session, actx: AutomationContext, *, workflow: str, execution_id: str | None,
                run_id: str | None, error_code: str | None, error_message: str | None,
                resource: str | None = None) -> dict[str, Any]:
    """Record a workflow failure: always logged per execution; alerting is decided
    per incident (first alert, suppression window, escalation; N8N-03)."""
    from app.models.automation import AutomationRun
    from app.services.automation import incidents

    if not run_id and execution_id:
        # Error-handler workflows know the failed execution, not our run id.
        run_id = db.scalar(select(AutomationRun.id).where(
            AutomationRun.organization_id == actx.organization_id, AutomationRun.execution_id == execution_id,
            AutomationRun.status == "running").order_by(AutomationRun.started_at.desc()))
    if run_id:
        run = records.get_run(db, actx.organization_id, run_id, lock=True)
        if run.status == "running":
            run.status = "failed"
            run.finished_at = utc_now()
            run.error_code = (error_code or "workflow_failed")[:80]
            run.error_message = redact(error_message)
    _lock_subject(db, "organization", actx.organization_id)
    category = incidents.classify(error_code, error_message)
    result = incidents.record_failure(
        db, organization_id=actx.organization_id, workflow=workflow, category=category, resource=resource,
        execution_id=execution_id, message=error_message, actor_user_id=actx.service_user.id)
    db.commit()
    return {**result, "run_id": run_id, "status": "sent" if result["recipient_count"] else (
        "suppressed" if result["action"] == "suppressed" else "skipped"),
        "duplicate": result["action"] == "suppressed"}


def inbox_rejected(db: Session, actx: AutomationContext, *, digest: str, file_name: str | None,
                   exc: AppError) -> tuple[int, dict[str, Any]]:
    """Persist an explicit failure state for an inbox file and raise one review
    task the first time this exact file is seen (N8N-09)."""
    from app.services.automation import statement_flow

    db.rollback()
    _lock_subject(db, "organization", actx.organization_id)
    row, first = statement_flow.record_inbox_file(
        db, organization_id=actx.organization_id, digest=digest, file_name=file_name, state="rejected",
        error_code=exc.code, error_message=exc.message)
    if first:
        title = f"Inbox file rejected: {(file_name or 'unknown')[:120]}"
        records.upsert_review_task(
            db, organization_id=actx.organization_id, kind="inbox_file_rejected",
            dedupe_key=f"inbox-file:{digest[:32]}", title=title, subject_type="inbox_file", subject_id=None,
            link="/settings/automation?tab=review",
            details={"file_name": file_name, "error_code": exc.code, "message": redact(exc.message, 300),
                     "action": "Fix or rename the file in the n8n inbox, or remove it."})
        _send_once(db, actx, kind="inbox_file", dedupe_key=f"inbox-file:{digest[:32]}", subject_type="inbox_file",
                   subject_id=None, run_id=None, minimum_role="manager", type="automation_review", title=title,
                   body=f"{exc.code}: {redact(exc.message, 200)}", link="/settings/automation?tab=review",
                   severity="warning")
    db.commit()
    return exc.status_code, {"error": {"code": exc.code, "message": exc.message, "details": exc.details},
                             "inbox_file": statement_flow.inbox_payload(row)}


def inbox_accepted(db: Session, actx: AutomationContext, *, digest: str, file_name: str | None,
                   statement_id: str, duplicate: bool) -> dict[str, Any]:
    from app.services.automation import statement_flow

    row, _ = statement_flow.record_inbox_file(
        db, organization_id=actx.organization_id, digest=digest, file_name=file_name,
        state="duplicate" if duplicate else "imported", statement_id=statement_id)
    db.commit()
    return statement_flow.inbox_payload(row)


REVIEW_SUBJECTS = ("work", "recording", "party", "rights_conflict")


def request_review(db: Session, ctx: OrgContext, subject_type: str, subject_id: str,
                   request: Request | None) -> dict[str, Any]:
    from app.services import catalog, rights

    if subject_type not in REVIEW_SUBJECTS:
        raise ValidationFailedError("Unsupported review subject", details={"allowed": list(REVIEW_SUBJECTS)})
    if subject_type == "rights_conflict":
        rights.get_conflict(db, ctx.organization_id, subject_id)
    else:
        getattr(catalog, _ENTITY_GETTERS[subject_type])(db, ctx.organization_id, subject_id)
    if not automation_enabled(db, ctx.organization_id):
        raise ConflictError("Automation isn't set up for this organization (no automation key)",
                            code="automation_not_configured")
    event = emit_event(db, organization_id=ctx.organization_id, event_type="review.requested",
                       payload={"subject_type": subject_type, "subject_id": subject_id,
                                "requested_by_user_id": ctx.user.id})
    record_audit(db, action="automation.review_requested", actor_user_id=ctx.user.id,
                 organization_id=ctx.organization_id, entity_type=subject_type, entity_id=subject_id,
                 summary=f"Requested automated review of {subject_type}", request=request)
    db.commit()
    return {"event_id": event.id if event else None, "subject_type": subject_type, "subject_id": subject_id}
