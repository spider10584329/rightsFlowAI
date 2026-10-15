"""Workflow-automation tables (n8n integration).

- ``integration_credentials``: organization-scoped machine credentials. Only an
  HMAC of the secret is stored; each credential acts as a dedicated, non-login
  service user.
- ``automation_events``: transactional outbox. Rows are written in the same
  transaction as the business change and pulled by n8n with a lease.
- ``automation_runs``: one row per workflow execution, for observability.
- ``automation_idempotency_keys``: stored responses for replayed requests.
- ``automation_deliveries``: notification/report deliveries, deduplicated by key.
- ``automation_review_tasks``: items an automation raised for human review.
- ``automation_connections`` / ``organization_automations`` (managed mode): the
  organization's link to the platform-operated n8n, and which automations are
  switched on with what settings, plus what was provisioned for them in n8n.

Nothing here holds money: payloads carry ids and counts, never amounts that
would duplicate the ledger.
"""

from datetime import datetime
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.mixins import CreatedByMixin, TenantMixin, TimestampMixin, UUIDPrimaryKeyMixin, utc_now


class IntegrationCredential(UUIDPrimaryKeyMixin, TenantMixin, CreatedByMixin, TimestampMixin, Base):
    __tablename__ = "integration_credentials"
    __table_args__ = (
        UniqueConstraint("key_id", name="uq_integration_credential_key"),
        Index("ix_integration_credentials_org_active", "organization_id", "revoked_at"),
    )

    name: Mapped[str] = mapped_column(String(100), nullable=False)
    # Public identifier embedded in the token (rfa_<key_id>_<secret>).
    key_id: Mapped[str] = mapped_column(String(32), nullable=False)
    # HMAC-SHA256 of the secret part; the secret itself is shown once and never stored.
    secret_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    scopes: Mapped[list[str]] = mapped_column(JSON, nullable=False)
    service_user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="RESTRICT", name="fk_integration_credential_user"),
        nullable=False,
    )
    expires_at: Mapped[datetime | None] = mapped_column(DateTime)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime)
    revoked_reason: Mapped[str | None] = mapped_column(String(200))
    rotated_from_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("integration_credentials.id", ondelete="SET NULL",
                               name="fk_integration_credential_rotated_from")
    )
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime)
    last_used_ip: Mapped[str | None] = mapped_column(String(64))
    # The n8n instance currently using this key (X-Automation-Instance). A second
    # instance is refused until an admin releases the binding (N8N-07).
    bound_instance_id: Mapped[str | None] = mapped_column(String(64))
    instance_bound_at: Mapped[datetime | None] = mapped_column(DateTime)
    instance_last_seen_at: Mapped[datetime | None] = mapped_column(DateTime)
    # Issued by RightsFlow for the platform n8n (managed mode): never shown to
    # anyone, rotated and revoked automatically.
    managed: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0", nullable=False)


class AutomationEvent(UUIDPrimaryKeyMixin, TenantMixin, Base):
    __tablename__ = "automation_events"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'claimed', 'completed', 'failed', 'dead', 'expired')",
            name="ck_automation_event_status",
        ),
        UniqueConstraint("organization_id", "dedupe_key", name="uq_automation_event_dedupe"),
        Index("ix_automation_events_poll", "organization_id", "status", "available_at"),
    )

    event_type: Mapped[str] = mapped_column(String(60), nullable=False)
    # Ids and non-confidential context only.
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    dedupe_key: Mapped[str] = mapped_column(String(191), nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="pending", nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    max_attempts: Mapped[int] = mapped_column(Integer, default=5, nullable=False)
    available_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    lease_token: Mapped[str | None] = mapped_column(String(64))
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime)
    claimed_by_credential_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("integration_credentials.id", ondelete="SET NULL",
                               name="fk_automation_event_credential")
    )
    last_error: Mapped[str | None] = mapped_column(String(500))
    correlation_id: Mapped[str | None] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime)


class AutomationRun(UUIDPrimaryKeyMixin, TenantMixin, Base):
    __tablename__ = "automation_runs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('running', 'succeeded', 'failed', 'partial', 'skipped')",
            name="ck_automation_run_status",
        ),
        CheckConstraint(
            "trigger_type IN ('manual', 'schedule', 'event', 'file', 'error_handler')",
            name="ck_automation_run_trigger",
        ),
        UniqueConstraint("organization_id", "workflow", "idempotency_key", name="uq_automation_run_idempotency"),
        Index("ix_automation_runs_org_started", "organization_id", "started_at"),
    )

    credential_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("integration_credentials.id", ondelete="SET NULL",
                               name="fk_automation_run_credential")
    )
    workflow: Mapped[str] = mapped_column(String(100), nullable=False)
    execution_id: Mapped[str | None] = mapped_column(String(100))
    trigger_type: Mapped[str] = mapped_column(String(20), nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="running", nullable=False)
    idempotency_key: Mapped[str | None] = mapped_column(String(191))
    correlation_id: Mapped[str | None] = mapped_column(String(100))
    event_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("automation_events.id", ondelete="SET NULL", name="fk_automation_run_event")
    )
    retry_count: Mapped[int] = mapped_column(SmallInteger, default=0, nullable=False)
    # Counts and ids only (no amounts, names or document text).
    summary: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    error_code: Mapped[str | None] = mapped_column(String(80))
    error_message: Mapped[str | None] = mapped_column(String(500))
    started_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime)


