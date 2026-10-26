# Database backup

`rightsflow_ai.sql` is the single, complete backup of the RightsFlow AI database
(schema + data). It replaces the per-migration dumps that used to live in
`backend/storage/backups/`.

| | |
|---|---|
| Database | `rightsflow_ai` (the file creates it if it does not exist) |
| Schema version | Alembic `c1120d7d8e4a` (head), so no migration is needed after a restore |
| Server | MariaDB 10.4 or newer (XAMPP, or `mariadb:10.11` from `docker-compose.yml`) |
| Character set | `utf8mb4` / `utf8mb4_general_ci` |
| Size | about 450 KB, under phpMyAdmin's default 2 MB import limit |

Contents: the **RightsFlow Music Publishing** organization, its owner
`spider10584329@gmail.com` (same password as before), its automation service
accounts, the four subscription plans, and the organization's audit and
automation history. All E2E/QA test organizations and users were removed.

> The file holds account emails, password hashes and the audit log, so it is
> listed in `.gitignore`. Copy it to the other computer directly (USB, private
> drive). Do not publish it.

## Restore on another computer

1. Start MariaDB (XAMPP Control Panel → MySQL → Start).
2. Import the file, using either of these:
   - Command line: `mysql -u root -p < database/rightsflow_ai.sql`
     (XAMPP: `C:\xampp\mysql\bin\mysql.exe -u root < database\rightsflow_ai.sql`)
   - phpMyAdmin: **Import** → choose `rightsflow_ai.sql` → **Import**. You do not
     need to select a database first.

   Re-importing is safe: each table is dropped and recreated from the file.
3. Point the backend at it in `backend/.env`:
   ```
   DATABASE_URL=mysql+pymysql://root@127.0.0.1:3306/rightsflow_ai?charset=utf8mb4
   ```
4. Optional check: `alembic check` (run from the project root) should print
   `No new upgrade operations detected.`

## Things that are not inside the SQL file

| Item | What to do |
|---|---|
| `JWT_SECRET_KEY` (in `backend/.env`) | Copy the same value from the old computer. Automation API keys are stored as HMACs keyed by it (or by `AUTOMATION_KEY_PEPPER` if set). With a different value, sign-in still works, but every session ends and n8n automation must be reconnected in **Settings → Automation**. |
| Uploaded files | Copy `backend/storage/files/` (3 files of the main organization). Without them, the database rows exist but downloads fail. |
| n8n workflows | n8n keeps its own data. See Manual.md §15.2 (back up the n8n `data` and `secrets` folders together). |

## Making a new backup

```
C:\xampp\mysql\bin\mysqldump.exe -h127.0.0.1 -uroot --single-transaction --routines --triggers --events --hex-blob --default-character-set=utf8mb4 --skip-dump-date --databases rightsflow_ai > database\rightsflow_ai.sql
```

`--databases` makes the file create and select `rightsflow_ai` by itself, which
lets it run on a fresh server.
============================================================================

backend exec command : .\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000

http://127.0.0.1:5678/ 
 -- mail : sendappp73@gmail.com