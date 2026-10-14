"""Statement metadata edit / processing cancel, rule-change conflict re-scan,
and catalog duplicate merging."""

from datetime import date
from decimal import Decimal as D

import pytest
from sqlalchemy import select

from app.models.catalog import Party, Recording, RecordingContributor, RecordingWork, Release, ReleaseTrack, Work
from app.models.platform import BackgroundJob
from app.models.rights import OwnershipShare, RightsConflict
from app.models.royalty import Payee, StatementLine
from tests.conftest import run_jobs


def org_url(team, path=""):
    return f"/api/v1/organizations/{team['org_id']}{path}"


def h(team, role="manager"):
    return team[role]["headers"]


CSV = b"Title,ISRC,Earnings\nSong,USAB12600001,10.00\n"


def upload(client, team, content=CSV, name="s.csv"):
    r = client.post(org_url(team, "/royalties/statements"), headers=h(team),
                    data={"source_name": "Distro", "source_category": "distributor",
                          "period_start": "2026-01-01", "period_end": "2026-01-31", "currency": "USD"},
                    files={"file": (name, content, "text/csv")})
    assert r.status_code == 201, r.text
    return r.json()


# --------------------------------------------------------------------------- statements


def test_statement_metadata_edit_rules(client, team, db):
    st = upload(client, team)
    url = org_url(team, f"/royalties/statements/{st['id']}")
    assert client.patch(url, json={"source_name": "X"}, headers=h(team, "viewer")).status_code == 403
    assert client.patch(url, json={"source_name": "X"}, headers=h(team, "outsider")).status_code == 404
    ok = client.patch(url, json={"source_name": "Distro Inc.", "currency": "EUR", "reported_total": "10.00",
                                 "notes": "Q1"}, headers=h(team))
    assert ok.status_code == 200 and ok.json()["currency"] == "EUR" and ok.json()["reported_total"] == "10.00000000"
    bad_period = client.patch(url, json={"period_end": "2025-12-01"}, headers=h(team))
    assert bad_period.status_code == 422

    client.post(f"{url}/process", headers=h(team))
    run_jobs()
    locked = client.patch(url, json={"currency": "USD"}, headers=h(team))
    assert locked.status_code == 409 and locked.json()["error"]["code"] == "currency_locked"

    # Changing a calculation input discards unposted runs.
    run = client.post(f"{url}/calculate", headers=h(team)).json()
    client.patch(url, json={"default_rights_type": "master"}, headers=h(team))
    assert client.get(org_url(team, f"/royalties/runs/{run['id']}"), headers=h(team)).json()["status"] == "discarded"
    assert client.get(url, headers=h(team)).json()["status"] == "processed"
    cleared = client.patch(url, json={"clear_default_rights_type": True, "clear_reported_total": True},
                           headers=h(team)).json()
    assert cleared["default_rights_type"] is None and cleared["reported_total"] is None


def test_statement_edit_locked_after_posting(client, team, db):
    st = upload(client, team, content=b"Title,ISRC,Earnings\nSong,USAB12600002,5\n", name="p.csv")
    url = org_url(team, f"/royalties/statements/{st['id']}")
    client.post(f"{url}/process", headers=h(team))
    run_jobs()
    run = client.post(f"{url}/calculate", headers=h(team)).json()
    assert client.post(org_url(team, f"/royalties/runs/{run['id']}/post"), headers=h(team, "admin")).status_code == 200
    r = client.patch(url, json={"notes": "late edit"}, headers=h(team))
    assert r.status_code == 409 and r.json()["error"]["code"] == "statement_posted"


def test_cancel_queued_processing(client, team, db):
    st = upload(client, team)
    url = org_url(team, f"/royalties/statements/{st['id']}")
    assert client.post(f"{url}/cancel", headers=h(team)).status_code == 409  # not queued
    client.post(f"{url}/process", headers=h(team))
    assert client.post(f"{url}/cancel", headers=h(team, "viewer")).status_code == 403
    cancelled = client.post(f"{url}/cancel", headers=h(team))
    assert cancelled.status_code == 200 and cancelled.json()["status"] == "uploaded"
    job = db.get(BackgroundJob, cancelled.json()["job_id"])
    assert job.status == "cancelled"
    run_jobs()  # cancelled job must not run
    assert client.get(url, headers=h(team)).json()["status"] == "uploaded"
    # It can be processed again afterwards.
    client.post(f"{url}/process", headers=h(team))
    run_jobs()
    assert client.get(url, headers=h(team)).json()["status"] == "processed"


# --------------------------------------------------------------------------- rights re-scan


