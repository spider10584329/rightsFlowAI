"""Regression tests for the n8n deep-audit repairs (docs/N8N_DEEP_AUDIT_REPORT.md):
N8N-02 statement retry state machine, N8N-03 incident alerting, N8N-04 credential
expiry health, N8N-05 event gating/retention, N8N-06 mapping confirmation,
N8N-07 instance binding, N8N-09 inbox files (XLSX, rejections), N8N-12 rate
limits, N8N-13 error handler marks the run failed."""

import io
import uuid
from datetime import timedelta
from decimal import Decimal as D

from openpyxl import Workbook
from sqlalchemy import func, select

from app.core.config import settings
from app.db.mixins import utc_now
from app.models.automation import (
    AutomationEvent,
    AutomationInboxFile,
    AutomationIncident,
    AutomationReviewTask,
    AutomationRun,
    AutomationStatementState,
    IntegrationCredential,
)
from app.models.catalog import Work
from app.models.platform import AuditLog, BackgroundJob, Notification
from app.models.royalty import RoyaltyStatement, StatementLine
from tests.conftest import run_jobs
from tests.test_automation import CSV, Bot, admin_url, catalog, issue  # noqa: F401  (catalog = fixture)

A = "/api/v1/automation"


def make_bot(client, team, **kw):
    return Bot(client, issue(client, team, **kw)["token"])


def set_expiry(db, token: str, delta: timedelta | None, revoked: bool = False) -> None:
    key_id = token.split("_")[1]
    values = {"expires_at": (utc_now() + delta) if delta is not None else None}
    if revoked:
        values["revoked_at"] = utc_now()
    db.execute(IntegrationCredential.__table__.update().where(IntegrationCredential.key_id == key_id).values(**values))
    db.commit()


def notes(db, type_: str) -> list[Notification]:
    db.expire_all()
    return list(db.scalars(select(Notification).where(Notification.type == type_)).all())


# =========================================================================== N8N-04 credential expiry


def test_health_reports_credential_expiry_levels(client, team, db):
    bot = make_bot(client, team)
    healthy = bot.get("/health").json()
    assert healthy["status"] == "healthy" and healthy["credential"]["expiry_level"] == "ok"

    set_expiry(db, bot.token, timedelta(days=10))
    warning = bot.get("/health").json()
    assert warning["status"] == "warning" and warning["credential"]["expiry_level"] == "warning"
    assert {"code": "credential_expiring", "severity": "warning"}.items() <= warning["issues"][0].items()
    assert bot.token not in str(warning)  # never echoes the key

    set_expiry(db, bot.token, timedelta(days=1, hours=1))
    critical = bot.get("/health").json()
    assert critical["status"] == "critical" and critical["credential"]["expiry_level"] == "critical"

    set_expiry(db, bot.token, timedelta(minutes=-1))
    assert bot.get("/health").status_code == 401  # expired: surfaced by the caller as critical

    other = make_bot(client, team, name="revoked one")
    set_expiry(db, other.token, timedelta(days=30), revoked=True)
    assert other.get("/health").status_code == 401


def test_backend_warns_admins_about_expiring_keys_independently_of_n8n(client, team, db):
    from app.services.automation.maintenance import notify_expiring_credentials

    bot = make_bot(client, team)
    set_expiry(db, bot.token, timedelta(days=10))
    assert notify_expiring_credentials(db) == 1
    assert notify_expiring_credentials(db) == 0  # once per level
    set_expiry(db, bot.token, timedelta(days=1))
    assert notify_expiring_credentials(db) == 1  # escalates to critical once
    set_expiry(db, bot.token, timedelta(minutes=-5))
    assert notify_expiring_credentials(db) == 1  # and once more when expired
    titles = [n.title for n in notes(db, "automation_failed")]
    assert any("expires in 10 day" in t or "expires in 9 day" in t for t in titles)
    assert any("has expired" in t for t in titles)
    recipients = {n.user_id for n in notes(db, "automation_failed")}
    assert recipients == {team["owner"]["id"], team["admin"]["id"]}  # admins only, own org


