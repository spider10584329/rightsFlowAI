"""Regression tests for financial, import, upload and platform findings of the
pre-launch audit (docs/FINAL_AUDIT_REPORT.md)."""

import io
import zipfile
from datetime import date, timedelta
from decimal import Decimal as D

import pytest

from app.db.mixins import utc_now
from app.models.catalog import Party, Recording
from app.models.contract import Contract, ContractRoyaltyTerm
from app.models.platform import BackgroundJob
from app.models.rights import OwnershipShare
from app.models.royalty import RoyaltyAllocation
from tests.conftest import run_jobs


def org(team, path=""):
    return f"/api/v1/organizations/{team['org_id']}{path}"


def hd(team, role="manager"):
    return team[role]["headers"]


@pytest.fixture
def owned_recording(db, team):
    o = team["org_id"]
    artist = Party(organization_id=o, name="Artist", roles=["artist"])
    db.add(artist)
    db.flush()
    rec = Recording(organization_id=o, title="Song", isrc="USAB12600001")
    db.add(rec)
    db.flush()
    db.add(OwnershipShare(organization_id=o, recording_id=rec.id, party_id=artist.id, role="artist",
                          rights_type="master", share_percent=D("100"), territories=["WORLD"]))
    db.commit()
    return {"recording": rec, "artist": artist}


def upload(client, team, content: bytes, name="s.csv", **extra):
    data = {"source_name": "Distro", "source_category": "distributor", "period_start": "2026-01-01",
            "period_end": "2026-12-31", "currency": "EUR", **extra}
    return client.post(org(team, "/royalties/statements"), data=data,
                       files={"file": (name, content, "text/csv")}, headers=hd(team))


def process(client, team, sid):
    assert client.post(org(team, f"/royalties/statements/{sid}/process"), headers=hd(team)).status_code == 202
    run_jobs()
    return client.get(org(team, f"/royalties/statements/{sid}"), headers=hd(team)).json()


# --------------------------------------------------------------------------- financial


def test_reprocessing_after_reversal_is_refused_and_history_kept(client, team, owned_recording, db):
    """D-01 / F-H3: reversed runs' allocations must survive."""
    sid = upload(client, team, b"ISRC,Earnings\nUSAB12600001,10.00\n").json()["id"]
    process(client, team, sid)
    run = client.post(org(team, f"/royalties/statements/{sid}/calculate"), headers=hd(team)).json()
    assert client.post(org(team, f"/royalties/runs/{run['id']}/post"), headers=hd(team, "admin")).status_code == 200
    assert client.post(org(team, f"/royalties/runs/{run['id']}/reverse"), json={"reason": "wrong file"},
                       headers=hd(team, "admin")).status_code == 200
    r = client.post(org(team, f"/royalties/statements/{sid}/process"), headers=hd(team))
    assert r.status_code == 409 and r.json()["error"]["code"] == "statement_has_history"
    db.expire_all()
    assert db.query(RoyaltyAllocation).filter_by(run_id=run["id"]).count() == 1


def test_european_decimals_and_compact_dates_parse_correctly(client, team, owned_recording):
    """F-H2 / F-M1: ';'-delimited EU file: '0,004' is 0.004, '1.234,5' is 1234.5,
    '1.234' units is 1234, and '202612' is December."""
    content = "ISRC;Earnings;Units;Sale Month\nUSAB12600001;0,004;1.234;202612\nUSAB12600001;1.234,5;10;202611\n"
    sid = upload(client, team, content.encode()).json()["id"]
    st = process(client, team, sid)
    assert D(st["total_amount"]) == D("1234.504")
    lines = client.get(org(team, f"/royalties/statements/{sid}/lines"), headers=hd(team)).json()["items"]
    by_row = {line["row_number"]: line for line in lines}
    assert D(by_row[2]["amount"]) == D("0.004") and D(by_row[2]["quantity"]) == D("1234")
    assert by_row[2]["transaction_date"] == "2026-12-01" and by_row[3]["transaction_date"] == "2026-11-01"


