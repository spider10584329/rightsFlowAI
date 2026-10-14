# Deployment Guide

> This project has **not** been deployed anywhere. This guide describes how to deploy it once you are ready.

## Topology

| Component | Notes |
|---|---|
| `web` | Next.js server (`npm run build && npm run start`), port 3000. Reaches the API through `BACKEND_URL`. Only this component needs to be public. |
| `api` | FastAPI behind uvicorn, port 8000. Can be private: the browser talks to the BFF. |
| `worker` | `python -m app.worker`, at least one instance. Set `RUN_EMBEDDED_WORKER=false` on the API instances. |
| `db` | MariaDB 10.6+ or MySQL 8, with daily backups and point-in-time recovery. |
| Storage | An S3-compatible bucket (private; no public ACLs). Set `STORAGE_BACKEND=s3`. |
| Reverse proxy / load balancer | Terminates TLS, forwards to `web` (and `api` if it is exposed for integrations). |

`docker-compose.yml` runs this topology locally. Do **not** use it as-is in production; secrets come from env files you create:

```bash
cp backend/.env.example backend/.env.docker   # set JWT_SECRET_KEY, CORS_ORIGINS, FRONTEND_URL, ...
DB_PASSWORD=... DB_ROOT_PASSWORD=... docker compose up --build
```

## Production configuration checklist

**Backend environment**

- `APP_ENV=production`, `LOG_JSON=true`, `LOG_LEVEL=INFO`.
- `JWT_SECRET_KEY`: 48+ random bytes from a secrets manager. Rotating it signs everyone out.
- `DATABASE_URL`: a dedicated DB user with least privilege (DML, plus DDL only for the migration job).
- `CORS_ORIGINS` and `FRONTEND_URL`: the exact public HTTPS origins.
- `TRUSTED_PROXY_COUNT`: the number of proxies in front of the API. It is required for correct client IPs, which rate limiting and audit logs depend on.
- `REQUIRE_EMAIL_VERIFICATION=true` (recommended).
- `EMAIL_PROVIDER=smtp` plus the SMTP credentials.
- `STORAGE_BACKEND=s3` plus the bucket and credentials; install `requirements-optional.txt`.
- Optional: `AI_PROVIDER` / `AI_API_KEY`, `BILLING_PROVIDER=stripe` with `STRIPE_*` keys and plan price ids, `ERROR_MONITORING_DSN`.

**Frontend environment**

- `BACKEND_URL` (internal URL of the API).
- `NODE_ENV=production`. Cookies are then marked `Secure`; `COOKIE_SECURE` overrides this.
- `APP_ORIGIN`: the public origin used for CSRF Origin checks behind proxies.

## Release procedure

1. **Back up the database.**
2. Run migrations once, as a release step: `alembic upgrade head`. In compose this is the `migrate` service. Migrations must be reviewed and non-destructive.
3. Deploy the API and worker images, then the web image.
4. Smoke check:
   - `GET /health` returns 200 (liveness).
   - `GET /health/ready` returns 200 (DB readiness).
   - Sign in, open the dashboard, and upload a small statement in a staging organization.

## HTTPS and security

- Terminate TLS at the proxy (TLS 1.2+). Redirect HTTP to HTTPS.
- The API adds HSTS when `APP_ENV=production`. The Next.js proxy sets the CSP, frame, referrer and permissions headers.
- Session cookies are httpOnly, `SameSite=Lax` and `Secure`. CSRF protection uses a double-submit token plus an Origin check.
- The auth rate limiter runs in-process. With several API replicas, move it to a shared store such as Redis, or enforce limits at the gateway.
- The BFF refresh is single-flight per Node process. With several `web` replicas, enable sticky sessions, or accept occasional re-login on concurrent refresh races.
- Keep the API private if only the web app uses it.
- Never expose the storage bucket publicly. All downloads go through authorized endpoints.

## Logging and monitoring

- Structured JSON logs go to stdout and carry `request_id`, which is propagated from `X-Request-ID` and returned in error envelopes. Ship them to your log platform.
- **Error monitoring:** initialize an SDK such as Sentry in `app/main.py`, guarded by `settings.error_monitoring_dsn`. Add the matching Next.js instrumentation in `frontend/instrumentation.ts`. Both are integration points; neither is wired to a vendor.
- **Alerts:**
  - `/health/ready` failures
  - 5xx rates
  - jobs stuck in `queued` or `running` (the `background_jobs` table)
  - failed `royalty_import` jobs
  - `email_messages.status = 'failed'`

## Backups

- **Database:** a nightly full dump plus binlogs for point-in-time recovery, retained for 30 days or more. Test restores quarterly.

  ```bash
  mysqldump --single-transaction --routines --triggers rightsflow_ai | gzip > rightsflow_$(date +%F).sql.gz
  ```

- **Files:** enable bucket versioning and lifecycle rules. With local storage, back up `backend/storage/files`.
- The ledger, statements and audit logs are financial records. Define a retention policy before deleting any of them.

## Scaling notes

- API and web are stateless and scale horizontally; workers scale horizontally because of the conditional claim.
- Large statement imports run inside workers: size the worker memory for the 250k-row limit (roughly 1–2 GB).
- Add read replicas for analytics if dashboard queries become heavy.
