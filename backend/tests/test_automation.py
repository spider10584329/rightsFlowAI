"""n8n automation API: credentials, authentication, tenant isolation,
idempotency, outbox, financial safeguards and the workflow operations."""

import uuid
from datetime import date, timedelta

import pytest
from sqlalchemy import func, select

from app.db.mixins import utc_now
from app.models.automation import (
    AutomationDelivery,
    AutomationEvent,
    AutomationReviewTask,
    IntegrationCredential,
)
from app.models.billing import AISuggestion
from app.models.contract import Contract
from app.models.platform import AuditLog, Notification
from app.models.rights import RightsConflict
from app.models.royalty import LedgerEntry, RoyaltyRun, RoyaltyStatement
from app.models.user import User
from app.services import billing
from tests.conftest import DEFAULT_PASSWORD, run_jobs
from tests.test_royalties import CSV, catalog  # noqa: F401  (fixture)

A = "/api/v1/automation"


def _contract(**fields) -> Contract:
    return Contract(territories=["WORLD"], rights_granted=["publishing"], **fields)


def admin_url(org_id: str, path: str = "") -> str:
    return f"/api/v1/organizations/{org_id}/automation{path}"


class Bot:
    """Calls the automation API with an API key, adding a fresh Idempotency-Key
    to every mutating request unless one is given."""

    def __init__(self, client, token: str):
        self.client = client
        self.token = token

    def headers(self, idem: str | None = None, extra: dict | None = None) -> dict:
        headers = {"Authorization": f"Bearer {self.token}", "X-Correlation-ID": "test-corr-1"}
        if idem is not False:
            headers["Idempotency-Key"] = idem or f"test-{uuid.uuid4()}"
        return {**headers, **(extra or {})}

    def get(self, path, **kw):
        return self.client.get(A + path, headers=self.headers(idem=False), **kw)

    def post(self, path, json=None, idem=None, **kw):
        return self.client.post(A + path, json=json if json is not None else {}, headers=self.headers(idem), **kw)

    def upload(self, content: bytes = CSV.encode(), filename="march.csv", idem=None, **meta):
        data = {"source_name": "Distro Inc", "source_category": "distributor", "period_start": "2026-03-01",
                "period_end": "2026-03-31", "currency": "USD", **meta}
        return self.client.post(A + "/statements", data=data, files={"file": (filename, content, "text/csv")},
                                headers=self.headers(idem))


def issue(client, team, role="admin", org_key="org_id", scopes=None, name="n8n local"):
    org_id = team[org_key] if org_key == "org_id" else team["other_org"]["id"]
    body = {"name": name}
    if scopes is not None:
        body["scopes"] = scopes
    r = client.post(admin_url(org_id, "/credentials"), json=body, headers=team[role]["headers"])
    assert r.status_code == 201, r.text
    return r.json()


@pytest.fixture
def bot(client, team):
    return Bot(client, issue(client, team)["token"])


@pytest.fixture
def other_bot(client, team):
    return Bot(client, issue(client, team, role="outsider", org_key="other")["token"])


# --------------------------------------------------------------------------- credentials


def test_only_admins_manage_credentials_and_the_secret_is_shown_once(client, team, db):
    for role in ("viewer", "manager"):
        r = client.post(admin_url(team["org_id"], "/credentials"), json={"name": "x1"}, headers=team[role]["headers"])
        assert r.status_code == 403
    issued = issue(client, team)
    token = issued["token"]
    assert token.startswith("rfa_") and issued["credential"]["state"] == "active"
    listed = client.get(admin_url(team["org_id"], "/credentials"), headers=team["admin"]["headers"]).json()
    assert token not in str(listed) and "secret_hash" not in str(listed)
    stored = db.scalar(select(IntegrationCredential))
    assert token.split("_", 2)[2] not in stored.secret_hash
    assert set(stored.scopes) == {"automation:read", "runs:write", "events:consume", "statements:import",
                                  "statements:review", "contracts:read", "notifications:send",
                                  "reports:deliver", "ai:review"}
    bad = client.post(admin_url(team["org_id"], "/credentials"), json={"name": "x1", "scopes": ["payouts:approve"]},
                      headers=team["admin"]["headers"])
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "invalid_scope"


def test_service_account_cannot_sign_in_and_holds_no_seat(client, team, db, api):
    seats_before = billing.measure_usage(db, team["org_id"])["max_users"]
    issue(client, team)
    db.expire_all()
    service_user = db.scalar(select(User).where(User.is_service_account.is_(True)))
    assert service_user is not None
    r = client.post("/api/v1/auth/login", json={"email": service_user.email, "password": DEFAULT_PASSWORD})
    assert r.status_code in (401, 422)
    members = client.get(f"/api/v1/organizations/{team['org_id']}/members", headers=team["owner"]["headers"]).json()
    assert service_user.id not in {m["user_id"] for m in members}
    assert billing.measure_usage(db, team["org_id"])["max_users"] == seats_before


# --------------------------------------------------------------------------- authentication


