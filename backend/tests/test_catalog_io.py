"""Catalog CSV/XLSX import (background job) and CSV export."""

import csv
import io

from openpyxl import Workbook
from sqlalchemy import select

from app.models.billing import Plan, Subscription
from app.models.catalog import Party, Work
from app.models.platform import BackgroundJob, Notification
from tests.conftest import run_jobs


def url(org_id: str, path: str = "") -> str:
    return f"/api/v1/organizations/{org_id}{path}"


def upload(client, team, content: bytes, entity_type: str, filename: str = "catalog.csv",
           dry_run: bool = False, as_: str = "manager"):
    return client.post(
        url(team["org_id"], "/catalog/imports"),
        files={"file": (filename, content, "text/csv")},
        data={"entity_type": entity_type, "dry_run": str(dry_run).lower()},
        headers=team[as_]["headers"],
    )


def job_status(client, team, job_id: str) -> dict:
    response = client.get(url(team["org_id"], f"/catalog/imports/{job_id}"),
                          headers=team["viewer"]["headers"])
    assert response.status_code == 200, response.text
    return response.json()


WORKS_CSV = (
    "Work Title,ISWC,Writers,Publisher,Internal Code,Year,Unknown Column\r\n"
    "Midnight River,T-034.524.680-1,Jane Writer; John Cowriter,Acme Publishing,WK-1,2021,x\r\n"
    "Bad Code,T-034.524.680-2,Jane Writer,,,,\r\n"
    ",,,,,,\r\n"
    ",T-034.524.680-1,,,,,\r\n"
    "Sunrise,,Jane Writer,,WK-2,not-a-year,\r\n"
    "Second Song,,jane writer,,WK-3,,\r\n"
    "Midnight River,T0345246801,John Cowriter,,,2021,\r\n"
).encode()


def test_work_import_end_to_end_with_row_errors(client, team, db):
    response = upload(client, team, WORKS_CSV, "work")
    assert response.status_code == 202, response.text
    job = response.json()
    assert job["status"] == "queued" and job["entity_type"] == "work" and job["deduplicated"] is False

    assert run_jobs() == 1
    done = job_status(client, team, job["id"])
    assert done["status"] == "succeeded" and done["progress"] == 100
    result = done["result"]
    assert result["created"] == 2  # Midnight River, Second Song
    assert result["skipped"] == 1  # second Midnight River row changes nothing
    assert result["updated"] == 0
    assert result["total_rows"] == 6  # blank row ignored
    assert result["parties_created"] == 3
    assert result["ignored_columns"] == ["Unknown Column"]
    errors = {e["row"]: e["message"] for e in result["errors"]}
    assert set(errors) == {3, 5, 6}
    assert "ISWC" in errors[3]
    assert "title" in errors[5]
    assert "creation_year" in errors[6]

    works = client.get(url(team["org_id"], "/works"), params={"sort": "title"},
                       headers=team["viewer"]["headers"]).json()["items"]
    assert [w["title"] for w in works] == ["Midnight River", "Second Song"]
    river = works[0]
    assert river["iswc"] == "T0345246801" and river["creation_year"] == 2021
    assert {(c["party_name"], c["role"]) for c in river["contributors"]} == {
        ("Jane Writer", "composer_lyricist"), ("John Cowriter", "composer_lyricist"),
        ("Acme Publishing", "original_publisher")}
    # Writers are matched by exact name; no duplicate "jane writer" party.
    names = sorted(db.scalars(select(Party.name).where(Party.organization_id == team["org_id"])).all())
    assert names == ["Acme Publishing", "Jane Writer", "John Cowriter"]
    publisher = db.scalar(select(Party).where(Party.name == "Acme Publishing"))
    assert publisher.party_type == "company" and publisher.roles == ["publisher"]

    note = db.scalar(select(Notification).where(Notification.user_id == team["manager"]["id"]))
    assert note.type == "import_completed" and "row error" in note.body

    # Same file again: the existing job is returned, nothing is re-imported.
    again = upload(client, team, WORKS_CSV, "work").json()
    assert again["id"] == job["id"] and again["deduplicated"] is True
    assert run_jobs() == 0
    listed = client.get(url(team["org_id"], "/catalog/imports"), headers=team["viewer"]["headers"]).json()
    assert [j["id"] for j in listed] == [job["id"]]


def test_import_updates_existing_by_identifier(client, team):
    org, manager = team["org_id"], team["manager"]["headers"]
    created = client.post(url(org, "/works"), json={"title": "Old Title", "iswc": "T-034.524.680-1"},
                          headers=manager).json()
    content = b"title,iswc,genre,writers\nNew Title,T-034.524.680-1,Jazz,Jane Writer\n"
    job = upload(client, team, content, "work").json()
    run_jobs()
    result = job_status(client, team, job["id"])["result"]
    assert (result["created"], result["updated"]) == (0, 1)
    work = client.get(url(org, f"/works/{created['id']}"), headers=manager).json()
    assert work["title"] == "New Title" and work["genre"] == "Jazz"
    assert [c["party_name"] for c in work["contributors"]] == ["Jane Writer"]
    history = client.get(url(org, f"/catalog/work/{created['id']}/activity"), headers=manager).json()
    assert "work.updated" in [i["action"] for i in history["items"]]


