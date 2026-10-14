# Final Pre-Launch Audit Report: RightsFlow AI

**Date:** 2026-10-14
**Scope:** the whole repository: FastAPI backend, Next.js BFF and frontend, MariaDB schema and migrations, royalty and ledger logic, AI features, file handling, tests.

**Verdict:** the code is ready for a controlled beta or staging deployment. It is **not ready for a public production launch yet**. No known critical or high-severity code defects remain open. What blocks launch is operational: production configuration, real provider integrations that have never been exercised, and the single-instance limits listed under [Deployment blockers](#deployment-blockers).

## Method

1. Six independent read-only reviewers each covered one area:
   - security and sessions
   - tenant isolation (BOLA)
   - royalty and ledger arithmetic
   - database integrity and concurrency
   - AI, uploads and robustness
   - frontend UX and accessibility
2. Reviewers worked against the running local stack where possible. Each produced findings with a file and line and, where possible, a reproduction.
3. Before any fix, every finding was re-checked against the code. Findings that did not hold up were dropped. Gaps in the numbering are IDs that were never issued, or that were merged into another finding (F-H3 is the same issue as D-01).
4. Each fix got a regression test where one was practical. Fixes without a dedicated test are marked in the tables.
5. After the fixes, the full verification pass described in [Tests performed](#tests-performed) was run.

Areas the reviewers checked and found sound:
- Organization-level tenant scoping (no BOLA found).
- JWT validation.
- Refresh-token rotation and reuse detection.
- The CSRF double-submit check and Origin check.
- API paths matching the OpenAPI schema.
- No `dangerouslySetInnerHTML` or other XSS sinks.

**Severity scale:**
- **Critical:** a data breach or loss of money that needs no special conditions.
- **High:** cross-user or tenant compromise, or corrupted financial records.
- **Medium:** integrity or availability problems under realistic conditions.
- **Low:** defence in depth, edge cases, UX and accessibility.

No finding was rated critical.

## Issues discovered and fixes applied

**Status values:**
- ✅ fixed, with a regression test
- ✅* fixed and verified by the full suite or a manual check, but no dedicated test
- 📝 accepted risk, documented

### Security and authentication

| ID | Sev | Issue | Fix | Status |
|---|---|---|---|---|
| A-01 | H | An unverified account registered with an invitee's email could list and accept that invitation by id. The email was then marked verified. | `/invitations/mine` and accept/decline by id now require a verified email. Only the emailed token path marks the email verified. | ✅ `test_audit_regressions.py` |
| A-02 | H | The BFF forwarded the client's `X-Forwarded-For`, which bypassed every per-IP rate limit and forged audit IPs. | Added `trustedClientIp()`, which takes only the hop appended by trusted proxies (`TRUSTED_PROXY_HOPS`, default 0). The API port is no longer published in docker-compose. | ✅ `client-ip.test.ts` |
| A-03 | M | The placeholder JWT secret from `.env.example` was accepted in production. | A Settings validator rejects placeholder or low-entropy secrets in staging and production. | ✅ |
| A-04 | M | `POST /organizations/{id}/members` added any registered email directly, which let admins enumerate accounts and enrol users without consent. | Endpoint removed. Members join only through invitations; the test helper now uses the real token flow. | ✅ |
| A-05 | L | Forgot-password took longer for known emails than for unknown ones. | Responses are padded to a fixed minimum time. | ✅ |
| A-05b | L | Registration returns 409 for an existing email, which enables enumeration. | Not changed: it is a deliberate UX choice and is rate limited. | 📝 |
| A-06 | L | Reset, verify and invite tokens were stored in plain text in `email_messages.body_text`. | Tokens are redacted before storage. | ✅ |
| A-07 | L | Password confirmation on archive and ownership transfer was not rate limited, so it could be used to guess passwords. | Limited to 5 attempts per 15 minutes per user. | ✅ |
| A-08 | L | Failed logins locked the victim's account from every IP, and per-email limits were also applied to the whole IP. | Limits are now keyed on (email, IP), with a separate looser per-account ceiling. Per-key limits no longer cap the IP bucket. | ✅ |
| A-09 | L | The BFF cached refresh results for 30 s, so a replayed rotated token could obtain new tokens. | TTL reduced to 5 s. | ✅* |
| A-10 | L | The frontend sent no HSTS header, and `/docs` and `/openapi.json` were served in production. | HSTS is sent whenever the site is served over HTTPS. Docs are disabled when `APP_ENV=production`. | ✅ (docs flag) / ✅* (HSTS) |
| A-11 | L | Users removed from an organization still received its job notifications. | `notify_user` skips non-members, except for invitations. | ✅ |

### Database and concurrency

| ID | Sev | Issue | Fix | Status |
|---|---|---|---|---|
| D-01 | H | Reprocessing a statement after a reversal deleted the reversed run's allocations through an FK CASCADE. | Statements with posted or reversed history refuse reprocessing (409 `statement_has_history`). Allocation FKs are now RESTRICT (migration). | ✅ |
| D-02 / F-N1 | H | The import job and `post()` could interleave, the two paths locked rows in different orders, and the identity map could return a stale run. | Consistent lock order (statement before run), `populate_existing`, and posting only from `calculated`. | ✅* (existing suite; no concurrency test) |
| D-03 | M | MariaDB ran in non-strict `sql_mode`, so oversized values were silently truncated or clamped. | Strict `sql_mode`, UTC time zone and READ COMMITTED set on every connection. | ✅ |
| D-04 | M | Balance checks could read stale data, and payee rows were not locked on approve, mark-paid or reverse. | READ COMMITTED isolation and payee row locks. | ✅* |
| D-05 | M | Blocking split-rule checks were not concurrency-safe. | Every share write locks its asset row first (`get_share_for_write`, `get_asset(lock=True)`). | ✅ `test_audit_concurrency.py` |
| D-06 | M | Stale-job recovery re-ran jobs that were still running, and job completion was not guarded by the owning worker. | Heartbeat via `updated_at`; completion is conditional on the owner; exhausted jobs fail. | ✅ |
| D-07 | M | Deleting a contract term silently cleared the term link on posted allocations. | 409 `term_in_use` / `contract_in_use`; RESTRICT foreign keys. | ✅ |
| D-08 | L | Allocation `work_id` and `recording_id` had no FK or index. | FKs and indexes added (migration). | ✅ |
| D-09 | L | Nothing stopped an organization getting two subscriptions, and lazy creation could race. | Unique key added; creation runs in a savepoint, and the loser of the race re-reads. | ✅ |
| D-10 | L | `uq_contract_asset` never fired because of NULLs, and duplicate split rules were possible. | NULL-safe unique keys. Split-rule creation is serialized on the organization row. | ✅ (assets) / ✅* (rules) |
| D-12 | L | Parties referenced only by split sheets could be deleted. | Deletion checks split-sheet entries. | ✅ |
| D-13 | L | Indexes were missing for notifications, unmatched lines and the email log. | Added (migration). | ✅ |
| D-14 | L | Integrity errors and deadlocks returned 500. | Integrity errors return 409, data errors 422, lock timeouts and deadlocks 409, and other database errors 503. | ✅* |
| D-15 | L | Hard-deleting an organization would cascade into audit and financial tables. | No API path performs a hard delete; organizations are only archived. | 📝 |

### Music rights and royalties

| ID | Sev | Issue | Fix | Status |
|---|---|---|---|---|
| F-H1 | H | A contract-linked share with no applicable term (outside its dates, a draft contract, or excluded by filters) paid 100% to the payee. | Such lines are held as `no_applicable_contract_term`; ambiguous terms are held too. | ✅ |
| F-H2 | H | European decimals were mis-parsed: `0,004` became 4 and `1.234` became 1.234. Letters were silently stripped from amounts. | The decimal separator and date order are detected once per column. Invalid amounts become row errors. | ✅ |
| F-H4 | H | Deleting a contract that had posted royalties rewrote history and made future royalties pay 100%. | 409 when posted or reversed allocations reference it; RESTRICT foreign keys. | ✅ |
| F-H5 | H | Duplicate statements were detected only by exact bytes, so a CRLF or BOM variant could be re-imported; manual statements were not checked at all. | Content fingerprint for files, a fingerprint for manual statements, and an explicit `allow_duplicate` override. | ✅ |
| F-M1 | M | `YYYYMM` dates for November and December parsed as January, and day/month order was chosen row by row. | Date order is detected per column; `YYYYMM` is parsed correctly. | ✅ |
| F-M3 | M | `statement.total_amount` summed lines across currencies. | Only lines in the statement's currency are summed. | ✅ |
| F-M4 | M | Remittance advice used the wrong window: later payouts emptied it, and same-second timestamps were ambiguous. | The window is anchored on the payout's own ledger entry; `ledger_entries.created_at` now has microsecond precision (migration). | ✅ |
| F-M5 | M | Merging works or recordings duplicated shares (200% ownership) and bypassed split rules. | Identical shares are superseded instead of copied, blocking rules are enforced, and party merges queue a conflict rescan. | ✅ |
| F-M6 | M | Gross-basis terms paid royalties on refunds when gross and net had opposite signs, and the default basis was gross. | Sign mismatches are held; the default basis is now net (backend and form). | ✅ |
| F-M7 | M | An out-of-range quantity (`1e30`) crashed the whole import. | It becomes a row warning. | ✅ |
| F-M8 | M | CSV formula neutralization turned negative amounts into text (`'-12.50`). | Plain numbers are left alone; formulas are still prefixed. | ✅ |
| F-L1 | L | Lifetime earnings included reversed earnings. | Reversals count against the type of the entry they reverse. | ✅ |
| F-L2 | L | When contract terms were equally specific, one was chosen silently by id order. | Held as `ambiguous_contract_terms`. | ✅ |
| F-L3 | L | Approve and mark-paid ignored holds or deactivations set after the batch was drafted. | 409 `payee_not_payable`. | ✅ |
| F-L5 | L | Report totals were computed after the rows were truncated. | Totals cover all rows; the response includes `row_count` and `truncated`, and the UI explains the truncation. | ✅ |
| F-L6 | L | Payout rounding ignored currency minor units (JPY, KRW, KWD). | ISO 4217 minor units are applied when amounts are created and edited. | ✅ |
| F-X1 | M | The allocation conservation check (payable + retained + unallocated = input) was a bare `assert`, which `python -O` removes. Found by bandit. | Replaced with an explicit 409 `calculation_not_reconciled` and an error log. | ✅* (suite) |

### AI, uploads and robustness

| ID | Sev | Issue | Fix | Status |
|---|---|---|---|---|
| AF-01 | H | A ~1.5 KB XLSX upload blocked the event loop for minutes. | Parsing runs in the threadpool, and sheets are bounded (`reset_dimensions`, `max_col`, a cap on blank rows). | ✅* |
| AF-02 | H | XLSX amplification and decompression bombs could exhaust memory. | `file_safety.check_office_archive` checks member count, total uncompressed size and compression ratio. | ✅ |
| AF-03 | M | The DOCX DTD/entity guard could be bypassed with UTF-16. | Parsed with `defusedxml` (DTDs and entities forbidden). `defusedxml==0.7.1` is now pinned. | ✅ |
| AF-04 | M | PDF extraction had no CPU budget. | 20 s budget and a 200-page cap. | ✅* |
| AF-05 | M | Poison-pill jobs were retried forever after a worker crash. | Attempts are capped at claim time and exhausted jobs fail. | ✅ |
| AF-06 | M | Cancelling an import or analysis through the generic Jobs API stranded its record. | 409 `cancel_from_owner`; the owning domain handles cancellation. | ✅ |
| AF-07 | M | Concurrent requests could exceed the monthly AI limit, and cost was under-counted. | Usage is reserved under a subscription row lock; refusals and truncated responses are billed. | ✅ |
| AF-08 | L/M | An outage or malformed response from the OpenAI-compatible provider returned 500. | Mapped to 502, with a usage row recorded. | ✅ |
| AF-09 | M | Downloads with non-Latin-1 filenames returned 500. | RFC 5987 `filename*` header. | ✅ |
| AF-10/11/12 | L | NaN or Infinity totals, CSV fields over 128 KB and boundary dates returned 500. | They now return 422 or row errors. | ✅ |
| AF-13 | L | The prompt-injection fence could be imitated (look-alike or zero-width tags). | Random per-call tag names, NFKC normalization, and zero-width/bidi characters stripped. Literal bidi characters in the source were replaced with escapes (bandit B613). | ✅ (`test_ai.py`) |
| AF-14 | L | Files downloaded through the BFF lost `nosniff` and `CSP: sandbox`. | Every proxied response is now `nosniff` and sandboxed. | ✅ `proxy-headers.test.ts` |
| AF-15 | L | 500 responses lost the request id and security headers. | The 500 is built inside `RequestContextMiddleware`. | ✅ |

### Frontend UX and accessibility

| ID | Sev | Issue | Fix | Status |
|---|---|---|---|---|
| UI-01 | H | The invitation notification link went to a 404 page. | The link now points to `/onboarding`, and `/invitations` redirects there for older notifications. | ✅* (E2E covers invitations) |
| UI-02 | H | Notifications from another organization opened in the active organization. | `useOpenNotification` switches organization first; user-scoped pages are exempt. | ✅* |
| UI-03 | M | Horizontal page scroll on mobile and tablet. | `grid-cols-1`, `min-w-0` and a `relative` scroll container. | ✅* |
| UI-04 | M | Focus landed on `<body>` when any dialog closed. | `useRestoreFocus` in `DialogContent` and in the raw Radix dialogs. | ✅ `dialog.test.tsx` |
| UI-05 | M | Dashboard KPI links hid the amounts from screen readers. | The `aria-label` override was removed; the action is added as screen-reader-only text. | ✅* |
| UI-06 | M | Tab triggers pointed to panels that did not exist (axe critical). | Replaced with a shared `SegmentedControl` (buttons with `aria-pressed`). | ✅ |
| UI-07 | M | Long forms had no unsaved-changes warning. | `useUnsavedChangesWarning` (on `beforeunload` and in-app link clicks), wired into the catalog, contract, manual statement and splits forms. | ✅ |
| UI-08 | L | Onboarding silently hid invitations from unverified users. | A verify-email banner is shown and the 403 query is skipped. | ✅* |
| UI-09 | L | Accessible names did not include the visible text. | Fixed for the avatar initials, the organization switcher and the catalog picker. | ✅* |
| UI-10 | L | Scrollable tables could not be reached by keyboard. | `ScrollRegion` is focusable and named when its content overflows. | ✅ |
| UI-11 | L | Headings skipped levels and the not-found page had no `<main>`. | Heading level is a prop, an `h1` was added, and the pages are wrapped in `<main>`. | ✅* |
| UI-12 | L | Detail pages showed the wrong message for not-found and server errors. | `detailLoadFailure()` separates a 404 from other errors in four detail views and the catalog. | ✅ |

## Tests performed

Final pass on 2026-10-14. The results below are the actual output of these runs.

| Check | Result |
|---|---|
| Backend `pytest` (full suite, MariaDB `_test` database) | **254 passed** (21 files, 4 min 54 s) |
| New regression test files | `test_audit_regressions.py`, `test_audit_financial.py`, `test_audit_concurrency.py`, and additions to `test_royalties.py`, `test_royalty_engine.py` and `test_session2_domain.py` |
| Frontend `tsc --noEmit` | 0 errors |
| ESLint | 0 problems |
| Vitest | **221 passed** (34 files) |
| `next build` (production) | Success |
| Playwright E2E (Chrome; dev server plus a reloaded API) | **8 passed** |
| `alembic check` on the dev DB after the upgrade | "No new upgrade operations detected"; head `cbc38defc8d1` |
| Migration rehearsal on scratch DB `rightsflow_migcheck_test` | upgrade → downgrade -1 → upgrade → check, all exit 0 |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `pip-audit -r requirements.txt --no-deps` | No known vulnerabilities |
| `pip-audit` of the installed venv | Only `pip 25.2` (12 advisories) is affected. It is installer tooling, not a runtime dependency; the Dockerfile now upgrades pip before installing. |
| `bandit -r app` | Before fixes: 1 high (B613: literal bidi characters, fixed) and 12 low. The low findings were reviewed: one meaningful `assert` was fixed (F-X1). The rest are type-narrowing asserts, an explicit `ElementTree` import used only for types and errors (parsing goes through `defusedxml`), and an OAuth `token_type="bearer"` false positive. |
| Secret scan (`sk-ant`, `sk_live`, AWS keys, private keys, GitHub/Slack tokens) | None found in source. `.env` files are excluded from the Docker build contexts. |

**Dev database migration:**
1. Backed up to `backend/storage/backups/rightsflow_ai_pre_cbc38defc8d1.sql`. The dump completed and ends with the "Dump completed" footer.
2. Data preconditions re-checked: 0 duplicate subscriptions, 0 duplicate contract assets, 0 orphaned allocation references.
3. Upgraded from `010ae74ee6d8` to `cbc38defc8d1`. No data was deleted; existing users and organizations are intact.

**Not tested:**
- Real Anthropic or OpenAI calls (a fake provider is used).
- SMTP delivery, S3 storage and Stripe (no credentials).
- Docker image build.
- Load and performance testing.
- Multi-replica behaviour.
- A browser accessibility re-scan with axe after the UI fixes. The UI fixes are covered by unit tests, tsc, lint, build and E2E, not by a fresh axe run.

## Remaining risks

1. **Single-instance assumptions.** The rate limiter and the BFF refresh single-flight both live in process memory. With more than one replica, limits multiply and parallel refreshes can revoke sessions. Moving them to Redis, or running a single instance with sticky sessions, is required before scaling out.
2. **Unexercised integrations.** AI, SMTP, S3 and Stripe have only run against fakes or the console provider. Production behaviour (timeouts, errors, webhook signatures under load) is unverified.
3. **Some fixes have no dedicated regression test** (marked ✅* above). These include:
   - the lock-ordering fixes (D-02/F-N1, D-10), which have no concurrency test;
   - the AF-01 threadpool change and the AF-04 PDF budget;
   - A-09 (refresh TTL) and the HSTS header.
4. **Accepted product risks:**
   - Registration reveals whether an email is already registered (A-05b).
   - The unsaved-changes guard does not cover the browser Back button.
   - Focus restore falls back to the Radix default when a dialog is opened from a dropdown menu item.
   - Hard-deleting an organization cascades into audit and financial tables (D-15). No API path does this, but a manual SQL delete would destroy financial history.
5. **AI output is advisory.** Prompt fencing reduces prompt injection but cannot eliminate it. AI suggestions are re-validated server-side and never post money, but users may still act on misleading summaries.
6. **Rights-conflict and royalty correctness depend on data quality.** The engine now holds ambiguous or uncovered lines rather than guessing, so operators must work the hold and unmatched queues.

## Deployment blockers

These must be done before a public production launch. None of them needs a code change unless noted.

1. **Production secrets:**
   - Generate a strong `JWT_SECRET_KEY`; the new validator refuses to start staging or production with a weak one.
   - Set `APP_ENV=production`, the CORS origins and `FRONTEND_URL`.
2. **HTTPS and proxies:**
   - Serve the site over TLS.
   - Set `COOKIE_SECURE=true` (or rely on `NODE_ENV=production`).
   - Set `TRUSTED_PROXY_HOPS` (frontend) and `TRUSTED_PROXY_COUNT` (backend) to match the actual proxy chain. Wrong values either disable per-IP limits or reopen IP spoofing.
3. **Email:** configure SMTP (`EMAIL_PROVIDER=smtp`). With the console provider, verification, reset and invitation emails are never delivered.
4. **Storage and backups:**
   - Configure S3 or a persistent volume for uploaded files.
   - Schedule database backups and test a restore.
5. **Topology:** run a single API and BFF instance (or sticky sessions) until the rate limiter and refresh coordination move to a shared store.
6. **Integrations:** test AI with a real key and spend limits, and test Stripe in test mode, before enabling either. Billing is manual-only at the moment. Live payments are not wired up and were not tested.
7. **Monitoring:** set `ERROR_MONITORING_DSN` (or an equivalent) and log shipping.
8. **Build and scan:** build the Docker images and run an image vulnerability scan; neither was done in this audit.

## Final launch readiness assessment

| Dimension | Assessment |
|---|---|
| Tenant isolation and authorization | **Good.** No BOLA found, and a route-level security sweep is part of the backend test suite. Invitation takeover and direct-add enrolment were fixed. |
| Authentication and sessions | **Good.** Rotation and reuse detection are in place, proxy-aware IP limits fixed spoofing, and production refuses weak secrets. |
| Financial integrity (royalties, ledger, payouts) | **Good.** History is protected by RESTRICT foreign keys and refusal paths, ambiguous cases are held instead of paid, conservation is checked explicitly, and payouts respect currency minor units. |
| Data integrity and concurrency | **Adequate.** Strict SQL mode, READ COMMITTED isolation, consistent lock ordering and the missing constraints are now in place, but there are no concurrency stress tests. |
| File and AI robustness | **Good.** Bomb, entity and CPU limits are in place, and inputs that used to cause 500s now get 4xx responses. |
| Frontend UX and accessibility | **Good.** All audit findings are addressed; no fresh axe scan has been run. |
| Operations and scale | **Not ready.** Single-instance limits, unexercised integrations, and no load test or image scan. |

**Conclusion:** no critical issues were found. Every high and medium finding was fixed and verified by the test results above (backend suite, Vitest, build, E2E, migration rehearsal, dependency and static scans). RightsFlow AI is **ready for a staging or closed-beta deployment** with real but limited users, using manual billing and single-instance topology. It is **not yet ready for a public production launch** until the [deployment blockers](#deployment-blockers) are cleared, in particular production configuration and TLS, real email delivery, backups, and the integration and Docker checks.
