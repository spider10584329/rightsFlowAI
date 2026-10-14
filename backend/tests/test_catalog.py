"""Music catalog: parties, works, recordings, releases and catalog tools."""

from sqlalchemy import select

from app.models.billing import Plan, Subscription
from app.models.catalog import Party
from app.models.platform import AuditLog
from app.models.royalty import Payee
from app.services import catalog as svc


def url(org_id: str, path: str = "") -> str:
    return f"/api/v1/organizations/{org_id}{path}"


def iswc(body: str) -> str:
    """Valid formatted ISWC for a 9-digit body."""
    digits = [int(d) for d in body]
    check = (10 - (1 + sum(d * (i + 1) for i, d in enumerate(digits))) % 10) % 10
    return f"T-{body[:3]}.{body[3:6]}.{body[6:9]}-{check}"


def upc(body: str) -> str:
    """Valid GTIN for an 11/12/13-digit body."""
    total = sum(int(ch) * (3 if i % 2 == 0 else 1) for i, ch in enumerate(reversed(body)))
    return body + str((10 - total % 10) % 10)


class Catalog:
    def __init__(self, client, team, as_="manager"):
        self.client = client
        self.org_id = team["org_id"]
        self.headers = team[as_]["headers"]

    def post(self, path, json, expected=201, **params):
        response = self.client.post(url(self.org_id, path), json=json, headers=self.headers,
                                    params=params)
        assert response.status_code == expected, response.text
        return response.json()

    def party(self, name, roles=("songwriter",), **extra):
        return self.post("/parties", {"name": name, "roles": list(roles), **extra})

    def work(self, title, **extra):
        return self.post("/works", {"title": title, **extra})

    def recording(self, title, **extra):
        return self.post("/recordings", {"title": title, **extra})

    def release(self, title, **extra):
        return self.post("/releases", {"title": title, **extra})


# --------------------------------------------------------------------------- parties


def test_party_crud_search_and_identifier_validation(client, team):
    cat = Catalog(client, team)
    jane = cat.party("Jane Writer", ["songwriter", "artist"], ipi_number="052210040",
                     isni="0000 0001 2103 2683", country_code="us")
    assert jane["ipi_number"] == "00052210040"
    assert jane["isni"] == "0000000121032683"
    assert jane["country_code"] == "US"
    assert jane["is_referenced"] is False
    cat.party("Acme Publishing", ["publisher"], party_type="company")
    cat.party("Bob Producer", ["producer"])

    headers = team["viewer"]["headers"]
    listed = client.get(url(team["org_id"], "/parties"), params={"role": "songwriter"},
                        headers=headers).json()
    assert [p["name"] for p in listed["items"]] == ["Jane Writer"]
    by_ipi = client.get(url(team["org_id"], "/parties"), params={"q": "52210040"}, headers=headers).json()
    assert by_ipi["total"] == 1
    companies = client.get(url(team["org_id"], "/parties"), params={"party_type": "company"},
                           headers=headers).json()
    assert [p["name"] for p in companies["items"]] == ["Acme Publishing"]

    for bad in ({"name": "X", "ipi_number": "12"}, {"name": "X", "isni": "0000000121032684"},
                {"name": "X", "roles": ["king"]}, {"name": "  "}, {"name": "X", "party_type": "robot"}):
        assert client.post(url(team["org_id"], "/parties"), json=bad,
                           headers=team["manager"]["headers"]).status_code == 422, bad

    updated = client.patch(url(team["org_id"], f"/parties/{jane['id']}"),
                           json={"roles": ["songwriter"], "pro_affiliation": "ASCAP"},
                           headers=team["manager"]["headers"])
    assert updated.status_code == 200
    assert updated.json()["roles"] == ["songwriter"] and updated.json()["pro_affiliation"] == "ASCAP"
    assert client.patch(url(team["org_id"], f"/parties/{jane['id']}"), json={"name": None},
                        headers=team["manager"]["headers"]).status_code == 422


