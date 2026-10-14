"""End-to-end royalty pipeline: import → match → calculate → post → ledger →
payouts, plus RBAC, tenant isolation and financial safety rules."""

import io
from datetime import date
from decimal import Decimal as D

import pytest
from openpyxl import Workbook
from sqlalchemy import func, select

from app.models.catalog import Party, Recording, RecordingWork, Work
from app.models.contract import Contract, ContractRoyaltyTerm
from app.models.royalty import LedgerEntry, RoyaltyAllocation
from app.models.rights import OwnershipShare
from tests.conftest import run_jobs

CSV = (
    "Store,Artist,Title,ISRC,Country of Sale,Quantity,Earnings (USD),Sale Month\n"
    "Spotify,Nova,Midnight Drive,US-AB1-26-00001,US,1000,\"1,000.00\",2026-03\n"
    "Spotify,Nova,Midnight Drive,USAB12600001,GB,500,250.5,2026-03\n"
    "Apple,Nova,Midnight Drive (feat. Echo),,DE,10,10.00,2026-03\n"
    "Spotify,Unknown,Mystery Song,ZZZZZ2600009,FR,7,3.33,2026-03\n"
    "Spotify,Nova,Broken Row,USAB12600001,US,1,not-a-number,2026-03\n"
)


def base(org_id):
    return f"/api/v1/organizations/{org_id}/royalties"


@pytest.fixture
def catalog(db, team):
    org = team["org_id"]
    artist = Party(organization_id=org, name="Nova", roles=["artist"])
    label = Party(organization_id=org, name="Our Label", roles=["label"], is_internal=True)
    producer = Party(organization_id=org, name="Pat Producer", roles=["producer"])
    writer = Party(organization_id=org, name="Wren Writer", roles=["songwriter"])
    db.add_all([artist, label, producer, writer])
    db.flush()
    recording = Recording(organization_id=org, title="Midnight Drive", isrc="USAB12600001",
                          primary_artist_id=artist.id, display_artist="Nova")
    work = Work(organization_id=org, title="Midnight Drive", iswc="T0345246801")
    db.add_all([recording, work])
    db.flush()
    db.add(RecordingWork(organization_id=org, recording_id=recording.id, work_id=work.id))
    contract = Contract(organization_id=org, title="Nova recording deal", contract_type="recording",
                        status="active", territories=["WORLD"], rights_granted=["master"],
                        start_date=date(2025, 1, 1))
    db.add(contract)
    db.flush()
    db.add(ContractRoyaltyTerm(organization_id=org, contract_id=contract.id, payee_party_id=artist.id,
                               rate_percent=D("20"), basis="net"))
    shares = [
        OwnershipShare(organization_id=org, recording_id=recording.id, party_id=label.id, role="label",
                       rights_type="master", share_percent=D("80"), territories=["WORLD"]),
        OwnershipShare(organization_id=org, recording_id=recording.id, party_id=artist.id, role="artist",
                       rights_type="master", share_percent=D("15"), territories=["WORLD"],
                       contract_id=contract.id),
        OwnershipShare(organization_id=org, recording_id=recording.id, party_id=producer.id,
                       role="producer", rights_type="master", share_percent=D("5"), territories=["WORLD"]),
        OwnershipShare(organization_id=org, work_id=work.id, party_id=writer.id, role="writer",
                       rights_type="performance", share_percent=D("100"), territories=["WORLD"]),
    ]
    db.add_all(shares)
    db.commit()
    return {"recording": recording, "work": work, "artist": artist, "label": label,
            "producer": producer, "writer": writer, "contract": contract, "shares": shares}


def upload(client, team, content: bytes = CSV.encode(), filename="march.csv", role="manager", **meta):
    data = {"source_name": "Distro Inc", "source_category": "distributor", "period_start": "2026-03-01",
            "period_end": "2026-03-31", "currency": "USD", **meta}
    return client.post(f"{base(team['org_id'])}/statements", data=data,
                       files={"file": (filename, content, "text/csv")}, headers=team[role]["headers"])


