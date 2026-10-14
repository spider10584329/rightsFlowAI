# Implementation Progress

> This file tracks progress so that work survives context compaction and future sessions. Update it whenever a task changes state.
> Last updated: 2026-10-14, session 3 (pre-launch audit). See `docs/FINAL_AUDIT_REPORT.md` for every finding, fix, test result, remaining risk and launch blocker.

## Completed features

| Area | Status | Evidence |
|---|---|---|
| **Auth:** register, login, refresh rotation and reuse detection, logout, password reset, email verification, sessions, rate limiting, notification email preferences | Done | `test_auth.py`, `test_platform_jobs.py`, E2E |
| **Organizations:** CRUD, settings, invitations (with re-send), roles, deactivation, ownership transfer, activity | Done | `test_organizations.py`, `test_platform_jobs.py`, E2E |
| **Catalog:** CRUD, bulk actions, validation, duplicate detection, **merge**, completeness, import and export, **external identifiers** | Done | `test_catalog*.py`, `test_session2_domain.py`, E2E |
| **Rights:** shares, split rules (a rule change queues a re-scan), split sheets, conflicts, history | Done | `test_rights.py`, `test_session2_domain.py` |
| **Contracts:** CRUD, documents, clause scan, AI analysis and review, expiry job | Done | `test_contracts.py`, `test_files.py` |
| **Royalties:** import adapters, matching, manual statements, **statement edit and cancel**, Decimal engine, runs, post and reverse, reports | Done | `test_royalty_engine.py`, `test_royalties.py`, `test_session2_domain.py`, E2E |
| **Payees and payouts:** ledger, advances, adjustments, payout batches and approval | Done | `test_royalties.py` |
| **AI:** provider abstraction, 16 endpoints, usage tracking and limits, prompt fencing; report figures are returned without AI | Done (fake provider only) | `test_ai.py` |
| **Billing:** plans, notifications, jobs, dashboard, Stripe webhook | Done | `test_billing*.py`, `test_notifications.py`, `test_jobs.py`, `test_dashboard.py` |
| **Platform:** email delivery job with retries, deleted-file purge job, error-monitoring hook | Done | `test_platform_jobs.py` |
| **Security:** route-level sweep across all 185 tenant routes (96 mutating) | Done | `test_security_sweep.py` |
| **Frontend:** 59 pages, BFF, design system, plus session-2 UI (preferences, re-send, statement edit and cancel, merge, external IDs) | Done | tsc, lint, 203 Vitest tests, build, 8 Playwright tests |

## Gap audit (session 2): all closed

| # | Gap | Resolution |
|---|---|---|
| G1 | Synchronous, unretried email | `email_delivery` background job: real providers queue the email; up to 5 attempts with backoff, then `failed`. The console provider stays synchronous for development previews. |
| G2 | No notification email preferences | `users.notification_preferences` plus `GET/PUT /auth/me/notification-preferences`. Important types are emailed by default. The profile page has toggles. |
| G3 | Deleted file bytes were never purged | `deleted_at` is stamped automatically. A daily `storage_purge` platform job removes the bytes after `FILE_PURGE_AFTER_DAYS` (30). |
| G4 | No error monitoring | `core/monitoring.py` initializes Sentry when `ERROR_MONITORING_DSN` is set (no-op otherwise), hooked into 500 errors and job failures. |
| G5 | Invitations couldn't be re-sent | `POST …/invitations/{id}/resend` rotates the token, so the old link stops working. Exposed as an action on the Team page. |
| G6 | Statements couldn't be edited or cancelled | `PATCH /royalties/statements/{id}` (locked after posting; currency locked once lines exist; stale runs discarded) and `POST …/cancel` (queued only). Exposed through a statement detail dialog and button. |
| G7 | Split-rule changes didn't re-scan | Rule create, update or delete queues a `rights_conflict_scan` job (deduplicated); managers are notified of new serious conflicts. |
| G8 | Duplicates couldn't be merged | `POST /catalog/merge` (admin, explicit confirmation): operational references move to the kept record, posted financial history is untouched, and the duplicate is archived. Two parties that both have payees are refused. The merge dialog is in the catalog overview. |
| G9 | External IDs couldn't be edited | Key/value editor on the work, recording, release and party forms, with validation that mirrors the backend. |
| G10 | Frontend for the above | Done. Covered by `e2e/gap-features.spec.ts`. |

