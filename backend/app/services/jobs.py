"""Database-backed background jobs.

Why a DB queue: it needs no extra infrastructure on Windows, survives restarts,
and shares the transactional guarantees of the main database. Jobs are claimed
with a conditional UPDATE (``status='queued'`` -> ``running``) so several
workers can run safely without ``SKIP LOCKED`` (unsupported on MariaDB 10.4).

Run modes:
- Embedded: a daemon thread inside the API process (``RUN_EMBEDDED_WORKER``).
- Standalone: ``python -m app.worker`` (recommended for production).
"""

import importlib
import os
import socket
import threading
import traceback
from collections.abc import Callable
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from sqlalchemy import or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.logging import get_logger
from app.db.mixins import utc_now
from app.models.platform import BackgroundJob

logger = get_logger(__name__)

# Modules that register handlers via @job_handler on import.
HANDLER_MODULES = [
    "app.services.email",
    "app.services.storage",
    "app.services.rights_jobs",
    "app.services.royalty_import",
    "app.services.catalog_io",
    "app.services.contracts",
    "app.services.reports",
    "app.services.scheduled",
    "app.services.automation.maintenance",
]


class PermanentJobError(Exception):
    """Raised by handlers for failures that retrying cannot fix."""


@dataclass
class JobContext:
    job_id: str
    organization_id: str | None
    payload: dict[str, Any]
    created_by_id: str | None
    attempt: int
    session_factory: Callable[[], Session]

    def progress(self, percent: int) -> None:
        percent = max(0, min(99, int(percent)))
        with self.session_factory() as db:
            db.execute(
                # updated_at doubles as the heartbeat used by stale-job recovery.
                update(BackgroundJob).where(BackgroundJob.id == self.job_id)
                .values(progress=percent, updated_at=utc_now())
            )
            db.commit()


Handler = Callable[[Session, JobContext], dict[str, Any] | None]
FailureHook = Callable[[Session, JobContext, str], None]

_handlers: dict[str, Handler] = {}
_failure_hooks: dict[str, FailureHook] = {}
_handlers_loaded = False


def job_handler(job_type: str, on_failure: FailureHook | None = None):
    def decorator(func: Handler) -> Handler:
        _handlers[job_type] = func
        if on_failure:
            _failure_hooks[job_type] = on_failure
        return func

    return decorator


def load_handlers() -> None:
    global _handlers_loaded
    if _handlers_loaded:
        return
    for module in HANDLER_MODULES:
        try:
            importlib.import_module(module)
        except ModuleNotFoundError as exc:
            if exc.name != module:
                raise
            logger.warning("Job handler module %s is not installed", module)
    _handlers_loaded = True


def enqueue(
    db: Session,
    *,
    organization_id: str | None,
    job_type: str,
    payload: dict[str, Any] | None = None,
    created_by_id: str | None = None,
    idempotency_key: str | None = None,
    max_attempts: int = 3,
    run_after=None,
    commit: bool = True,
) -> BackgroundJob:
    """Queue a job. With an idempotency key, an existing job is returned
    instead of creating a duplicate."""
    if idempotency_key:
        existing = db.scalar(
            select(BackgroundJob).where(BackgroundJob.idempotency_key == idempotency_key)
        )
        if existing is not None:
            return existing
    job = BackgroundJob(
        organization_id=organization_id,
        job_type=job_type,
        payload=payload or {},
        created_by_id=created_by_id,
        idempotency_key=idempotency_key,
        max_attempts=max_attempts,
        run_after=run_after or utc_now(),
    )
    db.add(job)
    try:
        if commit:
            db.commit()
        else:
            db.flush()
    except IntegrityError:
        db.rollback()
        existing = db.scalar(
            select(BackgroundJob).where(BackgroundJob.idempotency_key == idempotency_key)
        )
        if existing is None:
            raise
        return existing
    return job


def _worker_id() -> str:
    return f"{socket.gethostname()}:{os.getpid()}:{threading.get_ident()}"[:100]


