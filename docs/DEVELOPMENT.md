# Development Guide

## Environment

| Tool | Version |
|---|---|
| Python | 3.13 (venv at `backend/.venv`) |
| Node.js | 24 (npm 11) |
| MariaDB | 10.4.32, run through XAMPP |

Configuration lives in `backend/.env` (template: `backend/.env.example`) and `frontend/.env.local` (template: `frontend/.env.example`). Never commit real `.env` files; `.gitignore` excludes them.

## Database and migrations

Run Alembic from the **repository root**. `alembic.ini` points at `backend/alembic`, and `env.py` reads `DATABASE_URL` from the backend settings.

```powershell
backend\.venv\Scripts\alembic.exe current          # show current revision
backend\.venv\Scripts\alembic.exe upgrade head     # apply migrations
backend\.venv\Scripts\alembic.exe history
```

### Revision history

| Revision | Description |
|---|---|
| `a0d0d862a93d` | organizations |
| `f9c67edab705` | users |
| `1682ed44a5f2` | organization_memberships |
| `ff292c7fb808` | Full SaaS domain schema: 38 new tables; new nullable or defaulted columns on `users` and `organizations` |
| `010ae74ee6d8` | `users.notification_preferences`, `stored_files.deleted_at/purged_at`, nullable `background_jobs.organization_id` (platform jobs) |
| `cbc38defc8d1` | Pre-launch audit hardening: RESTRICT foreign keys on financial history, unique keys, indexes, `content_sha256`, DATETIME(6) ledger timestamps |
| `1195060a8593` | n8n automation: `integration_credentials`, `automation_events/runs/idempotency_keys/deliveries/review_tasks`, `users.is_service_account` (additive) |

`ff292c7fb808` is **purely additive**. It drops nothing and changes no existing column.

### Creating a new migration

1. Edit the models in `backend/app/models/`. Every module must be imported by `app/models/__init__.py`.
2. Run `backend\.venv\Scripts\alembic.exe revision --autogenerate -m "describe change"`.
3. **Review the file.** Name every constraint. MariaDB can't drop an index that backs a foreign key, so write downgrades that drop whole tables in reverse dependency order.
4. Rehearse the migration on a scratch database:

   ```powershell
   backend\.venv\Scripts\alembic.exe -x db_url=mysql+pymysql://root@127.0.0.1:3306/rightsflow_ai_test upgrade head
   ```

   Then run downgrade and upgrade again on that database.
5. Back up the development database before upgrading it:

   ```powershell
   C:\xampp\mysql\bin\mysqldump.exe -u root --single-transaction rightsflow_ai > backup.sql
   ```

### Rollback considerations

- MariaDB DDL is not transactional. If a migration fails halfway, the schema can be left partially applied. Restore from the backup rather than retrying blindly.
- Downgrading `ff292c7fb808` drops every domain table and **destroys** catalog, rights, royalty and ledger data. Only do it on a restored copy, or with a fresh backup.

Pre-migration backups of the development database are in `backend/storage/backups/` (`rightsflow_ai_pre_ff292c7fb808.sql`, `rightsflow_ai_pre_010ae74ee6d8.sql`).

## Running the services

```powershell
# API with auto-reload. The embedded worker processes jobs.
cd backend
.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000

# Optional standalone worker. Set RUN_EMBEDDED_WORKER=false for the API first.
.venv\Scripts\python.exe -m app.worker
.venv\Scripts\python.exe -m app.worker --once      # drain the queue and exit

# Frontend
cd frontend
npm run dev
```

## Testing

### Backend

The backend suite is about 190 tests. It runs against `TEST_DATABASE_URL`, which defaults to the development database name with a `_test` suffix and is created automatically. The schema is recreated for each test session, and tables are emptied after each test. A guard refuses to run against any database whose name doesn't end in `_test`.

```powershell
cd backend
.venv\Scripts\python.exe -m pytest                       # everything
.venv\Scripts\python.exe -m pytest tests\test_royalties.py -x
$env:API_MODULES="auth,organizations,catalog"            # optional: mount only these routers
```

### Frontend

Vitest and Testing Library run under jsdom:

```powershell
cd frontend
npm run test
npm run typecheck
npm run lint
```

### End-to-end tests

The Playwright suite in `frontend/e2e` covers these journeys:

- auth and onboarding
- sign-out and sign-in with `next`
- the full statement import → map → process → calculate → post-to-ledger flow, checked against exact balances
- tenant isolation in the browser

It uses the locally installed Chrome, and reuses or starts the dev server. The backend must be running on port 8000. Each run registers throwaway `e2e-*@example.com` users with their own organizations in the configured database.

```powershell
cd frontend
npm run test:e2e
```

### API types

After backend API changes, regenerate the frontend types and the API docs while the backend is running:

```powershell
cd frontend
npm run gen:api                                          # regenerates src/lib/api/schema.d.ts
cd ..
backend\.venv\Scripts\python.exe scripts\export_openapi.py   # regenerates docs/API.md and docs/openapi.json
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `JWT_SECRET_KEY must contain at least 32 characters` | Set a long random secret in `backend/.env`. |
| A test DB session doesn't see rows written by the API | InnoDB REPEATABLE READ: call `db.rollback()` before re-querying. |
| A job stays `queued` | Check that the embedded worker is enabled, or run `python -m app.worker --once`. |
| `ai_not_configured` (503) | Expected without `AI_PROVIDER` and `AI_API_KEY`. The deterministic features still work. |
| `ai_configuration_error` (502): "The AI API key needs a workspace" | The Anthropic key isn't scoped to a workspace, so every request must name one. Set `AI_WORKSPACE_ID=wrkspc_…` in `backend/.env` (Claude Console → Settings → Workspaces, **ID** column), or create a key scoped to one workspace. Restart the API, then use **Test connection** on the AI page. |
| `ai_auth_failed` / `ai_permission_denied` / `ai_model_unavailable` / `ai_billing` (502) | Key rejected, key not allowed, `AI_MODEL` not available to the account, or a billing problem on the provider account. The provider's exact reason and request id are in the API log (`AI provider returned HTTP …`). These are never retried automatically. |
| AI page says "Configured · not yet verified" | Settings are present, but no AI request has succeeded yet. An admin can click **Test connection**; it sends one minimal request, which counts as one AI request. |
| Emails not arriving | The console provider never sends. Look in `backend/storage/dev-outbox/`. |
| You were signed out after token reuse | Refresh tokens are single-use. Parallel refreshes from outside the BFF trigger reuse detection by design. |