def test_dry_run_saves_nothing(client, team, db):
    job = upload(client, team, WORKS_CSV, "work", dry_run=True).json()
    assert job["dry_run"] is True
    run_jobs()
    result = job_status(client, team, job["id"])["result"]
    assert result["dry_run"] is True and result["created"] == 2
    assert db.scalar(select(Work.id).where(Work.organization_id == team["org_id"])) is None
    assert db.scalar(select(Party.id).where(Party.organization_id == team["org_id"])) is None
    note = db.scalar(select(Notification).where(Notification.user_id == team["manager"]["id"]))
    assert note.title == "Catalog import dry run completed"
    # A real run of the same file is a separate job.
    real = upload(client, team, WORKS_CSV, "work").json()
    assert real["id"] != job["id"]


def test_recording_import_links_works_and_artists(client, team, db):
    org, manager = team["org_id"], team["manager"]["headers"]
    client.post(url(org, "/works"), json={"title": "Midnight River", "iswc": "T-034.524.680-1"},
                headers=manager)
    content = (
        "Track Title;ISRC;Artist;Featuring;Duration;Explicit;Work ISWC;Recording Date\n"
        "Midnight River;US-RC1-76-07839;The Band;Guest Singer;3:45;yes;T-034.524.680-1;2021-05-01\n"
        "Unknown Work;USRC17607840;The Band;;200;no;T-111.111.111-1;\n"
        "Bad Duration;;The Band;;3m;no;;\n"
        "Bad ISRC;XX;The Band;;;;;\n"
    ).encode()
    job = upload(client, team, content, "recording", filename="recordings.csv").json()
    run_jobs()
    result = job_status(client, team, job["id"])["result"]
    assert result["created"] == 1, result
    assert {e["row"] for e in result["errors"]} == {3, 4, 5}
    rec = client.get(url(org, "/recordings"), headers=manager).json()["items"][0]
    assert rec["isrc"] == "USRC17607839" and rec["duration_seconds"] == 225 and rec["is_explicit"] is True
    assert rec["primary_artist_name"] == "The Band"
    assert {(c["party_name"], c["role"]) for c in rec["contributors"]} == {
        ("The Band", "main_artist"), ("Guest Singer", "featured_artist")}
    assert [w["title"] for w in rec["works"]] == ["Midnight River"]
    # Parties created only by failed rows were rolled back with them.
    assert result["parties_created"] == 2
    assert db.scalar(select(Party).where(Party.organization_id == org, Party.name == "The Band")).roles == ["artist"]


