# n8n Integration: Deep Audit Report

**Date:** 2026-10-14

**Scope:** the whole n8n integration. This covers:
- the local install and scripts;
- the workflow exports and their copies stored in n8n;
- the FastAPI automation API, authentication, outbox, idempotency and run tracking;
- the frontend admin page, the tests and the documentation.

**Method:** evidence only. Earlier completion reports, including `N8N_TEST_RESULTS.md`, were not
taken as proof. Every status below comes from a command run during this audit, or from the cited
code.

**Constraints respected:**
- Windows only; no Docker or WSL.
- No database reset.
- Test activity was confined to throwaway `n8n E2E …` organizations and the test database.
- No payouts and no financial postings.

## Verdict

The integration is **implemented and operational at the technical level**:
- n8n runs on Windows (localhost only);
- the workflows are valid, import cleanly and execute against the real API;
- authentication and tenant isolation hold;
- schedules and the error workflow work inside the n8n server.

It is **not yet operational for real use**:
- n8n is connected only to a throwaway test organization;
- all five business workflows are inactive;
- the health workflow fails to report an expiring key.

There are also correctness and operations gaps (listed below), and two external integrations are
blocked by missing credentials. **No critical security or financial-integrity defect was found.**

## Repair status (updated 2026-10-14, after the audit-driven repair)

The findings below are the original audit and are kept unchanged as the record. This table gives
each finding's status after the repair. Evidence: **pytest** = `backend/tests/test_automation.py`
and `test_automation_reliability.py`; **live** = `scripts/n8n_live_test.py` in the separate test
n8n instance (real n8n 2.43.5, FastAPI, MariaDB), results in `automation/n8n/test-results/`.