# =========================================================================== N8N-03 incidents


def alert(bot, execution_id, message="ECONNREFUSED 127.0.0.1:8000", resource="Upload statement",
          workflow="royalty-import"):
    return bot.post("/alerts", json={"workflow": workflow, "execution_id": str(execution_id),
                                     "error_message": message, "resource": resource}).json()


def test_repeated_failures_alert_once_then_remind_escalate_and_recover(client, team, db, monkeypatch):
    bot = make_bot(client, team)
    monkeypatch.setattr(settings, "automation_alert_escalation_occurrences", 4)
    first = alert(bot, 1)
    assert first["action"] == "alerted" and first["recipient_count"] == 2
    assert [alert(bot, n)["action"] for n in (2, 3)] == ["suppressed", "suppressed"]
    # Every failure is still logged per execution.
    db.expire_all()
    assert db.scalar(select(func.count()).select_from(AuditLog).where(
        AuditLog.action == "automation.workflow_failed")) == 3
    # After the suppression window a reminder goes out.
    db.execute(AutomationIncident.__table__.update().values(
        last_alerted_at=utc_now() - timedelta(minutes=settings.automation_alert_suppression_minutes + 1)))
    db.commit()
    escalated = alert(bot, 4)
    assert escalated["action"] == "escalated" and escalated["recipient_count"] == 1  # owners only
    db.execute(AutomationIncident.__table__.update().values(
        last_alerted_at=utc_now() - timedelta(minutes=settings.automation_alert_suppression_minutes + 1)))
    db.commit()
    assert alert(bot, 5)["action"] == "reminded"
    # Recovery: the workflow succeeds -> resolved + one recovery notice.
    run = bot.post("/runs", json={"workflow": "royalty-import", "trigger_type": "schedule", "execution_id": "6"}).json()
    bot.post(f"/runs/{run['id']}/finish", json={"status": "succeeded"})
    db.expire_all()
    incident = db.scalar(select(AutomationIncident))
    assert incident.status == "resolved" and incident.occurrences == 5 and incident.suppressed == 2
    assert any(n.title.startswith("Recovered:") for n in notes(db, "automation_failed"))
    # Re-occurrence opens a new incident and alerts again.
    assert alert(bot, 7)["action"] == "alerted"
    db.expire_all()
    assert db.scalar(select(func.count()).select_from(AutomationIncident)) == 2


def test_a_run_that_reports_a_problem_does_not_resolve_its_own_incident(client, team, db):
    """The health workflow alerts, then finishes 'succeeded': the incident must stay open
    until a later execution succeeds."""
    bot = make_bot(client, team)
    for execution in ("41", "42"):
        run = bot.post("/runs", json={"workflow": "automation-health", "trigger_type": "schedule",
                                      "execution_id": execution}).json()
        alert(bot, execution, workflow="automation-health", message="Automation key expires in 10 days",
              resource="credential_expiring")
        bot.post(f"/runs/{run['id']}/finish", json={"status": "succeeded"})
    db.expire_all()
    incident = db.scalar(select(AutomationIncident))
    assert incident.status == "open" and incident.occurrences == 2 and incident.alerts_sent == 1
    run = bot.post("/runs", json={"workflow": "automation-health", "trigger_type": "schedule",
                                  "execution_id": "43"}).json()
    bot.post(f"/runs/{run['id']}/finish", json={"status": "succeeded"})
    db.expire_all()
    assert db.scalar(select(AutomationIncident)).status == "resolved"


