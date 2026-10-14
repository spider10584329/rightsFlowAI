"""Payout batches with an approval workflow on top of the internal ledger.

Workflow: draft → pending_approval → approved → paid (or cancelled).

No money is moved by this system. "Paid" means an authorized user confirmed
that payment was executed outside RightsFlow (bank transfer, PayPal, ...);
only then are negative ``payout`` ledger entries written. A provider adapter
interface exists for future integrations; the only built-in provider is the
internal ledger, which refuses to execute payments.
"""

import csv
import io
import secrets
from decimal import ROUND_DOWN, Decimal
from typing import Protocol

from fastapi import Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.errors import (
    ConflictError,
    NotFoundError,
    PermissionDeniedError,
    ServiceUnavailableError,
    ValidationFailedError,
)
from app.core.permissions import OrgContext
from app.db.mixins import utc_now
from app.models.royalty import LedgerEntry, Payee, Payout, PayoutBatch
from app.services import ledger
from app.services.audit import record_audit
from app.services.notifications import notify_org
from app.services.organization_service import org_settings
from app.services.reference import currency_minor_unit
from app.services.statement_parsing import neutralize_formula



class PaymentProvider(Protocol):
    name: str

    def execute(self, batch: PayoutBatch) -> None: ...


class InternalLedgerProvider:
    """Records payouts in the ledger only; never transfers money."""

    name = "internal"

    def execute(self, batch: PayoutBatch) -> None:
        raise ServiceUnavailableError(
            "No payment provider is connected. Pay recipients outside RightsFlow, then record the "
            "batch as paid.", code="payment_provider_not_configured")


def get_payment_provider() -> PaymentProvider:
    return InternalLedgerProvider()


def get_batch(db: Session, organization_id: str, batch_id: str, *, lock: bool = False) -> PayoutBatch:
    stmt = select(PayoutBatch).where(PayoutBatch.id == batch_id, PayoutBatch.organization_id == organization_id)
    if lock:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    batch = db.scalar(stmt)
    if batch is None:
        raise NotFoundError("Payout batch not found")
    return batch


def _cents(value: Decimal, currency: str) -> Decimal:
    """Round down to the currency's minor unit: a JPY payout can't be 1234.56 yen (audit F-L6)."""
    return value.quantize(currency_minor_unit(currency), rounding=ROUND_DOWN)


def _reference(db: Session, organization_id: str) -> str:
    today = utc_now().strftime("%Y%m%d")
    count = db.scalar(select(func.count()).select_from(PayoutBatch).where(
        PayoutBatch.organization_id == organization_id,
        PayoutBatch.reference.like(f"PB-{today}-%"))) or 0
    # Random suffix: concurrent creators can't collide on the unique reference.
    return f"PB-{today}-{count + 1:03d}-{secrets.token_hex(2).upper()}"


def _recalculate(batch: PayoutBatch) -> None:
    active = [p for p in batch.payouts if p.status == "pending"]
    batch.total_amount = sum((p.amount for p in active), Decimal("0"))
    batch.payout_count = len(active)


def create_batch(db: Session, ctx: OrgContext, currency: str, payee_ids: list[str] | None,
                 notes: str | None, request: Request | None) -> PayoutBatch:
    stmt = select(Payee).where(Payee.organization_id == ctx.organization_id, Payee.is_active.is_(True))
    if payee_ids:
        stmt = stmt.where(Payee.id.in_(payee_ids))
    payees = db.scalars(stmt.with_for_update().execution_options(populate_existing=True)).all()
    if payee_ids and len(payees) != len(set(payee_ids)):
        raise NotFoundError("One or more payees were not found")
    available = ledger.balances(db, ctx.organization_id, [p.id for p in payees])
    batch = PayoutBatch(organization_id=ctx.organization_id, reference=_reference(db, ctx.organization_id),
                        currency=currency, notes=notes, created_by_id=ctx.user.id, provider="internal")
    db.add(batch)
    db.flush()
    skipped: list[dict] = []
    for payee in sorted(payees, key=lambda p: p.display_name.lower()):
        amount = _cents(available.get(payee.id, {}).get(currency, {}).get("available", Decimal("0")), currency)
        if payee.hold_payments:
            skipped.append({"payee_id": payee.id, "reason": "payments_on_hold"})
            continue
        if amount <= 0:
            continue
        if amount < payee.minimum_payout:
            skipped.append({"payee_id": payee.id, "reason": "below_minimum_payout"})
            continue
        batch.payouts.append(Payout(organization_id=ctx.organization_id, payee_id=payee.id,
                                    amount=amount, currency=currency, status="pending"))
    if not batch.payouts:
        db.rollback()
        raise ValidationFailedError("No payees have an available balance to pay in this currency",
                                    details={"skipped": skipped})
    _recalculate(batch)
    record_audit(db, action="payout_batch.created", actor_user_id=ctx.user.id,
                 organization_id=ctx.organization_id, entity_type="payout_batch", entity_id=batch.id,
                 summary=f"Draft {batch.reference}: {batch.payout_count} payout(s), "
                         f"{batch.total_amount} {currency}",
                 changes={"skipped": skipped} if skipped else None, request=request)
    db.commit()
    db.refresh(batch)
    return batch