| Finding | Status | Evidence |
|---|---|---|
| N8N-01 Not connected; workflows inactive | **Blocked** (needs your key and authorization). Tooling fixed and verified. | Setup has `-Mode operational\|test`, an organization-change guard, a connection record and no auto-activation. `activate-n8n-workflows.ps1` requires `-OrganizationId` matching the connection plus `-Confirm`, and refuses test organizations and keys that are rejected or near expiry. `show-n8n-config.ps1` shows the connected organization. Live: test-mode setup, org-change refusal and explicit change. The operational instance was not changed. |
| N8N-02 Failed statements reprocessed every run | **Fixed and verified** | Durable `automation_statement_states`: transient → backoff (max 3 attempts); permanent or exhausted → `needs_manual_review`; manager **Retry**. pytest: 2 tests. Live: transient failure → `retry_waiting` → due retry → `completed`, no duplicate statement (runs 1 and 2). |
| N8N-03 Alert storm | **Fixed and verified** (one sub-path verified by pytest only) | `automation_incidents`: fingerprint, 60-minute suppression, reminders, escalation to owners at 10 occurrences, recovery notice, per-organization isolation, audit entry for every failure. pytest: 4 tests. Live, in server mode: a failing schedule produced one incident, one alert and suppressed repeats. Live: repeated health warnings were suppressed. The health incident's *recovery* failed in live run 2 (defect R-2 below). It was fixed afterwards and is verified by pytest only. |
| N8N-04 Health under-reports | **Fixed and verified** (recovery path by pytest only) | Expiry levels ok, warning (≤14 days), critical (≤3 days), expired and revoked. E uses the API's `issues` and reports healthy, warning or critical; it alerts, and fails loudly on 401/403/409 or when the API is unreachable. Backend maintenance notifies admins about expiring keys independently of n8n. `check-n8n.ps1` is a separate local path. pytest: 3 tests. Live: healthy, then key at 10 days → `warning` + one incident + alert, then suppression; API down → CRITICAL, non-zero exit. |
| N8N-05 Unbounded outbox | **Fixed and verified** (pytest) | Events are only written for organizations with an active `events:consume` key. Stale `pending` events (30 days, or organizations without a key) are marked `expired` in batches of 500 by the daily maintenance job; nothing is deleted. pytest: gating, expiry, reactivation, organization safety. The existing dev-DB events are left as they are until the maintenance job runs; not separately observed live. |
| N8N-06 App uploads auto-processed | **Fixed and verified** | App uploads wait for a person to confirm the mapping (`mapping_confirmed_at`), which emits `statement.ready`. No default mappings are invented: an inbox statement needs an amount column plus one identifying column. pytest: 2 tests. Live: `awaiting_mapping` → owner confirms → processed (runs 1 and 2). |
| N8N-07 Idempotency collisions across instances | **Fixed and verified** | Keys namespaced `<instance id>:…`. Each key is bound to one instance (409 `instance_conflict`, stale detection, admin **Release instance**, never automatic). pytest: 2 tests. Live: binding to the test instance; a second instance id refused. |
| N8N-08 Error-workflow check relied on CLI mode | **Fixed and verified** | The live test now runs a scheduled probe and a failing probe **inside the n8n server**. In two live runs: schedule `trigger/success`; error handler `error/success` ≥2; one incident with alerts_sent 1 and suppressed ≥1. |
| N8N-09 XLSX ignored | **Fixed and verified**. File moving: **accepted limitation**. | Inbox reads `*.*`; XLSX imported with exact amounts (1234.5678 and 0.42) and no formula execution (pytest + live); legacy `.xls` rejected with `unsupported_file_type` (pytest + live). Every file gets a stored outcome by SHA-256, and one review task per rejected file. Files are **not** moved to subfolders (the n8n file-access restriction covers the inbox only); outcomes are recorded instead and re-runs are idempotent. |
| N8N-10 Wrong mapping docs | **Fixed and verified** | Behaviour fixed (confirmation emits `statement.ready`, verified live); troubleshooting rewritten. |
| N8N-11 Fixed-interval node retries | **Accepted limitation** | Documented in `N8N_WORKFLOWS.md`. Durable retries with backoff live in the API (outbox, statement states). |
| N8N-12 Rate limits untested | **Fixed and verified** | pytest: failed-authentication 429 per IP; per-key 429. |
| N8N-13 "Run marked failed" not exercised | **Fixed and verified** (pytest) | `test_error_handler_alert_marks_the_started_run_failed`. |
| N8N-14 Platform deprecations | **Accepted limitation** | Pinned 2.43.5. `N8N_PYTHON_ENABLED=false` disables Python in Code nodes. n8n 2.43.5 still logs one Python-runner warning per process start in internal mode; no setting suppresses it (confirmed in the n8n source). The container and npm deprecation notices remain. Reassess before n8n 3.x. |
| N8N-15 Owner setup hung | **Accepted limitation**, documented | Root cause still unconfirmed. `N8N_WINDOWS_SETUP.md` says to reload the page after owner setup. Telemetry, version notifications, personalization and banners are off; templates are left on. |
| N8N-16 Test artefacts accumulate | **Fixed and verified** for new runs. Old leftovers: **pending your approval**. | The live test revokes its keys and archives its organizations (live: keys rejected afterwards). It runs in its own n8n instance. Leftovers from earlier runs are untouched: test organizations and keys in the dev DB, and two inactive "RF DIAG" workflows in the operational n8n. Removing them changes shared data and needs your OK. |
| N8N-17 No webhook triggers | **Accepted** (by design) | Pull-based delivery; localhost only. |
| N8N-18 Branches never executed | **Fixed and verified** | Live: B with nothing due (organization B, 0 contracts); E problems → alert. D's `report_not_ready` retry ran live in run 2: it was exhausted when the report job was slow, and the re-run completed the same delivery once. That was an uncontrolled observation; the API side is covered by pytest. |
| N8N-19 External integrations | **Blocked** | During live run 2 you configured SMTP and Anthropic in `backend\.env`. SMTP authentication failed (535), so nothing was delivered (test recipients were `@example.com` only), and the AI calls returned errors. Neither is verified. The live test now refuses to run against real providers unless explicitly allowed. |

**New defects found and fixed during the repair**

- **R-1:** `finish_run(succeeded)` could resolve an incident raised by the same execution. Open
  incidents whose last failure came from that execution now stay open. pytest:
  `test_a_run_that_reports_a_problem_does_not_resolve_its_own_incident`.
