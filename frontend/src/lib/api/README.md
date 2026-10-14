# API layer

| File | What |
|---|---|
| `client.ts` | `api.get/post/put/patch/delete<T>()`, `downloadFile()`, `authRequest()` (BFF auth endpoints) |
| `errors.ts` | `ApiError`, `parseApiError`, `fieldErrors`, `validationIssues`, `errorMessage` |
| `types.ts` | Hand-written auth/org/notification types; `Schemas` re-exports generated OpenAPI schemas |
| `schema.d.ts` | **Generated** by `npm run gen:api` (backend must be running). Do not edit. |
| `query-keys.ts` | Key factory. Tenant data lives under `["org", orgId, …]` |
| `hooks/*.ts` | TanStack Query hooks per module |

## Calling the backend

Paths are relative to the backend's `/api/v1`:

```ts
api.get<Page<Work>>(`/organizations/${orgId}/works`, { query: { page, page_size, sort, order, q } });
api.post<Work>(`/organizations/${orgId}/works`, { body: payload });
api.post<Job>(`/organizations/${orgId}/catalog/imports`, { formData });  // multipart; don't set content-type
await downloadFile(`/organizations/${orgId}/catalog/imports/template`, undefined, { query: { entity_type: "work" } });
```

- Unsafe methods send `x-csrf-token` automatically.
- Errors throw `ApiError { status, code, message, details, requestId }`:
  - Show `errorMessage(e)` to users.
  - Map 422s to form fields with `fieldErrors(e)`. It returns `{ field: message }` from the backend's `details[].loc`.
  - Branch on `e.code`, e.g. `plan_limit_exceeded`, `ai_not_configured` or `invalid_password`.
- In the app shell a 401 redirects to `/login?next=…`. Pass `skipAuthRedirect: true` on public pages.

## Adding typed hooks for a module

Create `src/lib/api/hooks/<module>.ts`:

```ts
"use client";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import type { Page, Schemas } from "@/lib/api/types";

type Work = Schemas["WorkResponse"];             // generated shape (or hand-write a type)
const keys = {
  all: (orgId: string) => ["org", orgId, "works"] as const,
  list: (orgId: string, params: object) => ["org", orgId, "works", "list", params] as const,
};

export function useWorks(orgId: string, params: { page: number; page_size: number; sort?: string; order?: "asc" | "desc" }) {
  return useQuery({
    queryKey: keys.list(orgId, params),
    queryFn: ({ signal }) => api.get<Page<Work>>(`/organizations/${orgId}/works`, { query: params, signal }),
    placeholderData: keepPreviousData,
  });
}

export function useCreateWork(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas["WorkCreate"]) => api.post<Work>(`/organizations/${orgId}/works`, { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.all(orgId) }),
  });
}
```

Rules:

- Keep tenant data under `["org", orgId, ...]`, so switching organizations clears it automatically.
- Money and percentages arrive as **strings** (exact decimals). Never `parseFloat` them for arithmetic.
- Datetimes are UTC without an offset. Format them with `formatDate` / `formatDateTime` / `parseApiDate` from `@/lib/utils`.
- After the backend changes, run `npm run gen:api` and commit `schema.d.ts`.
