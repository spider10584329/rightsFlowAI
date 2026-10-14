"""Royalty calculation runs: calculate → verify → post to ledger → reverse.

All steps run in a single database transaction with the statement row locked
(``SELECT ... FOR UPDATE``), so concurrent calculations or double posting are
impossible. A unique ``posting_key`` additionally guarantees at most one posted
run per statement at the database level.
"""

from collections import Counter, defaultdict
from decimal import Decimal

from fastapi import Request
from sqlalchemy import insert, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.errors import ConflictError, NotFoundError, ValidationFailedError
from app.core.logging import get_logger
from app.core.permissions import OrgContext
from app.db.mixins import new_uuid, utc_now
from app.models.catalog import Party, RecordingWork
from app.models.contract import Contract, ContractRoyaltyTerm
from app.models.rights import OwnershipShare
from app.models.royalty import (
    LedgerEntry,
    Payee,
    RoyaltyAllocation,
    RoyaltyRun,
    RoyaltyStatement,
    StatementLine,
)
from app.services import ledger
from app.services.audit import record_audit
from app.services.notifications import notify_org
from app.services.organization_service import org_settings
from app.services.royalty_engine import (
    CALCULATION_VERSION,
    AllocationOut,
    LineInput,
    ShareInput,
    TermInput,
    allocate_line,
    inputs_fingerprint,
)
from app.services.royalty_import import get_statement

logger = get_logger(__name__)

ZERO = Decimal("0")
TERM_CONTRACT_STATUSES = ("active", "expired", "terminated")


def lock_run_and_statement(db: Session, organization_id: str, run_id: str) -> tuple[RoyaltyRun, RoyaltyStatement]:
    """Lock statement then run: the same order as calculate() and the import
    job, so concurrent operations queue instead of deadlocking."""
    run = get_run(db, organization_id, run_id)
    statement = get_statement(db, organization_id, run.statement_id, lock=True)
    run = get_run(db, organization_id, run_id, lock=True)
    return run, statement


def get_run(db: Session, organization_id: str, run_id: str, *, lock: bool = False) -> RoyaltyRun:
    stmt = select(RoyaltyRun).where(RoyaltyRun.id == run_id, RoyaltyRun.organization_id == organization_id)
    if lock:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    run = db.scalar(stmt)
    if run is None:
        raise NotFoundError("Calculation run not found")
    return run


# --------------------------------------------------------------------------- input loading


class CalculationInputs:
    def __init__(self, lines, shares, terms, basis, warnings):
        self.lines: list[LineInput] = lines
        self.shares: list[ShareInput] = shares
        self.terms: list[TermInput] = terms
        self.basis: str = basis
        self.warnings: list[dict] = warnings


