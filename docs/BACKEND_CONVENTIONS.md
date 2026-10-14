# Backend Engineering Conventions

These conventions apply to every module in `backend/app`.

## Layout

| Layer | Location | Responsibility |
|---|---|---|
| Models | `app/models/*.py` | SQLAlchemy 2.x declarative tables. Imported by `app/models/__init__.py`. |
| Schemas | `app/schemas/*.py` | Pydantic request/response models. |
| Services | `app/services/*.py` | Business rules, transactions, validation. Routers stay thin. |
| Routers | `app/api/v1/*.py` | One module per area exposing `router` (and optionally `*_router`). Auto-mounted under `/api/v1` by `app/api/v1/__init__.py`. |
| Jobs | `@job_handler("type")` in a service module listed in `app.services.jobs.HANDLER_MODULES`. |
| Tests | `backend/tests/test_<area>.py` | pytest against a dedicated `*_test` MariaDB database. |

## Multi-tenancy

- Tenant routes live under `/organizations/{organization_id}/...`.
- Authorize with the `OrgViewer` / `OrgManager` / `OrgAdmin` / `OrgOwner` dependencies from `app.core.permissions`. Each yields an `OrgContext` (`ctx.user`, `ctx.organization`, `ctx.organization_id`, `ctx.role`, `ctx.has_role()`).
- Every query on a tenant table filters by `organization_id == ctx.organization_id`. Load rows by `(id, organization_id)`; rows from another organization are reported as **404**, never 403.
- Any foreign id received in a payload (party, work, recording, contract, file...) must be verified to belong to the same organization.
- Non-members get 404 for the organization itself (ids are not probeable).

## Role matrix

| Action | Minimum role |
|---|---|
| Read tenant data | viewer |
| Create / edit catalog, rights, contracts, statements; run AI | manager |
| Delete / bulk delete, post royalties to the ledger, approve payouts, split rules, org settings, members | admin |
| Assign admins, billing plan, ownership transfer, archive org | owner |

## Errors

Raise subclasses of `app.core.errors.AppError` (`NotFoundError`, `ConflictError`, `PermissionDeniedError`, `ValidationFailedError`, `LimitExceededError`, ...). Responses use the envelope `{"error": {"code", "message", "details"}, "detail", "request_id"}`.

## Money and percentages

- `Decimal` only — never `float`. Columns: `DECIMAL(20,8)` money, `DECIMAL(9,6)` percentages.
- Serialize with `DecimalStr` / `OptionalDecimalStr` from `app.schemas.common` (strings in JSON).
- Posted financial rows are immutable; corrections are new reversal/adjustment entries.

## Audit and notifications

- Mutations call `record_audit(db, action="area.verb", actor_user_id=..., organization_id=..., entity_type=..., entity_id=..., summary=..., changes=diff(before, after), request=request)` in the same transaction.
- User-facing events use `notify_user` / `notify_org` from `app.services.notifications`.

## Pagination

List endpoints accept `PageParams` (`page`, `page_size`, `sort`, `order`) and return `Page[T]` via `paginate(...)` + `page_of(...)`. Sorting is whitelisted per endpoint.

## Plan limits

Call `billing.check_limit(db, org_id, "<limit_key>", increment=n)` before creating limited resources (`max_catalog_items`, `max_statement_imports_per_month`, `max_users`, `max_storage_mb`, `max_ai_requests_per_month`).

## AI

Use `app.services.ai.run_structured(...)` only. It enforces configuration, plan entitlements and limits, validates structured output, and records usage and cost. Wrap any uploaded or user-provided text with `fence_untrusted(label, text)`. AI results are advisory; changes they propose are stored as `AISuggestion` rows and applied only after human approval. When no provider is configured, the API returns `503 ai_not_configured`. It never returns fabricated output.

## Testing

```
cd backend
.venv/Scripts/python.exe -m pytest                      # full suite
TEST_DATABASE_URL=mysql+pymysql://root@127.0.0.1:3306/rightsflow_<name>_test \
  .venv/Scripts/python.exe -m pytest tests/test_<area>.py
```

Fixtures in `tests/conftest.py`: `client`, `db`, `api` (register/login/org helpers), `team` (owner/admin/manager/viewer in one org plus an `outsider` with their own org), `fake_ai`, and `run_jobs()`.

Every module tests the happy paths, RBAC (a viewer cannot write), cross-tenant isolation (the outsider gets 404), and malicious or invalid input.
