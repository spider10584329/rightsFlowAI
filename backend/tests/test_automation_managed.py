"""Managed automation mode: RightsFlow provisions each organization's n8n
workflows, keys and schedules itself; admins only switch automations on and off.

A fake n8n records what the backend creates and checks that every workflow
references credentials and an error workflow that exist."""

import importlib.util
import json
import re
from pathlib import Path

import pytest
from sqlalchemy import select

from app.core.config import settings
from app.db.mixins import utc_now
from app.models.automation import (
    AutomationConnection,
    AutomationDelivery,
    AutomationReviewTask,
    AutomationRun,
    IntegrationCredential,
    OrganizationAutomation,
)
from app.models.platform import BackgroundJob, StoredFile
from app.services.automation import catalog, provisioner
from app.services.automation.n8n_client import N8nError, set_n8n_client
from tests.conftest import run_jobs
from tests.test_royalties import upload

A = "/api/v1/automation"


def url(org_id: str, path: str = "") -> str:
    return f"/api/v1/organizations/{org_id}/automation{path}"


class FakeN8n:
    def __init__(self) -> None:
        self.credentials: dict[str, dict] = {}
        self.workflows: dict[str, dict] = {}
        self.triggers: list[dict] = []
        self.calls: list[tuple[str, str]] = []
        self.fail_with: Exception | None = None
        self._next = 0

    def _id(self, prefix: str) -> str:
        self._next += 1
        return f"{prefix}{self._next:04d}"

    def _check(self) -> None:
        if self.fail_with:
            raise self.fail_with

    def get_credential(self, credential_id):
        self._check()
        return self.credentials.get(credential_id)

    def create_credential(self, *, name, credential_type, data):
        self._check()
        cid = self._id("cred")
        self.credentials[cid] = {"id": cid, "name": name, "type": credential_type, "data": data}
        self.calls.append(("create_credential", cid))
        return {"id": cid, "name": name}

    def update_credential(self, credential_id, *, name, data):
        self._check()
        self.credentials[credential_id].update(name=name, data=data)
        self.calls.append(("update_credential", credential_id))
        return {"id": credential_id}

    def delete_credential(self, credential_id):
        self._check()
        self.credentials.pop(credential_id, None)
        self.calls.append(("delete_credential", credential_id))

    def get_workflow(self, workflow_id):
        self._check()
        return self.workflows.get(workflow_id)

    def _validate(self, body):
        text = json.dumps(body)
        assert "__RF_" not in text, re.findall(r"__RF_[A-Z_]+__", text)
        assert set(body) == {"name", "nodes", "connections", "settings"}
        for node in body["nodes"]:
            for ref in (node.get("credentials") or {}).values():
                assert ref["id"] in self.credentials, f"{node['name']} uses missing credential {ref['id']}"
        error_workflow = body["settings"].get("errorWorkflow")
        if error_workflow is not None:
            assert error_workflow in self.workflows, "error workflow must exist first"

    def create_workflow(self, body):
        self._check()
        self._validate(body)
        wid = self._id("wf")
        self.workflows[wid] = {"id": wid, "active": False, **body}
        self.calls.append(("create_workflow", wid))
        return {"id": wid}

    def update_workflow(self, workflow_id, body):
        self._check()
        self._validate(body)
        self.workflows[workflow_id].update(body)
        self.calls.append(("update_workflow", workflow_id))
        return {"id": workflow_id}

    def publish_workflow(self, workflow_id):
        self._check()
        self.workflows[workflow_id]["active"] = True
        self.calls.append(("publish_workflow", workflow_id))

    def unpublish_workflow(self, workflow_id):
        self._check()
        if workflow_id in self.workflows:
            self.workflows[workflow_id]["active"] = False

    def delete_workflow(self, workflow_id):
        self._check()
        self.workflows.pop(workflow_id, None)
        self.calls.append(("delete_workflow", workflow_id))

    def trigger_webhook(self, path, *, header_name, secret, payload):
        self._check()
        self.triggers.append({"path": path, "header": header_name, "secret": secret, "payload": payload})

    # helpers ------------------------------------------------------------------

    def by_workflow(self, key: str) -> dict:
        suffix = catalog.load_template(key)["name"].split("] - ", 1)[1]
        matches = [w for w in self.workflows.values() if w["name"].endswith(suffix)]
        assert len(matches) == 1, (key, [w["name"] for w in matches])
        return matches[0]

    def api_token(self) -> str:
        tokens = [c["data"]["value"] for c in self.credentials.values() if c["data"]["name"] == "Authorization"]
        assert len(tokens) == 1
        return tokens[0].removeprefix("Bearer ")