def load_inputs(db: Session, statement: RoyaltyStatement, basis: str) -> CalculationInputs:
    org_id = statement.organization_id
    rows = db.scalars(
        select(StatementLine).where(
            StatementLine.statement_id == statement.id,
            StatementLine.is_valid.is_(True),
            StatementLine.match_status.in_(("matched", "unmatched")),
        ).order_by(StatementLine.row_number)
    ).all()
    recording_ids = {r.recording_id for r in rows if r.recording_id}
    linked: dict[str, list[str]] = defaultdict(list)
    if recording_ids:
        for rec_id, work_id in db.execute(
            select(RecordingWork.recording_id, RecordingWork.work_id).where(
                RecordingWork.organization_id == org_id, RecordingWork.recording_id.in_(recording_ids))
        ).all():
            linked[rec_id].append(work_id)
    work_ids = {r.work_id for r in rows if r.work_id} | {w for ws in linked.values() for w in ws}

    lines = [
        LineInput(
            id=r.id,
            amount=Decimal(r.amount or 0),
            gross_amount=Decimal(r.gross_amount) if r.gross_amount is not None else None,
            currency=r.currency or statement.currency,
            territory=r.territory,
            rights_type=r.rights_type,
            line_date=r.transaction_date or statement.period_end,
            work_id=r.work_id,
            recording_id=r.recording_id,
            linked_work_ids=tuple(sorted(linked.get(r.recording_id, []))) if r.recording_id else (),
            match_status=r.match_status,
        )
        for r in rows
    ]

    share_rows = []
    if work_ids or recording_ids:
        conditions = []
        if work_ids:
            conditions.append(OwnershipShare.work_id.in_(work_ids))
        if recording_ids:
            conditions.append(OwnershipShare.recording_id.in_(recording_ids))
        share_rows = db.scalars(
            select(OwnershipShare).where(
                OwnershipShare.organization_id == org_id,
                OwnershipShare.status.in_(("active", "disputed")),
                or_(*conditions),
            )
        ).all()
    party_ids = {s.party_id for s in share_rows}
    parties = {
        p.id: p for p in db.scalars(select(Party).where(Party.id.in_(party_ids))).all()
    } if party_ids else {}
    shares = [
        ShareInput(
            id=s.id, party_id=s.party_id, party_name=parties[s.party_id].name if s.party_id in parties else "",
            party_is_internal=bool(parties.get(s.party_id) and parties[s.party_id].is_internal),
            role=s.role, rights_type=s.rights_type, share_percent=Decimal(s.share_percent),
            territories=tuple(s.territories or []), excluded_territories=tuple(s.excluded_territories or []),
            effective_from=s.effective_from, effective_to=s.effective_to, is_controlled=s.is_controlled,
            status=s.status, contract_id=s.contract_id, work_id=s.work_id, recording_id=s.recording_id,
        )
        for s in share_rows
    ]

    warnings: list[dict] = []
    contract_ids = {s.contract_id for s in share_rows if s.contract_id}
    terms: list[TermInput] = []
    if contract_ids:
        contracts = {c.id: c for c in db.scalars(select(Contract).where(
            Contract.id.in_(contract_ids), Contract.organization_id == org_id)).all()}
        for contract in contracts.values():
            if contract.status not in TERM_CONTRACT_STATUSES:
                warnings.append({"type": "contract_not_in_effect", "contract_id": contract.id,
                                 "message": f"Contract '{contract.title}' is {contract.status}; its "
                                            "royalty terms were not applied."})
        for term in db.scalars(select(ContractRoyaltyTerm).where(
                ContractRoyaltyTerm.contract_id.in_(contract_ids))).all():
            contract = contracts.get(term.contract_id)
            if contract is None or contract.status not in TERM_CONTRACT_STATUSES:
                continue
            terms.append(TermInput(
                id=term.id, contract_id=term.contract_id, payee_party_id=term.payee_party_id,
                rights_type=term.rights_type, source_category=term.source_category,
                territories=tuple(term.territories) if term.territories else None,
                rate_percent=Decimal(term.rate_percent), basis=term.basis,
                valid_from=contract.start_date,
                valid_to=None if contract.auto_renew else contract.end_date,
            ))
    return CalculationInputs(lines, shares, terms, basis, warnings)


def compute(statement: RoyaltyStatement, inputs: CalculationInputs) -> tuple[list[AllocationOut], str]:
    allocations: list[AllocationOut] = []
    for line in inputs.lines:
        allocations.extend(allocate_line(
            line, shares=inputs.shares, terms=inputs.terms,
            statement_default_rights=statement.default_rights_type,
            source_category=statement.source_category, basis=inputs.basis,
        ))
    fingerprint = inputs_fingerprint(
        basis=inputs.basis, source_category=statement.source_category,
        default_rights=statement.default_rights_type, lines=inputs.lines,
        shares=inputs.shares, terms=inputs.terms,
    )
    return allocations, fingerprint