def recover_stale_jobs(db: Session) -> int:
    """Re-queue running jobs whose worker stopped sending heartbeats.

    The heartbeat is ``updated_at`` (bumped by ``progress()``), not
    ``started_at``, so long but healthy jobs are not run twice (audit D-06).
    Jobs that already used all attempts are failed instead of retried
    forever, and their failure hook runs (audit AF-05).
    """
    cutoff = utc_now() - timedelta(minutes=settings.job_stale_after_minutes)
    stale = db.scalars(select(BackgroundJob).where(
        BackgroundJob.status == "running", BackgroundJob.updated_at < cutoff)).all()
    recovered = 0
    for job in stale:
        exhausted = job.attempts >= job.max_attempts
        result = db.execute(
            update(BackgroundJob)
            .where(BackgroundJob.id == job.id, BackgroundJob.status == "running",
                   BackgroundJob.locked_by == job.locked_by)
            .values(status="failed" if exhausted else "queued", locked_by=None,
                    finished_at=utc_now() if exhausted else None,
                    error="Worker stopped responding" + ("; no attempts left" if exhausted else ""))
        )
        db.commit()
        if not result.rowcount:
            continue
        recovered += 1
        hook = _failure_hooks.get(job.job_type)
        if exhausted and hook:
            from app.db.session import SessionLocal

            ctx = JobContext(job_id=job.id, organization_id=job.organization_id,
                             payload=dict(job.payload or {}), created_by_id=job.created_by_id,
                             attempt=job.attempts, session_factory=SessionLocal)
            try:
                with SessionLocal() as hook_db:
                    hook(hook_db, ctx, "The worker stopped responding while running this job")
                    hook_db.commit()
            except Exception:  # pragma: no cover
                logger.exception("Failure hook for stale job %s raised", job.id)
    return recovered


def claim_next(db: Session, worker_id: str, job_types: list[str] | None = None) -> BackgroundJob | None:
    for _ in range(5):
        stmt = (
            select(BackgroundJob.id)
            .where(BackgroundJob.status == "queued", BackgroundJob.run_after <= utc_now(),
                   BackgroundJob.attempts < BackgroundJob.max_attempts)
            .order_by(BackgroundJob.run_after, BackgroundJob.created_at)
            .limit(1)
        )
        if job_types:
            stmt = stmt.where(BackgroundJob.job_type.in_(job_types))
        job_id = db.scalar(stmt)
        if job_id is None:
            return None
        result = db.execute(
            update(BackgroundJob)
            .where(BackgroundJob.id == job_id, BackgroundJob.status == "queued")
            .values(
                status="running",
                locked_by=worker_id,
                started_at=utc_now(),
                attempts=BackgroundJob.attempts + 1,
            )
        )
        db.commit()
        if result.rowcount == 1:
            return db.get(BackgroundJob, job_id, populate_existing=True)
    return None


def execute_job(job_id: str, session_factory: Callable[[], Session]) -> str:
    """Run one claimed job; returns the final status."""
    load_handlers()
    with session_factory() as db:
        job = db.get(BackgroundJob, job_id)
        if job is None:
            return "missing"
        ctx = JobContext(
            job_id=job.id,
            organization_id=job.organization_id,
            payload=dict(job.payload or {}),
            created_by_id=job.created_by_id,
            attempt=job.attempts,
            session_factory=session_factory,
        )
        handler = _handlers.get(job.job_type)
        job_type, attempts, max_attempts = job.job_type, job.attempts, job.max_attempts
        owner = job.locked_by

    if handler is None:
        _finish(session_factory, job_id, owner=owner, status="failed", error=f"No handler for job type {job_type!r}")
        return "failed"

    try:
        with session_factory() as db:
            result = handler(db, ctx) or {}
            db.commit()
    except Exception as exc:  # noqa: BLE001 - every failure is recorded on the job
        permanent = isinstance(exc, PermanentJobError)
        message = str(exc)[:2000] or exc.__class__.__name__
        logger.warning("Job %s (%s) failed: %s", job_id, job_type, message)
        logger.debug(traceback.format_exc())
        if not permanent and attempts < max_attempts:
            backoff = timedelta(seconds=15 * (2 ** (attempts - 1)))
            _finish(session_factory, job_id, owner=owner, status="queued", error=message, run_after=utc_now() + backoff)
            return "queued"
        if not _finish(session_factory, job_id, owner=owner, status="failed", error=message):
            return "lost"
        if not permanent:
            from app.core.monitoring import capture_exception

            capture_exception(exc, job_id=job_id, job_type=job_type)
        hook = _failure_hooks.get(job_type)
        if hook:
            try:
                with session_factory() as db:
                    hook(db, ctx, message)
                    db.commit()
            except Exception:  # pragma: no cover
                logger.exception("Failure hook for job %s raised", job_id)
        return "failed"

    _finish(session_factory, job_id, owner=owner, status="succeeded", result=result)
    return "succeeded"


