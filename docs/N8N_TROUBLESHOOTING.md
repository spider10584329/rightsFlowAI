# n8n Integration: Troubleshooting (Windows)

Start every diagnosis with:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\check-n8n.ps1
```

It checks the n8n install and settings, the ports (and that n8n listens on localhost only),
MariaDB, FastAPI, the frontend and the stored automation key: its **expiry level** and whether it
is **bound to this n8n instance**. It works even when n8n itself can no longer authenticate.
Exit code 1 means something critical is wrong.

To see which organization this n8n instance serves, in which mode, and which workflows are active:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\show-n8n-config.ps1
```

## Installation

| Symptom | Cause / fix |
|---|---|
| `install-n8n.ps1` says Node.js 24.x is required | n8n 2.43.5 needs Node 24. Install Node 24 LTS yourself; the script never changes Node. Check that Next.js still builds afterwards (`npm run build`). |
| `npm error network read ECONNRESET` (exit -4077) | Transient network failure while downloading n8n's ~1,000 packages. The script retries 3 times with npm fetch retries. Re-run it: cached packages make later attempts faster. Behind a proxy, set `npm config set proxy http://host:port` (and `https-proxy`). |
| Install is very slow | The first install downloads and extracts roughly 1.5 GB. That is expected; later runs exit immediately. |
| `EPERM`/`EBUSY` during install | Another process is using files in `runtime\node_modules` (often a running n8n). Run `scripts\stop-n8n.ps1` and retry. |

## Starting n8n

| Symptom | Cause / fix |
|---|---|
| `Port 5678 is in use by another program` | Something else (perhaps another n8n started with `npx n8n` or a global install) is listening. Find it: `Get-NetTCPConnection -LocalPort 5678 \| Select OwningProcess`. Stop it yourself; the scripts never stop unrelated processes. |
| `n8n exited with code …` | Read `%LOCALAPPDATA%\RightsFlowAI\n8n\logs\n8n.stderr.log` and `n8n.log`. |
| `Mismatching encryption keys` | The `data` folder was created with a different `N8N_ENCRYPTION_KEY`. Restore the matching `secrets\n8n.env` from your backup. Otherwise the stored credentials can't be decrypted: move `data` aside and re-import (`setup-n8n-automation.ps1`). |
| Editor loads but you can't log in over http | `N8N_SECURE_COOKIE=false` is set in `automation\n8n\n8n.settings.env`. Use `http://localhost:5678`, not an IP or host name. |
| Task runner errors (`Task runner ... port`) when running the CLI while the server runs | The CLI starts its own task broker. `Invoke-N8nCli` uses port 5689 for it (server: 5679); override with `RIGHTSFLOW_N8N_CLI_BROKER_PORT`. |
| One "Python task runner … virtual environment is missing" warning per start | Expected with n8n 2.43.5 in internal runner mode: the check runs once per process start and no setting turns it off. The workflows use JavaScript only (`N8N_PYTHON_ENABLED=false`). |

## Connecting to the API

| Symptom | Cause / fix |
|---|---|
| HTTP nodes fail with `ECONNREFUSED 127.0.0.1:8000` | FastAPI isn't running. Run `scripts\start-local-automation.ps1`, or start uvicorn manually (`cd backend; .\.venv\Scripts\python.exe -m uvicorn app.main:app --port 8000`). |
| 401 `invalid_automation_key` | The key is wrong, revoked, expired or for a deactivated organization. Check **Settings → Automation**. Create or rotate a key, then run `setup-n8n-automation.ps1 -Token <new key>`. Failed attempts are listed in the audit log as `automation.auth_failed`. |
| 409 `instance_conflict` | The key is **bound to another n8n instance** (each key serves one instance; the instance id lives in `data\rightsflow-instance-id`). This happens when the n8n data folder was reset, copied or moved, or a second n8n uses the same key. The response names the bound instance and whether it is stale (not seen for 24 hours). **If the other instance is gone:** an admin opens **Settings → Automation → Keys → Release instance**, then re-run `setup-n8n-automation.ps1`. **If it is still running:** don't release; create or rotate a separate key for this instance. Releasing is never automatic. |
| 409 `automation_not_configured` | "Request automated review" needs an active automation key with the `events:consume` scope. Without one, no events are written (nothing would consume them). |
| 429 `rate_limited` | More than 20 failed authentications from this machine in 5 minutes, or more than 600 requests a minute with one key. Wait and fix the key. |
| 403 `missing_scope` | The key was created without the scope this workflow needs. Create a key with the default (all automation) scopes. |
| 422 `idempotency_key_required` | Custom HTTP nodes must send an `Idempotency-Key` header on POST requests. |
| 422 `idempotency_key_reused` | The same key was sent with a different body. Derive keys from `$execution.id` plus the item. |
| 409 `lease_lost` | The event was re-claimed because the lease expired, typically when processing took longer than `lease_seconds`. It is processed by the other run; nothing is duplicated. |
| 409 `statement_not_processed` | Processing was still running after the bounded wait. The review step retries; the next run picks it up otherwise. |
| 409 `report_not_ready` | The report job hasn't finished. The send step retries 5 times at 10-second intervals. |
| The credential isn't linked in imported workflows | The credential must have id `RfAutomationKey1` and name `RightsFlow automation key`. Re-run `setup-n8n-automation.ps1`, or select it in each HTTP node. |