def process(client, team, statement_id):
    r = client.post(f"{base(team['org_id'])}/statements/{statement_id}/process", headers=team["manager"]["headers"])
    assert r.status_code == 202, r.text
    run_jobs()
    return client.get(f"{base(team['org_id'])}/statements/{statement_id}", headers=team["viewer"]["headers"]).json()


def imported(client, team):
    r = upload(client, team)
    assert r.status_code == 201, r.text
    return process(client, team, r.json()["id"])


def test_upload_detects_adapter_and_previews(client, team, catalog):
    r = upload(client, team)
    assert r.status_code == 201
    body = r.json()
    assert body["adapter"] == "distributor_standard"
    assert body["column_mapping"]["amount"] == "Earnings (USD)"
    assert body["column_mapping"]["territory"] == "Country of Sale"
    preview = client.get(f"{base(team['org_id'])}/statements/{body['id']}/preview",
                         headers=team["viewer"]["headers"]).json()
    assert preview["total_rows"] == 5 and len(preview["sample_rows"]) == 5


def test_duplicate_file_is_rejected(client, team, catalog):
    first = upload(client, team)
    second = upload(client, team, filename="renamed.csv")
    assert second.status_code == 409
    assert second.json()["error"]["code"] == "duplicate_statement"
    assert second.json()["error"]["details"]["statement_id"] == first.json()["id"]


def test_processing_validates_and_matches(client, team, catalog):
    statement = imported(client, team)
    assert statement["status"] == "processed"
    assert statement["total_rows"] == 5
    assert statement["error_rows"] == 1  # "not-a-number"
    assert statement["matched_rows"] == 3  # 2 by ISRC + 1 by title/artist (feat. stripped)
    assert D(statement["total_amount"]) == D("1263.83")
    lines = client.get(f"{base(team['org_id'])}/statements/{statement['id']}/lines?page_size=50",
                       headers=team["viewer"]["headers"]).json()["items"]
    by_row = {l["row_number"]: l for l in lines}
    assert by_row[2]["match_method"] == "isrc" and by_row[2]["territory"] == "US"
    assert D(by_row[2]["amount"]) == D("1000")
    assert by_row[4]["match_method"] == "title_artist"
    assert by_row[5]["match_status"] == "unmatched"
    assert by_row[6]["match_status"] == "invalid" and by_row[6]["is_valid"] is False


def test_full_pipeline_calculate_post_and_ledger(client, team, catalog, db):
    statement = imported(client, team)
    sid = statement["id"]
    # Viewer cannot calculate; manager can.
    assert client.post(f"{base(team['org_id'])}/statements/{sid}/calculate", headers=team["viewer"]["headers"]).status_code == 403
    r = client.post(f"{base(team['org_id'])}/statements/{sid}/calculate", headers=team["manager"]["headers"])
    assert r.status_code == 201, r.text
    run = r.json()
    total_input = D(run["total_input"])
    assert total_input == D("1263.83")
    assert D(run["total_payable"]) + D(run["total_retained"]) + D(run["total_unallocated"]) == total_input
    # Matched amount 1260.50: label 80% retained (internal), artist 15% at 20% rate, producer 5% (no term).
    matched = D("1260.50")
    assert D(run["total_unallocated"]) == D("3.33")
    assert D(run["total_payable"]) == matched * D("0.15") * D("0.20") + matched * D("0.05")

    verify = client.post(f"{base(team['org_id'])}/runs/{run['id']}/verify", headers=team["viewer"]["headers"]).json()
    assert verify["reproducible"] is True

    # Managers cannot post; admins can, exactly once.
    assert client.post(f"{base(team['org_id'])}/runs/{run['id']}/post", headers=team["manager"]["headers"]).status_code == 403
    posted = client.post(f"{base(team['org_id'])}/runs/{run['id']}/post", headers=team["admin"]["headers"])
    assert posted.status_code == 200 and posted.json()["status"] == "posted"
    assert client.post(f"{base(team['org_id'])}/runs/{run['id']}/post", headers=team["admin"]["headers"]).status_code == 409
    assert client.post(f"{base(team['org_id'])}/statements/{sid}/calculate", headers=team["manager"]["headers"]).status_code == 409

    org = f"/api/v1/organizations/{team['org_id']}"
    balances = client.get(f"{org}/ledger/balances", headers=team["viewer"]["headers"]).json()["items"]
    by_name = {b["payee_name"]: D(b["balance"]) for b in balances}
    assert by_name == {"Nova": matched * D("0.15") * D("0.20"), "Pat Producer": matched * D("0.05")}
    # Posted lines are immutable.
    line = db.scalar(select(RoyaltyAllocation.line_id).where(RoyaltyAllocation.run_id == run["id"]))
    r = client.patch(f"{base(team['org_id'])}/statements/{sid}/lines/{line}", json={"action": "ignore"},
                     headers=team["manager"]["headers"])
    assert r.status_code == 409

    # Reversal keeps history and zeroes balances.
    reversed_run = client.post(f"{base(team['org_id'])}/runs/{run['id']}/reverse",
                               json={"reason": "Wrong source statement"}, headers=team["admin"]["headers"])
    assert reversed_run.status_code == 200 and reversed_run.json()["status"] == "reversed"
    db.rollback()  # end this session's REPEATABLE READ snapshot
    totals = db.execute(select(LedgerEntry.entry_type, func.sum(LedgerEntry.amount)).where(
        LedgerEntry.organization_id == team["org_id"]).group_by(LedgerEntry.entry_type)).all()
    sums = {k: D(v) for k, v in totals}
    assert sums["earning"] == -sums["reversal"] and sums["earning"] > 0


