from datetime import timedelta

from sqlalchemy import select

from app.db.mixins import utc_now
from app.models.platform import AuditLog, BackgroundJob


def url(org_id: str, path: str = "") -> str:
    return f"/api/v1/organizations/{org_id}/jobs{path}"


def _job(db, org_id, *, job_type="statement_import", status="queued", minutes_ago=0, **extra):
    job = BackgroundJob(organization_id=org_id, job_type=job_type, status=status,
                        payload={"statement_id": "s1"},
                        created_at=utc_now() - timedelta(minutes=minutes_ago), **extra)
    db.add(job)
    db.commit()
    return job


def test_list_jobs_is_tenant_scoped_filtered_and_newest_first(client, team, db):
    org_id = team["org_id"]
    oldest = _job(db, org_id, status="succeeded", minutes_ago=30, progress=100,
                  result={"rows": 12})
    failed = _job(db, org_id, job_type="catalog_export", status="failed", minutes_ago=20,
                  error="Disk full", attempts=3)
    newest = _job(db, org_id, minutes_ago=1)
    foreign = _job(db, team["other_org"]["id"])

    data = client.get(url(org_id), headers=team["viewer"]["headers"]).json()
    assert [j["id"] for j in data["items"]] == [newest.id, failed.id, oldest.id]
    assert data["total"] == 3

    by_type = client.get(url(org_id), params={"job_type": "catalog_export"},
                         headers=team["viewer"]["headers"]).json()
    assert [j["id"] for j in by_type["items"]] == [failed.id]
    by_status = client.get(url(org_id), params={"status": "succeeded"},
                           headers=team["viewer"]["headers"]).json()
    assert [j["id"] for j in by_status["items"]] == [oldest.id]
    assert client.get(url(org_id), params={"status": "exploded"},
                      headers=team["viewer"]["headers"]).status_code == 422

    detail = client.get(url(org_id, f"/{failed.id}"), headers=team["viewer"]["headers"]).json()
    assert detail["status"] == "failed" and detail["error"] == "Disk full"
    assert detail["attempts"] == 3 and detail["progress"] == 0
    done = client.get(url(org_id, f"/{oldest.id}"), headers=team["viewer"]["headers"]).json()
    assert done["result"] == {"rows": 12} and done["progress"] == 100

    # Another organization's job is invisible, and outsiders can't see ours.
    assert client.get(url(org_id, f"/{foreign.id}"), headers=team["owner"]["headers"]).status_code == 404
    assert client.get(url(org_id), headers=team["outsider"]["headers"]).status_code == 404
    assert client.get(url(org_id, f"/{newest.id}"),
                      headers=team["outsider"]["headers"]).status_code == 404
    outsider_jobs = client.get(url(team["other_org"]["id"]),
                               headers=team["outsider"]["headers"]).json()
    assert [j["id"] for j in outsider_jobs["items"]] == [foreign.id]


def test_cancel_only_queued_jobs(client, team, db):
    org_id = team["org_id"]
    queued = _job(db, org_id)
    running = _job(db, org_id, status="running")

    assert client.post(url(org_id, f"/{queued.id}/cancel"),
                       headers=team["viewer"]["headers"]).status_code == 403
    response = client.post(url(org_id, f"/{queued.id}/cancel"), headers=team["manager"]["headers"])
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "cancelled"
    assert response.json()["finished_at"] is not None

    again = client.post(url(org_id, f"/{queued.id}/cancel"), headers=team["manager"]["headers"])
    assert again.status_code == 409 and again.json()["error"]["code"] == "job_not_cancellable"
    busy = client.post(url(org_id, f"/{running.id}/cancel"), headers=team["manager"]["headers"])
    assert busy.status_code == 409
    assert db.scalar(select(AuditLog).where(AuditLog.action == "job.cancelled")) is not None


def test_retry_only_failed_or_cancelled_jobs(client, team, db):
    org_id = team["org_id"]
    failed = _job(db, org_id, status="failed", attempts=3, error="boom", progress=40,
                  finished_at=utc_now())
    cancelled = _job(db, org_id, status="cancelled")
    succeeded = _job(db, org_id, status="succeeded")
    queued = _job(db, org_id)

    assert client.post(url(org_id, f"/{failed.id}/retry"),
                       headers=team["viewer"]["headers"]).status_code == 403
    retried = client.post(url(org_id, f"/{failed.id}/retry"), headers=team["manager"]["headers"])
    assert retried.status_code == 200, retried.text
    body = retried.json()
    assert body["status"] == "queued" and body["attempts"] == 0
    assert body["error"] is None and body["progress"] == 0 and body["finished_at"] is None

    assert client.post(url(org_id, f"/{cancelled.id}/retry"),
                       headers=team["admin"]["headers"]).json()["status"] == "queued"
    for job in (succeeded, queued):
        response = client.post(url(org_id, f"/{job.id}/retry"), headers=team["manager"]["headers"])
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "job_not_retryable"


def test_outsider_cannot_cancel_or_retry(client, team, db):
    org_id = team["org_id"]
    queued = _job(db, org_id)
    failed = _job(db, org_id, status="failed")
    outsider = team["outsider"]["headers"]
    assert client.post(url(org_id, f"/{queued.id}/cancel"), headers=outsider).status_code == 404
    assert client.post(url(org_id, f"/{failed.id}/retry"), headers=outsider).status_code == 404
    # Using their own org id with our job ids doesn't work either.
    other = team["other_org"]["id"]
    assert client.post(url(other, f"/{queued.id}/cancel"), headers=outsider).status_code == 404
    assert client.post(url(other, f"/{failed.id}/retry"), headers=outsider).status_code == 404
    db.expire_all()
    assert db.get(BackgroundJob, queued.id).status == "queued"
    assert db.get(BackgroundJob, failed.id).status == "failed"