def test_authentication_failures(client, team, bot, db):
    assert client.get(A + "/whoami").status_code == 401
    for header in ("Bearer nonsense", "Bearer rfa_0123456789abcdef_" + "x" * 43, "Basic abc",
                   f"Bearer {bot.token[:-2]}zz"):
        r = client.get(A + "/whoami", headers={"Authorization": header})
        assert r.status_code == 401, header
        assert r.json()["error"]["code"] == "invalid_automation_key"
    # A human JWT is not an automation credential, and vice versa.
    assert client.get(A + "/whoami", headers=team["owner"]["headers"]).status_code == 401
    human_route = f"/api/v1/organizations/{team['org_id']}/royalties/statements"
    assert client.get(human_route, headers={"Authorization": f"Bearer {bot.token}"}).status_code == 401
    # Failures are audited without the secret.
    db.expire_all()
    summaries = [a.summary or "" for a in db.scalars(select(AuditLog).where(AuditLog.action == "automation.auth_failed"))]
    assert summaries and not any(bot.token.split("_", 2)[2] in s for s in summaries)
    assert any("wrong secret" in s for s in summaries)


def test_revoked_and_expired_credentials_are_rejected(client, team, db):
    issued = issue(client, team)
    bot = Bot(client, issued["token"])
    assert bot.get("/whoami").status_code == 200
    cred_id = issued["credential"]["id"]
    r = client.post(admin_url(team["org_id"], f"/credentials/{cred_id}/revoke"), json={"reason": "test"},
                    headers=team["admin"]["headers"])
    assert r.status_code == 200 and r.json()["state"] == "revoked"
    assert bot.get("/whoami").status_code == 401

    second = issue(client, team, name="expiring")
    db.execute(IntegrationCredential.__table__.update()
               .where(IntegrationCredential.id == second["credential"]["id"])
               .values(expires_at=utc_now() - timedelta(minutes=1)))
    db.commit()
    assert Bot(client, second["token"]).get("/whoami").status_code == 401


def test_rotation_keeps_old_key_for_the_grace_period_only(client, team):
    issued = issue(client, team)
    old = Bot(client, issued["token"])
    r = client.post(admin_url(team["org_id"], f"/credentials/{issued['credential']['id']}/rotate"),
                    json={"grace_hours": 24}, headers=team["admin"]["headers"])
    assert r.status_code == 200, r.text
    new = Bot(client, r.json()["token"])
    assert new.get("/whoami").status_code == 200 and old.get("/whoami").status_code == 200
    again = client.post(admin_url(team["org_id"], f"/credentials/{r.json()['credential']['id']}/rotate"),
                        json={"grace_hours": 0}, headers=team["admin"]["headers"])
    newest = Bot(client, again.json()["token"])
    assert newest.get("/whoami").status_code == 200 and new.get("/whoami").status_code == 401


def test_scopes_are_enforced(client, team):
    limited = Bot(client, issue(client, team, scopes=["automation:read"])["token"])
    assert limited.get("/whoami").status_code == 200
    r = limited.upload()
    assert r.status_code == 403 and r.json()["error"]["code"] == "missing_scope"
    assert limited.post("/events/claim", json={"event_types": ["statement.uploaded"]}, idem=False).status_code == 403


def test_whoami_is_bound_to_one_organization(bot, team):
    body = bot.get("/whoami").json()
    assert body["organization_id"] == team["org_id"] and body["acts_as_role"] == "manager"


# --------------------------------------------------------------------------- tenant isolation


def test_credential_for_org_a_cannot_touch_org_b(client, team, bot, other_bot, catalog, db):
    # Org A data, created through the automation API.
    statement = bot.upload().json()
    run = bot.post("/runs", json={"workflow": "royalty-import", "trigger_type": "manual"}).json()
    contract = _contract(organization_id=team["org_id"], title="A deal", contract_type="recording",
                        status="active", end_date=date.today() + timedelta(days=5))
    db.add(contract)
    db.commit()
    event = db.scalar(select(AutomationEvent).where(AutomationEvent.organization_id == team["org_id"]))
    # Org B's key sees none of it.
    assert other_bot.get("/whoami").json()["organization_id"] == team["other_org"]["id"]
    assert other_bot.get(f"/statements/{statement['id']}").status_code == 404
    assert other_bot.post(f"/statements/{statement['id']}/process").status_code == 404
    assert other_bot.post(f"/statements/{statement['id']}/review", json={}).status_code == 404
    assert other_bot.post(f"/runs/{run['id']}/finish", json={"status": "succeeded"}).status_code == 404
    assert other_bot.post(f"/contracts/{contract.id}/reminders", json={"threshold_days": 7}).status_code == 404
    assert other_bot.get("/contracts/expiring?within_days=30").json()["count"] == 0
    assert other_bot.get(f"/jobs/{uuid.uuid4()}").status_code == 404
    if event is not None:
        assert other_bot.post(f"/events/{event.id}/ack", json={"lease_token": "x" * 32,
                                                               "outcome": "completed"}).status_code == 404
    claimed = other_bot.post("/events/claim", json={"event_types": ["statement.uploaded", "work.created"]},
                             idem=False).json()
    assert claimed["count"] == 0
    assert other_bot.post("/ai/metadata-review", json={"entity_type": "work",
                                                       "entity_id": catalog["work"].id}).status_code == 404
    # And the admin API refuses other organizations' members.
    assert client.get(admin_url(team["org_id"], "/credentials"),
                      headers=team["outsider"]["headers"]).status_code == 404