class AutomationIdempotencyKey(UUIDPrimaryKeyMixin, TenantMixin, Base):
    __tablename__ = "automation_idempotency_keys"
    __table_args__ = (
        UniqueConstraint("organization_id", "idempotency_key", name="uq_automation_idempotency_key"),
        Index("ix_automation_idempotency_created", "created_at"),
    )

    idempotency_key: Mapped[str] = mapped_column(String(128), nullable=False)
    credential_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("integration_credentials.id", ondelete="SET NULL",
                               name="fk_automation_idempotency_credential")
    )
    method: Mapped[str] = mapped_column(String(10), nullable=False)
    path: Mapped[str] = mapped_column(String(255), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    # NULL while the first request is still being processed.
    status_code: Mapped[int | None] = mapped_column(SmallInteger)
    response_body: Mapped[Any | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)


class AutomationDelivery(UUIDPrimaryKeyMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "automation_deliveries"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'sent', 'skipped', 'failed')",
            name="ck_automation_delivery_status",
        ),
        UniqueConstraint("organization_id", "dedupe_key", name="uq_automation_delivery_dedupe"),
    )

    kind: Mapped[str] = mapped_column(String(40), nullable=False)
    dedupe_key: Mapped[str] = mapped_column(String(191), nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="pending", nullable=False)
    subject_type: Mapped[str | None] = mapped_column(String(40))
    subject_id: Mapped[str | None] = mapped_column(String(36))
    job_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("background_jobs.id", ondelete="SET NULL", name="fk_automation_delivery_job")
    )
    recipient_user_ids: Mapped[list[str] | None] = mapped_column(JSON)
    detail: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    run_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("automation_runs.id", ondelete="SET NULL", name="fk_automation_delivery_run")
    )
    sent_at: Mapped[datetime | None] = mapped_column(DateTime)


class AutomationReviewTask(UUIDPrimaryKeyMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "automation_review_tasks"
    __table_args__ = (
        CheckConstraint(
            "status IN ('open', 'resolved', 'dismissed')",
            name="ck_automation_review_task_status",
        ),
        UniqueConstraint("organization_id", "dedupe_key", name="uq_automation_review_task_dedupe"),
        Index("ix_automation_review_tasks_org_status", "organization_id", "status"),
    )

    kind: Mapped[str] = mapped_column(String(40), nullable=False)
    dedupe_key: Mapped[str] = mapped_column(String(191), nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="open", nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    subject_type: Mapped[str | None] = mapped_column(String(40))
    subject_id: Mapped[str | None] = mapped_column(String(36))
    link: Mapped[str | None] = mapped_column(String(255))
    details: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    ai_suggestion_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("ai_suggestions.id", ondelete="SET NULL", name="fk_review_task_suggestion")
    )
    run_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("automation_runs.id", ondelete="SET NULL", name="fk_review_task_run")
    )
    resolved_by_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL", name="fk_review_task_resolved_by")
    )
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime)
    resolution_note: Mapped[str | None] = mapped_column(Text)


class AutomationIncident(UUIDPrimaryKeyMixin, TenantMixin, Base):
    """A recurring automation failure, grouped by (workflow, category, resource).

    Every failure is still logged per execution (audit log + run); the incident
    decides who is told and when: first alert, suppression window, escalation and
    recovery notice (N8N-03)."""

    __tablename__ = "automation_incidents"
    __table_args__ = (
        CheckConstraint("status IN ('open', 'resolved')", name="ck_automation_incident_status"),
        Index("ix_automation_incidents_lookup", "organization_id", "fingerprint", "status"),
    )

    fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    workflow: Mapped[str] = mapped_column(String(100), nullable=False)
    category: Mapped[str] = mapped_column(String(40), nullable=False)
    resource: Mapped[str | None] = mapped_column(String(120))
    status: Mapped[str] = mapped_column(String(20), default="open", nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    last_error: Mapped[str | None] = mapped_column(String(500))
    last_execution_id: Mapped[str | None] = mapped_column(String(100))
    occurrences: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    alerts_sent: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    suppressed: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    escalated_at: Mapped[datetime | None] = mapped_column(DateTime)
    first_seen_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    last_alerted_at: Mapped[datetime | None] = mapped_column(DateTime)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime)
    resolution: Mapped[str | None] = mapped_column(String(255))


