"""Client for the platform n8n (managed mode).

Uses n8n's public REST API (``N8N_API_URL``, authenticated with
``X-N8N-API-KEY``) to create, update, publish and delete the credentials and
workflows RightsFlow provisions for each organization, and calls a workflow's
"Run on request" webhook to start it now. Verified against n8n 2.43.5.

Tests replace the client with an in-memory fake through ``set_n8n_client``.
"""

from typing import Any, Protocol

import httpx

from app.core.config import settings
from app.core.logging import get_logger
from app.services.automation.credentials import redact

logger = get_logger(__name__)


class N8nError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class N8nNotConfigured(N8nError):
    pass


class N8nNotFound(N8nError):
    pass


class N8nApi(Protocol):
    def get_credential(self, credential_id: str) -> dict[str, Any] | None: ...
    def create_credential(self, *, name: str, credential_type: str, data: dict[str, Any]) -> dict[str, Any]: ...
    def update_credential(self, credential_id: str, *, name: str, data: dict[str, Any]) -> dict[str, Any]: ...
    def delete_credential(self, credential_id: str) -> None: ...
    def get_workflow(self, workflow_id: str) -> dict[str, Any] | None: ...
    def create_workflow(self, body: dict[str, Any]) -> dict[str, Any]: ...
    def update_workflow(self, workflow_id: str, body: dict[str, Any]) -> dict[str, Any]: ...
    def publish_workflow(self, workflow_id: str) -> None: ...
    def unpublish_workflow(self, workflow_id: str) -> None: ...
    def delete_workflow(self, workflow_id: str) -> None: ...
    def trigger_webhook(self, path: str, *, header_name: str, secret: str, payload: dict[str, Any]) -> None: ...


class HttpN8nClient:
    def __init__(self, api_url: str, api_key: str, webhook_url: str, timeout: float):
        self.api_url = api_url.rstrip("/")
        self.webhook_url = webhook_url.rstrip("/")
        self._headers = {"X-N8N-API-KEY": api_key, "Accept": "application/json"}
        self._timeout = timeout

    def _request(self, method: str, path: str, *, json: Any = None) -> Any:
        try:
            response = httpx.request(method, f"{self.api_url}{path}", json=json, headers=self._headers,
                                     timeout=self._timeout)
        except httpx.HTTPError as exc:
            raise N8nError(f"n8n is unreachable: {exc.__class__.__name__}") from exc
        if response.status_code == 404:
            raise N8nNotFound(f"{method} {path}: not found", 404)
        if response.status_code >= 400:
            try:
                message = response.json().get("message") or response.text
            except ValueError:
                message = response.text
            raise N8nError(f"{method} {path} failed (HTTP {response.status_code}): {redact(str(message), 300)}",
                           response.status_code)
        return response.json() if response.content else None

    # credentials ---------------------------------------------------------------

    def get_credential(self, credential_id: str) -> dict[str, Any] | None:
        try:
            return self._request("GET", f"/credentials/{credential_id}")
        except N8nNotFound:
            return None

    def create_credential(self, *, name: str, credential_type: str, data: dict[str, Any]) -> dict[str, Any]:
        return self._request("POST", "/credentials", json={"name": name, "type": credential_type, "data": data})

    def update_credential(self, credential_id: str, *, name: str, data: dict[str, Any]) -> dict[str, Any]:
        return self._request("PATCH", f"/credentials/{credential_id}", json={"name": name, "data": data})

    def delete_credential(self, credential_id: str) -> None:
        try:
            self._request("DELETE", f"/credentials/{credential_id}")
        except N8nNotFound:
            pass

    # workflows -----------------------------------------------------------------

    def get_workflow(self, workflow_id: str) -> dict[str, Any] | None:
        try:
            return self._request("GET", f"/workflows/{workflow_id}?excludePinnedData=true")
        except N8nNotFound:
            return None

    def create_workflow(self, body: dict[str, Any]) -> dict[str, Any]:
        return self._request("POST", "/workflows", json=body)

    def update_workflow(self, workflow_id: str, body: dict[str, Any]) -> dict[str, Any]:
        return self._request("PUT", f"/workflows/{workflow_id}", json=body)

    def publish_workflow(self, workflow_id: str) -> None:
        self._request("POST", f"/workflows/{workflow_id}/publish", json={})

    def unpublish_workflow(self, workflow_id: str) -> None:
        try:
            self._request("POST", f"/workflows/{workflow_id}/unpublish")
        except N8nNotFound:
            pass

    def delete_workflow(self, workflow_id: str) -> None:
        try:
            self._request("DELETE", f"/workflows/{workflow_id}")
        except N8nNotFound:
            pass

    # triggers ------------------------------------------------------------------

    def trigger_webhook(self, path: str, *, header_name: str, secret: str, payload: dict[str, Any]) -> None:
        url = f"{self.webhook_url}/{path}"
        try:
            response = httpx.post(url, json=payload, headers={header_name: secret}, timeout=self._timeout)
        except httpx.HTTPError as exc:
            raise N8nError(f"n8n is unreachable: {exc.__class__.__name__}") from exc
        if response.status_code >= 400:
            raise N8nError(f"The workflow did not accept the request (HTTP {response.status_code})",
                           response.status_code)


_override: N8nApi | None = None


def set_n8n_client(client: N8nApi | None) -> None:
    """Test hook: use ``client`` instead of the configured HTTP client."""
    global _override
    _override = client


def n8n_available() -> bool:
    return _override is not None or settings.n8n_configured


def get_n8n_client() -> N8nApi:
    if _override is not None:
        return _override
    if not settings.n8n_configured:
        raise N8nNotConfigured("Automation is not configured on this server (N8N_API_URL / N8N_API_KEY)")
    return HttpN8nClient(settings.n8n_api_url or "", settings.n8n_api_key or "", settings.n8n_webhook_base_url,
                         settings.n8n_timeout_seconds)