def test_stale_calculation_cannot_be_posted(client, team, catalog, db):
    sid = imported(client, team)["id"]
    run = client.post(f"{base(team['org_id'])}/statements/{sid}/calculate", headers=team["manager"]["headers"]).json()
    share = db.get(OwnershipShare, catalog["shares"][2].id)
    share.share_percent = D("4")
    db.commit()
    r = client.post(f"{base(team['org_id'])}/runs/{run['id']}/post", headers=team["admin"]["headers"])
    assert r.status_code == 409 and r.json()["error"]["code"] == "stale_calculation"
    assert client.post(f"{base(team['org_id'])}/runs/{run['id']}/verify", headers=team["viewer"]["headers"]).json()["reproducible"] is False


def test_manual_matching_and_bulk_match(client, team, catalog):
    sid = imported(client, team)["id"]
    lines = client.get(f"{base(team['org_id'])}/statements/{sid}/lines?match_status=unmatched",
                       headers=team["viewer"]["headers"]).json()["items"]
    target = lines[0]
    r = client.post(f"{base(team['org_id'])}/statements/{sid}/lines/bulk-match",
                    json={"action": "match", "recording_id": catalog["recording"].id, "match_key": "isrc",
                          "key_line_id": target["id"]}, headers=team["manager"]["headers"])
    assert r.status_code == 200 and r.json()["updated"] == 1
    unmatched = client.get(f"{base(team['org_id'])}/unmatched", headers=team["viewer"]["headers"]).json()
    assert unmatched["total"] == 0


def test_cross_tenant_matching_and_access_denied(client, team, catalog, db, api):
    sid = imported(client, team)["id"]
    other = team["other_org"]["id"]
    foreign = Recording(organization_id=other, title="Foreign", isrc="GBXYZ2600001")
    db.add(foreign)
    db.commit()
    line = client.get(f"{base(team['org_id'])}/statements/{sid}/lines?match_status=unmatched",
                      headers=team["viewer"]["headers"]).json()["items"][0]
    r = client.patch(f"{base(team['org_id'])}/statements/{sid}/lines/{line['id']}",
                     json={"action": "match", "recording_id": foreign.id}, headers=team["manager"]["headers"])
    assert r.status_code == 404
    outsider = team["outsider"]["headers"]
    assert client.get(f"{base(team['org_id'])}/statements/{sid}", headers=outsider).status_code == 404
    assert client.get(f"{base(other)}/statements/{sid}", headers=outsider).status_code == 404
    assert client.get(f"/api/v1/organizations/{team['org_id']}/ledger", headers=outsider).status_code == 404


