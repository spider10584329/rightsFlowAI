# RightsFlow AI: Architecture

RightsFlow AI is built as a **modular monolith**: one FastAPI backend, one Next.js frontend, and one MariaDB database. A background worker runs jobs that the database itself queues.

```
Browser ──HTTPS──► Next.js (App Router)
                     │  • pages and React client components
                     │  • BFF route handlers (/api/auth/*, /api/backend/*)
                     │    – httpOnly session cookies, CSRF checks, token refresh
                     ▼
                  FastAPI /api/v1  ◄── Swagger at /docs
                     │  routers → services → SQLAlchemy models
                     ├──► MariaDB (tenant data, ledger, audit, job queue)
                     ├──► File storage (local disk or S3-compatible bucket, private)
                     ├──► Email provider (console outbox in dev, or SMTP)
                     ├──► AI provider (optional: Anthropic Claude, or an OpenAI-compatible gateway)
                     └──► Billing provider (manual, or Stripe when configured)
                  Worker (embedded thread, or `python -m app.worker`)
                     └── claims jobs from `background_jobs`
```

## Backend modules (`backend/app`)

| Area | Router (`api/v1`) | Services |
|---|---|---|
| Auth & sessions | `auth.py` | `auth_service.py`, `core/security.py`, `core/rate_limit.py` |
| Organizations, members, invitations | `organizations.py` | `organization_service.py` |
| Catalog (parties, works, recordings, releases, import/export) | `catalog.py`, `reference.py` | `catalog.py`, `catalog_io.py`, `identifiers.py`, `reference.py` |
| Rights ownership, split rules, split sheets, conflicts | `rights.py` | `rights.py` |
| Contracts, documents, AI analysis | `contracts.py`, `files.py` | `contracts.py`, `document_text.py`, `scheduled.py`, `storage.py` |
| Royalty statements and calculation | `royalties.py` | `statement_parsing.py`, `royalty_import.py`, `royalty_engine.py`, `royalty_runs.py`, `reports.py` |
| Payees, ledger, payouts | `payees.py`, `payouts.py` | `ledger.py`, `payouts.py` |
| AI intelligence | `ai.py` | `ai/provider.py`, `ai/runner.py`, `ai/features.py` |
| Billing & entitlements | `billing.py`, `billing_webhooks.py` | `billing.py` |
| Notifications, email log | `notifications.py` | `notifications.py`, `email.py` |
| Background jobs | `jobs.py` | `jobs.py`, `worker.py` |
| Dashboard & analytics | `dashboard.py` | `analytics.py` |

Routers are discovered automatically: every module in `app/api/v1` that exposes `router` or `*_router` is mounted under `/api/v1`.

## Cross-cutting concerns

- **Configuration.** `core/config.py` uses pydantic-settings, reading environment variables or `backend/.env`. Secrets never leave the server.
- **Errors.** `core/errors.py` returns a uniform envelope, `{error:{code,message,details}, detail, request_id}`.
- **Request context.** A request id (`X-Request-ID`) is attached to every request, along with structured access logs and security headers. Logs are JSON when `LOG_JSON=true`.
- **Multi-tenancy.** Every tenant row carries an `organization_id`. The `require_org_role` dependencies resolve the caller's membership and role. Non-members receive 404, and every query is scoped to the organization. See `docs/BACKEND_CONVENTIONS.md`.
- **Authorization.** The role hierarchy is owner > admin > manager > viewer. The backend enforces it on every route; the frontend only mirrors it to tailor the UI.
- **Audit.** `audit_logs` is append-only. It records security and business events in the same transaction as the change.
- **Money.** Amounts are `DECIMAL(20,8)` and percentages `DECIMAL(9,6)`. Python uses `Decimal` everywhere, and JSON carries amounts as strings. The ledger is immutable (corrections are reversals). See `docs/ROYALTY_ENGINE.md`.
- **Time.** Timestamps are naive `DATETIME` values that always represent UTC.

## Authentication

- **Access tokens.** Short-lived JWTs (HS256, 30 minutes) carrying `sub`, `sid` (the session family) and `iss`. They are rejected after logout (the family is revoked) or a password change.
- **Refresh tokens.** Opaque 64-byte random values; only their SHA-256 hash is stored. They rotate on every use. Reusing a rotated token revokes the whole session family, which detects theft.
- **One-time tokens.** Password reset and email verification use single-use, expiring tokens, stored as hashes.
- **Invitations.** Tokens are hashed and expiring. The invitation is bound to its email address and counts toward the plan's user limit.
- **Rate limiting.** A per-IP and per-account sliding window protects login, register, refresh, reset and verification. It runs in-process; use Redis when you run several replicas.
- **Browser sessions.** The Next.js BFF keeps tokens in `httpOnly` cookies with `SameSite=Lax` (and `Secure` in production). Mutations need a double-submit CSRF token plus an Origin check. Browser JavaScript never sees a token.

## Background jobs

`background_jobs` is a durable queue. Workers claim jobs with a conditional `UPDATE … WHERE status='queued'`, which is safe across several workers on MariaDB 10.4 without `SKIP LOCKED`. Jobs track progress, attempts, exponential backoff, permanent failures, failure hooks and idempotency keys. Stale running jobs are recovered.

| Job type | Purpose |
|---|---|
| `royalty_import` | Parse, validate and match a statement |
| `catalog_import` | Bulk catalog CSV/XLSX import |
| `contract_analysis` | AI contract extraction (advisory) |
| `report_generation` | CSV report exports |
| `contract_expiry_check` | Daily per organization: expiry warnings and status updates |

## AI

`services/ai` is the provider abstraction. It defaults to Claude (`claude-opus-5-5`) through the official Anthropic SDK, using structured JSON outputs, server-side refusal fallback, timeouts and retries.

- **Not configured.** Every AI endpoint returns `503 ai_not_configured`; outputs are never fabricated.
- **Every call:** checks plan entitlements and monthly limits, wraps untrusted content in `<untrusted_data>` fences (prompt-injection defense), validates output with Pydantic, and records tokens and estimated cost in `ai_usage_records`.
- **Proposed changes** become `ai_suggestions` and take effect only after a human approves them.

## Data model overview

| Group | Tables |
|---|---|
| Identity | `users`, `refresh_tokens`, `user_action_tokens` |
| Tenancy | `organizations`, `organization_memberships`, `organization_invitations` |
| Catalog | `parties`, `works`, `recordings`, `recording_works`, `work_contributors`, `recording_contributors`, `releases`, `release_tracks` |
| Rights | `ownership_shares`, `split_rules`, `split_sheets`, `rights_conflicts` |
| Contracts | `contracts`, `contract_parties`, `contract_royalty_terms`, `contract_assets`, `contract_documents`, `contract_analyses` |
| Royalties | `royalty_statements`, `statement_lines`, `royalty_runs`, `royalty_allocations` |
| Money | `payees`, `ledger_entries`, `payout_batches`, `payouts` |
| Platform | `audit_logs`, `notifications`, `email_messages`, `stored_files`, `background_jobs` |
| SaaS | `plans`, `subscriptions`, `ai_usage_records`, `ai_suggestions` |

The full schema is in `backend/app/models/`, and the migrations are in `backend/alembic/versions/`.
