from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import func, select

from app.models.catalog import Party, Recording, Work
from app.models.platform import AuditLog, Notification
from app.models.rights import OwnershipShare, RightsConflict
from app.services import rights as rights_svc


def url(org_id: str, path: str = "") -> str:
    return f"/api/v1/organizations/{org_id}/rights{path}"


@pytest.fixture
def cat(db, team):
    """Parties, a work and a recording in the team org (plus foreign ones)."""
    org_id = team["org_id"]
    other_id = team["other_org"]["id"]

    def party(name, roles, org=org_id):
        p = Party(organization_id=org, name=name, roles=roles)
        db.add(p)
        return p

    rows = {
        "writer": party("Wendy Writer", ["songwriter"]),
        "writer2": party("Walt Writer", ["songwriter"]),
        "writer3": party("Wanda Writer", ["songwriter"]),
        "publisher": party("Pub House", ["publisher"]),
        "publisher2": party("Rival Publishing", ["publisher"]),
        "subpub": party("US SubPub", ["publisher"]),
        "label": party("Big Label", ["label"]),
        "foreign_party": party("Foreign Party", ["songwriter"], org=other_id),
    }
    rows["work"] = Work(organization_id=org_id, title="Midnight Song")
    rows["work2"] = Work(organization_id=org_id, title="Second Song")
    rows["recording"] = Recording(organization_id=org_id, title="Midnight Song (Master)")
    rows["foreign_work"] = Work(organization_id=other_id, title="Not Yours")
    for value in ("work", "work2", "recording", "foreign_work"):
        db.add(rows[value])
    db.commit()
    return {key: obj.id for key, obj in rows.items()}


def mk_share(client, team, cat, as_="manager", **overrides):
    body = {
        "work_id": cat["work"],
        "party_id": cat["writer"],
        "role": "writer",
        "rights_type": "performance",
        "share_percent": "50",
    }
    body.update(overrides)
    if "recording_id" in overrides:
        body.pop("work_id", None)
    return client.post(url(team["org_id"], "/shares"), json=body, headers=team[as_]["headers"])


def ok_share(client, team, cat, **overrides) -> dict:
    response = mk_share(client, team, cat, **overrides)
    assert response.status_code == 201, response.text
    return response.json()


def issues_of(payload, rights_type="performance", type_=None):
    return [
        i for i in payload["validation"]["issues"]
        if i["rights_type"] == rights_type and (type_ is None or i["type"] == type_)
    ]


def conflicts(client, team, **params):
    response = client.get(url(team["org_id"], "/conflicts"), params={"page_size": 200, **params},
                          headers=team["viewer"]["headers"])
    assert response.status_code == 200, response.text
    return response.json()["items"]


def make_rule(client, team, **body):
    payload = {"asset_type": "work", "rights_type": "performance", **body}
    response = client.post(url(team["org_id"], "/split-rules"), json=payload, headers=team["admin"]["headers"])
    assert response.status_code == 201, response.text
    return response.json()


# --------------------------------------------------------------------------- pure analysis


def _view(id_, pct, territories=("WORLD",), excluded=(), start=None, end=None, party=None, role="writer"):
    return rights_svc.ShareView(
        id=id_, party_id=party or id_, party_name=f"Party {id_}", party_status="active", role=role,
        rights_type="performance", share_percent=Decimal(pct), territories=list(territories),
        excluded=list(excluded), effective_from=start, effective_to=end, is_controlled=True,
    )


def test_analyzer_reports_compact_territories_and_segments():
    rules = rights_svc.RuleBook()
    shares = [
        _view("a", "50"),
        _view("b", "50", excluded=["US"], role="publisher"),
        _view("c", "30", territories=["US"], role="sub_publisher"),
    ]
    analysis = rights_svc.analyze("work", "work:x", shares, rules)
    totals = {t["territory_label"]: t for t in analysis.totals}
    assert set(totals) == {"US", "WORLD excluding US"}
    assert totals["WORLD excluding US"]["total"] == Decimal("100")
    assert totals["US"]["total"] == Decimal("80")
    [under] = [f for f in analysis.findings if f.type == "under_allocation"]
    assert under.details["territories"] == ["US"] and under.blocking is False
    assert "80%" in under.explanation and "Party c" in under.explanation

    # All-world equal totals are reported as WORLD; non-overlapping periods don't add up.
    timeline = [
        _view("old", "100", start=date(2020, 1, 1), end=date(2021, 12, 31)),
        _view("new", "100", start=date(2022, 1, 1)),
    ]
    analysis = rights_svc.analyze("work", "work:y", timeline, rules)
    assert [f.type for f in analysis.findings] == []
    assert {(t["effective_from"], t["effective_to"], t["territory_label"]) for t in analysis.totals} == {
        (date(2020, 1, 1), date(2021, 12, 31), "WORLD"),
        (date(2022, 1, 1), None, "WORLD"),
    }


# --------------------------------------------------------------------------- shares & totals