## Workflow-specific problems

| Workflow | Symptom | Fix |
|---|---|---|
| A | Files in the inbox are ignored | The workflow reads every file in `%LOCALAPPDATA%\RightsFlowAI\n8n\inbox` (CSV and XLSX are accepted). File access is restricted to that folder (`N8N_RESTRICT_FILE_ACCESS_TO`). Each file's outcome is listed in **Settings → Automation → Inbox files**. |
| A | `rejected_files` in the run summary | The name doesn't follow `<category>__<source>__<YYYY-MM>[__<CUR>].<csv\|xlsx>`, or the file failed validation (type, size, parsing). Legacy `.xls` is rejected (`unsupported_file_type`): save it as `.xlsx`. One review task is raised per rejected file (by content hash); later runs report it as `seen_before` without new tasks. Remove or fix the file. |
| A | An app upload is not processed (`awaiting_mapping` in the summary) | Statements uploaded in the app wait until a person **confirms the column mapping** (Royalties → Statements → the statement → Confirm mapping). Confirming emits `statement.ready`; the next run processes it. Automation never confirms a mapping. |
| A | "Confirm the column mapping" review task for an inbox file | The columns couldn't be mapped automatically (no amount column, or no identifying column). Fix the mapping in the app, then use **Retry** in **Settings → Automation → Statements**. |
| A | Statement in `retry_waiting` | Processing failed with a transient error (lost DB connection, timeout, deadlock). It is retried with exponential backoff (15, 30, 60 … minutes) up to 3 attempts. Nothing to do unless it ends in `needs_manual_review`. |
| A | Statement in `needs_manual_review` | Retries were exhausted, or the failure is permanent (invalid data). Managers were notified once. Fix the cause, then **Retry** in **Settings → Automation → Statements** (resets the attempts). |
| B | Nothing is sent | No active or pending contracts end within 30 days, or every due reminder was already sent (`duplicates` in the summary). |
| C | `ai_unavailable` | No AI provider is configured in the API (`AI_PROVIDER`/`AI_API_KEY`), or the plan has no AI feature. Deterministic issues are still recorded. |
| D | Skipped immediately | That month's report was already delivered (the run's business key is `monthly:<type>:<YYYY-MM>`). |
| E | `warning` that won't clear | Read the issue list in the run summary or `check-n8n.ps1`. Open incidents of *other* workflows and failed runs without a later successful run keep the status at `warning`; the health workflow's own incident doesn't. |
| Any | Repeated failure alerts | Failures are grouped into **incidents** (workflow + error category + failing node). Admins get one alert per incident; repeats within 60 minutes are counted but not sent, then one reminder per window. After 10 occurrences owners are notified once (escalation). The next successful run resolves the incident with one "Recovered:" notice. See **Settings → Automation → Incidents**. |
| Any | Outbox events marked `expired` | Pending events older than 30 days, or in organizations without an active automation key, are marked `expired` by the daily maintenance job. They are kept, never deleted. |
| Any | Event stuck as `dead` | Inspect `last_error` in **Settings → Automation → Outbox events**, fix the cause, then **Requeue**. |

## Logs and data

- n8n: `%LOCALAPPDATA%\RightsFlowAI\n8n\logs\n8n.log`, plus the editor's **Executions** list.
- API: the uvicorn console, or `%LOCALAPPDATA%\RightsFlowAI\logs\api.stderr.log` when it was
  started by `start-local-automation.ps1`.
- RightsFlow side: `automation_runs`, `automation_events`, `automation_deliveries`,
  `automation_review_tasks`, `automation_incidents`, `automation_statement_states` and
  `automation_inbox_files`, all visible in **Settings → Automation**. Every failure is also in the
  audit log as `automation.workflow_failed`, even when its alert was suppressed.
