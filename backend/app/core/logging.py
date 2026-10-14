"""Structured logging configuration."""

import json
import logging
import sys
from contextvars import ContextVar
from datetime import datetime, timezone

request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, object] = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        request_id = request_id_var.get()
        if request_id:
            payload["request_id"] = request_id
        extra = getattr(record, "context", None)
        if isinstance(extra, dict):
            payload.update(extra)
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


class TextFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        base = super().format(record)
        request_id = request_id_var.get()
        extra = getattr(record, "context", None)
        parts = [base]
        if request_id:
            parts.append(f"request_id={request_id}")
        if isinstance(extra, dict) and extra:
            parts.append(" ".join(f"{k}={v}" for k, v in extra.items()))
        return " | ".join(parts)


def configure_logging(level: str = "INFO", as_json: bool = False) -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        JsonFormatter()
        if as_json
        else TextFormatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    )
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level.upper())
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)
