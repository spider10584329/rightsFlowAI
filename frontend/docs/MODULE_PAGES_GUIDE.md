# Building Module Pages

These are the rules for adding feature pages, such as catalog, rights or royalties, to the authenticated app.

## Read first

- `frontend/README.md`: the BFF, cookies, CSRF and proxy setup.
- `frontend/src/lib/api/README.md`: the API client, hooks, `ApiError`, query keys, money as strings, and date helpers.
- The components in `src/components/ui/*`, especially `data-table.tsx`, `page-header.tsx`, `dialog.tsx`, `confirm-dialog.tsx`, `form-field.tsx`, `empty-state.tsx`, `error-state.tsx`, `stat-card.tsx`, `tabs.tsx` and `skeleton.tsx`. Also `src/lib/hooks/use-table-query-state.ts`.
- One finished page as a reference. `src/app/(app)/settings/team/` is the best one: it has `page.tsx` plus a `*-client.tsx`.
- The backend contract: `docs/API.md` (endpoint index), `http://127.0.0.1:8000/docs`, and `src/lib/api/schema.d.ts`, which holds the generated types. Read the backend router and schema for any endpoint you call (`backend/app/api/v1/*.py`, `backend/app/schemas/*.py`).
- The bundled Next.js 16.4 docs in `node_modules/next/dist/docs/`. This version postdates your training data. `cacheComponents` and `partialPrefetching` are on.

## Hard rules (Next 16 with Cache Components)

- Every `page.tsx` is a tiny server component: `export const metadata`, then `<Suspense fallback={<PageSkeleton/>}><XClient/></Suspense>`. The data UI lives in `"use client"` components.
- `useParams()`, `useSearchParams()`, `useSession()` and `useOrg()` must run below a `<Suspense>` boundary.
- Never call `cookies()`, `headers()` or `new Date()` at the top level of a server component.
- Dynamic routes such as `[id]` read `useParams()` inside the client component.

## Data and UX rules

- Every page calls real backend endpoints. No mock data, no placeholder sections, and no buttons that do nothing. If a backend capability is missing, leave the control out and mention it in your report.
- Use TanStack Query hooks in `src/lib/api/hooks/<module>.ts`. Keep query keys under `["org", orgId, ...]` and invalidate them after mutations.
- Every view handles four states: loading (skeletons), empty (`EmptyState` with a helpful call to action), error (`ErrorState` with retry) and success. Show a toast after each mutation. Map 422 errors to form fields with `fieldErrors`.
- Use role-aware UI: `const { can } = useOrg(); can("manager")`. Hide or disable actions the user's role can't perform. The backend still enforces permissions.
- Lists use `DataTable` with server-side pagination, sorting and filtering, kept in the URL through `use-table-query-state`. They also support search and row actions, and selection where bulk actions exist.
- Forms use controlled inputs with client-side validation that mirrors the backend rules, shown through `FormField` error messages.
- Money and percentages are strings. Display them with `Intl.NumberFormat` after `Number()`, for display only. Never compute totals from floats. Show the currency code.
- Show the backend's specific error codes clearly. Examples: `ai_not_configured` should say "AI provider not configured", `plan_limit_exceeded` should link to billing, and `stale_calculation` should say "Recalculate".
- AI output is always labelled "AI-generated · advisory — verify before relying on it. Not legal advice."
- Accessibility: use semantic headings, labelled inputs, and keyboard-operable menus and dialogs from the Radix components. Don't convey meaning by color alone. Status badges need text.
- Responsive: tables scroll horizontally on small screens, and detail pages stack into a single column.
- Design: premium, data-rich B2B. Reuse the design tokens. Pages should not all look the same: use summary stat rows, tabs and side panels where they help.

## File ownership and checks

- You own only the route folders, the `src/components/<module>/` folder and the `src/lib/api/hooks/<module>.ts` file listed in your brief. Do not edit shared files: `ui/*`, the app shell, `navigation.ts`, `types.ts`, `schema.d.ts`, `globals.css` or `package.json`. Put module-specific helper components in your own components folder. If you truly need a shared change, describe it in your report.
- Other engineers are editing other modules at the same time. Run:
  - `npx tsc --noEmit -p .`, and fix every error in your own files, ignoring errors that are only in other modules' in-progress files.
  - `npx eslint <your folders>`.
  - `npx vitest run <your test files>`. Add component tests for non-trivial logic in `src/components/<module>/__tests__/`.
- **Do not run `npm run build` or `npm install`.** The build runs centrally at the end.
- The backend runs at `http://127.0.0.1:8000` and the dev server at `http://localhost:3000`. If either is down, start it: backend with `cd backend && .venv/Scripts/python.exe -m uvicorn app.main:app --port 8000`, frontend with `npm run dev`. Verify your pages in the running app: register a test user `<module>-qa-<n>@example.com`, create an organization, create data through the UI, and request each page through the dev server to check it renders. A short Node script or headless Chrome is fine. Never modify or delete existing records belonging to other users.