def _summaries(statement: RoyaltyStatement, allocations: list[AllocationOut]) -> tuple[dict, list[dict]]:
    totals = {"payable": ZERO, "retained": ZERO, "unallocated": ZERO}
    other_currency: dict[str, Decimal] = defaultdict(lambda: ZERO)
    reasons: Counter = Counter()
    reason_amounts: dict[str, Decimal] = defaultdict(lambda: ZERO)
    for a in allocations:
        if a.currency == statement.currency:
            totals[a.allocation_type] += a.amount
        else:
            other_currency[a.currency] += a.amount
        if a.allocation_type == "unallocated" and a.reason:
            reasons[a.reason] += 1
            reason_amounts[a.reason] += a.amount
    warnings = [
        {"type": "unallocated", "reason": reason, "count": count,
         "amount": str(reason_amounts[reason])}
        for reason, count in sorted(reasons.items())
    ]
    if other_currency:
        warnings.append({"type": "other_currencies",
                         "totals": {k: str(v) for k, v in sorted(other_currency.items())},
                         "message": "Lines in other currencies were allocated in their own currency; "
                                    "no FX conversion was applied."})
    return totals, warnings


# --------------------------------------------------------------------------- calculate


def calculate(db: Session, ctx: OrgContext, statement_id: str, request: Request | None) -> RoyaltyRun:
    statement = get_statement(db, ctx.organization_id, statement_id, lock=True)
    if statement.status not in ("processed", "calculated"):
        raise ConflictError(f"Statement is {statement.status}; process it before calculating")
    if db.scalar(select(RoyaltyRun.id).where(RoyaltyRun.statement_id == statement.id,
                                             RoyaltyRun.status == "posted")):
        raise ConflictError("Royalties for this statement are already posted")
    basis = org_settings(ctx.organization).allocation_basis
    inputs = load_inputs(db, statement, basis)
    if not inputs.lines:
        raise ValidationFailedError("The statement has no valid lines to calculate")
    allocations, fingerprint = compute(statement, inputs)
    totals, warnings = _summaries(statement, allocations)
    input_total = sum((l.amount for l in inputs.lines if l.currency == statement.currency), ZERO)
    # Money conservation is checked explicitly, not with assert: `python -O`
    # strips asserts, and this guard must never disappear.
    if totals["payable"] + totals["retained"] + totals["unallocated"] != input_total:
        logger.error("Allocation totals do not reconcile", extra={"context": {
            "statement_id": statement.id, "totals": {k: str(v) for k, v in totals.items()},
            "input_total": str(input_total)}})
        raise ConflictError("Calculation did not reconcile with the statement total; nothing was saved",
                            code="calculation_not_reconciled")

    for previous in db.scalars(select(RoyaltyRun).where(RoyaltyRun.statement_id == statement.id,
                                                        RoyaltyRun.status == "calculated")):
        previous.status = "discarded"
    run = RoyaltyRun(
        organization_id=ctx.organization_id, statement_id=statement.id, status="calculated",
        calculation_version=CALCULATION_VERSION, allocation_basis=basis, inputs_hash=fingerprint,
        currency=statement.currency, total_input=input_total, total_payable=totals["payable"],
        total_retained=totals["retained"], total_unallocated=totals["unallocated"],
        line_count=len(inputs.lines), warnings=inputs.warnings + warnings or None,
        created_by_id=ctx.user.id,
    )
    db.add(run)
    db.flush()
    _insert_allocations(db, ctx.organization_id, run.id, allocations)
    statement.status = "calculated"
    record_audit(
        db, action="royalty_run.calculated", actor_user_id=ctx.user.id,
        organization_id=ctx.organization_id, entity_type="royalty_run", entity_id=run.id,
        summary=f"Calculated {statement.source_name}: payable {totals['payable']}, retained "
                f"{totals['retained']}, unallocated {totals['unallocated']} {statement.currency}",
        request=request,
    )
    db.commit()
    db.refresh(run)
    return run


