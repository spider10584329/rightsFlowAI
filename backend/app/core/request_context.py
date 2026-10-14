"""Per-request metadata: request id, client IP and user agent."""

import time
from uuid import uuid4

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.responses import Response

from app.core.config import settings
from app.core.errors import unexpected_error_response
from app.core.logging import get_logger, request_id_var

logger = get_logger("rightsflow.http")


def client_ip(request: Request) -> str:
    """Best-effort client IP. X-Forwarded-For is trusted only when
    ``TRUSTED_PROXY_COUNT`` > 0 (i.e. the API runs behind known proxies)."""
    if settings.trusted_proxy_count > 0:
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            hops = [h.strip() for h in forwarded.split(",") if h.strip()]
            if len(hops) >= settings.trusted_proxy_count:
                return hops[-settings.trusted_proxy_count]
    return request.client.host if request.client else "unknown"


def user_agent(request: Request) -> str | None:
    value = request.headers.get("user-agent")
    return value[:255] if value else None


class RequestContextMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        incoming = request.headers.get("x-request-id", "")
        request_id = incoming if 8 <= len(incoming) <= 64 and incoming.isascii() else str(uuid4())
        token = request_id_var.set(request_id)
        started = time.perf_counter()
        try:
            try:
                response = await call_next(request)
            except Exception as exc:  # noqa: BLE001 - becomes a generic 500 below
                response = unexpected_error_response(exc)
        finally:
            request_id_var.reset(token)
        elapsed_ms = round((time.perf_counter() - started) * 1000, 1)
        response.headers["X-Request-ID"] = request_id
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        if settings.is_production:
            response.headers.setdefault(
                "Strict-Transport-Security", "max-age=63072000; includeSubDomains"
            )
        logger.info(
            "%s %s -> %s",
            request.method,
            request.url.path,
            response.status_code,
            extra={"context": {"duration_ms": elapsed_ms, "request_id": request_id}},
        )
        return response