def test_formatting_variants_of_an_imported_file_are_duplicates(client, team, owned_recording):
    """F-H5: CRLF / BOM / reordered variants of the same rows are caught."""
    base = "ISRC,Earnings\nUSAB12600001,10.00\nUSAB12600001,5.00\n"
    assert upload(client, team, base.encode()).status_code == 201
    variants = (
        base.replace("\n", "\r\n").encode(),
        b"\xef\xbb\xbf" + base.encode(),
        "ISRC,Earnings\nUSAB12600001,5.00\nUSAB12600001,10.00\n".encode(),
    )
    for variant in variants:
        r = upload(client, team, variant, name="other.csv")
        assert r.status_code == 409 and r.json()["error"]["details"]["match"] == "content"
    # An explicit, audited override is possible.
    assert upload(client, team, variants[0], name="again.csv", allow_duplicate="true").status_code == 201


def test_identical_manual_statements_are_duplicates(client, team, owned_recording):
    body = {"source_name": "Sync", "source_category": "licensing", "period_start": "2026-01-01",
            "period_end": "2026-01-31", "currency": "USD", "lines": [{"title": "Cue", "amount": "100"}]}
    assert client.post(org(team, "/royalties/statements/manual"), json=body, headers=hd(team)).status_code == 201
    assert client.post(org(team, "/royalties/statements/manual"), json=body, headers=hd(team)).status_code == 409
    assert client.post(org(team, "/royalties/statements/manual"), json={**body, "allow_duplicate": True},
                       headers=hd(team)).status_code == 201


def test_statement_total_excludes_other_currencies(client, team, owned_recording):
    """F-M3."""
    content = b"ISRC,Earnings,Currency\nUSAB12600001,100,EUR\nUSAB12600001,50,USD\n"
    st = process(client, team, upload(client, team, content).json()["id"])
    assert D(st["total_amount"]) == D("100")


def test_out_of_range_quantity_is_a_warning_not_a_failed_import(client, team, owned_recording):
    """F-M7."""
    st = process(client, team, upload(client, team, b"ISRC,Earnings,Units\nUSAB12600001,1,1e30\n").json()["id"])
    assert st["status"] == "processed" and st["valid_rows"] == 1


def test_contract_share_outside_term_window_is_held(client, team, owned_recording, db):
    """F-H1 end to end: a line dated before the contract is not paid at 100%."""
    o = team["org_id"]
    contract = Contract(organization_id=o, title="Deal", contract_type="recording", status="active",
                        territories=["WORLD"], rights_granted=["master"], start_date=date(2026, 6, 1))
    db.add(contract)
    db.flush()
    db.add(ContractRoyaltyTerm(organization_id=o, contract_id=contract.id, rate_percent=D("20"), basis="net"))
    share = db.query(OwnershipShare).filter_by(recording_id=owned_recording["recording"].id).one()
    share.contract_id = contract.id
    db.commit()
    content = b"ISRC,Earnings,Sale Month\nUSAB12600001,100,2026-03\nUSAB12600001,100,2026-07\n"
    sid = process(client, team, upload(client, team, content).json()["id"])["id"]
    run = client.post(org(team, f"/royalties/statements/{sid}/calculate"), headers=hd(team)).json()
    assert D(run["total_payable"]) == D("20") and D(run["total_unallocated"]) == D("100")
    assert "no_applicable_contract_term" in {w.get("reason") for w in run["warnings"] or []}