# --------------------------------------------------------------------------- financial safeguards


def test_automation_has_no_route_to_post_reverse_or_pay(client, team, bot, catalog):
    from app.main import app

    paths = [p for p in app.openapi()["paths"] if p.startswith(A)]
    for forbidden in ("post", "reverse", "payout", "approve", "mark-paid", "ledger", "shares"):
        assert not any(forbidden in p.split("/")[-1] or f"/{forbidden}" in p for p in paths), forbidden
    statement = bot.upload().json()
    bot.post(f"/statements/{statement['id']}/process")
    run_jobs()
    review = bot.post(f"/statements/{statement['id']}/review", json={"calculate": True}).json()
    run_id = review["findings"]["run_id"]
    assert run_id
    # The key can't use the human posting endpoint either.
    r = client.post(f"/api/v1/organizations/{team['org_id']}/royalties/runs/{run_id}/post",
                    headers={"Authorization": f"Bearer {bot.token}"})
    assert r.status_code == 401


# --------------------------------------------------------------------------- idempotency


def test_idempotency_key_required_replayed_and_not_reusable(client, team, bot, catalog, db):
    no_key = client.post(A + "/runs", json={"workflow": "royalty-import", "trigger_type": "manual"},
                         headers={"Authorization": f"Bearer {bot.token}"})
    assert no_key.status_code == 422 and no_key.json()["error"]["code"] == "idempotency_key_required"
    first = bot.upload(idem="upload-key-0001")
    assert first.status_code == 201, first.text
    replay = bot.upload(idem="upload-key-0001")
    assert replay.status_code == 201 and replay.headers.get("Idempotent-Replayed") == "true"
    assert replay.json()["id"] == first.json()["id"]
    db.expire_all()
    assert db.scalar(select(func.count()).select_from(RoyaltyStatement)) == 1
    reused = bot.upload(content=b"Title,ISRC,Earnings\nX,USAB12600001,1.00\n", idem="upload-key-0001")
    assert reused.status_code == 422 and reused.json()["error"]["code"] == "idempotency_key_reused"
    # A fresh key with the same file is still a duplicate statement (business-level dedupe).
    dup = bot.upload(idem="upload-key-0002")
    assert dup.status_code == 200 and dup.json()["duplicate"] is True and dup.json()["id"] == first.json()["id"]
    db.expire_all()
    assert db.scalar(select(func.count()).select_from(RoyaltyStatement)) == 1


def test_failed_request_releases_its_idempotency_key(bot):
    # A raised error (here: invalid workflow name) releases the key for a retry.
    bad = bot.post("/runs", json={"workflow": "Not Valid!", "trigger_type": "manual"}, idem="retry-key-0001")
    assert bad.status_code == 422
    retry = bot.post("/runs", json={"workflow": "royalty-import", "trigger_type": "manual"}, idem="retry-key-0001")
    assert retry.status_code == 201  # the key is usable again


def test_rejected_file_is_a_stored_outcome_not_a_released_key(bot):
    # A rejected file is a deterministic business outcome: replaying the key returns it.
    bad = bot.upload(content=b"\x00\x01binary", filename="evil.exe", idem="reject-key-0001")
    assert bad.status_code == 422 and bad.json()["inbox_file"]["state"] == "rejected"
    replay = bot.upload(content=b"\x00\x01binary", filename="evil.exe", idem="reject-key-0001")
    assert replay.status_code == 422 and replay.headers.get("Idempotent-Replayed") == "true"


# --------------------------------------------------------------------------- outbox


def test_outbox_event_is_written_with_the_upload_and_leased_once(client, team, bot, catalog, db):
    r = client.post(f"/api/v1/organizations/{team['org_id']}/royalties/statements",
                    data={"source_name": "Distro Inc", "source_category": "distributor",
                          "period_start": "2026-03-01", "period_end": "2026-03-31", "currency": "USD"},
                    files={"file": ("march.csv", CSV.encode(), "text/csv")}, headers=team["manager"]["headers"])
    assert r.status_code == 201
    first = bot.post("/events/claim", json={"event_types": ["statement.uploaded"], "lease_seconds": 60},
                     idem=False).json()
    assert first["count"] == 1 and first["events"][0]["payload"]["statement_id"] == r.json()["id"]
    # A second poller can't claim the same event while it is leased.
    assert bot.post("/events/claim", json={"event_types": ["statement.uploaded"]}, idem=False).json()["count"] == 0
    event_id = first["events"][0]["id"]
    wrong = bot.post(f"/events/{event_id}/ack", json={"lease_token": "f" * 32, "outcome": "completed"})
    assert wrong.status_code == 409 and wrong.json()["error"]["code"] == "lease_lost"
    ack_key = "ack-key-0000001"
    ok = bot.post(f"/events/{event_id}/ack", json={"lease_token": first["lease_token"], "outcome": "completed"},
                  idem=ack_key)
    assert ok.status_code == 200 and ok.json()["status"] == "completed"
    replay = bot.post(f"/events/{event_id}/ack", json={"lease_token": first["lease_token"], "outcome": "completed"},
                      idem=ack_key)
    assert replay.status_code == 200 and replay.headers.get("Idempotent-Replayed") == "true"
    # Automation's own uploads don't emit events (they drive their own processing).
    bot.upload(content=CSV.replace("Distro", "Other").encode() + b"\n", filename="b.csv")
    db.expire_all()
    assert db.scalar(select(func.count()).select_from(AutomationEvent)) == 1