def test_xlsx_party_import(client, team):
    workbook = Workbook()
    sheet = workbook.active
    sheet.append(["Name", "Type", "Roles", "IPI", "Country", "Email"])
    sheet.append(["Jane Writer", "person", "songwriter; composer", 452210040, "us", "jane@example.com"])
    sheet.append(["Acme Publishing", "company", "publisher", None, "GB", None])
    sheet.append(["Broken", "robot", "artist", None, None, None])
    sheet.append(["Jane Writer", "person", "lyricist", "452210040", None, None])
    buffer = io.BytesIO()
    workbook.save(buffer)
    response = client.post(
        url(team["org_id"], "/catalog/imports"),
        files={"file": ("parties.xlsx", buffer.getvalue(),
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
        data={"entity_type": "party"},
        headers=team["manager"]["headers"],
    )
    assert response.status_code == 202, response.text
    run_jobs()
    result = job_status(client, team, response.json()["id"])["result"]
    assert (result["created"], result["updated"]) == (2, 1)
    assert [e["row"] for e in result["errors"]] == [4]
    parties = client.get(url(team["org_id"], "/parties"), params={"q": "Jane"},
                         headers=team["viewer"]["headers"]).json()["items"]
    assert len(parties) == 1
    assert parties[0]["ipi_number"] == "00452210040" and parties[0]["country_code"] == "US"
    assert parties[0]["roles"] == ["songwriter", "composer", "lyricist"]


def test_import_failures_and_permissions(client, team, db):
    missing_title = upload(client, team, b"iswc,writers\nT-034.524.680-1,Jane\n", "work").json()
    run_jobs()
    failed = job_status(client, team, missing_title["id"])
    assert failed["status"] == "failed" and "title" in failed["error"]
    note = db.scalar(select(Notification).where(Notification.type == "import_failed"))
    assert note is not None and note.user_id == team["manager"]["id"]

    assert upload(client, team, b"title\nX\n", "work", filename="evil.exe").status_code == 422
    assert upload(client, team, b"title\nX\n", "release").status_code == 422
    # A corrupt workbook is rejected at upload by the archive safety check (audit AF-02).
    bad_xlsx = upload(client, team, b"PK\x03\x04junk", "work", filename="x.xlsx")
    assert bad_xlsx.status_code == 422
    db.rollback()  # leave the test session's snapshot
    assert len(db.scalars(select(BackgroundJob).where(BackgroundJob.status == "failed")).all()) == 1

    assert upload(client, team, b"title\nX\n", "work", as_="viewer").status_code == 403
    response = client.post(url(team["org_id"], "/catalog/imports"),
                           files={"file": ("a.csv", b"title\nX\n", "text/csv")},
                           data={"entity_type": "work"}, headers=team["outsider"]["headers"])
    assert response.status_code == 404
    assert client.get(url(team["other_org"]["id"], f"/catalog/imports/{missing_title['id']}"),
                      headers=team["outsider"]["headers"]).status_code == 404


def test_import_respects_catalog_item_limit(client, team, db):
    plan = db.scalar(select(Plan).where(Plan.code == "test-catalog-tiny"))
    if plan is None:
        plan = Plan(code="test-catalog-tiny", name="Tiny", is_development=True, is_public=False,
                    currency="USD", sort_order=99, limits={"max_catalog_items": 2})
        db.add(plan)
        db.flush()
    sub = db.scalar(select(Subscription).where(Subscription.organization_id == team["org_id"]))
    sub.plan_id = plan.id
    db.commit()
    content = b"title\nOne\nTwo\nThree\n"
    job = upload(client, team, content, "work").json()
    run_jobs()
    result = job_status(client, team, job["id"])["result"]
    assert result["created"] == 2
    assert result["errors"] == [{"row": 4, "message": "Plan limit for catalog items reached; row not imported"}]


def test_template_and_formula_safe_export(client, team):
    org, manager, viewer = team["org_id"], team["manager"]["headers"], team["viewer"]["headers"]
    template = client.get(url(org, "/catalog/imports/template"), params={"entity_type": "recording"},
                          headers=viewer)
    assert template.status_code == 200 and template.headers["content-type"].startswith("text/csv")
    header = next(csv.reader(io.StringIO(template.text)))
    assert header[:3] == ["title", "version_title", "isrc"]
    # The work template imports cleanly (as a dry run).
    work_template = client.get(url(org, "/catalog/imports/template"), params={"entity_type": "works"},
                               headers=viewer)
    job = upload(client, team, work_template.content, "work", dry_run=True).json()
    run_jobs()
    assert job_status(client, team, job["id"])["result"]["error_count"] == 0

    writer = client.post(url(org, "/parties"), json={"name": "@SUM(A1)", "roles": ["songwriter"]},
                         headers=manager).json()
    client.post(url(org, "/works"), json={
        "title": '=HYPERLINK("http://evil.example","x")', "notes": "-2+3", "iswc": "T-034.524.680-1",
        "contributors": [{"party_id": writer["id"], "role": "composer"}]}, headers=manager)
    client.post(url(org, "/works"), json={"title": "Archived", "status": "active"}, headers=manager)
    archived_id = client.get(url(org, "/works"), params={"q": "Archived"}, headers=manager).json()["items"][0]["id"]
    client.post(url(org, "/catalog/bulk"), json={"entity_type": "work", "action": "archive",
                                                 "ids": [archived_id]}, headers=manager)

    response = client.get(url(org, "/catalog/export"), params={"entity_type": "works"}, headers=viewer)
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert 'attachment; filename="rightsflow-works-' in response.headers["content-disposition"]
    rows = list(csv.DictReader(io.StringIO(response.text)))
    assert len(rows) == 1
    assert rows[0]["title"] == '\'=HYPERLINK("http://evil.example","x")'
    assert rows[0]["notes"] == "'-2+3"
    assert rows[0]["writers"] == "'@SUM(A1)"
    assert rows[0]["iswc"] == "T-034.524.680-1"
    with_archived = client.get(url(org, "/catalog/export"),
                               params={"entity_type": "works", "include_archived": True}, headers=viewer)
    assert len(list(csv.DictReader(io.StringIO(with_archived.text)))) == 2

    for entity_type in ("recordings", "releases", "parties"):
        export = client.get(url(org, "/catalog/export"), params={"entity_type": entity_type}, headers=viewer)
        assert export.status_code == 200 and export.text.startswith("id,"), entity_type
    parties = list(csv.DictReader(io.StringIO(
        client.get(url(org, "/catalog/export"), params={"entity_type": "parties"}, headers=viewer).text)))
    assert parties[0]["name"] == "'@SUM(A1)"
    assert client.get(url(org, "/catalog/export"), params={"entity_type": "contracts"},
                      headers=viewer).status_code == 422