def test_health_recovers_once_failures_recover(client, team, db):
    """Health must not stay 'warning' because of its own incident or of failures that a
    later successful run has already recovered."""
    bot = make_bot(client, team)
    failed = bot.post("/runs", json={"workflow": "royalty-import", "trigger_type": "schedule",
                                     "execution_id": "61"}).json()
    alert(bot, 61)
    alert(bot, 62, workflow="automation-health", message="Automation key expires soon", resource="credential")
    health = bot.get("/health").json()
    assert {"recent_failed_runs", "open_incidents"} <= set(health["problems"])
    assert db.get(AutomationRun, failed["id"]) is not None
    ok = bot.post("/runs", json={"workflow": "royalty-import", "trigger_type": "schedule",
                                 "execution_id": "63"}).json()
    bot.post(f"/runs/{ok['id']}/finish", json={"status": "succeeded"})
    health = bot.get("/health").json()
    # Only the health workflow's own incident is open: it does not count against health.
    assert health["status"] == "healthy" and health["issues"] == [], health["issues"]
    assert health["runs"]["failed_last_24h"] == 1 and health["runs"]["open_incidents"] == 1


def test_distinct_failures_are_not_suppressed_and_orgs_are_isolated(client, team, db):
    bot = make_bot(client, team)
    other = make_bot(client, team, role="outsider", org_key="other")
    assert alert(bot, 1)["action"] == "alerted"
    assert alert(bot, 2, resource="Review results")["action"] == "alerted"           # other resource
    assert alert(bot, 3, message="HTTP 401 invalid_automation_key")["action"] == "alerted"  # other category
    assert alert(bot, 4, workflow="contract-expiration")["action"] == "alerted"      # other workflow
    # Another organization's identical failure opens its own incident, alerting its own admins.
    assert alert(other, 1)["action"] == "alerted"
    db.expire_all()
    by_org = dict(db.execute(select(AutomationIncident.organization_id, func.count())
                             .group_by(AutomationIncident.organization_id)).all())
    assert by_org == {team["org_id"]: 4, team["other_org"]["id"]: 1}
    outsider_notes = [n for n in notes(db, "automation_failed") if n.user_id == team["outsider"]["id"]]
    assert {n.organization_id for n in outsider_notes} == {team["other_org"]["id"]}
    listed = client.get(admin_url(team["org_id"], "/incidents"), headers=team["admin"]["headers"]).json()
    assert len(listed) == 4
    assert client.get(admin_url(team["org_id"], "/incidents"), headers=team["outsider"]["headers"]).status_code == 404


def test_error_handler_alert_marks_the_started_run_failed(client, team, db):
    """N8N-13: the error workflow only knows the n8n execution id."""
    bot = make_bot(client, team)
    run = bot.post("/runs", json={"workflow": "royalty-import", "trigger_type": "schedule", "execution_id": "900"}).json()
    result = alert(bot, 900, message="Review results: 500 Internal Server Error")
    assert result["run_id"] == run["id"] and result["category"] == "server_error"
    db.expire_all()
    stored = db.get(AutomationRun, run["id"])
    assert stored.status == "failed" and stored.error_code == "workflow_failed"


# =========================================================================== N8N-02 retry state machine


def _fail(db, sid: str, message: str) -> None:
    statement = db.get(RoyaltyStatement, sid)
    job = db.get(BackgroundJob, statement.job_id)
    statement.status = "failed"
    statement.errors = [{"row": None, "errors": [message]}]
    job.status, job.error = "failed", message
    db.commit()


def _due_now(db, sid: str) -> None:
    db.execute(AutomationStatementState.__table__.update().where(AutomationStatementState.statement_id == sid)
               .values(next_attempt_at=utc_now() - timedelta(seconds=1)))
    db.commit()