def test_expired_lease_is_reclaimed_and_poison_events_go_dead(client, team, bot, db, catalog):
    from app.services.automation import events as outbox

    event = outbox.emit_event(db, organization_id=team["org_id"], event_type="work.created",
                              payload={"entity_type": "work", "entity_id": catalog["work"].id})
    event.max_attempts = 2
    db.commit()
    first = bot.post("/events/claim", json={"event_types": ["work.created"], "lease_seconds": 30}, idem=False).json()
    assert first["count"] == 1
    # Simulate n8n dying mid-processing: the lease expires.
    db.execute(AutomationEvent.__table__.update().values(lease_expires_at=utc_now() - timedelta(seconds=1)))
    db.commit()
    second = bot.post("/events/claim", json={"event_types": ["work.created"]}, idem=False).json()
    assert second["count"] == 1 and second["events"][0]["attempts"] == 2
    # Transient failure on the last attempt -> dead (dead-letter), visible to admins and requeueable.
    r = bot.post(f"/events/{event.id}/ack", json={"lease_token": second["lease_token"], "outcome": "retry",
                                                  "error": "API timeout Bearer rfa_0123456789abcdef_secretsecret"})
    assert r.json()["status"] == "dead" and "secretsecret" not in (r.json()["last_error"] or "")
    dead = client.get(admin_url(team["org_id"], "/events?status=dead"), headers=team["admin"]["headers"]).json()
    assert [e["id"] for e in dead] == [event.id]
    assert client.post(admin_url(team["org_id"], f"/events/{event.id}/requeue"),
                       headers=team["manager"]["headers"]).status_code == 403
    requeued = client.post(admin_url(team["org_id"], f"/events/{event.id}/requeue"), headers=team["admin"]["headers"])
    assert requeued.json()["status"] == "pending" and requeued.json()["attempts"] == 0


def test_retry_backs_off_exponentially(db, team, bot, catalog):
    from app.services.automation import events as outbox

    assert [outbox.backoff_seconds(n) for n in (1, 2, 3, 10)] == [30, 60, 120, 3600]
    event = outbox.emit_event(db, organization_id=team["org_id"], event_type="work.created",
                              payload={"entity_type": "work", "entity_id": catalog["work"].id})
    db.commit()
    claim = bot.post("/events/claim", json={"event_types": ["work.created"]}, idem=False).json()
    r = bot.post(f"/events/{event.id}/ack", json={"lease_token": claim["lease_token"], "outcome": "retry"}).json()
    assert r["status"] == "pending"
    db.expire_all()
    stored = db.get(AutomationEvent, event.id)
    assert stored.available_at > utc_now() + timedelta(seconds=20)
    assert bot.post("/events/claim", json={"event_types": ["work.created"]}, idem=False).json()["count"] == 0


# --------------------------------------------------------------------------- runs


def test_runs_track_executions_and_dedupe_by_business_key(bot, db, team):
    start = {"workflow": "monthly-reporting", "trigger_type": "schedule", "execution_id": "n8n-41",
             "idempotency_key": "monthly:2026-09"}
    first = bot.post("/runs", json=start)
    assert first.status_code == 201 and first.json()["status"] == "running"
    run_id = first.json()["id"]
    failed = bot.post(f"/runs/{run_id}/finish", json={"status": "failed", "error_code": "timeout",
                                                      "error_message": "boom Bearer abc.def.ghi-123"})
    assert failed.json()["status"] == "failed" and "abc.def" not in failed.json()["error_message"]
    retry = bot.post("/runs", json={**start, "execution_id": "n8n-42"})
    assert retry.status_code == 200 and retry.json()["retry_count"] == 1 and retry.json()["status"] == "running"
    bot.post(f"/runs/{run_id}/finish", json={"status": "succeeded", "summary": {"rows": 3}})
    done = bot.post("/runs", json=start).json()
    assert done["replayed"] is True and done["status"] == "succeeded"
    too_big = bot.post("/runs", json={"workflow": "x-big", "trigger_type": "manual"}).json()
    r = bot.post(f"/runs/{too_big['id']}/finish", json={"status": "succeeded", "summary": {"blob": "x" * 5000}})
    assert r.status_code == 422


# --------------------------------------------------------------------------- Workflow A: statements


