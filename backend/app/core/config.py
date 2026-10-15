"""Centralized application configuration.

All settings are read from environment variables (and ``backend/.env`` in
development). Secrets never leave the server: nothing in this module is
exposed through the API.
"""

import math
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=BACKEND_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # Application
    app_name: str = "RightsFlow AI"
    app_env: Literal["development", "test", "staging", "production"] = "development"
    app_version: str = "1.0.0"
    log_level: str = "INFO"
    log_json: bool = False

    # Database
    database_url: str
    test_database_url: str | None = None
    db_pool_size: int = 10
    db_max_overflow: int = 20

    # Authentication
    jwt_secret_key: str = Field(min_length=32)
    jwt_algorithm: Literal["HS256", "HS384", "HS512"] = "HS256"
    access_token_expire_minutes: int = 30
    refresh_token_expire_days: int = 14
    password_reset_expire_minutes: int = 60
    email_verification_expire_hours: int = 48
    invitation_expire_days: int = 7
    require_email_verification: bool = False

    # Rate limiting (per client IP, per endpoint group)
    auth_rate_limit_attempts: int = 10
    auth_rate_limit_window_seconds: int = 60

    # HTTP
    cors_origins: list[str] = ["http://localhost:3000", "http://127.0.0.1:3000"]
    frontend_url: str = "http://localhost:3000"
    trusted_proxy_count: int = 0

    # File storage
    storage_backend: Literal["local", "s3"] = "local"
    storage_local_path: Path = BACKEND_DIR / "storage" / "files"
    storage_max_upload_mb: int = 25
    # Bytes of deleted files are removed after this many days (0 disables purging).
    file_purge_after_days: int = 30
    s3_bucket: str | None = None
    s3_region: str | None = None
    s3_endpoint_url: str | None = None
    s3_access_key_id: str | None = None
    s3_secret_access_key: str | None = None

    # Email
    email_provider: Literal["console", "smtp"] = "console"
    email_from: str = "RightsFlow AI <no-reply@rightsflow.local>"
    email_outbox_path: Path = BACKEND_DIR / "storage" / "dev-outbox"
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_username: str | None = None
    smtp_password: str | None = None
    smtp_use_tls: bool = True

    # AI
    ai_provider: Literal["none", "anthropic", "openai_compatible"] = "none"
    ai_model: str = "claude-opus-5-5"
    ai_api_key: str | None = None
    ai_base_url: str | None = None
    # Anthropic: sent as anthropic-workspace-id. Required when the API key is not scoped
    # to a workspace; leave unset for workspace-scoped keys.
    ai_workspace_id: str | None = None
    # openai_compatible: output-limit parameter name. "auto" uses max_completion_tokens for
    # api.openai.com (max_tokens is deprecated there and rejected by reasoning models) and
    # max_tokens for other gateways.
    ai_token_limit_param: Literal["auto", "max_tokens", "max_completion_tokens"] = "auto"
    ai_timeout_seconds: float = 60.0
    ai_max_retries: int = 2
    ai_max_output_tokens: int = 8000
    ai_effort: str = "medium"
    # Server-side refusal fallback (Claude API only).
    ai_refusal_fallback: bool = True
    # USD per million tokens, used for cost estimation only.
    ai_input_cost_per_mtok: float = 4.0
    ai_output_cost_per_mtok: float = 20.0

    # Billing
    billing_provider: Literal["manual", "stripe"] = "manual"
    stripe_secret_key: str | None = None
    stripe_webhook_secret: str | None = None

    # Background jobs
    run_embedded_worker: bool = True
    worker_poll_interval_seconds: float = 2.0
    job_stale_after_minutes: int = 15

    # Workflow automation (n8n). Automation API keys are stored as an HMAC of the
    # secret; the pepper defaults to JWT_SECRET_KEY (rotating it invalidates keys).
    automation_key_pepper: str | None = None
    automation_rate_limit_per_minute: int = 600
    automation_idempotency_retention_days: int = 7
    automation_event_retention_days: int = 30
    # Pending events older than this are expired (kept, never delivered).
    automation_pending_event_retention_days: int = 30
    # Credential expiry: "warning" and "critical" thresholds in days (N8N-04).
    automation_credential_warning_days: int = 14
    automation_credential_critical_days: int = 3
    # Incident alerting (N8N-03): repeat identical alerts at most once per window;
    # escalate to owners after this many occurrences.
    automation_alert_suppression_minutes: int = 60
    automation_alert_escalation_occurrences: int = 10
    # Statement processing retries (N8N-02).
    automation_statement_max_attempts: int = 3
    automation_statement_retry_base_minutes: int = 15
    # A bound n8n instance not seen for this long is reported as stale (N8N-07).
    automation_instance_stale_hours: int = 24

    # How automation is connected:
    # - "managed" (default, for deployments): the platform operates one n8n and
    #   RightsFlow provisions each organization's workflows, keys and schedules
    #   through n8n's public API. Organization admins only switch automations on
    #   and off in Settings > Automation; they never handle keys or scripts.
    # - "self_hosted": an operator connects a local n8n by hand with an
    #   automation key and scripts/setup-n8n-automation.ps1 (development).
    automation_mode: Literal["managed", "self_hosted"] = "managed"
    # Platform n8n (managed mode). The API key is created in n8n under
    # Settings > n8n API and never leaves the server.
    n8n_api_url: str | None = None  # e.g. http://n8n.internal:5678/api/v1
    n8n_api_key: str | None = None
    # Defaults are derived from N8N_API_URL (<base>/webhook and <base>/healthz).
    n8n_webhook_url: str | None = None
    n8n_health_url: str | None = None
    # The URL the platform n8n uses to reach this API (an internal address).
    automation_api_url: str = "http://127.0.0.1:8000"
    # Sent as X-Automation-Instance by every provisioned workflow.
    n8n_instance_id: str = "rf-platform-n8n"
    n8n_timeout_seconds: float = 15.0
    # Keys RightsFlow issues for its own n8n are replaced automatically this many
    # days before they expire.
    automation_managed_key_lifetime_days: int = 180
    automation_managed_rotate_before_days: int = 30

    # Error monitoring (e.g. a Sentry DSN). Optional integration point.
    error_monitoring_dsn: str | None = None

    @field_validator("cors_origins", mode="before")
    @classmethod
    def split_origins(cls, value: object) -> object:
        if isinstance(value, str) and not value.strip().startswith("["):
            return [item.strip() for item in value.split(",") if item.strip()]
        return value

    @model_validator(mode="after")
    def reject_weak_secrets_outside_dev(self) -> "Settings":
        """Staging/production must not boot with the example or a trivially
        guessable JWT secret: anyone knowing it can mint tokens (audit A-03)."""
        if self.app_env in ("staging", "production"):
            secret = self.jwt_secret_key
            lowered = secret.lower()
            # Rough upper bound on entropy: a 64-char hex secret (~256 bits) passes,
            # repeated patterns like "abab…" don't.
            estimated_bits = len(secret) * math.log2(len(set(secret))) if len(set(secret)) > 1 else 0
            if any(marker in lowered for marker in ("change-me", "changeme", "example", "secret-key")) or (
                estimated_bits < 128
            ):
                raise ValueError(
                    "JWT_SECRET_KEY looks like a placeholder or is too low-entropy; "
                    "generate one with `python -c \"import secrets; print(secrets.token_urlsafe(48))\"`"
                )
        return self

    @property
    def api_docs_enabled(self) -> bool:
        """Interactive docs and the OpenAPI schema are not served in production (audit A-10)."""
        return self.app_env != "production"

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"

    @property
    def ai_configured(self) -> bool:
        return self.ai_provider != "none" and bool(self.ai_api_key)

    @property
    def max_upload_bytes(self) -> int:
        return self.storage_max_upload_mb * 1024 * 1024

    @property
    def n8n_configured(self) -> bool:
        """Managed automation can provision workflows (platform n8n is set up)."""
        return bool(self.n8n_api_url and self.n8n_api_key)

    def _n8n_base_url(self) -> str:
        base = (self.n8n_api_url or "").rstrip("/")
        return base.removesuffix("/api/v1")

    @property
    def n8n_webhook_base_url(self) -> str:
        return (self.n8n_webhook_url or f"{self._n8n_base_url()}/webhook").rstrip("/")

    @property
    def n8n_health_check_url(self) -> str:
        return self.n8n_health_url or f"{self._n8n_base_url()}/healthz"


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]


settings = get_settings()