def test_split_rule_change_queues_conflict_rescan(client, team, db):
    org = team["org_id"]
    a, b = Party(organization_id=org, name="A"), Party(organization_id=org, name="B")
    work = Work(organization_id=org, title="Rule Song")
    db.add_all([a, b, work])
    db.flush()
    for party, pct in ((a, "50"), (b, "40")):  # 90% -> under-allocated vs a 100% rule
        db.add(OwnershipShare(organization_id=org, work_id=work.id, party_id=party.id, role="writer",
                              rights_type="performance", share_percent=D(pct), territories=["WORLD"]))
    db.commit()
    rule = {"asset_type": "work", "rights_type": "performance", "expected_total": "90",
            "tolerance": "0", "enforcement": "warn"}
    created = client.post(org_url(team, "/rights/split-rules"), json=rule, headers=h(team, "admin"))
    assert created.status_code == 201, created.text
    client.patch(org_url(team, f"/rights/split-rules/{created.json()['id']}"),
                 json={"expected_total": "100"}, headers=h(team, "admin"))
    queued = db.scalars(select(BackgroundJob).where(BackgroundJob.job_type == "rights_conflict_scan",
                                                    BackgroundJob.organization_id == org)).all()
    assert len(queued) == 1  # repeated rule edits collapse into one pending scan
    run_jobs()
    db.rollback()
    db.expire_all()
    # The work also has no mechanical shares, so a missing_ownership conflict exists too.
    conflict = db.scalar(select(RightsConflict).where(RightsConflict.organization_id == org,
                                                      RightsConflict.work_id == work.id,
                                                      RightsConflict.conflict_type == "under_allocation"))
    assert conflict is not None and conflict.status == "open"


# --------------------------------------------------------------------------- merge


def merge(client, team, entity_type, survivor, duplicate, role="admin", confirm=True):
    body = {"entity_type": entity_type, "survivor_id": survivor, "duplicate_id": duplicate}
    if confirm:
        body["confirm"] = True
    return client.post(org_url(team, "/catalog/merge"), json=body, headers=h(team, role))


@pytest.fixture
def dupes(db, team):
    org = team["org_id"]
    p1 = Party(organization_id=org, name="Nova", roles=["artist"])
    p2 = Party(organization_id=org, name="NOVA", roles=["songwriter"], ipi_number="00014107338")
    w1 = Work(organization_id=org, title="Midnight Drive")
    w2 = Work(organization_id=org, title="Midnight Drive (Intro)", iswc="T0345246801", internal_code="W-9")
    r1 = Recording(organization_id=org, title="Midnight Drive", isrc="USAB12600001")
    r2 = Recording(organization_id=org, title="Midnight Drive", isrc=None)
    db.add_all([p1, p2, w1, w2, r1, r2])
    db.flush()
    db.add_all([
        RecordingContributor(organization_id=org, recording_id=r1.id, party_id=p2.id, role="main_artist"),
        RecordingContributor(organization_id=org, recording_id=r1.id, party_id=p1.id, role="main_artist"),
        RecordingWork(organization_id=org, recording_id=r2.id, work_id=w2.id),
        OwnershipShare(organization_id=org, work_id=w2.id, party_id=p2.id, role="writer",
                       rights_type="performance", share_percent=D("100"), territories=["WORLD"]),
    ])
    db.commit()
    return {"p1": p1, "p2": p2, "w1": w1, "w2": w2, "r1": r1, "r2": r2}


def test_merge_requires_admin_confirmation_and_tenant(client, team, dupes):
    assert merge(client, team, "party", dupes["p1"].id, dupes["p2"].id, role="manager").status_code == 403
    assert merge(client, team, "party", dupes["p1"].id, dupes["p2"].id, confirm=False).status_code == 422
    assert merge(client, team, "party", dupes["p1"].id, dupes["p1"].id).status_code == 422
    assert merge(client, team, "party", dupes["p1"].id, dupes["p2"].id, role="outsider").status_code == 404


def test_merge_parties_moves_references(client, team, dupes, db):
    r = merge(client, team, "party", dupes["p1"].id, dupes["p2"].id)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["moved"]["ownership_shares"] == 1
    assert "ipi_number" in body["filled_fields"] and "roles" in body["filled_fields"]
    db.rollback()
    db.expire_all()
    survivor, duplicate = db.get(Party, dupes["p1"].id), db.get(Party, dupes["p2"].id)
    assert survivor.ipi_number == "00014107338" and set(survivor.roles) == {"artist", "songwriter"}
    assert duplicate.status == "archived" and duplicate.notes.startswith("Merged into Nova")
    # The clashing duplicate contribution was dropped rather than doubled.
    contribs = db.scalars(select(RecordingContributor).where(
        RecordingContributor.recording_id == dupes["r1"].id)).all()
    assert [c.party_id for c in contribs] == [survivor.id]
    assert db.scalar(select(OwnershipShare.party_id).where(OwnershipShare.work_id == dupes["w2"].id)) == survivor.id
    assert merge(client, team, "party", dupes["p1"].id, dupes["p2"].id).status_code == 409