def test_contract_delete_and_term_removal_protect_history(client, team, owned_recording, db):
    """F-H4 / D-07."""
    o = team["org_id"]
    contract = Contract(organization_id=o, title="Deal", contract_type="recording", status="active",
                        territories=["WORLD"], rights_granted=["master"])
    db.add(contract)
    db.flush()
    term = ContractRoyaltyTerm(organization_id=o, contract_id=contract.id, rate_percent=D("20"), basis="net")
    db.add(term)
    share = db.query(OwnershipShare).filter_by(recording_id=owned_recording["recording"].id).one()
    share.contract_id = contract.id
    db.commit()
    r = client.delete(org(team, f"/contracts/{contract.id}"), headers=hd(team, "admin"))
    assert r.status_code == 409 and r.json()["error"]["code"] == "contract_in_use"

    sid = process(client, team, upload(client, team, b"ISRC,Earnings\nUSAB12600001,100\n").json()["id"])["id"]
    run = client.post(org(team, f"/royalties/statements/{sid}/calculate"), headers=hd(team)).json()
    assert client.post(org(team, f"/royalties/runs/{run['id']}/post"), headers=hd(team, "admin")).status_code == 200
    r = client.patch(org(team, f"/contracts/{contract.id}"), json={"royalty_terms": []}, headers=hd(team))
    assert r.status_code == 409 and r.json()["error"]["code"] == "term_in_use"
    db.expire_all()
    assert db.query(RoyaltyAllocation).filter_by(contract_term_id=term.id).count() == 2  # payable + retention kept


def test_generic_job_cancel_cannot_strand_a_statement(client, team, owned_recording):
    """AF-06."""
    sid = upload(client, team, b"ISRC,Earnings\nUSAB12600001,1\n").json()["id"]
    st = client.post(org(team, f"/royalties/statements/{sid}/process"), headers=hd(team)).json()
    r = client.post(org(team, f"/jobs/{st['job_id']}/cancel"), headers=hd(team))
    assert r.status_code == 409 and r.json()["error"]["code"] == "cancel_from_owner"
    assert client.post(org(team, f"/royalties/statements/{sid}/cancel"), headers=hd(team)).status_code == 200


def test_stale_jobs_use_heartbeat_and_exhausted_jobs_fail(team, db):
    """D-06 / AF-05."""
    from app.services.jobs import enqueue, recover_stale_jobs

    old = utc_now() - timedelta(hours=2)
    healthy = enqueue(db, organization_id=team["org_id"], job_type="report_generation", payload={})
    exhausted = enqueue(db, organization_id=team["org_id"], job_type="report_generation", payload={})
    for job, attempts, updated in ((healthy, 1, utc_now()), (exhausted, 3, old)):
        db.query(BackgroundJob).filter_by(id=job.id).update(
            {"status": "running", "attempts": attempts, "locked_by": "w1", "started_at": old,
             "updated_at": updated})
    db.commit()
    assert recover_stale_jobs(db) == 1
    db.expire_all()
    assert db.get(BackgroundJob, healthy.id).status == "running"  # heartbeat is recent
    assert db.get(BackgroundJob, exhausted.id).status == "failed"


# --------------------------------------------------------------------------- uploads / robustness


def _xlsx_bomb() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("xl/sharedStrings.xml", "A" * (250 * 1024 * 1024))
    return buffer.getvalue()


