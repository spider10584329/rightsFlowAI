"""Standalone background worker.

    python -m app.worker          # run until interrupted
    python -m app.worker --once   # process queued jobs, then exit
"""

import argparse
import signal

from app.core.config import settings
from app.core.logging import configure_logging, get_logger
from app.db.session import SessionLocal
from app.services.billing import ensure_plans
from app.services.jobs import load_handlers, run_pending_jobs, worker

logger = get_logger("rightsflow.worker")


def main() -> None:
    parser = argparse.ArgumentParser(description="RightsFlow AI background worker")
    parser.add_argument("--once", action="store_true", help="Drain the queue and exit")
    args = parser.parse_args()

    configure_logging(settings.log_level, settings.log_json)
    with SessionLocal() as db:
        ensure_plans(db)
    load_handlers()

    if args.once:
        processed = run_pending_jobs(SessionLocal, max_jobs=10_000)
        logger.info("Processed %s job(s)", processed)
        return

    signal.signal(signal.SIGINT, lambda *_: worker.stop())
    signal.signal(signal.SIGTERM, lambda *_: worker.stop())
    logger.info("Worker running; press Ctrl+C to stop")
    worker.run_forever()


if __name__ == "__main__":
    main()