def test_merge_parties_with_two_payees_is_refused(client, team, dupes, db):
    org = team["org_id"]
    db.add_all([Payee(organization_id=org, party_id=dupes["p1"].id, display_name="Nova"),
                Payee(organization_id=org, party_id=dupes["p2"].id, display_name="NOVA")])
    db.commit()
    r = merge(client, team, "party", dupes["p1"].id, dupes["p2"].id)
    assert r.status_code == 409 and r.json()["error"]["code"] == "merge_payee_conflict"


def test_merge_works_fills_identifiers_and_moves_links(client, team, dupes, db):
    r = merge(client, team, "work", dupes["w1"].id, dupes["w2"].id)
    assert r.status_code == 200, r.text
    db.rollback()
    db.expire_all()
    survivor, duplicate = db.get(Work, dupes["w1"].id), db.get(Work, dupes["w2"].id)
    assert survivor.iswc == "T0345246801" and duplicate.iswc is None
    assert survivor.internal_code == "W-9" and duplicate.internal_code is None
    assert "Midnight Drive (Intro)" in survivor.alternate_titles
    link = db.scalar(select(RecordingWork).where(RecordingWork.recording_id == dupes["r2"].id))
    assert link.work_id == survivor.id
    assert db.scalar(select(OwnershipShare.work_id).where(OwnershipShare.party_id == dupes["p2"].id)) == survivor.id


def test_merge_recordings_moves_unposted_lines_only(client, team, dupes, db):
    from app.models.royalty import RoyaltyStatement

    org = team["org_id"]
    st = RoyaltyStatement(organization_id=org, source_name="S", source_category="streaming",
                          period_start=date(2026, 1, 1), period_end=date(2026, 1, 31), currency="USD",
                          status="processed")
    db.add(st)
    db.flush()
    db.add(StatementLine(organization_id=org, statement_id=st.id, row_number=2, raw={}, amount=D("1"),
                         currency="USD", match_status="matched", recording_id=dupes["r2"].id))
    release = Release(organization_id=org, title="EP", release_type="ep")
    db.add(release)
    db.flush()
    db.add(ReleaseTrack(organization_id=org, release_id=release.id, recording_id=dupes["r2"].id, track_number=1))
    db.commit()
    r = merge(client, team, "recording", dupes["r1"].id, dupes["r2"].id)
    assert r.status_code == 200, r.text
    assert r.json()["moved"]["unposted_statement_lines"] == 1 and r.json()["moved"]["release_tracks"] == 1
    db.rollback()
    db.expire_all()
    assert db.scalar(select(StatementLine.recording_id).where(StatementLine.statement_id == st.id)) == dupes["r1"].id
    assert db.scalar(select(ReleaseTrack.recording_id).where(ReleaseTrack.release_id == release.id)) == dupes["r1"].id


def test_merge_works_does_not_double_identical_shares(client, team, dupes, db):
    """Audit F-M5: the same split entered on both works must not become 200%."""
    org = team["org_id"]
    db.add(OwnershipShare(organization_id=org, work_id=dupes["w1"].id, party_id=dupes["p2"].id, role="writer",
                          rights_type="performance", share_percent=D("100"), territories=["WORLD"]))
    db.commit()
    r = merge(client, team, "work", dupes["w1"].id, dupes["w2"].id)
    assert r.status_code == 200, r.text
    assert r.json()["moved"].get("duplicate_shares_superseded") == 1
    db.rollback()
    db.expire_all()
    active = db.scalars(select(OwnershipShare).where(OwnershipShare.work_id == dupes["w1"].id,
                                                     OwnershipShare.status == "active")).all()
    assert sum(s.share_percent for s in active) == D("100")


def test_merge_refused_when_it_breaks_a_blocking_split_rule(client, team, dupes, db):
    """Audit F-M5: a merge is a share write and obeys blocking split rules."""
    org = team["org_id"]
    db.add(OwnershipShare(organization_id=org, work_id=dupes["w1"].id, party_id=dupes["p1"].id, role="writer",
                          rights_type="performance", share_percent=D("100"), territories=["WORLD"]))
    db.commit()
    rule = {"asset_type": "work", "rights_type": "performance", "expected_total": "100",
            "tolerance": "0", "enforcement": "block"}
    assert client.post(org_url(team, "/rights/split-rules"), json=rule, headers=h(team, "admin")).status_code == 201
    r = merge(client, team, "work", dupes["w1"].id, dupes["w2"].id)
    assert r.status_code == 422 and r.json()["error"]["code"] == "split_rule_violation"
    db.rollback()
    db.expire_all()
    # Nothing moved and the duplicate was not archived.
    assert db.get(Work, dupes["w2"].id).status != "archived"
    assert db.scalar(select(OwnershipShare.work_id).where(OwnershipShare.party_id == dupes["p2"].id)) == dupes["w2"].id