class AutomationStatementState(UUIDPrimaryKeyMixin, TenantMixin, TimestampMixin, Base):
    """Automation's processing state for one statement (N8N-02).

    pending -> processing -> completed, or on failure retry_waiting (bounded,
    exponential backoff) -> ... -> needs_manual_review. Persisted, so restarts
    resume where they left off; a person can reset it (manual retry)."""

    __tablename__ = "automation_statement_states"
    __table_args__ = (
        CheckConstraint(
            "state IN ('pending', 'processing', 'completed', 'retry_waiting', 'failed', "
            "'needs_manual_review', 'awaiting_mapping')",
            name="ck_automation_statement_state",
        ),
        UniqueConstraint("organization_id", "statement_id", name="uq_automation_statement_state"),
        Index("ix_automation_statement_states_due", "organization_id", "state", "next_attempt_at"),
    )

    statement_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("royalty_statements.id", ondelete="CASCADE", name="fk_auto_state_statement"),
        nullable=False,
    )
    source: Mapped[str] = mapped_column(String(20), nullable=False)  # inbox | app
    state: Mapped[str] = mapped_column(String(30), default="pending", nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    max_attempts: Mapped[int] = mapped_column(Integer, default=3, nullable=False)
    next_attempt_at: Mapped[datetime | None] = mapped_column(DateTime)
    error_category: Mapped[str | None] = mapped_column(String(40))
    last_error: Mapped[str | None] = mapped_column(String(500))


class AutomationInboxFile(UUIDPrimaryKeyMixin, TenantMixin, Base):
    """Outcome of each distinct file (by SHA-256) seen in the n8n inbox, so a
    rejected file gets one explicit failure record and review task instead of
    silent repeats (N8N-09)."""

    __tablename__ = "automation_inbox_files"
    __table_args__ = (
        CheckConstraint("state IN ('imported', 'duplicate', 'rejected')", name="ck_automation_inbox_file_state"),
        UniqueConstraint("organization_id", "sha256", name="uq_automation_inbox_file"),
    )

    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    file_name: Mapped[str] = mapped_column(String(255), nullable=False)
    state: Mapped[str] = mapped_column(String(20), nullable=False)
    statement_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("royalty_statements.id", ondelete="SET NULL", name="fk_inbox_file_statement")
    )
    error_code: Mapped[str | None] = mapped_column(String(80))
    error_message: Mapped[str | None] = mapped_column(String(500))
    times_seen: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    first_seen_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)


class AutomationConnection(UUIDPrimaryKeyMixin, TenantMixin, TimestampMixin, Base):
    """Managed mode: the organization's connection to the platform n8n.

    Holds the ids of what RightsFlow created in n8n for the organization (the
    credential carrying its automation key and the credential that authenticates
    webhook triggers) and a lease that serializes reconciliation runs."""

    __tablename__ = "automation_connections"
    __table_args__ = (
        CheckConstraint("status IN ('disabled', 'provisioning', 'active', 'error')",
                        name="ck_automation_connection_status"),
        UniqueConstraint("organization_id", name="uq_automation_connection_org"),
    )

    status: Mapped[str] = mapped_column(String(20), default="disabled", nullable=False)
    credential_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("integration_credentials.id", ondelete="SET NULL",
                               name="fk_automation_connection_credential")
    )
    n8n_credential_id: Mapped[str | None] = mapped_column(String(64))
    n8n_trigger_credential_id: Mapped[str | None] = mapped_column(String(64))
    # Fingerprint of the webhook trigger secret stored in n8n (the secret itself
    # is derived from the server's key and never stored).
    trigger_fingerprint: Mapped[str | None] = mapped_column(String(64))
    last_error: Mapped[str | None] = mapped_column(String(500))
    last_reconciled_at: Mapped[datetime | None] = mapped_column(DateTime)
    lease_token: Mapped[str | None] = mapped_column(String(64))
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime)


class OrganizationAutomation(UUIDPrimaryKeyMixin, TenantMixin, TimestampMixin, Base):
    """Managed mode: one automation (see app/services/automation/catalog.py) for
    one organization: whether it is on, its settings, and the n8n workflow
    provisioned for it."""

    __tablename__ = "organization_automations"
    __table_args__ = (
        CheckConstraint("status IN ('disabled', 'pending', 'active', 'error')",
                        name="ck_organization_automation_status"),
        UniqueConstraint("organization_id", "automation", name="uq_organization_automation"),
    )

    automation: Mapped[str] = mapped_column(String(40), nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    settings: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(20), default="disabled", nullable=False)
    n8n_workflow_id: Mapped[str | None] = mapped_column(String(64))
    template_version: Mapped[int | None] = mapped_column(Integer)
    # Hash of the workflow last sent to n8n; a different hash means "update it".
    config_hash: Mapped[str | None] = mapped_column(String(64))
    last_error: Mapped[str | None] = mapped_column(String(500))
    provisioned_at: Mapped[datetime | None] = mapped_column(DateTime)
    last_triggered_at: Mapped[datetime | None] = mapped_column(DateTime)
    updated_by_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL", name="fk_organization_automation_updated_by")
    )
