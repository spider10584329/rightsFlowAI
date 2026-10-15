"""AI provider abstraction.

Providers return structured JSON validated against a schema. No provider is
active unless AI_PROVIDER and AI_API_KEY are configured; callers then receive
an explicit ``ai_not_configured`` error instead of fabricated output.
"""

import json
import re
import time
from dataclasses import dataclass
from typing import Any, Protocol

from app.core.config import settings
from app.core.errors import AppError
from app.core.logging import get_logger

logger = get_logger(__name__)


class AINotConfiguredError(AppError):
    status_code = 503
    code = "ai_not_configured"

    def __init__(self) -> None:
        super().__init__(
            "AI provider not configured. Set AI_PROVIDER and AI_API_KEY on the server to "
            "enable AI features."
        )


class AIProviderError(AppError):
    status_code = 502
    code = "ai_provider_error"

    def __init__(self, message: str, *, code: str | None = None,
                 usage: tuple[int, int] | None = None, **kwargs) -> None:
        super().__init__(message, code=code, **kwargs)
        # (input_tokens, output_tokens) already billed by the provider, if known.
        self.usage = usage


@dataclass
class AIResult:
    data: dict[str, Any]
    provider: str
    model: str
    input_tokens: int
    output_tokens: int
    latency_ms: int


class AIProvider(Protocol):
    name: str
    model: str

    def generate_json(
        self,
        *,
        system: str,
        messages: list[dict[str, Any]],
        schema: dict[str, Any],
        max_tokens: int,
    ) -> AIResult: ...


_SECRET_RE = re.compile(r"(sk-ant-|sk-|Bearer\s+)[A-Za-z0-9_\-]{8,}")
_MODEL_PROBLEM_RE = re.compile(r"\bmodel\b[^.]*\b(not found|does not exist|invalid|unknown|not supported|not available)"
                               r"|\b(invalid|unknown|unsupported) model\b")


def _sanitize(text: str | None) -> str:
    return _SECRET_RE.sub(r"\1[redacted]", text or "")[:300]


def classify_anthropic_error(exc: Exception) -> AIProviderError:
    """Translate an Anthropic SDK error into a safe, actionable AIProviderError.

    The browser only sees our own message and code. The provider's message (sanitized)
    and request id are logged server-side for diagnosis, never returned to the client.
    """
    import anthropic

    if isinstance(exc, anthropic.APITimeoutError):
        return AIProviderError("The AI provider timed out; try again shortly", code="ai_timeout")
    if isinstance(exc, anthropic.APIConnectionError):
        return AIProviderError("Could not reach the AI provider (network problem)", code="ai_unreachable")
    if not isinstance(exc, anthropic.APIStatusError):
        return AIProviderError("The AI provider failed unexpectedly")

    body = exc.body if isinstance(exc.body, dict) else {}
    error = body.get("error") if isinstance(body.get("error"), dict) else {}
    kind = str(error.get("type") or "")
    provider_message = str(error.get("message") or "")
    lowered = provider_message.lower()
    status = exc.status_code
    logger.warning("AI provider returned HTTP %s (%s, request %s): %s", status, kind or type(exc).__name__,
                   exc.request_id, _sanitize(provider_message))
    details = {"provider_status": status, "provider_request_id": exc.request_id}

    if status == 401 or kind == "authentication_error":
        return AIProviderError("The AI provider rejected the configured API key. An administrator must "
                               "update AI_API_KEY.", code="ai_auth_failed", details=details)
    if status == 403 or kind == "permission_error":
        return AIProviderError("The configured API key is not allowed to use this model or feature.",
                               code="ai_permission_denied", details=details)
    if kind == "billing_error" or "credit balance" in lowered or "billing" in lowered:
        return AIProviderError("The AI provider account has a billing problem (for example, no credit "
                               "left). An administrator must check the provider account.",
                               code="ai_billing", details=details)
    if "workspace" in lowered:
        return AIProviderError("The AI API key needs a workspace: an administrator must set AI_WORKSPACE_ID "
                               "to a workspace this key can use, or use a workspace-scoped key.",
                               code="ai_configuration_error", details=details)
    if status == 404 or kind == "not_found_error" or (status == 400 and _MODEL_PROBLEM_RE.search(lowered)):
        return AIProviderError(f"The configured AI model '{settings.ai_model}' is not available to this "
                               "account. An administrator must check AI_MODEL.",
                               code="ai_model_unavailable", details=details)
    if status == 429 or kind == "rate_limit_error":
        return AIProviderError("The AI provider is rate limiting requests; try again shortly",
                               code="ai_rate_limited", details=details)
    if status in (500, 502, 503, 504, 529) or kind in ("api_error", "overloaded_error"):
        return AIProviderError("The AI provider is temporarily unavailable; try again shortly",
                               code="ai_unavailable", details=details)
    if status == 413 or kind == "request_too_large":
        return AIProviderError("This AI request is too large; shorten it and try again",
                               code="ai_invalid_request", details=details)
    return AIProviderError("The AI provider could not process this request", code="ai_invalid_request",
                           details=details)