- **R-2:** the health check counted its own open incident as an `open_incidents` problem, and
  counted failed runs for 24 hours even after recovery. Health therefore could not return to
  healthy, and its alert fingerprint changed between runs. Now it excludes its own incidents and
  counts only failed runs with no later successful run. pytest:
  `test_health_recovers_once_failures_recover`. Not yet re-verified live (see N8N-19: the live
  test needs an API with console email).
- **R-3:** `Invoke-N8nCli` used the server's task-broker port, so CLI executions collided with a
  running server. The CLI now uses its own port (5689 / server 5679).

## Environment facts (observed)

| Item | Observation | Evidence |
|---|---|---|
| Node.js | v24.21.0 | `node -v` |
| n8n | 2.43.5; engines `node >=24.0.0`; 1,112 top-level packages, 1.99 GB, in `%LOCALAPPDATA%\RightsFlowAI\n8n\runtime` | `package.json`, `npm ls n8n` |
| n8n process | Listening on **127.0.0.1:5678** (and task broker 127.0.0.1:5679). The pid file holds the `cmd.exe` wrapper; n8n is its child. | `Get-NetTCPConnection`, `Win32_Process` |
| n8n owner account | 1 user (created by you in the browser) | n8n SQLite `user` table |
| Workflows stored in n8n | 6 present. **Only the error handler is active**; A–E are inactive. | `workflow_entity.active` |
| Credential stored in n8n | `RfAutomationKey1`, "RightsFlow automation key", `httpHeaderAuth` | `credentials_entity` |
| Key n8n is using | Key `5931f9be…` of a **throwaway test organization**, expiring in 6 days | `scripts\check-n8n.ps1`, `/automation/whoami` |
| Automation keys for real organizations | **0** (13 keys exist, all in test organizations) | MariaDB `integration_credentials` |
| Execution history before this audit | Every execution had mode `cli`: none from the editor, schedules or webhooks. The error handler had 2 executions, both `crashed`. | n8n `execution_entity` |
| Secrets folder ACL | `Administrator:(OI)(CI)(F)` only; the key file has `Administrator:(F)` only | `icacls` |
| Dev DB migration | Head `1195060a8593` | `alembic current` |

## Workflow-by-workflow audit

Labels used in the tables:
- **Real:** executed against real local services during this audit.
- **Mock:** verified only with a mocked external service.
- **Not run:** implemented but not executed.
- **Blocked:** needs external credentials.

### A. Royalty statement import (`RfWfRoyaltyImprt`)

| Aspect | Finding |
|---|---|
| Trigger | Manual and every 15 minutes. **Inactive in this environment** (N8N-01). |
| Input | `*.csv` in the inbox, named `<category>__<source>__<YYYY-MM>[__<CUR>].csv`, plus `statement.uploaded` outbox events. XLSX is **not** picked up (N8N-09). |
| Auth | Header Auth credential `RfAutomationKey1`; scopes `statements:import`, `statements:review` and `events:consume`. |
| API calls | `/runs`, `/statements` (multipart), `/events/claim`, `/statements/{id}/process`, `GET /statements/{id}?wait_seconds`, `/statements/{id}/review`, `/runs/{id}/finish`. All verified against OpenAPI by the lint (N8N-L). |
| Business dependencies | Existing import, duplicate detection, matching and the draft calculation engine. |
| Success path | **Real:** inbox file plus app upload processed; `no_applicable_contract_term` held; nothing posted; ledger empty. Live run `live-20261014T182829Z`. |
| Empty path | **Real:** no files and no events gives `statements: 0` and a finished run (executed during this audit). |
| Failure path | **Real:** API unreachable fails the n8n execution. Rejected files are listed in the summary. |
| Retry | Node retry 3 × 5 s, fixed interval (N8N-11). The outbox lease gives at-least-once delivery. |
| Idempotency | **Real:** re-run gives `inbox_duplicate`, no new statement and no new notification. Collision risk after an n8n data reset (N8N-07). |
| Tenant isolation | **Real:** organization comes from the key; org B's key gets 404 for org A's statement. |
| Notifications | `automation_review` sent to managers once per distinct finding set. **Real** (3 → 3 on re-run). |
| Gaps | N8N-02 (failed statements reprocessed every run), N8N-06 (user uploads auto-processed), N8N-09, N8N-10 |
| Status | **Works; gaps open** |