def test_valid_split_writer_and_publisher_total_100(client, team, cat):
    first = ok_share(client, team, cat)
    assert first["share"]["share_percent"] == "50.000000"
    assert first["share"]["asset_type"] == "work"
    under = issues_of(first, type_="under_allocation")
    assert len(under) == 1 and under[0]["blocking"] is False
    assert under[0]["details"]["total"] == "50.000000"

    second = ok_share(client, team, cat, party_id=cat["publisher"], role="publisher")
    assert issues_of(second) == []
    [total] = [t for t in second["validation"]["totals"] if t["rights_type"] == "performance"]
    assert total["territories"] == ["WORLD"] and total["total"] == "100.000000" and total["status"] == "ok"

    # The earlier under-allocation conflict is kept (never auto-resolved) but flagged.
    [old] = conflicts(client, team, type="under_allocation")
    assert old["status"] == "open" and old["still_detected"] is False

    ownership = client.get(
        url(team["org_id"], f"/assets/work/{cat['work']}/ownership"), headers=team["viewer"]["headers"]
    ).json()
    perf = next(r for r in ownership["rights"] if r["rights_type"] == "performance")
    assert perf["total"] == "100.000000" and perf["controlled_percent"] == "100.000000"
    assert len(perf["shares"]) == 2 and perf["issues"] == []
    mech = next(r for r in ownership["rights"] if r["rights_type"] == "mechanical")
    assert [i["type"] for i in mech["issues"]] == ["missing_ownership"]


def test_over_allocation_creates_critical_conflict_and_notifies(client, team, cat, db):
    ok_share(client, team, cat, share_percent="60")
    result = ok_share(client, team, cat, party_id=cat["publisher"], role="publisher")
    [over] = issues_of(result, type_="over_allocation")
    assert over["severity"] == "critical" and over["blocking"] is False
    assert "110%" in over["message"] and "Wendy Writer" in over["message"] and "Pub House" in over["message"]

    [conflict] = conflicts(client, team, type="over_allocation")
    assert conflict["severity"] == "critical" and conflict["status"] == "open"
    assert conflict["still_detected"] is True
    assert conflict["details"]["total"] == "110.000000" and conflict["details"]["excluded_territories"] == []
    notes = db.scalars(select(Notification).where(Notification.type == "rights_conflict")).all()
    recipients = {n.user_id for n in notes}
    assert team["manager"]["id"] in recipients and team["viewer"]["id"] not in recipients


def test_under_allocation_can_be_allowed_by_rule(client, team, cat):
    make_rule(client, team, allow_under_allocation=True)
    result = ok_share(client, team, cat)
    assert issues_of(result) == []
    [total] = [t for t in result["validation"]["totals"] if t["rights_type"] == "performance"]
    assert total["status"] == "under_allowed"
    # Rule applies to performance only: mechanical stays strict.
    mech = ok_share(client, team, cat, rights_type="mechanical")
    assert issues_of(mech, "mechanical", "under_allocation")


def test_territory_carve_out_and_territory_specific_block_rule(client, team, cat):
    org = team["org_id"]
    splits_url = url(org, f"/assets/work/{cat['work']}/splits")
    carve_out = {
        "rights_type": "performance",
        "shares": [
            {"party_id": cat["writer"], "role": "writer", "share_percent": "50"},
            {"party_id": cat["publisher"], "role": "publisher", "share_percent": "50",
             "excluded_territories": ["US"]},
            {"party_id": cat["subpub"], "role": "sub_publisher", "share_percent": "30",
             "territories": ["us"]},
        ],
    }
    # Default rule: warn only.
    response = client.put(splits_url, json=carve_out, headers=team["manager"]["headers"])
    assert response.status_code == 200, response.text
    body = response.json()
    [under] = issues_of(body, type_="under_allocation")
    assert under["details"]["territories"] == ["US"] and under["details"]["total"] == "80.000000"
    totals = {t["territory_label"]: t for t in body["validation"]["totals"]}
    assert totals["WORLD excluding US"]["total"] == "100.000000"
    assert totals["WORLD excluding US"]["status"] == "ok"
    assert totals["US"]["status"] == "under"

    # A US-specific blocking rule rejects the same carve-out as a whole.
    make_rule(client, team, territory="US", enforcement="block")
    response = client.put(splits_url, json=carve_out, headers=team["manager"]["headers"])
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "split_rule_violation"
    assert "US" in error["message"] and "80%" in error["message"]

    carve_out["shares"][2]["share_percent"] = "50"
    response = client.put(splits_url, json=carve_out, headers=team["manager"]["headers"])
    assert response.status_code == 200, response.text
    assert issues_of(response.json()) == []
    assert response.json()["superseded"] == 3

    for code, expected in (("US", "100.000000"), ("GB", "100.000000")):
        own = client.get(url(org, f"/assets/work/{cat['work']}/ownership"), params={"territory": code},
                         headers=team["viewer"]["headers"]).json()
        perf = next(r for r in own["rights"] if r["rights_type"] == "performance")
        assert perf["total"] == expected, code
    us = client.get(url(org, f"/assets/work/{cat['work']}/ownership"), params={"territory": "US"},
                    headers=team["viewer"]["headers"]).json()
    perf = next(r for r in us["rights"] if r["rights_type"] == "performance")
    assert {s["party_name"] for s in perf["shares"]} == {"Wendy Writer", "US SubPub"}
    assert client.get(url(org, f"/assets/work/{cat['work']}/ownership"), params={"territory": "XX"},
                      headers=team["viewer"]["headers"]).status_code == 422