def _insert_allocations(db: Session, organization_id: str, run_id: str, allocations: list[AllocationOut]) -> None:
    rows = [
        {
            "id": new_uuid(), "organization_id": organization_id, "run_id": run_id,
            "line_id": a.line_id, "allocation_type": a.allocation_type,
            "ownership_share_id": a.ownership_share_id, "contract_term_id": a.contract_term_id,
            "party_id": a.party_id, "payee_id": None, "work_id": a.work_id,
            "recording_id": a.recording_id, "rights_type": a.rights_type, "territory": a.territory,
            "share_percent": a.share_percent, "rate_percent": a.rate_percent,
            "base_amount": a.base_amount, "amount": a.amount, "currency": a.currency,
            "reason": a.reason, "explanation": a.explanation or None,
        }
        for a in allocations
    ]
    for start in range(0, len(rows), 1000):
        db.execute(insert(RoyaltyAllocation), rows[start:start + 1000])


def verify(db: Session, ctx: OrgContext, run_id: str) -> dict:
    """Recompute a run from current data and compare with what was stored."""
    run = get_run(db, ctx.organization_id, run_id)
    statement = get_statement(db, ctx.organization_id, run.statement_id)
    inputs = load_inputs(db, statement, run.allocation_basis)
    allocations, fingerprint = compute(statement, inputs)
    stored = db.execute(
        select(RoyaltyAllocation.line_id, RoyaltyAllocation.allocation_type,
               RoyaltyAllocation.ownership_share_id, RoyaltyAllocation.amount)
        .where(RoyaltyAllocation.run_id == run.id)
    ).all()
    stored_set = sorted((r[0], r[1], r[2] or "", Decimal(r[3])) for r in stored)
    fresh_set = sorted((a.line_id, a.allocation_type, a.ownership_share_id or "", a.amount) for a in allocations)
    return {
        "run_id": run.id,
        "inputs_unchanged": fingerprint == run.inputs_hash,
        "allocations_match": stored_set == fresh_set,
        "reproducible": fingerprint == run.inputs_hash and stored_set == fresh_set,
        "stored_hash": run.inputs_hash,
        "current_hash": fingerprint,
        "calculation_version": CALCULATION_VERSION,
    }


# --------------------------------------------------------------------------- post / reverse


def post(db: Session, ctx: OrgContext, run_id: str, request: Request | None) -> RoyaltyRun:
    run, statement = lock_run_and_statement(db, ctx.organization_id, run_id)
    if run.status != "calculated":
        raise ConflictError(f"Only calculated runs can be posted (run is {run.status})")
    if statement.status != "calculated":
        # e.g. queued for reprocessing: the lines are about to be replaced.
        raise ConflictError(f"The statement is {statement.status}; recalculate before posting",
                            code="stale_calculation")
    inputs = load_inputs(db, statement, run.allocation_basis)
    _, fingerprint = compute(statement, inputs)
    if fingerprint != run.inputs_hash:
        raise ConflictError(
            "Ownership, contract or statement data changed after this run was calculated. "
            "Recalculate before posting.", code="stale_calculation")

    payable = db.execute(
        select(RoyaltyAllocation.party_id, RoyaltyAllocation.currency, RoyaltyAllocation.amount)
        .where(RoyaltyAllocation.run_id == run.id, RoyaltyAllocation.allocation_type == "payable")
    ).all()
    per_party: dict[tuple[str, str], Decimal] = defaultdict(lambda: ZERO)
    for party_id, currency, amount in payable:
        per_party[(party_id, currency)] += Decimal(amount)

    period = f"{statement.period_start.isoformat()} to {statement.period_end.isoformat()}"
    payees_by_party: dict[str, str] = {}
    entries = 0
    for (party_id, currency), amount in sorted(per_party.items()):
        party = db.get(Party, party_id)
        if party is None:
            raise ConflictError("A payee party was deleted; recalculate before posting")
        payee = ledger.ensure_payee_for_party(db, ctx.organization_id, party, currency)
        payees_by_party[party_id] = payee.id
        if amount == 0:
            continue
        ledger.add_entry(
            db, organization_id=ctx.organization_id, payee_id=payee.id, entry_type="earning",
            amount=amount, currency=currency, effective_date=statement.period_end,
            description=f"Royalties: {statement.source_name} ({period})",
            created_by_id=ctx.user.id, run_id=run.id,
        )
        entries += 1
    for party_id, payee_id in payees_by_party.items():
        db.execute(update(RoyaltyAllocation).where(
            RoyaltyAllocation.run_id == run.id, RoyaltyAllocation.party_id == party_id,
            RoyaltyAllocation.allocation_type == "payable").values(payee_id=payee_id))

    run.status = "posted"
    run.posting_key = statement.id
    run.posted_by_id = ctx.user.id
    run.posted_at = utc_now()
    statement.status = "posted"
    record_audit(
        db, action="royalty_run.posted", actor_user_id=ctx.user.id,
        organization_id=ctx.organization_id, entity_type="royalty_run", entity_id=run.id,
        summary=f"Posted {entries} ledger entr{'y' if entries == 1 else 'ies'} totalling "
                f"{run.total_payable} {run.currency} from {statement.source_name}",
        request=request,
    )
    notify_org(
        db, organization_id=ctx.organization_id, type="royalty_processing_completed",
        title=f"Royalties posted: {statement.source_name}",
        body=f"{run.total_payable} {run.currency} payable across {len(payees_by_party)} payee(s).",
        link=f"/royalties/runs/{run.id}", minimum_role="manager", severity="success",
    )
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise ConflictError("This statement already has posted royalties") from exc
    db.refresh(run)
    return run


