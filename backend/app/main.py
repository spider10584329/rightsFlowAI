from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.api.v1 import build_v1_router
from app.core.config import settings
from app.core.errors import register_exception_handlers
from app.core.logging import configure_logging, get_logger
from app.core.monitoring import init_monitoring
from app.core.request_context import RequestContextMiddleware
from app.db.session import SessionLocal

configure_logging(settings.log_level, settings.log_json)
logger = get_logger("rightsflow")
init_monitoring()


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    from app.services.billing import ensure_plans
    from app.services.jobs import worker

    try:
        with SessionLocal() as db:
            ensure_plans(db)
    except Exception:  # pragma: no cover - startup must not crash on a cold DB
        logger.exception("Could not seed subscription plans at startup")

    if settings.run_embedded_worker and settings.app_env != "test":
        worker.start()
    logger.info("RightsFlow AI API started", extra={"context": {"env": settings.app_env}})
    try:
        yield
    finally:
        worker.stop()


app = FastAPI(
    title="RightsFlow AI API",
    description=(
        "Music rights, publishing administration and royalty accounting API. "
        "All tenant data lives under `/api/v1/organizations/{organization_id}/...` "
        "and requires an active membership in that organization."
    ),
    version=settings.app_version,
    lifespan=lifespan,
    docs_url="/docs" if settings.api_docs_enabled else None,
    redoc_url="/redoc" if settings.api_docs_enabled else None,
    openapi_url="/openapi.json" if settings.api_docs_enabled else None,
)

app.add_middleware(RequestContextMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Request-ID", "Idempotency-Key"],
    expose_headers=["X-Request-ID", "Content-Disposition"],
)
register_exception_handlers(app)
app.include_router(build_v1_router())


@app.get("/health", tags=["System"])
def health_check():
    """Liveness probe."""
    return {"status": "healthy", "service": "RightsFlow AI API", "version": settings.app_version}


@app.get("/health/ready", tags=["System"])
def readiness_check():
    """Readiness probe: verifies database connectivity."""
    try:
        with SessionLocal() as db:
            db.execute(text("SELECT 1"))
    except Exception:
        logger.exception("Readiness check failed")
        return JSONResponse(status_code=503, content={"status": "unavailable", "database": "down"})
    return {"status": "ready", "database": "up"}
