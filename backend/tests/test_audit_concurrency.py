"""Audit regressions for database concurrency and referential gaps (D-05, D-09, D-12)."""

from decimal import Decimal as D

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import OperationalError

from app.db.session import SessionLocal
from app.models.billing import Subscription
from app.models.catalog import Party, Work
from app.models.rights import OwnershipShare, SplitSheet


@pytest.fixture
def work_with_share(db, team):
    org = team["org_id"]
    party = Party(organization_id=org, name="Writer")
    work = Work(organization_id=org, title="Locked Song")
    db.add_all([party, work])
    db.flush()
    share = OwnershipShare(organization_id=org, work_id=work.id, party_id=party.id, role="writer",
                           rights_type="performance", share_percent=D("50"), territories=["WORLD"])
    db.add(share)
    db.commit()
    return {"org": org, "party": party, "work": work, "share": share}


def test_share_writes_lock_the_asset_first(work_with_share):
    """D-05: blocking split rules are only safe if share writes on one asset are serialized."""
    from app.services.rights import get_share_for_write

    data = work_with_share
    with SessionLocal() as writer, SessionLocal() as other:
        get_share_for_write(writer, data["org"], data["share"].id)
        other.execute(text("SET SESSION innodb_lock_wait_timeout = 1"))
        with pytest.raises(OperationalError) as excinfo:
            other.execute(select(Work.id).where(Work.id == data["work"].id).with_for_update())
        assert excinfo.value.orig.args[0] == 1205  # lock wait timeout: the writer holds the asset
        writer.rollback()


def test_losing_the_subscription_create_race_keeps_the_transaction(team, db, monkeypatch):
    """D-09: a concurrent lazy-create hits uq_subscription_org; the caller recovers."""
    from app.services import billing

    org = team["org_id"]
    existing = db.scalar(select(Subscription).where(Subscription.organization_id == org))
    assert existing is not None
    real_scalar = db.scalar
    calls = {"n": 0}

    def first_lookup_misses(stmt, *args, **kwargs):
        calls["n"] += 1
        return None if calls["n"] == 1 else real_scalar(stmt, *args, **kwargs)

    monkeypatch.setattr(db, "scalar", first_lookup_misses)
    subscription = billing.get_subscription(db, org)
    assert subscription.id == existing.id
    db.execute(text("SELECT 1"))  # the outer transaction is still usable


def test_party_on_a_split_sheet_cannot_be_deleted(client, team, work_with_share, db):
    """D-12: split-sheet entries are JSON, so deletion must check them explicitly."""
    data = work_with_share
    lone = Party(organization_id=data["org"], name="Sheet Only")
    db.add(lone)
    db.flush()
    db.add(SplitSheet(organization_id=data["org"], work_id=data["work"].id, title="Session sheet",
                      entries=[{"party_id": lone.id, "role": "writer", "share_percent": "50"}]))
    db.commit()
    response = client.delete(f"/api/v1/organizations/{data['org']}/parties/{lone.id}",
                             headers=team["admin"]["headers"])
    assert response.status_code == 409, response.text
    assert "split sheets" in response.json()["error"]["message"]