### B. Contract expiration reminders (`RfWfContractExpr`)

| Aspect | Finding |
|---|---|
| Trigger | Manual and daily 07:00 UTC. **Inactive** (N8N-01). |
| Input | Contracts from `GET /contracts/expiring?within_days=30`; thresholds 30/14/7 set in the Config node. |
| API calls | `/runs`, `/contracts/expiring`, `/contracts/{id}/reminders`, finish. Lint OK. |
| Success path | **Real:** 7-day, 30-day and expired reminders sent; the 200-day contract skipped. |
| Idempotency | **Real:** re-run gives 0 sent and 3 duplicates. Concurrent duplicates are covered by a threaded pytest. |
| Failure path | Reminder errors are recorded per contract (`neverError`); other failures go to the error workflow. |
| Not executed | The "no reminders due" branch (N8N-18). |
| Overlap | The app's built-in daily job also sends one warning at the organization's warning window (60 days by default) and marks fixed-term contracts `expired`. After that the workflow's "expired" reminder no longer applies. Documented. |
| Status | **Works** |

### C. AI metadata and rights review (`RfWfAiReview0001`)

| Aspect | Finding |
|---|---|
| Trigger | Manual and every 30 minutes. **Inactive** (N8N-01). |
| Input | Events `work.created`, `recording.created`, `review.requested` and `rights_conflict.opened` (high or critical severity). |
| API calls | `/events/claim`, `/ai/review` (sent one item at a time), `/ai/sync-decisions`, runs. Lint OK. |
| Success path (no provider) | **Real:** 6–7 subjects per run, all `ai_unavailable`, 0 errors, nothing stored as AI output. |
| Empty path | **Real:** `subjects: 0` (executed during this audit). |
| AI suggestions and human decision | **Mock** only: pending suggestion, approval applies through the catalog service, task closes. |
| Real AI provider | **Blocked** (no `AI_API_KEY`) |
| Concurrency | **Real/pytest:** 4 parallel reviews of one subject produce one task and no error (a previous race, fixed). |
| Status | **Works without AI; AI path mock-verified only** |

### D. Monthly royalty report (`RfWfMonthlyRprt1`)

| Aspect | Finding |
|---|---|
| Trigger | Manual and monthly on the 2nd at 06:00 UTC. **Inactive** (N8N-01). |
| API calls | `/runs` (business key `monthly:<type>:<YYYY-MM>`), `/reports/monthly`, `GET /jobs/{id}?wait_seconds`, `/reports/deliveries/{id}/send`. Lint OK. |
| Success path | **Real:** report for 2026-09 generated from app data; owner notified with a link and no figures. |
| Idempotency | **Real:** re-run for the same month creates no new run or delivery. |
| Authorization | **Pytest:** a named non-admin recipient gets 403. |
| Email | **Blocked:** the console provider is in use; no real delivery. |
| Status | **Works** |

### E. Automation health check (`RfWfHealthCheck1`)

| Aspect | Finding |
|---|---|
| Trigger | Manual and hourly. **Inactive** (N8N-01). |
| Success path | **Real:** the run is recorded. |
| API unreachable | **Real:** the workflow completes and reports "unreachable". |
| Defect | **N8N-04:** it reported `healthy` while the API's own health returned `problems: ["credential_expiring_soon"]`, because the Diagnose node ignores the API's `problems` list. |
| Not executed | The "Problems found → Alert admins" branch (N8N-18). |
| Status | **Partially broken** (under-reports) |

### Error handler (`RfWfErrorHandler`)

| Aspect | Finding |
|---|---|
| Server mode | **Real (diagnostic probe):** a scheduled failing workflow ran the error handler twice (mode `error`, status `success`), and admins received 2 alerts. Evidence: `automation/n8n/test-results/server-probe-2026-10-14T184205Z.json`. |
| CLI mode | **Unreliable:** executions recorded as `crashed` (2), and in this audit's live run the error workflow wasn't recorded at all, so the harness check failed (N8N-08). |
| Alert volume | **N8N-03:** deduplication is per failed execution, so a workflow that keeps failing alerts admins on every run (observed: 2 alerts in 2 minutes). |
| Status | **Works in server mode; noisy** |

