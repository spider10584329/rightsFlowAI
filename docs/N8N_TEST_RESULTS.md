# n8n Integration: Test Results

**Date:** 2026-10-14

**Environment:** Windows 10 Pro 22H2, Node.js 24.21.0, npm 11.19.0, n8n **2.43.5** (native npm install,
no Docker), Python 3.13, MariaDB 10.4 (XAMPP), FastAPI on 127.0.0.1:8000, Next.js 16 dev server on :3000.

Every result below comes from a command that was actually run. Each result is labelled with how
it was verified:

- **Real local:** real local services (n8n, FastAPI, MariaDB) with no mocks.
- **Mocked:** a mocked external service, labelled as such.
- **Not verified:** missing credentials or infrastructure.

## Audit-driven repair (latest, 2026-10-14)

| Suite | Command | Result |
|---|---|---|
| Backend: full regression | `backend\.venv\Scripts\python.exe -m pytest -q` | **308 passed**, 0 failed (exit 0) |
| Backend: automation | `... -m pytest tests/test_automation.py tests/test_automation_reliability.py` | **54 passed** (34 + 20) |
| Workflow lint | `scripts\diagnostics\n8n_workflow_lint.py` | 26 authenticated API calls validated; 0 errors, 0 warnings |
| Frontend typecheck | `npx tsc --noEmit` | exit 0 |
| Frontend lint | `npm run lint` | 0 problems |
| Frontend unit tests | `npx vitest run` | **260 passed** (39 files) |
| Frontend build | `npm run build` | Success (`/settings/automation`); the running dev server still answered HTTP 200 |
| Playwright E2E | not run | Not run in this repair: `backend\.env` was switched to real SMTP and Anthropic while the work was in progress, and the E2E suite registers users and can trigger AI calls against the running API on port 8000 |
| Migration `46e2b483eada` | rehearsal on `rightsflow_migcheck_test` (up, down, up, check), then dev DB after backup | Applied; row counts unchanged; backup `backend/storage/backups/rightsflow_ai_pre_46e2b483eada.sql` |
| Live n8n, run 1 | `scripts\n8n_live_test.py` (test instance, port 5688) | **54 passed, 2 failed**: `live-20261014T200034Z.json`. Both failures were the health incident (suppression and recovery); fixed afterwards (R-2). |
| Live n8n, run 2 | same | **53 passed, 3 failed**: `live-20261014T201808Z.json`. E recovery (R-2, fixed afterwards and verified by pytest). C and D failed after `backend\.env` was switched to SMTP and Anthropic **during** the run: AI calls returned errors, and D's first execution exhausted its `report_not_ready` retries (the re-run completed the delivery once). |
| Secret scan | `grep` for `rfa_…` tokens, `Bearer rfa_`, encryption keys in `automation`, `docs`, `scripts`, `frontend/src`, `backend/app` | None found |

**Live checks that passed in both runs** (real n8n 2.43.5 in the separate test instance, real
FastAPI and MariaDB):
- tenant isolation with real keys;
- test-mode setup with a recorded connection that holds no secret;
- key bound to the test instance; a second instance id refused with 409 `instance_conflict`;
- A: CSV and XLSX imported (XLSX amounts exact); bad name, garbage and `.xls` rejected with
  reasons; every file has a stored outcome;
- A: the app upload waits for mapping confirmation, then `statement.ready` processes it;
- A: re-runs create no statements and raise no new rejection tasks; holds instead of payments;
  nothing posted; ledger untouched;
- A: transient failure → `retry_waiting` → due retry → `completed`, same statement;
- B: reminders sent; re-run sends no duplicates; organization B with nothing due completes with
  0 contracts;
- E: healthy; key at 10 days → warning, one incident and one alert, repeat suppressed (run 2);
  API down → CRITICAL, non-zero exit;
- crashed worker: expired lease re-claimed and completed;
- **server mode:** schedule fired (`trigger/success`); error workflow ran (`error/success` ≥2);
  one incident, one alert, repeats suppressed;
- the organization-switch guard refuses without `-AllowOrganizationChange`;
- **operational n8n instance untouched** (credential, key file, active workflows, connection
  compared by hash);
- test keys revoked at the end.

**Not re-verified live after the last fix:** R-2 (health recovery). The live test now refuses to
run while `backend\.env` configures real email or AI providers. See
[N8N_REMAINING_WORK.md](N8N_REMAINING_WORK.md) item 3.

**Email during run 2:** after SMTP was configured mid-run, 19 notifications to the test users
(`n8n-e2e-…@example.com`) went to the SMTP provider. 2 failed and 17 are queued for retry, all
with SMTP authentication failures (535). **No email was delivered.**