def test_statement_workflow_imports_processes_and_raises_one_review(client, team, bot, catalog, db):
    up = bot.upload()
    assert up.status_code == 201 and up.json()["status"] == "uploaded" and up.json()["has_amount_mapping"]
    sid = up.json()["id"]
    early = bot.post(f"/statements/{sid}/review", json={})
    assert early.status_code == 409 and early.json()["error"]["code"] == "statement_not_processed"
    started = bot.post(f"/statements/{sid}/process").json()
    assert started["status"] == "queued" and started["already_started"] is False
    assert bot.post(f"/statements/{sid}/process").json()["already_started"] is True  # retried call
    run_jobs()
    assert bot.get(f"/statements/{sid}").json()["status"] == "processed"
    review = bot.post(f"/statements/{sid}/review", json={"calculate": True}).json()
    assert review["needs_review"] is True
    lines = review["findings"]["lines"]
    assert lines["unmatched"] >= 1 and lines["invalid"] == 1
    assert review["task_change"] == "created" and review["notification"]["status"] == "sent"
    # Nothing was posted and the ledger is untouched.
    db.expire_all()
    assert db.scalar(select(RoyaltyRun.status).where(RoyaltyRun.id == review["findings"]["run_id"])) == "calculated"
    assert db.scalar(select(func.count()).select_from(LedgerEntry)) == 0
    notes = db.scalars(select(Notification).where(Notification.type == "automation_review")).all()
    assert {n.user_id for n in notes} == {team[r]["id"] for r in ("owner", "admin", "manager")}
    # Re-running the review changes nothing and notifies no one again.
    again = bot.post(f"/statements/{sid}/review", json={"calculate": True}).json()
    assert again["task_change"] == "unchanged" and again["notification"] is None
    db.expire_all()
    assert db.scalar(select(func.count()).select_from(Notification).where(
        Notification.type == "automation_review")) == len(notes)
    assert db.scalar(select(func.count()).select_from(AutomationReviewTask)) == 1
    tasks = client.get(admin_url(team["org_id"], "/review-tasks"), headers=team["viewer"]["headers"]).json()
    assert tasks[0]["kind"] == "statement_review" and tasks[0]["link"] == f"/royalties/statements/{sid}"


def test_missing_contract_terms_are_held_for_review_not_paid(client, team, bot, catalog, db):
    contract = db.get(Contract, catalog["contract"].id)
    contract.status = "draft"  # the artist's contract no longer applies
    db.commit()
    sid = bot.upload().json()["id"]
    bot.post(f"/statements/{sid}/process")
    run_jobs()
    review = bot.post(f"/statements/{sid}/review", json={"calculate": True}).json()
    held = {h["reason"] for h in review["findings"]["held"]}
    assert "no_applicable_contract_term" in held
    db.expire_all()
    run = db.get(RoyaltyRun, review["findings"]["run_id"])
    assert run.status == "calculated" and run.total_unallocated > 0


def test_malformed_and_unmappable_statements(bot):
    assert bot.upload(content=b"\x00\x01\x02", filename="x.pdf").status_code == 422
    assert bot.upload(source_category="nonsense").status_code == 422
    unmappable = bot.upload(content=b"Foo,Bar\n1,2\n", filename="odd.csv")
    assert unmappable.status_code == 201, unmappable.text  # parses, but no amount column
    if unmappable.status_code == 201:
        sid = unmappable.json()["id"]
        r = bot.post(f"/statements/{sid}/process")
        assert r.status_code == 202 and r.json()["automation"]["outcome"] == "mapping_required"
        assert r.json()["status"] == "uploaded"  # never processed without a usable mapping
        review = bot.post(f"/statements/{sid}/review", json={}).json()
        assert review["findings"]["mapping_required"] is True and review["task_change"] == "created"
        assert bot.post(f"/statements/{sid}/review", json={}).json()["task_change"] == "unchanged"
    else:
        assert unmappable.status_code == 422


# --------------------------------------------------------------------------- Workflow B: contracts


def test_contract_reminders_are_due_checked_and_sent_once(team, bot, db):
    today = date.today()
    soon = _contract(organization_id=team["org_id"], title="Soon", contract_type="publishing", status="active",
                    end_date=today + timedelta(days=6))
    gone = _contract(organization_id=team["org_id"], title="Gone", contract_type="publishing", status="active",
                    end_date=today - timedelta(days=2))
    later = _contract(organization_id=team["org_id"], title="Later", contract_type="publishing", status="active",
                     end_date=today + timedelta(days=200))
    db.add_all([soon, gone, later])
    db.commit()
    listed = bot.get("/contracts/expiring?within_days=30").json()
    assert {i["contract_id"] for i in listed["items"]} == {soon.id, gone.id}
    first = bot.post(f"/contracts/{soon.id}/reminders", json={"threshold_days": 7}).json()
    assert first["status"] == "sent" and first["duplicate"] is False and first["recipient_count"] == 3
    dup = bot.post(f"/contracts/{soon.id}/reminders", json={"threshold_days": 7}).json()
    assert dup["duplicate"] is True
    not_due = bot.post(f"/contracts/{later.id}/reminders", json={"threshold_days": 7})
    assert not_due.status_code == 422 and not_due.json()["error"]["code"] == "reminder_not_due"
    assert bot.post(f"/contracts/{soon.id}/reminders", json={"threshold_days": 0}).status_code == 422
    expired = bot.post(f"/contracts/{gone.id}/reminders", json={"threshold_days": 0}).json()
    assert expired["status"] == "sent"
    db.expire_all()
    assert db.scalar(select(func.count()).select_from(Notification).where(
        Notification.type == "contract_expiration")) == 6  # 2 reminders x 3 managers+


