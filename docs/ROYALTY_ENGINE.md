# Royalty Processing and Accounting

This document describes how RightsFlow AI turns a royalty statement into ledger balances and payouts. Code lives in `backend/app/services/`:

| Stage | Module |
|---|---|
| File parsing and format adapters | `statement_parsing.py` |
| Upload, validation, matching (job `royalty_import`) | `royalty_import.py` |
| Pure allocation engine | `royalty_engine.py` |
| Calculation runs, posting, reversal | `royalty_runs.py` |
| Payees, ledger, balances, advances | `ledger.py` |
| Payout batches | `payouts.py` |
| Reports and CSV exports (job `report_generation`) | `reports.py` |

## 1. Statement lifecycle

```
uploaded ─► queued ─► processing ─► processed ─► calculated ─► posted
                          │                          ▲   │
                          └──► failed                │   └─ reverse ─► processed
                               (re-process allowed)  └── recalculate (unposted runs are discarded)
```

1. **Upload** (`POST /royalties/statements`, multipart). Accepted formats are CSV, TSV, TXT, and XLSX, up to 25 MB and 250,000 rows. The SHA-256 of the file is unique per organization, so uploading the same file twice returns `409 duplicate_statement`. The file is stored privately, the adapter is auto-detected, and a column mapping is suggested.
2. **Preview and mapping** (`GET …/preview`, `PUT …/mapping`). The mapping must include `amount` and at least one identifier: ISRC, ISWC, UPC, or title.
3. **Process** (`POST …/process`, background job). Every row is parsed, validated, and matched:
   - **Amounts** are parsed with locale awareness (`1,234.56`, `1.234,56`, `(12.50)`, `$9`) into `Decimal` with 8 decimal places. Floats are never used. XLSX numbers are read through `repr()`, which avoids binary float artefacts.
   - **Validation.** A row is invalid if the amount is missing or unparseable, the currency is malformed, or it has no identifier. Unknown territories, invalid ISRC/ISWC formats, or unrecognized dates produce warnings only.
   - **Matching**, in order:

     | Match | Confidence |
     |---|---|
     | ISRC → recording | 1.0 |
     | ISWC → work | 1.0 |
     | UPC → single-track release, or the track with the same title | 0.95 |
     | Normalized title + artist (feat./remaster suffixes stripped) | 0.85 |
     | Unique title | 0.6–0.7 |

     Title matching can be disabled per organization (`auto_match_title_artist`).
   - Re-processing replaces the lines of an unposted statement.
4. **Review.** Unmatched lines can be matched manually, one at a time or in bulk by ISRC/title, or marked as ignored. `POST …/rematch` re-runs automatic matching after catalog changes. Any matching change discards stale unposted calculations.
5. **Reconciliation** (`GET …/reconciliation`). It compares matched, unmatched, and ignored amounts with the reported total, and shows totals in other currencies.

New statement formats are added by registering a `StatementAdapter` (header aliases and signature headers) in `ADAPTERS`. Nothing else changes.

## 2. Allocation model

For each valid line (matched or unmatched), the engine produces allocations of three types:

| Type | Meaning |
|---|---|
| `payable` | Owed to an external party. Posted to the ledger. |
| `retained` | Kept by the organization: internal parties, or the remainder after a contract rate. |
| `unallocated` | Held. Needs human action, and the reason is stored. |

**Invariant:** the allocations of a line sum *exactly* to the line amount. The run is rejected if its totals don't reconcile with the statement.

### Steps

1. **Rights type.** The line's own rights type is used first, then the statement default, then a default by source category. Streaming and distributor income defaults to master, PRO to performance, mechanical to mechanical, licensing to sync.
2. **Asset resolution.**
   - Work rights (performance, mechanical, print) need a work. A recording match resolves through its linked work only when there is exactly one.
   - Master and neighbouring rights need a recording.
   - Sync rights use the recording if one is matched, otherwise the work.