def _require_status(batch: PayoutBatch, *statuses: str) -> None:
    if batch.status not in statuses:
        raise ConflictError(f"Batch is {batch.status}; this action requires {' or '.join(statuses)}")


def update_payout_amount(db: Session, ctx: OrgContext, batch_id: str, payout_id: str, amount: Decimal,
                         request: Request | None) -> PayoutBatch:
    batch = get_batch(db, ctx.organization_id, batch_id, lock=True)
    _require_status(batch, "draft")
    payout = next((p for p in batch.payouts if p.id == payout_id), None)
    if payout is None:
        raise NotFoundError("Payout not found")
    available = ledger.balances(db, ctx.organization_id, [payout.payee_id], exclude_batch_id=batch.id)
    limit = _cents(available.get(payout.payee_id, {}).get(batch.currency, {}).get("available", Decimal("0")),
                   batch.currency)
    if amount != _cents(amount, batch.currency):
        places = -currency_minor_unit(batch.currency).as_tuple().exponent
        raise ValidationFailedError(f"{batch.currency} amounts can have at most {places} decimal places",
                                    code="invalid_currency_precision")
    if amount > limit:
        raise ValidationFailedError(f"Amount exceeds the available balance of {limit} {batch.currency}")
    previous = payout.amount
    payout.amount = amount
    _recalculate(batch)
    record_audit(db, action="payout_batch.payout_amended", actor_user_id=ctx.user.id,
                 organization_id=ctx.organization_id, entity_type="payout_batch", entity_id=batch.id,
                 changes={"payout_id": payout.id, "amount": {"from": previous, "to": amount}},
                 request=request)
    db.commit()
    db.refresh(batch)
    return batch


def remove_payout(db: Session, ctx: OrgContext, batch_id: str, payout_id: str,
                  request: Request | None) -> PayoutBatch:
    batch = get_batch(db, ctx.organization_id, batch_id, lock=True)
    _require_status(batch, "draft")
    payout = next((p for p in batch.payouts if p.id == payout_id), None)
    if payout is None:
        raise NotFoundError("Payout not found")
    batch.payouts.remove(payout)
    _recalculate(batch)
    record_audit(db, action="payout_batch.payout_removed", actor_user_id=ctx.user.id,
                 organization_id=ctx.organization_id, entity_type="payout_batch", entity_id=batch.id,
                 request=request)
    db.commit()
    db.refresh(batch)
    return batch


def submit(db: Session, ctx: OrgContext, batch_id: str, request: Request | None) -> PayoutBatch:
    batch = get_batch(db, ctx.organization_id, batch_id, lock=True)
    _require_status(batch, "draft")
    if not batch.payout_count:
        raise ValidationFailedError("The batch has no payouts")
    batch.status = "pending_approval"
    batch.submitted_at = utc_now()
    record_audit(db, action="payout_batch.submitted", actor_user_id=ctx.user.id,
                 organization_id=ctx.organization_id, entity_type="payout_batch", entity_id=batch.id,
                 request=request)
    notify_org(db, organization_id=ctx.organization_id, type="payout_approval_request",
               title=f"Payout batch {batch.reference} needs approval",
               body=f"{batch.payout_count} payout(s) totalling {batch.total_amount} {batch.currency}.",
               link=f"/payouts/{batch.id}", minimum_role="admin", exclude_user_ids=[ctx.user.id])
    db.commit()
    db.refresh(batch)
    return batch