def test_decompression_bomb_is_rejected_before_parsing(client, team):
    """AF-02."""
    r = client.post(org(team, "/royalties/statements"), headers=hd(team),
                    data={"source_name": "X", "source_category": "distributor", "period_start": "2026-01-01",
                          "period_end": "2026-01-31", "currency": "USD"},
                    files={"file": ("bomb.xlsx", _xlsx_bomb(),
                                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert r.status_code == 422 and r.json()["error"]["code"] == "file_too_complex"


def test_docx_with_utf16_dtd_entities_is_rejected():
    """AF-03: the byte-level DOCTYPE check missed UTF-16 documents."""
    from app.services.document_text import TextExtractionError, extract_text

    xml = ('<?xml version="1.0" encoding="UTF-16"?><!DOCTYPE d [<!ENTITY a "XXXXXXXXXX">]>'
           '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
           '<w:body><w:p><w:r><w:t>&a;</w:t></w:r></w:p></w:body></w:document>').encode("utf-16")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("word/document.xml", xml)
    with pytest.raises(TextExtractionError):
        extract_text(buffer.getvalue(), ".docx")


def test_statement_download_with_non_latin_filename(client, team):
    """AF-09."""
    r = upload(client, team, b"ISRC,Earnings\nUSAB12600001,1\n", name="отчёт_報告.csv")
    assert r.status_code == 201
    dl = client.get(org(team, f"/royalties/statements/{r.json()['id']}/download"), headers=hd(team))
    assert dl.status_code == 200 and "filename*=UTF-8''" in dl.headers["content-disposition"]


@pytest.mark.parametrize("value", ["NaN", "Infinity", "1e999999"])
def test_non_finite_reported_total_is_422(client, team, value):
    """AF-10."""
    r = upload(client, team, b"ISRC,Earnings\nUSAB12600001,1\n", name=f"{value}.csv", reported_total=value)
    assert r.status_code == 422


def test_oversized_csv_field_is_422(client, team):
    """AF-11."""
    content = b'ISRC,Earnings\n"' + b"A" * 200_000 + b'",1\n'
    assert upload(client, team, content).status_code == 422


def test_boundary_dates_do_not_500(client, team, owned_recording):
    """AF-12."""
    r = client.post(org(team, "/rights/shares"), headers=hd(team), json={
        "recording_id": owned_recording["recording"].id, "party_id": owned_recording["artist"].id,
        "role": "artist", "rights_type": "sync", "share_percent": "10", "territories": ["WORLD"],
        "effective_from": "0001-01-01"})
    assert r.status_code < 500


# --------------------------------------------------------------------------- platform


def test_database_session_is_strict_and_read_committed(db):
    """D-03 / D-04."""
    from sqlalchemy import text

    mode, isolation = db.execute(text("SELECT @@SESSION.sql_mode, @@SESSION.tx_isolation")).one()
    assert "STRICT_TRANS_TABLES" in mode and isolation == "READ-COMMITTED"


def test_ai_usage_is_reserved_before_the_provider_call(client, team, db, fake_ai):
    """AF-07: the limit check and the usage row are atomic, so concurrent
    requests can't all slip under the monthly limit."""
    from app.models.billing import AIUsageRecord, Plan, Subscription
    from app.services.billing import get_subscription

    starter = db.query(Plan).filter_by(code="dev-starter").one()
    get_subscription(db, team["org_id"])
    db.query(Subscription).filter_by(organization_id=team["org_id"]).update({"plan_id": starter.id})
    limit = starter.limits["max_ai_requests_per_month"]
    for _ in range(limit - 1):
        db.add(AIUsageRecord(organization_id=team["org_id"], feature="x", provider="fake", model="m",
                             status="success"))
    db.commit()
    seen = []
    original = fake_ai.generate_json

    def during_call(**kwargs):
        with db.bind.connect() as conn:
            from sqlalchemy import func, select

            seen.append(conn.execute(select(func.count()).select_from(AIUsageRecord).where(
                AIUsageRecord.organization_id == team["org_id"])).scalar())
        return original(**kwargs)

    fake_ai.generate_json = during_call
    client.post(org(team, "/ai/search"), json={"query": "songs"}, headers=hd(team))
    assert seen == [limit]  # this call's slot was reserved before the provider ran
    assert client.post(org(team, "/ai/search"), json={"query": "more"}, headers=hd(team)).status_code == 402


def test_unexpected_provider_exception_is_502_with_usage(client, team, db, fake_ai):
    """AF-08."""
    from app.models.billing import AIUsageRecord

    fake_ai.error = IndexError("list index out of range")
    r = client.post(org(team, "/ai/search"), json={"query": "xy"}, headers=hd(team))
    assert r.status_code == 502
    db.expire_all()
    assert db.query(AIUsageRecord).filter_by(organization_id=team["org_id"], status="error").count() == 1


def test_csv_export_keeps_negative_numbers_numeric():
    """F-M8: refunds exported as '-12.50 became text in spreadsheets."""
    from app.services.statement_parsing import neutralize_formula

    assert neutralize_formula("-12.50") == "-12.50"
    assert neutralize_formula("+3") == "+3"
    for hostile in ("=1+2", "-2+3", "@SUM(A1)", "-1;=cmd", "+cmd|' /C calc'!A0"):
        assert neutralize_formula(hostile) == "'" + hostile