## Findings

Severity:
- **High:** prevents real use, or hides failures.
- **Medium:** a correctness or operations gap with workarounds.
- **Low:** coverage, documentation or hygiene.

### N8N-01 · High · Operations: not connected to any real organization; every workflow is inactive

**Evidence:**
- `integration_credentials`: 0 keys outside test organizations.
- n8n `workflow_entity.active = 0` for workflows A–E.
- `check-n8n.ps1` shows key `5931f9be…` (test organization, 6 days left).

**Reproduce:** run `powershell -File scripts\check-n8n.ps1`, then `/automation/whoami` with the stored key.

**Root cause:** the live test harness leaves n8n on a throwaway organization. Restoring a "previous key" only restores the previous test key. Activation is a deliberate manual step.

**Fix:**
1. Create a key for the real organization in **Settings → Automation**.
2. Run `setup-n8n-automation.ps1 -Token <key> -Activate`.
3. Make the harness use a separate n8n credential id, so it never replaces the production one.

**Verify:** `whoami` returns the real organization; after one scheduled interval, runs show `trigger_type = schedule`.

### N8N-02 · Medium · Workflow A: failed statements are reprocessed on every run

**Evidence:** `backend/app/services/automation/operations.py:211`. The "already started" statuses omit `failed`, and inbox files are never moved after upload, so every 15 minutes the duplicate file is matched to the failed statement and processing is requested again.

**Reproduce:** put a file whose processing job fails in the inbox, then run A twice. A new `royalty_import` job is queued each time.

**Root cause:** no terminal-state handling for `failed` statements, and no inbox archive step.

**Fix:**
- Treat `failed` as terminal for automation: report it and raise a review task instead of reprocessing.
- Or move processed and rejected files to `inbox\processed` / `inbox\rejected`.

**Verify:** run twice; the second run queues no job.

### N8N-03 · Medium · Error handler: alert storm

**Evidence:** `operations.py:737`, dedupe key `alert:{workflow}:{execution_id}`. The probe produced 2 alerts in 2 minutes for one failing scheduled workflow. `automation_failed` is emailed by default.

**Reproduce:** a workflow failing on every scheduled run, for example a broken node, alerts on every run: about 96 times a day at 15-minute intervals.

**Root cause:** deduplication is per execution, not per workflow and time window.

**Fix:**
- Deduplicate on `alert:{workflow}:{error_code}:{UTC hour or day}` and keep a counter.
- Send a "recovered" notice on the next success.

**Verify:** the probe again; 1 alert per window.

### N8N-04 · High · Workflow E: under-reports, so an expiring key goes unnoticed

**Evidence:** `automation/n8n/build_workflows.py:531-534` (Diagnose). A run during this audit recorded `overall: healthy, problems: []`, while `GET /automation/health` returned `problems: ["credential_expiring_soon"]`.

**Reproduce:** run E with a key that has fewer than 14 days left.

**Root cause:** Diagnose derives problems only from HTTP status, outbox, dead and failed counts. It ignores `body.problems` and `credential.rotation_recommended`.

**Fix:** include each entry of `body.problems` as a failing check.

**Verify:** run E with the current test key; it should report `degraded` and alert once.

### N8N-05 · Medium · Outbox grows without bound for organizations that don't use automation

**Evidence:**
- `royalty_import.py:158`, `catalog.py:715` and `rights.py:978` emit events unconditionally.
- `events.py:212` purges only `completed` events.
- 12 events are pending in non-test organizations that have no automation key.

**Root cause:** events are emitted with no check that the organization has an automation consumer.

**Fix:**
- Emit only if the organization has an active key.
- Or expire `pending` events after N days into a terminal `expired` status.

**Verify:** create a work in an organization without a key; no event row is written.

### N8N-06 · Medium · Workflow A auto-processes statements that people uploaded in the app

**Evidence:** `build_workflows.py:244-273`. A `statement.uploaded` event leads to *Start processing* with the auto-detected mapping, up to 15 minutes after a user's upload, whether or not they intended to adjust the mapping first.

**Root cause:** the design treats every app upload as ready to process.

**Fix:**
- Make it an organization setting ("auto-process app uploads"), defaulting to off.
- Or only review statements a person has already processed.