def test_referenced_party_cannot_be_deleted_but_can_be_archived(client, team, db):
    cat = Catalog(client, team)
    writer = cat.party("Writer One")
    cat.work("Song", contributors=[{"party_id": writer["id"], "role": "composer"}])
    payee_party = cat.party("Payee Person")
    db.add(Payee(organization_id=team["org_id"], party_id=payee_party["id"], display_name="Payee"))
    db.commit()

    admin = team["admin"]["headers"]
    for party in (writer, payee_party):
        response = client.delete(url(team["org_id"], f"/parties/{party['id']}"), headers=admin)
        assert response.status_code == 409
        body = response.json()["error"]
        assert body["code"] == "party_in_use" and body["details"]["suggestion"] == "archive"
    assert client.get(url(team["org_id"], f"/parties/{writer['id']}"),
                      headers=admin).json()["references"] == {"work_contributors": 1}

    archived = client.patch(url(team["org_id"], f"/parties/{writer['id']}"),
                            json={"status": "archived"}, headers=team["manager"]["headers"])
    assert archived.status_code == 200
    names = [p["name"] for p in client.get(url(team["org_id"], "/parties"), headers=admin).json()["items"]]
    assert "Writer One" not in names
    with_archived = client.get(url(team["org_id"], "/parties"), params={"include_archived": True},
                               headers=admin).json()
    assert "Writer One" in [p["name"] for p in with_archived["items"]]
    only_archived = client.get(url(team["org_id"], "/parties"), params={"status": "archived"},
                               headers=admin).json()
    assert [p["name"] for p in only_archived["items"]] == ["Writer One"]

    free = cat.party("Unused")
    assert client.delete(url(team["org_id"], f"/parties/{free['id']}"), headers=admin).status_code == 200
    assert client.get(url(team["org_id"], f"/parties/{free['id']}"), headers=admin).status_code == 404


# --------------------------------------------------------------------------- works


def test_work_crud_with_contributors_and_completeness(client, team):
    cat = Catalog(client, team)
    jane = cat.party("Jane Writer")
    john = cat.party("John Lyricist", ["lyricist"])
    pub = cat.party("Acme Publishing", ["publisher"], party_type="company")

    work = cat.work("Midnight River", iswc="T-034.524.680-1", internal_code="WK-1",
                    language="en", contributors=[
                        {"party_id": jane["id"], "role": "composer"},
                        {"party_id": jane["id"], "role": "composer"},
                        {"party_id": john["id"], "role": "lyricist"},
                    ])
    assert work["iswc"] == "T0345246801"
    assert work["iswc_display"] == "T-034.524.680-1"
    assert [(c["party_name"], c["role"]) for c in work["contributors"]] == [
        ("Jane Writer", "composer"), ("John Lyricist", "lyricist")]
    assert work["completeness"]["score"] == 30 + 30 + 10 + 5
    assert "publisher" in work["completeness"]["missing"]
    assert work["recordings"] == []

    # internal_code is unique per organization.
    dup_code = client.post(url(team["org_id"], "/works"), json={"title": "Other", "internal_code": "WK-1"},
                           headers=team["manager"]["headers"])
    assert dup_code.status_code == 409 and dup_code.json()["error"]["code"] == "duplicate_internal_code"
    # Invalid ISWC check digit.
    assert client.post(url(team["org_id"], "/works"), json={"title": "Bad", "iswc": "T-034.524.680-2"},
                       headers=team["manager"]["headers"]).status_code == 422
    # Unknown party.
    missing = client.post(url(team["org_id"], "/works"),
                          json={"title": "X", "contributors": [{"party_id": "nope", "role": "composer"}]},
                          headers=team["manager"]["headers"])
    assert missing.status_code == 404

    updated = client.patch(url(team["org_id"], f"/works/{work['id']}"), json={
        "genre": "Pop",
        "contributors": [{"party_id": jane["id"], "role": "composer"},
                         {"party_id": pub["id"], "role": "original_publisher"}],
    }, headers=team["manager"]["headers"])
    assert updated.status_code == 200, updated.text
    body = updated.json()
    assert {(c["party_name"], c["role"]) for c in body["contributors"]} == {
        ("Jane Writer", "composer"), ("Acme Publishing", "original_publisher")}
    # Unchanged contributor rows are kept (same id).
    assert next(c["id"] for c in body["contributors"] if c["role"] == "composer") == \
        next(c["id"] for c in work["contributors"] if c["role"] == "composer")
    assert body["genre"] == "Pop"

    detail = client.get(url(team["org_id"], f"/works/{work['id']}"), headers=team["viewer"]["headers"])
    assert detail.status_code == 200 and detail.json()["title"] == "Midnight River"

    assert client.delete(url(team["org_id"], f"/works/{work['id']}"),
                         headers=team["admin"]["headers"]).status_code == 200
    assert client.get(url(team["org_id"], f"/works/{work['id']}"),
                      headers=team["admin"]["headers"]).status_code == 404


