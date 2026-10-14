# n8n integration test fixtures

Used by `scripts/n8n_live_test.py`, which creates an isolated test organization
(`n8n E2E <timestamp>`), seeds catalog/contract data through the API, and copies
these files into the n8n inbox with names following the intake convention
`<source_category>__<source name>__<YYYY-MM>[__<CUR>].csv`. `PERIOD` is replaced
with the previous calendar month.

| File | Purpose |
|---|---|
| `statement_valid.csv` | 2 matched rows (one share held: draft contract with no terms), 1 unmatched ISRC, 1 invalid amount |
| `statement_app_upload.csv` | Uploaded through the app (JWT) to produce a `statement.uploaded` outbox event |
| `statement_bad_name.csv` | Copied with a non-conforming name: rejected (422) and listed in the run summary |
| `statement_garbage.csv` | Binary junk with a valid name: rejected by file validation (422) |

All amounts are synthetic. No real royalty data.