class AnthropicProvider:
    """Claude via the official Anthropic SDK with structured outputs."""

    name = "anthropic"

    def __init__(self) -> None:
        import anthropic

        self._anthropic = anthropic
        self.model = settings.ai_model
        # API keys that aren't scoped to a workspace must name one on every request.
        headers = {"anthropic-workspace-id": settings.ai_workspace_id} if settings.ai_workspace_id else None
        # The SDK retries only connection errors, 408, 409, 429 and 5xx; a 400 is never retried.
        self.client = anthropic.Anthropic(
            api_key=settings.ai_api_key,
            base_url=settings.ai_base_url or None,
            timeout=settings.ai_timeout_seconds,
            max_retries=settings.ai_max_retries,
            default_headers=headers,
        )

    def generate_json(self, *, system, messages, schema, max_tokens) -> AIResult:
        anthropic = self._anthropic
        started = time.perf_counter()
        kwargs: dict[str, Any] = {
            "model": self.model,
            "max_tokens": max_tokens,
            "system": system,
            "messages": messages,
            "output_config": {
                "effort": settings.ai_effort,
                "format": {"type": "json_schema", "schema": schema},
            },
        }
        try:
            if settings.ai_refusal_fallback and not settings.ai_base_url:
                response = self.client.beta.messages.create(
                    betas=["server-side-fallback-2026-07-01"], fallbacks="default", **kwargs
                )
            else:
                response = self.client.messages.create(**kwargs)
        except anthropic.APIError as exc:
            raise classify_anthropic_error(exc) from exc

        latency = int((time.perf_counter() - started) * 1000)
        billed = (response.usage.input_tokens, response.usage.output_tokens)
        if response.stop_reason == "refusal":
            raise AIProviderError("The AI model declined this request", code="ai_refused", usage=billed)
        if response.stop_reason == "max_tokens":
            raise AIProviderError("The AI response was truncated", code="ai_truncated", usage=billed)
        text = next((b.text for b in response.content if b.type == "text"), None)
        if text is None:
            raise AIProviderError("The AI provider returned no content")
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise AIProviderError("The AI provider returned malformed JSON") from exc
        return AIResult(
            data=data,
            provider=self.name,
            model=getattr(response, "model", self.model),
            input_tokens=response.usage.input_tokens,
            output_tokens=response.usage.output_tokens,
            latency_ms=latency,
        )


def _openai_compatible_error(status: int) -> AIProviderError:
    logger.warning("AI gateway returned HTTP %s", status)
    details = {"provider_status": status}
    if status == 401:
        return AIProviderError("The AI provider rejected the configured API key. An administrator must "
                               "update AI_API_KEY.", code="ai_auth_failed", details=details)
    if status == 403:
        return AIProviderError("The configured API key is not allowed to use this model or feature.",
                               code="ai_permission_denied", details=details)
    if status == 404:
        return AIProviderError(f"The configured AI model '{settings.ai_model}' is not available. An "
                               "administrator must check AI_MODEL and AI_BASE_URL.",
                               code="ai_model_unavailable", details=details)
    if status == 429:
        return AIProviderError("The AI provider is rate limiting requests; try again shortly",
                               code="ai_rate_limited", details=details)
    if status >= 500:
        return AIProviderError("The AI provider is temporarily unavailable; try again shortly",
                               code="ai_unavailable", details=details)
    return AIProviderError("The AI provider could not process this request", code="ai_invalid_request",
                           details=details)