def test_effective_date_segmentation(client, team, cat):
    ok_share(client, team, cat, share_percent="100", effective_from="2020-01-01", effective_to="2021-12-31")
    result = ok_share(client, team, cat, party_id=cat["writer2"], share_percent="100",
                      effective_from="2022-01-01")
    assert issues_of(result) == []  # successive owners never add up

    result = ok_share(client, team, cat, party_id=cat["writer3"], share_percent="50",
                      effective_from="2021-07-01", effective_to="2022-06-30")
    overs = issues_of(result, type_="over_allocation")
    periods = sorted((o["details"]["effective_from"], o["details"]["effective_to"]) for o in overs)
    assert periods == [("2021-07-01", "2021-12-31"), ("2022-01-01", "2022-06-30")]
    assert all(o["details"]["total"] == "150.000000" for o in overs)

    def perf_total(day):
        own = client.get(url(team["org_id"], f"/assets/work/{cat['work']}/ownership"),
                         params={"on_date": day}, headers=team["viewer"]["headers"]).json()
        return next(r for r in own["rights"] if r["rights_type"] == "performance")

    assert perf_total("2021-01-15")["total"] == "100.000000"
    summer = perf_total("2021-08-01")
    assert summer["total"] == "150.000000" and summer["issues"][0]["type"] == "over_allocation"
    assert perf_total("2023-01-01")["total"] == "100.000000"
    assert perf_total("2023-01-01")["issues"] == []
    # Invalid date range on input.
    bad = mk_share(client, team, cat, effective_from="2022-01-01", effective_to="2021-01-01")
    assert bad.status_code == 422


def test_block_versus_warn_rules(client, team, cat, db):
    # Warn (default): over-allocation is accepted with a warning.
    ok_share(client, team, cat, work_id=cat["work2"], share_percent="70")
    warned = ok_share(client, team, cat, work_id=cat["work2"], party_id=cat["publisher"],
                      role="publisher", share_percent="40")
    assert issues_of(warned, type_="over_allocation")[0]["blocking"] is False

    rule = make_rule(client, team, enforcement="block", allow_under_allocation=True)
    assert rule["expected_total"] == "100.000000" and rule["tolerance"] == "0.010000"
    ok_share(client, team, cat, share_percent="60")
    blocked = mk_share(client, team, cat, party_id=cat["publisher"], role="publisher")
    assert blocked.status_code == 422
    assert blocked.json()["error"]["code"] == "split_rule_violation"
    assert blocked.json()["error"]["details"]["issues"][0]["type"] == "over_allocation"
    count = db.scalar(select(func.count()).select_from(OwnershipShare).where(
        OwnershipShare.work_id == cat["work"], OwnershipShare.status == "active"))
    assert count == 1
    # Within the rule it's fine.
    ok_share(client, team, cat, party_id=cat["publisher"], role="publisher", share_percent="40")

    # The pre-existing violation on work2 can be repaired step by step, but not worsened.
    share_id = warned["share"]["id"]
    worse = client.patch(url(team["org_id"], f"/shares/{share_id}"), json={"share_percent": "45"},
                         headers=team["manager"]["headers"])
    assert worse.status_code == 422
    better = client.patch(url(team["org_id"], f"/shares/{share_id}"), json={"share_percent": "30"},
                          headers=team["manager"]["headers"])
    assert better.status_code == 200 and issues_of(better.json()) == []


def test_duplicate_entries(client, team, cat):
    ok_share(client, team, cat, share_percent="25")
    result = ok_share(client, team, cat, share_percent="25")
    [dup] = issues_of(result, type_="duplicate_entry")
    assert dup["severity"] == "medium" and len(dup["share_ids"]) == 2
    assert issues_of(result, type_="overlapping_claims") == []
    [conflict] = conflicts(client, team, type="duplicate_entry")
    assert "Wendy Writer" in conflict["explanation"]


def test_overlapping_claims(client, team, cat):
    # The same party twice with overlapping scope (US is in both).
    ok_share(client, team, cat, share_percent="30")
    result = ok_share(client, team, cat, share_percent="20", territories=["US", "CA"])
    [overlap] = issues_of(result, type_="overlapping_claims")
    assert overlap["details"]["same_party"] is True
    assert overlap["details"]["territories"] == ["CA", "US"]
    assert overlap["severity"] == "high"

    # Two different publishers claiming the same role beyond 100%.
    ok_share(client, team, cat, work_id=cat["work2"], party_id=cat["publisher"], role="publisher",
             share_percent="60")
    result = ok_share(client, team, cat, work_id=cat["work2"], party_id=cat["publisher2"],
                      role="publisher", share_percent="60")
    [overlap] = issues_of(result, type_="overlapping_claims")
    assert overlap["details"]["same_party"] is False and overlap["details"]["combined_percent"] == "120.000000"
    assert "Pub House" in overlap["message"] and "Rival Publishing" in overlap["message"]
    assert issues_of(result, type_="over_allocation")[0]["severity"] == "critical"

    # Successive periods are not overlapping claims.
    ok_share(client, team, cat, rights_type="mechanical", party_id=cat["publisher"], role="publisher",
             share_percent="100", effective_to="2020-12-31")
    result = ok_share(client, team, cat, rights_type="mechanical", party_id=cat["publisher2"],
                      role="publisher", share_percent="100", effective_from="2021-01-01")
    assert issues_of(result, "mechanical") == []


