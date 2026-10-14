# n8n on Windows (native, no Docker): Setup

Everything below runs in **Windows PowerShell** from the repository root
(`D:\My_Projects\z_testing\Jonathan\rightsFlowAI`). Docker, WSL and cloud services are not used.

## Prerequisites

| Requirement | Version used | Notes |
|---|---|---|
| Windows 10/11 | Windows 10 Pro 22H2 | |
| Node.js | **24.x** (tested with 24.21.0) | n8n 2.43.5 declares `node >=24`. n8n's npm-install docs support 20.19–24.x. The scripts refuse other majors and never change your Node installation. |
| npm | 11.x | |
| XAMPP MariaDB | 10.4 | Start **MySQL** in the XAMPP Control Panel |
| Python venv | `backend\.venv` | Already set up for the backend |
| Free port | 5678 | Checked by the scripts |
| Disk | about 1.5 GB on C: | n8n's dependencies |

## Versions

- **n8n 2.43.5** (npm `stable` tag on 2026-10-14), pinned in `automation\n8n\runtime\package.json`.
- It is installed **locally**, not globally, into `%LOCALAPPDATA%\RightsFlowAI\n8n\runtime`.

## Folder layout

The repository holds the scripts, workflows and settings. The runtime and data live outside it,
on C:, under `%LOCALAPPDATA%\RightsFlowAI\n8n\`:

| Folder | Contents |
|---|---|
| `runtime\` | `node_modules` (pinned n8n) |
| `data\` | `N8N_USER_FOLDER`: n8n's SQLite DB, settings, execution history |
| `logs\` | `n8n.log`, plus stdout/stderr of the background process |
| `inbox\` | Workflow A picks statements up from here |
| `secrets\` | `n8n.env` (`N8N_ENCRYPTION_KEY`), `automation-key.txt`, `automation-key.previous.txt` (after a key change) and `connection.json` (which organization this instance serves, in which mode; no secrets). Current user only. |
| `data\rightsflow-instance-id` | This instance's id (`rf-<guid>`). The API binds each key to one instance id. |
| `n8n.pid` | |

A separate **test instance** used by the live test lives in `%LOCALAPPDATA%\RightsFlowAI\n8n-test`
(port 5688, its own data, encryption key, credential and instance id). It shares only the
`runtime` folder. The scripts select it through `RIGHTSFLOW_N8N_HOME`, `RIGHTSFLOW_N8N_PORT` and
`RIGHTSFLOW_N8N_BROKER_PORT`; without them they always use the operational instance.

n8n's storage (SQLite) is completely separate from the RightsFlow MariaDB database.

## 1. Install n8n

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-n8n.ps1
```

The script:
- checks Node.js and npm;
- creates the folders and a random `N8N_ENCRYPTION_KEY` (once);
- runs `npm install` with network retries.

Re-running it is safe: it exits early when 2.43.5 is already installed. Pass `-Force` to reinstall.

## 2. Start the services

```powershell
# Everything: checks MariaDB, starts FastAPI and Next.js if their ports are free, then n8n.
powershell -ExecutionPolicy Bypass -File scripts\start-local-automation.ps1

# Or only n8n:
powershell -ExecutionPolicy Bypass -File scripts\start-n8n.ps1
```

How the start scripts behave:
- n8n runs hidden in the background, bound to **127.0.0.1:5678**.
- Its environment variables are set for that process only. Nothing is written to your user or
  machine environment.
- Services that are already running are left alone, and unrelated processes are never stopped.

## 3. Open the editor

Browse to **http://localhost:5678**. On first visit, n8n asks you to create its **owner account**.
This is n8n's own login, separate from RightsFlow; use a strong password. Any email address works;
it doesn't have to match a RightsFlow account.

If the page keeps spinning after you submit the owner form, reload it (F5). The owner is usually
created already (`n8n.log` says "Owner was set up successfully"), and you can sign in. The cause
was not confirmed; it's most likely a post-setup call to an external n8n service on a slow
network (audit N8N-15).

## 4. Create an automation key and connect n8n

1. Sign in to RightsFlow as an **admin**. Go to **Settings → Automation → Create key**, or use the API:
   `POST /api/v1/organizations/{id}/automation/credentials`.
