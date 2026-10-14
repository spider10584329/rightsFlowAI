# n8n Integration: Remaining Work

Updated 2026-10-14, after the audit-driven repair. Source:
[N8N_DEEP_AUDIT_REPORT.md](N8N_DEEP_AUDIT_REPORT.md). Its "Repair status" section has the status
and evidence for each finding (N8N-01 … N8N-19). This file lists only what is still open.

## Needs your action or authorization

| # | Work | Why it waits | How | Verification |
|---|---|---|---|---|
| 1 | Connect the operational n8n instance to your real organization (N8N-01) | Needs a key for your organization | Settings → Automation → Create key (admin), then `scripts\setup-n8n-automation.ps1 -Token $key`. The instance still holds a key of a throwaway test organization from before the repair; the new key replaces it (the old one is kept as `automation-key.previous.txt`). No connection was recorded yet, so `-AllowOrganizationChange` isn't needed. | `scripts\show-n8n-config.ps1` shows your organization, mode OPERATIONAL, key accepted and bound to this instance |
| 2 | Activate the schedules (N8N-01) | Activating for a real organization needs your explicit authorization | `scripts\activate-n8n-workflows.ps1 -OrganizationId <id> -Confirm` | Runs with `trigger_type = schedule` appear in Settings → Automation → Runs within each interval |
| 3 | Re-run the live test once against an API with console email and no AI (verifies R-2 live) | Your `backend\.env` configures the Anthropic provider. It also configured SMTP during live run 2; `EMAIL_PROVIDER` was commented out again at 22:30. The test refuses to run against real providers. | Second API on port 8001 with `EMAIL_PROVIDER=console` and `AI_PROVIDER=none`, with the port 8000 API stopped during the test. Steps in [N8N_WINDOWS_SETUP.md § 10](N8N_WINDOWS_SETUP.md#10-tests). | All checks pass, including "E. healthy again: incident resolved with a recovery notice" |
| 4 | Clean up leftovers from earlier test runs (N8N-16) | Changes shared data | Delete the two inactive "RF DIAG …" workflows in the operational n8n editor. Optionally revoke the remaining test keys and archive the `n8n E2E …` organizations from earlier runs. | Counts return to 0 |
| 5 | 17 test notification emails queued for SMTP retry (`email_messages.status = queued`, recipients `n8n-e2e-…@example.com` only) | Created by live run 2 after SMTP was configured mid-run; changing them needs your OK | Either leave them (they fail permanently after 5 attempts while SMTP authentication fails), or mark their `email_delivery` jobs failed before fixing SMTP credentials | No queued `email_delivery` jobs for `@example.com` recipients |
| 6 | Real email delivery (N8N-19) | SMTP authentication failed (535) in live run 2; `EMAIL_PROVIDER` is commented out at the moment (console) | Fix `SMTP_USERNAME`/`SMTP_PASSWORD` in `backend\.env`, then send a test to your own address | A reminder or alert email arrives |
| 7 | Real AI provider for workflow C (N8N-19) | The calls in live run 2 failed because the key isn't scoped to a workspace (HTTP 400, diagnosed later; see `docs/DEVELOPMENT.md` troubleshooting) | Set `AI_WORKSPACE_ID` in `backend\.env`, restart the API, use **Test connection** on the AI page, then run C manually on one subject | C records pending suggestions; approving one applies it |

## Accepted limitations (documented; no work planned)

| Finding | Limitation |
|---|---|
| N8N-09 | Inbox files are not moved after processing. Outcomes are recorded per file hash and re-runs are idempotent; remove files manually. |
| N8N-11 | n8n node retries are fixed-interval. Durable retries with backoff are in the API (outbox, statement states). |
| N8N-14 | n8n 2.43.5 logs one Python-runner warning per process start. The container and npm-install deprecation notices remain. Reassess before upgrading to n8n 3.x. |
| N8N-15 | Owner-setup spinner: reload the page. The root cause is unconfirmed. |
| N8N-17 | No webhook triggers; delivery is pull-based (15 and 30 minutes). |
| Frontend | The new admin endpoints (incidents, statements, inbox files, overview) have no response models in OpenAPI, so their frontend types are written by hand in `src/lib/api/hooks/automation.ts`. |

## Optional improvements

| # | Work | Benefit |
|---|---|---|
| 8 | Add Pydantic response models for the incidents, statements, inbox-files and overview endpoints, then regenerate `schema.d.ts` | Generated frontend types instead of hand-written ones |
| 9 | An authenticated localhost-only webhook trigger (N8N-17) | Real-time intake instead of polling |
| 10 | External task-runner mode for n8n | Removes the internal-mode deprecation; isolates Code node execution |

## Recommended order

1. Item 3, so the last fix is verified live.
2. Items 1 and 2, when you decide to connect your organization.
3. Items 5 and 6 together: decide about the queued test emails before fixing SMTP.
4. Item 7, then item 4.