def test_missing_ownership_and_summary(client, team, cat):
    scan = client.post(url(team["org_id"], "/conflicts/scan"), headers=team["manager"]["headers"])
    assert scan.status_code == 200, scan.text
    body = scan.json()
    assert body["by_type"] == {"missing_ownership": 5}  # 2 works × 2 + recording master
    assert body["new"] == 5 and body["scanned_assets"] == 3

    missing = conflicts(client, team, type="missing_ownership", recording_id=cat["recording"])
    assert [c["rights_type"] for c in missing] == ["master"]

    summary = client.get(url(team["org_id"], "/summary"), headers=team["viewer"]["headers"]).json()
    assert summary["assets_missing_ownership"] == 3
    assert summary["unresolved_conflicts_by_severity"]["medium"] == 5

    for rights_type in ("performance", "mechanical"):
        ok_share(client, team, cat, rights_type=rights_type, share_percent="100")
    ok_share(client, team, cat, recording_id=cat["recording"], party_id=cat["label"], role="label",
             rights_type="master", share_percent="100")
    summary = client.get(url(team["org_id"], "/summary"), headers=team["viewer"]["headers"]).json()
    assert summary["works_missing_ownership"] == 1  # work2
    assert summary["recordings_missing_ownership"] == 0
    assert summary["active_shares"] == 3 and summary["verified_percent"] == "0.00"
    # Fixed conflicts stay open until a human acts.
    rescan = client.post(url(team["org_id"], "/conflicts/scan"), headers=team["manager"]["headers"]).json()
    assert rescan["detected"] == 2 and rescan["new"] == 0
    stale = [c for c in conflicts(client, team, type="missing_ownership") if not c["still_detected"]]
    assert len(stale) == 3 and all(c["status"] == "open" for c in stale)


def test_rights_type_must_match_asset(client, team, cat):
    assert mk_share(client, team, cat, rights_type="master").status_code == 422
    assert mk_share(client, team, cat, recording_id=cat["recording"], rights_type="performance").status_code == 422
    response = mk_share(client, team, cat, recording_id=cat["recording"], party_id=cat["label"],
                        role="label", rights_type="sync", share_percent="100")
    assert response.status_code == 201
    assert response.json()["share"]["asset_type"] == "recording"
    # Exactly one asset.
    both = mk_share(client, team, cat, recording_id=cat["recording"], work_id=cat["work"])
    assert both.status_code == 422
    assert mk_share(client, team, cat, rights_type="lyrics").status_code == 422
    assert mk_share(client, team, cat, territories=["ZZ"]).status_code == 422
    assert mk_share(client, team, cat, territories=[]).status_code == 422


def test_decimal_precision(client, team, cat):
    make_rule(client, team, tolerance="0")
    for key in ("writer", "writer2", "writer3"):
        result = ok_share(client, team, cat, party_id=cat[key], share_percent="33.333333")
    [under] = issues_of(result, type_="under_allocation")
    assert under["details"]["total"] == "99.999999"
    result = ok_share(client, team, cat, party_id=cat["publisher"], role="publisher", share_percent="0.000001")
    assert issues_of(result) == []
    [total] = [t for t in result["validation"]["totals"] if t["rights_type"] == "performance"]
    assert total["total"] == "100.000000"
    assert result["share"]["share_percent"] == "0.000001"

    for bad in ("10.1234567", "0", "-5", "100.000001", "abc"):
        assert mk_share(client, team, cat, share_percent=bad).status_code == 422, bad


def test_conflict_lifecycle_never_auto_resolves(client, team, cat):
    writer = ok_share(client, team, cat, share_percent="60")
    ok_share(client, team, cat, party_id=cat["publisher"], role="publisher")
    [conflict] = conflicts(client, team, type="over_allocation")
    cid = conflict["id"]
    base = url(team["org_id"], f"/conflicts/{cid}")

    # Fix the data: the conflict stays open, flagged as no longer detected.
    fixed = client.patch(url(team["org_id"], f"/shares/{writer['share']['id']}"),
                         json={"share_percent": "50"}, headers=team["manager"]["headers"])
    assert fixed.status_code == 200 and issues_of(fixed.json()) == []
    current = client.get(base, headers=team["viewer"]["headers"]).json()
    assert current["status"] == "open" and current["still_detected"] is False
    scan = client.post(url(team["org_id"], "/conflicts/scan"),
                       json={"asset_type": "work", "asset_id": cat["work"]},
                       headers=team["manager"]["headers"]).json()
    assert scan["scanned_assets"] == 1
    assert client.get(base, headers=team["viewer"]["headers"]).json()["status"] == "open"

    # Human review: viewer cannot, notes are required.
    assert client.post(f"{base}/resolve", json={"notes": "ok"}, headers=team["viewer"]["headers"]).status_code == 403
    assert client.post(f"{base}/acknowledge", headers=team["manager"]["headers"]).json()["status"] == "acknowledged"
    assert client.post(f"{base}/resolve", json={"notes": "  "}, headers=team["manager"]["headers"]).status_code == 422
    assert client.post(f"{base}/resolve", headers=team["manager"]["headers"]).status_code == 422
    resolved = client.post(f"{base}/resolve", json={"notes": "Writer share corrected per contract"},
                           headers=team["manager"]["headers"])
    assert resolved.status_code == 200
    resolved = resolved.json()
    assert resolved["status"] == "resolved" and resolved["resolved_by_id"] == team["manager"]["id"]
    assert resolved["resolution_notes"] == "Writer share corrected per contract"
    assert client.post(f"{base}/resolve", json={"notes": "again"}, headers=team["manager"]["headers"]).status_code == 409

    # Re-breaking the data re-detects the same conflict but never changes its status.
    client.patch(url(team["org_id"], f"/shares/{writer['share']['id']}"),
                 json={"share_percent": "60"}, headers=team["manager"]["headers"])
    current = client.get(base, headers=team["viewer"]["headers"]).json()
    assert current["status"] == "resolved" and current["still_detected"] is True
    assert current["details"]["total"] == "110.000000"

    assert client.post(f"{base}/reopen", headers=team["manager"]["headers"]).json()["status"] == "open"
    assert client.post(f"{base}/dismiss", json={}, headers=team["manager"]["headers"]).status_code == 422
    dismissed = client.post(f"{base}/dismiss", json={"notes": "Known catalogue quirk"},
                            headers=team["manager"]["headers"]).json()
    assert dismissed["status"] == "dismissed"
    assert client.post(f"{base}/explode", headers=team["manager"]["headers"]).status_code == 422
    filtered = conflicts(client, team, status="dismissed")
    assert [c["id"] for c in filtered] == [cid]


