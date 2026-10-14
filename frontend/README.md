# RightsFlow AI — Frontend

Next.js 16 (App Router, Cache Components, Partial Prefetching), React 19, TypeScript strict, Tailwind CSS 4, TanStack Query 5, Radix UI.

```bash
cp .env.example .env.local      # BACKEND_URL defaults to http://127.0.0.1:8000
npm install
npm run dev                     # http://localhost:3000 (backend must be running)
```

| Script | Purpose |
|---|---|
| `npm run dev` / `build` / `start` | Next.js dev server / production build / serve the build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (next core-web-vitals + typescript) |
| `npm run test` / `test:watch` | Vitest + Testing Library (jsdom) |
| `npm run gen:api` | Regenerate `src/lib/api/schema.d.ts` from the running backend's OpenAPI spec |

## Architecture

```
Browser ──fetch──▶ Next.js BFF (/api/*) ──Bearer token──▶ FastAPI (/api/v1/*)
          cookies: rf_at, rf_rt (httpOnly), rf_csrf (readable)
```

### BFF and cookies (tokens never reach browser JavaScript)

| Cookie | Content | Flags |
|---|---|---|
| `rf_at` | access token | httpOnly, SameSite=Lax, `Path=/`, `Max-Age=expires_in` |
| `rf_rt` | refresh token | httpOnly, SameSite=Lax, `Path=/api`, `Max-Age=refresh_expires_in` |
| `rf_session` | `1` (no secret) | httpOnly, `Path=/` — lets `proxy.ts` know a refreshable session exists, because `rf_rt` is not sent with page requests |
| `rf_csrf` | random token | **not** httpOnly (double-submit), SameSite=Lax, `Path=/` |

`Secure` is set when `NODE_ENV=production` (override with `COOKIE_SECURE`).

Route handlers (`src/app/api/`):

- `POST /api/auth/login` and `POST /api/auth/register` (register then auto sign-in): set the cookies, rotate `rf_csrf`, return `{ user }`.
- `POST /api/auth/logout`: revokes the session on the backend (best effort) and clears the cookies.
- `GET /api/auth/session`: returns `{ user }` or 401, refreshing tokens if needed. A 401 clears stale cookies.
- `POST /api/auth/change-password`: the backend issues a new token pair, which this handler writes to the cookies.
- `GET /api/auth/csrf`: issues `rf_csrf` if it is missing.
- `GET|POST|PUT|PATCH|DELETE /api/backend/v1/...`: generic proxy to `${BACKEND_URL}/api/v1/...`.
  - Forwards the query string, an allow-list of request headers (content type, idempotency key, user agent, `X-Request-ID`) and the body, streamed for multipart uploads. Cookies are never forwarded.
  - Passes binary responses through with `content-type` and `content-disposition`, and an allow-list of response headers (hop-by-hop headers and `set-cookie` are dropped).
  - Paths must start with `v1/`. It rejects `..`, separators and control characters, and blocks token endpoints (`auth/login|refresh|logout|register|password/change`).
  - Token rotation happens before forwarding when `rf_at` is missing or expiring (based on the JWT `exp`). It also happens once after a backend 401 when the body is replayable (requests with no body, or bodies of 2 MB or less, which are buffered). If refresh fails, the cookies are cleared and the response is 401.
  - Refresh is **single-flight**: the backend revokes the whole session when a rotated refresh token is reused, so parallel requests share one refresh call, memoised for 30 s per token hash. This is per Node process; multi-instance deployments need sticky sessions or a shared store.

### CSRF

`src/lib/server/csrf.ts` (unit-tested) checks every non-GET request to `/api/backend/*`, `/api/auth/logout` and `/api/auth/change-password`:

1. `Origin` must match the request `Host` (or an `APP_ORIGIN` entry). A missing Origin is accepted only with `Sec-Fetch-Site: same-origin`.
2. The `x-csrf-token` header must equal the `rf_csrf` cookie (constant-time compare).

Login and register need only the Origin check. Failures return 403 in the backend error envelope (`origin_mismatch`, `origin_missing`, `csrf_missing`, `csrf_invalid`).

### `src/proxy.ts`

This only does optimistic routing; real authorization happens in the BFF and the backend.