def _finish(session_factory, job_id: str, *, status: str, owner: str | None = None,
            error: str | None = None, result: dict | None = None, run_after=None) -> bool:
    """Record a job outcome. With ``owner``, only applies while this worker still
    owns the running job (a recovered job may have been re-claimed); returns
    whether the update applied."""
    values: dict[str, Any] = {"status": status, "locked_by": None, "error": error}
    if status in ("succeeded", "failed"):
        values["finished_at"] = utc_now()
    if status == "succeeded":
        values["progress"] = 100
        values["result"] = result
    if run_after is not None:
        values["run_after"] = run_after
    conditions = [BackgroundJob.id == job_id]
    if owner is not None:
        conditions += [BackgroundJob.locked_by == owner, BackgroundJob.status == "running"]
    with session_factory() as db:
        result = db.execute(update(BackgroundJob).where(*conditions).values(**values))
        db.commit()
    if owner is not None and not result.rowcount:
        logger.warning("Job %s no longer owned by this worker; outcome %s discarded", job_id, status)
        return False
    return True


def run_pending_jobs(session_factory: Callable[[], Session], max_jobs: int = 100,
                     job_types: list[str] | None = None) -> int:
    """Synchronously process queued jobs (used by tests and the CLI)."""
    processed = 0
    worker_id = _worker_id()
    while processed < max_jobs:
        with session_factory() as db:
            job = claim_next(db, worker_id, job_types)
        if job is None:
            break
        execute_job(job.id, session_factory)
        processed += 1
    return processed


def cancel_job(db: Session, job: BackgroundJob) -> bool:
    result = db.execute(
        update(BackgroundJob)
        .where(BackgroundJob.id == job.id, BackgroundJob.status == "queued")
        .values(status="cancelled", finished_at=utc_now())
    )
    db.commit()
    return bool(result.rowcount)


def retry_job(db: Session, job: BackgroundJob) -> bool:
    result = db.execute(
        update(BackgroundJob)
        .where(BackgroundJob.id == job.id, or_(BackgroundJob.status == "failed",
                                               BackgroundJob.status == "cancelled"))
        .values(status="queued", attempts=0, run_after=utc_now(), error=None, finished_at=None,
                progress=0)
    )
    db.commit()
    return bool(result.rowcount)


class Worker:
    """Polling worker running in a daemon thread."""

    def __init__(self) -> None:
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._last_schedule = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self.run_forever, name="rightsflow-worker", daemon=True)
        self._thread.start()
        logger.info("Background worker started")

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=10)

    def run_forever(self) -> None:
        from app.db.session import SessionLocal

        load_handlers()
        worker_id = _worker_id()
        while not self._stop.is_set():
            try:
                self._maybe_schedule(SessionLocal)
                with SessionLocal() as db:
                    job = claim_next(db, worker_id)
                if job is not None:
                    execute_job(job.id, SessionLocal)
                    continue
            except Exception:  # pragma: no cover - keep the worker alive
                logger.exception("Worker loop error")
            self._stop.wait(settings.worker_poll_interval_seconds)

    def _maybe_schedule(self, session_factory) -> None:
        now = utc_now()
        if self._last_schedule and now - self._last_schedule < timedelta(hours=1):
            return
        self._last_schedule = now
        from app.services.scheduled import schedule_periodic_jobs

        with session_factory() as db:
            recover_stale_jobs(db)
            schedule_periodic_jobs(db)


worker = Worker()
