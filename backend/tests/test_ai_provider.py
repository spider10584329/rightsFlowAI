"""Anthropic provider adapter: request headers, error classification, retry policy,
secret hygiene, and the live-connectivity status. The SDK runs for real against an
in-process HTTP transport (no network, no provider cost)."""

import json
import logging

import httpx2 as httpx  # the Anthropic SDK 1.x transport package
import pytest
from sqlalchemy import select

from app.core.config import settings
from app.models.billing import AIUsageRecord
from app.services.ai import AIProviderError
from app.services.ai.provider import AnthropicProvider

FAKE_SECRET = "sk-ant-api03-" + "Z" * 40
SCHEMA = {"type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"],
          "additionalProperties": False}


@pytest.fixture
def anthropic_settings(monkeypatch):
    monkeypatch.setattr(settings, "ai_provider", "anthropic")
    monkeypatch.setattr(settings, "ai_api_key", "test-key-not-real")
    monkeypatch.setattr(settings, "ai_model", "claude-opus-5-5")
    monkeypatch.setattr(settings, "ai_base_url", None)
    monkeypatch.setattr(settings, "ai_workspace_id", None)
    monkeypatch.setattr(settings, "ai_refusal_fallback", False)
    return settings


def provider_with(handler, *, max_retries: int = 0) -> tuple[AnthropicProvider, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    provider = AnthropicProvider()
    provider.client = provider.client.with_options(
        http_client=httpx.Client(transport=httpx.MockTransport(record)), max_retries=max_retries)
    return provider, seen


def error_response(status: int, kind: str, message: str):
    def handler(request):
        return httpx.Response(status, headers={"request-id": "req_test_1"},
                              json={"type": "error", "error": {"type": kind, "message": message}})
    return handler


def ok_response(request):
    return httpx.Response(200, json={
        "id": "msg_1", "type": "message", "role": "assistant", "model": "claude-opus-5-5",
        "content": [{"type": "text", "text": json.dumps({"ok": True})}],
        "stop_reason": "end_turn", "stop_sequence": None, "usage": {"input_tokens": 5, "output_tokens": 3}})


def call(provider) -> None:
    provider.generate_json(system="s", messages=[{"role": "user", "content": "hi"}], schema=SCHEMA, max_tokens=32)


def test_unscoped_key_400_is_classified_sanitized_and_not_retried(anthropic_settings, caplog):
    """The real failure seen in production: a key without a workspace."""
    provider, seen = provider_with(error_response(
        400, "invalid_request_error",
        f"This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id "
        f"header. Key {FAKE_SECRET}"), max_retries=2)
    with caplog.at_level(logging.WARNING), pytest.raises(AIProviderError) as raised:
        call(provider)
    err = raised.value
    assert len(seen) == 1  # permanent 400: never retried, even with max_retries=2
    assert err.code == "ai_configuration_error" and "AI_WORKSPACE_ID" in err.message
    assert err.details == {"provider_status": 400, "provider_request_id": "req_test_1"}
    assert FAKE_SECRET not in err.message and FAKE_SECRET not in caplog.text
    assert "req_test_1" in caplog.text  # correlatable in the server log


def test_workspace_id_is_sent_when_configured(anthropic_settings, monkeypatch):
    monkeypatch.setattr(settings, "ai_workspace_id", "wrkspc_test")
    provider, seen = provider_with(ok_response)
    provider.generate_json(system="s", messages=[{"role": "user", "content": "hi"}], schema=SCHEMA, max_tokens=32)
    assert seen[0].headers["anthropic-workspace-id"] == "wrkspc_test"
    body = json.loads(seen[0].content)
    assert body["model"] == "claude-opus-5-5"
    assert body["output_config"]["effort"] == settings.ai_effort
    assert body["output_config"]["format"]["type"] == "json_schema"


def test_no_workspace_header_by_default(anthropic_settings):
    provider, seen = provider_with(ok_response)
    call(provider)
    assert "anthropic-workspace-id" not in seen[0].headers


@pytest.mark.parametrize(("status", "kind", "message", "code"), [
    (401, "authentication_error", "invalid x-api-key", "ai_auth_failed"),
    (403, "permission_error", "Your API key does not have permission", "ai_permission_denied"),
    (404, "not_found_error", "model: claude-nope", "ai_model_unavailable"),
    (400, "invalid_request_error", "The model claude-nope does not exist", "ai_model_unavailable"),
    (400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API.", "ai_billing"),
    (429, "rate_limit_error", "Number of requests has exceeded your rate limit", "ai_rate_limited"),
    (529, "overloaded_error", "Overloaded", "ai_unavailable"),
    (500, "api_error", "Internal server error", "ai_unavailable"),
    (413, "request_too_large", "Request exceeds the maximum allowed number of bytes.", "ai_invalid_request"),
    (400, "invalid_request_error", "messages.0.content: Field required", "ai_invalid_request"),
    (400, "invalid_request_error", "max_tokens: 99999999 > 64000, which is the maximum for this model",
     "ai_invalid_request"),
])
def test_provider_errors_are_classified(anthropic_settings, status, kind, message, code):
    provider, _ = provider_with(error_response(status, kind, message))
    with pytest.raises(AIProviderError) as raised:
        call(provider)
    assert raised.value.code == code
    assert message not in raised.value.message  # the provider's text never reaches the client


def test_network_failure_is_reported_as_unreachable(anthropic_settings):
    def refuse(request):
        raise httpx.ConnectError("connection refused")

    provider, _ = provider_with(refuse)
    with pytest.raises(AIProviderError) as raised:
        call(provider)
    assert raised.value.code == "ai_unreachable"


def test_beta_fallback_path_classifies_the_same_way(anthropic_settings, monkeypatch):
    monkeypatch.setattr(settings, "ai_refusal_fallback", True)
    provider, seen = provider_with(error_response(400, "invalid_request_error",
                                                  "This API key is not scoped to a workspace"))
    with pytest.raises(AIProviderError) as raised:
        call(provider)
    assert raised.value.code == "ai_configuration_error"
    assert "server-side-fallback" in seen[0].headers.get("anthropic-beta", "")


# --------------------------------------------------------------------------- status / connection check


def url(team: dict, path: str, org_id: str | None = None) -> str:
    return f"/api/v1/organizations/{org_id or team['org_id']}/ai{path}"


def test_status_reports_live_connectivity_not_just_configuration(client, team, db, fake_ai):
    admin = team["admin"]["headers"]
    status = client.get(url(team, "/status"), headers=team["viewer"]["headers"]).json()
    assert status["configured"] is True and status["connectivity"]["state"] == "unverified"

    fake_ai.error = AIProviderError("The AI API key is not scoped to a workspace.", code="ai_configuration_error")
    failed = client.post(url(team, "/status/check"), headers=admin)
    assert failed.status_code == 502 and failed.json()["error"]["code"] == "ai_configuration_error"
    status = client.get(url(team, "/status"), headers=team["viewer"]["headers"]).json()
    assert status["connectivity"]["state"] == "failing"
    assert status["connectivity"]["last_error_code"] == "ai_configuration_error"
    assert status["connectivity"]["last_error_message"].startswith("The AI API key is not scoped")

    fake_ai.error = None
    fake_ai.responses["_ConnectionCheck"] = {"ok": True}
    ok = client.post(url(team, "/status/check"), headers=admin)
    assert ok.status_code == 200 and ok.json()["connectivity"]["state"] == "verified"
    # Both checks are recorded as usage (created_at has second precision, so no ordering).
    statuses = db.scalars(select(AIUsageRecord.status).where(AIUsageRecord.feature == "connection_check")).all()
    assert sorted(statuses) == ["error", "success"]


def test_transient_errors_do_not_mark_the_provider_as_failing(client, team, fake_ai):
    fake_ai.error = AIProviderError("slow", code="ai_timeout")
    client.post(url(team, "/assistant"), headers=team["manager"]["headers"], json={"question": "Anything?"})
    status = client.get(url(team, "/status"), headers=team["viewer"]["headers"]).json()
    assert status["connectivity"]["state"] == "unverified"
    assert status["connectivity"]["last_error_code"] == "ai_timeout"


def test_connection_check_is_admin_only_and_tenant_scoped(client, team, fake_ai):
    fake_ai.responses["_ConnectionCheck"] = {"ok": True}
    assert client.post(url(team, "/status/check"), headers=team["manager"]["headers"]).status_code == 403
    assert client.post(url(team, "/status/check"), headers=team["outsider"]["headers"]).status_code == 404
    assert client.post(url(team, "/status/check"), headers=team["admin"]["headers"]).status_code == 200
    other = client.get(url(team, "/status", org_id=team["other_org"]["id"]),
                       headers=team["outsider"]["headers"]).json()
    assert other["connectivity"]["state"] == "unverified"  # another org's success is not shared