def test_invalid_upload_inputs(client, team, catalog):
    assert upload(client, team, filename="evil.exe").status_code == 422
    assert upload(client, team, content=b"").status_code == 422
    assert upload(client, team, content=b"a,b\n1,2\n", period_end="2025-01-01").status_code == 422
    assert upload(client, team, content=b"a,b\n1,2\n", source_category="lottery").status_code == 422
    assert upload(client, team, role="viewer").status_code == 403


def test_xlsx_import_and_mapping_update(client, team, catalog):
    wb = Workbook()
    ws = wb.active
    ws.append(["Song", "Code", "Net"])
    ws.append(["Midnight Drive", "USAB12600001", 12.34])
    ws.append(["Midnight Drive", "USAB12600001", 0.1])
    buffer = io.BytesIO()
    wb.save(buffer)
    r = upload(client, team, content=buffer.getvalue(), filename="q1.xlsx")
    assert r.status_code == 201
    sid = r.json()["id"]
    bad = client.put(f"{base(team['org_id'])}/statements/{sid}/mapping",
                     json={"adapter": "generic", "column_mapping": {"amount": "Nope"}}, headers=team["manager"]["headers"])
    assert bad.status_code == 422
    ok = client.put(f"{base(team['org_id'])}/statements/{sid}/mapping",
                    json={"adapter": "generic", "column_mapping": {"amount": "Net", "isrc": "Code", "title": "Song"}},
                    headers=team["manager"]["headers"])
    assert ok.status_code == 200
    statement = process(client, team, sid)
    assert statement["matched_rows"] == 2
    assert D(statement["total_amount"]) == D("12.44")  # no float artefacts


def test_manual_statement_and_reconciliation(client, team, catalog):
    r = client.post(f"{base(team['org_id'])}/statements/manual", json={
        "source_name": "Sync fee", "source_category": "licensing", "period_start": "2026-02-01",
        "period_end": "2026-02-28", "currency": "USD", "reported_total": "500.00",
        "lines": [{"recording_id": catalog["recording"].id, "amount": "500", "rights_type": "master",
                   "description": "TV placement"}]}, headers=team["manager"]["headers"])
    assert r.status_code == 201, r.text
    sid = r.json()["id"]
    rec = client.get(f"{base(team['org_id'])}/statements/{sid}/reconciliation", headers=team["viewer"]["headers"]).json()
    assert D(rec["statement_total"]) == D("500") and D(rec["reported_difference"]) == D("0")
    run = client.post(f"{base(team['org_id'])}/statements/{sid}/calculate", headers=team["manager"]["headers"]).json()
    assert D(run["total_payable"]) == D("500") * D("0.15") * D("0.2") + D("25")


def test_work_level_income_needs_work_ownership(client, team, catalog):
    r = client.post(f"{base(team['org_id'])}/statements/manual", json={
        "source_name": "PRO", "source_category": "pro", "period_start": "2026-01-01",
        "period_end": "2026-03-31", "currency": "USD",
        "lines": [{"work_id": catalog["work"].id, "amount": "40", "territory": "US"},
                  {"recording_id": catalog["recording"].id, "amount": "10", "territory": "US"}]},
        headers=team["manager"]["headers"])
    sid = r.json()["id"]
    run = client.post(f"{base(team['org_id'])}/statements/{sid}/calculate", headers=team["manager"]["headers"]).json()
    # Both lines resolve to the work (second via the recording's linked work) -> writer 100%.
    assert D(run["total_payable"]) == D("50")


def _post_simple_earnings(client, team, catalog):
    sid = imported(client, team)["id"]
    run = client.post(f"{base(team['org_id'])}/statements/{sid}/calculate", headers=team["manager"]["headers"]).json()
    client.post(f"{base(team['org_id'])}/runs/{run['id']}/post", headers=team["admin"]["headers"])