@pytest.fixture
def n8n(monkeypatch):
    fake = FakeN8n()
    monkeypatch.setattr(settings, "automation_mode", "managed")
    set_n8n_client(fake)
    yield fake
    set_n8n_client(None)


def enable(client, team, key, role="admin", **body):
    return client.put(url(team["org_id"], f"/managed/{key}"), json={"enabled": True, **body},
                      headers=team[role]["headers"])


def overview(client, team, role="admin"):
    r = client.get(url(team["org_id"], "/managed"), headers=team[role]["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def item(payload, key):
    return next(a for a in payload["automations"] if a["key"] == key)


# --------------------------------------------------------------------------- modes and access


def test_self_hosted_mode_keeps_manual_keys_and_refuses_managed_changes(client, team):
    assert settings.automation_mode == "self_hosted"
    data = overview(client, team)
    assert data["mode"] == "self_hosted" and data["available"] is False and data["automations"] == []
    r = enable(client, team, "royalty_import")
    assert r.status_code == 409 and r.json()["error"]["code"] == "automation_not_managed"


def test_only_admins_manage_automations(client, team, n8n):
    for role in ("viewer", "manager"):
        assert client.get(url(team["org_id"], "/managed"), headers=team[role]["headers"]).status_code == 403
        assert enable(client, team, "royalty_import", role=role).status_code == 403
    assert client.get(url(team["other_org"]["id"], "/managed"), headers=team["admin"]["headers"]).status_code in (403, 404)


def test_managed_mode_refuses_hand_made_keys(client, team, n8n):
    r = client.post(url(team["org_id"], "/credentials"), json={"name": "my n8n"}, headers=team["admin"]["headers"])
    assert r.status_code == 409 and r.json()["error"]["code"] == "automation_managed"


def test_unconfigured_server_cannot_switch_automations_on(client, team, monkeypatch):
    monkeypatch.setattr(settings, "automation_mode", "managed")
    data = overview(client, team)
    assert data["mode"] == "managed" and data["available"] is False
    assert [a["key"] for a in data["automations"]] == list(catalog.USER_AUTOMATIONS)
    r = enable(client, team, "royalty_import")
    assert r.status_code == 409 and r.json()["error"]["code"] == "automation_unavailable"


# --------------------------------------------------------------------------- provisioning


def test_switching_on_provisions_workflows_key_and_schedule(client, team, n8n, db):
    r = enable(client, team, "royalty_import")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "pending" and r.json()["enabled"] is True
    assert db.scalar(select(BackgroundJob).where(BackgroundJob.job_type == provisioner.RECONCILE_JOB)) is not None
    run_jobs()

    data = overview(client, team)
    royalty = item(data, "royalty_import")
    assert royalty["status"] == "active" and royalty["can_run_now"] is True
    assert royalty["next_run_at"] is not None and royalty["schedule"]["description"] == "Every 15 minutes"
    assert data["connection"]["status"] == "active" and data["connection"]["key"]["state"] == "active"
    assert "token" not in json.dumps(data) and "rfa_" in data["connection"]["key"]["key_hint"]

    # Error handler, health check and the import workflow, all published.
    assert len(n8n.workflows) == 3 and all(w["active"] for w in n8n.workflows.values())
    names = sorted(w["name"] for w in n8n.workflows.values())
    assert all(name.startswith("RightsFlow [acme-music] - ") for name in names)
    workflow = n8n.by_workflow("royalty_import")
    nodes = {n["name"]: n for n in workflow["nodes"]}
    assert "Read inbox files" not in nodes  # no local folder in managed mode
    webhook = nodes["Run on request"]
    assert webhook["parameters"]["path"] == f"rightsflow/{team['org_id']}/royalty-import"
    assert webhook["parameters"]["authentication"] == "headerAuth"
    schedule = nodes["On schedule"]["parameters"]["rule"]["interval"][0]
    assert schedule["field"] == "cronExpression" and schedule["expression"].endswith(" * * * *")
    assert '"process_on_upload": true' in nodes["Config"]["parameters"]["jsCode"]
    assert workflow["settings"]["errorWorkflow"] == n8n.by_workflow("error_handler")["id"]
    assert workflow["settings"]["saveDataSuccessExecution"] == "none"

    # Two n8n credentials: the automation key and the webhook trigger secret.
    assert sorted(c["data"]["name"] for c in n8n.credentials.values()) == ["Authorization", "X-RightsFlow-Trigger"]
    key = db.scalar(select(IntegrationCredential).where(IntegrationCredential.organization_id == team["org_id"]))
    assert key.managed and key.scopes == catalog.required_scopes({"royalty_import", *catalog.SYSTEM_AUTOMATIONS})


def test_the_provisioned_key_works_for_the_workflow_and_only_its_scopes(client, team, n8n):
    enable(client, team, "royalty_import")
    run_jobs()
    headers = {"Authorization": f"Bearer {n8n.api_token()}", "X-Automation-Instance": settings.n8n_instance_id}
    who = client.get(f"{A}/whoami", headers=headers)
    assert who.status_code == 200 and who.json()["organization_id"] == team["org_id"]
    # Contract reminders are off, so the key has no contracts:read scope.
    assert client.get(f"{A}/contracts/expiring", headers=headers).status_code == 403


def test_settings_change_updates_only_that_workflow(client, team, n8n, db):
    enable(client, team, "royalty_import")
    enable(client, team, "contract_expiration")
    run_jobs()
    n8n.calls.clear()
    r = client.put(url(team["org_id"], "/managed/contract_expiration"),
                   json={"settings": {"thresholds": [60, 7], "hour_utc": 9}}, headers=team["admin"]["headers"])
    assert r.status_code == 200 and r.json()["settings"]["thresholds"] == [60, 7]
    assert r.json()["schedule"]["description"].startswith("Daily at 09:")
    run_jobs()
    updated = [wid for call, wid in n8n.calls if call == "update_workflow"]
    contract = n8n.by_workflow("contract_expiration")
    assert updated == [contract["id"]]
    assert '"thresholds": [60, 7]' in next(n for n in contract["nodes"] if n["name"] == "Config")["parameters"]["jsCode"]
    rule = next(n for n in contract["nodes"] if n["name"] == "On schedule")["parameters"]["rule"]["interval"][0]
    assert rule["expression"].split()[1] == "9"


def test_invalid_settings_are_rejected(client, team, n8n):
    bad = [
        ("royalty_import", {"interval_minutes": 7}),
        ("contract_expiration", {"thresholds": [0]}),
        ("monthly_reporting", {"report_type": "nope"}),
        ("monthly_reporting", {"day_of_month": 31}),
        ("royalty_import", {"unknown": True}),
    ]
    for key, values in bad:
        r = client.put(url(team["org_id"], f"/managed/{key}"), json={"settings": values},
                       headers=team["admin"]["headers"])
        assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_automation_settings", (key, values)
    r = client.put(url(team["org_id"], "/managed/automation_health"), json={"enabled": False},
                   headers=team["admin"]["headers"])
    assert r.status_code == 422 and r.json()["error"]["code"] == "unknown_automation"


def test_new_scopes_replace_the_key_and_n8n_gets_the_new_one(client, team, n8n, db):
    enable(client, team, "royalty_import")
    run_jobs()
    first_token = n8n.api_token()
    enable(client, team, "contract_expiration")
    run_jobs()
    second_token = n8n.api_token()
    assert second_token != first_token
    keys = db.scalars(select(IntegrationCredential).where(
        IntegrationCredential.organization_id == team["org_id"])).all()
    assert len(keys) == 2
    # Both rows can share a created_at second, so tell them apart by lineage.
    new = next(k for k in keys if k.rotated_from_id is not None)
    old = next(k for k in keys if k.id == new.rotated_from_id)
    assert "contracts:read" in new.scopes and "contracts:read" not in old.scopes
    # The previous key works for a short grace period only.
    assert old.expires_at <= utc_now() + provisioner.KEY_GRACE
    headers = {"Authorization": f"Bearer {second_token}", "X-Automation-Instance": settings.n8n_instance_id}
    assert client.get(f"{A}/contracts/expiring", headers=headers).status_code == 200


def test_key_is_renewed_before_it_expires(client, team, n8n, db):
    enable(client, team, "royalty_import")
    run_jobs()
    key = db.scalar(select(IntegrationCredential).where(IntegrationCredential.managed.is_(True)))
    key.expires_at = utc_now() + provisioner.timedelta(days=settings.automation_managed_rotate_before_days - 1)
    db.commit()
    token = n8n.api_token()
    provisioner.request_reconcile(db, team["org_id"])
    run_jobs()
    assert n8n.api_token() != token


def test_drift_in_n8n_is_repaired(client, team, n8n, db):
    enable(client, team, "royalty_import")
    run_jobs()
    workflow = n8n.by_workflow("royalty_import")
    del n8n.workflows[workflow["id"]]
    n8n.workflows[n8n.by_workflow("automation_health")["id"]]["active"] = False
    r = client.post(url(team["org_id"], "/managed/repair"), headers=team["admin"]["headers"])
    assert r.status_code == 202
    run_jobs()
    assert len(n8n.workflows) == 3 and all(w["active"] for w in n8n.workflows.values())
    row = db.scalar(select(OrganizationAutomation).where(OrganizationAutomation.automation == "royalty_import"))
    assert row.n8n_workflow_id != workflow["id"] and row.status == "active"


def test_n8n_failure_is_reported_and_retried(client, team, n8n, db):
    n8n.fail_with = N8nError("n8n is unreachable: ConnectError")
    enable(client, team, "royalty_import")
    run_jobs()
    data = overview(client, team)
    assert data["connection"]["status"] == "error" and "unreachable" in data["connection"]["last_error"]
    assert item(data, "royalty_import")["status"] == "error"
    job = db.scalar(select(BackgroundJob).where(BackgroundJob.job_type == provisioner.RECONCILE_JOB))
    assert job.status == "queued" and job.attempts == 1  # retried with backoff
    n8n.fail_with = None
    job.run_after = utc_now()
    db.commit()
    run_jobs()
    assert item(overview(client, team), "royalty_import")["status"] == "active"


def test_switching_everything_off_removes_it_from_n8n(client, team, n8n, db):
    enable(client, team, "royalty_import")
    enable(client, team, "monthly_reporting")
    run_jobs()
    assert len(n8n.workflows) == 4
    r = client.post(url(team["org_id"], "/managed/disable-all"), headers=team["admin"]["headers"])
    assert r.status_code == 200
    run_jobs()
    assert n8n.workflows == {} and n8n.credentials == {}
    data = overview(client, team)
    assert data["connection"]["status"] == "disabled" and data["connection"]["key"] is None
    assert all(not a["enabled"] and a["status"] == "disabled" for a in data["automations"])
    assert all(k.revoked_at is not None for k in db.scalars(select(IntegrationCredential)).all())


def test_switching_one_off_removes_only_its_workflow(client, team, n8n):
    enable(client, team, "royalty_import")
    enable(client, team, "ai_metadata_review")
    run_jobs()
    ai = n8n.by_workflow("ai_metadata_review")
    client.put(url(team["org_id"], "/managed/ai_metadata_review"), json={"enabled": False},
               headers=team["admin"]["headers"])
    run_jobs()
    assert ai["id"] not in n8n.workflows and len(n8n.workflows) == 3


def test_archiving_the_organization_tears_automation_down(client, team, n8n, db):
    enable(client, team, "royalty_import")
    run_jobs()
    from tests.conftest import DEFAULT_PASSWORD

    r = client.post(f"/api/v1/organizations/{team['org_id']}/archive",
                    json={"password": DEFAULT_PASSWORD, "confirm_slug": "acme-music"}, headers=team["owner"]["headers"])
    assert r.status_code == 200, r.text
    run_jobs()
    assert n8n.workflows == {} and n8n.credentials == {}


def test_managed_keys_cannot_be_rotated_or_revoked_by_hand(client, team, n8n, db):
    enable(client, team, "royalty_import")
    run_jobs()
    keys = client.get(url(team["org_id"], "/credentials"), headers=team["admin"]["headers"]).json()
    assert len(keys) == 1 and keys[0]["managed"] is True
    for path, body in (("rotate", {"grace_hours": 0}), ("revoke", {}), ("release-instance", None)):
        r = client.post(url(team["org_id"], f"/credentials/{keys[0]['id']}/{path}"), json=body,
                        headers=team["admin"]["headers"])
        assert r.status_code == 409, (path, r.text)


# --------------------------------------------------------------------------- starting runs


def test_run_now_calls_the_workflow_webhook(client, team, n8n, db):
    r = client.post(url(team["org_id"], "/managed/royalty_import/run"), headers=team["admin"]["headers"])
    assert r.status_code == 409 and r.json()["error"]["code"] == "automation_disabled"
    enable(client, team, "royalty_import")
    r = client.post(url(team["org_id"], "/managed/royalty_import/run"), headers=team["admin"]["headers"])
    assert r.status_code == 409 and r.json()["error"]["code"] == "automation_not_ready"
    run_jobs()
    r = client.post(url(team["org_id"], "/managed/royalty_import/run"), headers=team["admin"]["headers"])
    assert r.status_code == 202 and r.json()["status"] == "requested"
    trigger = n8n.triggers[-1]
    assert trigger["path"] == f"rightsflow/{team['org_id']}/royalty-import"
    assert trigger["payload"] == {"trigger": "manual"} and trigger["header"] == "X-RightsFlow-Trigger"
    # The secret is the one stored in the workflow's trigger credential.
    trigger_credential = next(c for c in n8n.credentials.values() if c["data"]["name"] == "X-RightsFlow-Trigger")
    assert trigger["secret"] == trigger_credential["data"]["value"]


def test_run_now_reports_an_unreachable_n8n(client, team, n8n, db):
    enable(client, team, "royalty_import")
    run_jobs()
    n8n.fail_with = N8nError("n8n is unreachable: ConnectError")
    r = client.post(url(team["org_id"], "/managed/royalty_import/run"), headers=team["admin"]["headers"])
    assert r.status_code == 503 and r.json()["error"]["code"] == "automation_unreachable"
    assert db.scalar(select(BackgroundJob).where(BackgroundJob.job_type == provisioner.RECONCILE_JOB,
                                                 BackgroundJob.status == "queued")) is not None


def test_upload_starts_processing_right_away(client, team, n8n, db):
    enable(client, team, "royalty_import")
    run_jobs()
    r = upload(client, team)
    assert r.status_code == 201, r.text
    upload(client, team, filename="april.csv", period_start="2026-04-01", period_end="2026-04-30")
    queued = db.scalars(select(BackgroundJob).where(BackgroundJob.job_type == provisioner.TRIGGER_JOB)).all()
    assert len(queued) == 1  # one pending start covers both uploads
    queued[0].run_after = utc_now()
    db.commit()
    run_jobs()
    assert [t["payload"] for t in n8n.triggers] == [{"trigger": "event"}]


def test_upload_waits_for_the_schedule_when_asked_to(client, team, n8n, db):
    enable(client, team, "royalty_import", settings={"process_on_upload": False})
    run_jobs()
    assert upload(client, team).status_code == 201
    assert db.scalar(select(BackgroundJob).where(BackgroundJob.job_type == provisioner.TRIGGER_JOB)) is None


# --------------------------------------------------------------------------- results


def test_run_detail_links_what_the_run_produced(client, team, n8n, db):
    statement_id = upload(client, team).json()["id"]
    org = team["org_id"]
    run = AutomationRun(organization_id=org, workflow="royalty-import", trigger_type="event", status="partial",
                        summary={"statements": 1, "results": [{"statement_id": statement_id},
                                                              {"statement_id": "not-in-this-org"}]})
    db.add(run)
    db.flush()
    db.add(AutomationReviewTask(organization_id=org, kind="statement_review", dedupe_key="t1", title="Check lines",
                                run_id=run.id, link=f"/royalties/statements/{statement_id}"))
    report = StoredFile(organization_id=org, category="export", original_filename="report-2026-09.csv",
                        content_type="text/csv", size_bytes=10, sha256="0" * 64, storage_key="k",
                        storage_backend="local")
    db.add(report)
    db.flush()
    db.add(AutomationDelivery(organization_id=org, kind="monthly_report", dedupe_key="d1", status="sent",
                              run_id=run.id, detail={"file_id": report.id, "period": "2026-09"}))
    db.commit()

    r = client.get(url(org, f"/runs/{run.id}"), headers=team["admin"]["headers"])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["automation"] == "royalty_import"
    assert [s["id"] for s in body["outputs"]["statements"]] == [statement_id]
    assert [t["title"] for t in body["outputs"]["review_tasks"]] == ["Check lines"]
    assert body["outputs"]["deliveries"][0]["kind"] == "monthly_report"
    assert body["outputs"]["files"] == [{"id": report.id, "filename": "report-2026-09.csv", "size_bytes": 10,
                                         "created_at": body["outputs"]["files"][0]["created_at"]}]
    other = client.get(url(team["other_org"]["id"], f"/runs/{run.id}"), headers=team["outsider"]["headers"])
    assert other.status_code == 404


def test_overview_shows_the_last_run(client, team, n8n, db):
    enable(client, team, "royalty_import")
    run_jobs()
    db.add(AutomationRun(organization_id=team["org_id"], workflow="royalty-import", trigger_type="schedule",
                         status="succeeded", summary={"statements": 0}))
    db.commit()
    last = item(overview(client, team), "royalty_import")["last_run"]
    assert last["status"] == "succeeded" and last["workflow"] == "royalty-import"


def test_hourly_schedule_reconciles_connected_organizations(client, team, n8n, db):
    from app.services.scheduled import schedule_periodic_jobs

    enable(client, team, "royalty_import")
    run_jobs()
    schedule_periodic_jobs(db)
    run_jobs()
    jobs_done = db.scalars(select(BackgroundJob).where(BackgroundJob.job_type == provisioner.RECONCILE_JOB)).all()
    assert len(jobs_done) == 2 and all(j.status == "succeeded" for j in jobs_done)


def test_audit_trail(client, team, n8n, db):
    from app.models.platform import AuditLog

    enable(client, team, "royalty_import")
    client.put(url(team["org_id"], "/managed/royalty_import"), json={"settings": {"interval_minutes": 60}},
               headers=team["admin"]["headers"])
    run_jobs()
    actions = set(db.scalars(select(AuditLog.action).where(AuditLog.organization_id == team["org_id"])).all())
    assert {"automation.enabled", "automation.settings_changed", "automation.managed_key_issued"} <= actions


# --------------------------------------------------------------------------- templates


def test_committed_templates_match_the_builder():
    root = Path(__file__).resolve().parents[2]
    spec = importlib.util.spec_from_file_location("build_workflows", root / "automation" / "n8n" / "build_workflows.py")
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    for path, text in builder.render_all().items():
        assert path.read_text(encoding="utf-8") == text, f"{path.name} is stale: run build_workflows.py"


def test_every_template_renders_completely(team, db):
    connection = AutomationConnection(organization_id=team["org_id"], n8n_credential_id="c1",
                                      n8n_trigger_credential_id="c2")
    from app.models.organization import Organization

    organization = db.get(Organization, team["org_id"])
    rows = provisioner.automation_rows(db, team["org_id"])
    rows[catalog.ERROR_HANDLER].n8n_workflow_id = "wf-error"
    for key in catalog.DEFINITIONS:
        body = provisioner.render_workflow(connection, organization, rows, key)
        assert "__RF_" not in json.dumps(body) and "__RIGHTSFLOW_" not in json.dumps(body), key
        if key in catalog.USER_AUTOMATIONS:
            names = {n["name"] for n in body["nodes"]}
            assert {"Run on request", "On schedule", "Config"} <= names, key
    db.rollback()