def test_transient_failures_retry_with_backoff_then_stop_for_manual_review(client, team, catalog, db):
    bot = make_bot(client, team)
    sid = bot.upload().json()["id"]
    assert bot.post(f"/statements/{sid}/process").json()["automation"]["outcome"] == "started"
    _fail(db, sid, "Lost connection to MySQL server during query")
    first = bot.post(f"/statements/{sid}/process").json()["automation"]
    assert first["outcome"] == "retry_scheduled" and first["error_category"] == "transient"
    assert first["attempts"] == 1
    waiting = bot.post(f"/statements/{sid}/process").json()["automation"]
    assert waiting["outcome"] == "retry_waiting"  # not due yet: no new job
    db.expire_all()
    jobs_before = db.scalar(select(func.count()).select_from(BackgroundJob).where(BackgroundJob.job_type == "royalty_import"))
    # No notification while retries are pending.
    assert bot.post(f"/statements/{sid}/review", json={}).json()["outcome"] == "retry_waiting"
    _due_now(db, sid)
    assert bot.post(f"/statements/{sid}/process").json()["automation"]["outcome"] == "retry_started"
    _fail(db, sid, "Lost connection to MySQL server during query")
    second = bot.post(f"/statements/{sid}/process").json()["automation"]
    assert second["outcome"] == "retry_scheduled" and second["attempts"] == 2
    db.expire_all()
    state = db.scalar(select(AutomationStatementState).where(AutomationStatementState.statement_id == sid))
    gap = state.next_attempt_at - utc_now()
    assert gap > timedelta(minutes=settings.automation_statement_retry_base_minutes * 2 - 1)  # exponential
    _due_now(db, sid)
    bot.post(f"/statements/{sid}/process")
    _fail(db, sid, "Lost connection to MySQL server during query")
    final = bot.post(f"/statements/{sid}/process").json()["automation"]
    assert final["outcome"] == "needs_manual_review" and final["attempts"] == 3
    # Stays stopped (restart-safe: the state is in the database).
    assert bot.post(f"/statements/{sid}/process").json()["automation"]["outcome"] == "needs_manual_review"
    db.expire_all()
    assert db.scalar(select(func.count()).select_from(BackgroundJob).where(
        BackgroundJob.job_type == "royalty_import")) == jobs_before + 2
    # Authorized users are told once that intervention is needed.
    review = bot.post(f"/statements/{sid}/review", json={}).json()
    assert review["needs_review"] is True and review["notification"]["status"] == "sent"
    assert bot.post(f"/statements/{sid}/review", json={}).json()["notification"] is None
    # Exactly one statement exists: retries never import twice.
    assert db.scalar(select(func.count()).select_from(RoyaltyStatement)) == 1


def test_permanent_failure_stops_immediately_and_manual_retry_resumes(client, team, catalog, db):
    bot = make_bot(client, team)
    sid = bot.upload().json()["id"]
    bot.post(f"/statements/{sid}/process")
    _fail(db, sid, "Mapped columns not found in file: Earnings (USD)")
    result = bot.post(f"/statements/{sid}/process").json()["automation"]
    assert result["outcome"] == "needs_manual_review" and result["error_category"] == "invalid_input"
    url = admin_url(team["org_id"], f"/statements/{sid}/retry")
    assert client.post(url, headers=team["viewer"]["headers"]).status_code == 403
    retried = client.post(url, headers=team["manager"]["headers"])
    assert retried.status_code == 200, retried.text
    assert retried.json()["state"] == "processing" and retried.json()["attempts"] == 1
    run_jobs()
    assert bot.post(f"/statements/{sid}/process").json()["automation"]["outcome"] == "completed"
    listed = client.get(admin_url(team["org_id"], "/statements"), headers=team["viewer"]["headers"]).json()
    assert listed[0]["state"] == "completed"


# =========================================================================== N8N-06 mapping confirmation


def _app_upload(client, team, content=CSV):
    r = client.post(f"/api/v1/organizations/{team['org_id']}/royalties/statements",
                    data={"source_name": "App Upload", "source_category": "distributor",
                          "period_start": "2026-03-01", "period_end": "2026-03-31", "currency": "USD"},
                    files={"file": ("app.csv", content.encode(), "text/csv")}, headers=team["manager"]["headers"])
    assert r.status_code == 201, r.text
    return r.json()


