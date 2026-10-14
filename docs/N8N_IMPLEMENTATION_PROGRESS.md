# n8n Integration: Implementation Progress

> Durable tracker for the n8n automation integration (native Windows, no Docker).
> Last updated: 2026-10-14, after the audit-driven repair.
> **Status:** every actionable audit finding is fixed. All are verified by tests; all but one
> (R-2, health recovery) are also verified live. Each finding's status and evidence:
> [N8N_DEEP_AUDIT_REPORT.md → Repair status](N8N_DEEP_AUDIT_REPORT.md#repair-status-updated-2026-10-14-after-the-audit-driven-repair).
> **Not operational yet:** the operational n8n instance is not connected to your organization and
> its business workflows are inactive (needs your key and authorization). Real SMTP and AI are
> not verified.

## Environment findings

| Check | Result |
|---|---|
| Node.js / npm | v24.21.0 / 11.19.0. Unchanged. |
| n8n before this work | None (no global package, no `~/.n8n`, no `N8N_*` environment variables) |
| n8n release | **2.43.5** (`stable` tag, engines `node >=24.0.0`). The official npm-install docs support Node 20.19–24.x. |
| Install | Local, pinned, in `%LOCALAPPDATA%\RightsFlowAI\n8n\runtime`: 2,330 packages, about 25 minutes after one network retry |
| Port 5678 | Free before install; n8n listens on **127.0.0.1:5678** only |
| Disk | D: had 8.5 GB free, so the runtime and data live on C: |

## Completed

| Area | Status | Evidence |
|---|---|---|
| Native install, start, stop, check and combined start scripts (PowerShell) | Done | Executed; see the test results |
| Process-scoped environment, generated encryption key, user-only ACL secrets folder, 14-day execution retention, file logging, telemetry off | Done | `automation/n8n/n8n.settings.env`, `scripts/n8n-common.ps1` |
| Machine-to-machine authentication: organization-scoped keys, HMAC storage, scopes, expiry, rotation with grace period, revocation, failure audit, rate limits, non-login service user | Done | 33 backend tests, plus the live isolation checks |
| Transactional outbox: events, leases, backoff, dead letter, requeue, purge | Done | Backend tests, plus live crashed-worker recovery |
| Idempotency layer, runs (observability), deduplicated deliveries, review tasks | Done | Backend tests, plus live re-runs |
| Workflow A, statement import (inbox and app events) | Done | Live: imported, held, reviewed, nothing posted, no duplicates |
| Workflow B, contract expiration (30/14/7/expired) | Done | Live: 3 sent, re-run 3 duplicates |
| Workflow C, AI metadata and rights review (pending human decision) | Done | Live: AI-unavailable path. Pytest: mocked provider |
| Workflow D, monthly report (once per month, admins only) | Done | Live: delivered once, re-run skipped |
| Workflow E, health; error handler | Done | Live: healthy; API-down report; automatic error alert |
| Frontend: Settings → Automation (keys shown once, review queue, runs, outbox) and "Request automated review" buttons | Done | Vitest 239, build, new Playwright test |
| Documentation (setup, architecture, workflows, security, test results, troubleshooting) | Done | `docs/N8N_*.md` |
| Full regression | Done | Backend 287, Vitest 239, tsc, lint, build, E2E 9 |

## Audit-driven repair (2026-10-14)

| Area | Change | Findings |
|---|---|---|
| Credential health | Expiry levels ok, warning (14 days), critical (3 days), expired and revoked; backend maintenance notices; E reports healthy, warning or critical from the API's issues and fails loudly; `check-n8n.ps1` reads the key independently of n8n | N8N-04 |
| Incidents | `automation_incidents`: fingerprint, suppression, reminders, escalation, recovery, per-organization; every failure is audited | N8N-03, R-1, R-2 |
| Statement state machine | `automation_statement_states`: transient retries with backoff, permanent failures, manual review, manager retry; restart-safe | N8N-02 |
| Mapping boundary | App uploads wait for a confirmed mapping (`statement.ready`); no invented defaults | N8N-06, N8N-10 |
| Instances | Key-to-instance binding (409 `instance_conflict`), stale detection, admin release; idempotency keys namespaced per instance | N8N-07 |
| Outbox | Events only for organizations using automation; stale events `expired` in batches, never deleted | N8N-05 |
| Inbox | XLSX; `.xls` rejected; per-file outcomes by SHA-256; one review task per rejected file | N8N-09 |
| Test and operational separation | Separate test n8n instance (port 5688); setup modes and organization guard; activation script with confirmation; config display; live test revokes its keys and archives its organizations; refuses real email and AI providers | N8N-01, N8N-16 |
| Server-mode verification | Live test checks schedules and the error workflow inside the n8n server | N8N-08, N8N-13, N8N-18 |
| Rate limits | 429 tests | N8N-12 |
| Frontend | Settings → Automation: incidents, statements needing attention (retry), inbox files, key expiry badges, instance binding with release | all |

**Repair files.** Created:
- backend: `app/services/automation/{incidents,statement_flow}.py`,
  `alembic/versions/46e2b483eada_automation_reliability_incidents_.py`,
  `tests/test_automation_reliability.py`;
- scripts: `scripts/{activate-n8n-workflows,show-n8n-config,stop-local-automation,test-n8n-smoke}.ps1`;
- frontend: `src/components/automation/{incidents-panel,statements-panel,inbox-files-panel}.tsx`
  and their tests.

Modified:
- backend: `app/models/{automation,royalty,__init__}.py`, `app/core/config.py`,
  `app/services/automation/{context,credentials,events,operations,records,maintenance}.py`,
  `app/services/{royalty_import,catalog,rights}.py`, `app/api/v1/automation{,_admin}.py`,
  `app/schemas/automation.py`, `tests/test_automation.py`;
- n8n: `automation/n8n/build_workflows.py`, `workflows/*.json` (regenerated),
  `n8n.settings.env`, `scripts/diagnostics/n8n_workflow_lint.py`;
- scripts: `scripts/{n8n-common,setup-n8n-automation,check-n8n}.ps1`, `scripts/n8n_live_test.py`;
- frontend: `src/lib/api/hooks/automation.ts`, `src/lib/api/schema.d.ts`,
  `src/components/automation/{automation-format.ts,automation-keys.tsx,automation-activity.tsx}`,
  `src/app/(app)/settings/automation/automation-client.tsx`, tests;
- docs: `docs/openapi.json`, `docs/API.md`, `docs/N8N_*.md`.

## Files created

**Backend**
- `app/models/automation.py`
- `app/services/automation/{__init__,credentials,context,idempotency,events,records,operations,maintenance}.py`
- `app/api/v1/automation.py`, `app/api/v1/automation_admin.py`, `app/schemas/automation.py`
- `alembic/versions/1195060a8593_n8n_automation_integration.py`
- `tests/test_automation.py`

**n8n**
- `automation/n8n/runtime/package.json`, `automation/n8n/n8n.settings.env`
- `automation/n8n/build_workflows.py`, `automation/n8n/workflows/*.json` (6 workflows)
- `automation/n8n/fixtures/*`, `automation/n8n/test-results/live-*.json`

**Scripts**
- `scripts/{n8n-common,install-n8n,start-n8n,stop-n8n,check-n8n,start-local-automation,setup-n8n-automation}.ps1`
- `scripts/n8n_live_test.py`

**Frontend**
- `src/lib/api/hooks/automation.ts`
- `src/components/automation/*` (keys, review queue, activity, request button, format helpers, plus tests)
- `src/app/(app)/settings/automation/*`
- `e2e/automation.spec.ts`

**Docs**
- `docs/N8N_{WINDOWS_SETUP,ARCHITECTURE,WORKFLOWS,SECURITY,TEST_RESULTS,TROUBLESHOOTING,IMPLEMENTATION_PROGRESS}.md`

## Files modified

**Backend**
- `app/models/{user,__init__}.py`: `users.is_service_account`
- `app/core/config.py`: automation settings
- `app/core/dependencies.py`, `app/services/auth_service.py`: service accounts can't use human authentication
- `app/services/notifications.py`: new types (`automation_review`, `automation_failed`, `monthly_report`); service accounts are never notified
- `app/services/royalty_import.py`, `catalog.py`, `rights.py`: outbox events in the same transaction
- `app/services/scheduled.py`, `jobs.py`: daily `automation_maintenance` job
- `tests/test_contracts.py`: expected daily job counts

**Frontend**
- `src/lib/api/query-keys.ts`, `src/components/app-shell/nav-config.ts`
- `src/components/catalog/entity-detail.tsx`
- `src/app/(app)/rights/conflicts/[id]/conflict-detail-client.tsx`
- `src/lib/api/schema.d.ts` (regenerated)

**Docs**
- `README.md`, `docs/DEVELOPMENT.md` (migration list), `docs/openapi.json`, `docs/API.md` (regenerated)

## Tests executed

See [N8N_TEST_RESULTS.md](N8N_TEST_RESULTS.md) for commands and per-check results.

- **Backend:** 287 passed (33 of them automation).
- **Live n8n:** 44 passed, 0 failed.
- **Frontend:** Vitest 239 passed; tsc and lint clean; build OK; Playwright 9 passed.

## Failures encountered and fixes

These are listed in full in [N8N_TEST_RESULTS.md](N8N_TEST_RESULTS.md#defects-found-during-verification-and-fixed):
- network failure during install
- PowerShell 5.1 BOM
- handle inheritance of detached processes
- health check on a refused connection
- error workflow must be published
- **a concurrency race when n8n sends items in parallel**, fixed with subject row locks and
  covered by tests
- party link pluralization
- a review re-run looked like a change

## Remaining limitations

See [N8N_REMAINING_WORK.md](N8N_REMAINING_WORK.md). In short:
- The operational n8n instance still holds a test organization's key from before the repair, and
  its business workflows are inactive.
- Real SMTP and AI are not verified. SMTP was configured during live run 2 and then commented out
  again; its authentication failed. The Anthropic provider is configured, but its calls returned
  errors.
- R-2 (health recovery) is verified by pytest, not yet live.
- Workflows are imported **inactive**; scheduled firing is verified in the test instance only.
- n8n's npm installation is deprecated from n8n 3.0. The rate limiter is in-process.
- Live test runs keep their archived `n8n E2E …` organizations and test users in the dev
  database. Their keys are revoked.

## Next steps (for the user)

1. In RightsFlow, go to **Settings → Automation → Create key** (as admin), then run
   `scripts\setup-n8n-automation.ps1 -Token $key` and check with `scripts\show-n8n-config.ps1`.
2. When you authorize it: `scripts\activate-n8n-workflows.ps1 -OrganizationId <id> -Confirm`.
3. Fix the SMTP credentials and check the AI settings in `backend\.env`. Decide about the 17
   queued test emails first (remaining work, item 5).
