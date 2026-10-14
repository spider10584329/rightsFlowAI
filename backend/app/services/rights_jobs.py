"""Background re-scan of rights conflicts.

Split-rule changes alter what counts as over- or under-allocated, so the
whole organization is re-scanned in the background. Detection never resolves
conflicts by itself; it only refreshes what is (or is no longer) detected.
"""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.platform import BackgroundJob
from app.services import jobs

RIGHTS_SCAN_JOB = "rights_conflict_scan"


def queue_rights_rescan(db: Session, organization_id: str, created_by_id: str | None,
                        reason: str) -> BackgroundJob:
    """Queue an org-wide conflict scan, reusing one that is still waiting."""
    pending = db.scalar(
        select(BackgroundJob).where(
            BackgroundJob.organization_id == organization_id,
            BackgroundJob.job_type == RIGHTS_SCAN_JOB,
            BackgroundJob.status == "queued",
        )
    )
    if pending is not None:
        return pending
    return jobs.enqueue(db, organization_id=organization_id, job_type=RIGHTS_SCAN_JOB,
                        payload={"reason": reason}, created_by_id=created_by_id, max_attempts=2)


@jobs.job_handler(RIGHTS_SCAN_JOB)
def rights_conflict_scan(db: Session, ctx: jobs.JobContext) -> dict:
    from app.services.notifications import notify_org
    from app.services.rights import scan_organization

    assert ctx.organization_id is not None
    result = scan_organization(db, ctx.organization_id, actor_user_id=ctx.created_by_id)
    serious = [c for c in result.new if c.severity in ("high", "critical")]
    if serious:
        notify_org(
            db, organization_id=ctx.organization_id, type="rights_conflict",
            title=f"{len(serious)} new rights conflict(s) after a split rule change",
            body="Review them in Rights → Conflicts. Nothing was changed automatically.",
            link="/rights/conflicts", minimum_role="manager", severity="warning",
        )
    db.commit()
    return {
        "reason": ctx.payload.get("reason"),
        "scanned_assets": result.scanned_assets,
        "detected": len(result.detected),
        "new": len(result.new),
        "no_longer_detected": len(result.no_longer_detected),
    }