## Defects found and fixed in session 2

- **Invite dialog:** it showed "Email delivery failed" for any status except `logged`, which would mislabel successful SMTP sends (`queued`/`sent`). Fixed.
- **Line endings:** 71 frontend source files had CRLF endings while the rest of the codebase is LF. Normalized to LF.
- **Scheduler tests:** three contracts tests expected the scheduler to create only organization jobs; their expectations are updated for the new daily platform purge job.

## Pre-launch audit (session 3)

- 13 high, 26 medium and 32 low findings across security, the database, royalties, AI/uploads and the frontend. None were critical. All are fixed except two accepted risks (A-05b, D-15).
- New migration `cbc38defc8d1` (RESTRICT FKs on financial history, unique keys, indexes, `content_sha256`, `ledger_entries.created_at` DATETIME(6)). Applied to the dev DB after backup `backend/storage/backups/rightsflow_ai_pre_cbc38defc8d1.sql`.
- API changes:
  - `POST /organizations/{id}/members` was removed; members join through invitations only.
  - Report responses now include `row_count` and `truncated`.
  - Statement upload and manual statements accept `allow_duplicate`.
- Launch readiness: ready for staging or a closed beta, not for public production. The blockers are listed in the report.

## Partially implemented (needs credentials or infrastructure)

- **AI generation** has only been verified with a fake provider. Set `AI_PROVIDER=anthropic` and `AI_API_KEY`.
- **SMTP, S3 and Stripe** have code and tests with fakes, but have never run against real services.
- **Rate limiting and BFF refresh:** the rate limiter and the BFF single-flight refresh run in-process. Multiple replicas need Redis or sticky sessions.

## Known defects

- None open.

## Verification status (final pass, session 3)

| Check | Result |
|---|---|
| Backend pytest (21 files) | **254 passed** |
| Frontend `tsc`, ESLint | 0 errors, 0 problems |
| Vitest | **221 passed** (34 files) |
| `next build` | Success |
| Playwright E2E | **8 passed** |
| `alembic check` (dev DB) | No drift; head `cbc38defc8d1` |
| `npm audit --omit=dev` / `pip-audit` | 0 runtime vulnerabilities (only the installer `pip` itself is affected) |

## Verification status (session 2, superseded)

| Check | Result |
|---|---|
| Backend pytest (19 files) | **210 passed** |
| Security sweep: 401 for anonymous users, no 2xx/500 for outsiders, viewers can't mutate (185 routes) | Included above; passes |
| Frontend `tsc --noEmit` | 0 errors |
| ESLint | 0 problems |
| Vitest | **203 passed** (27 files) |
| `next build` | Success, 68 pages |
| Playwright E2E | **8 passed** |
| `alembic check` (dev DB) | No drift; single head `010ae74ee6d8` |
| Migration chain on a scratch DB | Full up/down/up cycle passes |

## Migrations

- `ff292c7fb808`: SaaS domain schema (session 1).
- `010ae74ee6d8`: notification preferences, file purge columns, and a nullable `background_jobs.organization_id`. Additive. Applied to the dev DB after a backup.
- `cbc38defc8d1`: audit hardening (RESTRICT FKs, unique keys, indexes, `content_sha256`, DATETIME(6) ledger timestamps). Rehearsed up/down/up on a scratch DB, then applied to the dev DB after a backup.

## Next tasks (optional, beyond the spec)

1. Run the AI features against a real Anthropic key and tune the prompts with an eval set.
2. Integration-test SMTP, S3 and Stripe once credentials exist.
3. Move the rate limiter and BFF refresh coordination to Redis for multi-replica deployments.
4. Bulk merge for large duplicate sets, plus an undo window for merges.