def test_advance_recoupment_and_adjustments(client, team, catalog):
    _post_simple_earnings(client, team, catalog)
    org = f"/api/v1/organizations/{team['org_id']}"
    payees = {p["display_name"]: p for p in client.get(f"{org}/payees", headers=team["viewer"]["headers"]).json()["items"]}
    nova = payees["Nova"]
    earned = D(nova["balances"][0]["balance"])
    assert client.post(f"{org}/ledger/advances", json={"payee_id": nova["id"], "amount": "100", "currency": "USD",
                       "description": "Signing advance"}, headers=team["manager"]["headers"]).status_code == 403
    r = client.post(f"{org}/ledger/advances", json={"payee_id": nova["id"], "amount": "100", "currency": "USD",
                    "contract_id": catalog["contract"].id, "description": "Signing advance"},
                    headers=team["admin"]["headers"])
    assert r.status_code == 201
    balance = client.get(f"{org}/payees/{nova['id']}", headers=team["viewer"]["headers"]).json()["balances"][0]
    assert D(balance["balance"]) == earned - D("100")
    assert D(balance["unrecouped_advances"]) == D("100") - earned
    assert D(balance["available"]) == D("0")
    adj = client.post(f"{org}/ledger/adjustments", json={"payee_id": nova["id"], "amount": "-0.5", "currency": "USD",
                      "description": "Bank fee"}, headers=team["admin"]["headers"]).json()
    rev = client.post(f"{org}/ledger/{adj['id']}/reverse", json={"reason": "Fee waived"}, headers=team["admin"]["headers"])
    assert rev.status_code == 201
    assert client.post(f"{org}/ledger/{adj['id']}/reverse", json={"reason": "again"}, headers=team["admin"]["headers"]).status_code == 409
    ledger = client.get(f"{org}/payees/{nova['id']}/ledger", headers=team["viewer"]["headers"]).json()
    assert D(ledger[-1]["running_balance"]) == earned - D("100")


def test_payout_workflow(client, team, catalog, db):
    _post_simple_earnings(client, team, catalog)
    org = f"/api/v1/organizations/{team['org_id']}"
    r = client.post(f"{org}/payouts/batches", json={"currency": "USD"}, headers=team["manager"]["headers"])
    assert r.status_code == 201, r.text
    batch = r.json()
    assert batch["status"] == "draft" and batch["payout_count"] == 2
    # Amounts are whole cents rounded down from the available balance.
    for payout in batch["payouts"]:
        assert D(payout["amount"]) == D(payout["amount"]).quantize(D("0.01"))
    bid = batch["id"]
    # A second draft can't double-commit the same balances.
    second = client.post(f"{org}/payouts/batches", json={"currency": "USD"}, headers=team["manager"]["headers"])
    assert second.status_code == 422
    assert client.post(f"{org}/payouts/batches/{bid}/approve", headers=team["admin"]["headers"]).status_code == 409
    assert client.post(f"{org}/payouts/batches/{bid}/submit", headers=team["manager"]["headers"]).status_code == 200
    assert client.post(f"{org}/payouts/batches/{bid}/approve", headers=team["manager"]["headers"]).status_code == 403
    assert client.post(f"{org}/payouts/batches/{bid}/approve", headers=team["admin"]["headers"]).status_code == 200
    assert client.post(f"{org}/payouts/batches/{bid}/mark-paid", json={}, headers=team["admin"]["headers"]).status_code == 422
    paid = client.post(f"{org}/payouts/batches/{bid}/mark-paid", json={"confirm": True}, headers=team["admin"]["headers"])
    assert paid.status_code == 200 and paid.json()["status"] == "paid"
    balances = client.get(f"{org}/ledger/balances", headers=team["viewer"]["headers"]).json()["items"]
    for row in balances:
        assert D("0") <= D(row["balance"]) < D("0.01")  # sub-cent remainders stay in the ledger
    remittance = client.get(f"{org}/payouts/batches/{bid}/remittance.csv", headers=team["viewer"]["headers"])
    assert remittance.status_code == 200 and "Pat Producer" in remittance.text
    assert client.post(f"{org}/payouts/batches/{bid}/cancel", headers=team["admin"]["headers"]).status_code == 409