def test_verify_and_supersede_flow(client, team, cat, db):
    created = ok_share(client, team, cat, share_percent="50")
    share_id = created["share"]["id"]
    share_url = url(team["org_id"], f"/shares/{share_id}")
    assert client.post(f"{share_url}/verify", headers=team["viewer"]["headers"]).status_code == 403
    verified = client.post(f"{share_url}/verify", json={"notes": "checked"}, headers=team["manager"]["headers"])
    assert verified.status_code == 200
    data = verified.json()["share"]
    assert data["verification_status"] == "verified" and data["verified_by_id"] == team["manager"]["id"]
    assert data["verified_at"] is not None

    locked = client.patch(share_url, json={"share_percent": "40"}, headers=team["manager"]["headers"])
    assert locked.status_code == 409 and locked.json()["error"]["code"] == "share_verified"
    assert client.patch(share_url, json={"territories": ["US"]}, headers=team["manager"]["headers"]).status_code == 409
    notes = client.patch(share_url, json={"notes": "Per 2019 agreement"}, headers=team["manager"]["headers"])
    assert notes.status_code == 200 and notes.json()["share"]["notes"] == "Per 2019 agreement"

    superseded = client.post(f"{share_url}/supersede", json={"share_percent": "40", "reason": "Amendment"},
                             headers=team["manager"]["headers"])
    assert superseded.status_code == 201, superseded.text
    new = superseded.json()["share"]
    assert new["supersedes_id"] == share_id and new["share_percent"] == "40.000000"
    assert new["verification_status"] == "unverified" and new["status"] == "active"
    assert new["notes"] == "Per 2019 agreement"
    old = client.get(share_url, headers=team["viewer"]["headers"]).json()
    assert old["status"] == "superseded"
    assert client.post(f"{share_url}/supersede", json={}, headers=team["manager"]["headers"]).status_code == 409
    assert client.patch(share_url, json={"notes": "x"}, headers=team["manager"]["headers"]).status_code == 409

    history = client.get(url(team["org_id"], f"/assets/work/{cat['work']}/history"),
                         params={"page_size": 50}, headers=team["viewer"]["headers"]).json()
    actions = {item["action"] for item in history["items"]}
    assert {"ownership_share.created", "ownership_share.verified", "ownership_share.updated",
            "ownership_share.superseded"} <= actions
    assert {item["entity_id"] for item in history["items"]} == {share_id, new["id"]}

    archived = client.delete(url(team["org_id"], f"/shares/{new['id']}"), headers=team["manager"]["headers"])
    assert archived.status_code == 200 and archived.json()["share"]["status"] == "archived"
    assert db.get(OwnershipShare, new["id"]) is not None  # never hard-deleted
    assert client.delete(url(team["org_id"], f"/shares/{new['id']}"), headers=team["manager"]["headers"]).status_code == 409


def test_dispute_generates_conflict(client, team, cat):
    created = ok_share(client, team, cat, share_percent="100")
    share_url = url(team["org_id"], f"/shares/{created['share']['id']}")
    assert client.post(f"{share_url}/dispute", json={"reason": ""}, headers=team["manager"]["headers"]).status_code == 422
    disputed = client.post(f"{share_url}/dispute", json={"reason": "Co-writer claims 50%"},
                           headers=team["manager"]["headers"])
    assert disputed.status_code == 200
    body = disputed.json()
    assert body["share"]["status"] == "disputed" and body["share"]["verification_status"] == "disputed"
    [invalid] = issues_of(body, type_="invalid_metadata")
    assert invalid["details"]["problems"] == ["disputed"] and invalid["severity"] == "medium"
    assert conflicts(client, team, type="invalid_metadata")[0]["status"] == "open"
    reverified = client.post(f"{share_url}/verify", headers=team["manager"]["headers"]).json()
    assert reverified["share"]["status"] == "active"