**Verify:** upload in the app with the setting off; the workflow doesn't process it.

### N8N-07 · Medium · Idempotency keys collide across n8n databases or instances

**Evidence:** keys such as `run-start-{{ $execution.id }}` and `upload-{{ $execution.id }}-{{ $itemIndex }}` (`build_workflows.py:162,231`). n8n execution ids restart at 1 per database, and the API keeps keys for 7 days. Replaying `run-start-53` with a new body returned **422 `idempotency_key_reused`** (executed during this audit).

**Reproduce:** reset or move the n8n data folder, or run a second n8n instance on the same organization, then run any workflow.

**Root cause:** keys aren't namespaced per n8n instance.

**Fix:** prefix keys with a per-instance id, for example `{{ $execution.id }}` plus the n8n instance id, or a UUID generated once in Config per execution.

**Verify:** two instances run without 422.

### N8N-08 · Medium · Tests: error-workflow verification relies on CLI mode, where it is unreliable

**Evidence:**
- n8n `execution_entity`: error handler `crashed` (ids 24 and 37).
- This audit's live run `live-20261014T182829Z`: "Error workflow ran automatically" **FAILED**.
- The earlier `N8N_TEST_RESULTS.md` states it as passed.

**Root cause:** `n8n execute` exits before its error workflow finishes, or before it is persisted.

**Fix:** verify error handling in server mode, as `scripts/diagnostics/n8n_server_probe.py` does, and remove or mark the CLI-based check as informational. Update `N8N_TEST_RESULTS.md`.

**Verify:** the probe passes repeatedly.

### N8N-09 · Medium · XLSX statements in the inbox are ignored, though the docs say CSV/XLSX

**Evidence:** `build_workflows.py:192` (`/*.csv`); `docs/N8N_WINDOWS_SETUP.md:131`.