def test_distinct_approver_rule(client, team, catalog):
    _post_simple_earnings(client, team, catalog)
    org = f"/api/v1/organizations/{team['org_id']}"
    bid = client.post(f"{org}/payouts/batches", json={"currency": "USD"}, headers=team["admin"]["headers"]).json()["id"]
    client.post(f"{org}/payouts/batches/{bid}/submit", headers=team["admin"]["headers"])
    r = client.post(f"{org}/payouts/batches/{bid}/approve", headers=team["admin"]["headers"])
    assert r.status_code == 403 and r.json()["error"]["code"] == "distinct_approver_required"
    assert client.post(f"{org}/payouts/batches/{bid}/approve", headers=team["owner"]["headers"]).status_code == 200


def test_payee_reference_rejects_full_account_numbers(client, team, catalog):
    org = f"/api/v1/organizations/{team['org_id']}"
    r = client.post(f"{org}/payees", json={"party_id": catalog["writer"].id,
                    "payment_reference": {"iban": "DE89370400440532013000"}}, headers=team["manager"]["headers"])
    assert r.status_code == 422
    r = client.post(f"{org}/payees", json={"party_id": catalog["writer"].id,
                    "payment_reference": {"bank_name": "ACME Bank", "account_last4": "3000"}},
                    headers=team["manager"]["headers"])
    assert r.status_code == 201
    assert client.post(f"{org}/payees", json={"party_id": catalog["label"].id}, headers=team["manager"]["headers"]).status_code == 422


def test_reports_and_export(client, team, catalog):
    _post_simple_earnings(client, team, catalog)
    r = client.get(f"{base(team['org_id'])}/reports/revenue_by_territory", headers=team["viewer"]["headers"]).json()
    by = {row["territory"]: D(row["amount"]) for row in r["rows"]}
    assert by == {"US": D("1000"), "GB": D("250.5"), "DE": D("10"), "FR": D("3.33")}
    payees = client.get(f"{base(team['org_id'])}/reports/earnings_by_payee", headers=team["viewer"]["headers"]).json()
    assert len(payees["rows"]) == 2
    job = client.post(f"{base(team['org_id'])}/reports/revenue_by_source/export", headers=team["viewer"]["headers"]).json()
    run_jobs()
    download = client.get(f"{base(team['org_id'])}/reports/exports/{job['job_id']}/download", headers=team["viewer"]["headers"])
    assert download.status_code == 200 and "Distro Inc" in download.text
    assert client.get(f"{base(team['org_id'])}/reports/exports/{job['job_id']}/download",
                      headers=team["outsider"]["headers"]).status_code == 404


def test_reprocessing_replaces_unposted_lines(client, team, catalog):
    sid = imported(client, team)["id"]
    client.post(f"{base(team['org_id'])}/statements/{sid}/calculate", headers=team["manager"]["headers"])
    again = process(client, team, sid)
    assert again["status"] == "processed" and again["total_rows"] == 5
    runs = client.get(f"{base(team['org_id'])}/runs?statement_id={sid}", headers=team["viewer"]["headers"]).json()
    assert [r["status"] for r in runs["items"]] == ["discarded"]


def test_statement_deletion_rules(client, team, catalog):
    sid = imported(client, team)["id"]
    run = client.post(f"{base(team['org_id'])}/statements/{sid}/calculate", headers=team["manager"]["headers"]).json()
    client.post(f"{base(team['org_id'])}/runs/{run['id']}/post", headers=team["admin"]["headers"])
    r = client.delete(f"{base(team['org_id'])}/statements/{sid}", headers=team["admin"]["headers"])
    assert r.status_code == 409


# --------------------------------------------------------------------------- audit regressions


def _pay_batch(client, team, org):
    bid = client.post(f"{org}/payouts/batches", json={"currency": "USD"}, headers=team["manager"]["headers"]).json()["id"]
    assert client.post(f"{org}/payouts/batches/{bid}/submit", headers=team["manager"]["headers"]).status_code == 200
    assert client.post(f"{org}/payouts/batches/{bid}/approve", headers=team["admin"]["headers"]).status_code == 200
    paid = client.post(f"{org}/payouts/batches/{bid}/mark-paid", json={"confirm": True}, headers=team["admin"]["headers"])
    assert paid.status_code == 200, paid.text
    return paid.json()