def test_reminder_without_recipients_is_recorded_as_skipped(client, api, bot, db, team):
    # A fresh organization whose only member is its owner, who then leaves the manager set:
    # simulate by deactivating every membership except none -> no recipients.
    from app.models.organization_membership import OrganizationMembership

    contract = _contract(organization_id=team["org_id"], title="Orphan", contract_type="publishing",
                        status="active", end_date=date.today() + timedelta(days=3))
    db.add(contract)
    db.execute(OrganizationMembership.__table__.update()
               .where(OrganizationMembership.organization_id == team["org_id"],
                      OrganizationMembership.role != "viewer")
               .values(is_active=False))
    db.commit()
    r = bot.post(f"/contracts/{contract.id}/reminders", json={"threshold_days": 7}).json()
    assert r["status"] == "skipped" and r["detail"]["reason"] == "no_recipients"


# --------------------------------------------------------------------------- Workflow D: monthly report


def test_monthly_report_is_generated_once_and_sent_to_admins_only(client, team, bot, catalog, db):
    period = (date.today().replace(day=1) - timedelta(days=1)).strftime("%Y-%m")
    current = date.today().strftime("%Y-%m")
    assert bot.post("/reports/monthly", json={"period": current}).json()["error"]["code"] == "period_not_complete"
    queued = bot.post("/reports/monthly", json={"period": period}).json()
    assert queued["status"] == "pending" and queued["job_id"] and queued["duplicate"] is False
    dup = bot.post("/reports/monthly", json={"period": period}).json()
    assert dup["duplicate"] is True and dup["id"] == queued["id"]
    early = bot.post(f"/reports/deliveries/{queued['id']}/send", json={})
    assert early.status_code == 409 and early.json()["error"]["code"] == "report_not_ready"
    run_jobs()
    assert bot.get(f"/jobs/{queued['job_id']}").json()["status"] == "succeeded"
    unauthorized = bot.post(f"/reports/deliveries/{queued['id']}/send",
                            json={"recipient_user_id": team["manager"]["id"]})
    assert unauthorized.status_code == 403 and unauthorized.json()["error"]["code"] == "recipient_not_authorized"
    outsider = bot.post(f"/reports/deliveries/{queued['id']}/send", json={"recipient_user_id": team["outsider"]["id"]})
    assert outsider.status_code == 403
    sent = bot.post(f"/reports/deliveries/{queued['id']}/send", json={}).json()
    assert sent["status"] == "sent" and sent["recipient_count"] == 2  # owner + admin
    assert bot.post(f"/reports/deliveries/{queued['id']}/send", json={}).json()["duplicate"] is True
    db.expire_all()
    notes = db.scalars(select(Notification).where(Notification.type == "monthly_report")).all()
    assert {n.user_id for n in notes} == {team["owner"]["id"], team["admin"]["id"]}
    assert all("Royalties" in (n.body or "") for n in notes)


# --------------------------------------------------------------------------- Workflow C: AI review


def test_ai_review_without_provider_degrades_to_deterministic_issues(team, bot, catalog, db):
    r = bot.post("/ai/metadata-review", json={"entity_type": "work", "entity_id": catalog["work"].id})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["outcome"] == "ai_unavailable" and body["suggestion_ids"] == []
    db.expire_all()
    assert db.scalar(select(func.count()).select_from(AISuggestion)) == 0


def test_ai_suggestions_are_pending_until_a_human_decides(client, team, bot, catalog, db, fake_ai):
    fake_ai.responses["MetadataCleanupProposal"] = {
        "summary": "Title has stray whitespace",
        "changes": [{"field": "genre", "proposed_value": "Synthwave", "proposed_values": [],
                     "reason": "Genre is missing; the record describes a synthwave track."}],
    }
    work = catalog["work"]
    r = bot.post("/ai/metadata-review", json={"entity_type": "work", "entity_id": work.id}).json()
    assert r["outcome"] == "suggested" and r["proposed_fields"] == ["genre"]
    db.expire_all()
    suggestion = db.get(AISuggestion, r["suggestion_ids"][0])
    assert suggestion.status == "pending"
    assert db.get(type(work), work.id).genre is None  # nothing applied by the AI
    waiting = bot.post("/ai/sync-decisions").json()
    assert waiting["still_waiting"] == 1 and waiting["resolved"] == []
    approve = client.post(f"/api/v1/organizations/{team['org_id']}/ai/suggestions/{suggestion.id}/approve",
                          headers=team["manager"]["headers"])
    assert approve.status_code == 200, approve.text
    synced = bot.post("/ai/sync-decisions").json()
    assert len(synced["resolved"]) == 1
    db.expire_all()
    task = db.get(AutomationReviewTask, r["review_task_id"])
    assert task.status == "resolved" and task.resolved_by_id == team["manager"]["id"]
    assert db.get(type(work), work.id).genre == "Synthwave"