def test_work_list_filters_search_sort_and_pagination(client, team):
    cat = Catalog(client, team)
    writer = cat.party("Writer")
    titles = ["Echo", "Alpha", "Delta", "Charlie", "Bravo"]
    for i, title in enumerate(titles):
        extra = {"iswc": iswc(f"10000000{i}")} if i % 2 == 0 else {}
        if title == "Delta":
            extra["contributors"] = [{"party_id": writer["id"], "role": "composer"}]
        cat.work(title, **extra)
    headers = team["viewer"]["headers"]

    def get(**params):
        response = client.get(url(team["org_id"], "/works"), params=params, headers=headers)
        assert response.status_code == 200, response.text
        return response.json()

    page1 = get(page=1, page_size=2, sort="title")
    assert [w["title"] for w in page1["items"]] == ["Alpha", "Bravo"]
    assert page1["total"] == 5 and page1["pages"] == 3
    assert [w["title"] for w in get(page=3, page_size=2, sort="title")["items"]] == ["Echo"]
    assert [w["title"] for w in get(sort="title", order="desc")["items"]][0] == "Echo"
    # Unknown sort keys are ignored (whitelist), not an error.
    assert get(sort="organization_id")["total"] == 5
    assert {w["title"] for w in get(has_iswc=True)["items"]} == {"Echo", "Delta", "Bravo"}
    assert {w["title"] for w in get(has_iswc=False)["items"]} == {"Alpha", "Charlie"}
    assert [w["title"] for w in get(party_id=writer["id"])["items"]] == ["Delta"]
    assert [w["title"] for w in get(q="harl")["items"]] == ["Charlie"]
    assert get(q=iswc("100000002"))["items"][0]["title"] == "Delta"
    assert get(q="%")["total"] == 0  # LIKE wildcards are escaped
    assert client.get(url(team["org_id"], "/works"), params={"page_size": 1000},
                      headers=headers).status_code == 422


# --------------------------------------------------------------------------- recordings


