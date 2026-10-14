"""Organization background jobs: status, progress, cancel and retry."""

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import ConflictError, NotFoundError
from app.core.permissions import OrgContext, OrgManager, OrgViewer
from app.db.session import get_db
from app.models.platform import BackgroundJob
from app.schemas.common import Page, PageParams, page_of, paginate
from app.schemas.job import JobResponse, JobStatus
from app.services import jobs as job_service
from app.services.audit import record_audit

router = APIRouter(prefix="/organizations/{organization_id}/jobs", tags=["Jobs"])

JobId = Annotated[str, Path(max_length=36)]


def _get_job(db: Session, ctx: OrgContext, job_id: str) -> BackgroundJob:
    job = db.scalar(
        select(BackgroundJob).where(
            BackgroundJob.id == job_id, BackgroundJob.organization_id == ctx.organization_id
        )
    )
    if job is None:
        raise NotFoundError("Job not found")
    return job


@router.get("", response_model=Page[JobResponse])
def list_jobs(
    ctx: OrgViewer,
    db: Session = Depends(get_db),
    params: PageParams = Depends(),
    job_type: Annotated[str | None, Query(max_length=50)] = None,
    status: Annotated[JobStatus | None, Query()] = None,
):
    """Jobs for this organization, newest first."""
    stmt = select(BackgroundJob).where(BackgroundJob.organization_id == ctx.organization_id)
    if job_type:
        stmt = stmt.where(BackgroundJob.job_type == job_type)
    if status:
        stmt = stmt.where(BackgroundJob.status == status)
    rows, total = paginate(
        db,
        stmt,
        params,
        sortable={
            "created_at": BackgroundJob.created_at,
            "status": BackgroundJob.status,
            "job_type": BackgroundJob.job_type,
        },
        default_sort=BackgroundJob.created_at.desc(),
    )
    return page_of([JobResponse.model_validate(r) for r in rows], total, params)


@router.get("/{job_id}", response_model=JobResponse)
def get_job(job_id: JobId, ctx: OrgViewer, db: Session = Depends(get_db)):
    return _get_job(db, ctx, job_id)


DOMAIN_OWNED_JOBS = {
    "royalty_import": "statement page (Cancel processing)",
    "contract_analysis": "contract's AI analysis panel",
}


@router.post("/{job_id}/cancel", response_model=JobResponse)
def cancel_job(job_id: JobId, ctx: OrgManager, request: Request, db: Session = Depends(get_db)):
    """Cancel a job that has not started yet (status ``queued``)."""
    job = _get_job(db, ctx, job_id)
    if job.job_type in DOMAIN_OWNED_JOBS:
        # These jobs drive another record's state (a statement, a contract
        # analysis); cancelling only the job would strand it (audit AF-06).
        raise ConflictError(
            f"Cancel this from the {DOMAIN_OWNED_JOBS[job.job_type]} instead.",
            code="cancel_from_owner", details={"job_type": job.job_type},
        )
    if job.status != "queued" or not job_service.cancel_job(db, job):
        db.refresh(job)
        raise ConflictError(
            f"Only queued jobs can be cancelled; this job is {job.status}.",
            code="job_not_cancellable",
            details={"status": job.status},
        )
    record_audit(
        db,
        action="job.cancelled",
        actor_user_id=ctx.user.id,
        organization_id=ctx.organization_id,
        entity_type="job",
        entity_id=job.id,
        summary=f"Cancelled {job.job_type} job",
        request=request,
    )
    db.commit()
    db.refresh(job)
    return job


@router.post("/{job_id}/retry", response_model=JobResponse)
def retry_job(job_id: JobId, ctx: OrgManager, request: Request, db: Session = Depends(get_db)):
    """Re-queue a failed or cancelled job with a fresh attempt budget."""
    job = _get_job(db, ctx, job_id)
    if job.status not in ("failed", "cancelled") or not job_service.retry_job(db, job):
        db.refresh(job)
        raise ConflictError(
            f"Only failed or cancelled jobs can be retried; this job is {job.status}.",
            code="job_not_retryable",
            details={"status": job.status},
        )
    record_audit(
        db,
        action="job.retried",
        actor_user_id=ctx.user.id,
        organization_id=ctx.organization_id,
        entity_type="job",
        entity_id=job.id,
        summary=f"Retried {job.job_type} job",
        request=request,
    )
    db.commit()
    db.refresh(job)
    return job