def test_malformed_ai_output_is_rejected(team, bot, catalog, db, fake_ai):
    fake_ai.responses["MetadataCleanupProposal"] = {"summary": "x", "changes": [{"field": "royalty_rate",
                                                                                 "proposed_value": "100"}]}
    r = bot.post("/ai/metadata-review", json={"entity_type": "work", "entity_id": catalog["work"].id}).json()
    assert r["outcome"] in ("ai_error", "no_changes") and r["suggestion_ids"] == []
    db.expire_all()
    assert db.scalar(select(func.count()).select_from(AISuggestion)) == 0


def test_conflict_review_is_advisory(team, bot, db, fake_ai):
    from app.models.catalog import Work

    work = Work(organization_id=team["org_id"], title="Contested")
    db.add(work)
    db.flush()
    conflict = RightsConflict(organization_id=team["org_id"], conflict_type="over_allocation", severity="high",
                              status="open", work_id=work.id, rights_type="performance", title="Over 100%",
                              explanation="Shares add up to 120%", details={}, fingerprint="fp-1",
                              last_detected_at=utc_now())
    db.add(conflict)
    db.commit()
    fake_ai.responses["ConflictExplanation"] = {"summary": "Two writers both claim 60%.",
                                                "likely_causes": ["Duplicate split sheet"],
                                                "suggested_next_steps": ["Check the split sheet"],
                                                "parties_involved": []}
    r = bot.post("/ai/conflict-review", json={"conflict_id": conflict.id}).json()
    assert r["outcome"] == "explained" and r["review_task_id"]
    db.expire_all()
    assert db.get(RightsConflict, conflict.id).status == "open"
    task = db.get(AutomationReviewTask, r["review_task_id"])
    assert task.details["ai_generated"] is True and "Two writers" in task.details["ai_summary"]


def test_review_request_emits_an_event(client, team, bot, catalog):
    url = admin_url(team["org_id"], "/review-requests")
    body = {"subject_type": "work", "subject_id": catalog["work"].id}
    assert client.post(url, json=body, headers=team["viewer"]["headers"]).status_code == 403
    assert client.post(url, json={**body, "subject_id": str(uuid.uuid4())},
                       headers=team["manager"]["headers"]).status_code == 404
    r = client.post(url, json=body, headers=team["manager"]["headers"])
    assert r.status_code == 202 and r.json()["event_id"]
    claimed = bot.post("/events/claim", json={"event_types": ["review.requested"]}, idem=False).json()
    assert claimed["events"][0]["payload"]["subject_id"] == catalog["work"].id


# --------------------------------------------------------------------------- health / alerts


def test_health_and_alerts(client, team, bot, db):
    health = bot.get("/health").json()
    assert health["database"]["ok"] is True and health["credential"]["state"] == "active"
    assert health["status"] == "healthy" and health["issues"] == []
    run = bot.post("/runs", json={"workflow": "royalty-import", "trigger_type": "manual",
                                  "execution_id": "77"}).json()
    alert = bot.post("/alerts", json={"workflow": "royalty-import", "execution_id": "77", "run_id": run["id"],
                                      "error_code": "api_unavailable", "error_message": "ECONNREFUSED"}).json()
    assert alert["action"] == "alerted" and alert["recipient_count"] == 2  # admins and owner
    assert alert["category"] == "connection"
    again = bot.post("/alerts", json={"workflow": "royalty-import", "execution_id": "78",
                                      "error_message": "ECONNREFUSED"}).json()
    assert again["duplicate"] is True and again["action"] == "suppressed"
    after = bot.get("/health").json()
    assert after["runs"]["failed_last_24h"] == 1 and "recent_failed_runs" in after["problems"]
    assert after["status"] == "warning" and "open_incidents" in after["problems"]
    runs = client.get(admin_url(team["org_id"], "/runs?status=failed"), headers=team["admin"]["headers"]).json()
    assert runs[0]["error_code"] == "api_unavailable"
    db.expire_all()
    from app.models.automation import AutomationIncident

    incident = db.scalar(select(AutomationIncident))
    assert incident.occurrences == 2 and incident.alerts_sent == 1 and incident.suppressed == 1


def test_human_review_queue(client, team, bot, catalog, db):
    sid = bot.upload().json()["id"]
    bot.post(f"/statements/{sid}/process")
    run_jobs()
    task_id = bot.post(f"/statements/{sid}/review", json={}).json()["review_task_id"]
    url = admin_url(team["org_id"], f"/review-tasks/{task_id}/resolve")
    assert client.post(url, json={"note": "x"}, headers=team["viewer"]["headers"]).status_code == 403
    done = client.post(url, json={"note": "Matched the mystery song"}, headers=team["manager"]["headers"])
    assert done.status_code == 200 and done.json()["status"] == "resolved"
    assert client.post(url, json={}, headers=team["manager"]["headers"]).status_code == 409