def test_app_uploads_wait_for_a_person_to_confirm_the_mapping(client, team, catalog, db):
    bot = make_bot(client, team)
    st = _app_upload(client, team)
    waiting = bot.post(f"/statements/{st['id']}/process").json()
    assert waiting["automation"]["outcome"] == "awaiting_mapping_confirmation" and waiting["status"] == "uploaded"
    assert bot.post(f"/statements/{st['id']}/review", json={}).json()["outcome"] == "awaiting_mapping_confirmation"
    mapping_url = f"/api/v1/organizations/{team['org_id']}/royalties/statements/{st['id']}/mapping"
    # Rejected and incomplete mappings don't count as confirmation.
    bad = client.put(mapping_url, json={"adapter": st["adapter"], "column_mapping": {"amount": "No Such Column"}},
                     headers=team["manager"]["headers"])
    assert bad.status_code == 422
    incomplete = client.put(mapping_url, json={"adapter": st["adapter"], "column_mapping": {"title": "Title"}},
                            headers=team["manager"]["headers"])
    assert incomplete.status_code == 422
    assert bot.post(f"/statements/{st['id']}/process").json()["automation"]["outcome"] == "awaiting_mapping_confirmation"
    # Viewers can't confirm.
    assert client.put(mapping_url, json={"adapter": st["adapter"], "column_mapping": st["column_mapping"]},
                      headers=team["viewer"]["headers"]).status_code == 403
    ok = client.put(mapping_url, json={"adapter": st["adapter"], "column_mapping": st["column_mapping"]},
                    headers=team["manager"]["headers"])
    assert ok.status_code == 200
    # Automation resumes from the statement.ready event.
    claim = bot.post("/events/claim", json={"event_types": ["statement.ready"]}, idem=False).json()
    assert claim["count"] == 1 and claim["events"][0]["payload"]["statement_id"] == st["id"]
    started = bot.post(f"/statements/{st['id']}/process").json()
    assert started["automation"]["outcome"] == "started" and started["mapping_confirmed"] is True


def test_inbox_statements_need_a_usable_mapping(client, team, catalog, db):
    bot = make_bot(client, team)
    st = bot.upload(content=b"Store,Earnings (USD)\nSpotify,1.00\n", filename="no-identifier.csv").json()
    result = bot.post(f"/statements/{st['id']}/process").json()
    assert result["automation"]["outcome"] == "mapping_required" and result["status"] == "uploaded"


# =========================================================================== N8N-05 events


def test_no_events_without_automation_and_stale_events_expire(client, team, db, monkeypatch):
    from app.services.automation.events import expire_stale_events

    org = f"/api/v1/organizations/{team['org_id']}"
    assert client.post(f"{org}/works", json={"title": "Before automation"}, headers=team["manager"]["headers"]).status_code == 201
    db.expire_all()
    assert db.scalar(select(func.count()).select_from(AutomationEvent)) == 0
    bot = make_bot(client, team)
    client.post(f"{org}/works", json={"title": "After automation"}, headers=team["manager"]["headers"])
    db.expire_all()
    assert db.scalar(select(func.count()).select_from(AutomationEvent)) == 1
    # Retention: an old pending event expires (kept, never delivered).
    db.execute(AutomationEvent.__table__.update().values(
        created_at=utc_now() - timedelta(days=settings.automation_pending_event_retention_days + 1)))
    db.commit()
    assert expire_stale_events(db, batch_size=1) == 1
    db.expire_all()
    event = db.scalar(select(AutomationEvent))
    assert event.status == "expired" and "retention" in event.last_error
    assert bot.post("/events/claim", json={"event_types": ["work.created"]}, idem=False).json()["count"] == 0
    # Revoking the last key: leftover pending events expire; new ones aren't written.
    client.post(f"{org}/works", json={"title": "Pending at revocation"}, headers=team["manager"]["headers"])
    for cred in client.get(admin_url(team["org_id"], "/credentials"), headers=team["admin"]["headers"]).json():
        client.post(admin_url(team["org_id"], f"/credentials/{cred['id']}/revoke"), json={}, headers=team["admin"]["headers"])
    assert expire_stale_events(db) == 1
    client.post(f"{org}/works", json={"title": "After revocation"}, headers=team["manager"]["headers"])
    db.expire_all()
    assert db.scalar(select(func.count()).select_from(AutomationEvent)) == 2
    # Re-activation: a new key starts a fresh stream; expired events stay expired.
    new_bot = make_bot(client, team, name="reactivated")
    client.post(f"{org}/works", json={"title": "Reactivated"}, headers=team["manager"]["headers"])
    claimed = new_bot.post("/events/claim", json={"event_types": ["work.created"]}, idem=False).json()
    assert claimed["count"] == 1


