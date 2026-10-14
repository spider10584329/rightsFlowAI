import re

from sqlalchemy import select

from app.models.platform import EmailMessage
from tests.conftest import DEFAULT_PASSWORD, email_token


def url(org_id: str, path: str = "") -> str:
    return f"/api/v1/organizations/{org_id}{path}"


def members(client, team, as_="owner"):
    return {
        m["user_email"]: m
        for m in client.get(url(team["org_id"], "/members"), headers=team[as_]["headers"]).json()
    }


def test_create_and_list_organizations_with_role(api, client):
    owner = api.user("o@example.com")
    org = api.org(owner, slug="my-label", name="My Label")
    assert org["role"] == "owner"
    listed = client.get("/api/v1/organizations", headers=owner["headers"]).json()
    assert [o["slug"] for o in listed] == ["my-label"]
    dup = client.post("/api/v1/organizations", json={"name": "Xy", "slug": "my-label"}, headers=owner["headers"])
    assert dup.status_code == 409
    bad_slug = client.post("/api/v1/organizations", json={"name": "Xy", "slug": "Bad Slug!"}, headers=owner["headers"])
    assert bad_slug.status_code == 422


def test_cross_tenant_access_is_denied(client, team):
    outsider = team["outsider"]["headers"]
    for path in ["", "/members", "/settings", "/activity"]:
        assert client.get(url(team["org_id"], path), headers=outsider).status_code == 404
    response = client.patch(url(team["org_id"]), json={"name": "Hijacked"}, headers=outsider)
    assert response.status_code == 404
    # And a member of org A can't see org B either.
    assert client.get(url(team["other_org"]["id"]), headers=team["owner"]["headers"]).status_code == 404


def test_role_permissions_on_settings(client, team):
    for role, expected in [("viewer", 403), ("manager", 403), ("admin", 200), ("owner", 200)]:
        response = client.patch(url(team["org_id"]), json={"description": f"by {role}"}, headers=team[role]["headers"])
        assert response.status_code == expected, role
    detail = client.get(url(team["org_id"]), headers=team["viewer"]["headers"]).json()
    assert detail["role"] == "viewer"
    assert detail["settings"]["allocation_basis"] == "controlled_pro_rata"


def test_role_changes_follow_hierarchy(client, team):
    m = members(client, team)
    manager_id = m["manager@example.com"]["id"]
    admin_id = m["admin@example.com"]["id"]
    owner_id = m["owner@example.com"]["id"]

    # Admin can demote a manager but cannot promote to admin or touch admins/owner.
    assert client.patch(url(team["org_id"], f"/members/{manager_id}/role"), json={"role": "viewer"}, headers=team["admin"]["headers"]).status_code == 200
    assert client.patch(url(team["org_id"], f"/members/{manager_id}/role"), json={"role": "admin"}, headers=team["admin"]["headers"]).status_code == 403
    assert client.patch(url(team["org_id"], f"/members/{admin_id}/role"), json={"role": "viewer"}, headers=team["admin"]["headers"]).status_code == 403
    assert client.patch(url(team["org_id"], f"/members/{owner_id}/role"), json={"role": "viewer"}, headers=team["owner"]["headers"]).status_code == 403
    # "owner" is never assignable through role updates.
    assert client.patch(url(team["org_id"], f"/members/{manager_id}/role"), json={"role": "owner"}, headers=team["owner"]["headers"]).status_code == 422
    # Managers cannot manage members at all.
    assert client.patch(url(team["org_id"], f"/members/{manager_id}/role"), json={"role": "viewer"}, headers=team["manager"]["headers"]).status_code == 403


def test_deactivate_and_reactivate_membership(client, team):
    m = members(client, team)
    viewer_id = m["viewer@example.com"]["id"]
    response = client.patch(url(team["org_id"], f"/members/{viewer_id}/deactivate"), headers=team["admin"]["headers"])
    assert response.status_code == 200 and response.json()["is_active"] is False
    # Deactivated members lose access immediately.
    assert client.get(url(team["org_id"]), headers=team["viewer"]["headers"]).status_code == 404
    assert client.patch(url(team["org_id"], f"/members/{viewer_id}/deactivate"), headers=team["admin"]["headers"]).status_code == 409
    assert client.patch(url(team["org_id"], f"/members/{viewer_id}/reactivate"), headers=team["owner"]["headers"]).status_code == 200
    assert client.get(url(team["org_id"]), headers=team["viewer"]["headers"]).status_code == 200


def test_owner_cannot_leave_without_transfer(client, team):
    response = client.post(url(team["org_id"], "/leave"), headers=team["owner"]["headers"])
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "ownership_transfer_required"
    assert client.post(url(team["org_id"], "/leave"), headers=team["viewer"]["headers"]).status_code == 200