## Original implementation results (superseded where noted)

The rows below are from the first implementation. The deep audit found that the error-workflow
check in the original live run relied on CLI mode, where it is unreliable (N8N-08). The server-mode
checks above replace it.

### Summary

| Suite | Command | Result |
|---|---|---|
| Backend: full regression | `backend\.venv\Scripts\python.exe -m pytest tests` | **287 passed**, 0 failed |
| Backend: automation tests only | `... -m pytest tests/test_automation.py` | **33 passed** |
| Live n8n end-to-end | `backend\.venv\Scripts\python.exe scripts\n8n_live_test.py` | **44 passed, 0 failed** (`automation/n8n/test-results/live-20261014T144209Z.json`) |
| Frontend typecheck | `npx tsc --noEmit -p .` | 0 errors |
| Frontend lint | `npm run lint` | 0 problems |
| Frontend unit tests | `npx vitest run` | **239 passed** (37 files) |
| Frontend production build | `npm run build` | Success (includes `/settings/automation`) |
| Playwright E2E | `npm run test:e2e` | **9 passed** (8 existing + 1 new automation test) |
| Migration rehearsal (`1195060a8593`) | scratch database `rightsflow_migcheck_test`: up, down, up, `alembic check` | All exit 0, no drift |
| Dev database migration | backup, then `alembic upgrade head`, then `alembic check` | Applied. Row counts unchanged (users 66, organizations 50, statements 43, ledger entries 26). Backup: `backend/storage/backups/rightsflow_ai_pre_1195060a8593.sql` |
| Secret scan of exports, docs, scripts and results | `grep` for `rfa_…`, `Bearer …`, encryption key | None found |
| bandit on the new backend code | `bandit -r app/services/automation app/api/v1/automation*.py` | 1 low finding: B105 on the constant `"rfa_"` prefix (false positive) |

Test-database runs were sequential; the backend suite was never run in parallel against the same
`_test` database.

## Live n8n run, check by check (real local)

The script registers throwaway users and creates **isolated test organizations** through the
public API. It then:
- seeds catalog, ownership, contracts and statements through the API;
- creates an automation key;
- imports the credential and workflows with `scripts/setup-n8n-automation.ps1`;
- executes each workflow with `n8n execute` and checks the results through the API.

| Area | Check | Result |
|---|---|---|
| Setup | Key created and shown once; credential and six workflows imported; error handler published; editor reachable at http://localhost:5678 (bound to 127.0.0.1) | Pass |
| Tenant isolation | Org B's key resolves to org B only, gets 404 for org A's statement and contract, and is rejected by the human JWT API | Pass |
| E. Health | Workflow executes; run recorded as `healthy` | Pass |
| A. Import | Inbox statement **and** app-uploaded statement (outbox event) processed: 2 statements, both needing review | Pass |
| A. Import | Garbage file and badly named file rejected (422) and listed in the run summary | Pass |
| A. Import | Statements end at `calculated` (draft); **no run posted, ledger empty** | Pass |
| A. Import | `no_applicable_contract_term` hold reported: the share on a draft contract without terms was **held, not paid** | Pass |
| A. Import | `statement.uploaded` event completed through the outbox | Pass |
| A. Re-run | Inbox file recognised as already imported; no new statement; **no duplicate notifications** (3 → 3) | Pass |
| B. Contracts | Reminders sent for the 7-day, 30-day and already-expired contracts; the 200-day contract was skipped | Pass |
| B. Re-run | 0 sent, 3 duplicates: no repeated reminders | Pass |
| C. AI review | 7 subjects from events: new works and recordings, a requested review, 2 high/critical conflicts | Pass |
| C. AI review | No AI provider configured: every subject `ai_unavailable`, 0 errors, nothing stored as AI output | Pass, **real provider not verified** |
| C. AI review | Conflict raised as an advisory review task and left **open** for a person | Pass |
| D. Monthly report | Report job for 2026-09 generated from app data and delivered to the owner (admin+); notification contains a link and no figures | Pass |
| D. Re-run | Same month: no second run, report or delivery | Pass |
| Reliability | Simulated crashed worker: event claimed with a 30 s lease and never acknowledged; the next run re-claimed and completed it (`attempts = 2`) | Pass |
| Reliability | API unreachable (workflows re-imported against a closed port): health workflow completes and reports "unreachable"; royalty import fails cleanly | Pass |
| Reliability | **Error workflow ran automatically** and alerted the admin ("Automation 'rightsflow-a-royalty-statement-import' failed") | Pass |
| Reliability | Workflows restored; royalty import succeeds again | Pass |
| Health API | `GET /automation/health` reports outbox and run state | Pass |

