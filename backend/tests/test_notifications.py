from datetime import timedelta

from sqlalchemy import select

from app.db.mixins import utc_now
from app.models.platform import EmailMessage, Notification
from app.services.email import send_email

BASE = "/api/v1/notifications"


def _notify(db, user_id, title, *, org_id=None, minutes_ago=0, is_read=False):
    n = Notification(user_id=user_id, organization_id=org_id, type="test", title=title,
                     severity="info", is_read=is_read,
                     created_at=utc_now() - timedelta(minutes=minutes_ago))
    db.add(n)
    db.commit()
    return n


def test_list_newest_first_with_unread_count_and_filters(client, api, db):
    alice = api.user("alice@example.com")
    org = api.org(alice, slug="alice-music", name="Alice Music")
    _notify(db, alice["id"], "old", minutes_ago=30)
    _notify(db, alice["id"], "read one", minutes_ago=20, is_read=True)
    _notify(db, alice["id"], "org scoped", org_id=org["id"], minutes_ago=10)
    _notify(db, alice["id"], "newest", minutes_ago=0)

    response = client.get(BASE, headers=alice["headers"])
    assert response.status_code == 200, response.text
    data = response.json()
    assert [n["title"] for n in data["items"]] == ["newest", "org scoped", "read one", "old"]
    assert data["total"] == 4 and data["unread_count"] == 3

    unread = client.get(BASE, params={"unread_only": True}, headers=alice["headers"]).json()
    assert [n["title"] for n in unread["items"]] == ["newest", "org scoped", "old"]

    scoped = client.get(BASE, params={"organization_id": org["id"]}, headers=alice["headers"]).json()
    assert [n["title"] for n in scoped["items"]] == ["org scoped"]
    assert scoped["unread_count"] == 1

    paged = client.get(BASE, params={"page": 2, "page_size": 3}, headers=alice["headers"]).json()
    assert [n["title"] for n in paged["items"]] == ["old"] and paged["pages"] == 2

    count = client.get(f"{BASE}/unread-count", headers=alice["headers"]).json()
    assert count == {"unread_count": 3}
    assert client.get(BASE).status_code == 401


def test_mark_read_unread_delete_and_read_all(client, api, db):
    alice = api.user("alice@example.com")
    org = api.org(alice, slug="alice-music", name="Alice Music")
    a1 = _notify(db, alice["id"], "a1")
    _notify(db, alice["id"], "a2", org_id=org["id"])
    _notify(db, alice["id"], "a3")

    read = client.post(f"{BASE}/{a1.id}/read", headers=alice["headers"])
    assert read.status_code == 200 and read.json()["is_read"] is True
    assert read.json()["read_at"] is not None
    assert client.get(f"{BASE}/unread-count", headers=alice["headers"]).json()["unread_count"] == 2

    unread = client.post(f"{BASE}/{a1.id}/unread", headers=alice["headers"]).json()
    assert unread["is_read"] is False and unread["read_at"] is None

    scoped = client.post(f"{BASE}/read-all", params={"organization_id": org["id"]},
                         headers=alice["headers"]).json()
    assert scoped == {"affected": 1, "unread_count": 2}
    everything = client.post(f"{BASE}/read-all", headers=alice["headers"]).json()
    assert everything == {"affected": 2, "unread_count": 0}

    assert client.delete(f"{BASE}/{a1.id}", headers=alice["headers"]).status_code == 200
    assert client.delete(f"{BASE}/{a1.id}", headers=alice["headers"]).status_code == 404
    assert client.get(BASE, headers=alice["headers"]).json()["total"] == 2


def test_users_cannot_touch_other_users_notifications(client, api, db):
    alice = api.user("alice@example.com")
    bob = api.user("bob@example.com")
    note = _notify(db, alice["id"], "private to alice")
    _notify(db, bob["id"], "bob's")

    listed = client.get(BASE, headers=bob["headers"]).json()
    assert [n["title"] for n in listed["items"]] == ["bob's"]
    for method, path in [("post", f"/{note.id}/read"), ("post", f"/{note.id}/unread"),
                         ("delete", f"/{note.id}")]:
        response = getattr(client, method)(BASE + path, headers=bob["headers"])
        assert response.status_code == 404, path
    # Bob's read-all leaves Alice's notification untouched.
    assert client.post(f"{BASE}/read-all", headers=bob["headers"]).json()["affected"] == 1
    db.expire_all()
    stored = db.get(Notification, note.id)
    assert stored is not None and stored.is_read is False
    # An organization filter cannot widen access either.
    assert client.get(BASE, params={"organization_id": "x" * 36},
                      headers=bob["headers"]).json()["total"] == 0


def test_email_log_marks_console_emails_as_not_delivered(client, team, db):
    org_id = team["org_id"]
    response = client.post(f"/api/v1/organizations/{org_id}/invitations",
                           json={"email": "newbie@example.com", "role": "viewer"},
                           headers=team["admin"]["headers"])
    assert response.status_code == 201, response.text
    # A real delivery (status "sent") recorded directly, and another org's email.
    db.add(EmailMessage(organization_id=org_id, to_email="x@example.com", subject="Sent",
                        template="generic", body_text="hello", provider="smtp", status="sent",
                        sent_at=utc_now(), created_at=utc_now() - timedelta(hours=1)))
    send_email(db, to="spy@example.com", subject="Other org", body="secret", template="generic",
               organization_id=team["other_org"]["id"])
    db.commit()

    for role in ("viewer", "manager"):
        assert client.get(f"/api/v1/organizations/{org_id}/email-log",
                          headers=team[role]["headers"]).status_code == 403
    assert client.get(f"/api/v1/organizations/{org_id}/email-log",
                      headers=team["outsider"]["headers"]).status_code == 404

    log = client.get(f"/api/v1/organizations/{org_id}/email-log",
                     headers=team["admin"]["headers"]).json()
    assert log["total"] == 2
    invite, sent = log["items"]
    assert invite["template"] == "invitation" and invite["to_email"] == "newbie@example.com"
    assert invite["provider"] == "console" and invite["status"] == "logged"
    assert invite["delivered"] is False and invite["sent_at"] is None
    assert "body_text" not in invite and "preview_path" not in invite
    assert sent["delivered"] is True and sent["status"] == "sent"

    filtered = client.get(f"/api/v1/organizations/{org_id}/email-log", params={"status": "logged"},
                          headers=team["owner"]["headers"]).json()
    assert [e["subject"] for e in filtered["items"]] == [invite["subject"]]
    assert client.get(f"/api/v1/organizations/{org_id}/email-log", params={"status": "bogus"},
                      headers=team["owner"]["headers"]).status_code == 422
    assert db.scalar(select(EmailMessage).where(EmailMessage.subject == "Other org")) is not None