def test_review_acknowledges_its_event_and_refuses_a_lost_lease(client, team, bot, catalog, db):
    r = client.post(f"/api/v1/organizations/{team['org_id']}/royalties/statements",
                    data={"source_name": "Distro Inc", "source_category": "distributor",
                          "period_start": "2026-03-01", "period_end": "2026-03-31", "currency": "USD"},
                    files={"file": ("march.csv", CSV.encode(), "text/csv")}, headers=team["manager"]["headers"])
    sid = r.json()["id"]
    claim = bot.post("/events/claim", json={"event_types": ["statement.uploaded"]}, idem=False).json()
    event = claim["events"][0]
    # The uploader confirms the suggested mapping first (automation never processes before that).
    uploaded = r.json()
    confirmed = client.put(f"/api/v1/organizations/{team['org_id']}/royalties/statements/{sid}/mapping",
                           json={"adapter": uploaded["adapter"], "column_mapping": uploaded["column_mapping"]},
                           headers=team["manager"]["headers"])
    assert confirmed.status_code == 200, confirmed.text
    bot.post(f"/statements/{sid}/process")
    run_jobs()
    status = bot.get(f"/statements/{sid}?wait_seconds=2").json()
    assert status["status"] == "processed"
    stolen = bot.post(f"/statements/{sid}/review", json={"event_id": event["id"], "lease_token": "0" * 32})
    assert stolen.status_code == 409 and stolen.json()["error"]["code"] == "lease_lost"
    done = bot.post(f"/statements/{sid}/review",
                    json={"event_id": event["id"], "lease_token": claim["lease_token"]}).json()
    assert done["event_status"] == "completed" and done["needs_review"] is True
    db.expire_all()
    assert db.get(AutomationEvent, event["id"]).status == "completed"


def test_unified_ai_review_and_bounded_long_poll(team, bot, catalog, db):
    from app.services.automation import events as outbox

    outbox.emit_event(db, organization_id=team["org_id"], event_type="work.created",
                      payload={"entity_type": "work", "entity_id": catalog["work"].id})
    db.commit()
    claim = bot.post("/events/claim", json={"event_types": ["work.created"]}, idem=False).json()
    event = claim["events"][0]
    r = bot.post("/ai/review", json={"subject_type": "work", "subject_id": catalog["work"].id,
                                     "event_id": event["id"], "lease_token": claim["lease_token"]}).json()
    assert r["outcome"] == "ai_unavailable" and r["event_status"] == "completed"
    import time

    started = time.monotonic()
    missing = bot.get(f"/jobs/{uuid.uuid4()}?wait_seconds=5")
    assert missing.status_code == 404 and time.monotonic() - started < 3
    assert bot.get("/jobs/x?wait_seconds=61").status_code == 422


def test_party_review_task_links_to_the_parties_route(team, bot, db):
    from app.models.catalog import Party

    party = Party(organization_id=team["org_id"], name="Linky")
    db.add(party)
    db.commit()
    r = bot.post("/ai/review", json={"subject_type": "party", "subject_id": party.id}).json()
    if r["review_task_id"]:
        db.expire_all()
        assert db.get(AutomationReviewTask, r["review_task_id"]).link == f"/catalog/parties/{party.id}"
    from app.services.automation.operations import _entity_link

    assert _entity_link("party", "x") == "/catalog/parties/x"
    assert _entity_link("work", "x") == "/catalog/works/x"


def test_concurrent_reviews_of_the_same_subject_do_not_conflict(team, bot, catalog):
    """n8n sends a node's items in parallel: two events about one work (work.created +
    review.requested) are reviewed at the same moment. Neither call may fail."""
    from concurrent.futures import ThreadPoolExecutor

    work_id = catalog["work"].id

    def review(i: int):
        return bot.post("/ai/review", json={"subject_type": "work", "subject_id": work_id}, idem=f"concurrent-{i:04d}")

    with ThreadPoolExecutor(max_workers=4) as pool:
        responses = list(pool.map(review, range(4)))
    assert [r.status_code for r in responses] == [200, 200, 200, 200], [r.text for r in responses]
    task_ids = {r.json()["review_task_id"] for r in responses}
    assert len(task_ids) == 1


def test_concurrent_duplicate_reminders_and_reports_send_once(team, bot, db):
    from concurrent.futures import ThreadPoolExecutor

    contract = _contract(organization_id=team["org_id"], title="Racy", contract_type="publishing", status="active",
                         end_date=date.today() + timedelta(days=3))
    db.add(contract)
    db.commit()
    period = (date.today().replace(day=1) - timedelta(days=1)).strftime("%Y-%m")
    with ThreadPoolExecutor(max_workers=6) as pool:
        reminders = list(pool.map(lambda i: bot.post(f"/contracts/{contract.id}/reminders",
                                                     json={"threshold_days": 7}, idem=f"race-rem-{i:04d}"), range(3)))
        reports = list(pool.map(lambda i: bot.post("/reports/monthly", json={"period": period},
                                                   idem=f"race-rep-{i:04d}"), range(3)))
    assert all(r.status_code == 200 for r in reminders), [r.text for r in reminders]
    assert sorted(r.json()["duplicate"] for r in reminders) == [False, True, True]
    assert all(r.status_code == 202 for r in reports), [r.text for r in reports]
    assert sorted(r.json()["duplicate"] for r in reports) == [False, True, True]
    db.expire_all()
    assert db.scalar(select(func.count()).select_from(Notification).where(
        Notification.type == "contract_expiration")) == 3  # one reminder x owner, admin, manager