def test_remittance_advice_of_an_older_payout_survives_later_payouts(client, team, catalog):
    """F-M4: the advice window is anchored on the payout itself."""
    _post_simple_earnings(client, team, catalog)
    org = f"/api/v1/organizations/{team['org_id']}"
    first = _pay_batch(client, team, org)
    nova_payout = first["payouts"][0]
    payee_id = nova_payout["payee_id"]
    assert client.post(f"{org}/ledger/adjustments", json={"payee_id": payee_id, "amount": "25", "currency": "USD",
                       "description": "Sync bonus"}, headers=team["admin"]["headers"]).status_code == 201
    _pay_batch(client, team, org)
    advice = client.get(f"{org}/payouts/batches/{first['id']}/payouts/{nova_payout['id']}/advice.csv",
                        headers=team["viewer"]["headers"]).text
    assert "earning" in advice and "Sync bonus" not in advice


def test_hold_after_submission_blocks_approval(client, team, catalog):
    """F-L3: a payee put on hold after drafting can't be approved or paid."""
    _post_simple_earnings(client, team, catalog)
    org = f"/api/v1/organizations/{team['org_id']}"
    batch = client.post(f"{org}/payouts/batches", json={"currency": "USD"}, headers=team["manager"]["headers"]).json()
    client.post(f"{org}/payouts/batches/{batch['id']}/submit", headers=team["manager"]["headers"])
    payee_id = batch["payouts"][0]["payee_id"]
    held = client.patch(f"{org}/payees/{payee_id}", json={"hold_payments": True}, headers=team["admin"]["headers"])
    assert held.status_code == 200, held.text
    r = client.post(f"{org}/payouts/batches/{batch['id']}/approve", headers=team["admin"]["headers"])
    assert r.status_code == 409 and r.json()["error"]["code"] == "payee_not_payable"


def test_payout_amounts_follow_currency_minor_units():
    """F-L6: JPY/KRW have no minor unit; dinars have three."""
    from app.services.payouts import _cents

    assert _cents(D("1234.567"), "JPY") == D("1234")
    assert _cents(D("1234.567"), "USD") == D("1234.56")
    assert _cents(D("1.2345"), "KWD") == D("1.234")


def test_lifetime_earnings_are_net_of_reversed_runs(client, team, catalog):
    """F-L1: reversing a posted run removes it from lifetime earnings."""
    sid = imported(client, team)["id"]
    org = f"/api/v1/organizations/{team['org_id']}"
    run = client.post(f"{base(team['org_id'])}/statements/{sid}/calculate", headers=team["manager"]["headers"]).json()
    assert client.post(f"{base(team['org_id'])}/runs/{run['id']}/post", headers=team["admin"]["headers"]).status_code == 200
    reversed_ = client.post(f"{base(team['org_id'])}/runs/{run['id']}/reverse", json={"reason": "Wrong statement"},
                            headers=team["admin"]["headers"])
    assert reversed_.status_code == 200, reversed_.text
    for payee in client.get(f"{org}/payees", headers=team["viewer"]["headers"]).json()["items"]:
        for row in payee["balances"]:
            assert D(row["lifetime_earnings"]) == 0 and D(row["balance"]) == 0


def test_report_totals_cover_rows_beyond_the_display_limit(client, team, catalog, db):
    """F-L5: totals were summed after truncating to the display limit."""
    from app.services.reports import run_report

    _post_simple_earnings(client, team, catalog)
    report = run_report(db, team["org_id"], "revenue_by_territory", limit=2)
    assert len(report["rows"]) == 2 and report["truncated"] is True and report["row_count"] == 4
    assert D(report["totals_by_currency"]["USD"]) == D("1263.83")
    recon = run_report(db, team["org_id"], "statement_reconciliation", limit=1)
    assert len(recon["rows"]) == 1 and recon["truncated"] is False
