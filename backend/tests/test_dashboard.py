from datetime import date, datetime, timedelta
from decimal import Decimal

from app.db.mixins import utc_now
from app.models.catalog import Party, Recording, RecordingWork, Release, Work
from app.models.contract import Contract
from app.models.platform import AuditLog
from app.models.rights import OwnershipShare, RightsConflict
from app.models.royalty import (
    LedgerEntry,
    Payee,
    Payout,
    PayoutBatch,
    RoyaltyStatement,
    StatementLine,
)

ENDPOINTS = [
    "/summary", "/royalties-over-time", "/revenue-by-source", "/revenue-by-territory",
    "/top-works", "/top-recordings", "/ownership-distribution", "/catalog-growth",
]


def url(org_id: str, path: str = "") -> str:
    return f"/api/v1/organizations/{org_id}/dashboard{path}"


def month_label(d: date) -> str:
    return f"{d.year:04d}-{d.month:02d}"


def shift_month(d: date, months: int) -> date:
    index = d.year * 12 + (d.month - 1) + months
    return date(index // 12, index % 12 + 1, 1)


# --------------------------------------------------------------------------- data builders


class Builder:
    def __init__(self, db, org_id):
        self.db, self.org = db, org_id
        self._row = 0

    def add(self, obj):
        self.db.add(obj)
        self.db.flush()
        return obj

    def statement(self, *, source="Spotify", category="streaming", currency="USD",
                  period_end=date(2026, 1, 31), status="processed", sha=None):
        return self.add(RoyaltyStatement(
            organization_id=self.org, source_name=source, source_category=category,
            period_start=period_end.replace(day=1), period_end=period_end, currency=currency,
            status=status, file_sha256=sha,
        ))

    def line(self, statement, amount, *, currency=None, work=None, recording=None,
             territory=None, match="matched", valid=True):
        self._row += 1
        return self.add(StatementLine(
            organization_id=self.org, statement_id=statement.id, row_number=self._row, raw={},
            amount=Decimal(amount), currency=currency, work_id=work.id if work else None,
            recording_id=recording.id if recording else None, territory=territory,
            match_status=match, is_valid=valid,
        ))


def build_rich_org(db, org_id, today):
    b = Builder(db, org_id)
    w1 = b.add(Work(organization_id=org_id, title="Alpha Song", iswc="T1234567890"))
    w2 = b.add(Work(organization_id=org_id, title="Beta Song"))
    b.add(Work(organization_id=org_id, title="Archived Song", status="archived"))
    r1 = b.add(Recording(organization_id=org_id, title="Alpha (Original)", isrc="USAAA2600001"))
    r2 = b.add(Recording(organization_id=org_id, title="Medley"))
    b.add(Release(organization_id=org_id, title="The Album"))
    p1 = b.add(Party(organization_id=org_id, name="Writer One"))
    p2 = b.add(Party(organization_id=org_id, name="Writer Two"))
    b.add(Party(organization_id=org_id, name="Gone", status="archived"))
    b.add(RecordingWork(organization_id=org_id, recording_id=r1.id, work_id=w1.id))
    b.add(RecordingWork(organization_id=org_id, recording_id=r2.id, work_id=w1.id))
    b.add(RecordingWork(organization_id=org_id, recording_id=r2.id, work_id=w2.id))

    # USD streaming statement in January of the current year (period_end month).
    s1 = b.statement(sha="a" * 64, period_end=date(today.year, 1, 31))
    b.line(s1, "100.12345678", work=w1, territory="US")
    b.line(s1, "50.5", recording=r1)                       # -> w1 via single link, Unknown
    b.line(s1, "20", recording=r2, territory="GB")         # ambiguous recording: no work
    b.line(s1, "7.25", territory="US", match="unmatched")  # unmatched but reported
    b.line(s1, "999", territory="US", match="invalid", valid=False)
    b.line(s1, "30", currency="EUR", work=w2, territory="DE")
    # Posted EUR PRO statement last year (within the last 12 months).
    s2 = b.statement(source="ASCAP", category="pro", currency="EUR", status="posted",
                     sha="b" * 64, period_end=date(today.year - 1, 11, 30))
    b.line(s2, "200", work=w2, territory="FR")
    b.line(s2, "5", match="unmatched")
    # Still processing: never counted as reported.
    s3 = b.statement(status="processing", sha="c" * 64, period_end=date(today.year, 1, 31))
    b.line(s3, "1000", work=w1, territory="US")

    payee_a = b.add(Payee(organization_id=org_id, party_id=p1.id, display_name="Writer One"))
    payee_b = b.add(Payee(organization_id=org_id, party_id=p2.id, display_name="Writer Two"))
    for payee, amount, currency in [(payee_a, "100", "USD"), (payee_a, "50.5", "USD"),
                                    (payee_a, "-20", "USD"), (payee_b, "10", "USD"),
                                    (payee_b, "-25", "USD"), (payee_a, "40", "EUR")]:
        b.add(LedgerEntry(organization_id=org_id, payee_id=payee.id, entry_type="earning",
                          amount=Decimal(amount), currency=currency, effective_date=today,
                          description="test"))
    pending = b.add(PayoutBatch(organization_id=org_id, reference="PB-1", currency="USD",
                                status="pending_approval"))
    b.add(Payout(organization_id=org_id, batch_id=pending.id, payee_id=payee_a.id,
                 amount=Decimal("30"), currency="USD"))
    draft = b.add(PayoutBatch(organization_id=org_id, reference="PB-2", currency="USD",
                              status="draft"))
    b.add(Payout(organization_id=org_id, batch_id=draft.id, payee_id=payee_a.id,
                 amount=Decimal("10"), currency="USD"))

    def contract(title, status, end):
        return b.add(Contract(organization_id=org_id, title=title, contract_type="publishing",
                              status=status, end_date=end, territories=["WORLD"],
                              rights_granted=["performance"]))

    soon = contract("Expiring Soon", "active", today + timedelta(days=10))
    contract("Far Future", "active", today + timedelta(days=200))
    contract("Open Ended", "active", None)
    contract("Already Expired", "expired", today + timedelta(days=5))
    contract("Draft Deal", "draft", today + timedelta(days=3))

    for severity, status, fp in [("high", "open", "1"), ("high", "acknowledged", "2"),
                                 ("critical", "resolved", "3"), ("low", "open", "4")]:
        b.add(RightsConflict(organization_id=org_id, conflict_type="over_allocation",
                             severity=severity, status=status, title="c", explanation="e",
                             fingerprint=fp * 8, last_detected_at=utc_now()))

    for party, pct, rights, controlled, status, work, rec in [
        (p1, "50", "performance", True, "active", w1, None),
        (p2, "50", "performance", False, "active", w1, None),
        (p1, "100", "master", True, "active", None, r1),
        (p1, "25", "mechanical", True, "superseded", w2, None),
    ]:
        b.add(OwnershipShare(organization_id=org_id, party_id=party.id, role="writer",
                             rights_type=rights, share_percent=Decimal(pct), territories=["WORLD"],
                             is_controlled=controlled, status=status,
                             work_id=work.id if work else None, recording_id=rec.id if rec else None))

    b.add(AuditLog(organization_id=org_id, action="work.created", entity_type="work",
                   entity_id=w1.id, summary="Created Alpha Song"))
    b.add(AuditLog(organization_id=org_id, action="contract.created", entity_type="contract",
                   summary="not catalog"))
    db.commit()
    return {"w1": w1, "w2": w2, "r1": r1, "r2": r2, "soon": soon}


def build_foreign_org(db, org_id, today):
    b = Builder(db, org_id)
    w = b.add(Work(organization_id=org_id, title="Foreign Hit"))
    s = b.statement(sha="f" * 64, period_end=date(today.year, 1, 31))
    b.line(s, "777777", work=w, territory="US")
    b.line(s, "55", match="unmatched", territory="US")
    p = b.add(Party(organization_id=org_id, name="Foreign Writer"))
    payee = b.add(Payee(organization_id=org_id, party_id=p.id, display_name="FW"))
    b.add(LedgerEntry(organization_id=org_id, payee_id=payee.id, entry_type="earning",
                      amount=Decimal("5000"), currency="USD", effective_date=today,
                      description="x"))
    b.add(RightsConflict(organization_id=org_id, conflict_type="x", severity="critical",
                         status="open", title="c", explanation="e", fingerprint="z" * 8,
                         last_detected_at=utc_now()))
    b.add(OwnershipShare(organization_id=org_id, party_id=p.id, role="writer",
                         rights_type="performance", share_percent=Decimal("100"),
                         territories=["WORLD"], work_id=w.id))
    b.add(AuditLog(organization_id=org_id, action="work.created", entity_type="work",
                   entity_id=w.id, summary="foreign"))
    db.commit()


# --------------------------------------------------------------------------- tests


def test_empty_org_returns_zeros_not_fabricated_data(client, team):
    org_id = team["org_id"]
    h = team["viewer"]["headers"]
    summary = client.get(url(org_id, "/summary"), headers=h)
    assert summary.status_code == 200, summary.text
    s = summary.json()
    assert s["primary_currency"] == "USD"
    assert s["catalog"] == {"works": 0, "recordings": 0, "releases": 0, "parties": 0}
    assert s["active_contracts"] == 0
    assert s["open_conflicts"] == {"total": 0, "by_severity": {
        "critical": 0, "high": 0, "medium": 0, "low": 0}}
    assert s["unmatched_transactions"] == {"count": 0, "primary_count": 0, "currency": "USD",
                                           "amount": "0.00", "other_currencies": []}
    assert s["reported_royalties"]["all_time"] == {"currency": "USD", "amount": "0.00",
                                                   "other_currencies": []}
    assert s["reported_royalties"]["current_year"]["amount"] == "0.00"
    assert s["payable_balances"] == {"currency": "USD", "gross_balance": "0.00",
                                     "reserved_in_payouts": "0.00", "available": "0.00",
                                     "payee_count": 0, "other_currencies": []}
    assert s["recent_catalog_activity"] == []
    assert s["recent_statements"] == []
    assert s["upcoming_contract_expirations"] == []

    series = client.get(url(org_id, "/royalties-over-time"), headers=h).json()
    assert len(series["series"]) == 12
    assert {p["amount"] for p in series["series"]} == {"0.00"}
    assert series["total"] == "0.00" and series["other_currencies"] == []
    for path in ["/revenue-by-source", "/revenue-by-territory", "/top-works", "/top-recordings"]:
        data = client.get(url(org_id, path), headers=h).json()
        assert data["items"] == [] and data["total"] == "0.00", path
        assert data["other_currencies"] == []
    ownership = client.get(url(org_id, "/ownership-distribution"), headers=h).json()
    assert ownership == {"total_active_shares": 0, "by_party": [], "by_rights_type": []}
    growth = client.get(url(org_id, "/catalog-growth"), headers=h).json()
    assert len(growth["series"]) == 12
    assert all(p["works"] == 0 and p["works_total"] == 0 for p in growth["series"])


def test_dashboard_figures_are_exact(client, team, db):
    org_id = team["org_id"]
    today = utc_now().date()
    ids = build_rich_org(db, org_id, today)
    build_foreign_org(db, team["other_org"]["id"], today)
    h = team["viewer"]["headers"]

    s = client.get(url(org_id, "/summary"), headers=h).json()
    assert s["catalog"] == {"works": 2, "recordings": 2, "releases": 1, "parties": 2}
    assert s["active_contracts"] == 3
    assert s["open_conflicts"] == {"total": 3, "by_severity": {
        "critical": 0, "high": 2, "medium": 0, "low": 1}}
    # Only the unmatched line in the non-posted statement counts.
    assert s["unmatched_transactions"] == {"count": 1, "primary_count": 1, "currency": "USD",
                                           "amount": "7.25", "other_currencies": []}
    assert s["reported_royalties"]["all_time"] == {
        "currency": "USD", "amount": "177.87345678",
        "other_currencies": [{"currency": "EUR", "amount": "235.00"}],
    }
    assert s["reported_royalties"]["current_year"] == {
        "year": today.year, "currency": "USD", "amount": "177.87345678",
        "other_currencies": [{"currency": "EUR", "amount": "30.00"}],
    }
    assert s["payable_balances"] == {
        "currency": "USD", "gross_balance": "130.50", "reserved_in_payouts": "30.00",
        "available": "100.50", "payee_count": 1,
        "other_currencies": [{"currency": "EUR", "gross_balance": "40.00",
                              "reserved_in_payouts": "0.00", "available": "40.00",
                              "payee_count": 1}],
    }
    assert [a["summary"] for a in s["recent_catalog_activity"]] == ["Created Alpha Song"]
    assert len(s["recent_statements"]) == 3
    assert {st["source_name"] for st in s["recent_statements"]} == {"Spotify", "ASCAP"}
    assert s["upcoming_contract_expirations"] == [{
        "id": ids["soon"].id, "title": "Expiring Soon", "reference": None,
        "contract_type": "publishing", "end_date": (today + timedelta(days=10)).isoformat(),
        "days_remaining": 10, "auto_renew": False,
    }]

    usd = client.get(url(org_id, "/royalties-over-time"), headers=h).json()
    assert usd["currency"] == "USD" and usd["total"] == "177.87345678"
    jan = month_label(date(today.year, 1, 1))
    expected = {p["month"]: p["amount"] for p in usd["series"] if p["amount"] != "0.00"}
    assert expected == {jan: "177.87345678"}
    assert usd["series"][-1]["month"] == month_label(today)
    eur = client.get(url(org_id, "/royalties-over-time"), params={"currency": "EUR"},
                     headers=h).json()
    nonzero = {p["month"]: p["amount"] for p in eur["series"] if p["amount"] != "0.00"}
    window_start = shift_month(today.replace(day=1), -11)
    want = {jan: "30.00"}
    if date(today.year - 1, 11, 1) >= window_start:
        want[f"{today.year - 1:04d}-11"] = "205.00"  # 200 + 5 (unmatched still reported)
    assert nonzero == want
    assert eur["other_currencies"] == [{"currency": "USD", "amount": "177.87345678"}]

    by_source = client.get(url(org_id, "/revenue-by-source"), headers=h).json()
    assert by_source["items"] == [{"source_category": "streaming", "source_name": "Spotify",
                                   "amount": "177.87345678", "line_count": 4}]
    eur_source = client.get(url(org_id, "/revenue-by-source"), params={"currency": "EUR"},
                            headers=h).json()
    assert [(i["source_name"], i["amount"]) for i in eur_source["items"]] == [
        ("ASCAP", "205.00"), ("Spotify", "30.00")]
    assert eur_source["total"] == "235.00"

    territory = client.get(url(org_id, "/revenue-by-territory"), headers=h).json()
    assert [(i["territory"], i["amount"]) for i in territory["items"]] == [
        ("US", "107.37345678"), ("Unknown", "50.50"), ("GB", "20.00")]
    eur_territory = client.get(url(org_id, "/revenue-by-territory"), params={"currency": "EUR"},
                               headers=h).json()
    assert [(i["territory"], i["amount"]) for i in eur_territory["items"]] == [
        ("FR", "200.00"), ("DE", "30.00"), ("Unknown", "5.00")]

    works = client.get(url(org_id, "/top-works"), headers=h).json()
    assert works["items"] == [{"work_id": ids["w1"].id, "title": "Alpha Song",
                               "iswc": "T1234567890", "amount": "150.62345678", "line_count": 2}]
    eur_works = client.get(url(org_id, "/top-works"), params={"currency": "EUR"}, headers=h).json()
    assert [(i["title"], i["amount"]) for i in eur_works["items"]] == [("Beta Song", "230.00")]

    recordings = client.get(url(org_id, "/top-recordings"), headers=h).json()
    assert [(i["title"], i["amount"]) for i in recordings["items"]] == [
        ("Alpha (Original)", "50.50"), ("Medley", "20.00")]
    assert client.get(url(org_id, "/top-recordings"), params={"limit": 1},
                      headers=h).json()["items"][0]["title"] == "Alpha (Original)"

    ownership = client.get(url(org_id, "/ownership-distribution"), headers=h).json()
    assert ownership["total_active_shares"] == 3
    assert [(p["party_name"], p["share_count"], p["total_share_percent"],
             p["weighted_asset_count"]) for p in ownership["by_party"]] == [
        ("Writer One", 2, "150.00", "1.50"), ("Writer Two", 1, "50.00", "0.50")]
    assert ownership["by_rights_type"] == [
        {"rights_type": "master", "controlled": 1, "non_controlled": 0},
        {"rights_type": "performance", "controlled": 1, "non_controlled": 1},
    ]


def test_period_filters(client, team, db):
    org_id = team["org_id"]
    today = utc_now().date()
    build_rich_org(db, org_id, today)
    h = team["viewer"]["headers"]
    params = {"currency": "EUR", "period_start": f"{today.year}-01-01",
              "period_end": f"{today.year}-12-31"}
    data = client.get(url(org_id, "/revenue-by-source"), params=params, headers=h).json()
    assert [(i["source_name"], i["amount"]) for i in data["items"]] == [("Spotify", "30.00")]
    assert data["total"] == "30.00"
    assert data["other_currencies"] == [{"currency": "USD", "amount": "177.87345678"}]
    bad = client.get(url(org_id, "/top-works"),
                     params={"period_start": "2026-05-01", "period_end": "2026-01-01"}, headers=h)
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "invalid_period"
    assert client.get(url(org_id, "/top-works"), params={"currency": "usd"},
                      headers=h).status_code == 422
    assert client.get(url(org_id, "/royalties-over-time"), params={"months": 0},
                      headers=h).status_code == 422


def test_cross_tenant_data_never_leaks(client, team, db):
    today = utc_now().date()
    build_foreign_org(db, team["other_org"]["id"], today)
    org_id = team["org_id"]
    h = team["owner"]["headers"]
    s = client.get(url(org_id, "/summary"), headers=h).json()
    assert s["catalog"]["works"] == 0 and s["catalog"]["parties"] == 0
    assert s["open_conflicts"]["total"] == 0
    assert s["unmatched_transactions"]["count"] == 0
    assert s["reported_royalties"]["all_time"]["amount"] == "0.00"
    assert s["payable_balances"]["gross_balance"] == "0.00"
    assert s["recent_catalog_activity"] == [] and s["recent_statements"] == []
    assert client.get(url(org_id, "/top-works"), headers=h).json()["items"] == []
    assert client.get(url(org_id, "/ownership-distribution"),
                      headers=h).json()["total_active_shares"] == 0

    # The foreign org sees exactly its own data.
    foreign = client.get(url(team["other_org"]["id"], "/summary"),
                         headers=team["outsider"]["headers"]).json()
    assert foreign["reported_royalties"]["all_time"]["amount"] == "777832.00"
    assert foreign["payable_balances"]["gross_balance"] == "5000.00"

    # Non-members get 404 on every dashboard endpoint.
    for path in ENDPOINTS:
        assert client.get(url(org_id, path), headers=team["outsider"]["headers"]).status_code == 404
        assert client.get(url(org_id, path)).status_code == 401


def test_catalog_growth_is_cumulative(client, team, db):
    org_id = team["org_id"]
    now = utc_now()
    this_month = datetime(now.year, now.month, 1, 12)
    two_ago = datetime.combine(shift_month(this_month.date(), -2), datetime.min.time())
    long_ago = datetime.combine(shift_month(this_month.date(), -24), datetime.min.time())
    for title, created in [("Old", long_ago), ("Two ago A", two_ago), ("Two ago B", two_ago),
                           ("Now", this_month)]:
        db.add(Work(organization_id=org_id, title=title, created_at=created))
    db.add(Work(organization_id=org_id, title="Archived", created_at=two_ago, status="archived"))
    db.add(Recording(organization_id=org_id, title="Rec", created_at=this_month))
    db.add(Work(organization_id=team["other_org"]["id"], title="Foreign", created_at=this_month))
    db.commit()

    growth = client.get(url(org_id, "/catalog-growth"), params={"months": 3},
                        headers=team["viewer"]["headers"]).json()
    assert growth["baseline"] == {"works": 1, "recordings": 0, "releases": 0}
    assert [(p["month"], p["works"], p["works_total"], p["recordings_total"])
            for p in growth["series"]] == [
        (month_label(two_ago.date()), 2, 3, 0),
        (month_label(shift_month(this_month.date(), -1)), 0, 3, 0),
        (month_label(this_month.date()), 1, 4, 1),
    ]
