"""Email delivery job, notification email preferences, invitation resend,
deleted-file purge and periodic scheduling."""

import re
from datetime import timedelta

import pytest
from sqlalchemy import select

from app.core.config import settings
from app.db.mixins import utc_now
from app.db.session import SessionLocal
from app.models.platform import BackgroundJob, EmailMessage, StoredFile
from app.services import email as email_service
from app.services import storage
from app.services.email import EmailDeliveryResult
from app.services.notifications import notify_user
from tests.conftest import run_jobs


class FakeSmtp:
    name = "smtp"

    def __init__(self, fail_times: int = 0) -> None:
        self.fail_times = fail_times
        self.sent: list = []

    def send(self, message):
        if self.fail_times > 0:
            self.fail_times -= 1
            return EmailDeliveryResult("failed", "550 mailbox unavailable")
        self.sent.append(message)
        return EmailDeliveryResult("sent")


@pytest.fixture
def smtp(monkeypatch):
    fake = FakeSmtp()
    monkeypatch.setattr(email_service, "get_email_provider", lambda: fake)
    return fake


def _drain_with_retries(rounds: int = 6) -> None:
    """Run jobs repeatedly, fast-forwarding retry backoff."""
    for _ in range(rounds):
        with SessionLocal() as db:
            for job in db.scalars(select(BackgroundJob).where(BackgroundJob.status == "queued")):
                job.run_after = utc_now() - timedelta(seconds=1)
            db.commit()
        run_jobs()


def test_smtp_email_is_delivered_by_background_job(api, client, db, smtp):
    api.register("queued@example.com")
    message = db.scalar(select(EmailMessage).where(EmailMessage.to_email == "queued@example.com"))
    assert message.status == "queued" and smtp.sent == []
    run_jobs()
    db.rollback()
    db.refresh(message)
    assert message.status == "sent" and message.sent_at is not None
    assert len(smtp.sent) == 1 and smtp.sent[0]["To"] == "queued@example.com"


def test_failed_smtp_delivery_is_retried_then_marked_failed(api, db, monkeypatch):
    flaky = FakeSmtp(fail_times=1)
    monkeypatch.setattr(email_service, "get_email_provider", lambda: flaky)
    api.register("retry@example.com")
    _drain_with_retries()
    message = db.scalar(select(EmailMessage).where(EmailMessage.to_email == "retry@example.com"))
    assert message.status == "sent" and len(flaky.sent) == 1

    broken = FakeSmtp(fail_times=99)
    monkeypatch.setattr(email_service, "get_email_provider", lambda: broken)
    api.register("bounce@example.com")
    _drain_with_retries(rounds=8)
    db.rollback()
    bounced = db.scalar(select(EmailMessage).where(EmailMessage.to_email == "bounce@example.com"))
    assert bounced.status == "failed" and "550" in bounced.error
    job = db.scalar(select(BackgroundJob).where(BackgroundJob.job_type == "email_delivery",
                                                BackgroundJob.status == "failed"))
    assert job is not None and job.attempts == job.max_attempts and job.organization_id is None


def test_notification_email_preferences(api, client, db):
    user = api.user("prefs@example.com")
    prefs = client.get("/api/v1/auth/me/notification-preferences", headers=user["headers"]).json()
    by_type = {t["type"]: t["email"] for t in prefs["types"]}
    assert prefs["email_enabled"] is True
    assert by_type["payout_approval_request"] is True and by_type["import_completed"] is False
    assert "invitation" not in by_type  # invitations already send their own email

    notify_user(db, user_id=user["id"], type="payout_approval_request", title="Batch PB-1 needs approval",
                link="/payouts/x")
    notify_user(db, user_id=user["id"], type="import_completed", title="Imported")
    db.commit()
    templates = db.scalars(select(EmailMessage.template).where(EmailMessage.to_email == "prefs@example.com")).all()
    assert "notification:payout_approval_request" in templates
    assert "notification:import_completed" not in templates

    bad = client.put("/api/v1/auth/me/notification-preferences",
                     json={"email_enabled": True, "email_types": {"nonsense": True}}, headers=user["headers"])
    assert bad.status_code == 422
    off = client.put("/api/v1/auth/me/notification-preferences",
                     json={"email_enabled": False, "email_types": {"import_completed": True}},
                     headers=user["headers"])
    assert off.status_code == 200 and off.json()["email_enabled"] is False
    db.rollback()  # end the snapshot taken before the PUT
    notify_user(db, user_id=user["id"], type="payout_approval_request", title="Second batch")
    db.commit()
    count = db.scalars(select(EmailMessage).where(
        EmailMessage.to_email == "prefs@example.com",
        EmailMessage.template == "notification:payout_approval_request")).all()
    assert len(count) == 1  # master switch off: no new email


