# n8n Integration: Security

## Guarantees

| Requirement | How it is met | Verified by |
|---|---|---|
| Dedicated automation credentials, not human tokens | `integration_credentials` keys (`rfa_...`). Human JWTs are rejected on `/automation/*`, and keys are rejected on the JWT API. | `test_authentication_failures`, live test |
| Secure generation and storage | 64-bit public key id and 256-bit secret from `secrets`. The database stores only `HMAC-SHA256(pepper, key_id:secret)` (pepper = `AUTOMATION_KEY_PEPPER`, or `JWT_SECRET_KEY` if unset). The token is shown once. | `test_only_admins_manage_credentials_and_the_secret_is_shown_once` |
| Least privilege | 9 scopes (`automation:read`, `runs:write`, `events:consume`, `statements:import`, `statements:review`, `contracts:read`, `notifications:send`, `reports:deliver`, `ai:review`). The context is a manager-level role, and no route posts runs, reverses, approves or pays payouts, or edits shares. | `test_scopes_are_enforced`, `test_automation_has_no_route_to_post_reverse_or_pay` |
| Organization scoping | The organization comes from the key, never from the request. Every query filters by it, and another tenant's ids return 404. | `test_credential_for_org_a_cannot_touch_org_b`, live test (two organizations) |
| Expiry, revocation and rotation | Lifetime is 1–365 days (default 90). Revocation is immediate. Rotation has a 0–168 h grace period. Health warns 14 days before expiry. | `test_revoked_and_expired_credentials_are_rejected`, `test_rotation_keeps_old_key_for_the_grace_period_only` |
| Authentication failure logging | Each failure is audited as `automation.auth_failed` with a reason and the key id, never the secret. Scope denials are audited as `automation.scope_denied`. | `test_authentication_failures` |
| Brute-force and abuse limits | 20 failed authentications per IP per 5 minutes (then 429). 600 requests per minute per key (`AUTOMATION_RATE_LIMIT_PER_MINUTE`). | code review (in-process limiter, see limitations) |
| Replay protection | `Idempotency-Key` on all mutating calls, with stored responses and request-hash checks. Event acknowledgements need the current lease token, so a stale worker's acknowledgement gets 409 `lease_lost`. | `test_idempotency_*`, `test_outbox_*`, `test_review_acknowledges_its_event_and_refuses_a_lost_lease` |
| Secret redaction | `rfa_…` keys, `Bearer …` tokens and email-link tokens are stripped from stored error messages, run summaries and event errors. | `test_expired_lease_is_reclaimed_and_poison_events_go_dead`, `test_runs_track_executions_and_dedupe_by_business_key` |
| Service account isolation | It cannot sign in, refresh or use reset/verify links; JWTs are rejected for it; it receives no notifications; it holds no membership or seat. | `test_service_account_cannot_sign_in_and_holds_no_seat` |
| Financial safety | Automation can calculate only a *draft* run. Missing or ambiguous contract terms, disputed ownership and so on stay **held** (unallocated). Nothing is posted and the ledger is untouched. | `test_missing_contract_terms_are_held_for_review_not_paid`, `test_statement_workflow_...`, live test |
| AI safety | AI output is validated against the structured schema and per-field rules, then stored as **pending** suggestions or advisory review notes. Only a person's approval in the app applies a change, through the existing validated service. Malformed output is rejected. | `test_ai_suggestions_are_pending_until_a_human_decides`, `test_malformed_ai_output_is_rejected`, `test_conflict_review_is_advisory` (mocked provider) |
| Report confidentiality | Only active admins and owners can receive monthly report notices, and a named recipient must be one. Messages contain a link, never figures. | `test_monthly_report_is_generated_once_and_sent_to_admins_only` |

## Local secret handling (Windows)

| Secret | Location | Protection |
|---|---|---|
| `N8N_ENCRYPTION_KEY` | `%LOCALAPPDATA%\RightsFlowAI\n8n\secrets\n8n.env` | Generated once (256 bits). The ACL is restricted to the current user. Loaded into the n8n *process* environment only. |
| Automation key | `...\secrets\automation-key.txt` and the n8n credential "RightsFlow automation key" | User-only ACL. n8n encrypts credentials with the encryption key. Workflow exports reference the credential by id and name only. |
| Workflow JSON (`automation/n8n/workflows`) | Repository | Contains **no secrets**. `__RIGHTSFLOW_API_URL__` and `__RIGHTSFLOW_INBOX__` placeholders are filled in at import. |

**Back up the `secrets` folder together with `data`.** Without the encryption key, the stored n8n
credentials can't be decrypted.

## Network exposure

- n8n listens on `127.0.0.1:5678` only (`N8N_LISTEN_ADDRESS`). There are no webhooks or tunnel,
  and nothing is reachable from the network.
- n8n pulls from the API, so no inbound path into n8n is needed.
- `N8N_BLOCK_ENV_ACCESS_IN_NODE=true`: workflows can't read the process environment, which holds
  the encryption key.
- File access for the inbox node is restricted to the inbox folder (`N8N_RESTRICT_FILE_ACCESS_TO`).
- Diagnostics, version notifications and personalization telemetry are disabled.

## Limitations and residual risks

- The **rate limiter is in-process** (the same limiter as the rest of the API). With several API
  replicas, the limits apply per replica.
- **n8n execution data** (14 days) can show statuses, ids and counts. It doesn't hold amounts or
  document text, but anyone with n8n editor access can see run history and *use* the stored
  credential within its scopes. Protect the n8n owner account with a strong password.
- An n8n user who can edit workflows can call any endpoint the key's scopes allow. Use narrower
  scopes for keys in less-trusted setups.
- `AUTOMATION_KEY_PEPPER` defaults to `JWT_SECRET_KEY`. Rotating the JWT secret invalidates all
  automation keys; set a dedicated pepper in production to decouple them.
- The npm installation of n8n is meant for local development and testing (n8n's documentation
  says so); npm installs are deprecated from n8n 3.0.