def test_recording_crud_with_links_and_contributors(client, team):
    cat = Catalog(client, team)
    artist = cat.party("The Band", ["artist"], party_type="company")
    producer = cat.party("Pat Producer", ["producer"])
    work = cat.work("Midnight River", iswc="T-034.524.680-1")

    rec = cat.recording("Midnight River", isrc="us-rc1-76-07839", primary_artist_id=artist["id"],
                        duration_seconds=225, work_ids=[work["id"], work["id"]],
                        contributors=[{"party_id": producer["id"], "role": "producer"},
                                      {"party_id": artist["id"], "role": "main_artist"}])
    assert rec["isrc"] == "USRC17607839"
    assert rec["primary_artist_name"] == "The Band" and rec["artist"] == "The Band"
    assert [w["id"] for w in rec["works"]] == [work["id"]]
    assert [c["role"] for c in rec["contributors"]] == ["main_artist", "producer"]
    assert rec["releases"] == []

    work_detail = client.get(url(team["org_id"], f"/works/{work['id']}"),
                             headers=team["viewer"]["headers"]).json()
    assert [r["id"] for r in work_detail["recordings"]] == [rec["id"]]

    for bad in ({"title": "x", "isrc": "US-RC1-76"}, {"title": "x", "duration_seconds": -1},
                {"title": "x", "contributors": [{"party_id": artist["id"], "role": "boss"}]}):
        assert client.post(url(team["org_id"], "/recordings"), json=bad,
                           headers=team["manager"]["headers"]).status_code == 422, bad
    assert client.post(url(team["org_id"], "/recordings"),
                       json={"title": "x", "primary_artist_id": "missing"},
                       headers=team["manager"]["headers"]).status_code == 404
    assert client.post(url(team["org_id"], "/recordings"), json={"title": "x", "work_ids": ["missing"]},
                       headers=team["manager"]["headers"]).status_code == 404

    updated = client.patch(url(team["org_id"], f"/recordings/{rec['id']}"),
                           json={"work_ids": [], "version_title": "Radio Edit",
                                 "contributors": [{"party_id": producer["id"], "role": "producer",
                                                   "instrument": "synth"}]},
                           headers=team["manager"]["headers"])
    assert updated.status_code == 200, updated.text
    body = updated.json()
    assert body["works"] == [] and body["version_title"] == "Radio Edit"
    assert [(c["role"], c["instrument"]) for c in body["contributors"]] == [("producer", "synth")]

    headers = team["viewer"]["headers"]
    listing = client.get(url(team["org_id"], "/recordings"), params={"party_id": artist["id"]},
                         headers=headers).json()
    assert listing["total"] == 1
    assert client.get(url(team["org_id"], "/recordings"), params={"has_work": True},
                      headers=headers).json()["total"] == 0
    assert client.get(url(team["org_id"], "/recordings"), params={"q": "the band"},
                      headers=headers).json()["total"] == 1
    assert client.get(url(team["org_id"], "/recordings"), params={"q": "USRC1760"},
                      headers=headers).json()["total"] == 1


# --------------------------------------------------------------------------- releases


def test_release_crud_with_tracks(client, team):
    cat = Catalog(client, team)
    label = cat.party("Example Records", ["label"], party_type="company")
    r1 = cat.recording("One", isrc="USRC17600001")
    r2 = cat.recording("Two", isrc="USRC17600002")
    code = upc("01234567890")
    release = cat.release("The Album", upc=code, label_id=label["id"], release_type="ep", tracks=[
        {"recording_id": r2["id"], "track_number": 2},
        {"recording_id": r1["id"], "track_number": 1},
    ])
    assert release["upc"] == code and release["label_name"] == "Example Records"
    assert [t["recording_title"] for t in release["tracks"]] == ["One", "Two"]
    assert release["track_count"] == 2

    manager = team["manager"]["headers"]
    assert client.post(url(team["org_id"], "/releases"), json={"title": "x", "upc": "012345678901"},
                       headers=manager).status_code == 422
    assert client.post(url(team["org_id"], "/releases"), json={"title": "x", "tracks": [
        {"recording_id": r1["id"], "track_number": 1}, {"recording_id": r2["id"], "track_number": 1}]},
        headers=manager).status_code == 422
    assert client.post(url(team["org_id"], "/releases"), json={"title": "x", "label_id": "missing"},
                       headers=manager).status_code == 404

    updated = client.patch(url(team["org_id"], f"/releases/{release['id']}"), json={"tracks": [
        {"recording_id": r2["id"], "track_number": 1},
        {"recording_id": r1["id"], "disc_number": 2, "track_number": 1},
    ]}, headers=manager)
    assert updated.status_code == 200, updated.text
    assert [(t["disc_number"], t["track_number"], t["recording_title"])
            for t in updated.json()["tracks"]] == [(1, 1, "Two"), (2, 1, "One")]

    rec_detail = client.get(url(team["org_id"], f"/recordings/{r1['id']}"), headers=manager).json()
    assert rec_detail["releases"][0]["disc_number"] == 2
    # A recording on a release cannot be deleted.
    response = client.delete(url(team["org_id"], f"/recordings/{r1['id']}"), headers=team["admin"]["headers"])
    assert response.status_code == 409 and response.json()["error"]["code"] == "recording_in_use"
    assert client.get(url(team["org_id"], "/releases"), params={"recording_id": r1["id"]},
                      headers=manager).json()["total"] == 1
    assert client.delete(url(team["org_id"], f"/releases/{release['id']}"),
                         headers=team["admin"]["headers"]).status_code == 200
    assert client.delete(url(team["org_id"], f"/recordings/{r1['id']}"),
                         headers=team["admin"]["headers"]).status_code == 200