- App routes without `rf_at`/`rf_session` redirect to `/login?next=…`.
- `/login` and `/register` with a session redirect to `next` or `/dashboard`.
- It issues `rf_csrf` when missing.
- It sets the CSP (no nonces, so pages stay static; `'unsafe-eval'` and `ws:` only in dev), `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, `X-Content-Type-Options` and COOP.
- It excludes `/api/*`, `_next/*` and static files.

### Rendering model (Cache Components)

Each `page.tsx` is a tiny server component: metadata plus `<Suspense fallback={<PageSkeleton/>}><XxxClient/></Suspense>`. The `(app)` layout renders `AppShell` (client). Its sidebar is static, and **children always render**:

- `SessionProvider` / `OrgProvider` load `/api/auth/session` and `/organizations` on the client.
- `useSession()` / `useOrg()` **suspend** until data is ready. During server rendering they throw Next's client-side-rendering bailout (the same mechanism as `next/dynamic({ ssr: false })`). The page's Suspense fallback is therefore prerendered into the static shell, and instant-navigation validation sees every page segment.
- Always call them below a `<Suspense>` boundary. `useSessionState()` / `useOrgState()` are non-suspending variants.
- The active org is the one picked in this tab, else `user.last_organization_id` if the user is still a member, else the first org. Users with no org go to `/onboarding`. Switching calls `PUT /auth/me/active-organization`, drops every tenant-scoped query (`["org", orgId, …]`) and shows a toast.
- `can(minRole)` hides or disables UI by role. The backend still enforces permissions.
- Sign-in/out and joining, leaving or switching org boundaries use `hardNavigate()` (a full document load) so no state from the previous identity survives.

Theme: an inline script in `<head>` applies `data-theme` from `localStorage["rf-theme"]` (or the OS setting) before paint. `ThemeProvider` uses `useSyncExternalStore`, which avoids hydration mismatches.

## API client

See [`src/lib/api/README.md`](src/lib/api/README.md). In short: `api.get/post/put/patch/delete<T>(path, { query, body, formData })`, with paths relative to `/api/v1`. It adds `x-csrf-token` automatically, throws a typed `ApiError { status, code, message, details, requestId }`, and redirects to login on 401 inside the app shell. `downloadFile(path, filename?)` saves binary responses.

## Adding a page or module

1. Add hooks in `src/lib/api/hooks/<module>.ts`. Use keys under `["org", orgId, "<module>", …]`.
2. Create `src/app/(app)/<route>/page.tsx`:

   ```tsx
   export const metadata: Metadata = { title: "Works" };
   export default function Page() {
     return <Suspense fallback={<PageSkeleton />}><WorksClient /></Suspense>;
   }
   ```

3. In `works-client.tsx` (`"use client"`), call `const { org, can } = useOrg()`. Then compose `PageHeader`, `Card`, `DataTable` (with `useTableQueryState` for URL-synced page, sort and filters), `Pagination`, `ConfirmDialog` and `toast`. `useSearchParams`/`useTableQueryState` must stay inside the Suspense boundary.
4. Don't read `cookies()`/`headers()`/`searchParams` or call `new Date()`/`Math.random()` in server components outside `<Suspense>`: the build will fail. Segment configs `dynamic`/`revalidate` aren't allowed.
5. The sidebar (`src/components/app-shell/nav-config.ts`) already lists every module route.

## Design system (`src/components/ui`)

Tokens live in `src/app/globals.css` as semantic CSS variables mapped through Tailwind 4 `@theme`, for example `bg-surface`, `text-fg-muted`, `bg-primary`, `bg-success-soft`, `border-border`, `ring-ring`. Light and dark modes are both supported, and focus rings are visible.

Components: Button / ButtonLink, IconButton, Input, Textarea, Select, NativeSelect, Checkbox, Switch, Label, FormField, Card, Badge (+ `statusTone`), Avatar, Table primitives, DataTable, Pagination, Tabs, Dialog, ConfirmDialog (typed confirmation), DropdownMenu, Tooltip, Popover, Skeleton / PageSkeleton, EmptyState, ErrorState (shows the request id and a retry), PageHeader / Breadcrumbs, StatCard, KeyValueList, SearchInput (debounced), Alert, Spinner, and Toaster (`toast`).

## Tests

`src/**/__tests__/*.test.ts(x)` cover Button, FormField, DataTable (sorting, empty, loading, error, selection), ConfirmDialog, API client and error parsing, and the CSRF/origin and path-validation helpers.