**Fix:** use the glob `*.{csv,xlsx}` (check that n8n's fast-glob supports it on Windows), or correct the docs.

**Verify:** an XLSX in the inbox is uploaded.

### N8N-10 · Low · Docs: the mapping-task advice is wrong for app uploads

**Evidence:** `docs/N8N_TROUBLESHOOTING.md:52` says "the next run processes it". That is true only for inbox files: app-upload events are completed when the mapping task is raised and never re-triggered.

**Fix:** correct the docs, or re-emit an event when a person confirms a mapping.

**Verify:** n/a (documentation), or a test that confirming a mapping re-queues automation.

### N8N-11 · Low · n8n node retries use a fixed interval, not exponential backoff

**Evidence:** `build_workflows.py:127` (3 × 5 s) and `:485` (5 × 10 s). Exponential backoff exists only in the outbox (`events.backoff_seconds`).

**Fix:** accept and document this, or rely on the outbox: return `retry` acknowledgements rather than node retries for transient API failures.

### N8N-12 · Low · Automation rate limiting is not tested

**Evidence:** `context.py` (20 failures per 5 minutes per IP; 600 requests a minute per key). `tests/test_automation.py` has no 429 test.

**Fix:** add tests for both limits.

### N8N-13 · Low · "Error handler marks the run failed" is not exercised

**Evidence:** `operations.raise_alert` looks the run up by `execution_id`. In both live and probe failures no run had been started, so the branch never ran.

**Fix:** add a probe or test where a workflow fails after *Start run*, and assert `automation_runs.status = failed`.

### N8N-14 · Medium · Platform risk: n8n deprecations against the no-Docker constraint

**Evidence:** `n8n.log` deprecation notices:
- "Running n8n outside a container is deprecated. Future versions will require running n8n via the official Docker image."
- Internal task-runner mode is deprecated.
- npm installs are deprecated from n8n 3.0 (n8n docs).
- 50 "Python task runner … virtual environment missing" warnings.

**Fix:**
- Pin 2.43.x and track n8n release notes.
- Plan for external task-runner mode.
- Set `N8N_RUNNERS_ENABLED` / Python runner settings so the Python runner warnings stop.
- Reassess native installs before upgrading to n8n 3.x.

### N8N-15 · Low · First-run owner setup hung in the browser

**Evidence:** your report and screenshot. The server logged "Owner was set up successfully"; the UI spinner never resolved.

**Root cause:** unconfirmed. Likely a post-setup call to an external n8n service (the updates opt-in) hanging on the unstable network seen during npm installs.

**Fix:** document "reload after setup". Optionally disable external calls (templates, banners).

### N8N-16 · Low · Test hygiene: test and diagnostic artefacts accumulate

**Evidence:**
- 12 `n8n E2E …` organizations and 12 `n8n-e2e-*` users in the dev DB.
- 13 active test keys.
- 1 event stuck as `claimed` in a test organization.
- 2 inactive "RF DIAG …" probe workflows in n8n.

**Fix:**
- Make the harness revoke its keys and deactivate its organizations at the end.
- Delete the probe workflows in the n8n editor.
- Optionally provide a cleanup script.

### N8N-17 · Low · No webhook triggers (by design)

**Evidence:** none of the workflows has a Webhook node. Delivery is pull-based (outbox polling every 15 or 30 minutes).

**Impact:** latency of up to one polling interval, and no intake of events from external systems. That is acceptable for local use and consistent with the localhost-only requirement.

**Fix (optional):** an authenticated webhook trigger bound to localhost, if real-time handling is needed.

### N8N-18 · Low · Branches never executed

**Evidence:** neither the live harness nor this audit has executed:
- B's "no reminders due" branch;
- E's "Problems found → Alert admins" branch;
- the D "Notify recipients" retry on `report_not_ready`.

**Fix:** add these cases to the harness, for example a test organization with no due contracts and a short-lived key.

### N8N-19 · Blocked · External integrations

- **Real AI provider:** no `AI_API_KEY`. Workflow C's AI path is verified only with mocks.
- **SMTP:** the console provider; no real email.

**Verify once credentials exist:** run C with AI enabled, and check email delivery of reminder, report and alert notices.

### N8N-L · Info · Static contract check (no defects)

`scripts/diagnostics/n8n_workflow_lint.py` (added during this audit) validates **26 authenticated API calls** across the six exports:
- method and path exist in the OpenAPI schema;
- JSON body keys are accepted by `extra="forbid"` schemas and required keys are present;
- multipart and query fields;
- credential references and `Idempotency-Key` on mutating calls;
- node references and connections, and reachability from triggers.

**Result: 0 errors, 0 warnings.** Mutation tests confirmed it detects a wrong path and a wrong body field.

**Drift check:** the workflows stored in n8n match the repo exports, apart from the expected inbox-path substitution.

## Acceptance checklist and verified percentage

Legend:
- **V:** verified with real local services during this audit.
- **M:** verified with mocks only.
- **I:** implemented, not executed.
- **X:** missing or broken.
- **B:** blocked by credentials.

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Native n8n install, pinned, Node-compatible | V | Environment facts |
| 2 | n8n starts and stops on Windows via scripts | V | Probe and harness restarts |
| 3 | Editor reachable, bound to 127.0.0.1 only | V | `healthz`, listener address |
| 4 | Persistent data folder, encryption key, user-only secrets ACL | V | `icacls` |
| 5 | Real HTTP from n8n to FastAPI with the automation credential | V | Live run, probe |
| 6 | Six workflow exports exist | V | Lint |
| 7 | Exports import; the copy stored in n8n matches the repo | V | Import, export diff |
| 8 | Every API call matches route, method and schema | V | Lint (26 calls) |
| 9 | No secrets in exports; credential by reference | V | Lint, grep |
| 10 | Machine credentials: HMAC, scopes, expiry, rotation, revocation | V | pytest on real DB (33/33) |
| 11 | Authentication failures rejected and audited without the secret | V | pytest |
| 12 | Authentication-failure and per-key rate limiting | I | N8N-12 |
| 13 | Tenant isolation | V | pytest, live |
| 14 | Outbox written in the business transaction | V | pytest, live |
| 15 | Lease, re-claim after expiry, backoff, dead letter, requeue | V | pytest; live lease expiry |
| 16 | Idempotency (replay, reuse detection, release on error) | V | pytest, live (collision gap: N8N-07) |
| 17 | Run tracking with execution and correlation ids | V | Live, probe |
| 18 | A works end to end, holds missing terms, never posts, no duplicates | V | Live |
| 19 | B works; reminders due-checked and sent once | V | Live |
| 20 | C works (AI-unavailable path) | V | Live |
| 21 | C AI suggestions wait for a human decision | M | pytest (mocked provider) |
| 22 | D works; once per month; admins only | V | Live, pytest |
| 23 | E reports problems correctly | X | N8N-04 |
| 24 | Error workflow alerts on a real failure (server mode) | V | Probe |
| 25 | Schedule triggers fire inside the n8n server | V | Probe |
| 26 | Real workflows connected to a real organization and active | X | N8N-01 |
| 27 | Failure handling avoids reprocessing loops and alert storms | X | N8N-02, N8N-03 |
| 28 | Outbox bounded for organizations without automation | X | N8N-05 |
| 29 | Real AI provider | B | N8N-19 |
| 30 | Real email delivery | B | N8N-19 |
| 31 | Frontend admin page works in a browser | V | Playwright `automation.spec.ts` |
| 32 | Existing regression suites pass | V | See "Tests executed" |
| 33 | Documentation accurate | X | N8N-08, N8N-09, N8N-10 |

Webhook triggers are **not applicable**: the pull design is intentional and they were optional in
the original requirements, so they are excluded from the count (see N8N-17).

| Category | Count | Share of 33 |
|---|---|---|
| Verified with real services (V) | 24 | **72.7%** |
| Verified with mocks only (M) | 1 | 3.0% |
| Implemented, not executed (I) | 1 | 3.0% |
| Missing or broken (X) | 5 | 15.2% |
| Blocked by credentials (B) | 2 | 6.1% |

## Tests executed during this audit

| Test | Command | Result |
|---|---|---|
| Static workflow and API contract lint | `backend\.venv\Scripts\python.exe scripts\diagnostics\n8n_workflow_lint.py` | 26 calls validated, **0 errors**. Mutation tests detected both injected defects. |
| Drift check, n8n-stored vs repo | `n8n export:workflow --all --separate`, then a diff | No drift |
| Backend automation tests | `pytest tests/test_automation.py` | **33 passed** |
| Backend full suite | `pytest tests` | **287 passed**, 0 failed or errors. The doubled `-q` hides the summary line; the count comes from the 287 progress marks with no `F` or `E`. |
| Frontend unit tests and typecheck | `npx vitest run`, `npx tsc --noEmit` | Vitest **239 passed** (37 files); tsc exit 0 |
| Live n8n end-to-end (real n8n, FastAPI, MariaDB) | `scripts\n8n_live_test.py` | **43 passed, 1 failed** (error workflow in CLI mode, N8N-08). `test-results/live-20261014T182829Z.json` |
| Server-mode probe (schedules, credential, Code node, error workflow inside the n8n server) | `scripts\diagnostics\n8n_server_probe.py --wait 150` | Schedule probe: 2 `trigger` executions succeeded, runs recorded as `schedule`. Failing probe: 2 error-handler executions succeeded, 2 alerts. `test-results/server-probe-2026-10-14T184205Z.json` |
| Empty-input branches | `n8n execute` A and C with empty inbox and no events | Both succeeded (`statements: 0`, `subjects: 0`) |
| Degraded health detection | `n8n execute` E with a key expiring in 6 days | Reported healthy: **defect N8N-04** |
| Idempotency collision | `POST /automation/runs` with reused `run-start-53` | 422 `idempotency_key_reused`: **N8N-07** |
| Playwright automation page | `npx playwright test e2e/automation.spec.ts` | **1 passed** |

## Artefacts created during this audit

- `scripts/diagnostics/n8n_workflow_lint.py`: static contract check (read-only).
- `scripts/diagnostics/n8n_server_probe.py`: server-mode probe. It left two **inactive** workflows,
  "RF DIAG - schedule probe (temporary)" and "RF DIAG - failing probe (temporary)", which are safe
  to delete in the editor. It also wrote probe run rows and 2 alert notifications in the test
  organization.
- `automation/n8n/test-results/live-20261014T182829Z.json`, `server-probe-2026-10-14T184205Z.json`.
- One more throwaway test organization from the live run.

No production code was changed during this audit.
