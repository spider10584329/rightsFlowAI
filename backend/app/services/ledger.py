"""Payee profiles and the immutable payee ledger.

Balance semantics (per payee and currency):
    balance = SUM(ledger_entries.amount)
- earnings (+), adjustments (±), advances (−), payouts (−), reversals (negated originals).
- A negative balance after an advance is the unrecouped amount; future earnings
  recoup it automatically (cross-collateralized at payee + currency level).
- ``available`` = balance − amounts already committed to open payout batches.
Calculated balances are accounting figures, not confirmations of bank payments.
"""

from collections import defaultdict
from datetime import date
from decimal import Decimal

from fastapi import Request
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session, aliased

from app.core.errors import ConflictError, NotFoundError, ValidationFailedError
from app.core.permissions import OrgContext
from app.db.mixins import utc_now
from app.models.catalog import Party
from app.models.contract import Contract
from app.models.royalty import LedgerEntry, Payee, Payout, PayoutBatch
from app.services.audit import diff, record_audit, snapshot

OPEN_BATCH_STATUSES = ("draft", "pending_approval", "approved")
ZERO = Decimal("0")
PAYEE_FIELDS = [
    "display_name", "email", "payment_method", "payment_reference", "currency",
    "minimum_payout", "hold_payments", "tax_form_status", "notes", "is_active",
]


def get_payee(db: Session, organization_id: str, payee_id: str, *, lock: bool = False) -> Payee:
    stmt = select(Payee).where(Payee.id == payee_id, Payee.organization_id == organization_id)
    if lock:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    payee = db.scalar(stmt)
    if payee is None:
        raise NotFoundError("Payee not found")
    return payee


def get_party(db: Session, organization_id: str, party_id: str) -> Party:
    party = db.scalar(select(Party).where(Party.id == party_id, Party.organization_id == organization_id))
    if party is None:
        raise NotFoundError("Party not found")
    return party


def create_payee(db: Session, ctx: OrgContext, data: dict, request: Request | None) -> Payee:
    party = get_party(db, ctx.organization_id, data["party_id"])
    if party.is_internal:
        raise ValidationFailedError("Internal parties retain income and cannot be payees")
    if db.scalar(select(Payee.id).where(Payee.organization_id == ctx.organization_id,
                                        Payee.party_id == party.id)):
        raise ConflictError("This party already has a payee profile")
    data = dict(data)
    data["display_name"] = data.get("display_name") or party.name
    data["email"] = data.get("email") or party.email
    payee = Payee(organization_id=ctx.organization_id, **data)
    db.add(payee)
    db.flush()
    record_audit(db, action="payee.created", actor_user_id=ctx.user.id,
                 organization_id=ctx.organization_id, entity_type="payee", entity_id=payee.id,
                 summary=f"Created payee {payee.display_name}", request=request)
    db.commit()
    db.refresh(payee)
    return payee


def ensure_payee_for_party(db: Session, organization_id: str, party: Party, currency: str) -> Payee:
    payee = db.scalar(select(Payee).where(Payee.organization_id == organization_id,
                                          Payee.party_id == party.id))
    if payee is None:
        payee = Payee(organization_id=organization_id, party_id=party.id, display_name=party.name,
                      email=party.email, currency=currency)
        db.add(payee)
        db.flush()
    return payee


def update_payee(db: Session, ctx: OrgContext, payee: Payee, changes: dict, request: Request | None) -> Payee:
    before = snapshot(payee, PAYEE_FIELDS)
    for key, value in changes.items():
        if key in ("display_name", "payment_method", "currency", "minimum_payout",
                   "hold_payments", "is_active") and value is None:
            continue
        setattr(payee, key, value)
    after = snapshot(payee, PAYEE_FIELDS)
    record_audit(db, action="payee.updated", actor_user_id=ctx.user.id,
                 organization_id=ctx.organization_id, entity_type="payee", entity_id=payee.id,
                 changes=diff(before, after), request=request)
    db.commit()
    db.refresh(payee)
    return payee


# --------------------------------------------------------------------------- balances


