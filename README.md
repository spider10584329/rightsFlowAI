# RightsFlow AI

RightsFlow AI is a multi-tenant SaaS for music publishers, labels, catalog administrators and royalty teams. In one place it handles:

- the catalog, rights ownership and contracts
- royalty statement processing and royalty accounting
- payouts
- AI-assisted rights intelligence

| Layer | Stack |
|---|---|
| Frontend | Next.js 16.4 (App Router, Cache Components), React 19, TypeScript (strict), Tailwind CSS 4, TanStack Query, Radix UI |
| Backend | Python 3.13, FastAPI 0.143, SQLAlchemy 2.1, Pydantic 2, Alembic |
| Database | MariaDB 10.4+ (MySQL compatible) through PyMySQL |
| Auth | JWT access tokens (PyJWT), rotating opaque refresh tokens, Argon2 passwords (pwdlib), httpOnly-cookie BFF |
| AI (optional) | Anthropic Claude (`claude-opus-5-5`) through the official SDK, or an OpenAI-compatible gateway |

## Features

- **Organizations:** multi-tenant workspaces with owner, admin, manager and viewer roles.
  - Invitations, role changes, member deactivation and reactivation, and ownership transfer with safety checks.
  - Organization switching, settings, and an audit history.
- **Authentication:** registration and login, refresh-token rotation with reuse detection, and logout everywhere.
  - Password reset and email verification.
  - Active session management and rate limiting.
- **Catalog:**
  - Works, recordings, releases and parties (artists, songwriters, producers, publishers, labels), with contributors and track lists.
  - Identifier validation for ISRC, ISWC (check digit), UPC/EAN (GTIN), IPI and ISNI.
  - Search, filters, bulk actions, duplicate detection, completeness scoring, CSV/XLSX import (background job) and export.
- **Rights:**
  - Ownership shares by rights type, territory and effective dates; controlled and non-controlled shares.
  - Configurable split rules (warn or block), split sheets and verification.
  - Conflict detection: over- and under-allocation, overlapping claims, duplicates, missing ownership and invalid metadata. Conflicts are never resolved automatically.
- **Contracts:**
  - Parties, royalty terms, territories, rights granted, advances and linked catalog items.
  - Secure document storage, expiry tracking and notifications.
  - Rule-based clause scan, plus advisory AI extraction with human review.
- **Royalties:**
  - CSV/XLSX statement import through pluggable format adapters, with duplicate-file prevention and validation.
  - Matching by ISRC, ISWC, UPC and title/artist; manual and bulk matching; reconciliation.
  - A reproducible Decimal calculation engine with contract rates and an exact-sum rounding guarantee.
  - Posting to an immutable ledger, and reversals. See [docs/ROYALTY_ENGINE.md](docs/ROYALTY_ENGINE.md).
- **Payouts:**
  - Payee profiles and balances; advances with recoupment and adjustments.
  - Payout batches with an approval workflow (four-eyes option) and remittance CSVs. Payout batches never move real money.
- **AI:**
  - Catalog assistant, natural-language search and metadata-cleanup suggestions (human-approved).
  - Duplicate and conflict explanations, contract extraction and statement column classification.
  - Royalty anomaly detection (deterministic), completeness scoring and report narratives.
  - Usage and cost tracking with plan limits.
  - When AI isn't configured, AI features show a clear "AI provider not configured" state.
- **SaaS:** development subscription plans, entitlements and usage limits, a billing provider abstraction (manual, or Stripe with a verified webhook), in-app notifications and an email outbox.
- **Platform:** a background job queue backed by the database, private file storage (local or S3-compatible), structured logging, and request ids.

## Repository layout

```
backend/            FastAPI app (app/), Alembic migrations, pytest suite, requirements
frontend/           Next.js app (src/app, src/components, src/lib), Vitest tests
docs/               Architecture, API reference, royalty engine, deployment, conventions
scripts/            Utilities (OpenAPI/API.md export)
alembic.ini         Alembic config (run from the repo root)
docker-compose.yml  Production-like container stack
```

## Quick start (Windows, XAMPP MariaDB)