def test_expiry_is_organization_safe(client, team, db):
    from app.services.automation import events as outbox

    make_bot(client, team)  # org A uses automation; org B does not
    outbox.emit_event(db, organization_id=team["org_id"], event_type="work.created", payload={"entity_id": "a"})
    outbox.emit_event(db, organization_id=team["other_org"]["id"], event_type="work.created", payload={"entity_id": "b"})
    db.commit()
    assert outbox.expire_stale_events(db) == 1
    db.expire_all()
    states = dict(db.execute(select(AutomationEvent.organization_id, AutomationEvent.status)).all())
    assert states == {team["org_id"]: "pending", team["other_org"]["id"]: "expired"}


# =========================================================================== N8N-07 instance binding


def test_key_binds_to_one_instance_and_admin_release_recovers(client, team, db):
    bot = make_bot(client, team)
    first, second = "instance-aaaa-1111", "instance-bbbb-2222"
    who = client.get(A + "/whoami", headers={**bot.headers(idem=False), "X-Automation-Instance": first}).json()
    assert who["this_instance_matches"] is True and who["bound_instance"] == "instance…"
    again = client.get(A + "/whoami", headers={**bot.headers(idem=False), "X-Automation-Instance": first})
    assert again.status_code == 200
    conflict = client.get(A + "/whoami", headers={**bot.headers(idem=False), "X-Automation-Instance": second})
    assert conflict.status_code == 409 and conflict.json()["error"]["code"] == "instance_conflict"
    assert conflict.json()["error"]["details"]["bound_instance_stale"] is False
    # A mutating call from the second instance is refused too (no double processing).
    blocked = client.post(A + "/runs", json={"workflow": "royalty-import", "trigger_type": "manual"},
                          headers={**bot.headers(), "X-Automation-Instance": second})
    assert blocked.status_code == 409
    # Diagnostics without the header still work.
    assert bot.get("/whoami").status_code == 200
    cred_id = bot.get("/whoami").json()["credential_id"]
    url = admin_url(team["org_id"], f"/credentials/{cred_id}/release-instance")
    assert client.post(url, headers=team["manager"]["headers"]).status_code == 403
    released = client.post(url, headers=team["admin"]["headers"])
    assert released.status_code == 200 and released.json()["bound_instance"] is None
    moved = client.get(A + "/whoami", headers={**bot.headers(idem=False), "X-Automation-Instance": second})
    assert moved.status_code == 200 and moved.json()["this_instance_matches"] is True
    db.expire_all()
    actions = set(db.scalars(select(AuditLog.action).where(AuditLog.action.like("automation.instance%"))).all())
    assert actions == {"automation.instance_bound", "automation.instance_conflict", "automation.instance_released"}


def test_idempotency_keys_from_different_instances_do_not_collide(client, team):
    """Workflows prefix keys with their instance id, so a reset n8n (execution ids
    restart at 1) can't hit the previous instance's stored keys."""
    bot = make_bot(client, team)
    body = {"workflow": "royalty-import", "trigger_type": "manual", "execution_id": "1"}
    assert bot.post("/runs", json=body, idem="instance-old:run-start-1").status_code == 201
    fresh = bot.post("/runs", json={**body, "trigger_type": "schedule"}, idem="instance-new:run-start-1")
    assert fresh.status_code == 201