def balances(db: Session, organization_id: str, payee_ids: list[str] | None = None,
             *, exclude_batch_id: str | None = None) -> dict[str, dict[str, dict[str, Decimal]]]:
    """{payee_id: {currency: {balance, pending_payouts, available, ...}}}

    A reversal counts against the type of the entry it reverses, so
    lifetime earnings and advances are net of reversed runs/advances
    (audit F-L1)."""
    original = aliased(LedgerEntry)
    kind = case((LedgerEntry.entry_type == "reversal", original.entry_type), else_=LedgerEntry.entry_type)
    stmt = (
        select(
            LedgerEntry.payee_id,
            LedgerEntry.currency,
            func.coalesce(func.sum(LedgerEntry.amount), 0),
            func.coalesce(func.sum(case((kind == "earning", LedgerEntry.amount), else_=0)), 0),
            func.coalesce(func.sum(case((kind == "payout", LedgerEntry.amount), else_=0)), 0),
            func.coalesce(func.sum(case((kind == "advance", LedgerEntry.amount), else_=0)), 0),
        )
        .outerjoin(original, original.id == LedgerEntry.reversal_of_id)
        .where(LedgerEntry.organization_id == organization_id)
        .group_by(LedgerEntry.payee_id, LedgerEntry.currency)
    )
    if payee_ids is not None:
        stmt = stmt.where(LedgerEntry.payee_id.in_(payee_ids))
    result: dict[str, dict[str, dict[str, Decimal]]] = defaultdict(dict)
    for payee_id, currency, total, earnings, payouts, advances in db.execute(stmt).all():
        result[payee_id][currency] = {
            "balance": Decimal(total),
            "lifetime_earnings": Decimal(earnings),
            "lifetime_payouts": -Decimal(payouts),
            "advances": -Decimal(advances),
            "pending_payouts": ZERO,
        }
    pending_stmt = (
        select(Payout.payee_id, Payout.currency, func.sum(Payout.amount))
        .join(PayoutBatch, PayoutBatch.id == Payout.batch_id)
        .where(Payout.organization_id == organization_id,
               PayoutBatch.status.in_(OPEN_BATCH_STATUSES), Payout.status == "pending")
        .group_by(Payout.payee_id, Payout.currency)
    )
    if exclude_batch_id:
        pending_stmt = pending_stmt.where(Payout.batch_id != exclude_batch_id)
    if payee_ids is not None:
        pending_stmt = pending_stmt.where(Payout.payee_id.in_(payee_ids))
    for payee_id, currency, pending in db.execute(pending_stmt).all():
        row = result[payee_id].setdefault(currency, {
            "balance": ZERO, "lifetime_earnings": ZERO, "lifetime_payouts": ZERO,
            "advances": ZERO, "pending_payouts": ZERO,
        })
        row["pending_payouts"] = Decimal(pending)
    for per_currency in result.values():
        for row in per_currency.values():
            row["available"] = max(ZERO, row["balance"] - row["pending_payouts"])
            row["unrecouped_advances"] = max(ZERO, -row["balance"]) if row["advances"] > 0 else ZERO
    return result


def balance_rows(per_currency: dict[str, dict[str, Decimal]]) -> list[dict]:
    return [
        {"currency": currency, **{k: v for k, v in values.items() if k != "advances"}}
        for currency, values in sorted(per_currency.items())
    ]


# --------------------------------------------------------------------------- entries


def add_entry(db: Session, *, organization_id: str, payee_id: str, entry_type: str, amount: Decimal,
              currency: str, description: str, effective_date: date | None = None,
              created_by_id: str | None = None, run_id: str | None = None,
              payout_id: str | None = None, contract_id: str | None = None,
              reversal_of_id: str | None = None) -> LedgerEntry:
    entry = LedgerEntry(
        organization_id=organization_id, payee_id=payee_id, entry_type=entry_type,
        amount=amount, currency=currency, description=description[:500],
        effective_date=effective_date or utc_now().date(), created_by_id=created_by_id,
        run_id=run_id, payout_id=payout_id, contract_id=contract_id, reversal_of_id=reversal_of_id,
    )
    db.add(entry)
    return entry