def test_archived_party_is_invalid_metadata(client, team, cat, db):
    ok_share(client, team, cat, share_percent="100")
    party = db.get(Party, cat["writer"])
    party.status = "archived"
    db.commit()
    client.post(url(team["org_id"], "/conflicts/scan"), headers=team["manager"]["headers"])
    [invalid] = conflicts(client, team, type="invalid_metadata")
    assert invalid["details"]["problems"] == ["party_archived"]
    assert "archived" in invalid["explanation"]
    response = mk_share(client, team, cat, rights_type="mechanical")
    assert response.status_code == 422 and response.json()["error"]["code"] == "party_archived"


def test_replace_splits_supersedes_and_archives(client, team, cat, db):
    first = ok_share(client, team, cat, share_percent="50")
    second = ok_share(client, team, cat, party_id=cat["publisher"], role="publisher")
    response = client.put(
        url(team["org_id"], f"/assets/work/{cat['work']}/splits"),
        json={"rights_type": "performance", "reason": "New co-writer", "shares": [
            {"party_id": cat["writer"], "role": "writer", "share_percent": "25"},
            {"party_id": cat["writer2"], "role": "writer", "share_percent": "25"},
            {"party_id": cat["publisher2"], "role": "publisher", "share_percent": "50"},
        ]},
        headers=team["manager"]["headers"],
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["superseded"] == 1 and body["archived"] == 1 and len(body["shares"]) == 3
    assert issues_of(body) == []
    by_party = {s["party_id"]: s for s in body["shares"]}
    assert by_party[cat["writer"]]["supersedes_id"] == first["share"]["id"]
    assert db.get(OwnershipShare, first["share"]["id"]).status == "superseded"
    assert db.get(OwnershipShare, second["share"]["id"]).status == "archived"

    bad = client.put(url(team["org_id"], f"/assets/work/{cat['work']}/splits"),
                     json={"rights_type": "master", "shares": []}, headers=team["manager"]["headers"])
    assert bad.status_code == 422
    assert client.put(url(team["org_id"], f"/assets/recording/{cat['work']}/splits"),
                      json={"rights_type": "master", "shares": []},
                      headers=team["manager"]["headers"]).status_code == 404


def test_validate_is_a_dry_run(client, team, cat, db):
    payload = {
        "asset_type": "work",
        "asset_id": cat["work"],
        "shares": [
            {"party_id": cat["writer"], "role": "writer", "rights_type": "performance", "share_percent": "60"},
            {"party_id": cat["publisher"], "role": "publisher", "rights_type": "performance", "share_percent": "50"},
        ],
    }
    response = client.post(url(team["org_id"], "/validate"), json=payload, headers=team["viewer"]["headers"])
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["valid"] is False and body["blocked"] is False
    assert [i["type"] for i in body["issues"]] == ["over_allocation"]
    assert db.scalar(select(func.count()).select_from(OwnershipShare)) == 0
    assert db.scalar(select(func.count()).select_from(RightsConflict)) == 0

    make_rule(client, team, enforcement="block")
    body = client.post(url(team["org_id"], "/validate"), json=payload, headers=team["viewer"]["headers"]).json()
    assert body["blocked"] is True

    payload["shares"][0]["share_percent"] = "50"
    body = client.post(url(team["org_id"], "/validate"), json=payload, headers=team["viewer"]["headers"]).json()
    assert body["valid"] is True and body["issues"] == []

    # Rights type / asset mismatch.
    payload["shares"][0]["rights_type"] = "master"
    assert client.post(url(team["org_id"], "/validate"), json=payload,
                       headers=team["viewer"]["headers"]).status_code == 422


def test_validate_include_existing(client, team, cat):
    ok_share(client, team, cat, share_percent="50")
    payload = {
        "asset_type": "work", "asset_id": cat["work"], "include_existing": True,
        "shares": [{"party_id": cat["publisher"], "role": "publisher", "rights_type": "performance",
                    "share_percent": "60"}],
    }
    body = client.post(url(team["org_id"], "/validate"), json=payload, headers=team["viewer"]["headers"]).json()
    [issue] = body["issues"]
    assert issue["type"] == "over_allocation" and issue["details"]["total"] == "110.000000"


def test_share_list_filters(client, team, cat):
    ok_share(client, team, cat, share_percent="50")
    ok_share(client, team, cat, party_id=cat["publisher"], role="publisher", excluded_territories=["US"])
    ok_share(client, team, cat, party_id=cat["subpub"], role="sub_publisher", territories=["US"])
    ok_share(client, team, cat, rights_type="mechanical", share_percent="100")

    def ids(**params):
        response = client.get(url(team["org_id"], "/shares"), params=params, headers=team["viewer"]["headers"])
        assert response.status_code == 200, response.text
        return {s["party_name"] for s in response.json()["items"]}, response.json()["total"]

    assert ids(territory="US") == ({"Wendy Writer", "US SubPub"}, 3)
    assert ids(territory="GB", rights_type="performance") == ({"Wendy Writer", "Pub House"}, 2)
    assert ids(party_id=cat["subpub"]) == ({"US SubPub"}, 1)
    assert ids(work_id=cat["work"], page_size=2)[1] == 4
    assert ids(status="archived")[1] == 0
    assert ids(verification_status="unverified")[1] == 4
    assert client.get(url(team["org_id"], "/shares"), params={"status": "bogus"},
                      headers=team["viewer"]["headers"]).status_code == 422


# --------------------------------------------------------------------------- rules & sheets


def test_split_rule_crud_and_permissions(client, team):
    org = team["org_id"]
    body = {"asset_type": "work", "rights_type": "performance", "territory": "uk", "enforcement": "block"}
    for role in ("viewer", "manager"):
        assert client.post(url(org, "/split-rules"), json=body, headers=team[role]["headers"]).status_code == 403
    rule = make_rule(client, team, territory="uk", enforcement="block")
    assert rule["territory"] == "GB"
    assert client.post(url(org, "/split-rules"), json=body, headers=team["admin"]["headers"]).status_code == 409
    make_rule(client, team)
    generic_dup = client.post(url(org, "/split-rules"), json={"asset_type": "work", "rights_type": "performance"},
                              headers=team["admin"]["headers"])
    assert generic_dup.status_code == 409
    mismatch = {"asset_type": "recording", "rights_type": "performance"}
    assert client.post(url(org, "/split-rules"), json=mismatch, headers=team["admin"]["headers"]).status_code == 422
    listed = client.get(url(org, "/split-rules"), headers=team["viewer"]["headers"]).json()
    assert len(listed) == 2
    updated = client.patch(url(org, f"/split-rules/{rule['id']}"), json={"tolerance": "0.5"},
                           headers=team["admin"]["headers"])
    assert updated.json()["tolerance"] == "0.500000"
    assert client.patch(url(org, f"/split-rules/{rule['id']}"), json={"tolerance": "1"},
                        headers=team["manager"]["headers"]).status_code == 403
    assert client.delete(url(org, f"/split-rules/{rule['id']}"), headers=team["manager"]["headers"]).status_code == 403
    assert client.delete(url(org, f"/split-rules/{rule['id']}"), headers=team["admin"]["headers"]).status_code == 200
    assert client.get(url(org, f"/split-rules/{rule['id']}"), headers=team["viewer"]["headers"]).status_code == 404


def test_split_sheet_crud_and_apply(client, team, cat, db):
    org = team["org_id"]
    sheet_body = {
        "work_id": cat["work"],
        "title": "Midnight Song split sheet",
        "agreed_date": "2024-03-01",
        "entries": [
            {"party_id": cat["writer"], "role": "writer", "share_percent": "50"},
            {"party_id": cat["writer2"], "role": "writer", "share_percent": "50"},
        ],
    }
    assert client.post(url(org, "/split-sheets"), json=sheet_body, headers=team["viewer"]["headers"]).status_code == 403
    over = {**sheet_body, "entries": [{**e, "share_percent": "60"} for e in sheet_body["entries"]]}
    assert client.post(url(org, "/split-sheets"), json=over, headers=team["manager"]["headers"]).status_code == 422
    dup = {**sheet_body, "entries": [sheet_body["entries"][0], sheet_body["entries"][0]]}
    assert client.post(url(org, "/split-sheets"), json=dup, headers=team["manager"]["headers"]).status_code == 422

    created = client.post(url(org, "/split-sheets"), json=sheet_body, headers=team["manager"]["headers"])
    assert created.status_code == 201, created.text
    sheet = created.json()
    assert sheet["entries_total"] == "100.000000" and sheet["entries"][0]["party_name"] == "Wendy Writer"
    assert sheet["work_title"] == "Midnight Song"

    applied = client.post(url(org, f"/split-sheets/{sheet['id']}/apply"),
                          json={"rights_types": ["performance", "mechanical"], "effective_from": "2024-03-01"},
                          headers=team["manager"]["headers"])
    assert applied.status_code == 200, applied.text
    body = applied.json()
    assert len(body["shares"]) == 4
    assert {s["source"] for s in body["shares"]} == {"split_sheet"}
    assert {s["split_sheet_id"] for s in body["shares"]} == {sheet["id"]}
    assert body["validation"]["issues"] == []

    patched = client.patch(url(org, f"/split-sheets/{sheet['id']}"), json={
        "status": "signed",
        "entries": [
            {"party_id": cat["writer"], "role": "writer", "share_percent": "60"},
            {"party_id": cat["writer2"], "role": "writer", "share_percent": "40"},
        ],
    }, headers=team["manager"]["headers"])
    assert patched.status_code == 200 and patched.json()["status"] == "signed"
    replaced = client.post(url(org, f"/split-sheets/{sheet['id']}/apply"),
                           json={"rights_types": ["performance"], "mode": "replace",
                                 "effective_from": "2024-03-01", "controlled_party_ids": [cat["writer"]]},
                           headers=team["manager"]["headers"]).json()
    assert replaced["superseded"] == 2 and replaced["archived"] == 0
    controlled = {s["party_id"]: s["is_controlled"] for s in replaced["shares"]}
    assert controlled == {cat["writer"]: True, cat["writer2"]: False}

    listed = client.get(url(org, "/split-sheets"), params={"work_id": cat["work"]},
                        headers=team["viewer"]["headers"]).json()
    assert listed["total"] == 1

    client.patch(url(org, f"/split-sheets/{sheet['id']}"), json={"status": "disputed"},
                 headers=team["manager"]["headers"])
    assert client.post(url(org, f"/split-sheets/{sheet['id']}/apply"), json={"rights_types": ["performance"]},
                       headers=team["manager"]["headers"]).status_code == 409
    assert client.post(url(org, f"/split-sheets/{sheet['id']}/apply"), json={"rights_types": ["master"]},
                       headers=team["manager"]["headers"]).status_code == 422
    assert client.delete(url(org, f"/split-sheets/{sheet['id']}"), headers=team["manager"]["headers"]).status_code == 200
    # Shares created from the sheet survive its deletion.
    assert db.scalar(select(func.count()).select_from(OwnershipShare).where(OwnershipShare.source == "split_sheet")) == 6
    assert db.scalar(select(func.count()).select_from(AuditLog).where(AuditLog.entity_type == "split_sheet")) >= 4


# --------------------------------------------------------------------------- RBAC & isolation


def test_rbac_viewer_cannot_write(client, team, cat):
    assert mk_share(client, team, cat, as_="viewer").status_code == 403
    share = ok_share(client, team, cat)
    sid = share["share"]["id"]
    viewer = team["viewer"]["headers"]
    org = team["org_id"]
    assert client.get(url(org, f"/shares/{sid}"), headers=viewer).status_code == 200
    assert client.patch(url(org, f"/shares/{sid}"), json={"notes": "x"}, headers=viewer).status_code == 403
    assert client.delete(url(org, f"/shares/{sid}"), headers=viewer).status_code == 403
    assert client.post(url(org, f"/shares/{sid}/dispute"), json={"reason": "x"}, headers=viewer).status_code == 403
    assert client.post(url(org, f"/shares/{sid}/supersede"), json={}, headers=viewer).status_code == 403
    assert client.put(url(org, f"/assets/work/{cat['work']}/splits"), json={"rights_type": "performance", "shares": []},
                      headers=viewer).status_code == 403
    assert client.post(url(org, "/conflicts/scan"), headers=viewer).status_code == 403
    assert client.get(url(org, "/summary"), headers=viewer).status_code == 200
    assert client.get(url(org, f"/assets/work/{cat['work']}/history"), headers=viewer).status_code == 200


def test_tenant_isolation(client, team, cat, db):
    org = team["org_id"]
    outsider = team["outsider"]["headers"]
    share = ok_share(client, team, cat)
    sid = share["share"]["id"]
    [conflict] = conflicts(client, team, type="under_allocation")

    for path in ["/shares", f"/shares/{sid}", "/conflicts", f"/conflicts/{conflict['id']}", "/summary",
                 "/split-rules", "/split-sheets", f"/assets/work/{cat['work']}/ownership"]:
        assert client.get(url(org, path), headers=outsider).status_code == 404, path
    assert client.post(url(org, "/shares"), json={"work_id": cat["work"], "party_id": cat["writer"], "role": "writer",
                                                  "rights_type": "performance", "share_percent": "1"},
                       headers=outsider).status_code == 404

    # Within its own org the outsider can't reach our rows either.
    other = team["other_org"]["id"]
    assert client.get(url(other, f"/shares/{sid}"), headers=outsider).status_code == 404
    assert client.get(url(other, f"/conflicts/{conflict['id']}"), headers=outsider).status_code == 404
    assert client.post(url(other, f"/conflicts/{conflict['id']}/acknowledge"), headers=outsider).status_code == 404
    assert client.get(url(other, f"/assets/work/{cat['work']}/ownership"), headers=outsider).status_code == 404

    # We can't attach another org's party or work.
    assert mk_share(client, team, cat, party_id=cat["foreign_party"]).status_code == 404
    assert mk_share(client, team, cat, work_id=cat["foreign_work"]).status_code == 404
    assert mk_share(client, team, cat, contract_id="00000000-0000-0000-0000-000000000000").status_code == 404
    put = client.put(url(org, f"/assets/work/{cat['work']}/splits"), json={"rights_type": "performance", "shares": [
        {"party_id": cat["foreign_party"], "role": "writer", "share_percent": "100"}]},
        headers=team["manager"]["headers"])
    assert put.status_code == 404
    sheet = client.post(url(org, "/split-sheets"), json={
        "work_id": cat["work"], "title": "x",
        "entries": [{"party_id": cat["foreign_party"], "role": "writer", "share_percent": "100"}],
    }, headers=team["manager"]["headers"])
    assert sheet.status_code == 404
    sheet = client.post(url(org, "/split-sheets"), json={
        "work_id": cat["foreign_work"], "title": "x",
        "entries": [{"party_id": cat["writer"], "role": "writer", "share_percent": "100"}],
    }, headers=team["manager"]["headers"])
    assert sheet.status_code == 404
    validate = client.post(url(org, "/validate"), json={"asset_type": "work", "shares": [
        {"party_id": cat["foreign_party"], "role": "writer", "rights_type": "performance", "share_percent": "100"}]},
        headers=team["viewer"]["headers"])
    assert validate.status_code == 404
    # Nothing leaked into the foreign org.
    assert db.scalar(select(func.count()).select_from(OwnershipShare).where(
        OwnershipShare.organization_id == other)) == 0