3. **Applicable shares.** A share applies when it has the same asset and rights type, is `active`, covers the line's territory (`WORLD` minus exclusions; lines without a territory only match unrestricted `WORLD` shares), and is effective on the line date (transaction date, otherwise the statement period end).
4. **Holds.** The line is unallocated (held) when:
   - no share applies (`missing_ownership`),
   - any applicable share is disputed (`disputed_ownership`), or
   - applicable shares exceed 100% (`over_allocated_ownership`).

   Disputes are never resolved automatically.
5. **Split basis.** This is an organization setting, `allocation_basis`:
   - **`controlled_pro_rata`** (default). Statement income is income for the shares the organization controls. It is divided among the controlled shares in proportion to their percentages.
   - **`gross_share`**. The amount is 100% of the asset's income, and each share receives `amount × share%`. Non-controlled shares (`non_controlled_share`) and unowned remainders (`unassigned_share`) stay unallocated.
6. **Contract rates.** For each share linked to a contract, the engine picks the most specific matching royalty term. Specificity is measured over payee, rights type, source category, and territory, with ties broken by term id. A term applies only while the contract is active, expired, or terminated, and the line date falls inside the contract dates (an auto-renewing contract has no end date).
   - `payable = portion × rate`, and the rest is `retained` (`contract_retention`).
   - A `gross` basis uses the line's gross amount pro-rata when one is present.
   - Without a term, the whole portion is payable.
   - Internal parties' portions are always retained.
7. **Rounding.**
   - Portions use the largest-remainder method at 8 decimal places. Leftover units go to the largest remainders, with ties broken by share id, so results are deterministic.
   - The payable amount is rounded half-even at 8 decimal places, and the retained amount is the exact remainder.
   - Payouts are rounded *down* to whole cents. Sub-cent remainders stay in the ledger balance.
   - Negative lines (refunds, adjustments) are allocated the same way.

## 3. Reproducibility and posting

- Every run stores `calculation_version` and `inputs_hash`, a SHA-256 over every line, share, and term used, plus the basis.
- `POST /runs/{id}/verify` recomputes the run from current data and reports whether the hash and allocations still match.
- **Posting** requires admin. It locks the statement and the run, then recomputes the hash. If ownership or contract data changed since the calculation, it refuses with `409 stale_calculation`.
- On success, posting creates one immutable `earning` ledger entry per payee and currency. Payee profiles are created automatically for parties that don't have one.
- A unique `posting_key` on runs guarantees at most one posted run per statement, and posted lines can no longer change.
- **Reversal** writes offsetting `reversal` entries. It never deletes. The statement returns to `processed` so it can be corrected and recalculated.

## 4. Ledger, recoupment and payouts

- **Balance** is the sum of a payee's ledger entries in each currency. There is no FX conversion.
  - Advances are negative entries. Later earnings recoup them automatically, cross-collateralized per payee and currency.
  - `unrecouped_advances` is the negative part of the balance.
  - `available` is the balance minus amounts committed to open payout batches.
- **Manual adjustments** (±) and **advances** require admin, and they can be reversed exactly once.
- **Payout batches** move through: draft → submitted (`pending_approval`) → approved (admin, by someone other than the batch's creator when `require_distinct_payout_approver` is on) → **recorded as paid**.
  - "Paid" requires an explicit `confirm: true`. It means payment happened *outside* RightsFlow, and only then are negative `payout` ledger entries written.
  - The only payment provider is the internal ledger, which never moves money. `PaymentProvider` is the extension point for future integrations.
- Ledger balances are accounting figures. They are not confirmations of bank payments.

## 5. Tests

- `tests/test_royalty_engine.py` is a set of pure unit tests covering rounding, thirds, negative and tiny amounts, both bases, contract term specificity, gross basis, disputes, over-allocation, territories and dates, work resolution, and fingerprints.
- `tests/test_royalties.py` covers the end-to-end pipeline:
  - adapter detection, duplicate prevention, validation, and matching
  - XLSX imports, manual statements, and reconciliation
  - posting once, immutability, stale-calculation protection, and reversal
  - advances and recoupment, adjustments, the payout workflow and its approval rules
  - reports and exports, RBAC, and tenant isolation