# --------------------------------------------------------------------------- duplicates


def test_exact_identifier_duplicates_conflict_unless_allowed(client, team):
    cat = Catalog(client, team)
    cat.work("Song A", iswc="T-034.524.680-1")
    conflict = client.post(url(team["org_id"], "/works"), json={"title": "Song B", "iswc": "T0345246801"},
                           headers=team["manager"]["headers"])
    assert conflict.status_code == 409 and conflict.json()["error"]["code"] == "duplicate_identifier"
    cat.post("/works", {"title": "Song B", "iswc": "T0345246801"}, allow_duplicate="true")

    cat.recording("Rec", isrc="USRC17607839")
    assert client.post(url(team["org_id"], "/recordings"), json={"title": "Rec 2", "isrc": "US-RC1-76-07839"},
                       headers=team["manager"]["headers"]).status_code == 409
    code = upc("01234567890")
    cat.release("Album", upc=code)
    # The same GTIN expressed as EAN-13 is still a duplicate.
    assert client.post(url(team["org_id"], "/releases"), json={"title": "Album 2", "upc": "0" + code},
                       headers=team["manager"]["headers"]).status_code == 409

    dupes = client.get(url(team["org_id"], "/catalog/duplicates"), params={"entity_type": "work"},
                       headers=team["viewer"]["headers"]).json()
    assert dupes[0]["score"] == 1.0
    assert dupes[0]["reasons"] == ["Same ISWC T-034.524.680-1"]
    assert sorted(dupes[0]["titles"]) == ["Song A", "Song B"]


def test_find_duplicate_candidates_title_similarity(client, team, db):
    cat = Catalog(client, team)
    band = cat.party("The Band", ["artist"])
    other = cat.party("Someone Else", ["artist"])
    a = cat.recording("Hello World (feat. Guest)", primary_artist_id=band["id"])
    b = cat.recording("Hello, World - 2011 Remastered", display_artist="The Band")
    cat.recording("Hello World", primary_artist_id=other["id"], isrc="USRC17600009")
    cat.recording("Completely Different", primary_artist_id=band["id"])

    results = svc.find_duplicate_candidates(db, team["org_id"], "recording")
    assert sorted(results[0]["ids"]) == sorted([a["id"], b["id"]])
    assert results[0]["score"] == 1.0
    assert "Same normalized title" in results[0]["reasons"] and "Same artist" in results[0]["reasons"]
    # Same title but a different artist scores below the threshold.
    assert all(set(r["ids"]) == {a["id"], b["id"]} for r in results)
    assert svc.normalize_title("Café (Remastered 2009)") == "cafe"
    # Deterministic and limit-respecting.
    assert svc.find_duplicate_candidates(db, team["org_id"], "recording") == results
    assert svc.find_duplicate_candidates(db, team["org_id"], "recording", limit=0) == []

    cat.party("Jon Smith", ipi_number="00052210040")
    cat.party("John Smith", ipi_number="052210040")
    parties = client.get(url(team["org_id"], "/catalog/duplicates"), params={"entity_type": "parties"},
                         headers=team["viewer"]["headers"]).json()
    assert parties[0]["score"] == 1.0 and parties[0]["reasons"][0].startswith("Same IPI")
    assert client.get(url(team["org_id"], "/catalog/duplicates"), params={"entity_type": "contract"},
                      headers=team["viewer"]["headers"]).status_code == 422


# --------------------------------------------------------------------------- tenancy and RBAC


