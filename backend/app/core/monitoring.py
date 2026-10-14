"""Optional error monitoring.

Set ERROR_MONITORING_DSN (a Sentry-compatible DSN) and install ``sentry-sdk``
(listed in requirements-optional.txt) to report unhandled API and job errors.
Without a DSN this module does nothing.
"""

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)
_enabled = False


def init_monitoring() -> bool:
    global _enabled
    if not settings.error_monitoring_dsn:
        return False
    try:
        import sentry_sdk  # type: ignore[import-not-found]
    except ImportError:
        logger.warning("ERROR_MONITORING_DSN is set but sentry-sdk is not installed; "
                       "error monitoring disabled")
        return False
    sentry_sdk.init(
        dsn=settings.error_monitoring_dsn,
        environment=settings.app_env,
        release=settings.app_version,
        send_default_pii=False,
        traces_sample_rate=0.0,
    )
    _enabled = True
    logger.info("Error monitoring enabled")
    return True


def capture_exception(exc: BaseException, **context: object) -> None:
    if not _enabled:
        return
    try:
        import sentry_sdk  # type: ignore[import-not-found]

        with sentry_sdk.new_scope() as scope:
            for key, value in context.items():
                scope.set_extra(key, value)
            sentry_sdk.capture_exception(exc)
    except Exception:  # pragma: no cover - monitoring must never break requests
        logger.debug("Error monitoring capture failed", exc_info=True)
