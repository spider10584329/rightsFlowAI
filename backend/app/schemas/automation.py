from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


# --------------------------------------------------------------------------- admin (JWT)


class CredentialCreate(_Strict):
    name: str = Field(min_length=2, max_length=100)
    scopes: list[str] | None = Field(default=None, max_length=20)
    expires_in_days: int | None = Field(default=None, ge=1, le=365)


class CredentialRotate(_Strict):
    grace_hours: int = Field(default=24, ge=0, le=168)


class CredentialRevoke(_Strict):
    reason: str | None = Field(default=None, max_length=200)


class CredentialResponse(BaseModel):
    id: str
    name: str
    key_id: str
    key_hint: str
    scopes: list[str]
    state: Literal["active", "expired", "revoked"]
    expires_at: datetime | None
    revoked_at: datetime | None
    revoked_reason: str | None
    rotated_from_id: str | None
    last_used_at: datetime | None
    created_by_id: str | None
    created_at: datetime
    expiry_level: Literal["ok", "warning", "critical", "expired", "revoked"]
    bound_instance: str | None
    instance_bound_at: datetime | None
    instance_last_seen_at: datetime | None
    instance_stale: bool


class IssuedCredentialResponse(BaseModel):
    credential: CredentialResponse
    token: str = Field(description="The full API key. Shown only once; store it in n8n now.")


class ReviewTaskClose(_Strict):
    note: str | None = Field(default=None, max_length=2000)


class ReviewRequestCreate(_Strict):
    subject_type: Literal["work", "recording", "party", "rights_conflict"]
    subject_id: str = Field(min_length=1, max_length=36)


# --------------------------------------------------------------------------- automation (API key)


class RunStart(_Strict):
    workflow: str = Field(min_length=3, max_length=100)
    trigger_type: Literal["manual", "schedule", "event", "file", "error_handler"]
    execution_id: str | None = Field(default=None, max_length=100)
    idempotency_key: str | None = Field(default=None, max_length=191,
                                        description="Business key, e.g. 'monthly:2026-09'. A run that "
                                                    "already succeeded with this key is returned instead "
                                                    "of starting a new one.")
    event_id: str | None = Field(default=None, max_length=36)


class RunFinish(_Strict):
    status: Literal["succeeded", "failed", "partial", "skipped"]
    summary: dict[str, Any] | None = None
    error_code: str | None = Field(default=None, max_length=80)
    error_message: str | None = Field(default=None, max_length=2000)


class EventClaim(_Strict):
    event_types: list[str] = Field(min_length=1, max_length=10)
    limit: int = Field(default=10, ge=1, le=25)
    lease_seconds: int = Field(default=300, ge=30, le=900)


class EventAck(_Strict):
    lease_token: str = Field(min_length=8, max_length=64)
    outcome: Literal["completed", "retry", "failed"]
    error: str | None = Field(default=None, max_length=2000)


class _EventAck(_Strict):
    """Optional: acknowledge the outbox event that triggered this call once it succeeds."""
    event_id: str | None = Field(default=None, max_length=36)
    lease_token: str | None = Field(default=None, max_length=64)


class StatementReviewRequest(_EventAck):
    calculate: bool = Field(default=True, description="Calculate a draft (unposted) run so held amounts "
                                                      "are visible. Never posts.")
    run_id: str | None = Field(default=None, max_length=36)


class ContractReminderRequest(_Strict):
    threshold_days: int = Field(ge=0, le=365, description="0 = the contract has expired")
    run_id: str | None = Field(default=None, max_length=36)


class MonthlyReportRequest(_Strict):
    period: str | None = Field(default=None, pattern=r"^\d{4}-(0[1-9]|1[0-2])$",
                               description="YYYY-MM; defaults to the previous month")
    report_type: str = Field(default="revenue_by_source", max_length=40)
    run_id: str | None = Field(default=None, max_length=36)


class ReportSendRequest(_Strict):
    recipient_user_id: str | None = Field(default=None, max_length=36,
                                          description="Defaults to every admin and owner")


class MetadataReviewRequest(_Strict):
    entity_type: Literal["work", "recording", "party"]
    entity_id: str = Field(min_length=1, max_length=36)
    run_id: str | None = Field(default=None, max_length=36)


class ConflictReviewRequest(_Strict):
    conflict_id: str = Field(min_length=1, max_length=36)
    run_id: str | None = Field(default=None, max_length=36)


class AIReviewRequest(_EventAck):
    subject_type: Literal["work", "recording", "party", "rights_conflict"]
    subject_id: str = Field(min_length=1, max_length=36)
    run_id: str | None = Field(default=None, max_length=36)


class AlertRequest(_Strict):
    workflow: str = Field(min_length=3, max_length=100)
    execution_id: str | None = Field(default=None, max_length=100)
    resource: str | None = Field(default=None, max_length=120,
                                 description="What failed, e.g. the n8n node name; part of the incident key")
    run_id: str | None = Field(default=None, max_length=36)
    error_code: str | None = Field(default=None, max_length=80)
    error_message: str | None = Field(default=None, max_length=2000)