class OpenAICompatibleProvider:
    """Any chat-completions API that supports JSON-schema response formats
    (for organizations that standardize on another vendor or a gateway)."""

    name = "openai_compatible"

    def __init__(self) -> None:
        if not settings.ai_base_url:
            raise AINotConfiguredError()
        self.model = settings.ai_model
        self.base_url = settings.ai_base_url.rstrip("/")

    def _token_limit_param(self) -> str:
        if settings.ai_token_limit_param != "auto":
            return settings.ai_token_limit_param
        from urllib.parse import urlparse

        host = (urlparse(self.base_url).hostname or "").lower()
        return "max_completion_tokens" if host == "api.openai.com" else "max_tokens"

    def generate_json(self, *, system, messages, schema, max_tokens) -> AIResult:
        import httpx

        started = time.perf_counter()
        payload = {
            "model": self.model,
            self._token_limit_param(): max_tokens,
            "messages": [{"role": "system", "content": system}, *messages],
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": "result", "schema": schema, "strict": True},
            },
        }
        last_error: Exception | None = None
        for attempt in range(settings.ai_max_retries + 1):
            try:
                response = httpx.post(
                    f"{self.base_url}/chat/completions",
                    json=payload,
                    headers={"Authorization": f"Bearer {settings.ai_api_key}"},
                    timeout=settings.ai_timeout_seconds,
                )
                if response.status_code in (429, 500, 502, 503, 504) and attempt < settings.ai_max_retries:
                    time.sleep(2 ** attempt)
                    continue
                if response.status_code >= 400:
                    raise _openai_compatible_error(response.status_code)
                body = response.json()
                usage = body.get("usage") or {}
                billed = (int(usage.get("prompt_tokens", 0)), int(usage.get("completion_tokens", 0)))
                choice = (body.get("choices") or [{}])[0]
                message = choice.get("message") or {}
                if choice.get("finish_reason") == "length":
                    # Reasoning tokens count against the limit too; the output may be empty.
                    raise AIProviderError("The AI response was truncated", code="ai_truncated", usage=billed)
                if message.get("refusal"):
                    raise AIProviderError("The AI model declined this request", code="ai_refused",
                                          usage=billed)
                if not isinstance(message.get("content"), str):
                    raise AIProviderError("The AI provider returned no content", usage=billed)
                data = json.loads(message["content"])
                return AIResult(
                    data=data,
                    provider=self.name,
                    model=body.get("model", self.model),
                    input_tokens=int(usage.get("prompt_tokens", 0)),
                    output_tokens=int(usage.get("completion_tokens", 0)),
                    latency_ms=int((time.perf_counter() - started) * 1000),
                )
            except httpx.TimeoutException as exc:
                last_error = exc
            except httpx.HTTPError as exc:  # connection refused, DNS, protocol errors
                raise AIProviderError("Could not reach the AI provider") from exc
            except (KeyError, ValueError, IndexError, TypeError, AttributeError, json.JSONDecodeError) as exc:
                raise AIProviderError("The AI provider returned malformed output") from exc
        raise AIProviderError("The AI provider timed out", code="ai_timeout") from last_error


_override: AIProvider | None = None


def set_ai_provider(provider: AIProvider | None) -> None:
    """Install a provider explicitly (used by tests)."""
    global _override
    _override = provider


def ai_is_configured() -> bool:
    return _override is not None or settings.ai_configured


def get_ai_provider() -> AIProvider:
    if _override is not None:
        return _override
    if not settings.ai_configured:
        raise AINotConfiguredError()
    if settings.ai_provider == "anthropic":
        return AnthropicProvider()
    if settings.ai_provider == "openai_compatible":
        return OpenAICompatibleProvider()
    raise AINotConfiguredError()