Prerequisites: Python 3.13, Node.js 24, and MariaDB running through XAMPP on `127.0.0.1:3306`.

```powershell
# 1. Backend
cd backend
python -m venv .venv                       # skip if .venv already exists
.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
copy .env.example .env                     # then edit DATABASE_URL and JWT_SECRET_KEY
cd ..
backend\.venv\Scripts\alembic.exe upgrade head
cd backend
.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000

# 2. Frontend (new terminal)
cd frontend
npm install
copy .env.example .env.local               # BACKEND_URL=http://127.0.0.1:8000
npm run dev
```

| Service | URL |
|---|---|
| App | http://localhost:3000 |
| API | http://127.0.0.1:8000 |
| Swagger | http://127.0.0.1:8000/docs |
| Health | http://127.0.0.1:8000/health/ready |

The background worker runs inside the API process by default (`RUN_EMBEDDED_WORKER=true`). To run it separately:

```powershell
cd backend
.venv\Scripts\python.exe -m app.worker
```

In development, email is written to `backend/storage/dev-outbox/*.eml` and **not delivered**. Invitation links are also shown in the UI once.

## Tests and quality checks

```powershell
# Backend: uses a separate <db>_test database that is created automatically
cd backend
.venv\Scripts\python.exe -m pytest

# Frontend
cd frontend
npm run typecheck
npm run lint
npm run test
npm run build
npm run test:e2e        # Playwright journeys against the running stack (uses installed Chrome)
```

## Documentation

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, modules, security model, jobs, AI |
| [docs/API.md](docs/API.md) | Generated endpoint index; [`docs/openapi.json`](docs/openapi.json) is the schema |
| [docs/ROYALTY_ENGINE.md](docs/ROYALTY_ENGINE.md) | Statement processing, the allocation model, rounding and the ledger |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Setup details, migrations, testing and troubleshooting |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Production configuration, Docker, HTTPS, backups and monitoring |
| [docs/BACKEND_CONVENTIONS.md](docs/BACKEND_CONVENTIONS.md) | How to add backend modules |
| [frontend/README.md](frontend/README.md) | Frontend architecture: BFF, cookies, CSRF and the API client |
| [frontend/docs/MODULE_PAGES_GUIDE.md](frontend/docs/MODULE_PAGES_GUIDE.md) | How to add frontend pages |
| [docs/N8N_MANAGED_MODE.md](docs/N8N_MANAGED_MODE.md) | Automation on a deployed server: one platform n8n, RightsFlow provisions each organization's workflows; admins only switch automations on |
| [docs/N8N_WINDOWS_SETUP.md](docs/N8N_WINDOWS_SETUP.md) | Self-hosted n8n on Windows (development, no Docker): install, start, connect, back up |
| [docs/N8N_ARCHITECTURE.md](docs/N8N_ARCHITECTURE.md), [N8N_WORKFLOWS.md](docs/N8N_WORKFLOWS.md), [N8N_SECURITY.md](docs/N8N_SECURITY.md) | Automation design, the five workflows, credentials and threat model |
| [docs/N8N_TEST_RESULTS.md](docs/N8N_TEST_RESULTS.md), [N8N_TROUBLESHOOTING.md](docs/N8N_TROUBLESHOOTING.md) | What was verified (and how), and common problems |

## External credentials

None are required for local development. All of these are optional:

| Purpose | Variables |
|---|---|
| AI features | `AI_PROVIDER=anthropic`, `AI_API_KEY` (Anthropic API key); `AI_WORKSPACE_ID` if the key isn't scoped to a workspace |
| Real email delivery | `EMAIL_PROVIDER=smtp`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD` |
| S3-compatible storage | `STORAGE_BACKEND=s3`, `S3_BUCKET`, `S3_REGION`, keys, optional `S3_ENDPOINT_URL` (and `pip install boto3`) |
| Stripe billing | `BILLING_PROVIDER=stripe`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and a `provider_price_id` set on each plan |
| Error monitoring | `ERROR_MONITORING_DSN` (integration point) |

Commercial plan pricing is intentionally not configured. The plans are labelled as development plans.
