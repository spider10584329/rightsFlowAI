import csv
import io
from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, status
from fastapi.responses import Response
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.permissions import OrgAdmin, OrgManager, OrgViewer
from app.db.session import get_db
from app.models.catalog import Party
from app.models.royalty import LedgerEntry, Payee
from app.schemas.common import Page, PageParams, page_of, paginate
from app.schemas.royalty import (
    AdjustmentCreate,
    AdvanceCreate,
    LedgerEntryResponse,
    PayeeCreate,
    PayeeResponse,
    PayeeUpdate,
    ReasonRequest,
)
from app.services import ledger
from app.services.statement_parsing import neutralize_formula

router = APIRouter(prefix="/organizations/{organization_id}", tags=["Payees & Ledger"])


def _payee_payload(payee: Payee, balances: dict | None = None) -> dict:
    data = PayeeResponse.model_validate(payee).model_dump()
    data["party_name"] = payee.party.name if payee.party else None
    data["balances"] = ledger.balance_rows(balances or {})
    return data


def _entry_payload(entry: LedgerEntry, **extra) -> dict:
    data = LedgerEntryResponse.model_validate(entry).model_dump()
    data["payee_name"] = entry.payee.display_name if entry.payee else None
    data.update(extra)
    return data


# --------------------------------------------------------------------------- payees


@router.get("/payees", response_model=Page[PayeeResponse])
def list_payees(
    ctx: OrgViewer, db: Session = Depends(get_db), params: PageParams = Depends(),
    q: Annotated[str | None, Query(max_length=120)] = None,
    active: bool | None = None,
    with_balance: bool = False,
):
    stmt = select(Payee).where(Payee.organization_id == ctx.organization_id)
    if q:
        stmt = stmt.join(Party, Party.id == Payee.party_id).where(
            or_(Payee.display_name.contains(q), Payee.email.contains(q), Party.name.contains(q)))
    if active is not None:
        stmt = stmt.where(Payee.is_active.is_(active))
    if with_balance:
        positive = select(LedgerEntry.payee_id).where(
            LedgerEntry.organization_id == ctx.organization_id).group_by(
            LedgerEntry.payee_id, LedgerEntry.currency).having(
            func.sum(LedgerEntry.amount) != 0)
        stmt = stmt.where(Payee.id.in_(positive))
    rows, total = paginate(db, stmt, params, sortable={"display_name": Payee.display_name,
                                                        "created_at": Payee.created_at},
                           default_sort=Payee.display_name.asc())
    balances = ledger.balances(db, ctx.organization_id, [p.id for p in rows])
    return page_of([_payee_payload(p, balances.get(p.id)) for p in rows], total, params)


@router.post("/payees", response_model=PayeeResponse, status_code=status.HTTP_201_CREATED)
def create_payee(payload: PayeeCreate, ctx: OrgManager, request: Request, db: Session = Depends(get_db)):
    return _payee_payload(ledger.create_payee(db, ctx, payload.model_dump(), request))


@router.get("/payees/{payee_id}", response_model=PayeeResponse)
def get_payee(payee_id: str, ctx: OrgViewer, db: Session = Depends(get_db)):
    payee = ledger.get_payee(db, ctx.organization_id, payee_id)
    return _payee_payload(payee, ledger.balances(db, ctx.organization_id, [payee.id]).get(payee.id))


@router.patch("/payees/{payee_id}", response_model=PayeeResponse)
def update_payee(payee_id: str, payload: PayeeUpdate, ctx: OrgManager, request: Request,
                 db: Session = Depends(get_db)):
    payee = ledger.get_payee(db, ctx.organization_id, payee_id)
    payee = ledger.update_payee(db, ctx, payee, payload.model_dump(exclude_unset=True), request)
    return _payee_payload(payee, ledger.balances(db, ctx.organization_id, [payee.id]).get(payee.id))


@router.get("/payees/{payee_id}/ledger", response_model=list[LedgerEntryResponse])
def payee_ledger(payee_id: str, ctx: OrgViewer, db: Session = Depends(get_db),
                 currency: Annotated[str | None, Query(min_length=3, max_length=3)] = None,
                 start: date | None = None, end: date | None = None):
    """Statement of account with running balance (oldest first)."""
    ledger.get_payee(db, ctx.organization_id, payee_id)
    rows = ledger.statement_of_account(db, ctx.organization_id, payee_id,
                                       currency.upper() if currency else None, start, end)
    return [_entry_payload(r["entry"], running_balance=r["running_balance"], reversed=r["reversed"])
            for r in rows]