def reverse(db: Session, ctx: OrgContext, run_id: str, reason: str, request: Request | None) -> RoyaltyRun:
    run, statement = lock_run_and_statement(db, ctx.organization_id, run_id)
    if run.status != "posted":
        raise ConflictError("Only posted runs can be reversed")
    originals = db.scalars(select(LedgerEntry).where(
        LedgerEntry.run_id == run.id, LedgerEntry.entry_type == "earning")).all()
    # Lock affected payees so a concurrent payout approval re-checks funds
    # against the reduced balance instead of a stale one.
    payee_ids = sorted({e.payee_id for e in originals})
    if payee_ids:
        db.execute(select(Payee.id).where(Payee.id.in_(payee_ids)).order_by(Payee.id).with_for_update())
    for entry in originals:
        ledger.add_entry(
            db, organization_id=ctx.organization_id, payee_id=entry.payee_id,
            entry_type="reversal", amount=-entry.amount, currency=entry.currency,
            effective_date=utc_now().date(), description=f"Reversal of royalty run: {reason}"[:500],
            created_by_id=ctx.user.id, run_id=run.id, reversal_of_id=entry.id,
        )
    run.status = "reversed"
    run.posting_key = None
    run.reversed_by_id = ctx.user.id
    run.reversed_at = utc_now()
    run.reversal_reason = reason
    statement.status = "processed"
    record_audit(
        db, action="royalty_run.reversed", actor_user_id=ctx.user.id,
        organization_id=ctx.organization_id, entity_type="royalty_run", entity_id=run.id,
        summary=f"Reversed {len(originals)} ledger entries: {reason}", request=request,
    )
    db.commit()
    db.refresh(run)
    return run


def discard(db: Session, ctx: OrgContext, run_id: str, request: Request | None) -> RoyaltyRun:
    run, statement = lock_run_and_statement(db, ctx.organization_id, run_id)
    if run.status != "calculated":
        raise ConflictError("Only calculated (unposted) runs can be discarded")
    run.status = "discarded"
    if statement.status == "calculated":
        statement.status = "processed"
    record_audit(db, action="royalty_run.discarded", actor_user_id=ctx.user.id,
                 organization_id=ctx.organization_id, entity_type="royalty_run", entity_id=run.id,
                 request=request)
    db.commit()
    db.refresh(run)
    return run