2. Copy the key (`rfa_…`). It is shown only once.
3. Run the setup script with the key:

   ```powershell
   $key = Read-Host 'Paste the automation key'
   powershell -ExecutionPolicy Bypass -File scripts\setup-n8n-automation.ps1 -Token $key
   ```

   The script:
   - verifies the key (`/api/v1/automation/whoami`) **with this instance's id**. If the key is
     bound to another n8n instance, it stops and prints the recovery steps (see
     [Troubleshooting](N8N_TROUBLESHOOTING.md), `instance_conflict`);
   - refuses to switch an instance that already serves another organization, unless you pass
     `-AllowOrganizationChange`;
   - keeps the previous key as `automation-key.previous.txt` and stores the new one in
     `secrets\automation-key.txt`;
   - creates the n8n credential **"RightsFlow automation key"** (a Header Auth credential:
     `Authorization: Bearer rfa_…`, encrypted by n8n);
   - imports the six workflows, filling in the API URL, inbox folder, n8n URL and instance id;
   - publishes only the error handler. Business workflows keep their previous active state
     (inactive on a first setup);
   - records the connection (`secrets\connection.json`: organization, key id, mode).

   n8n is briefly stopped and restarted during the import.

   **Replacing the key** (rotation, or a new key for the same organization): rotate in
   **Settings → Automation** (the old key keeps working during the grace period), then run the
   script again with the new key. Active workflows stay active.

4. Check the result:

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\show-n8n-config.ps1
   ```

   It shows the mode, the connected organization, the key id, its expiry level, whether the key is
   bound to this instance, and each workflow's active state. It never prints the key.

### Attaching the credential manually (instead of the script)

In n8n, go to **Credentials → Add credential → Header Auth**:
- **Name:** `RightsFlow automation key`
- **Header name:** `Authorization`
- **Value:** `Bearer rfa_…`

Then import each file from `automation\n8n\workflows` (**Workflows → Import from file**). In the
**Config** node, replace `__RIGHTSFLOW_API_URL__` with `http://127.0.0.1:8000`,
`__RIGHTSFLOW_INBOX__` with your inbox path (forward slashes), `__RIGHTSFLOW_N8N_URL__` with
`http://127.0.0.1:5678` and `__RIGHTSFLOW_INSTANCE_ID__` with the content of
`data\rightsflow-instance-id`. Open each HTTP node and select the credential if n8n didn't link it
automatically. The script is the recommended way.

## 5. Run workflows manually

In the editor, open a workflow and click **Execute workflow**. Every workflow has a **Run now**
manual trigger, so you don't have to wait for its schedule.

From PowerShell:

```powershell
. .\scripts\n8n-common.ps1
Invoke-N8nCli execute --id=RfWfHealthCheck1 --rawOutput   # CLI task broker on 5689, server on 5679
```

Use the CLI for one-off runs only. The error workflow is reliable only inside the running server
(audit N8N-08); failures of CLI executions may not reach it.

| Workflow | Id |
|---|---|
| A. Royalty statement import | `RfWfRoyaltyImprt` |
| B. Contract expiration reminders | `RfWfContractExpr` |
| C. AI metadata and rights review | `RfWfAiReview0001` |
| D. Monthly royalty report | `RfWfMonthlyRprt1` |
| E. Automation health check | `RfWfHealthCheck1` |
| Error handler | `RfWfErrorHandler` |

### Feeding statements to Workflow A

Copy CSV or XLSX files into `%LOCALAPPDATA%\RightsFlowAI\n8n\inbox`. Name them
`<source_category>__<source name>__<YYYY-MM>[__<CURRENCY>].<csv|xlsx>`, for example
`distributor__Distro Inc__2026-09__USD.csv`. Legacy `.xls` files are rejected: save them as `.xlsx`.

`source_category` is one of `streaming`, `distributor`, `publishing_admin`, `pro`, `mechanical`,
`licensing` or `manual_adjustment`. Files with other names are rejected and listed in the run
summary.

Re-running the workflow is safe: files that were already imported are recognized as duplicates,
and a rejected file raises one review task only. Every file's outcome is listed in **Settings →
Automation → Inbox files**. Remove files from the inbox once you're done with them.

Statements uploaded in the app are processed by automation only **after a person confirms the
column mapping** in the app.

## 6. Activate the schedules