# =========================================================================== N8N-09 inbox files


def _xlsx(rows) -> bytes:
    wb = Workbook()
    ws = wb.active
    for row in rows:
        ws.append(row)
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


def test_xlsx_inbox_statement_imports_with_exact_amounts_and_no_formula_execution(client, team, catalog, db):
    bot = make_bot(client, team)
    data = _xlsx([
        ["Store", "Artist", "Title", "ISRC", "Country of Sale", "Quantity", "Earnings (USD)", "Sale Month"],
        ["Spotify", "Nova", "Midnight Drive", "USAB12600001", "US", 10, 1234.5678, "2026-03"],
        ["Spotify", "Nova", "Midnight Drive", "USAB12600001", "GB", 1, "=1+1", "2026-03"],
    ])
    up = client.post(A + "/statements", headers=bot.headers(),
                     data={"source_name": "XLSX Distro", "source_category": "distributor",
                           "period_start": "2026-03-01", "period_end": "2026-03-31", "currency": "USD"},
                     files={"file": ("march.xlsx", data,
                                     "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert up.status_code == 201, up.text
    assert up.json()["inbox_file"]["state"] == "imported"
    sid = up.json()["id"]
    bot.post(f"/statements/{sid}/process")
    run_jobs()
    db.expire_all()
    lines = db.scalars(select(StatementLine).where(StatementLine.statement_id == sid)
                       .order_by(StatementLine.row_number)).all()
    assert lines[0].is_valid and lines[0].amount == D("1234.5678")
    # The formula is not evaluated: the cell has no cached value, so the row is invalid.
    assert lines[1].is_valid is False


def test_rejected_inbox_files_get_one_explicit_failure_record(client, team, db):
    bot = make_bot(client, team)
    for attempt in range(2):
        r = client.post(A + "/statements", headers=bot.headers(),
                        data={"source_name": "Legacy", "source_category": "distributor",
                              "period_start": "2026-03-01", "period_end": "2026-03-31", "currency": "USD"},
                        files={"file": ("old.xls", b"\xd0\xcf\x11\xe0legacy-binary", "application/vnd.ms-excel")})
        assert r.status_code == 422 and r.json()["inbox_file"]["state"] == "rejected"
    db.expire_all()
    row = db.scalar(select(AutomationInboxFile))
    assert row.times_seen == 2 and row.state == "rejected" and row.file_name == "old.xls"
    assert db.scalar(select(func.count()).select_from(AutomationReviewTask).where(
        AutomationReviewTask.kind == "inbox_file_rejected")) == 1
    assert len([n for n in notes(db, "automation_review") if "rejected" in n.title]) == 3  # once x managers+
    listed = client.get(admin_url(team["org_id"], "/inbox-files"), headers=team["admin"]["headers"]).json()
    assert listed[0]["state"] == "rejected"


def test_duplicate_inbox_file_keeps_imported_record(client, team, catalog, db):
    bot = make_bot(client, team)
    first = bot.upload().json()
    second = bot.upload().json()
    assert second["duplicate"] is True and second["inbox_file"]["state"] == "imported"
    assert second["inbox_file"]["times_seen"] == 2 and second["id"] == first["id"]


# =========================================================================== N8N-12 rate limits


def test_failed_authentication_is_rate_limited_per_ip(client):
    codes = [client.get(A + "/whoami", headers={"Authorization": "Bearer rfa_0123456789abcdef_" + "x" * 43}).status_code
             for _ in range(21)]
    assert codes[:20] == [401] * 20 and codes[20] == 429


def test_per_key_request_rate_limit(client, team, monkeypatch):
    bot = make_bot(client, team)
    monkeypatch.setattr(settings, "automation_rate_limit_per_minute", 3)
    codes = [bot.get("/whoami").status_code for _ in range(4)]
    assert codes == [200, 200, 200, 429]