def record_adjustment(db: Session, ctx: OrgContext, payee_id: str, amount: Decimal, currency: str,
                      description: str, effective_date: date | None, request: Request | None) -> LedgerEntry:
    payee = get_payee(db, ctx.organization_id, payee_id, lock=True)
    entry = add_entry(db, organization_id=ctx.organization_id, payee_id=payee.id,
                      entry_type="adjustment", amount=amount, currency=currency,
                      description=description, effective_date=effective_date,
                      created_by_id=ctx.user.id)
    db.flush()
    record_audit(db, action="ledger.adjustment", actor_user_id=ctx.user.id,
                 organization_id=ctx.organization_id, entity_type="ledger_entry", entity_id=entry.id,
                 summary=f"Adjustment {amount} {currency} for {payee.display_name}: {description}",
                 request=request)
    db.commit()
    db.refresh(entry)
    return entry


def record_advance(db: Session, ctx: OrgContext, payee_id: str, amount: Decimal, currency: str,
                   contract_id: str | None, description: str, effective_date: date | None,
                   request: Request | None) -> LedgerEntry:
    payee = get_payee(db, ctx.organization_id, payee_id, lock=True)
    if contract_id and db.scalar(select(Contract.id).where(
            Contract.id == contract_id, Contract.organization_id == ctx.organization_id)) is None:
        raise NotFoundError("Contract not found")
    entry = add_entry(db, organization_id=ctx.organization_id, payee_id=payee.id,
                      entry_type="advance", amount=-amount, currency=currency,
                      description=description, effective_date=effective_date,
                      created_by_id=ctx.user.id, contract_id=contract_id)
    db.flush()
    record_audit(db, action="ledger.advance", actor_user_id=ctx.user.id,
                 organization_id=ctx.organization_id, entity_type="ledger_entry", entity_id=entry.id,
                 summary=f"Recoupable advance {amount} {currency} to {payee.display_name}",
                 request=request)
    db.commit()
    db.refresh(entry)
    return entry


def reverse_entry(db: Session, ctx: OrgContext, entry_id: str, reason: str,
                  request: Request | None) -> LedgerEntry:
    entry = db.scalar(select(LedgerEntry).where(
        LedgerEntry.id == entry_id, LedgerEntry.organization_id == ctx.organization_id)
        .with_for_update().execution_options(populate_existing=True))
    if entry is None:
        raise NotFoundError("Ledger entry not found")
    if entry.entry_type not in ("adjustment", "advance"):
        raise ConflictError("Only manual adjustments and advances can be reversed here; reverse "
                            "royalty runs or cancel payouts instead")
    if db.scalar(select(LedgerEntry.id).where(LedgerEntry.reversal_of_id == entry.id)):
        raise ConflictError("This entry has already been reversed")
    reversal = add_entry(db, organization_id=ctx.organization_id, payee_id=entry.payee_id,
                         entry_type="reversal", amount=-entry.amount, currency=entry.currency,
                         description=f"Reversal: {reason}", created_by_id=ctx.user.id,
                         contract_id=entry.contract_id, reversal_of_id=entry.id)
    db.flush()
    record_audit(db, action="ledger.reversed", actor_user_id=ctx.user.id,
                 organization_id=ctx.organization_id, entity_type="ledger_entry", entity_id=entry.id,
                 summary=f"Reversed {entry.entry_type} {entry.amount} {entry.currency}: {reason}",
                 request=request)
    db.commit()
    db.refresh(reversal)
    return reversal


def statement_of_account(db: Session, organization_id: str, payee_id: str, currency: str | None,
                         start: date | None, end: date | None) -> list[dict]:
    """Ledger entries with running balance (per currency), oldest first."""
    stmt = select(LedgerEntry).where(LedgerEntry.organization_id == organization_id,
                                     LedgerEntry.payee_id == payee_id)
    if currency:
        stmt = stmt.where(LedgerEntry.currency == currency)
    entries = db.scalars(stmt.order_by(LedgerEntry.effective_date, LedgerEntry.created_at,
                                       LedgerEntry.id)).all()
    reversed_ids = set(db.scalars(select(LedgerEntry.reversal_of_id).where(
        LedgerEntry.organization_id == organization_id, LedgerEntry.payee_id == payee_id,
        LedgerEntry.reversal_of_id.is_not(None))).all())
    running: dict[str, Decimal] = defaultdict(lambda: ZERO)
    rows = []
    for entry in entries:
        running[entry.currency] += entry.amount
        if start and entry.effective_date < start:
            continue
        if end and entry.effective_date > end:
            continue
        rows.append({"entry": entry, "running_balance": running[entry.currency],
                     "reversed": entry.id in reversed_ids})
    return rows
