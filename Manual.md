# RightsFlow AI Manual

> **As of:** 2026-10-15
> **For:** the developers and operators who explain this system to the client and handle the client's questions and change requests.
> **Covers:** the project's mission, architecture, the screens each role uses and how to use them, business rules, the data model, AI features, all eight n8n workflows, installation, configuration and operation, the current state and known limitations.

---

## Contents

1. [Mission and overview](#1-mission-and-overview)
2. [Architecture](#2-architecture)
3. [Key concepts and terms](#3-key-concepts-and-terms)
4. [Roles and permissions](#4-roles-and-permissions)
5. [End-to-end workflow (registration to payout)](#5-end-to-end-workflow-registration-to-payout)
6. [Screens and how to use them](#6-screens-and-how-to-use-them)
7. [Royalty calculation rules](#7-royalty-calculation-rules)
8. [Data model (database)](#8-data-model-database)
9. [AI features and configuration](#9-ai-features-and-configuration)
10. [n8n automation and the eight workflows](#10-n8n-automation-and-the-eight-workflows)
11. [Installation and configuration](#11-installation-and-configuration)
12. [Plans and limits](#12-plans-and-limits)
13. [Background jobs, notifications and email](#13-background-jobs-notifications-and-email)
14. [Security](#14-security)
15. [Operations: start, stop, back up, test](#15-operations-start-stop-back-up-test)
16. [Current state and known limitations](#16-current-state-and-known-limitations)
17. [Client questions and change requests](#17-client-questions-and-change-requests)
18. [Error codes and troubleshooting](#18-error-codes-and-troubleshooting)
19. [Appendix: documents and file locations](#19-appendix-documents-and-file-locations)

---

## 1. Mission and overview

### 1.1 Mission

**RightsFlow AI** is a **music rights and royalty management SaaS** for music publishers, record labels and rights administrators. In one line:

> "From first registration to final payout."

Money in the music industry flows like this:

1. A song (a work) is written and recorded.
2. The recording earns income through streaming services, distributors and performing rights organizations (PROs).
3. That income arrives as **statements**.
4. The money must be split according to who owns which rights in the song (ownership shares) and which contract terms (royalty rates) apply.
5. The split amounts are recorded in a ledger and paid to each rights holder (payee).

This is usually done in spreadsheets by hand, which leads to errors, double payments, missed payments and disputes. RightsFlow AI handles the whole process **in one system, with a full audit trail, and with financial safeguards**.

### 1.2 Who uses it

| Client type | Main features used |
|---|---|
| Music publishers | Works, writer shares, splitting performance and mechanical income |
| Record labels | Recordings and releases, splitting master income, artist royalties |
| Rights administrators | Catalogs and contracts for many rights holders, statement processing, payouts |

### 1.3 Feature areas

| Area | What it does |
|---|---|
| Catalog | Registers, validates and merges works, recordings, releases and parties (artists, writers, publishers…) with international identifiers (ISWC, ISRC, UPC, IPI, ISNI) |
| Rights | Records who owns what percentage of which right (ownership shares), validates totals, detects conflicts |
| Contracts | Contracts, contract parties, royalty terms (rates), expiry tracking, document storage, advisory AI clause analysis |
| Statement processing | Reads CSV/XLSX income statements and matches each line to the catalog |
| Royalty engine | Splits amounts by share × contract rate × amount; holds any money that is in doubt |
| Ledger & payouts | Records confirmed amounts in an immutable ledger, tracks payee balances, approves payout batches |
| AI assistance | Catalog Q&A, natural-language search, metadata cleanup suggestions, conflict and duplicate explanations, report narratives. All advisory; changes need human approval |
| Automation (n8n) | Automatic statement intake, contract expiry reminders, AI review, monthly reports, health checks |
| Teams, security & audit | Multiple organizations (tenants), role permissions, invitations, audit log, plans |

### 1.4 Design principles (worth stressing to the client)

1. **Data is isolated per organization.** One organization's data is never visible to another. Requests for another organization's data get "not found" (404).
2. **People confirm money.** Calculation is automatic, but posting to the ledger, approving payouts and recording payments are always done by an admin. AI and automation (n8n) cannot move money or change the ledger.
3. **The ledger is append-only.** Ledger entries are never edited or deleted. Corrections are made with reversal or adjustment entries.
4. **Money in doubt is held.** If a share is disputed, totals exceed 100%, or contract terms are ambiguous, that amount is not made payable. It stays **unallocated**, with the reason recorded.
5. **No real money transfers.** RightsFlow does not send bank transfers. "Paid" means the payment was made outside the system and is being recorded.
6. **AI only advises.** Changes proposed by AI are stored as pending suggestions and take effect only after a manager or higher approves them.
7. **Every important action is in the audit log.**

---

## 2. Architecture

### 2.1 Diagram

```
User's browser
     │  (http://localhost:3000)
     ▼
Next.js frontend + BFF (server-side proxy)        ← tokens live only in httpOnly cookies
     │  (/api/backend/v1/... → http://127.0.0.1:8000/api/v1/...)
     ▼
FastAPI backend (:8000) ── embedded background worker
     │                         │
     ▼                         ▼
MariaDB database (XAMPP, :3306)   File storage (backend/storage/files or S3)
     ▲
     │  automation API key (rfa_...) + event outbox
n8n automation (:5678, 127.0.0.1 only, its own SQLite database)
     │
     └─ The AI provider (OpenAI or Anthropic) is called only by the backend
```

- **n8n only orchestrates:** schedules, event polling, retries, telling the API to send notifications.
- **FastAPI makes every decision:** authentication, permissions, tenant isolation, calculation, ledger, audit.
- n8n never connects to the database and never calculates money.

### 2.2 Stack and versions

| Part | Details |
|---|---|
| Backend | Python 3.13, FastAPI 0.143, SQLAlchemy 2.1, Alembic 1.20, PyMySQL, Pydantic 2, Argon2 password hashing, PyJWT, openpyxl (XLSX), pypdf, Anthropic SDK 1.13, httpx |
| Frontend | Next.js 16.4, React 19.3, TypeScript (strict), Tailwind CSS 4, TanStack React Query 5, Radix UI, recharts |
| Database | MariaDB 10.4 or later (currently XAMPP's MariaDB). Every connection uses UTC and strict SQL mode |
| Automation | n8n 2.43.5 (Node.js 24, native npm install, no Docker) |
| Tests | pytest (backend), Vitest + Testing Library (frontend unit tests), Playwright (end-to-end) |
| OS | Windows 10 development environment (no Docker, no WSL) |

### 2.3 Ports

| Port | Service |
|---|---|
| 3000 | Frontend (Next.js): the address users open |
| 8000 | Backend API (FastAPI). API docs: `http://127.0.0.1:8000/docs` |
| 3306 | MariaDB (XAMPP) |
| 5678 / 5679 | n8n operational instance / its internal task broker |
| 5689 | Task broker for n8n command-line (CLI) runs |
| 5688 / 5698 | n8n test instance (live tests only) |

### 2.4 Repository layout

| Folder | Contents |
|---|---|
| `backend/` | The FastAPI app: `app/api/v1` (routes), `app/models` (tables), `app/services` (business logic), `app/schemas` (request/response formats), `app/core` (settings, security, permissions), `alembic/` (database migrations), `tests/` (pytest), `storage/` (files, dev outbox, backups) |
| `frontend/` | The Next.js app: `src/app` (screens), `src/components` (components), `src/lib` (API client, roles, plans), `e2e/` (Playwright) |
| `automation/n8n/` | The six n8n workflow JSON files, the generator `build_workflows.py`, test fixtures, n8n settings |
| `backend/app/services/automation/n8n_templates/` | Managed-mode workflow templates (generated by `build_workflows.py`; the backend provisions one copy per organization) |
| `scripts/` | PowerShell and Python helpers (install, start, configure and check n8n; export OpenAPI) |
| `docs/` | Technical documents (architecture, API, royalty engine, development, deployment, audit reports, n8n documents) |
| Root | `README.md`, `alembic.ini`, `docker-compose.yml` (reference for production deployment), `Manual.md` (this document) |

---

## 3. Key concepts and terms

| Term | Meaning |
|---|---|
| Organization | One client company. All business data belongs to an organization and is fully isolated from other organizations. A user can belong to several organizations. |
| Membership | The link between a user and an organization, with a role (owner, admin, manager or viewer). |
| Party | A person or company: artist, composer, lyricist, producer, publisher, label and so on. A party marked `is_internal` is the organization itself; its share is retained, not paid out. |
| Work | The composition itself (music and lyrics). Identifier: **ISWC** (for example `T-123.456.789-C`). |
| Recording | A recorded performance of a work (the master). Identifier: **ISRC** (12 characters). Linked to one or more works. |
| Release | An album, EP, single or compilation. Identifier: **UPC/EAN**. Has a track list. |
| IPI / ISNI | International identifiers for writers and publishers (IPI) and for creators (ISNI). |
| Rights type | Work rights: performance, mechanical, sync, print. Recording rights: master, neighbouring, sync. |
| Ownership share | A record that a party holds a percentage of one right in a work or recording, for given territories and dates. The core input to royalty splitting. |
| Controlled share | A share the organization administers, i.e. money the organization receives and passes on. |
| Split rule | The rule for what share totals must be (default 100%, tolerance ±0.01%) and whether a violation warns or blocks. |
| Split sheet | A record of the splits writers agreed on. Can be applied as ownership shares. |
| Rights conflict | A problem such as totals over or under 100%, overlapping claims or missing owners. Never resolved automatically; a person decides. |
| Contract | A publishing, administration, licensing, distribution, recording, producer or collaboration agreement, with parties, royalty terms, covered works/recordings and documents. |
| Royalty term | A payment rate in a contract, for example "20% of master income to this artist, on a net basis". It can be narrowed by payee, rights type, income source and territory. |
| Advance | Money paid in advance. Recorded in the ledger as a negative entry and recouped automatically from later earnings. |
| Statement | An income report file from a streaming service, distributor, PRO and so on (CSV, TSV, XLSX). |
| Statement line | One row of a statement (track, identifiers, territory, amount…). |
| Matching | Linking a statement line to a recording or work in the catalog, in the order ISRC → ISWC → UPC → title and artist. |
| Unmatched | A line not found in the catalog. A person must link it or ignore it. |
| Royalty run | The calculation result for one statement. Status: calculated (draft) → posted → reversed / discarded. |
| Allocation | One portion of a calculation result: **payable** (to be paid), **retained** (kept by the organization) or **unallocated** (held, with a reason). A line's allocations always add up exactly to the line amount. |
| Posting | Writing a calculation to the ledger. Admins only. |
| Ledger | The money record per payee: earning, advance, adjustment, reversal and payout entries. Immutable. |
| Payee | Payment details for a party who receives money: method, currency, minimum payout, hold flag. |
| Payout batch | A group of payments to many payees: draft → pending approval → approved → recorded as paid. |
| Four-eyes rule | The person who created a payout batch cannot approve it (on by default). |
| Automation key | The machine key n8n uses to call the API (`rfa_...`). Shown only once. |

---

## 4. Roles and permissions

### 4.1 The four roles

Each role includes everything the roles below it can do.

| Role | Description shown in the app | Summary |
|---|---|---|
| **Viewer** | Read-only access to organization data. | Can see all organization data, change nothing. |
| **Manager** | Create and edit catalog, rights, contracts and statements; run AI. | Creates and edits catalog, rights, contracts and statements; runs draft calculations; uses AI. |
| **Admin** | Manage members, settings, deletions, ledger postings and payout approvals. | Deletes, posts and reverses, adjusts the ledger, approves payouts, manages members, changes organization settings. |
| **Owner** | Full control including billing, ownership transfer and archiving. | Changes the plan, transfers ownership, archives the organization, grants the admin role. |

> There is no separate "super admin". Each organization's **owner** is the highest authority in that organization.

### 4.2 Permission matrix

V = viewer, M = manager, A = admin, O = owner. ✓ = allowed, – = not allowed.

| Area / action | V | M | A | O |
|---|---|---|---|---|
| View all organization data (dashboard, catalog, rights, contracts, statements, runs, ledger, payees, payouts, reports, background jobs, member list) | ✓ | ✓ | ✓ | ✓ |
| See security events (sign-ins, members, invitations) and IP addresses in the audit log | – | – | ✓ | ✓ |
| Create and edit catalog items, archive/restore, CSV/XLSX bulk import | – | ✓ | ✓ | ✓ |
| Delete catalog items, bulk delete, merge duplicates | – | – | ✓ | ✓ |
| Export catalog, import templates, validation issues, duplicate candidates, completeness | ✓ | ✓ | ✓ | ✓ |
| Create/edit/archive/supersede/verify/dispute shares, save splits, split sheets, run conflict scans and act on conflicts | – | ✓ | ✓ | ✓ |
| Create, edit and delete split rules | – | – | ✓ | ✓ |
| Create and edit contracts, upload documents, clause scan, request and review AI analysis | – | ✓ | ✓ | ✓ |
| Delete contracts and contract documents | – | – | ✓ | ✓ |
| Upload statements, manual statements, column mapping, process, edit, cancel, line matching, rematch, calculate, discard runs | – | ✓ | ✓ | ✓ |
| Verify a run, export reports | ✓ | ✓ | ✓ | ✓ |
| Delete statements, **post runs to the ledger**, **reverse runs** | – | – | ✓ | ✓ |
| Create and edit payees, set payment holds | – | ✓ | ✓ | ✓ |
| Ledger adjustments, advances, reversing ledger entries | – | – | ✓ | ✓ |
| Create payout batches, edit or remove amounts, submit for approval, cancel draft/pending batches | – | ✓ | ✓ | ✓ |
| **Approve** batches, **record as paid**, cancel approved batches | – | – | ✓ | ✓ |
| View AI status, usage, suggestions, duplicates, anomalies, completeness | ✓ | ✓ | ✓ | ✓ |
| Run AI (assistant, search, suggestions, explanations, summaries), approve or reject suggestions | – | ✓ | ✓ | ✓ |
| AI "Test connection" | – | – | ✓ | ✓ |
| Cancel and retry background jobs | – | ✓ | ✓ | ✓ |
| Invite, resend and revoke invitations; change roles; deactivate, reactivate and remove members | – | – | ✓* | ✓ |
| Grant the admin role (by invitation or role change) | – | – | – | ✓ |
| Change organization profile and accounting settings | – | – | ✓ | ✓ |
| View the email log | – | – | ✓ | ✓ |
| View billing overview / view usage history | ✓ / – | ✓ / – | ✓ / ✓ | ✓ / ✓ |
| Change plan, checkout, billing email | – | – | – | ✓ |
| Archive the organization, transfer ownership | – | – | – | ✓ |
| Leave the organization | ✓ | ✓ | ✓ | – (must transfer first) |
| Automation admin (managed mode): switch automations on/off, change their settings, Run now, check again | – | – | ✓ | ✓ |
| Automation admin: create/rotate/revoke keys (self-hosted mode; managed mode: revoke old hand-made keys only), release instance, overview, requeue events, runs and their results, incidents, inbox files | – | – | ✓ | ✓ |
| Automation: view statements and review tasks | ✓ | ✓ | ✓ | ✓ |
| Automation: retry statements, resolve/dismiss review tasks, request automated reviews | – | ✓ | ✓ | ✓ |

\* Admins can manage only managers and viewers. Nobody can change their own membership this way, and the owner's membership changes only through ownership transfer.

### 4.3 How permissions show up in the UI

- The left menu looks **the same for every role**. Restrictions are applied inside each screen.
- Buttons a role cannot use are mostly **hidden**. A few screens (catalog create/edit, import, contract create/edit, statement upload, manual statements, AI panels) show a read-only notice instead.
- Independently of the UI, **the backend checks permissions on every request**. Bypassing the UI does not get around them.
- A non-member requesting an organization's data gets "not found" (404).

### 4.4 Organization settings (accounting behaviour)

Changed by admins under **Settings → Organization → Accounting behaviour**.

| Setting | Default | Meaning |
|---|---|---|
| Allocation basis | Controlled pro-rata | `controlled_pro_rata`: split the whole amount among controlled shares in proportion. `gross_share`: give each share amount × share %, and hold the non-controlled part. |
| Four-eyes payout approval | On | The creator of a payout batch cannot approve it. |
| Contract expiry warning | 60 days | How many days before a contract ends to warn once (1–365). |
| Automatic title & artist matching | On | Whether lines without identifiers are matched by title/artist. |
| AI contract analysis | On | Whether AI analysis of contract documents is allowed. |

---

## 5. End-to-end workflow (registration to payout)

```
① Create the organization, invite members
      ▼
② Register the catalog (parties → works → recordings → releases)   ← CSV/XLSX bulk import available
      ▼
③ Record rights (ownership shares, split rules, split sheets)       → automatic conflict detection → a person resolves
      ▼
④ Register contracts (parties, royalty terms, covered works/recordings, documents)
      ▼
⑤ Upload statements (details → confirm column mapping → process)    ← n8n can pick up inbox files automatically
      ▼
⑥ Review matching (link unmatched lines or ignore them)
      ▼
⑦ Calculate → draft run: payable / retained / held (with reasons)
      ▼
⑧ Post (admin) → earning entries per payee; payees created automatically
      ▼
⑨ Payout batch (create: manager → submit → approve: admin, four-eyes → pay outside the system → record as paid: admin)
      ▼
⑩ Reports, payee statements of account (CSV), audit log
```

### Notes on each step

1. **Create the organization:** after signing up, enter the organization name, URL slug and default currency at `/onboarding`. The creator becomes the owner. Invite colleagues with **Settings → Team → Invite member** (links are valid for 7 days).
2. **Catalog:** creating parties (writers, artists, publishers) first makes entering works and recordings easier. Identifiers are checked for format and check digits as you type, and duplicate identifiers are refused.
3. **Rights:** in **Rights**, pick a work or recording, enter shares per rights type under **Edit splits**, check them with **Validate (dry run)**, then **Save splits**. Totals that don't add up create conflicts.
4. **Contracts:** contract rates apply only if the contract has royalty terms and the share is linked to the contract. A share with no contract is 100% payable.
5. **Statements:** after upload the system detects the format (adapter) and suggests a column mapping. A person confirms the mapping and clicks **Save mapping & process**; a background job then reads, validates and matches the lines.
6. **Review matching:** work through the **Unmatched** screen, largest amounts first.
7. **Calculate:** **Calculate** on the statement page. The result is a draft and does not touch the ledger.
8. **Post:** an admin clicks **Post to ledger** on the run page. If shares, contracts or the statement changed after the calculation, posting is refused and a recalculation is required.
9. **Pay:** build a batch from payees' available balances and take it through approval. The actual transfer happens outside (bank etc.); then **Record as paid**.
10. **Corrections:** an admin can **Reverse** a posted run (reason required). Offsetting ledger entries are written and the statement returns to "processed" so it can be rematched, recalculated and posted again.

---

## 6. Screens and how to use them

### 6.0 The app frame (all business screens)

- **Left menu:** see the table below. On desktop it can be collapsed (the state is remembered). On mobile it opens as a drawer from the "Open navigation" button.
- **Top right:** notifications bell (unread count, latest 8, "Mark all read", "View all notifications") and the user menu (Profile & security, Notifications, Theme: Light/Dark/System, Sign out).
- **Top left:** the organization switcher, listing your organizations with your role and a ✓ on the current one. The last item, **Create or join organization**, opens `/onboarding`.
- Opening a business screen while signed out redirects to `/login?next=…`. When a session ends, you are sent to the sign-in page automatically.

| Menu group | Items | URLs |
|---|---|---|
| Overview | Dashboard | `/dashboard` |
| Catalog | Catalog overview / Works / Recordings / Releases / Artists & contributors | `/catalog`, `/catalog/works`, `/catalog/recordings`, `/catalog/releases`, `/catalog/parties` |
| Rights | Rights overview / Conflicts / Split sheets | `/rights`, `/rights/conflicts`, `/rights/split-sheets` |
| Contracts | Contracts | `/contracts` |
| Royalties | Statements / Processing / Reports | `/royalties/statements`, `/royalties/runs`, `/royalties/reports` |
| Payouts | Payouts / Payees | `/payouts`, `/payouts/payees` |
| Intelligence | AI assistant | `/ai` |
| Admin | Team / Organization / Billing / Background jobs / Automation / Audit log | `/settings/...` |

Screens not in the menu: `/rights/rules` ("Split rules" button on Rights overview), `/royalties/unmatched` ("Unmatched" button on Statements and Reports), `/notifications` and `/settings/profile` (user menu).

### 6.1 Public pages (no sign-in)

| Page | Contents |
|---|---|
| `/` home | Product intro: "From first registration to final payout.", audiences (publishers, labels, rights administrators), 8 feature cards, a 5-step how-it-works, sign-up calls to action |
| `/features` | Detailed description of each module (catalog, rights, contracts, statements, royalties, payouts, AI, organizations, security, notifications) |
| `/pricing` (titled "Plans") | The 4 plans and their limits, with the warning "Development plans — commercial pricing not yet configured… nothing is charged." |

### 6.2 Authentication pages

| Page | How to use it |
|---|---|
| `/register` | Full name, work email, password. Live password checklist: 12–128 characters, a letter, a number or symbol, at least 5 different characters, no leading/trailing spaces, not the same as the email. A verification email is sent and you go to `/onboarding`. |
| `/login` | Email and password. Too many attempts shows "Too many sign-in attempts" (temporary block). |
| `/forgot-password` | Enter an email to get a reset link (the same response whether or not the account exists). The link is valid for 60 minutes. |
| `/reset-password?token=…` | Set a new password. Success signs you out on every device. |
| `/verify-email?token=…` | Verifies automatically when opened (link valid 48 hours). |
| `/invitations/accept?token=…` | Accept an invitation. Signed out: "Sign in to accept" or "Create an account". Signed in as someone else: a "Different account" warning. Signed in as the invited email: **Accept invitation** / **Decline**. |

### 6.3 Onboarding `/onboarding`

- A "Welcome, <name>" screen.
- If your email is not verified you see "Verify your email address" with a resend button. The pending invitations list here appears only after verification (invitation links received by email work without it).
- **Pending invitations:** accept or decline.
- **Create an organization:** name, URL slug (generated, editable; 3–100 lowercase letters, digits and hyphens), currency → **Create organization**. The creator becomes the owner.

### 6.4 Dashboard `/dashboard` (all roles)

- **New organizations:** a "Getting started" card (add works, add recordings, import the first statement, record a contract).
- **Money figures:** reported royalties (all time, this year), outstanding payable (available, reserved in batches, payee count), unmatched transactions.
- **Catalog figures:** works, recordings (with release count), active contracts (how many expire within 90 days), open rights conflicts (by severity).
- **Royalty analytics:** a currency selector (no currency conversion is done). Charts: royalties over time (12 months), revenue by source, by territory, top works, top recordings, catalog growth, ownership distribution. Each chart has a Chart/Table toggle.
- **Recent activity:** catalog changes, recent statements, contracts expiring within 90 days.
- Top right: "Background jobs", "Refresh".

### 6.5 Catalog

#### Catalog overview `/catalog`

- **Export** (all roles): CSV download of works, recordings, releases or parties.
- **Import** (manager+): opens the bulk import screen.
- **New** (manager+): Work / Recording / Release / Artist or contributor.
- Panels:
  - Counts per type (including archived counts).
  - Missing identifiers (for example works without an ISWC); click to open a filtered list.
  - Parties by role.
  - **Metadata completeness:** average score, bands (complete 100 / high ≥80 / medium ≥50 / low <50), the 8 least complete items.
  - **Validation issues:** severities error (invalid identifier, work with no writers, recording with no artist, release with no tracks), warning (missing ISRC/ISWC/UPC, recording not linked to a work, writer without IPI) and info.
  - **Duplicate candidates:** identical identifiers score 100%; otherwise pairs scoring 85% or more on title/artist/writer similarity. **Merge…** is admin+ only.

#### Lists `/catalog/works`, `/recordings`, `/releases`, `/parties`

- Search, status filter (default "Active & draft", Archived, All), sorting, paging. Filter state is kept in the URL.

| List | Columns | Extra filters |
|---|---|---|
| Works | Title (internal code), ISWC, Writers, Status, Verification, Completeness, Updated | Verification, has/missing ISWC |
| Recordings | Title (version · artist), ISRC, Linked works ("Not linked" if none), Duration, Status (Explicit badge), Verification, Completeness | Verification, ISRC, linked work |
| Releases | Title (artist · label), Type, UPC, Tracks, Release date, Status, Completeness | Type, UPC |
| Parties | Name, Type, Roles, IPI, PRO, Status ("Internal" badge) | Role, type (people/companies) |

- Row menu: View details (all), Edit and Archive/Restore (manager+), Delete (admin+).
- **Bulk actions** (checkboxes appear for manager+ only): Archive, Restore, Delete (admin+). Deleting several items requires typing "DELETE". Items referenced elsewhere are skipped and the reasons are listed.
- **Delete rule:** items referenced by shares, contracts, statement lines, allocations, payees, split sheets or tracks cannot be deleted; archiving is suggested instead.

#### Detail pages `/catalog/{type}/[id]`

- Header: title, status, identifier strip ("Missing" when absent).
- Buttons: Edit / Archive·Restore (manager+), **Request automated review** (manager+, works and recordings only; queues an n8n/AI review whose results appear under Settings → Automation → Review queue), Delete (admin+).
- Tabs: **Overview** (metadata, writers and publishers, linked recordings/works, contributors, releases…), **Ownership** ("View ownership & splits" → the Rights screen), **Activity** (change history with field-by-field before/after).
- Side panel: completeness meter, this item's validation issues, created/updated info.

#### Create and edit `/catalog/{type}/new`, `/[id]/edit` (manager+)

- **Work:** title, alternate titles, ISWC (check digit verified), internal code (unique within the organization), language, genre, creation year, writers and publishers (parties can be created inline), external identifiers, status, verification, lyrics excerpt, notes.
- **Recording:** title, version, ISRC, internal code, duration, recording date, explicit, ℗ line, primary artist (create inline), display artist, contributors, underlying works, external identifiers, status.
- **Release:** title, type, UPC/EAN (GS1 check digit), catalog number, release date, label, display artist, © line, track list (add, reorder, disc numbers).
- **Party:** name, type, roles, legal name, email, country, IPI, ISNI, PRO affiliation, Internal (the organization itself), notes.
- Warnings on save: possible duplicate ("Create anyway" to override), plan limit reached (link to billing).

#### Identifier validation

| Identifier | Normalization | Rule |
|---|---|---|
| ISRC | Spaces, hyphens and dots removed; uppercased | `^[A-Z]{2}[A-Z0-9]{3}\d{7}$` (12 characters; no check digit) |
| ISWC | Same | `T` + 10 digits with a mod-10 weighted check digit. Displayed as `T-DDD.DDD.DDD-C` |
| UPC/EAN | Digits only | GTIN-12/13/14 with the GS1 mod-10 check digit |
| IPI | Digits only, zero-padded to 11 | Format check only, 9–11 digits (the check digit is deliberately not verified because of legacy numbers) |
| ISNI | Same | 16 characters with an ISO 7064 MOD 11-2 check character (may be `X`) |

#### Bulk import `/catalog/import` (manager+)

1. Choose what to import: works, recordings or parties (**releases cannot be imported**, only exported). A template CSV can be downloaded.
2. Upload: `.csv` (UTF-8, UTF-8 with BOM or Windows-1252; comma, semicolon or tab delimited) or `.xlsx` (first sheet only). Up to 25 MB and 20,000 rows.
3. **Dry run first** (on by default) shows the result without saving → if all is well, **Run import now**.
- Matching existing records: works by ISWC then internal code; recordings by ISRC then internal code; parties by IPI, then ISNI, then name. Matches are updated with non-empty values only; contributors and links are added, never removed. Writer/artist names with no matching party create a new party.
- Each row is processed separately, so bad rows don't stop the rest (up to 500 errors are listed).
- Re-uploading the same file returns the existing job.

#### Merging duplicates (admin+, confirmation required)

- Choose the record to keep. The other record's contributors, links, contract links, tracks, split sheets, shares, payee (party merges) and unposted statement lines move to it.
- Posted financial records are not rewritten. The duplicate is archived, not deleted, with a "Merged into …" note.
- Identical shares are superseded rather than copied, so percentages don't double. A party merge where both parties have ledgers is refused.

### 6.6 Rights

#### Rights overview `/rights`

- Summary: active shares, verified %, unresolved conflicts, works/recordings with no owner.
- **Re-scan all assets for conflicts** (manager+).
- After choosing a work or recording:
  - **Ownership:** date and territory filters, totals versus expected per territory, share lines per rights type (party, role, controlled or not, %, scope, status). Row actions (manager+): **Verify**, **Dispute** (reason required), **Supersede** (replace with a new share), **Archive**.
  - **Edit splits** (manager+; read-only for viewers): edit shares per rights type (Performance, Mechanical, Synchronization, Print/lyrics, Master, Neighbouring). Columns: party, role, share % (6 decimals), territories, effective dates, contract. **Save splits** is enabled only after **Validate (dry run)**. Saving replaces the whole active set for that rights type. A blocking rule rejects the save with "Save rejected by a blocking rule".
  - **History:** all share records and the rights audit trail.

#### Share rules

- Work rights: performance, mechanical, sync, print. Recording rights: master, neighbouring, sync. Anything else is refused.
- A share is greater than 0 and at most 100. Territories are ISO country codes or `WORLD` (UK→GB, USA→US, WW→WORLD are converted). `WORLD` cannot be mixed with individual countries. Excluded territories are allowed.
- **Verified shares cannot have their key fields edited** (`share_verified`); create a new share with Supersede.
- Archived parties cannot receive shares.

#### Split rules `/rights/rules` (editing: admin+)

- Scope: asset type (work/recording) + rights type + territory (optional).
- Settings: expected total (default 100), tolerance (default 0.01), whether under-allocation is allowed, enforcement **Warn** (record a conflict) or **Block** (reject the change).
- The most specific rule wins: country > WORLD > no territory > default. With no rules at all, "100% ±0.01%, warn only" applies.
- Changing a rule queues an organization-wide conflict rescan.

#### Rights conflicts `/rights/conflicts`, `/rights/conflicts/[id]`

| Type | When it is raised | Severity |
|---|---|---|
| over_allocation | Total exceeds expected + tolerance | critical if 1 point or more over or the rule blocks, otherwise high |
| under_allocation | Total below expected − tolerance and under-allocation not allowed | medium |
| overlapping_claims | Same role, overlapping territories/periods: the same party twice, or different parties whose total exceeds the expected total | high |
| duplicate_entry | Identical shares | medium |
| missing_ownership | Active work with no performance/mechanical share, or active recording with no master share | medium |
| invalid_metadata | No or unknown territory, date errors, rights type invalid for the asset, archived party, disputed claim | low/medium |

- Status: open → acknowledged → resolved (notes required) / dismissed (notes required); can be reopened. Managers+ act on conflicts.
- **Conflicts are never resolved automatically.** One that is no longer detected is only flagged "No longer detected — needs confirmation".
- Detail page: **Explain with AI** (manager+, advisory), **Request automated review**.
- New high/critical conflicts notify managers.

#### Split sheets `/rights/split-sheets` (editing: manager+)

- Status: draft, signed, verified, disputed (set by hand).
- Entries: party, role, % (each party/role pair once; total at most 100%).
- **Apply to shares:** choose rights types, territories, dates, mode (Replace / Add) and controlled parties to turn the sheet into shares. Disputed sheets cannot be applied.

### 6.7 Contracts

#### Contract list `/contracts`

- Summary: contract counts (draft, pending signature), active (expired, terminated counts), expiring within 30/60/90 days, advances by currency.
- Filters: search (title, reference, party), type, status, expiring within.
- Buttons: **New contract** (manager+); row menu View / Edit (manager+) / Delete (admin+, confirm by typing the reference).

#### Contract types and statuses

- Types: publishing, administration, licensing, distribution, recording, producer, collaboration.
- Status transitions:

| From | Allowed next statuses |
|---|---|
| draft | pending_signature, active, terminated |
| pending_signature | draft, active, terminated |
| active | expired, terminated |
| expired | active, terminated |
| terminated | none (final) |

- A contract past its end date that does not auto-renew cannot be made active.

#### Create and edit (manager+)

- **Key terms:** title, reference (unique in the organization), type, status, currency, start/end/renewal dates, notice period (days), advance, territories, summary, internal notes (also auto-renew, recoupable, rights granted).
- **Parties:** party, role (licensor, licensee, publisher, writer, administrator, label, artist, producer, distributor, other), signed date.
- **Royalty terms:** payee (blank = every party), rights type, source category, territories, **rate (%)**, basis (net / gross), description.
- **Catalog items:** covered works and recordings.

> Important: the contract's **advance field is informational only**. To record an advance in the ledger, an admin enters an **Advance** on the payee page.

#### Contract detail `/contracts/[id]`

- Tabs: **Overview** (key terms, expiry), **Parties & terms**, **Catalog items**, **Documents**, **AI analysis**, **Activity**.
- **Documents:** upload PDF, DOCX, TXT, PNG or JPG up to 25 MB (manager+), download (all), delete (admin+). **Clause scan** (manager+) is a rule-based scan for term & termination, exclusivity, perpetuity (high), assignment, reversion, audit rights, cross-collateralization (high), recoupment, key person, most-favoured-nation, governing law, indemnity, auto-renewal, territory. It is labelled "not legal advice". Images get no text recognition (no OCR).
- **AI analysis** (manager+): pick a document, **Analyze with AI**, then in **Review** tick fields and choose **Accept & apply N fields** / Accept without changes / Reject. Fields that can be applied: title, type, dates, territories, rights granted, currency, advance, summary. **AI never applies royalty terms or parties.**
- Delete protection: contracts referenced by ledger entries or shares cannot be deleted (terminate them instead). Terms used by posted royalties cannot be removed.

#### Contract expiry (automatic)

The daily background job `contract_expiry_check`, per organization:
1. Sets active, non-auto-renewing contracts past their end date to **expired** and notifies.
2. Warns once when an active contract enters the warning window (default 60 days).
3. Notifies once when an auto-renewing contract passes its renewal date. **Dates are never changed automatically.**

n8n workflow B adds reminders at 30, 14 and 7 days and on expiry (chapter 10).

### 6.8 Royalties

#### Statement list `/royalties/statements`

- Buttons: **Unmatched** (all), **Manual statement** and **Upload statement** (manager+).
- Filters: source name, status (Needs mapping, Queued, Processing, Processed, Failed, Calculated, Posted), source category, period.
- Columns: source, category, period, status, rows · valid, matched ratio, total, uploaded.
- Row menu: Open, Map columns & process (manager+), Download source file, Delete statement (admin+; not for posted statements; type "DELETE").

#### Upload wizard `/royalties/statements/new` (manager+)

**Step 1 — Details & file**
- Source name; source category (streaming, distributor, publishing_admin, pro, mechanical, licensing, manual_adjustment); default rights type; period start and end; currency; reported total (for reconciliation); notes.
- File: CSV, TSV, TXT or XLSX; up to 25 MB, 250,000 rows, 200 columns.
- **A byte-identical file** is always refused ("This exact file was already imported"). A different file with the same content (line endings, row order…) is also refused by default and allowed only with `allow_duplicate` (audited).
- The monthly import limit of the plan is checked.

**Step 2 — Map columns**
- Choose the format (adapter): generic, distributor_standard, dsp_streaming, pro_works. The detected one is labelled "(detected)".
- Standard fields: isrc, iswc, upc, title, artist, territory, usage_type, rights_type, store, quantity, gross_amount, amount, currency, transaction_date, source_reference.
- **Required:** `amount` (net payable) plus at least one of ISRC, ISWC, UPC or title.
- Sample rows preview, "Reset to detected", optional "AI mapping assistant" (Suggest with AI).
- Clicking **Save mapping & process** records that a person confirmed the mapping. **Automation never processes a statement whose mapping no person has confirmed.**

**Step 3 — Process**
- Queue and progress display, then rows, valid rows, matched rows and statement total.
- Warnings for rows with errors and unmatched rows. On failure, "Edit mapping" and retry.
- When done: **Review statement**, **Calculate royalties**.

#### Processing rules (reading and validation)

- Amount formats: `1,234.56`, `1.234,56`, `(12.50)` (negative), trailing minus, currency symbols. The decimal separator is detected per column. Stored with 8 decimals.
- Dates: ISO, YYYYMMDD, YYYYMM, month names and more; day/month order detected per column.
- **Invalid rows:** amount missing or unparseable, currency not a 3-letter code, no identifier at all.
- **Warnings only (row stays valid):** bad ISRC/ISWC format, unknown territory, unrecognized rights type or date (the period end is used), unusable quantity.
- The statement total sums only lines in the statement's own currency.
- Reprocessing is possible only for unposted statements; it replaces the lines and discards unposted runs. **Once a statement has ever been posted, it cannot be reprocessed** (`statement_has_history`).
- Cancel processing works only while queued.

#### Matching order

| Order | Method | Confidence |
|---|---|---|
| 1 | ISRC → recording | 1.0 |
| 2 | ISWC → work (can be attached alongside an ISRC match) | 1.0 |
| 3 | UPC → the release's only track, or the track with the same title | 0.95 |
| 4a | Work-level lines: normalized title unique among works | 0.7 |
| 4b | Recording lines: title + exact artist → unique recording | 0.85 |
| 4c | Recording lines without an artist: title unique among recordings | 0.6 |

- Work-level lines: rights type performance/mechanical/print, or no rights type with source pro, publishing_admin or mechanical.
- Steps 4a–4c (title matching) can be turned off with the organization setting "Automatic title & artist matching".

#### Statement detail `/royalties/statements/[id]`

- Buttons: Source file, **Calculate** (manager+), Map & process. **More** menu (manager+): Edit details, Re-run automatic matching, Edit column mapping, Reprocess file, Delete statement (admin+).
- Posted statements show "Posted to the ledger": lines are locked; reverse the run to correct them.
- Tabs:
  - **Overview:** total, rows, matched %, reported total, reconciliation table (matched, unmatched, ignored versus reported, difference, other-currency totals).
  - **Lines / Unmatched:** search and filters; row actions (manager+): Match…, Match all with this ISRC/title…, Ignore line, Remove match; bulk actions on selected lines.
  - **Anomalies:** rule-based checks (duplicate lines, negative amounts, rate outliers, usage without money, currency mismatches).
  - **Calculation:** Calculate/Recalculate, latest run figures (input, payable, retained, unallocated), run history.
- Changing matches discards unposted runs and returns the statement to "processed".

#### Unmatched `/royalties/unmatched`

- Groups unmatched valid lines from all unposted statements by identifier and title, largest amounts first.
- **Match** (manager+): choose the scope (this line / all lines with this ISRC / title + artist / title), then search for a recording or work.

#### Manual statements `/royalties/statements/manual` (manager+)

- Category manual_adjustment by default (or licensing), 1–5,000 lines. Each line either points to a catalog item directly or is matched automatically by title, ISRC or ISWC. Negative amounts allowed. The statement is created already "processed".

#### Runs `/royalties/runs` (menu name "Processing")

- Status filter: Calculated, Posted, Reversed, Discarded. Columns: calculated date, statement, status, basis, lines, input, payable, retained, unallocated.
- Runs are not created here but from a statement's Calculation tab.

#### Run detail `/royalties/runs/[id]`

- **Verify** (all roles): recalculates and compares with the stored result.
- **Discard** (manager+, drafts only).
- **Post to ledger** (admin+, drafts only): refused with "Recalculate before posting" if the inputs changed.
- **Reverse** (admin+, posted runs only, reason required).
- Cards: totals (input = payable + retained + unallocated), verification result, warnings (why money is held), summaries by party, reason and rights type, allocation table (type, party, rights · territory, share, rate, base, amount, expandable explanation).
- Managers see "Awaiting posting… An admin reviews and posts this run."

#### Reports `/royalties/reports` (all roles)

| Report | Based on |
|---|---|
| Revenue by source / territory / work / recording | Valid, non-ignored lines of processed, calculated or posted statements (**includes unposted data**) |
| Earnings by payee | Payable allocations of **posted** runs only |
| Payee balances | Ledger sums |
| Statement reconciliation | Rows, matched rows, total and reported total per statement |

- Filters: period-end range, currency; up to 1,000 rows shown; totals per currency.
- **Export CSV** runs as a background job (`report_generation`, up to 100,000 rows); you are notified when it is ready to download.

### 6.9 Payouts

#### Batch list `/payouts`

- Notice: "RightsFlow never transfers money…".
- Status: Draft, Pending approval, Approved, Recorded as paid, Cancelled.
- **New batch** (manager+): currency, payees (all eligible / selected), notes.
  - Each amount = the payee's available balance **rounded down to the currency's minor unit** (0 decimals for JPY, KRW and similar; 3 for KWD, BHD and similar; 2 otherwise).
  - Skipped: payees on hold, zero balances, amounts below the payee's minimum payout.

#### Batch detail `/payouts/[id]`

| Stage | Who | What |
|---|---|---|
| Draft | manager+ | Lower or remove amounts (never above the balance). **Submit for approval** |
| Pending approval | admin+ | **Approve**. With four-eyes on, the creator cannot approve. Balances and holds are re-checked. |
| Approved | admin+ | After paying outside the system, **Record as paid**: confirm payment was made outside RightsFlow, payment date (not in the future), external reference per payout, notes. **Only now are negative payout entries written to the ledger.** |
| Cancelled | draft/pending: manager+; approved: admin+ | No ledger effect |

- Downloads: batch remittance CSV, per-payout advice CSV.

#### Payees `/payouts/payees`, `/payouts/payees/[id]`

- List: name, payment method, minimum, status, balance · available. **New payee** (manager+). Payees are also created automatically at posting.
- Detail:
  - Balance card per currency: balance, available, reserved in batches, unrecouped advances, lifetime earnings, lifetime payouts.
  - Payment details: method (bank_transfer, paypal, check, wire, other), currency, minimum payout, tax form status. **Full account numbers are never stored** (bank name, last 4 digits or PayPal email only).
  - **Hold payments** switch (manager+): earnings keep accruing but the payee is left out of batches.
  - Statement of account: date, type (Earning, Adjustment, Advance, Payout, Reversal), description, amount, running balance. CSV download ("balances are not bank confirmations").
  - **Adjustment / Advance** (admin+): adjustments (credit or debit) and advances (optionally linked to a contract). **Reverse entry** (admin+): adjustments and advances only, once each.

### 6.10 AI assistant `/ai`

- Status banner:
  - "AI assistant ready / Connected": a recent AI request succeeded.
  - "AI assistant configured / Configured · not yet verified": settings exist but no request has succeeded yet.
  - "AI provider not working": a configuration problem (reason shown).
- Also: this month's usage, a notice if the plan has no AI, **Test connection** (admin+; one minimal request, counted as one AI request).
- With no AI provider, the AI tabs show "Off" and the default tab becomes Suggestions.
- **Anything that sends data to the AI provider needs manager or higher.** Viewers see "Manager role required…".

| Tab | Contents | Who |
|---|---|---|
| Assistant | Q&A about the catalog (for example "Which works are missing an ISWC?"). Answers use only the organization's own data; with too little data it answers "Insufficient data". | manager+ |
| Smart search | Natural-language search → the AI turns it into filters → real database results ("How your query was interpreted") | manager+ |
| Suggestions | AI metadata cleanup proposals. **Generate suggestions**, **Approve & apply**, **Reject** | view: all; act: manager+ |
| Duplicates | Rule-based duplicate candidates, "Explain with AI" | view: all; AI: manager+ |
| Anomalies | Rule-based anomalies (3–36 months), "Summarize with AI" | view: all; AI: manager+ |
| Completeness | Completeness per type with missing items | all |
| Report summary | Narrative summaries: royalties by source or territory, catalog health, rights conflicts | manager+ |
| Usage | This month's usage and a log (feature, status, model, tokens, latency, estimated cost) | all |

### 6.11 Notifications `/notifications`

- All / Unread, Mark all as read, click a row to open the related screen (switching organization if needed), mark read/unread, delete.

### 6.12 Settings

#### Profile & security `/settings/profile` (every user)

- Profile: full name, email (read-only: "Contact support to change your sign-in email"), job title, time zone.
- Password change: requires the current password; signs out all other devices.
- Email notifications: a master switch and one switch per type (in-app notifications are always kept).
- Active sessions: device, IP, signed in, last active, expires. Revoke individual sessions or "Sign out everywhere".

> There is no screen for changing your email address. An operator must do it in the database (see chapter 16).

#### Organization `/settings/organization`

- Everyone can view it; admins+ can edit.
- Profile: display name, legal name, description, website, country, default currency, time zone, brand colour, logo URL (https).
- Overview: slug, organization ID, member count, created, your role.
- Accounting behaviour: see 4.4.
- **Danger zone:**
  - Owner: **Transfer ownership** (to an active admin; slug and password; the old owner becomes an admin) and **Archive organization** (slug and password; every member loses access; data is kept).
  - Everyone else: **Leave organization** (type the slug to confirm).

> **Where to create and delete organizations:** create via the organization switcher → **Create or join organization**. "Delete" is **Archive organization**. The system deliberately has no permanent delete, to protect financial and audit records.

#### Team `/settings/team`

- **Members** (everyone can view): search, role filter, "Show deactivated" (admin+).
- Row actions (admin+, on members they may manage): Change role, Deactivate/Reactivate, Remove from organization. Not possible on yourself or the owner. Only the owner can grant the admin role.
- **Invite member** (admin+): email, role (owner can invite admin, manager or viewer; admins can invite manager or viewer), personal message (500 characters). The invitation link can also be copied on screen.
- **Invitations** tab (admin+): pending, accepted, declined, revoked, expired. Re-send with a new link (the old one stops working), revoke.
- Invitations count toward the plan's user limit (pending ones included).

#### Billing `/settings/billing`

- Current plan, billing provider, period, billing email. "Development plan / No charges in manual mode" notices.
- Usage versus limits; included features.
- **Switch to <plan>** (owner only): blocked if current usage exceeds the new plan's limits. Without a payment provider (manual) the change applies immediately and nothing is charged.
- Usage history (admin+): 3–24 months of AI requests and cost, statement imports, storage.

#### Audit log `/settings/audit`

- Everyone can view it, but security events (sign-ins, members, invitations) and the IP column are admin+ only.
- Filters: area (Organization, Members, Invitations, Security & sign-in, User profiles, Catalog, Rights, Contracts, Royalties, Payouts, Billing), action prefix, entity type. Expanding a row shows before/after values.

#### Background jobs `/settings/jobs`

- Job types include catalog import, statement import, contract analysis, contract expiry check and report generation.
- Columns: job, status, progress, attempts, error, created, finished. **Cancel job** (queued) and **Retry job** (failed or cancelled): manager+.

#### Automation `/settings/automation`

- Viewers see the review queue and "Statements needing attention"; managers can act on them; admins see everything.
- **Managed mode (deployments, 10.13):** admin cards at the top (automations on, pending events, dead events, failed runs in 24 hours, open incidents, open review tasks). Tabs: **Automations** (switch each automation on or off, Settings, Run now, schedule, next and last run), **Runs** (with **Results**: processed statements, review tasks, notifications, report downloads), **Review queue**, **Statements**, **Incidents**, **Outbox**, and **Old keys** only when hand-made keys remain.
- **Self-hosted mode (development, 10.11):** admin cards at the top: active keys (expiring soon), pending events, dead events, failed runs in 24 hours, open incidents, open review tasks, an "Event delivery is off" warning.
- Tabs (self-hosted mode):
  1. **Review queue:** tasks automation handed to people (statement review, column mapping, AI metadata, rights conflict). Resolve / Dismiss (manager+).
  2. **Statements:** statements automation is working on or stopped on. State (pending, processing, completed, retry_waiting, failed, needs_manual_review, awaiting_mapping), attempts, next attempt, error. **Confirm mapping**, **Retry** (manager+).
  3. **Incidents:** repeated failures grouped together. Workflow, category, occurrences, alerts sent, suppressed, escalated badge. **Mark resolved**.
  4. **Inbox files:** the outcome of each file in the n8n inbox (imported, duplicate, rejected with reason).
  5. **Keys:** create automation keys (name, scopes, valid days; the key is **shown only once**), rotate (choose a grace period), **Release instance** (only when the old n8n instance is gone), revoke. Expiry badge (ok / expires soon / expires very soon / expired).
  6. **Runs:** the latest 50 workflow runs.
  7. **Outbox:** the event outbox; requeue dead events.

---

## 7. Royalty calculation rules

Use this chapter when the client asks "why is this the amount?" or "why was this money held?". The engine is `backend/app/services/royalty_engine.py`; the calculation version is `2026.10.2`.

### 7.1 Preconditions

- The statement is `processed` or `calculated` and has no posted run.
- Calculating discards the previous draft and creates a new draft (`calculated`).
- The organization's current allocation basis is used.

### 7.2 Steps for each line

1. **Unmatched lines** are entirely unallocated (`unmatched_line`). Zero-amount lines produce nothing.
2. **Rights type:** the line's own value → the statement default → the default for the source.

   | Source category | Default rights type |
   |---|---|
   | streaming, distributor, manual_adjustment | master |
   | publishing_admin, mechanical | mechanical |
   | pro | performance |
   | licensing | sync |

3. **Asset:**
   - Performance, mechanical and print need a **work**. A line matched to a recording reaches a work only if **exactly one** work is linked to it; otherwise it is held as `no_linked_work` or `multiple_linked_works`.
   - Master and neighbouring need a **recording** (`recording_required`).
   - Sync uses the recording if there is one, otherwise the work.
4. **Applicable shares:** same asset and rights type; status active or disputed; covering the line's territory (lines without a territory match only WORLD shares); in effect on the line date (transaction date, or the statement period end).
5. **Holds:** the whole line is unallocated when:
   - `missing_ownership`: no applicable share
   - `disputed_ownership`: any applicable share is disputed
   - `over_allocated_ownership`: applicable shares total more than 100%
6. **Split:**
   - **controlled_pro_rata (default):** the whole amount is divided among controlled shares in proportion to their percentages. With no controlled share: `no_controlled_shares`.
   - **gross_share:** each share gets amount × share %. Non-controlled portions are held as `non_controlled_share` and any unowned remainder as `unassigned_share`.
7. **Each portion:**
   - Internal party (the organization itself) → **retained** (`internal_party`).
   - Share linked to a contract → the most specific royalty term is chosen (by how many of payee, rights type, source and territory match). The contract must be active, expired or terminated, and the line date must fall inside the contract period (auto-renewing contracts have no end). Draft or pending contracts give the warning `contract_not_in_effect`.
     - No matching term → unallocated `no_applicable_contract_term`
     - Two equally specific terms with different rates or bases → unallocated `ambiguous_contract_terms`
     - Normal case → **payable = portion × rate**; the remainder is **retained** (`contract_retention`). On a gross basis with a gross amount on the line, the gross amount is used pro rata. Gross and net with opposite signs are held as `gross_net_sign_mismatch`.
   - Share with no contract → the whole portion is **payable**.

### 7.3 Hold (unallocated) reasons

| Reason code | Meaning | How to fix |
|---|---|---|
| `unmatched_line` | Line not matched to the catalog | Link it on the Unmatched screen, or add it to the catalog and rematch |
| `no_linked_work` | Recording has no linked work (work-right line) | Link the recording to a work |
| `multiple_linked_works` | Recording linked to several works | Match the line directly to a work |
| `recording_required` | Master-right line not matched to a recording | Match it to a recording |
| `missing_ownership` | No applicable share | Add shares (check territories and dates) |
| `disputed_ownership` | A disputed share applies | Resolve the dispute, recalculate |
| `over_allocated_ownership` | Shares total over 100% | Correct the shares |
| `no_controlled_shares` | No controlled share (pro-rata basis) | Check the controlled flags |
| `unassigned_share` | Unowned remainder (gross basis) | Complete the shares |
| `non_controlled_share` | Non-controlled portion (gross basis) | Can be normal (someone else's share) |
| `no_applicable_contract_term` | Contract linked but no matching term | Add a term to the contract |
| `ambiguous_contract_terms` | Equally specific terms disagree | Tidy up term scopes |
| `gross_net_sign_mismatch` | Gross and net signs differ | Check the statement data |
| `internal_party` (retained) | The organization's own share | Normal |
| `contract_retention` (retained) | The part outside the contract rate (kept by the organization) | Normal |

### 7.4 Precision and rounding

- Amounts are decimals with 8 places; shares and rates have 6. Floating point is never used.
- Portions use the largest-remainder method; ties go by share ID.
- Payable is rounded half-even at 8 places; retained is the exact remainder.
- Negative lines (refunds, adjustments) are split the same way.
- **Conservation check:** payable + retained + unallocated = input total. If not, nothing is saved and the request fails with `calculation_not_reconciled` (409).

### 7.5 Currency

- **No currency conversion.** Lines in a currency other than the statement's are allocated in their own currency and appear in an `other_currencies` warning. Run totals include only the statement currency.
- The dashboard and reports also show each currency separately.

### 7.6 Reproducibility

- Each run stores `calculation_version` and `inputs_hash` (SHA-256 over the lines, shares, terms and basis).
- **Verify** recalculates and compares with the stored result.
- **Post** recomputes the hash and refuses with `stale_calculation` (409) if shares, contracts or the statement changed after the calculation.
- Each statement can have only one posted run (`posting_key` unique constraint).

### 7.7 Posting and reversal

- **Post (admin):** one immutable `earning` entry per party and currency (effective date = statement period end). Parties without payee details get a payee automatically. The statement and run become `posted`; managers are notified.
- **Reverse (admin, reason of 3+ characters):** offsetting `reversal` entries are written and nothing is deleted. The run becomes `reversed` and the statement returns to `processed`, so it can be rematched, recalculated and posted again. Reprocessing the source file stays blocked.

### 7.8 Balances, advances and payouts

- Payee balance (per currency) = sum of ledger entries.
- Advances are negative entries, so later earnings recoup them automatically (per payee and currency). The negative part of a balance is the "unrecouped advance".
- Available = max(0, balance − amounts in open batches (draft, pending approval, approved)).
- Recording a batch as paid writes negative `payout` entries.
- Note: there is no API to reverse a `payout` entry once paid. A wrong payment is corrected with a ledger adjustment (this procedure is not stated in the code or docs).

---

## 8. Data model (database)

### 8.1 Common rules

- Database: MariaDB with **50** business tables (+ the migration version table `alembic_version` = 51).
- Every primary key `id` is a UUID4 string (VARCHAR(36)).
- Times are UTC: `created_at`, `updated_at`.
- **Tenant isolation:** business tables have `organization_id` (NOT NULL, indexed, CASCADE when an organization is deleted).
- **Money:** `DECIMAL(20,8)`. **Percentages:** `DECIMAL(9,6)` (0–100). Payout amounts `DECIMAL(20,2)`, plan prices `DECIMAL(12,2)`, AI cost `DECIMAL(12,6)`.
- **Enumerations:** string columns, enforced partly by database CHECK constraints and partly by API validation.
- **Soft delete:** there is no common column. Tables use `status='archived'` (catalog, shares), `is_active` (users, organizations, memberships, payees), `is_deleted/deleted_at/purged_at` (files) or `revoked_at` (tokens, keys).
- **Financial records are append-only:** posted statement lines, allocations and ledger entries are never updated or deleted.

### 8.2 Tables by area (52)

| Area | Count | Tables |
|---|---|---|
| Identity & tenancy | 6 | users, refresh_tokens, user_action_tokens, organizations, organization_memberships, organization_invitations |
| Catalog | 8 | parties, works, recordings, recording_works, work_contributors, recording_contributors, releases, release_tracks |
| Rights | 4 | ownership_shares, split_rules, split_sheets, rights_conflicts |
| Contracts | 6 | contracts, contract_parties, contract_royalty_terms, contract_assets, contract_documents, contract_analyses |
| Royalties | 4 | royalty_statements, statement_lines, royalty_runs, royalty_allocations |
| Ledger & payouts | 4 | payees, ledger_entries, payout_batches, payouts |
| Billing | 4 | plans, subscriptions, ai_usage_records, ai_suggestions |
| Platform | 5 | audit_logs, notifications, email_messages, stored_files, background_jobs |
| Automation (n8n) | 11 | integration_credentials, automation_events, automation_runs, automation_idempotency_keys, automation_deliveries, automation_review_tasks, automation_incidents, automation_statement_states, automation_inbox_files, automation_connections, organization_automations |

### 8.3 Identity & tenancy

| Table | Purpose and key columns |
|---|---|
| `organizations` | A client company (tenant). `name`, `slug` (unique), `is_active` (false when archived), legal name, country, `default_currency` (default USD), `timezone`, `settings` JSON (allocation basis, four-eyes, expiry warning days, title matching, AI contract analysis) |
| `users` | A login identity (global, not per organization). `email` (unique), `full_name`, `hashed_password` (Argon2), `is_active`, `is_service_account` (machine account for n8n, cannot sign in), `email_verified_at`, `notification_preferences` JSON, `last_organization_id` |
| `organization_memberships` | User ↔ organization link. `role`: owner/admin/manager/viewer, `is_active`. Unique per (organization, user) |
| `organization_invitations` | Invitations. `email`, `role` (admin/manager/viewer), `status` (pending/accepted/declined/revoked/expired), `token_hash` (only the hash is stored), `expires_at`, `message` |
| `refresh_tokens` | Session refresh tokens (SHA-256 hash only). `family_id` groups one sign-in's tokens so reuse revokes the whole family |
| `user_action_tokens` | Single-use tokens: password_reset, email_verification |

### 8.4 Catalog

| Table | Purpose and key columns |
|---|---|
| `parties` | People and companies. `party_type` (person/company), `roles` JSON (artist, songwriter, composer, lyricist, producer, publisher, label, performer, engineer, administrator, other), `ipi_number`, `isni`, `pro_affiliation`, `is_internal`, `status` (active/draft/archived) |
| `works` | Works. `title`, `alternate_titles`, `iswc`, `internal_code` (unique in the organization), language, genre, creation year, `status`, `verification_status` (unverified/verified/disputed) |
| `recordings` | Recordings. `title`, `version_title`, `isrc`, `internal_code`, `primary_artist_id`, `display_artist`, duration, recording date, ℗ line, explicit, `status`, `verification_status` |
| `recording_works` | Recording ↔ work links (used by the engine to route ISRC income to the work) |
| `work_contributors` | Work credits: composer, lyricist, composer_lyricist, arranger, adapter, translator, original_publisher, sub_publisher, administrator. **Credits are not ownership** (ownership lives in shares) |
| `recording_contributors` | Recording credits: main_artist, featured_artist, producer, co_producer, mixer, engineer, mastering_engineer, musician, vocalist, label, plus instrument |
| `releases` | Releases. `release_type` (album/ep/single/compilation/other), `upc`, `catalog_number`, `label_id`, release date, © line |
| `release_tracks` | Track list (release, disc number, track number unique) |

- There are no separate identifier, merge or import tables. Identifiers are columns on each table, other IDs go in `external_ids` JSON, and imports are recorded as background jobs.

### 8.5 Rights

| Table | Purpose and key columns |
|---|---|
| `ownership_shares` | Ownership shares. Exactly one of `work_id` or `recording_id`, `party_id`, `role`, `rights_type`, `share_percent` (> 0 and ≤ 100), `territories`/`excluded_territories` JSON, `effective_from/to`, `is_controlled`, `source` (manual/contract/import/split_sheet), `contract_id`, `split_sheet_id`, `status` (active/superseded/disputed/archived), `verification_status`, `supersedes_id` (version chain) |
| `split_rules` | Split rules. `asset_type`, `rights_type`, `territory`, `expected_total`, `tolerance`, `allow_under_allocation`, `enforcement` (warn/block) |
| `split_sheets` | Split sheets. `work_id`, `title`, `agreed_date`, `status` (draft/signed/verified/disputed), `entries` JSON, attached document |
| `rights_conflicts` | Rights conflicts. `conflict_type`, `severity` (low/medium/high/critical), `status` (open/acknowledged/resolved/dismissed), asset, `explanation`, `details`, `fingerprint` (prevents duplicates), resolver and resolution notes |

### 8.6 Contracts

| Table | Purpose and key columns |
|---|---|
| `contracts` | Contracts. `title`, `reference` (unique), `contract_type`, `status`, start/end/renewal dates, `auto_renew`, `notice_period_days`, `territories`, `rights_granted`, `currency`, `advance_amount` (informational), `is_recoupable`, `expiry_notified_at` |
| `contract_parties` | Contract parties with role and signed date |
| `contract_royalty_terms` | Royalty terms. `payee_party_id` (blank = all), `rights_type`, `source_category`, `territories`, `rate_percent` (0–100), `basis` (gross/net) |
| `contract_assets` | Works/recordings covered by the contract |
| `contract_documents` | Contract documents (file links) |
| `contract_analyses` | AI contract analysis results. `status` (queued/running/completed/failed), `extracted` JSON, `flagged_clauses`, `review_status` (pending_review/accepted/rejected) |

### 8.7 Royalties

| Table | Purpose and key columns |
|---|---|
| `royalty_statements` | Statements. `source_name`, `source_category`, period, `currency`, file, `file_sha256` (unique per organization — identical files are refused), `content_sha256` (detects identical content), `adapter`, `column_mapping`, `status` (uploaded/queued/processing/processed/failed/calculated/posted), row counters, `total_amount`, `reported_total`, `mapping_confirmed_at/by` |
| `statement_lines` | Statement lines. `row_number`, `raw` JSON (original row), title and artist, `isrc/iswc/upc`, territory, usage type, rights type, store, quantity, `gross_amount`, `amount`, currency, transaction date, `is_valid`, `validation_errors`, `match_status` (matched/unmatched/ignored/invalid), `match_method` (isrc/iswc/upc/title_artist/title/manual), `match_confidence`, `recording_id`, `work_id` |
| `royalty_runs` | Runs. `status` (calculated/posted/reversed/discarded), `calculation_version`, `allocation_basis`, `inputs_hash`, totals (input, payable, retained, unallocated), `warnings`, `posting_key` (one posted run per statement), who posted/reversed and the reversal reason |
| `royalty_allocations` | Allocations. `allocation_type` (payable/retained/unallocated), share, contract term, party, payee, asset, rights type, territory, share %, rate %, base amount, amount, `reason`, `explanation` JSON |

### 8.8 Ledger & payouts

| Table | Purpose and key columns |
|---|---|
| `payees` | Payees. `party_id` (unique in the organization), `display_name`, `payment_method`, `payment_reference` JSON (non-sensitive only), `currency`, `minimum_payout`, `hold_payments`, `tax_form_status`, `is_active` |
| `ledger_entries` | Ledger entries (immutable). `entry_type` (earning/advance/adjustment/reversal/payout), `amount` (positive = more owed to the payee), `currency`, `effective_date`, `run_id`, `payout_id`, `contract_id`, `reversal_of_id` (unique — reversed at most once) |
| `payout_batches` | Payout batches. `reference`, `status` (draft/pending_approval/approved/paid/cancelled), `currency`, `total_amount`, `provider` (internal — moves no money), who/when for submit, approve, paid and cancel |
| `payouts` | Payments in a batch. `amount` (> 0), `status` (pending/paid/cancelled/failed), `external_reference`. Unique per (batch, payee) |

- There is no balance table; balances are computed from the ledger.

### 8.9 Billing & AI

| Table | Purpose |
|---|---|
| `plans` | Plans (`code`, `limits` JSON, no price set). Filled automatically when the backend starts |
| `subscriptions` | One per organization. `plan_id`, `status`, `provider` (manual/stripe) |
| `ai_usage_records` | One row per AI call: feature, provider, model, status, tokens, estimated cost, latency, error (`[error_code] message`) |
| `ai_suggestions` | AI suggestions. `entity_type/id`, `proposed_changes`, `status` (pending/approved/rejected/applied), reviewer |

### 8.10 Platform

| Table | Purpose |
|---|---|
| `audit_logs` | Audit log (append-only). `action` (for example contract.created, statement.uploaded, ledger.reversed), target, `changes` JSON, IP, request ID |
| `notifications` | In-app notifications per user: type, title, body, link, severity, read flag |
| `email_messages` | Outbound email log. `status`: queued/sent/logged (development; **not actually sent**)/failed |
| `stored_files` | File metadata. `category` (contract/statement/import/export/other), storage key, original name, size, `sha256`, deleted/purged times |
| `background_jobs` | Job queue. `job_type`, `status` (queued/running/succeeded/failed/cancelled), progress, result, attempts, `idempotency_key` |

### 8.11 Automation (n8n)

| Table | Purpose |
|---|---|
| `integration_credentials` | Automation keys (`rfa_<key_id>_<secret>`; only an HMAC of the secret is stored). Scopes, expiry, revocation, rotation history, **n8n instance binding** (`bound_instance_id`, last seen), `managed` (issued by RightsFlow for its own n8n) |
| `automation_events` | Event outbox. `event_type` (statement.uploaded, statement.ready, work.created, recording.created, rights_conflict.opened, review.requested), `status` (pending/claimed/completed/failed/dead/expired), lease details, attempts |
| `automation_runs` | One row per workflow run: workflow name, n8n execution ID, trigger (manual/schedule/event/file/error_handler), status (running/succeeded/failed/partial/skipped), summary (counts only) |
| `automation_idempotency_keys` | Stored responses that stop repeated requests being processed twice |
| `automation_deliveries` | Notification and report deliveries (dedupe keys) |
| `automation_review_tasks` | Tasks automation handed to people (statement_mapping, statement_review, ai_metadata, ai_conflict, inbox_file_rejected) |
| `automation_incidents` | Repeated failures grouped by workflow, category and resource; drives first alert, suppression, escalation and recovery notice |
| `automation_statement_states` | Per-statement automation state and retry schedule |
| `automation_inbox_files` | Outcome per inbox file (by SHA-256) |
| `automation_connections` | Managed mode: one row per organization. Connection status (disabled/provisioning/active/error), the managed key, the ids of the two n8n credentials RightsFlow created, last error, last check, a lease that keeps two set-up runs apart |
| `organization_automations` | Managed mode: one row per organization and automation. On/off, settings (JSON), status (disabled/pending/active/error), the n8n workflow id, template version, hash of what was sent to n8n, last error, last manual start |

### 8.12 Table relationships, following the money

```
stored_files ─► royalty_statements ─► statement_lines ──(match)──► recordings / works
                                              │                      │
                                              │              ownership_shares ──► contracts ──► contract_royalty_terms
                                              ▼                      │
                                       royalty_runs ─► royalty_allocations (payable / retained / unallocated)
                                              │ (Post, admin)
                                              ▼
                                       payees ─► ledger_entries (earning, advance, adjustment, reversal, payout)
                                              │
                                              ▼
                                       payout_batches ─► payouts ─(Record as paid)─► ledger_entries(payout)
```

### 8.13 Database migrations, in order

| # | Revision | Contents |
|---|---|---|
| 1 | `a0d0d862a93d` | organizations table |
| 2 | `f9c67edab705` | users table |
| 3 | `1682ed44a5f2` | organization_memberships table |
| 4 | `ff292c7fb808` | 38 SaaS business tables (catalog, rights, contracts, royalties, ledger, payouts, platform, billing, tokens, invitations) |
| 5 | `010ae74ee6d8` | Notification preferences, file purge, platform jobs |
| 6 | `cbc38defc8d1` | Audit hardening constraints (RESTRICT to protect financial records, etc.) |
| 7 | `1195060a8593` | 6 n8n automation tables |
| 8 | `46e2b483eada` | Automation reliability: incidents, statement states, inbox files, instance binding, mapping confirmation |

The database is at the latest revision, `46e2b483eada`. Migrations are run from the repository root with `backend\.venv\Scripts\alembic.exe upgrade head`.

---

## 9. AI features and configuration

### 9.1 AI features

Every feature that sends data to the AI provider requires manager or higher.

| Feature | What it does | Nature of the result |
|---|---|---|
| Catalog assistant | Answers questions from the organization's own records | Advisory answer; cited IDs are filtered to records actually sent |
| Smart search | Turns a question into a search plan that the server validates and runs | Real database results |
| Metadata cleanup | Proposes corrections to works, recordings and parties | **Pending suggestions**, applied only after approval |
| Duplicate explain | Explains whether two records are duplicates | Advisory |
| Conflict explain | Explains a rights conflict | Advisory; the conflict is not changed |
| Anomaly summary | Summarizes the rule-based anomaly results | Advisory |
| Statement classify | Classifies statement column names (mapping help) | Applied by a person |
| Report summary | Narrative summary of a report | Figures come from the database; only the narrative is AI |
| Contract analysis | Extracts fields and flags clauses in contract documents | Field-by-field human review; **royalty terms and parties are never applied** |
| Test connection | One minimal request to check the connection (admin) | Counts as one request |

Features that work without AI: duplicate candidates, anomaly detection (negative amounts, amounts with zero quantity, rate outliers, period swings, duplicate lines, currency mismatches), completeness scores, report figures, the rule-based contract clause scan.

### 9.2 Human approval

- AI suggestions are stored as **pending** in `ai_suggestions`, and a manager or higher clicks **Approve & apply** or **Reject**.
- On approval only whitelisted fields are applied, values are re-validated, and a field is skipped if it changed after the suggestion was made.
  - Work: title, alternate_titles, iswc, language, genre
  - Recording: title, version_title, isrc, display_artist
  - Party: name, legal_name, ipi_number, isni, country_code
- Every AI output carries "AI-generated and advisory only… not legal or financial advice".
- Record content is sent inside randomly tagged "untrusted data" fences, which reduces (but does not eliminate) prompt-injection risk.

### 9.3 Usage and cost

- Each AI call checks the plan's monthly AI request limit and AI entitlement and reserves one request. Successes, errors and refusals are all recorded.
- Estimated cost = (input tokens × `AI_INPUT_COST_PER_MTOK` + output tokens × `AI_OUTPUT_COST_PER_MTOK`) ÷ 1,000,000 USD. **This is an estimate, not the actual bill.** Check real charges in the AI provider's account.

### 9.4 Provider configuration (`backend/.env`)

**Current setting: OpenAI `gpt-4o-mini` (connection confirmed 2026-10-15).**

OpenAI:

```
AI_PROVIDER=openai_compatible
AI_API_KEY=sk-...                      # platform.openai.com → API keys
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-4o-mini                   # a model that supports structured outputs (strict JSON schema)
AI_TOKEN_LIMIT_PARAM=auto              # uses max_completion_tokens for api.openai.com
AI_INPUT_COST_PER_MTOK=0.15            # for cost estimates (match the model's price)
AI_OUTPUT_COST_PER_MTOK=0.60
```

Anthropic (Claude):

```
AI_PROVIDER=anthropic
AI_API_KEY=sk-ant-...
AI_MODEL=claude-opus-5-5
AI_WORKSPACE_ID=wrkspc_...             # required when the key is not scoped to a workspace
AI_EFFORT=medium
```

Shared: `AI_TIMEOUT_SECONDS` (60), `AI_MAX_RETRIES` (2), `AI_MAX_OUTPUT_TOKENS` (8000).

- After changing settings, **restart the backend** (`.env` is not reloaded automatically).
- Then click **Test connection** on the AI page; "Connected" means it works.
- The AI provider account needs credit. Without it you see "AI provider account needs attention".

### 9.5 AI errors as shown in the UI

| Title on screen | Code | Cause and fix |
|---|---|---|
| Invalid AI configuration | `ai_configuration_error` | Anthropic key needs a workspace → set `AI_WORKSPACE_ID` |
| Invalid AI model configuration | `ai_model_unavailable` | `AI_MODEL` is not available to the account |
| AI provider credentials rejected | `ai_auth_failed` | Wrong or revoked key → replace `AI_API_KEY` |
| AI provider access denied | `ai_permission_denied` | The key may not use that model or feature |
| AI provider account needs attention | `ai_billing` | Provider account out of credit, etc. |
| AI provider is busy | `ai_rate_limited` | Too many requests; retry later |
| AI provider temporarily unavailable | `ai_unavailable` | Provider outage; retry |
| Can't reach the AI provider | `ai_unreachable` | Network problem |
| The AI provider timed out | `ai_timeout` | Timeout; retry |
| AI request could not be processed | `ai_invalid_request` | Problem with the request |
| AI provider not configured | `ai_not_configured` (503) | `AI_PROVIDER` / `AI_API_KEY` not set |

Configuration errors (the first five) are never retried automatically. The provider's detailed reason and request ID go only to the backend log, not to the browser.

---

## 10. n8n automation and the eight workflows

### 10.1 Concept

- n8n is **optional**. Every RightsFlow feature works without it.
- n8n only calls RightsFlow's **automation API** (`/api/v1/automation/...`). It never connects to the database, never calculates money, and cannot post to the ledger or approve payouts (no such API routes exist).
- There are two ways to connect n8n, chosen per server with `AUTOMATION_MODE`:

| Mode | For | Who does what |
|---|---|---|
| **managed** (default) | Deployments (SaaS) | The operator runs one n8n next to the API. **RightsFlow sets up each organization's workflows, keys and schedules itself.** Organization owners/admins only switch automations on and off in **Settings → Automation**. They never see keys, scripts or n8n. See 10.13. |
| **self_hosted** | Development and single-machine use | An admin creates a key in the app and an operator runs `scripts\setup-n8n-automation.ps1` on the machine where n8n is installed (10.11). Supports the local inbox folder. |

- Self-hosted n8n is installed natively on Windows with npm and runs only on `127.0.0.1:5678` (not exposed). Location: `%LOCALAPPDATA%\RightsFlowAI\n8n` (runtime, data, logs, inbox, secrets).

### 10.2 Authentication and safeguards

- **Automation keys:** format `rfa_<key_id>_<secret>`; only an HMAC hash is stored.
  - **Managed mode:** RightsFlow issues the key itself, with exactly the scopes the switched-on automations need, writes it straight into an n8n credential and replaces it automatically 30 days before it expires (validity 180 days). Nobody sees it. Hand-made keys cannot be created.
  - **Self-hosted mode:** an admin creates one under **Settings → Automation → Keys → Create key**. It is **shown only once**. Default validity 90 days (maximum 365), at most 20 per organization.
- Each key gets its own **service account**, which cannot sign in or receive notifications, does not count as a seat, and appears in the audit log as "done by automation".
- Automation acts with temporary **manager-level** permissions only.
- **Scopes:** automation:read, runs:write, events:consume, statements:import, statements:review, contracts:read, notifications:send, reports:deliver, ai:review.
- **Instance binding:** a key is bound to the first n8n instance that uses it. Another n8n using the same key gets 409 `instance_conflict`. If the old n8n is gone, an admin clicks **Release instance** (never automatic).
- **No double processing:** every change request carries an `Idempotency-Key`, so retries are not processed twice.
- **Event outbox:** events are written in the same transaction as the business change, and n8n takes them under a lease. If n8n dies midway, the lease expires and the event is taken again. After 5 failures an event becomes `dead` and an admin can requeue it. Organizations without an automation key get no events, and pending events older than 30 days are marked `expired` (not deleted).
- **Incidents:** identical failures (workflow + category + node) are grouped into one incident. The first occurrence alerts admins; repeats within 60 minutes are only counted; after that, one reminder per window; the 10th occurrence escalates to owners; the next success sends one "Recovered:" notice.

### 10.3 The eight workflows at a glance

The n8n editor (`http://localhost:5678`) currently contains eight workflows.

| # | Name (as shown in n8n) | ID | Trigger | Current state | Kind |
|---|---|---|---|---|---|
| 1 | RightsFlow - A. Royalty statement import | `RfWfRoyaltyImprt` | Manual / every 15 minutes | Inactive | Business |
| 2 | RightsFlow - B. Contract expiration reminders | `RfWfContractExpr` | Manual / daily 07:00 UTC | Inactive | Business |
| 3 | RightsFlow - C. AI metadata and rights review | `RfWfAiReview0001` | Manual / every 30 minutes | Inactive | Business |
| 4 | RightsFlow - D. Monthly royalty report | `RfWfMonthlyRprt1` | Manual / 2nd of each month 06:00 UTC | Inactive | Business |
| 5 | RightsFlow - E. Automation health check | `RfWfHealthCheck1` | Manual / hourly | Inactive | Business (monitoring) |
| 6 | RightsFlow - Automation error handler | `RfWfErrorHandler` | When another workflow fails | **Active** | Error handling |
| 7 | RF DIAG - schedule probe (temporary) | `RfDiagSchedProbe` | Every minute | Inactive | **Temporary diagnostic (delete recommended)** |
| 8 | RF DIAG - failing probe (temporary) | `RfDiagFailProbe` | Every minute (fails on purpose) | Inactive | **Temporary diagnostic (delete recommended)** |

Common structure of the business workflows:
- The **Config** node holds the API URL, inbox path, n8n URL and instance ID (filled in by the setup script). No secrets are in the workflows; the key lives only in the encrypted n8n credential "RightsFlow automation key".
- **Start run → … → Finish run:** each execution leaves a run record in RightsFlow (`automation_runs`; Settings → Automation → Runs).
- HTTP nodes retry up to 3 times, 5 seconds apart (fixed interval). Longer outages are handled by the API's retries with backoff.
- On failure, the error handler (workflow 6) runs.

### 10.4 Workflow A — Royalty statement import

**Purpose:** process statement files dropped in the inbox folder and statements uploaded in the app, and turn whatever needs a person into review tasks. **It never posts to the ledger.**

```
Config → Start run → Read inbox files ─┬─(files)→ Describe file → Upload statement ─┐
                                       └─(none)─────────────────────────────────────┴→ Claim statement events
→ Collect statements → Anything to process? ─(yes)→ Start processing → Wait for processing
                                             │        → Review results → Summarize → Finish run
                                             └─(no)───────────────────────────────→ Finish run
```

1. **Read the inbox:** every file in `%LOCALAPPDATA%\RightsFlowAI\n8n\inbox`. File name rule:
   `<source_category>__<source name>__<YYYY-MM>[__<currency>].csv` or `.xlsx`
   Example: `distributor__Distro Inc__2026-09__USD.csv`
   (categories: streaming, distributor, publishing_admin, pro, mechanical, licensing, manual_adjustment)
2. **Upload:** the same checks as the app (type, size, archive bombs, parsing, duplicates). CSV and XLSX are supported (tested with real fixtures; XLSX amounts stay exact, formulas are not executed). Legacy `.xls` is rejected.
   - Each file gets an outcome by SHA-256: imported / duplicate / rejected (with reason).
   - A rejected file creates a review task and notification **only once**; later runs only report it as `seen_before`.
   - Files are not moved out of the inbox (a person deletes them when done).
3. **App events:** `statement.uploaded` and `statement.ready`. **Statements uploaded in the app are not processed until a person confirms the column mapping** (`awaiting_mapping`). Confirming creates a `statement.ready` event and the next run processes it.
4. **Processing state** (`automation_statement_states`):
   - Temporary failure (lost connection, timeout, deadlock) → `retry_waiting`, every 15 min × 2^(attempt−1), at most 3 attempts.
   - Permanent failure (bad data) or retries used up → `needs_manual_review`; managers are notified once. Resume with **Settings → Automation → Statements → Retry**.
   - Inbox statement with an unusable mapping → `awaiting_mapping` plus a mapping task.
5. **Review results:** a draft calculation is made so held money is visible; unmatched, invalid and held (by reason) counts are reported in one review task per statement, and managers are notified (not again if nothing changed).

### 10.5 Workflow B — Contract expiration reminders

**Purpose:** remind managers about contracts 30, 14 and 7 days before they end and when they have expired.

```
Config → Start run → List expiring contracts → Plan reminders → Any reminders due? ─(yes)→ Send reminder → Summarize → Finish run
                                                                                  └─(no)──────────────→ Finish run
```

- The thresholds are `thresholds = [30, 14, 7]` in Config. For each contract, the tightest threshold reached is chosen (0 if already expired).
- The API re-checks that a reminder is really due and sends it **only once** per contract, end date and threshold (re-runs don't repeat). With no recipients the delivery is `skipped`.
- The app's own daily job warns once at the organization's warning window (default 60 days). B adds the 30/14/7-day and expiry reminders.
- Tested: 3 reminders sent for 7-day, 30-day and expired contracts; a re-run gave 3 duplicates; a far-off contract was skipped; an organization with nothing due finished with 0.

### 10.6 Workflow C — AI metadata and rights review

**Purpose:** review new works and recordings, requested reviews and serious rights conflicts with AI, producing **pending suggestions** or **advisory explanations**.

```
Config → Start run → Claim review events → Collect subjects → Anything to review? ─(yes)→ AI review → Record human decisions → Summarize → Finish run
                                                                                   └─(no)─────────────→ Record human decisions
```

- Events taken: `work.created`, `recording.created`, `review.requested` (the **Request automated review** button), `rights_conflict.opened` (high/critical).
- AI review, one item every 0.5 seconds:
  - Works, recordings, parties → metadata cleanup **suggestions** (pending) plus deterministic validation issues.
  - Rights conflicts → an AI **explanation** stored as an advisory note. The conflict itself is not changed.
- Outcomes: suggested, explained, no_changes, ai_unavailable (no provider, or plan without AI), ai_limit_reached, ai_error.
- **Record human decisions:** once a person has approved or rejected every suggestion in the app, the review task is closed.
- The workflow never applies anything itself.

### 10.7 Workflow D — Monthly royalty report

**Purpose:** on the 2nd of each month, generate last month's report and notify admins and owners.

```
Config → Start run (business key monthly:<type>:<YYYY-MM>) → Already delivered? ─(yes)→ Nothing to do
                                                                                 └─(no)→ Request report → Wait for report → Notify recipients → Summarize → Finish run
```

- Default report type `revenue_by_source`; the period is the previous calendar month (only completed months).
- Figures are produced by the app's existing report job from RightsFlow data. n8n never sees or computes them.
- The notification carries a link, not figures. Recipients are active admins and owners only.
- Each month is delivered only once (business idempotency key). If the report is not ready yet (`report_not_ready`), it retries 5 times, 10 seconds apart.

### 10.8 Workflow E — Automation health check

**Purpose:** every hour, check n8n, the API, the database, automation key expiry, the outbox, runs and incidents.

```
Config → Check n8n → Check API → Check automation API → Diagnose → API reachable? ─(yes)→ Start run → Finish run → Problems found? ─(yes)→ Alert admins
                                                                                   └─(no)──→ Fail loudly
```

- Result levels: healthy / warning / critical.
- **Key expiry:** warning at 14 days or less, critical at 3 days or less (settings `AUTOMATION_CREDENTIAL_WARNING_DAYS`, `_CRITICAL_DAYS`).
- Problems reported by the API: dead events, jobs running over 6 hours, failed runs with no later success, open incidents of other workflows.
- Problems open an incident and alert admins (repeats suppressed).
- If the API is unreachable or rejects the key (401/403) or the instance (409), there is nowhere to record anything, so the **execution itself fails**, visibly in n8n's execution list and through the error handler.
- The backend's daily maintenance job also warns admins about expiring keys, independently of n8n. `scripts\check-n8n.ps1` gives the same diagnosis locally.

### 10.9 Workflow 6 — Automation error handler

- Run by the n8n server when another workflow fails. It works **only when active (published)** and has no schedule. The setup script activates it automatically.
- It calls `POST /automation/alerts` with the workflow name, execution ID, last node and error message.
- The API removes secrets, marks the run failed, writes an audit entry, and groups the failure into an incident (first alert, suppression, escalation, recovery).
- Tested inside the n8n server: a workflow failing every minute → the error handler ran → one incident, one alert, repeats suppressed.
- Note: failures of workflows run from the command line (CLI) may not reach the error handler. Production runs use the server's schedules.

### 10.10 Workflows 7 and 8 — temporary diagnostics (RF DIAG)

- Created during the 2026-10-14 n8n audit to prove that schedules and the error handler really work inside the n8n server.
  - **schedule probe:** runs every minute and leaves a run record.
  - **failing probe:** calls a closed port on purpose to fail and trigger the error handler.
- Both are **inactive** and do nothing now. They have nothing to do with the business, so **deleting them in the n8n editor is recommended**. The same checks now run as automated tests in a separate test instance (port 5688).

### 10.11 Setting up and activating n8n (self-hosted mode only)

> This section applies to `AUTOMATION_MODE=self_hosted` (development, single machine). On a deployed server (managed mode) nobody runs these steps per organization: see 10.13.

```powershell
# 1) Install (once; needs Node.js 24)
powershell -ExecutionPolicy Bypass -File scripts\install-n8n.ps1

# 2) Start (or start everything with start-local-automation.ps1)
powershell -ExecutionPolicy Bypass -File scripts\start-n8n.ps1
# Create the n8n owner account at http://localhost:5678 (separate from RightsFlow accounts).
# If the page keeps spinning, reload it (F5).

# 3) In RightsFlow an admin opens Settings → Automation → Keys → Create key and copies the key (shown once)

# 4) Connect (Read-Host keeps the key out of shell history)
$key = Read-Host 'Automation key'
powershell -ExecutionPolicy Bypass -File scripts\setup-n8n-automation.ps1 -Token $key

# 5) Check
powershell -ExecutionPolicy Bypass -File scripts\show-n8n-config.ps1

# 6) Activate — for a real organization only after the client explicitly approves
powershell -ExecutionPolicy Bypass -File scripts\activate-n8n-workflows.ps1 -OrganizationId <organization ID> -Confirm
# To stop: activate-n8n-workflows.ps1 -Deactivate
```

- The setup script verifies the key (including the instance), refuses to silently switch to another organization (needs `-AllowOrganizationChange`), backs up the previous key, creates the n8n credential, imports the six workflows (business workflows stay inactive), activates the error handler, and records the connection (`secrets\connection.json`, no secrets).
- The activation script refuses when there is no recorded connection, the organization ID differs, `-Confirm` is missing, the organization is a test one, or the key is rejected, bound elsewhere or expires within 3 days.
- **Key rotation:** Settings → Automation → Keys → Rotate key (the old key keeps working during the grace period) → run the setup script again with the new key. Active workflows stay active.
- **Inbox:** files dropped into `%LOCALAPPDATA%\RightsFlowAI\n8n\inbox` with the naming rule above are processed within 15 minutes.

### 10.12 n8n scripts

| Script | Purpose |
|---|---|
| `install-n8n.ps1` | Installs the pinned n8n 2.43.5 with npm; creates folders and the encryption key |
| `start-n8n.ps1` / `stop-n8n.ps1` | Starts n8n / stops only the process it started |
| `setup-n8n-automation.ps1` | Connects to RightsFlow with a key and imports workflows (`-Mode operational\|test`) |
| `activate-n8n-workflows.ps1` | Activates or deactivates the business workflows (organization ID and `-Confirm` required) |
| `show-n8n-config.ps1` | Shows the connected organization, mode, key expiry, instance binding and workflow states (never prints the key) |
| `check-n8n.ps1` | Diagnoses ports, services and key status (exit code 1 when critical) |
| `start-local-automation.ps1` / `stop-local-automation.ps1` | Checks MariaDB and starts/stops API + web + n8n together |
| `test-n8n-smoke.ps1` | Workflow lint, environment check, automation tests (`-Live` adds the live test) |
| `n8n_live_test.py` | End-to-end test with real n8n, API and database in a separate test instance (5688). **Refuses to run when real email or paid AI is configured** |
| `automation/n8n/build_workflows.py` | The workflow JSON generator (change workflows here). Also writes the managed-mode templates |

### 10.13 Managed mode (deployments)

**What the organization sees.** In **Settings → Automation → Automations** an owner or admin finds four cards: Statement processing (workflow A), Contract expiration reminders (B), AI metadata and rights review (C) and Monthly royalty report (D). Each card has an on/off switch, its schedule, the next and the last run, **Settings** and **Run now**. Nothing else is needed: no keys, no scripts, no n8n account.

| Card | Settings |
|---|---|
| Statement processing | Process uploads right away (default on), interval 15/30/60/120 minutes |
| Contract expiration reminders | Reminder thresholds in days (default 30, 14, 7), time of day (UTC) |
| AI metadata and rights review | Interval 30/60/120/360 minutes |
| Monthly royalty report | Report type, day of the month (1–28), time of day (UTC) |

**What happens behind the switch.** RightsFlow provisions everything in the platform n8n through n8n's public API, in a background job (status "Setting up" for a few seconds):

1. A managed automation key with exactly the scopes the switched-on automations need, stored only in an n8n credential.
2. A second n8n credential that authenticates the "Run on request" webhooks. Its secret is derived from the server's key and never stored.
3. The error handler, the hourly health check, and one workflow per switched-on automation, named `RightsFlow [<organization slug>] - …`, filled in with the organization's settings and published. Each organization gets a stable minute offset so organizations don't all start at the same minute.
4. Switching an automation off deletes its workflow; switching everything off (or archiving the organization) deletes all of them and the credentials, and revokes the key.

**Statements without an inbox folder.** In managed mode statements arrive through the app's upload wizard. With "Process uploads right away", RightsFlow starts workflow A about 10 seconds after an upload (one start covers several uploads made in the same moment). As before, a statement uploaded in the app is only processed once a person has confirmed its column mapping.

**Self-healing.** Every hour, and after every change, RightsFlow compares what should exist with what n8n holds: missing or unpublished workflows are recreated, settings changes are applied, and the key is replaced before it expires. If n8n can't be reached, the card shows "Needs attention" with the reason and the job retries with backoff; **Check again** starts a check immediately.

**Results.** Every run appears under **Runs**. **Results** on a run lists what it produced, with links: the statements it processed, the review tasks it raised, the notifications it sent, and report files to download (the monthly report CSV).

**Hand-made keys from before.** If an organization still has keys created by hand, an **Old keys** tab lists them so an admin can revoke them. They cannot be rotated and no new ones can be created.

**Operator setup (once per server).** Install and start n8n next to the API (internal network only), create an API key in n8n (**Settings → n8n API**), then set `AUTOMATION_MODE=managed`, `N8N_API_URL`, `N8N_API_KEY` and `AUTOMATION_API_URL` in `backend/.env` (11.4) and restart the backend. Details and checks: `docs/N8N_MANAGED_MODE.md`.

---

## 11. Installation and configuration

### 11.1 Prerequisites

| Item | Version |
|---|---|
| Windows 10/11 | |
| Python | 3.13 |
| Node.js / npm | 24.x / 11.x |
| XAMPP (MariaDB) | 10.4 or later; **MySQL → Start** in the XAMPP Control Panel |
| Disk | About 1.5 GB on C: if n8n is used |

### 11.2 Backend

```powershell
cd backend
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
copy .env.example .env          # edit DATABASE_URL, JWT_SECRET_KEY, etc.
cd ..
backend\.venv\Scripts\alembic.exe upgrade head      # run from the repository root
cd backend
.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000
```

- API docs: `http://127.0.0.1:8000/docs` (disabled when `APP_ENV=production`).
- Health: `GET /health` (alive), `GET /health/ready` (database reachable).
- The background worker runs inside the API process by default (`RUN_EMBEDDED_WORKER=true`). To run it separately, set it to `false` and run `python -m app.worker`.

### 11.3 Frontend

```powershell
cd frontend
npm install
copy .env.example .env.local     # BACKEND_URL=http://127.0.0.1:8000
npm run dev                      # http://localhost:3000
```

Production mode: `npm run build`, then `npm run start`.

### 11.4 Main `backend/.env` settings

| Group | Variable (default) | Meaning |
|---|---|---|
| App | `APP_ENV` (development) | development / test / staging / production. Production disables API docs, enables HSTS and enforces a strong JWT secret |
| Database | `DATABASE_URL` (required) | e.g. `mysql+pymysql://root:@127.0.0.1:3306/rightsflow_ai` |
| Auth | `JWT_SECRET_KEY` (required, 32+ characters) | Signing secret |
| | `ACCESS_TOKEN_EXPIRE_MINUTES` (30), `REFRESH_TOKEN_EXPIRE_DAYS` (14) | Token lifetimes |
| | `PASSWORD_RESET_EXPIRE_MINUTES` (60), `EMAIL_VERIFICATION_EXPIRE_HOURS` (48), `INVITATION_EXPIRE_DAYS` (7) | Link validity |
| | `REQUIRE_EMAIL_VERIFICATION` (false) | true blocks sign-in until the email is verified (recommended in production) |
| Rate limits | `AUTH_RATE_LIMIT_ATTEMPTS` (10), `AUTH_RATE_LIMIT_WINDOW_SECONDS` (60) | Sign-in attempt limits |
| HTTP | `CORS_ORIGINS`, `FRONTEND_URL` (http://localhost:3000), `TRUSTED_PROXY_COUNT` (0) | Allowed origins, link base for emails, number of proxies |
| Storage | `STORAGE_BACKEND` (local), `STORAGE_LOCAL_PATH`, `STORAGE_MAX_UPLOAD_MB` (25), `FILE_PURGE_AFTER_DAYS` (30), `S3_*` | File storage |
| Email | `EMAIL_PROVIDER` (console), `EMAIL_FROM`, `EMAIL_OUTBOX_PATH`, `SMTP_HOST/PORT/USERNAME/PASSWORD/USE_TLS` | console **does not send**; it writes .eml previews to `backend/storage/dev-outbox/` |
| AI | `AI_PROVIDER` (none), `AI_API_KEY`, `AI_MODEL`, `AI_BASE_URL`, `AI_WORKSPACE_ID`, `AI_TOKEN_LIMIT_PARAM`, `AI_EFFORT`, `AI_TIMEOUT_SECONDS`, `AI_MAX_RETRIES`, `AI_MAX_OUTPUT_TOKENS`, `AI_REFUSAL_FALLBACK`, `AI_INPUT/OUTPUT_COST_PER_MTOK` | See chapter 9 |
| Billing | `BILLING_PROVIDER` (manual), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | manual charges nothing |
| Jobs | `RUN_EMBEDDED_WORKER` (true), `WORKER_POLL_INTERVAL_SECONDS` (2), `JOB_STALE_AFTER_MINUTES` (15) | Background jobs |
| Automation | `AUTOMATION_KEY_PEPPER`, `AUTOMATION_RATE_LIMIT_PER_MINUTE` (600), `AUTOMATION_CREDENTIAL_WARNING_DAYS` (14), `AUTOMATION_CREDENTIAL_CRITICAL_DAYS` (3), `AUTOMATION_ALERT_SUPPRESSION_MINUTES` (60), `AUTOMATION_ALERT_ESCALATION_OCCURRENCES` (10), `AUTOMATION_STATEMENT_MAX_ATTEMPTS` (3), `AUTOMATION_STATEMENT_RETRY_BASE_MINUTES` (15), `AUTOMATION_PENDING_EVENT_RETENTION_DAYS` (30), `AUTOMATION_INSTANCE_STALE_HOURS` (24) | n8n-related |
| Automation mode | `AUTOMATION_MODE` (managed) | managed: RightsFlow provisions each organization's n8n workflows (deployments, 10.13). self_hosted: keys and setup script by hand (development, 10.11) |
| Platform n8n (managed) | `N8N_API_URL` (e.g. `http://n8n.internal:5678/api/v1`), `N8N_API_KEY` | n8n's public API and the API key created in n8n under Settings → n8n API. Without both, the Automations tab says automation isn't set up on this server |
| | `AUTOMATION_API_URL` (http://127.0.0.1:8000) | The address the platform n8n uses to reach this API (internal) |
| | `N8N_WEBHOOK_URL`, `N8N_HEALTH_URL` (derived from `N8N_API_URL`), `N8N_INSTANCE_ID` (rf-platform-n8n), `N8N_TIMEOUT_SECONDS` (15) | Webhook base for "Run now", the health URL the health check calls, the instance id workflows send |
| | `AUTOMATION_MANAGED_KEY_LIFETIME_DAYS` (180), `AUTOMATION_MANAGED_ROTATE_BEFORE_DAYS` (30) | Validity of keys RightsFlow issues for its n8n, and how early they are replaced |
| Monitoring | `ERROR_MONITORING_DSN` | Sentry-compatible error monitoring (optional) |

- `.env` is excluded from version control (`.gitignore`). **Never put real keys in `.env.example`.**
- Restart the backend after changing `.env`.

### 11.5 Frontend `.env.local`

| Variable | Meaning |
|---|---|
| `BACKEND_URL` | Backend address (server-side only; default `http://127.0.0.1:8000`) |
| `APP_ORIGIN` | Public origin for the CSRF origin check behind a proxy (optional) |
| `COOKIE_SECURE` | Force the cookie Secure flag (optional; true behind HTTPS in production) |
| `TRUSTED_PROXY_HOPS` | Number of proxies in front (default 0) |

### 11.6 Turning on real email

```
EMAIL_PROVIDER=smtp
EMAIL_FROM=RightsFlow AI <no-reply@your-domain>
SMTP_HOST=...
SMTP_PORT=587
SMTP_USERNAME=...
SMTP_PASSWORD=...
SMTP_USE_TLS=true
```

- In SMTP mode a background job sends each email, retrying up to 5 times. Status becomes sent or failed.
- Note: in the 2026-10-14 tests SMTP authentication failed (535). Send a test to your own address before going live.

---

## 12. Plans and limits

All plans are **development plans** with no price set (nothing is charged). New organizations default to Professional.

| Code | Name | Users | Catalog items | Statement imports / month | AI requests / month | Storage | Advanced reporting | AI |
|---|---|---|---|---|---|---|---|---|
| `dev-starter` | Starter | 3 | 500 | 5 | 50 | 1 GB | – | ✓ |
| `dev-professional` | Professional | 10 | 10,000 | 50 | 500 | 10 GB | ✓ | ✓ |
| `dev-business` | Business | 50 | 100,000 | 500 | 5,000 | 100 GB | ✓ | ✓ |
| `dev-enterprise` | Enterprise | unlimited | unlimited | unlimited | unlimited | unlimited | ✓ | ✓ |

- How usage is counted: users = active members + pending invitations; catalog = non-archived works + recordings + releases (parties excluded); imports = statements created this calendar month (UTC); AI = AI records this month; storage = total of non-deleted files.
- Over a limit: HTTP 402 `plan_limit_exceeded` ("Your <plan> plan allows N …"). Missing feature: 402 `feature_not_available`. A plan change is blocked with 409 if current usage exceeds the new plan's limits.
- **Stripe** billing is prepared in code (`BILLING_PROVIDER=stripe`) but has never been tested for real.
- "Advanced reporting" is shown, but no backend code enforcing it was found.
- Plans are defined in `backend/app/services/billing.py` and displayed from `frontend/src/lib/plans.ts`.

---

## 13. Background jobs, notifications and email

### 13.1 Background jobs

The `background_jobs` table is the queue. Failures are retried every 15 s × 2^(attempt−1), 3 times by default; jobs silent for more than 15 minutes are requeued.

| Job type | Started by | What it does |
|---|---|---|
| `royalty_import` | Statement Process | Parses, validates and matches a statement |
| `catalog_import` | Catalog import | Bulk import (dry run or real) |
| `contract_analysis` | AI analysis request | AI contract extraction (retried up to 3 times on timeouts/rate limits) |
| `report_generation` | Report CSV export, n8n D | Generates report files |
| `rights_conflict_scan` | Split rule changes, party merges | Organization-wide conflict rescan |
| `email_delivery` | Each email (SMTP mode) | Sends, up to 5 attempts |
| `contract_expiry_check` | Daily, per organization | Contract expiry and warnings |
| `storage_purge` | Daily | Deletes the bytes of files deleted 30+ days ago (metadata kept) |
| `automation_maintenance` | Daily | Cleans automation records, expires old events, warns about expiring hand-made automation keys (managed keys are replaced automatically) |
| `automation_reconcile_all` / `automation_reconcile` | Hourly / after every change | Managed mode: makes the platform n8n match each organization's automation settings, repairs drift, replaces keys before expiry |
| `automation_trigger` | After an upload | Managed mode: starts statement processing (or a requested AI review) right away |

### 13.2 Notifications

- In-app notifications are always kept. Each user chooses per type whether to also get an email (Profile).
- Email-capable types (default): payout_approval_request (on), contract_expiration (on), rights_conflict (on), import_failed (on), contract_analysis_failed (on), ownership_transferred (on), import_completed (off), royalty_processing_completed (off), contract_analysis_completed (off), invitation_accepted (off), report_ready (off), automation_review (on), automation_failed (on, admins), monthly_report (on, admins).
- Service accounts and former members are not notified.
- Single-use tokens (reset and verification links) are masked in stored email bodies.

---

## 14. Security

| Item | Details |
|---|---|
| Passwords | Argon2 hashes. 12–128 characters, letter + number/symbol, 5+ distinct characters, different from the email |
| Sign-in protection | 10 per 60 s per IP, (email + IP) limits, 50 per 15 min per account. Unknown emails take the same time, hiding whether an account exists |
| Tokens | Access token (JWT, 30 min) + refresh token (opaque, 14 days, replaced on each use). Reusing an already-used refresh token revokes that whole session family |
| Sessions | Sign out, sign out everywhere, revoke individual sessions. Password change or reset revokes all sessions |
| Browser | Tokens only in httpOnly cookies (invisible to JavaScript). Double-submit CSRF token + Origin check. CSP, X-Frame-Options DENY, nosniff and other security headers |
| Tenant isolation | Every query is filtered by organization ID. Non-members get 404 |
| Files | Extension allow-list, file signature (magic number) check, archive-bomb checks, server-generated storage keys, downloads only after permission checks with a sandbox CSP |
| Automation keys | HMAC hashes, scopes, expiry, rotation and revocation, instance binding, request rate limits |
| Audit | Audit entries are written in the same transaction as the business change |
| Accepted risks | Registration reveals that an email is already registered (A-05b). Deleting an organization directly in SQL cascades into financial and audit tables (no API path does this, D-15) |

---

## 15. Operations: start, stop, back up, test

### 15.1 Start and stop

```powershell
# Start everything: check MariaDB → FastAPI (8000) → Next.js (3000) → n8n (5678)
powershell -ExecutionPolicy Bypass -File scripts\start-local-automation.ps1
# Stop everything (only what the script started)
powershell -ExecutionPolicy Bypass -File scripts\stop-local-automation.ps1
```

If you started things by hand, stop each one with Ctrl+C in its window.

### 15.2 Backups

The complete database backup is `database/rightsflow_ai.sql` (schema + data, migration `c1120d7d8e4a`). It creates the `rightsflow_ai` database by itself, so it restores on another computer with `mysql -u root -p < database/rightsflow_ai.sql` or a phpMyAdmin import. `database/README.md` has the restore steps and the `.env` values to carry over (`JWT_SECRET_KEY`). The file is in `.gitignore` because it holds account data.

To refresh it:

```powershell
C:\xampp\mysql\bin\mysqldump.exe -h127.0.0.1 -uroot --single-transaction --routines --triggers --events --hex-blob --default-character-set=utf8mb4 --skip-dump-date --databases rightsflow_ai > database\rightsflow_ai.sql
```

- The old per-migration dumps in `backend/storage/backups/` were replaced by this single file on 2026-10-16.
- Uploaded files are in `backend/storage/files/` (local storage) and must be backed up together with the database.
- n8n: stop n8n, then compress `%LOCALAPPDATA%\RightsFlowAI\n8n\data` and `secrets` together (data cannot be decrypted without secrets). Keep that archive as safe as a password.

### 15.3 Running tests

| Target | Command | Latest result (2026-10-15) |
|---|---|---|
| Backend, all | `cd backend; .venv\Scripts\python.exe -m pytest` (uses a separate `_test` database) | 333 of 334 passed, 1 failed (see note) |
| Backend AI | `pytest tests/test_ai_provider.py tests/test_ai.py` | 48 passed (with default cost settings) |
| Frontend type check | `npm run typecheck` | 0 errors |
| Frontend lint | `npm run lint` | 0 problems |
| Frontend unit tests | `npm run test` | 266 passed |
| Frontend build | `npm run build` | Success |
| End-to-end | `npm run test:e2e` (needs the backend on 8000) | Not run in this work |
| n8n smoke test | `scripts\test-n8n-smoke.ps1` | Passed |

> **Note — one environment-dependent test:** `tests/test_ai.py::test_usage_and_cost_tracking` assumes the default AI cost settings (input 4.0, output 20.0). `backend/.env` currently has OpenAI prices (0.15 / 0.60), so only this test fails. It is not a code defect. It passes when the defaults are set:
> `$env:AI_INPUT_COST_PER_MTOK='4.0'; $env:AI_OUTPUT_COST_PER_MTOK='20.0'; .venv\Scripts\python.exe -m pytest`
> The proper fix is to pin these two values in the test setup (`tests/conftest.py`), which is a code change.

To regenerate the API types: `backend\.venv\Scripts\python.exe scripts\export_openapi.py` → `cd frontend; npx openapi-typescript ../docs/openapi.json -o src/lib/api/schema.d.ts`.

### 15.4 Logs

| What | Where |
|---|---|
| Backend | The uvicorn window, or `%LOCALAPPDATA%\RightsFlowAI\logs\api.stderr.log` (when started by the script) |
| n8n | `%LOCALAPPDATA%\RightsFlowAI\n8n\logs\n8n.log`, and Executions in the n8n editor (kept 14 days) |
| Development email | `backend/storage/dev-outbox/*.eml` |
| Business records | Audit log, Background jobs and Automation (Runs, Incidents) screens |

---

## 16. Current state and known limitations

### 16.1 Current environment (as of 2026-10-15)

| Item | State |
|---|---|
| Main organization | **RightsFlow Music Publishing** (slug `rightsflow-music-publishing`), plan Professional (Development) |
| Main organization data | Only 3 parties; no works, recordings, statements or contracts → enter sample data before a demo (`docs/samples/sample-distributor-statement.csv` and its README) |
| Owner account | `spider10584329@gmail.com` (changed from `admin@gmail.com` on 2026-10-15; email not yet verified) |
| Cleaned up | Two empty "string" organizations deleted (backup: `backend/storage/backups/deleted_string_organizations_20261015T030901.json`). On 2026-10-16 all test data was removed: 80 E2E/QA/test organizations (including the manual test organization "aaa"), their users and their uploaded files, plus the 9 `rightsflow_*_test` databases. The database now holds 1 organization, 4 users (the owner and 3 automation service accounts) and the 4 plans |
| AI | OpenAI `gpt-4o-mini`, connected ("Connected") |
| Email | console mode (nothing is actually sent) |
| Billing | manual (nothing is charged) |
| Database | Latest migration `c1120d7d8e4a` (managed automation), 53 tables. Full backup: `database/rightsflow_ai.sql` (15.2) |
| Automation mode | `AUTOMATION_MODE` is not set in `backend/.env`, so the server runs in **managed** mode (the default). `N8N_API_URL` / `N8N_API_KEY` are not set yet, so the Automations tab says automation isn't set up on this server. To use the local n8n as the platform n8n: create an API key in n8n (Settings → n8n API) and set both values (10.13). To keep the old hand-made setup instead: `AUTOMATION_MODE=self_hosted` |
| n8n operational instance | Installed and running. **Not yet connected to the real organization** (the old test organization's key was deleted with the test data on 2026-10-16). The 5 business workflows are inactive; only the error handler is active. The 2 temporary diagnostic workflows remain |
| Leftover test data | None. Running the backend tests recreates `rightsflow_ai_test` automatically |

### 16.2 Limitations to tell the client up front

1. **No real money transfers:** payments are made outside and only recorded (by design).
2. **No currency conversion:** each currency is totalled separately.
3. **No OCR:** scanned PDF or image contracts cannot be read.
4. **No permanent organization delete:** archive only (protects financial and audit records).
5. **No screen for changing an email address:** an operator must do it in the database.
6. **External integrations not verified:** real SMTP sending, S3 storage, Stripe billing and real Anthropic responses (blocked by missing credit) have not been tested against the real services. OpenAI is confirmed connected.
7. **Single server assumed:** rate limiting and token refresh run in-process. Scaling to several servers needs Redis or similar.
8. **Automation timing:** in managed mode an upload is processed about 10 seconds later and **Run now** starts a workflow at once; otherwise workflows follow their schedules (15–30 minutes for polling workflows). In self-hosted mode the workflows are inactive until activated after the client approves.
9. **Inbox folder (self-hosted mode only):** outcomes are recorded but a person deletes the files. Managed mode has no inbox folder; statements are uploaded in the app.
10. **n8n version risk:** n8n warns it will require Docker in future. It is pinned to 2.43.5 and needs reassessment before 3.x.
11. **No "dismiss" button for catalog duplicate candidates** (although the description mentions it).
12. **No API to reverse a paid payout entry:** fix wrong payments with a ledger adjustment.

### 16.3 Remaining work before production (recommended order)

1. Rotate any AI key that has been exposed, in the provider's console.
2. Prepare a demo with sample data (catalog → shares → contract → statement → calculate → post → pay).
3. n8n (managed mode): create an n8n API key, set `N8N_API_URL`, `N8N_API_KEY` and `AUTOMATION_API_URL`, restart the backend, then switch automations on in Settings → Automation after client approval. Delete the 2 temporary diagnostic workflows.
4. Configure real SMTP and send a test email.
5. For production deployment: `APP_ENV=production`, strong secrets, HTTPS, `COOKIE_SECURE`, database backups, error monitoring.

---

## 17. Client questions and change requests

### 17.1 Likely questions and answers

| Question | Answer |
|---|---|
| Why was this money held instead of paid? | Look at the `unallocated` rows' reason codes in the run's allocation table (table in 7.3). Usually: no share, a dispute, no contract term, or an unmatched line. Fix the cause and recalculate. |
| We posted a calculation by mistake. | An admin clicks **Reverse** on the run (reason required). Offsetting ledger entries are written and the statement returns to processed. Fix, recalculate and post again. |
| We uploaded the same statement twice. | Identical files are refused automatically. A different file with the same content is also refused by default. |
| Why is there no Post button? | Only admins and owners see it. Managers see "Awaiting posting". |
| Why can't I approve this payout? | Four-eyes rule: the batch creator can't approve it. Another admin approves, or four-eyes is turned off in organization settings (not recommended). |
| The batch amount is less than the balance. | Amounts are rounded down to the currency's minor unit, and amounts in other open batches are subtracted. Payees on hold or below their minimum are left out. |
| I entered an advance on the contract but it's not in the ledger. | The contract's advance field is informational. Record an **Advance** on the payee page to put it in the ledger. |
| Does the AI change our data by itself? | No. It only suggests, and a manager or higher must approve. AI never changes contract royalty terms. |
| The AI says "Insufficient data". | The catalog has no data for that question (the main organization is almost empty right now). |
| Can other companies using the system see our data? | No. Organizations are fully isolated; non-members can't even tell a record exists (404). |
| We want to delete our organization. | The owner uses Settings → Organization → Archive organization. Data is kept but access is blocked. |
| We want contract expiry reminders more often. | Change the warning days in organization settings, or activate n8n workflow B (30/14/7 days). |
| Does it accept Excel files? | `.xlsx` is supported for statements and catalog imports. Legacy `.xls` must be re-saved as `.xlsx`. |
| Does it calculate fees and taxes? | Not as a separate feature. Express them through contract royalty rates and the net/gross basis. Tax form status is only a note on the payee. |

### 17.2 Where to make common changes

| Request | Where to change | Notes |
|---|---|---|
| Support a new statement format (distributor layout) | `backend/app/services/statement_parsing.py` (`ADAPTERS`, column aliases) | Add statement tests in `backend/tests` |
| Change matching rules | `backend/app/services/royalty_import.py` (`match_line`) | Apply to unposted statements with Re-run matching |
| Change calculation rules | `backend/app/services/royalty_engine.py`, `royalty_runs.py` | **Bump `calculation_version`.** Posted results don't change. Money tests are mandatory |
| Change role permissions | `backend/app/core/permissions.py`, the `OrgViewer/OrgManager/OrgAdmin/OrgOwner` dependencies in `backend/app/api/v1/*.py`; in the UI `frontend/src/lib/roles.ts` and each screen's `can()` | Change backend and UI together |
| Change plan limits | `backend/app/services/billing.py` (plan definitions), `frontend/src/lib/plans.ts` (display) | Applied at startup |
| Default organization settings | `backend/app/schemas/organization.py` (`OrganizationSettings`) | |
| Notification types and defaults | `backend/app/services/notifications.py` | |
| UI text and menus | `frontend/src/components/app-shell/nav-config.ts`, screens in `frontend/src/app/(app)/...`, components in `frontend/src/components/...` | All text in English |
| Add tables or columns | `backend/app/models/*.py` → `alembic revision --autogenerate` → review → `alembic upgrade head` | **Always back up first** and rehearse up/down/up on a test database |
| Add or change APIs | `backend/app/api/v1/*.py`, `backend/app/schemas/*.py` → `scripts/export_openapi.py` → regenerate frontend types (15.3) | |
| Change n8n workflows (schedules, thresholds…) | `automation/n8n/build_workflows.py` → run it to regenerate the JSON → `scripts/diagnostics/n8n_workflow_lint.py` → rerun `setup-n8n-automation.ps1` | Edits made directly in the n8n editor are overwritten on the next import |
| Switch AI provider or model | `AI_*` in `backend/.env` (9.4) | Restart the backend, then Test connection |
| Turn on email sending | `EMAIL_PROVIDER=smtp` and `SMTP_*` in `backend/.env` (11.6) | Test with your own address first |

### 17.3 Ground rules for changes

1. Back up the database before any database change (`mysqldump`).
2. Rehearse migrations on a test database first.
3. Money-related changes must pass the tests (`pytest tests/test_royalties.py` and others).
4. Write code, comments and documents in English.
5. Never put secrets (keys, passwords) in code or `.env.example`.

---

## 18. Error codes and troubleshooting

### 18.1 Common error response

Every API error has the shape `{ "error": { "code", "message", "details" }, "request_id" }`. The "Request ID" shown on screen finds the matching log entry.

| HTTP | Code | Meaning |
|---|---|---|
| 401 | `unauthorized`, `email_not_verified`, `invalid_automation_key` | Sign-in needed, email not verified, automation key problem |
| 402 | `plan_limit_exceeded`, `feature_not_available` | Plan limit or feature |
| 403 | `forbidden`, `csrf_invalid`, `origin_mismatch`, `missing_scope` | Not allowed, security check failed, key scope missing |
| 404 | `not_found` | Not found, or not a member |
| 409 | `duplicate_statement`, `duplicate_identifier`, `duplicate_internal_code`, `stale_calculation`, `statement_has_history`, `contract_in_use`, `term_in_use`, `{type}_in_use`, `share_verified`, `split_rule_violation`, `merge_payee_conflict`, `instance_conflict`, `report_not_ready`, `distinct_approver_required`, `insufficient_balance`, `calculation_not_reconciled` | State, duplicate or reference conflicts |
| 422 | `validation_failed`, `unsupported_file_type`, `file_signature_mismatch`, `file_too_large` | Input errors |
| 429 | `rate_limited` | Too many requests (see `retry_after_seconds`) |
| 502 | `ai_*` | AI provider errors (9.5) |
| 503 | `ai_not_configured`, `billing_not_configured`, `payment_provider_not_configured` | External feature not configured |

### 18.2 What to do when…

| Symptom | Action |
|---|---|
| "We couldn't load your organizations" | Check the backend (8000) is running: `GET /health` |
| Keep getting signed out | Check for revoked sessions or a password change. Check `BACKEND_URL` in the frontend `.env.local` |
| Statement stuck in Queued | Check the background worker (`RUN_EMBEDDED_WORKER`) and Settings → Background jobs |
| Statement processing Failed | Check errors in the Lines tab, Edit mapping and reprocess |
| Post refused after calculating | `stale_calculation`: shares, contracts or the statement changed after the calculation → Recalculate |
| Can't delete a contract | It is referenced by the ledger or shares → terminate it instead |
| Can't delete a catalog item | It is referenced → Archive it |
| Invitation email doesn't arrive | With `EMAIL_PROVIDER=console` nothing is sent. Copy the link from the invitation screen and send it yourself |
| AI errors | Table in 9.5 |
| n8n problems | `scripts\check-n8n.ps1`, `docs/N8N_TROUBLESHOOTING.md` |
| `instance_conflict` | Another n8n uses the same key. If the old instance is gone, an admin clicks Release instance and the setup script is rerun |
| Port in use | Check whether another program uses 3000/8000/5678 (the scripts never stop other programs) |

---

## 19. Appendix: documents and file locations

| Document | Contents |
|---|---|
| `README.md` | Project introduction, quick start |
| `docs/ARCHITECTURE.md` | Architecture (its data model table omits the 9 automation tables) |
| `docs/ROYALTY_ENGINE.md` | Royalty calculation in detail |
| `docs/API.md`, `docs/openapi.json` | API list and specification |
| `docs/DEVELOPMENT.md` | Development environment, troubleshooting |
| `docs/DEPLOYMENT.md` | Production deployment |
| `docs/BACKEND_CONVENTIONS.md` | Backend coding conventions |
| `docs/FINAL_AUDIT_REPORT.md` | Pre-launch audit (verdict: ready for staging or a closed beta, not yet for public production) |
| `docs/IMPLEMENTATION_REPORT.md`, `docs/IMPLEMENTATION_PROGRESS.md` | Implementation history (some items were later superseded) |
| `docs/N8N_*.md` | n8n setup, architecture, workflows, security, test results, troubleshooting, audit, remaining work |
| `database/rightsflow_ai.sql`, `database/README.md` | Complete database backup (not in git) and how to restore it on another computer |
| `docs/samples/` | Sample statement and how to use it |
| `automation/n8n/fixtures/` | Sample statements for n8n tests |

Places where documents disagree (the code is authoritative):
- `frontend/README.md` says token-refresh results are cached for 30 seconds; the code uses 5.
- `docs/ARCHITECTURE.md` lists 5 job types; there are actually 9.
- `docs/DEVELOPMENT.md`'s migration table lacks the latest revision `46e2b483eada`.
- `backend/.env.example` lacks `AI_MAX_OUTPUT_TOKENS`, `AI_REFUSAL_FALLBACK` and the `AUTOMATION_*` settings.

---

*This manual was written on 2026-10-15 from a read-only review of the code and database. When the code changes, update the affected chapters.*