## Backend automation tests (`tests/test_automation.py`, 33 tests)

**Real local MariaDB `_test` database. Uses a mocked AI provider where noted.**

- **Authentication and authorization:**
  - missing, malformed, unknown, wrong-secret, revoked and expired keys all return 401;
  - a human JWT is rejected on `/automation/*`, and a key is rejected on the JWT API;
  - failures are audited without the secret;
  - scopes are enforced (403 `missing_scope`);
  - only admins manage keys, and the token is shown once with only the HMAC stored;
  - rotation grace periods behave as documented;
  - the service account can't sign in and uses no seat.
- **Cross-tenant:** the org B key gets 404 for statements, process, review, runs, contract
  reminders, jobs, event acknowledgements and AI review on org A data, and claims none of org A's
  events.
- **Financial:**
  - no automation route posts, reverses, approves or pays;
  - the key is rejected on the human posting endpoint;
  - missing contract terms are held;
  - nothing reaches the ledger;
  - currency rounding is unchanged and covered by the existing royalty tests.
- **Reliability:**
  - idempotency keys are required, replayed, can't be reused for a different request, and are
    released after an error;
  - duplicate uploads are reported as duplicates;
  - outbox: transactional write, single lease, stale acknowledgements rejected, expired lease
    re-claimed, poison event goes dead, requeue, exponential backoff;
  - runs: business keys and retry counter;
  - bounded long-poll;
  - **concurrent duplicate requests** (4 parallel reviews of one work; 3 parallel reminders and
    3 parallel monthly-report requests) each produce exactly one task or delivery.
- **Workflows:**
  - statement review raises one task and notifies once;
  - unmappable statements become a "confirm mapping" task;
  - contract reminders: due-checking, sent once, `no_recipients` recorded;
  - monthly report: completed months only, admins and owners only, sent once;
  - AI: pending until a human decides (mocked provider), malformed output rejected (mocked),
    conflict review is advisory (mocked), and graceful degradation without a provider (real
    configuration);
  - health and alerts, deduplicated.

## Defects found during verification, and fixed

| Found by | Problem | Fix |
|---|---|---|
| Backend test | A re-run statement review reported `updated` (the status went from processed to calculated), which would re-notify | Record the status after calculation |
| First `npm install` | Network ECONNRESET (exit -4077) | Install script retries (npm fetch retries, 3 attempts) |
| Live run 1 | The API refuses an *active* contract with a past end date (correct behaviour); the fixture was wrong | Fixture uses `pending_signature` |
| Live run 2 | Credential import failed: Windows PowerShell 5.1 writes a UTF-8 **BOM** that n8n's JSON parser rejects | BOM-free writes (`Write-Utf8NoBom`); setup always restarts n8n, even after a failure |
| Starting n8n from Git Bash | The call hung: the detached process inherited the caller's handles | Services are launched via `cmd /c … > log` through ShellExecute (no handle inheritance) |
| Live run 3 | Health workflow crashed when the API was unreachable (`neverError` doesn't cover refused connections) | Health checks use `continue on error` |
| Live run 3 | The error workflow didn't run: n8n only runs **published** error workflows | Setup publishes the error handler (it has no schedule) |
| Live run 4 | Intermittent 409 in AI review: n8n sends a node's items **in parallel**, and two events for the same work raced on the review task's unique key (InnoDB deadlock) | Lock the subject row before task and delivery writes (also for contracts, reports and alerts); savepoint fallback; AI review node sends one item at a time; regression tests with real threads |
| Frontend subagent | Party review links pointed to `/catalog/partys/…` | Correct route map, plus a test |
| Full suite | Scheduler tests expected the old number of daily jobs (a new maintenance job was added) | Expected counts updated |

## Not verified (requires credentials or infrastructure)

| Item | Status |
|---|---|
| Real AI provider (Anthropic or OpenAI-compatible) | **Not verified.** No API key is configured. Suggestion handling is verified with a **mocked** provider in pytest. The live run verified only the "AI unavailable" path. |
| Real email delivery (SMTP) | **Not verified.** The API uses the console email provider: notifications are created in the app and email previews are written to the dev outbox. Nothing was sent. |
| Stripe and payments | Not involved. The integration exposes no payment or payout execution. |
| Schedules firing on their own | Workflows were executed manually (CLI) in the tests; they are imported **inactive** by design. Scheduled firing after `-Activate` was not observed over real time. |
| n8n owner-account setup in the browser | n8n asks for an owner account on first visit. That is a manual step, not automated. |
| Multi-replica or production deployment | Out of scope (local Windows only). |