@router.get("/payees/{payee_id}/statement.csv")
def payee_statement_csv(payee_id: str, ctx: OrgViewer, db: Session = Depends(get_db),
                        currency: Annotated[str | None, Query(min_length=3, max_length=3)] = None,
                        start: date | None = None, end: date | None = None):
    payee = ledger.get_payee(db, ctx.organization_id, payee_id)
    rows = ledger.statement_of_account(db, ctx.organization_id, payee_id,
                                       currency.upper() if currency else None, start, end)
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(["Statement of account", neutralize_formula(payee.display_name)])
    writer.writerow(["Generated from the RightsFlow ledger; balances are not bank confirmations."])
    writer.writerow([])
    writer.writerow(["Date", "Type", "Description", "Amount", "Currency", "Running balance"])
    for row in rows:
        entry = row["entry"]
        writer.writerow([entry.effective_date.isoformat(), entry.entry_type,
                         neutralize_formula(entry.description), format(entry.amount, "f"),
                         entry.currency, format(row["running_balance"], "f")])
    safe = "".join(c for c in payee.display_name if c.isalnum() or c in "-_ ")[:60].strip() or "payee"
    return Response(content=out.getvalue().encode("utf-8-sig"), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="statement-{safe}.csv"'})


# --------------------------------------------------------------------------- ledger


@router.get("/ledger", response_model=Page[LedgerEntryResponse])
def list_ledger(
    ctx: OrgViewer, db: Session = Depends(get_db), params: PageParams = Depends(),
    payee_id: Annotated[str | None, Query(max_length=36)] = None,
    entry_type: Annotated[str | None, Query(max_length=20)] = None,
    currency: Annotated[str | None, Query(min_length=3, max_length=3)] = None,
    run_id: Annotated[str | None, Query(max_length=36)] = None,
):
    stmt = select(LedgerEntry).where(LedgerEntry.organization_id == ctx.organization_id)
    if payee_id:
        stmt = stmt.where(LedgerEntry.payee_id == payee_id)
    if entry_type:
        stmt = stmt.where(LedgerEntry.entry_type == entry_type)
    if currency:
        stmt = stmt.where(LedgerEntry.currency == currency.upper())
    if run_id:
        stmt = stmt.where(LedgerEntry.run_id == run_id)
    rows, total = paginate(db, stmt, params, sortable={"effective_date": LedgerEntry.effective_date,
                                                        "amount": LedgerEntry.amount,
                                                        "created_at": LedgerEntry.created_at},
                           default_sort=LedgerEntry.created_at.desc())
    reversed_ids = set(db.scalars(select(LedgerEntry.reversal_of_id).where(
        LedgerEntry.reversal_of_id.in_([r.id for r in rows]))).all()) if rows else set()
    return page_of([_entry_payload(r, reversed=r.id in reversed_ids) for r in rows], total, params)


@router.get("/ledger/balances")
def all_balances(ctx: OrgViewer, db: Session = Depends(get_db)):
    """Balances for every payee with ledger activity, per currency."""
    balances = ledger.balances(db, ctx.organization_id)
    payees = {p.id: p for p in db.scalars(select(Payee).where(Payee.id.in_(list(balances)))).all()} \
        if balances else {}
    items = []
    for payee_id, per_currency in balances.items():
        payee = payees.get(payee_id)
        for row in ledger.balance_rows(per_currency):
            items.append({"payee_id": payee_id, "payee_name": payee.display_name if payee else None,
                          **{k: format(v, "f") if not isinstance(v, str) else v for k, v in row.items()}})
    items.sort(key=lambda r: (r["currency"], r["payee_name"] or ""))
    return {"items": items, "note": "Ledger balances are accounting figures, not confirmed bank payments."}


@router.post("/ledger/adjustments", response_model=LedgerEntryResponse, status_code=status.HTTP_201_CREATED)
def create_adjustment(payload: AdjustmentCreate, ctx: OrgAdmin, request: Request, db: Session = Depends(get_db)):
    entry = ledger.record_adjustment(db, ctx, payload.payee_id, payload.amount, payload.currency,
                                     payload.description, payload.effective_date, request)
    return _entry_payload(entry)


@router.post("/ledger/advances", response_model=LedgerEntryResponse, status_code=status.HTTP_201_CREATED)
def create_advance(payload: AdvanceCreate, ctx: OrgAdmin, request: Request, db: Session = Depends(get_db)):
    """Record a recoupable advance (a negative ledger entry recouped from future earnings)."""
    entry = ledger.record_advance(db, ctx, payload.payee_id, payload.amount, payload.currency,
                                  payload.contract_id, payload.description, payload.effective_date, request)
    return _entry_payload(entry)


@router.post("/ledger/{entry_id}/reverse", response_model=LedgerEntryResponse, status_code=status.HTTP_201_CREATED)
def reverse_entry(entry_id: str, payload: ReasonRequest, ctx: OrgAdmin, request: Request,
                  db: Session = Depends(get_db)):
    return _entry_payload(ledger.reverse_entry(db, ctx, entry_id, payload.reason, request))