def test_ownership_transfer_requires_confirmation(client, team):
    m = members(client, team)
    admin_id = m["admin@example.com"]["id"]
    manager_id = m["manager@example.com"]["id"]
    base = {"new_owner_membership_id": admin_id, "password": DEFAULT_PASSWORD, "confirm_slug": "acme-music"}

    assert client.post(url(team["org_id"], "/transfer-ownership"), json={**base, "confirm_slug": "wrong"}, headers=team["owner"]["headers"]).status_code == 422
    assert client.post(url(team["org_id"], "/transfer-ownership"), json={**base, "password": "bad"}, headers=team["owner"]["headers"]).status_code == 422
    assert client.post(url(team["org_id"], "/transfer-ownership"), json={**base, "new_owner_membership_id": manager_id}, headers=team["owner"]["headers"]).status_code == 422
    assert client.post(url(team["org_id"], "/transfer-ownership"), json=base, headers=team["admin"]["headers"]).status_code == 403

    response = client.post(url(team["org_id"], "/transfer-ownership"), json=base, headers=team["owner"]["headers"])
    assert response.status_code == 200
    m = members(client, team, as_="admin")
    assert m["admin@example.com"]["role"] == "owner"
    assert m["owner@example.com"]["role"] == "admin"
    # Former owner can now leave.
    assert client.post(url(team["org_id"], "/leave"), headers=team["owner"]["headers"]).status_code == 200


def test_invitation_lifecycle(api, client, team, db):
    response = client.post(
        url(team["org_id"], "/invitations"),
        json={"email": "newbie@example.com", "role": "manager"},
        headers=team["admin"]["headers"],
    )
    assert response.status_code == 201
    created = response.json()
    assert created["email_delivery"] == "logged"
    token = re.search(r"token=([\w\-]+)", created["invite_url"]).group(1)

    preview = client.post("/api/v1/invitations/preview", json={"token": token})
    assert preview.json()["organization_name"] == "Acme Music"

    # A different user cannot accept someone else's invitation.
    stranger = api.user("stranger@example.com")
    assert client.post("/api/v1/invitations/accept", json={"token": token}, headers=stranger["headers"]).status_code == 403

    newbie = api.user("newbie@example.com", "New Bie")
    # Listing invitations by email requires a verified mailbox (audit A-01).
    assert client.get("/api/v1/invitations/mine", headers=newbie["headers"]).status_code == 403
    verify_token = email_token(db, "newbie@example.com", "email_verification")
    assert client.post("/api/v1/auth/email/verify", json={"token": verify_token}).status_code == 200
    mine = client.get("/api/v1/invitations/mine", headers=newbie["headers"]).json()
    assert len(mine) == 1
    accepted = client.post("/api/v1/invitations/accept", json={"token": token}, headers=newbie["headers"])
    assert accepted.status_code == 200 and accepted.json()["role"] == "manager"
    assert client.post("/api/v1/invitations/accept", json={"token": token}, headers=newbie["headers"]).status_code == 409
    assert client.get(url(team["org_id"]), headers=newbie["headers"]).status_code == 200
    assert db.scalar(select(EmailMessage).where(EmailMessage.template == "invitation")) is not None


def test_invitation_permissions_and_revocation(client, team):
    assert client.post(url(team["org_id"], "/invitations"), json={"email": "x@example.com", "role": "viewer"}, headers=team["manager"]["headers"]).status_code == 403
    assert client.post(url(team["org_id"], "/invitations"), json={"email": "x@example.com", "role": "admin"}, headers=team["admin"]["headers"]).status_code == 403
    invite = client.post(url(team["org_id"], "/invitations"), json={"email": "x@example.com", "role": "viewer"}, headers=team["owner"]["headers"]).json()
    revoked = client.post(url(team["org_id"], f"/invitations/{invite['id']}/revoke"), headers=team["admin"]["headers"])
    assert revoked.json()["status"] == "revoked"
    token = re.search(r"token=([\w\-]+)", invite["invite_url"]).group(1)
    assert client.post("/api/v1/invitations/preview", json={"token": token}).json()["status"] == "revoked"
    # Existing members cannot be re-invited.
    assert client.post(url(team["org_id"], "/invitations"), json={"email": "viewer@example.com", "role": "viewer"}, headers=team["owner"]["headers"]).status_code == 409


def test_user_limit_is_enforced(api, client, db):
    from app.models.billing import Plan, Subscription

    owner = api.user("limits@example.com")
    org = api.org(owner, slug="tiny-co")
    starter = db.scalar(select(Plan).where(Plan.code == "dev-starter"))
    sub = db.scalar(select(Subscription).where(Subscription.organization_id == org["id"]))
    sub.plan_id = starter.id
    db.commit()
    for i in range(2):
        assert client.post(url(org["id"], "/invitations"), json={"email": f"p{i}@example.com", "role": "viewer"}, headers=owner["headers"]).status_code == 201
    over = client.post(url(org["id"], "/invitations"), json={"email": "p3@example.com", "role": "viewer"}, headers=owner["headers"])
    assert over.status_code == 402
    assert over.json()["error"]["code"] == "plan_limit_exceeded"


def test_activity_log_visibility(client, team):
    admin_view = client.get(url(team["org_id"], "/activity"), headers=team["admin"]["headers"]).json()
    actions = {item["action"] for item in admin_view["items"]}
    assert "organization.created" in actions and "invitation.accepted" in actions
    viewer_view = client.get(url(team["org_id"], "/activity"), headers=team["viewer"]["headers"]).json()
    assert all(not i["action"].startswith("membership.") for i in viewer_view["items"])


def test_organization_switching(client, team):
    headers = team["owner"]["headers"]
    response = client.put("/api/v1/auth/me/active-organization", json={"organization_id": team["org_id"]}, headers=headers)
    assert response.status_code == 200 and response.json()["last_organization_id"] == team["org_id"]
    response = client.put("/api/v1/auth/me/active-organization", json={"organization_id": team["other_org"]["id"]}, headers=headers)
    assert response.status_code == 404