Imported workflows are **inactive**. Activate them only once you have confirmed that this
instance is connected to the right organization:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\show-n8n-config.ps1        # note the organization id
powershell -ExecutionPolicy Bypass -File scripts\activate-n8n-workflows.ps1 -OrganizationId <id> -Confirm
```

The activation script refuses to run when:
- there is no recorded connection (run the setup first);
- `-OrganizationId` doesn't match the connected organization, or `-Confirm` is missing;
- the connection is a test connection or an `n8n E2E …` organization (unless
  `-AllowTestOrganization`, for test instances only);
- the stored key is rejected, bound to another instance, or expires within 3 days.

It publishes the five business workflows and restarts n8n so the schedules register. To stop all
schedules: `scripts\activate-n8n-workflows.ps1 -Deactivate`. `-Workflows <id>,<id>` limits
either action to some workflows.

Keep the **error handler** workflow present and published, because the other workflows point to it
as their error workflow.

## 7. View executions and logs

| What | Where |
|---|---|
| n8n executions | Editor → **Executions** (kept 14 days, at most 10,000) |
| n8n log file | `%LOCALAPPDATA%\RightsFlowAI\n8n\logs\n8n.log` |
| RightsFlow run history | **Settings → Automation → Recent runs**, or `GET /api/v1/organizations/{id}/automation/runs` |
| Health | `powershell -ExecutionPolicy Bypass -File scripts\check-n8n.ps1` |

## 8. Stop

```powershell
powershell -ExecutionPolicy Bypass -File scripts\stop-n8n.ps1
```

This only stops the process recorded in `n8n.pid`, and only if it is this n8n runtime.

To stop everything `start-local-automation.ps1` started (FastAPI, Next.js and n8n):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\stop-local-automation.ps1   # -KeepN8n to leave n8n running
```

It only stops processes recorded in its pid files whose command line is still the expected one
(`uvicorn app.main:app` / `npm run dev`). Servers you started yourself are left alone.

## 9. Back up and restore

Stop n8n first so the SQLite file is consistent:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\stop-n8n.ps1
$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
Compress-Archive -Path "$env:LOCALAPPDATA\RightsFlowAI\n8n\data", "$env:LOCALAPPDATA\RightsFlowAI\n8n\secrets" `
  -DestinationPath "$env:USERPROFILE\Documents\rightsflow-n8n-backup-$stamp.zip"
```

The archive contains the encryption key and the API key: store it like a password.

To restore, stop n8n and extract both folders back to `%LOCALAPPDATA%\RightsFlowAI\n8n\`. The
`data` folder is useless without the matching `secrets\n8n.env`.

To restore only the workflow configuration, re-run `scripts\setup-n8n-automation.ps1`. The
workflow definitions in the repository are the source of truth, regenerated by
`automation\n8n\build_workflows.py`.

To export what is currently in n8n (for example after editing in the editor):

```powershell
. .\scripts\n8n-common.ps1
Invoke-N8nCli export:workflow --all --separate --output="$env:USERPROFILE\Documents\n8n-export"
```

Exported credentials stay encrypted unless you add `--decrypted`; don't commit decrypted exports.

## 10. Tests

Quick smoke test (workflow lint, environment check, backend automation tests):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\test-n8n-smoke.ps1          # add -Live for the live test
```

Live end-to-end test:

```powershell
backend\.venv\Scripts\python.exe scripts\n8n_live_test.py
```

The live test:
- runs in the separate **test instance** (`%LOCALAPPDATA%\RightsFlowAI\n8n-test`, port 5688). It
  never touches the operational instance; it checks that the operational credential, key file,
  connection and active workflows are unchanged at the end;
- creates throwaway `n8n E2E …` organizations through the API (existing data is untouched);
- runs every workflow, including re-runs, a crashed worker, an API outage, retries, the mapping
  confirmation gate, key-expiry warning → alert → suppression → recovery, and server-mode
  schedules and error handling;
- revokes its keys and archives its organizations at the end;
- writes `automation\n8n\test-results\live-<timestamp>.json`.

**It refuses to run when `backend\.env` configures real email (`EMAIL_PROVIDER` other than
`console`) or a real AI provider**, because the test registers users and triggers notifications.
In that case, start a second local API for the test with console email and no AI, and point the
test at it:

```powershell
cd backend
$env:EMAIL_PROVIDER = 'console'; $env:AI_PROVIDER = 'none'; $env:RUN_EMBEDDED_WORKER = 'true'
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8001
# in another PowerShell window, from the repository root:
$env:RIGHTSFLOW_API_URL = 'http://127.0.0.1:8001'; $env:RIGHTSFLOW_LIVE_TEST_SAFE_API = '1'
backend\.venv\Scripts\python.exe scripts\n8n_live_test.py
```

Background jobs live in the shared database: while your own API on port 8000 (with real SMTP) is
also running, its worker can pick up the test's jobs, and notifications created by those jobs
would use real SMTP. Stop the port 8000 API for the duration of the test. Alternatively, pass
`--allow-real-providers` if you authorize real delivery. See
[N8N_TEST_RESULTS.md](N8N_TEST_RESULTS.md).
