"""Domain errors and the structured error response format.

Every error returned by the API has the shape::

    {"error": {"code": "not_found", "message": "...", "details": ...},
     "detail": "...", "request_id": "..."}

``detail`` mirrors ``message`` for backward compatibility with clients that
read FastAPI's default ``detail`` field.
"""

from typing import Any

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.core.logging import get_logger, request_id_var

logger = get_logger(__name__)


class AppError(Exception):
    status_code: int = status.HTTP_400_BAD_REQUEST
    code: str = "bad_request"

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        details: Any = None,
        status_code: int | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        if code:
            self.code = code
        if status_code:
            self.status_code = status_code
        self.details = details


class NotFoundError(AppError):
    status_code = status.HTTP_404_NOT_FOUND
    code = "not_found"


class ConflictError(AppError):
    status_code = status.HTTP_409_CONFLICT
    code = "conflict"


class PermissionDeniedError(AppError):
    status_code = status.HTTP_403_FORBIDDEN
    code = "forbidden"


class AuthenticationError(AppError):
    status_code = status.HTTP_401_UNAUTHORIZED
    code = "unauthorized"


class ValidationFailedError(AppError):
    status_code = status.HTTP_422_UNPROCESSABLE_CONTENT
    code = "validation_failed"


class LimitExceededError(AppError):
    status_code = status.HTTP_402_PAYMENT_REQUIRED
    code = "plan_limit_exceeded"


class RateLimitedError(AppError):
    status_code = status.HTTP_429_TOO_MANY_REQUESTS
    code = "rate_limited"


class ServiceUnavailableError(AppError):
    status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    code = "service_unavailable"


def _body(code: str, message: str, details: Any = None) -> dict[str, Any]:
    return {
        "error": {"code": code, "message": message, "details": jsonable_encoder(details)},
        "detail": message,
        "request_id": request_id_var.get(),
    }


_HTTP_CODES = {
    400: "bad_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    409: "conflict",
    413: "payload_too_large",
    415: "unsupported_media_type",
    422: "validation_failed",
    429: "rate_limited",
}


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def handle_app_error(_: Request, exc: AppError) -> JSONResponse:
        headers = None
        if isinstance(exc, AuthenticationError):
            headers = {"WWW-Authenticate": "Bearer"}
        return JSONResponse(
            status_code=exc.status_code,
            content=_body(exc.code, exc.message, exc.details),
            headers=headers,
        )

    @app.exception_handler(HTTPException)
    async def handle_http_error(_: Request, exc: HTTPException) -> JSONResponse:
        message = exc.detail if isinstance(exc.detail, str) else "Request failed"
        details = None if isinstance(exc.detail, str) else exc.detail
        return JSONResponse(
            status_code=exc.status_code,
            content=_body(_HTTP_CODES.get(exc.status_code, "error"), message, details),
            headers=getattr(exc, "headers", None),
        )

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(
        _: Request, exc: RequestValidationError
    ) -> JSONResponse:
        errors = [
            {
                "loc": [str(part) for part in err.get("loc", [])],
                "message": err.get("msg", "Invalid value"),
                "type": err.get("type", "value_error"),
            }
            for err in exc.errors()
        ]
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            content=_body("validation_failed", "Request validation failed", errors),
        )

    from sqlalchemy.exc import DataError, IntegrityError, OperationalError

    @app.exception_handler(IntegrityError)
    async def handle_integrity_error(_: Request, exc: IntegrityError) -> JSONResponse:
        # A unique/foreign-key constraint caught a race or a stale reference.
        # The transaction was rolled back; nothing partial was committed.
        logger.warning("Integrity error: %s", str(exc.orig)[:300])
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            content=_body("conflict", "The request conflicts with the current data. Refresh and try again."),
        )

    @app.exception_handler(DataError)
    async def handle_data_error(_: Request, exc: DataError) -> JSONResponse:
        # Strict SQL mode rejected an out-of-range or over-long value.
        logger.warning("Data error: %s", str(exc.orig)[:300])
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            content=_body("validation_failed", "A value is out of range or too long."),
        )

    @app.exception_handler(OperationalError)
    async def handle_operational_error(_: Request, exc: OperationalError) -> JSONResponse:
        code = getattr(exc.orig, "args", [None])[0]
        if code in (1205, 1213):  # lock wait timeout / deadlock: safe to retry
            logger.warning("Lock conflict (%s); asking client to retry", code)
            return JSONResponse(
                status_code=status.HTTP_409_CONFLICT,
                content=_body("concurrent_update", "Another change was in progress. Please retry."),
            )
        logger.exception("Database operational error", exc_info=exc)
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content=_body("service_unavailable", "The database is temporarily unavailable."),
        )

    @app.exception_handler(Exception)
    async def handle_unexpected(_: Request, exc: Exception) -> JSONResponse:
        return unexpected_error_response(exc)


def unexpected_error_response(exc: Exception) -> JSONResponse:
    """Generic 500. Called from RequestContextMiddleware so the response still
    carries the request id and security headers (audit AF-15); the app-level
    handler is a fallback for errors raised outside it."""
    logger.exception("Unhandled error", exc_info=exc)
    from app.core.monitoring import capture_exception

    capture_exception(exc, request_id=request_id_var.get())
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content=_body("internal_error", "An unexpected error occurred"),
    )
