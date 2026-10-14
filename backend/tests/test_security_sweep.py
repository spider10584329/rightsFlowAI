"""Route-level security sweep over every tenant-scoped endpoint.

Instead of trusting each module's own tests, this enumerates the live route
table and asserts the access rules hold everywhere:

1. Unauthenticated requests are rejected (401) on every org route.
2. A user with no membership never gets a 2xx (or a 500) from another
   organization's routes, whatever ids are used.
3. A viewer cannot call any mutating endpoint except an explicit allow-list
   of read-only/self-service actions.
"""

import re
from uuid import uuid4

import pytest

from app.main import app

MUTATING = {"POST", "PUT", "PATCH", "DELETE"}

# Mutating endpoints a viewer may legitimately call (read-only computations or
# self-service). Anything else must be refused for viewers.
VIEWER_ALLOWED = {
    ("POST", "/api/v1/organizations/{organization_id}/leave"),
    ("POST", "/api/v1/organizations/{organization_id}/rights/validate"),
    ("POST", "/api/v1/organizations/{organization_id}/royalties/runs/{run_id}/verify"),
    ("POST", "/api/v1/organizations/{organization_id}/royalties/reports/{report_type}/export"),
}


def org_routes() -> list[tuple[str, str]]:
    """Every (method, path) under /organizations/{organization_id}, taken from
    the OpenAPI schema so nested routers are included."""
    found = set()
    for path, operations in app.openapi()["paths"].items():
        if "{organization_id}" not in path:
            continue
        for method in operations:
            if method.upper() in ("GET", "POST", "PUT", "PATCH", "DELETE"):
                found.add((method.upper(), path))
    return sorted(found)


ROUTES = org_routes()


def fill(path: str, org_id: str) -> str:
    def repl(match: re.Match) -> str:
        name = match.group(1)
        if name == "organization_id":
            return org_id
        if name in ("asset_type",):
            return "work"
        if name in ("entity_type",):
            return "works"
        if name == "report_type":
            return "revenue_by_source"
        return str(uuid4())
    return re.sub(r"\{([^}:]+)(?::[^}]*)?\}", repl, path)


def call(client, method: str, url: str, headers: dict | None = None):
    kwargs = {"headers": headers or {}}
    if method in ("POST", "PUT", "PATCH"):
        kwargs["json"] = {}
    return client.request(method, url, **kwargs)


def test_sweep_covers_the_whole_api():
    assert len(ROUTES) > 150, len(ROUTES)


def test_unauthenticated_requests_are_rejected_everywhere(client, team):
    failures = []
    for method, path in ROUTES:
        response = call(client, method, fill(path, team["org_id"]))
        if response.status_code != 401:
            failures.append((method, path, response.status_code))
    assert failures == []


def test_outsiders_never_reach_another_tenant(client, team):
    failures = []
    outsider = team["outsider"]["headers"]
    for method, path in ROUTES:
        response = call(client, method, fill(path, team["org_id"]), outsider)
        # 404 (org hidden) is expected; 403/405/422 also leak nothing.
        if response.status_code < 300 or response.status_code >= 500 or response.status_code not in (403, 404, 405, 422):
            failures.append((method, path, response.status_code))
    assert failures == []


def test_viewers_cannot_mutate(client, team):
    failures = []
    viewer = team["viewer"]["headers"]
    for method, path in ROUTES:
        if method not in MUTATING or (method, path) in VIEWER_ALLOWED:
            continue
        response = call(client, method, fill(path, team["org_id"]), viewer)
        if response.status_code != 403:
            failures.append((method, path, response.status_code))
    assert failures == []


@pytest.mark.parametrize("bad_org", ["../../etc/passwd", "1 OR 1=1", "x" * 37])
def test_malformed_organization_ids_are_rejected(client, team, bad_org):
    headers = team["owner"]["headers"]
    for path in ("/api/v1/organizations/{}", "/api/v1/organizations/{}/works", "/api/v1/organizations/{}/ledger"):
        response = client.get(path.format(bad_org), headers=headers)
        assert response.status_code in (404, 422), (path, response.status_code)