def test_invitation_resend_rotates_link(client, team):
    org = f"/api/v1/organizations/{team['org_id']}"
    invite = client.post(f"{org}/invitations", json={"email": "late@example.com", "role": "viewer"},
                         headers=team["admin"]["headers"]).json()
    old_token = re.search(r"token=([\w\-]+)", invite["invite_url"]).group(1)
    assert client.post(f"{org}/invitations/{invite['id']}/resend", headers=team["manager"]["headers"]).status_code == 403
    assert client.post(f"{org}/invitations/{invite['id']}/resend", headers=team["outsider"]["headers"]).status_code == 404
    resent = client.post(f"{org}/invitations/{invite['id']}/resend", headers=team["admin"]["headers"])
    assert resent.status_code == 200
    new_token = re.search(r"token=([\w\-]+)", resent.json()["invite_url"]).group(1)
    assert new_token != old_token
    assert client.post("/api/v1/invitations/preview", json={"token": old_token}).status_code == 404
    assert client.post("/api/v1/invitations/preview", json={"token": new_token}).json()["status"] == "pending"
    client.post(f"{org}/invitations/{invite['id']}/revoke", headers=team["admin"]["headers"])
    assert client.post(f"{org}/invitations/{invite['id']}/resend", headers=team["admin"]["headers"]).status_code == 409


def test_deleted_files_are_purged_after_retention(team, db):
    upload = storage.validate_bytes("a.csv", b"isrc,amount\nX,1\n", "statement")
    old = storage.store_file(db, organization_id=team["org_id"], category="statement", upload=upload,
                             created_by_id=None)
    fresh = storage.store_file(db, organization_id=team["org_id"], category="statement",
                               upload=storage.validate_bytes("b.csv", b"isrc,amount\nY,2\n", "statement"),
                               created_by_id=None)
    old.is_deleted = True
    fresh.is_deleted = True
    db.commit()
    assert old.deleted_at is not None  # stamped automatically by the model event
    old.deleted_at = utc_now() - timedelta(days=settings.file_purge_after_days + 1)
    db.commit()

    result = storage.purge_deleted_files(db)
    assert result == {"purged": 1, "failed": 0}
    db.refresh(old)
    db.refresh(fresh)
    assert old.purged_at is not None and fresh.purged_at is None
    with pytest.raises(Exception):
        storage.get_storage().open(old.storage_key)
    assert storage.get_storage().open(fresh.storage_key)


def test_periodic_scheduler_queues_purge_once_per_day(team, db):
    from app.services.scheduled import schedule_periodic_jobs

    first = schedule_periodic_jobs(db)
    second = schedule_periodic_jobs(db)
    assert first >= 3 and second == 0  # two orgs' expiry checks + one platform purge
    purge = db.scalars(select(BackgroundJob).where(BackgroundJob.job_type == "storage_purge")).all()
    assert len(purge) == 1 and purge[0].organization_id is None
    run_jobs()
    db.rollback()
    assert db.get(BackgroundJob, purge[0].id).status == "succeeded"


def test_platform_jobs_are_not_visible_to_tenants(client, team, db):
    from app.services.jobs import enqueue

    enqueue(db, organization_id=None, job_type="storage_purge", payload={})
    listed = client.get(f"/api/v1/organizations/{team['org_id']}/jobs", headers=team["owner"]["headers"]).json()
    assert all(j["job_type"] != "storage_purge" for j in listed["items"])


def test_monitoring_is_noop_without_dsn():
    from app.core import monitoring

    assert monitoring.init_monitoring() is False
    monitoring.capture_exception(RuntimeError("ignored"))  # must not raise
