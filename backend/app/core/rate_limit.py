"""In-process sliding-window rate limiter.

Adequate for a single API process. When running several API replicas, move
the counters to a shared store (e.g. Redis) behind the same interface.
"""

import threading
import time
from collections import defaultdict, deque

from fastapi import Request

from app.core.config import settings
from app.core.errors import RateLimitedError
from app.core.request_context import client_ip


class SlidingWindowRateLimiter:
    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def hit(self, key: str, limit: int, window_seconds: int) -> tuple[bool, int]:
        """Record a hit. Returns (allowed, retry_after_seconds)."""
        now = time.monotonic()
        with self._lock:
            hits = self._hits[key]
            while hits and hits[0] <= now - window_seconds:
                hits.popleft()
            if len(hits) >= limit:
                retry_after = int(hits[0] + window_seconds - now) + 1
                return False, retry_after
            hits.append(now)
            return True, 0

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


limiter = SlidingWindowRateLimiter()


def enforce_rate_limit(
    request: Request,
    bucket: str,
    *,
    extra_key: str | None = None,
    limit: int | None = None,
    window_seconds: int | None = None,
    include_ip: bool = True,
) -> None:
    """Apply the per-IP limit (always the configured default, so people behind
    one NAT aren't throttled by a stricter per-account rule) and, with
    ``extra_key``, a per-key limit of ``limit`` per ``window_seconds``
    (audit A-08)."""
    default_limit = settings.auth_rate_limit_attempts
    default_window = settings.auth_rate_limit_window_seconds
    checks: list[tuple[str, int, int]] = []
    if include_ip:
        checks.append((f"{bucket}:ip:{client_ip(request)}", default_limit, default_window))
    if extra_key:
        checks.append((f"{bucket}:key:{extra_key.lower()}", limit or default_limit,
                       window_seconds or default_window))
    for key, key_limit, key_window in checks:
        allowed, retry_after = limiter.hit(key, key_limit, key_window)
        if not allowed:
            raise RateLimitedError(
                "Too many attempts. Please wait before trying again.",
                details={"retry_after_seconds": retry_after},
            )


def auth_rate_limit(bucket: str):
    """FastAPI dependency limiting requests per client IP for ``bucket``."""

    def dependency(request: Request) -> None:
        enforce_rate_limit(request, bucket)

    return dependency