def _lock_payees(db: Session, payee_ids: list[str]) -> None:
    """Serialize with other balance-changing operations (adjustments,
    advances, run reversals) before checking or spending balances."""
    if payee_ids:
        db.execute(select(Payee.id).where(Payee.id.in_(sorted(set(payee_ids))))
                   .order_by(Payee.id).with_for_update())


def _assert_funds(db: Session, ctx: OrgContext, batch: PayoutBatch) -> None:
    _lock_payees(db, [p.payee_id for p in batch.payouts])
    available = ledger.balances(db, ctx.organization_id, [p.payee_id for p in batch.payouts],
                                exclude_batch_id=batch.id)
    short = []
    for payout in batch.payouts:
        if payout.status != "pending":
            continue
        have = available.get(payout.payee_id, {}).get(batch.currency, {}).get("available", Decimal("0"))
        if payout.amount > have:
            short.append({"payout_id": payout.id, "payee_id": payout.payee_id,
                          "requested": str(payout.amount), "available": str(have)})
    if short:
        raise ConflictError("Some payees no longer have enough available balance",
                            code="insufficient_balance", details=short)
    # Holds and deactivations set after the batch was drafted still apply (audit F-L3).
    pending_ids = {p.payee_id for p in batch.payouts if p.status == "pending"}
    blocked = [
        {"payee_id": payee.id, "reason": "payments_on_hold" if payee.hold_payments else "payee_inactive"}
        for payee in db.scalars(select(Payee).where(Payee.id.in_(pending_ids))
                                .execution_options(populate_existing=True)).all()
        if payee.hold_payments or not payee.is_active
    ]
    if blocked:
        raise ConflictError("Some payees are on hold or inactive; remove their payouts from the batch first",
                            code="payee_not_payable", details=blocked)


def approve(db: Session, ctx: OrgContext, batch_id: str, request: Request | None) -> PayoutBatch:
    batch = get_batch(db, ctx.organization_id, batch_id, lock=True)
    _require_status(batch, "pending_approval")
    if org_settings(ctx.organization).require_distinct_payout_approver and batch.created_by_id == ctx.user.id:
        raise PermissionDeniedError(
            "Payouts must be approved by someone other than their creator (organization setting)",
            code="distinct_approver_required")
    _assert_funds(db, ctx, batch)
    batch.status = "approved"
    batch.approved_by_id = ctx.user.id
    batch.approved_at = utc_now()
    record_audit(db, action="payout_batch.approved", actor_user_id=ctx.user.id,
                 organization_id=ctx.organization_id, entity_type="payout_batch", entity_id=batch.id,
                 summary=f"Approved {batch.reference} ({batch.total_amount} {batch.currency})",
                 request=request)
    db.commit()
    db.refresh(batch)
    return batch


def mark_paid(db: Session, ctx: OrgContext, batch_id: str, payment_date, references: dict[str, str] | None,
              notes: str | None, request: Request | None) -> PayoutBatch:
    batch = get_batch(db, ctx.organization_id, batch_id, lock=True)
    _require_status(batch, "approved")
    _assert_funds(db, ctx, batch)
    references = references or {}
    for payout in batch.payouts:
        if payout.status != "pending":
            continue
        payout.status = "paid"
        payout.external_reference = (references.get(payout.id) or None)
        ledger.add_entry(
            db, organization_id=ctx.organization_id, payee_id=payout.payee_id, entry_type="payout",
            amount=-payout.amount, currency=payout.currency, effective_date=payment_date,
            description=f"Payout {batch.reference}" + (f" ({payout.external_reference})"
                                                       if payout.external_reference else ""),
            created_by_id=ctx.user.id, payout_id=payout.id,
        )
    batch.status = "paid"
    batch.paid_by_id = ctx.user.id
    batch.paid_at = utc_now()
    if notes:
        batch.notes = ((batch.notes or "") + f"\nPayment note: {notes}").strip()
    record_audit(db, action="payout_batch.recorded_paid", actor_user_id=ctx.user.id,
                 organization_id=ctx.organization_id, entity_type="payout_batch", entity_id=batch.id,
                 summary=f"Recorded {batch.reference} as paid externally "
                         f"({batch.total_amount} {batch.currency})", request=request)
    db.commit()
    db.refresh(batch)
    return batch