def test_tenant_isolation(client, team):
    cat = Catalog(client, team)
    party = cat.party("Mine")
    work = cat.work("My Work")
    rec = cat.recording("My Rec")
    rel = cat.release("My Release")
    outsider = team["outsider"]["headers"]
    org = team["org_id"]

    gets = ["/parties", f"/parties/{party['id']}", "/works", f"/works/{work['id']}", "/recordings",
            f"/recordings/{rec['id']}", "/releases", f"/releases/{rel['id']}",
            "/catalog/validation-issues", "/catalog/duplicates?entity_type=work",
            "/catalog/completeness", "/catalog/summary", "/catalog/export?entity_type=works",
            "/catalog/imports/template?entity_type=work", "/catalog/imports",
            f"/catalog/work/{work['id']}/activity"]
    for path in gets:
        assert client.get(url(org, path), headers=outsider).status_code == 404, path
    assert client.post(url(org, "/works"), json={"title": "Hijack"}, headers=outsider).status_code == 404
    assert client.patch(url(org, f"/works/{work['id']}"), json={"title": "Hijack"},
                        headers=outsider).status_code == 404
    assert client.delete(url(org, f"/parties/{party['id']}"), headers=outsider).status_code == 404
    assert client.post(url(org, "/catalog/bulk"), json={"entity_type": "work", "action": "archive",
                                                         "ids": [work["id"]]},
                       headers=outsider).status_code == 404

    # The outsider's own organization cannot see or reference our rows.
    other = team["other_org"]["id"]
    assert client.get(url(other, f"/works/{work['id']}"), headers=outsider).status_code == 404
    assert client.get(url(other, f"/catalog/work/{work['id']}/activity"),
                      headers=outsider).status_code == 404
    response = client.post(url(other, "/works"), json={
        "title": "Steal", "contributors": [{"party_id": party["id"], "role": "composer"}]},
        headers=outsider)
    assert response.status_code == 404
    assert client.post(url(other, "/recordings"), json={"title": "Steal", "primary_artist_id": party["id"]},
                       headers=outsider).status_code == 404
    assert client.post(url(other, "/releases"), json={
        "title": "Steal", "tracks": [{"recording_id": rec["id"], "track_number": 1}]},
        headers=outsider).status_code == 404
    bulk = client.post(url(other, "/catalog/bulk"), json={"entity_type": "work", "action": "delete",
                                                           "ids": [work["id"]]}, headers=outsider)
    assert bulk.status_code == 200 and bulk.json()["skipped"] == [{"id": work["id"], "reason": "Not found"}]
    assert client.get(url(org, f"/works/{work['id']}"), headers=team["owner"]["headers"]).status_code == 200


def test_role_permissions(client, team):
    org = team["org_id"]
    viewer, manager, admin = (team[r]["headers"] for r in ("viewer", "manager", "admin"))
    for path, body in [("/parties", {"name": "V"}), ("/works", {"title": "V"}),
                       ("/recordings", {"title": "V"}), ("/releases", {"title": "V"})]:
        assert client.post(url(org, path), json=body, headers=viewer).status_code == 403, path
    work = Catalog(client, team).work("Song")
    assert client.patch(url(org, f"/works/{work['id']}"), json={"title": "X"}, headers=viewer).status_code == 403
    assert client.delete(url(org, f"/works/{work['id']}"), headers=manager).status_code == 403
    bulk = {"entity_type": "work", "action": "delete", "ids": [work["id"]]}
    assert client.post(url(org, "/catalog/bulk"), json=bulk, headers=manager).status_code == 403
    assert client.post(url(org, "/catalog/bulk"), json={**bulk, "action": "archive"},
                       headers=viewer).status_code == 403
    assert client.get(url(org, "/works"), headers=viewer).status_code == 200
    assert client.delete(url(org, f"/works/{work['id']}"), headers=admin).status_code == 200


# --------------------------------------------------------------------------- bulk


