from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, status
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import NotFoundError
from app.core.permissions import OrgAdmin, OrgManager, OrgViewer
from app.db.mixins import utc_now
from app.db.session import get_db
from app.models.royalty import PayoutBatch
from app.schemas.common import Page, PageParams, page_of, paginate
from app.schemas.royalty import (
    MarkPaidRequest,
    PayoutAmountUpdate,
    PayoutBatchCreate,
    PayoutBatchResponse,
)
from app.services import payouts

router = APIRouter(prefix="/organizations/{organization_id}/payouts", tags=["Payouts"])


def _batch_payload(batch: PayoutBatch) -> dict:
    data = PayoutBatchResponse.model_validate(batch).model_dump()
    data["payouts"] = [
        {**p, "payee_name": src.payee.display_name, "payment_method": src.payee.payment_method}
        for p, src in zip(data["payouts"], batch.payouts)
    ]
    return data


@router.get("/provider")
def payment_provider(ctx: OrgViewer):
    provider = payouts.get_payment_provider()
    return {"provider": provider.name, "moves_money": False,
            "message": "Payments are executed outside RightsFlow and then recorded here."}


@router.get("/batches", response_model=Page[PayoutBatchResponse])
def list_batches(ctx: OrgViewer, db: Session = Depends(get_db), params: PageParams = Depends(),
                 status_filter: Annotated[str | None, Query(alias="status", max_length=20)] = None):
    stmt = select(PayoutBatch).where(PayoutBatch.organization_id == ctx.organization_id)
    if status_filter:
        stmt = stmt.where(PayoutBatch.status == status_filter)
    rows, total = paginate(db, stmt, params, sortable={"created_at": PayoutBatch.created_at,
                                                        "total_amount": PayoutBatch.total_amount},
                           default_sort=PayoutBatch.created_at.desc())
    return page_of([_batch_payload(b) for b in rows], total, params)


@router.post("/batches", response_model=PayoutBatchResponse, status_code=status.HTTP_201_CREATED)
def create_batch(payload: PayoutBatchCreate, ctx: OrgManager, request: Request, db: Session = Depends(get_db)):
    """Draft a batch paying each eligible payee's available balance (whole cents)."""
    return _batch_payload(payouts.create_batch(db, ctx, payload.currency, payload.payee_ids,
                                               payload.notes, request))


@router.get("/batches/{batch_id}", response_model=PayoutBatchResponse)
def get_batch(batch_id: str, ctx: OrgViewer, db: Session = Depends(get_db)):
    return _batch_payload(payouts.get_batch(db, ctx.organization_id, batch_id))


@router.patch("/batches/{batch_id}/payouts/{payout_id}", response_model=PayoutBatchResponse)
def amend_payout(batch_id: str, payout_id: str, payload: PayoutAmountUpdate, ctx: OrgManager,
                 request: Request, db: Session = Depends(get_db)):
    return _batch_payload(payouts.update_payout_amount(db, ctx, batch_id, payout_id, payload.amount, request))


@router.delete("/batches/{batch_id}/payouts/{payout_id}", response_model=PayoutBatchResponse)
def remove_payout(batch_id: str, payout_id: str, ctx: OrgManager, request: Request,
                  db: Session = Depends(get_db)):
    return _batch_payload(payouts.remove_payout(db, ctx, batch_id, payout_id, request))


@router.post("/batches/{batch_id}/submit", response_model=PayoutBatchResponse)
def submit_batch(batch_id: str, ctx: OrgManager, request: Request, db: Session = Depends(get_db)):
    return _batch_payload(payouts.submit(db, ctx, batch_id, request))


@router.post("/batches/{batch_id}/approve", response_model=PayoutBatchResponse)
def approve_batch(batch_id: str, ctx: OrgAdmin, request: Request, db: Session = Depends(get_db)):
    return _batch_payload(payouts.approve(db, ctx, batch_id, request))


@router.post("/batches/{batch_id}/mark-paid", response_model=PayoutBatchResponse)
def mark_paid(batch_id: str, payload: MarkPaidRequest, ctx: OrgAdmin, request: Request,
              db: Session = Depends(get_db)):
    """Record that the approved batch was paid OUTSIDE RightsFlow. Writes
    negative payout entries to the ledger. Requires explicit confirmation."""
    return _batch_payload(payouts.mark_paid(db, ctx, batch_id, payload.payment_date or utc_now().date(),
                                            payload.external_references, payload.notes, request))


@router.post("/batches/{batch_id}/cancel", response_model=PayoutBatchResponse)
def cancel_batch(batch_id: str, ctx: OrgManager, request: Request, db: Session = Depends(get_db)):
    return _batch_payload(payouts.cancel(db, ctx, batch_id, request))


@router.get("/batches/{batch_id}/remittance.csv")
def batch_remittance(batch_id: str, ctx: OrgViewer, db: Session = Depends(get_db)):
    batch = payouts.get_batch(db, ctx.organization_id, batch_id)
    return Response(content=payouts.remittance_csv(db, batch).encode("utf-8-sig"), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="{batch.reference}-remittance.csv"'})


@router.get("/batches/{batch_id}/payouts/{payout_id}/advice.csv")
def payout_advice(batch_id: str, payout_id: str, ctx: OrgViewer, db: Session = Depends(get_db)):
    batch = payouts.get_batch(db, ctx.organization_id, batch_id)
    payout = next((p for p in batch.payouts if p.id == payout_id), None)
    if payout is None:
        raise NotFoundError("Payout not found")
    return Response(content=payouts.payout_advice_csv(db, batch, payout).encode("utf-8-sig"),
                    media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="{batch.reference}-advice.csv"'})