def cancel(db: Session, ctx: OrgContext, batch_id: str, request: Request | None) -> PayoutBatch:
    batch = get_batch(db, ctx.organization_id, batch_id, lock=True)
    _require_status(batch, "draft", "pending_approval", "approved")
    if batch.status == "approved" and not ctx.has_role("admin"):
        raise PermissionDeniedError("Only admins can cancel approved batches")
    for payout in batch.payouts:
        if payout.status == "pending":
            payout.status = "cancelled"
    batch.status = "cancelled"
    batch.cancelled_at = utc_now()
    record_audit(db, action="payout_batch.cancelled", actor_user_id=ctx.user.id,
                 organization_id=ctx.organization_id, entity_type="payout_batch", entity_id=batch.id,
                 request=request)
    db.commit()
    db.refresh(batch)
    return batch


def remittance_csv(db: Session, batch: PayoutBatch) -> str:
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(["Batch", "Status", "Payee", "Email", "Payment method", "Bank / reference",
                     "Amount", "Currency", "Payout status", "External reference"])
    for payout in sorted(batch.payouts, key=lambda p: p.payee.display_name.lower()):
        reference = payout.payee.payment_reference or {}
        ref_text = " ".join(f"{k}={v}" for k, v in sorted(reference.items()))
        writer.writerow([neutralize_formula(str(x)) for x in [
            batch.reference, batch.status, payout.payee.display_name, payout.payee.email or "",
            payout.payee.payment_method, ref_text, format(payout.amount, "f"), payout.currency,
            payout.status, payout.external_reference or "",
        ]])
    return out.getvalue()


def payout_advice_csv(db: Session, batch: PayoutBatch, payout: Payout) -> str:
    """Remittance advice: ledger activity included in this payout: entries
    after the payee's previous payout and up to this payout's own ledger
    entry (or up to now while it is unpaid).

    The window is anchored on this payout, so advice for an older payout is
    not emptied by later payouts (audit F-M4)."""
    own_entry_at = db.scalar(select(LedgerEntry.created_at).where(
        LedgerEntry.payout_id == payout.id, LedgerEntry.entry_type == "payout"))
    previous_stmt = select(func.max(LedgerEntry.created_at)).where(
        LedgerEntry.payee_id == payout.payee_id, LedgerEntry.entry_type == "payout",
        LedgerEntry.currency == payout.currency, LedgerEntry.payout_id != payout.id)
    if own_entry_at is not None:
        previous_stmt = previous_stmt.where(LedgerEntry.created_at < own_entry_at)
    previous_payout_at = db.scalar(previous_stmt)
    stmt = select(LedgerEntry).where(
        LedgerEntry.payee_id == payout.payee_id, LedgerEntry.currency == payout.currency,
        LedgerEntry.entry_type != "payout")
    if previous_payout_at is not None:
        stmt = stmt.where(LedgerEntry.created_at > previous_payout_at)
    if own_entry_at is not None:
        stmt = stmt.where(LedgerEntry.created_at <= own_entry_at)
    entries = db.scalars(stmt.order_by(LedgerEntry.effective_date, LedgerEntry.created_at)).all()
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(["Remittance advice", batch.reference])
    writer.writerow(["Payee", neutralize_formula(payout.payee.display_name)])
    writer.writerow(["Payout amount", format(payout.amount, "f"), payout.currency])
    writer.writerow(["Status", payout.status])
    writer.writerow([])
    writer.writerow(["Date", "Type", "Description", "Amount", "Currency"])
    for entry in entries:
        writer.writerow([entry.effective_date.isoformat(), entry.entry_type,
                         neutralize_formula(entry.description), format(entry.amount, "f"), entry.currency])
    return out.getvalue()