def test_bulk_archive_restore_delete(client, team, db):
    cat = Catalog(client, team)
    writer = cat.party("Writer")
    unused = cat.party("Unused")
    w1 = cat.work("One", contributors=[{"party_id": writer["id"], "role": "composer"}])
    w2 = cat.work("Two")
    org = team["org_id"]
    manager, admin = team["manager"]["headers"], team["admin"]["headers"]

    archived = client.post(url(org, "/catalog/bulk"), json={
        "entity_type": "work", "action": "archive", "ids": [w1["id"], w2["id"], "missing"]},
        headers=manager).json()
    assert archived["affected"] == 2
    assert archived["skipped"] == [{"id": "missing", "reason": "Not found"}]
    assert client.get(url(org, "/works"), headers=manager).json()["total"] == 0
    assert client.get(url(org, "/works"), params={"status": "archived"}, headers=manager).json()["total"] == 2

    again = client.post(url(org, "/catalog/bulk"), json={
        "entity_type": "work", "action": "archive", "ids": [w1["id"]]}, headers=manager).json()
    assert again["skipped"][0]["reason"] == "Already archived"
    restored = client.post(url(org, "/catalog/bulk"), json={
        "entity_type": "work", "action": "restore", "ids": [w1["id"]]}, headers=manager).json()
    assert restored["affected_ids"] == [w1["id"]]

    deleted = client.post(url(org, "/catalog/bulk"), json={
        "entity_type": "party", "action": "delete", "ids": [writer["id"], unused["id"]]},
        headers=admin).json()
    assert deleted["affected_ids"] == [unused["id"]]
    assert deleted["skipped"][0]["id"] == writer["id"]
    assert "work contributors (1)" in deleted["skipped"][0]["reason"]

    actions = set(db.scalars(select(AuditLog.action).where(AuditLog.organization_id == org)).all())
    assert {"work.archived", "work.restored", "party.deleted"} <= actions
    assert client.post(url(org, "/catalog/bulk"), json={"entity_type": "work", "action": "explode",
                                                         "ids": [w1["id"]]}, headers=admin).status_code == 422
    assert client.post(url(org, "/catalog/bulk"), json={"entity_type": "work", "action": "archive",
                                                         "ids": []}, headers=admin).status_code == 422


# --------------------------------------------------------------------------- quality tools


def test_validation_issues_completeness_and_summary(client, team):
    cat = Catalog(client, team)
    writer = cat.party("Writer", ["songwriter"])
    pub = cat.party("Pub", ["publisher"], party_type="company", ipi_number="123456789")
    complete_work = cat.work("Complete", iswc="T-034.524.680-1", internal_code="C1", language="en",
                             genre="Pop", creation_year=2020, contributors=[
                                 {"party_id": writer["id"], "role": "composer"},
                                 {"party_id": pub["id"], "role": "original_publisher"}])
    bare_work = cat.work("Bare")
    pub_only = cat.work("Publisher Only", contributors=[{"party_id": pub["id"], "role": "original_publisher"}])
    rec = cat.recording("Rec", work_ids=[complete_work["id"]])
    cat.release("Empty Release")
    assert complete_work["completeness"] == {"score": 100, "missing": []}

    org, viewer = team["org_id"], team["viewer"]["headers"]
    issues = client.get(url(org, "/catalog/validation-issues"), headers=viewer).json()
    found = {(i["entity_id"], i["code"]) for i in issues["items"]}
    assert (bare_work["id"], "missing_contributors") in found
    assert (bare_work["id"], "missing_iswc") in found
    assert (pub_only["id"], "no_writers") in found
    assert (rec["id"], "missing_isrc") in found and (rec["id"], "missing_artist") in found
    assert (rec["id"], "no_linked_work") not in found
    assert (writer["id"], "missing_ipi") in found and (pub["id"], "missing_ipi") not in found
    assert issues["by_code"]["no_tracks"] == 1
    assert not any(i["entity_id"] == complete_work["id"] and i["severity"] == "error" for i in issues["items"])
    # Deterministic ordering and filters.
    assert client.get(url(org, "/catalog/validation-issues"), headers=viewer).json() == issues
    works_only = client.get(url(org, "/catalog/validation-issues"),
                            params={"entity_type": "works", "severity": "error"}, headers=viewer).json()
    assert works_only["items"] and all(i["entity_type"] == "work" and i["severity"] == "error"
                                       for i in works_only["items"])

    completeness = client.get(url(org, "/catalog/completeness"), headers=viewer).json()
    assert completeness["count"] == 5
    assert completeness["bands"]["complete"] == 1
    assert completeness["least_complete"][0]["score"] == 0
    assert completeness["by_entity_type"]["work"]["count"] == 3

    summary = client.get(url(org, "/catalog/summary"), headers=viewer).json()
    assert (summary["works"], summary["recordings"], summary["releases"], summary["parties"]) == (3, 1, 1, 2)
    assert summary["parties_by_role"] == {"publisher": 1, "songwriter": 1}
    assert summary["missing_identifiers"]["works_without_iswc"] == 2
    assert summary["missing_identifiers"]["works_without_writers"] == 2
    assert summary["missing_identifiers"]["recordings_without_isrc"] == 1
    assert summary["missing_identifiers"]["releases_without_tracks"] == 1
    assert summary["missing_identifiers"]["writers_without_ipi"] == 1
    assert len(summary["recently_updated"]) == 7


def test_activity_history(client, team):
    cat = Catalog(client, team)
    work = cat.work("Song")
    org = team["org_id"]
    client.patch(url(org, f"/works/{work['id']}"), json={"title": "Song v2"}, headers=team["manager"]["headers"])
    history = client.get(url(org, f"/catalog/works/{work['id']}/activity"), headers=team["viewer"]["headers"])
    assert history.status_code == 200
    items = history.json()["items"]
    assert {i["action"] for i in items} == {"work.created", "work.updated"}
    update = next(i for i in items if i["action"] == "work.updated")
    assert update["changes"]["title"] == {"from": "Song", "to": "Song v2"}
    assert update["actor_name"] == "Mia Manager"
    # History survives deletion; unknown ids are 404.
    client.delete(url(org, f"/works/{work['id']}"), headers=team["admin"]["headers"])
    after = client.get(url(org, f"/catalog/work/{work['id']}/activity"), headers=team["viewer"]["headers"]).json()
    assert after["total"] == 3
    assert client.get(url(org, "/catalog/work/unknown/activity"),
                      headers=team["viewer"]["headers"]).status_code == 404


def test_catalog_item_plan_limit(client, team, db):
    plan = db.scalar(select(Plan).where(Plan.code == "test-catalog-tiny"))
    if plan is None:
        plan = Plan(code="test-catalog-tiny", name="Tiny", is_development=True, is_public=False,
                    currency="USD", sort_order=99, limits={"max_catalog_items": 2})
        db.add(plan)
        db.flush()
    sub = db.scalar(select(Subscription).where(Subscription.organization_id == team["org_id"]))
    sub.plan_id = plan.id
    db.commit()
    cat = Catalog(client, team)
    cat.work("One")
    second = cat.recording("Two")
    over = client.post(url(team["org_id"], "/releases"), json={"title": "Three"},
                       headers=team["manager"]["headers"])
    assert over.status_code == 402 and over.json()["error"]["code"] == "plan_limit_exceeded"
    # Parties are not catalog items.
    cat.party("Still fine")
    # Archiving frees capacity; restoring needs it again.
    client.post(url(team["org_id"], "/catalog/bulk"), json={
        "entity_type": "recording", "action": "archive", "ids": [second["id"]]}, headers=team["manager"]["headers"])
    cat.work("Three")
    restore = client.post(url(team["org_id"], "/catalog/bulk"), json={
        "entity_type": "recording", "action": "restore", "ids": [second["id"]]},
        headers=team["manager"]["headers"])
    assert restore.status_code == 402


def test_reference_data_requires_authentication(client, team):
    assert client.get("/api/v1/reference").status_code == 401
    headers = team["outsider"]["headers"]
    data = client.get("/api/v1/reference", headers=headers).json()
    assert data["territories"][0]["code"] == "WORLD"
    assert "publishing" in [c["code"] for c in data["contract_types"]]
    assert "songwriter" in [r["code"] for r in data["party_roles"]]
    assert "composer_lyricist" in [r["code"] for r in data["contributor_roles"]["work"]]
    for path in ("territories", "rights-types", "source-categories", "currencies", "party-roles",
                 "contributor-roles", "release-types", "contract-types"):
        assert client.get(f"/api/v1/reference/{path}", headers=headers).status_code == 200, path
    assert "USD" in [c["code"] for c in client.get("/api/v1/reference/currencies", headers=headers).json()]


def test_party_roles_stored_as_json(db, client, team):
    party = Catalog(client, team).party("Multi", ["artist", "producer"])
    stored = db.get(Party, party["id"])
    assert stored.roles == ["artist", "producer"]
