"""Live n8n integration test against the local FastAPI + MariaDB (no mocks).

    backend\\.venv\\Scripts\\python.exe scripts\\n8n_live_test.py

Runs in a separate TEST n8n instance (own home, data, encryption key, credential,
instance id and port 5688) under %LOCALAPPDATA%\\RightsFlowAI\\n8n-test. The
operational n8n instance (port 5678) is never touched; the test asserts that.

1. Registers throwaway users and two isolated organizations through the public
   API (``n8n E2E …``) and seeds catalog, ownership, contracts and statements.
2. Configures the test instance (scripts/setup-n8n-automation.ps1 -Mode test)
   and starts its n8n server.
3. Executes every workflow (CLI) and verifies outcomes through the API:
   inbox CSV + XLSX import, explicit rejection of bad files (incl. legacy .xls),
   the mapping-confirmation gate for app uploads, holds for missing contract
   terms, no postings, bounded retry of a failed statement, reminders, AI review,
   monthly report, health warning -> alert -> suppression -> recovery.
4. Server execution (not CLI): a scheduled probe and a failing probe prove that
   schedules fire inside the n8n server and that the error workflow raises one
   incident whose repeats are suppressed (audit N8N-08, N8N-03).
5. Reliability: crashed worker (expired lease), API unreachable, re-runs.
6. Cleanup: revokes the test keys and archives the test organizations.

Real AI and SMTP are not used: the API's configured providers apply
(AI "none" -> the AI-unavailable path; console email -> no real delivery).
Results: automation/n8n/test-results/live-<timestamp>.json
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import secrets
import shutil
import sqlite3
import subprocess
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
API = os.environ.get("RIGHTSFLOW_API_URL", "http://127.0.0.1:8000")
LOCAL = Path(os.environ["LOCALAPPDATA"]) / "RightsFlowAI"
RUNTIME = Path(os.environ.get("RIGHTSFLOW_N8N_RUNTIME", LOCAL / "n8n" / "runtime"))
N8N_BIN = RUNTIME / "node_modules" / "n8n" / "bin" / "n8n"
# Test instance: separate from the operational one in every respect.
N8N_HOME = Path(os.environ.get("RIGHTSFLOW_N8N_TEST_HOME", LOCAL / "n8n-test"))
N8N_PORT, BROKER_PORT, CLI_BROKER_PORT = 5688, 5698, 5699
INBOX = N8N_HOME / "inbox"
OPERATIONAL_HOME = LOCAL / "n8n"
FIXTURES = ROOT / "automation" / "n8n" / "fixtures"
RESULTS_DIR = ROOT / "automation" / "n8n" / "test-results"
PASSWORD = "E2e-" + secrets.token_urlsafe(12) + "!9a"
WORKFLOW_IDS = {
    "health": "RfWfHealthCheck1",
    "royalty": "RfWfRoyaltyImprt",
    "contracts": "RfWfContractExpr",
    "ai": "RfWfAiReview0001",
    "monthly": "RfWfMonthlyRprt1",
}
TEST_ENV = {"RIGHTSFLOW_N8N_HOME": str(N8N_HOME), "RIGHTSFLOW_N8N_PORT": str(N8N_PORT),
            "RIGHTSFLOW_N8N_BROKER_PORT": str(BROKER_PORT), "RIGHTSFLOW_N8N_RUNTIME": str(RUNTIME)}

results: list[dict] = []


def record(name: str, ok: bool, detail: str = "", category: str = "real-local") -> None:
    results.append({"check": name, "ok": ok, "detail": detail, "verified_with": category})
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" - {detail}" if detail else ""), flush=True)


def check(name: str, condition: bool, detail: str = "") -> bool:
    record(name, bool(condition), detail)
    return bool(condition)


# --------------------------------------------------------------------------- API helpers


class Client:
    def __init__(self):
        self.http = httpx.Client(base_url=API, timeout=90)

    @staticmethod
    def jwt(token: str) -> dict:
        return {"Authorization": f"Bearer {token}"}

    def register_and_login(self, label: str) -> dict:
        email = f"n8n-e2e-{label}-{int(time.time())}-{secrets.token_hex(3)}@example.com"
        r = self.http.post("/api/v1/auth/register", json={"email": email, "full_name": f"n8n E2E {label}",
                                                          "password": PASSWORD})
        r.raise_for_status()
        token = self.http.post("/api/v1/auth/login", json={"email": email, "password": PASSWORD})
        token.raise_for_status()
        return {"email": email, "id": r.json()["id"], "headers": self.jwt(token.json()["access_token"])}

    def org(self, user: dict, label: str) -> dict:
        slug = f"n8n-e2e-{label}-{secrets.token_hex(4)}"
        r = self.http.post("/api/v1/organizations", json={"name": f"n8n E2E {label} {date.today()}", "slug": slug},
                           headers=user["headers"])
        r.raise_for_status()
        return r.json()

    def post(self, user: dict, path: str, body: dict, expect=(200, 201, 202)) -> dict:
        r = self.http.post(path, json=body, headers=user["headers"])
        if r.status_code not in expect:
            raise RuntimeError(f"POST {path} -> {r.status_code}: {r.text[:300]}")
        return r.json()

    def get(self, headers: dict, path: str, **params):
        r = self.http.get(path, headers=headers, params=params)
        r.raise_for_status()
        return r.json()


def real_providers() -> list[str]:
    """Providers in backend\\.env that would send real email or make paid AI calls.
    The harness registers users and triggers notifications, so it refuses to run
    against such an API unless explicitly allowed. Run a separate local API with
    EMAIL_PROVIDER=console and AI_PROVIDER=none instead (RIGHTSFLOW_API_URL)."""
    from dotenv import dotenv_values

    if os.environ.get("RIGHTSFLOW_LIVE_TEST_SAFE_API") == "1":  # caller vouches for a console/none API
        return []
    values = dotenv_values(ROOT / "backend" / ".env")
    found = []
    email = (values.get("EMAIL_PROVIDER") or "console").split("#")[0].strip().lower()
    ai = (values.get("AI_PROVIDER") or "none").split("#")[0].strip().lower()
    if email != "console":
        found.append(f"EMAIL_PROVIDER={email}")
    if ai != "none":
        found.append(f"AI_PROVIDER={ai}")
    return found


def api_up() -> bool:
    try:
        return httpx.get(f"{API}/health", timeout=5).status_code == 200
    except httpx.HTTPError:
        return False


def dev_db():
    """Direct DB access, used only to simulate time passing / failures on the
    throwaway test organization's own rows."""
    from dotenv import dotenv_values
    from sqlalchemy import create_engine

    return create_engine(dotenv_values(ROOT / "backend" / ".env")["DATABASE_URL"])


# --------------------------------------------------------------------------- n8n helpers


def _load_env_file(path: Path) -> dict:
    values = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                values[k.strip()] = v.strip()
    return values


def n8n_env(broker_port: int = CLI_BROKER_PORT) -> dict:
    env = dict(os.environ)
    env.update(_load_env_file(ROOT / "automation" / "n8n" / "n8n.settings.env"))
    env.update(_load_env_file(N8N_HOME / "secrets" / "n8n.env"))
    env.update({"N8N_USER_FOLDER": str(N8N_HOME / "data"), "N8N_PORT": str(N8N_PORT),
                "N8N_LISTEN_ADDRESS": "127.0.0.1", "N8N_RUNNERS_BROKER_PORT": str(broker_port),
                "N8N_EDITOR_BASE_URL": f"http://localhost:{N8N_PORT}",
                "N8N_LOG_FILE_LOCATION": str(N8N_HOME / "logs" / "n8n.log"),
                "N8N_RESTRICT_FILE_ACCESS_TO": str(INBOX)})
    return env


def ps(script: str, *args: str) -> int:
    cmd = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ROOT / "scripts" / script), *args]
    return subprocess.run(cmd, env={**os.environ, **TEST_ENV}).returncode


def n8n_running(port: int = N8N_PORT) -> bool:
    try:
        return httpx.get(f"http://127.0.0.1:{port}/healthz", timeout=5).status_code == 200
    except httpx.HTTPError:
        return False


def cli(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["node", str(N8N_BIN), *args], env=n8n_env(), capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=600)


def execute(workflow: str, label: str) -> dict:
    """Run a workflow through the n8n CLI against the test instance's database."""
    started = time.monotonic()
    proc = cli("execute", f"--id={WORKFLOW_IDS[workflow]}", "--rawOutput")
    elapsed = round(time.monotonic() - started, 1)
    output = (proc.stdout or "") + (proc.stderr or "")
    print(f"    n8n execute {workflow} ({label}): exit {proc.returncode} in {elapsed}s", flush=True)
    return {"exit": proc.returncode, "output": output[-6000:], "seconds": elapsed}


def instance_id() -> str:
    return (N8N_HOME / "data" / "rightsflow-instance-id").read_text().strip()


def render(text: str, api_url: str) -> str:
    return (text.replace("__RIGHTSFLOW_API_URL__", api_url)
            .replace("__RIGHTSFLOW_INBOX__", str(INBOX).replace("\\", "/"))
            .replace("__RIGHTSFLOW_N8N_URL__", f"http://127.0.0.1:{N8N_PORT}")
            .replace("__RIGHTSFLOW_INSTANCE_ID__", instance_id()))


def import_workflows(api_url: str, error_handler_url: str | None = None, extra: list[dict] | None = None) -> int:
    """Import the repo workflows (and optional probe workflows) into the stopped
    test instance; publish the error handler."""
    tmp = N8N_HOME / "secrets" / "import-test"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    try:
        for src in (ROOT / "automation" / "n8n" / "workflows").glob("*.json"):
            url = error_handler_url if (error_handler_url and src.name == "automation-error-handler.json") else api_url
            (tmp / src.name).write_text(render(src.read_text(encoding="utf-8"), url), encoding="utf-8")
        for wf in extra or []:
            (tmp / f"{wf['id']}.json").write_text(render(json.dumps(wf), api_url), encoding="utf-8")
        code = cli("import:workflow", "--separate", f"--input={tmp}").returncode
        if code == 0:
            code = cli("publish:workflow", "--id=RfWfErrorHandler").returncode
        return code
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def probe_workflows() -> list[dict]:
    """Two temporary probes for server-mode verification (test instance only)."""
    sys.path.insert(0, str(ROOT / "automation" / "n8n"))
    import build_workflows as bw

    sched = bw.Flow("diag-schedule-probe", "RfTestSchedProbe", "TEST - schedule probe", "Test instance only.")
    trigger = sched.node("Every minute", "scheduleTrigger",
                         {"rule": {"interval": [{"field": "minutes", "minutesInterval": 1}]}}, x=0)
    sched._x = 0
    cfg = sched.node("Config", "code", bw.config("diag-schedule-probe", "Every minute"))
    start = bw.start_run(sched)
    finish = bw.api_node(sched, "Finish run", bw.http(
        "POST", f"{bw.API}/runs/{{{{ $('Start run').first().json.id }}}}/finish", idem="=run-finish-{{ $execution.id }}",
        body="={{ JSON.stringify({ status: 'succeeded', summary: { trigger: $('Config').first().json.trigger } }) }}"))
    sched.chain(trigger, cfg, start, finish)

    fail = bw.Flow("diag-fail-probe", "RfTestFailProbe", "TEST - failing probe", "Fails on purpose.")
    t2 = fail.node("Every minute", "scheduleTrigger", {"rule": {"interval": [{"field": "minutes", "minutesInterval": 1}]}}, x=0)
    fail._x = 0
    boom = fail.node("Call closed port", "httpRequest", bw.http("GET", "http://127.0.0.1:8099/unreachable", auth=False))
    fail.chain(t2, boom)
    return [sched.export(), fail.export()]


def n8n_executions(workflow_ids: tuple[str, ...], since: str) -> list[tuple]:
    db = N8N_HOME / "data" / ".n8n" / "database.sqlite"
    cur = sqlite3.connect(f"file:{db}?mode=ro", uri=True).cursor()
    marks = ",".join("?" * len(workflow_ids))
    return cur.execute(f"select workflowId, mode, status, count(*) from execution_entity "
                       f"where workflowId in ({marks}) and startedAt > ? group by workflowId, mode, status",
                       (*workflow_ids, since)).fetchall()


def operational_fingerprint() -> dict:
    """Hashes of the operational instance's credential and key file (never printed)."""
    out = {}
    key = OPERATIONAL_HOME / "secrets" / "automation-key.txt"
    out["key_file"] = hashlib.sha256(key.read_bytes()).hexdigest() if key.exists() else None
    db = OPERATIONAL_HOME / "data" / ".n8n" / "database.sqlite"
    if db.exists():
        cur = sqlite3.connect(f"file:{db}?mode=ro", uri=True).cursor()
        row = cur.execute("select data from credentials_entity where id='RfAutomationKey1'").fetchone()
        out["credential"] = hashlib.sha256((row[0] if row else "").encode()).hexdigest()
        out["active"] = sorted(r[0] for r in cur.execute("select id from workflow_entity where active=1"))
    conn = OPERATIONAL_HOME / "secrets" / "connection.json"
    out["connection"] = hashlib.sha256(conn.read_bytes()).hexdigest() if conn.exists() else None
    return out


# --------------------------------------------------------------------------- scenario data


def previous_month() -> str:
    first = date.today().replace(day=1)
    return (first - timedelta(days=1)).strftime("%Y-%m")


def seed(c: Client) -> dict:
    owner = c.register_and_login("owner")
    org = c.org(owner, "a")
    o = f"/api/v1/organizations/{org['id']}"
    other_owner = c.register_and_login("other")
    other_org = c.org(other_owner, "b")
    # Keys first: outbox events are only written for organizations that use automation.
    key = c.post(owner, f"{o}/automation/credentials", {"name": "n8n live test", "expires_in_days": 90})
    other_key = c.post(other_owner, f"/api/v1/organizations/{other_org['id']}/automation/credentials",
                       {"name": "n8n live test (other org)", "expires_in_days": 90})

    artist = c.post(owner, f"{o}/parties", {"name": "Nova E2E", "roles": ["artist"]})
    label = c.post(owner, f"{o}/parties", {"name": "Label E2E", "roles": ["label"], "is_internal": True})
    producer = c.post(owner, f"{o}/parties", {"name": "Producer E2E", "roles": ["producer"]})
    writer_a = c.post(owner, f"{o}/parties", {"name": "Writer A E2E", "roles": ["songwriter"]})
    writer_b = c.post(owner, f"{o}/parties", {"name": "Writer B E2E", "roles": ["songwriter"]})
    work = c.post(owner, f"{o}/works", {"title": "Midnight Drive E2E"})
    contested = c.post(owner, f"{o}/works", {"title": "Contested Song E2E"})
    rec1 = c.post(owner, f"{o}/recordings", {"title": "Midnight Drive E2E", "isrc": "USE2E2600001",
                                             "primary_artist_id": artist["id"], "work_ids": [work["id"]]})
    rec2 = c.post(owner, f"{o}/recordings", {"title": "Night Bus E2E", "isrc": "USE2E2600002",
                                             "primary_artist_id": artist["id"]})
    today = date.today()
    deal = c.post(owner, f"{o}/contracts", {
        "title": "Nova E2E recording deal", "contract_type": "recording", "status": "active",
        "start_date": "2025-01-01", "end_date": (today + timedelta(days=6)).isoformat(),
        "rights_granted": ["master"], "royalty_terms": [{"payee_party_id": artist["id"], "rate_percent": "20"}]})
    draft = c.post(owner, f"{o}/contracts", {
        "title": "Producer E2E side letter (draft, no terms)", "contract_type": "recording", "status": "draft",
        "start_date": "2025-01-01", "rights_granted": ["master"]})
    c.post(owner, f"{o}/contracts", {
        "title": "Old E2E licence (never countersigned)", "contract_type": "licensing", "status": "pending_signature",
        "start_date": "2024-01-01", "end_date": (today - timedelta(days=2)).isoformat()})
    c.post(owner, f"{o}/contracts", {
        "title": "E2E publishing admin", "contract_type": "publishing", "status": "active",
        "start_date": "2024-01-01", "end_date": (today + timedelta(days=20)).isoformat()})
    c.post(owner, f"{o}/contracts", {
        "title": "E2E long-term deal", "contract_type": "publishing", "status": "active",
        "start_date": "2024-01-01", "end_date": (today + timedelta(days=200)).isoformat()})
    for share in (
        {"recording_id": rec1["id"], "party_id": label["id"], "role": "label", "share_percent": "80"},
        {"recording_id": rec1["id"], "party_id": artist["id"], "role": "artist", "share_percent": "20",
         "contract_id": deal["id"]},
        {"recording_id": rec2["id"], "party_id": label["id"], "role": "label", "share_percent": "70"},
        {"recording_id": rec2["id"], "party_id": producer["id"], "role": "producer", "share_percent": "30",
         "contract_id": draft["id"]},
    ):
        c.post(owner, f"{o}/rights/shares", {**share, "rights_type": "master"})
    for writer in (writer_a, writer_b):  # 120% -> over-allocation conflict
        c.post(owner, f"{o}/rights/shares", {"work_id": contested["id"], "party_id": writer["id"], "role": "writer",
                                             "rights_type": "performance", "share_percent": "60"})
    return {"owner": owner, "org": org, "o": o, "other_owner": other_owner, "other_org": other_org,
            "work": work, "contested": contested, "key": key, "other_key": other_key}


def xlsx_bytes(period: str) -> bytes:
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.append(["Store", "Artist", "Title", "ISRC", "Country of Sale", "Quantity", "Earnings (USD)", "Sale Month"])
    ws.append(["Deezer", "Nova E2E", "Midnight Drive E2E", "USE2E2600001", "FR", 70, 1234.5678, period])
    ws.append(["Deezer", "Nova E2E", "Night Bus E2E", "USE2E2600002", "FR", 3, 0.42, period])
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


def stage_inbox(period: str) -> None:
    INBOX.mkdir(parents=True, exist_ok=True)
    for old in INBOX.iterdir():
        if old.is_file():
            old.unlink()

    def put(name: str, data: bytes) -> None:
        (INBOX / name).write_bytes(data)

    put(f"distributor__E2E Distro__{period}__USD.csv",
        (FIXTURES / "statement_valid.csv").read_bytes().replace(b"PERIOD", period.encode()))
    put(f"streaming__E2E Deezer XLSX__{period}__USD.xlsx", xlsx_bytes(period))
    put("random-export.csv", (FIXTURES / "statement_bad_name.csv").read_bytes())
    put(f"distributor__Garbage__{period}.csv", (FIXTURES / "statement_garbage.csv").read_bytes())
    put(f"distributor__Legacy Excel__{period}.xls", b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1legacy-binary-xls")


def auto_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# --------------------------------------------------------------------------- main


def main() -> int:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    print(f"== n8n live integration test {stamp} (test instance {N8N_HOME}, port {N8N_PORT})")
    providers = real_providers()
    if providers and "--allow-real-providers" not in sys.argv:
        print(f"Refusing to run: backend\\.env configures {', '.join(providers)}. The test would send real "
              "emails and/or make paid AI calls. Start a separate local API with EMAIL_PROVIDER=console and "
              "AI_PROVIDER=none, point RIGHTSFLOW_API_URL at it and set RIGHTSFLOW_LIVE_TEST_SAFE_API=1, "
              "or pass --allow-real-providers if you authorize real delivery.")
        return 2
    if not api_up():
        print("FastAPI is not reachable; start it first (scripts\\start-local-automation.ps1)")
        return 2
    if not N8N_BIN.exists():
        print("n8n is not installed (scripts\\install-n8n.ps1)")
        return 2
    operational_before = operational_fingerprint()
    c = Client()
    period = previous_month()
    year, month = map(int, period.split("-"))
    period_start = date(year, month, 1)
    period_end = (period_start.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)

    print("-- seeding isolated test organizations through the API")
    s = seed(c)
    token, other_token, owner, o = s["key"]["token"], s["other_key"]["token"], s["owner"], s["o"]
    org_id = s["org"]["id"]
    check("Automation keys created for both test organizations (shown once)",
          token.startswith("rfa_") and other_token.startswith("rfa_"))

    app_csv = (FIXTURES / "statement_app_upload.csv").read_bytes().replace(b"PERIOD", period.encode())
    r = c.http.post(f"{o}/royalties/statements", headers=owner["headers"],
                    files={"file": ("app.csv", app_csv, "text/csv")},
                    data={"source_name": "E2E App Upload", "source_category": "streaming",
                          "period_start": period_start.isoformat(), "period_end": period_end.isoformat(),
                          "currency": "USD"})
    check("Statement uploaded by a user in the app", r.status_code == 201, f"HTTP {r.status_code}")
    app_statement = r.json()
    stage_inbox(period)

    print("-- tenant isolation with real keys")
    other = auto_headers(other_token)
    check("Org B key resolves to org B only",
          c.http.get(f"{API}/api/v1/automation/whoami", headers=other).json()["organization_id"] == s["other_org"]["id"])
    check("Org B key cannot read org A statement",
          c.http.get(f"{API}/api/v1/automation/statements/{app_statement['id']}", headers=other).status_code == 404)
    check("Automation key rejected on the human (JWT) API",
          c.http.get(f"{o}/royalties/statements", headers=auto_headers(token)).status_code == 401)

    print("-- configuring the TEST n8n instance (operational instance untouched)")
    code = ps("setup-n8n-automation.ps1", "-Token", token, "-Mode", "test", "-AllowOrganizationChange")
    if not check("setup-n8n-automation.ps1 -Mode test configured the test instance", code == 0, f"exit {code}"):
        return finish(stamp, 1)
    connection = json.loads((N8N_HOME / "secrets" / "connection.json").read_text(encoding="utf-8"))
    check("Test instance records its organization and test mode (no secret in the file)",
          connection["mode"] == "test" and connection["organization_id"] == org_id and token not in json.dumps(connection))
    ps("start-n8n.ps1", "-TimeoutSeconds", "300")
    check(f"Test n8n server running on 127.0.0.1:{N8N_PORT}", n8n_running())
    who = c.http.get(f"{API}/api/v1/automation/whoami",
                     headers={**auto_headers(token), "X-Automation-Instance": instance_id()}).json()
    check("Key is bound to the test instance", who.get("this_instance_matches") is True)
    conflict = c.http.get(f"{API}/api/v1/automation/whoami",
                          headers={**auto_headers(token), "X-Automation-Instance": "rf-another-instance-0000"})
    check("A second instance using the same key is refused (409 instance_conflict)",
          conflict.status_code == 409 and conflict.json()["error"]["code"] == "instance_conflict")

    def runs(**params):
        return c.get(owner["headers"], f"{o}/automation/runs", **params)

    def latest(workflow: str) -> dict:
        found = runs(workflow=workflow)
        return found[0] if found else {}

    def notification_count(type_: str | None = None) -> int:
        items = c.get(owner["headers"], "/api/v1/notifications", page_size=100)["items"]
        return len([n for n in items if type_ is None or n["type"] == type_])

    # ---------------------------------------------------------------- E: health, healthy
    print("-- Workflow E: automation health")
    res = execute("health", "healthy")
    e = latest("automation-health")
    check("E. health workflow executed and recorded 'healthy'",
          res["exit"] == 0 and (e.get("summary") or {}).get("overall") == "healthy", json.dumps(e.get("summary"))[:200])

    # ---------------------------------------------------------------- A: first run
    print("-- Workflow A: royalty statement import")
    res = execute("royalty", "first")
    a = latest("royalty-import").get("summary") or {}
    check("A. royalty-import executed", res["exit"] == 0, res["output"][-400:] if res["exit"] else "")
    check("A. CSV and XLSX inbox statements imported", a.get("from_inbox") == 2, json.dumps(a.get("results"))[:300])
    check("A. app upload is NOT processed before its mapping is confirmed (awaiting_mapping)",
          a.get("from_events") == 1 and a.get("awaiting_mapping") == 1)
    app_now = c.get(owner["headers"], f"{o}/royalties/statements/{app_statement['id']}")
    check("A. app upload still 'uploaded'", app_now["status"] == "uploaded")
    rejected = {r["file"]: r for r in a.get("rejected", [])}
    check("A. bad name, garbage and legacy .xls files rejected with an explicit reason",
          len(rejected) == 3 and any(f.endswith(".xls") for f in rejected), json.dumps(a.get("rejected")))
    inbox_files = c.get(owner["headers"], f"{o}/automation/inbox-files")
    check("A. every inbox file has a recorded outcome",
          sorted(f["state"] for f in inbox_files) == ["imported", "imported", "rejected", "rejected", "rejected"],
          str(sorted(f["state"] for f in inbox_files)))
    statements = {st["source_name"]: st for st in c.get(owner["headers"], f"{o}/royalties/statements")["items"]}
    xlsx = statements.get("E2E Deezer XLSX")
    lines = c.get(owner["headers"], f"{o}/royalties/statements/{xlsx['id']}/lines")["items"] if xlsx else []
    amounts = sorted(str(line["amount"]) for line in lines)
    check("A. XLSX amounts kept exact (1234.5678 and 0.42)",
          any(x.startswith("1234.5678") for x in amounts) and any(x.startswith("0.42") for x in amounts), str(amounts))
    tasks = c.get(owner["headers"], f"{o}/automation/review-tasks", kind="statement_review")
    held = {h["reason"] for t in tasks for h in (t["details"] or {}).get("held", [])}
    check("A. missing contract terms held for review, not paid", "no_applicable_contract_term" in held, str(sorted(held)))
    check("A. no royalty run posted by automation", c.get(owner["headers"], f"{o}/royalties/runs", status="posted")["items"] == [])
    check("A. ledger untouched", c.get(owner["headers"], f"{o}/ledger/balances")["items"] == [])
    rejection_tasks = len(c.get(owner["headers"], f"{o}/automation/review-tasks", kind="inbox_file_rejected"))

    print("-- mapping confirmation by a person, then automation resumes")
    confirmed = c.http.put(f"{o}/royalties/statements/{app_statement['id']}/mapping", headers=owner["headers"],
                           json={"adapter": app_now["adapter"], "column_mapping": app_now["column_mapping"]})
    check("Owner confirmed the app upload's column mapping", confirmed.status_code == 200, confirmed.text[:200])
    notes_before = notification_count()
    res = execute("royalty", "after confirmation")
    a2 = latest("royalty-import").get("summary") or {}
    app_after = c.get(owner["headers"], f"{o}/royalties/statements/{app_statement['id']}")
    check("A. statement.ready event processed the confirmed app upload",
          app_after["status"] in ("processed", "calculated"), f"status {app_after['status']}")
    check("A. re-run: inbox files recognised as already imported, rejections not re-raised",
          all(r["origin"] in ("inbox_duplicate", "event") for r in a2.get("results", []))
          and all(r.get("seen_before") for r in a2.get("rejected", []))
          and len(c.get(owner["headers"], f"{o}/automation/review-tasks", kind="inbox_file_rejected")) == rejection_tasks,
          json.dumps(a2.get("rejected"))[:300])
    res = execute("royalty", "third")
    statement_total = c.get(owner["headers"], f"{o}/royalties/statements")["total"]
    check("A. re-runs created no new statements", statement_total == 3, str(statement_total))
    notes_after = notification_count()
    check("A. third run sent no further notifications", notes_after - notes_before <= 3,
          f"{notes_before} -> {notes_after} (the confirmed upload's review may notify once)")

    print("-- bounded retry of a failed statement (N8N-02)")
    from sqlalchemy import text as sql

    eng = dev_db()
    with eng.begin() as conn:
        conn.execute(sql("UPDATE royalty_statements SET status='failed', errors=:e WHERE id=:id"),
                     {"id": xlsx["id"], "e": json.dumps([{"row": None, "errors": ["Lost connection to MySQL server"]}])})
        conn.execute(sql("UPDATE background_jobs SET status='failed', error='Lost connection to MySQL server' "
                         "WHERE id=(SELECT job_id FROM royalty_statements WHERE id=:id)"), {"id": xlsx["id"]})
    execute("royalty", "after transient failure")
    state = c.get(auto_headers(token), f"/api/v1/automation/statements/{xlsx['id']}/automation")
    check("A. transient failure scheduled for retry with backoff (no alert yet)",
          state["state"] == "retry_waiting" and state["next_attempt_at"] is not None, json.dumps(state)[:200])
    with eng.begin() as conn:
        conn.execute(sql("UPDATE automation_statement_states SET next_attempt_at=:t WHERE statement_id=:id"),
                     {"id": xlsx["id"], "t": datetime.utcnow() - timedelta(seconds=5)})
    execute("royalty", "retry due")
    time.sleep(5)
    execute("royalty", "after retry")
    state = c.get(auto_headers(token), f"/api/v1/automation/statements/{xlsx['id']}/automation")
    check("A. due retry reprocessed the same statement (no duplicate import)",
          state["state"] == "completed" and state["attempts"] >= 2
          and c.get(owner["headers"], f"{o}/royalties/statements")["total"] == 3, json.dumps(state)[:200])

    # ---------------------------------------------------------------- B
    print("-- Workflow B: contract expiration")
    execute("contracts", "first")
    b = latest("contract-expiration").get("summary") or {}
    check("B. reminders for 7-day, 30-day and expired contracts (not the 200-day one)",
          b.get("sent") == 3 and b.get("contracts") == 3, json.dumps(b.get("outcomes"))[:300])
    execute("contracts", "re-run")
    b2 = latest("contract-expiration").get("summary") or {}
    check("B. re-run sends no duplicate reminders", b2.get("sent") == 0 and b2.get("duplicates") == 3)

    # ---------------------------------------------------------------- C
    print("-- Workflow C: AI metadata and rights review")
    c.post(owner, f"{o}/automation/review-requests", {"subject_type": "work", "subject_id": s["work"]["id"]})
    execute("ai", "first")
    csum = latest("ai-metadata-review").get("summary") or {}
    check("C. new works/recordings, requested review and conflicts handled", csum.get("subjects", 0) >= 5,
          json.dumps({k: csum.get(k) for k in ("subjects", "suggested", "explained", "ai_unavailable", "errors")}))
    if c.get(owner["headers"], f"{o}/ai/status").get("configured"):
        record("C. AI provider configured: suggestions pending human review",
               csum.get("suggested", 0) + csum.get("explained", 0) > 0, json.dumps(csum)[:200])
    else:
        record("C. AI provider not configured: degraded gracefully, nothing applied",
               csum.get("ai_unavailable", 0) > 0 and csum.get("errors") == 0,
               "real provider NOT verified (no credentials)", category="not-verified (no AI credentials)")
    check("C. conflict left open for a person", len(c.get(owner["headers"], f"{o}/rights/conflicts", status="open")["items"]) >= 1)

    # ---------------------------------------------------------------- D
    print("-- Workflow D: monthly report")
    execute("monthly", "first")
    d = latest("monthly-reporting").get("summary") or {}
    check("D. report generated from app data and delivered to admins/owner",
          d.get("delivery_status") == "sent" and d.get("recipients", 0) >= 1, json.dumps(d))
    count = len(runs(workflow="monthly-reporting"))
    res = execute("monthly", "re-run")
    check("D. same month is not generated or delivered again",
          res["exit"] == 0 and len(runs(workflow="monthly-reporting")) == count)

    # ---------------------------------------------------------------- E: warning -> alert -> recovery
    print("-- Workflow E: credential expiry warning, alert, suppression, recovery (N8N-04/03)")
    key_id = token.split("_")[1]
    with eng.begin() as conn:
        conn.execute(sql("UPDATE integration_credentials SET expires_at=:t WHERE key_id=:k"),
                     {"k": key_id, "t": datetime.utcnow() + timedelta(days=10)})
    execute("health", "key expiring")
    e = latest("automation-health").get("summary") or {}
    check("E. expiring key reported as warning (not healthy)", e.get("overall") == "warning", json.dumps(e)[:250])
    incidents = c.get(owner["headers"], f"{o}/automation/incidents", status="open")
    health_incidents = [i for i in incidents if i["workflow"] == "automation-health"]
    check("E. one health incident opened and admins alerted",
          len(health_incidents) == 1 and health_incidents[0]["alerts_sent"] == 1)
    execute("health", "still expiring")
    incidents = [i for i in c.get(owner["headers"], f"{o}/automation/incidents", status="open")
                 if i["workflow"] == "automation-health"]
    check("E. repeated warning suppressed (same incident, no second alert)",
          len(incidents) == 1 and incidents[0]["occurrences"] == 2 and incidents[0]["alerts_sent"] == 1)
    with eng.begin() as conn:
        conn.execute(sql("UPDATE integration_credentials SET expires_at=:t WHERE key_id=:k"),
                     {"k": key_id, "t": datetime.utcnow() + timedelta(days=90)})
    execute("health", "renewed")
    resolved = [i for i in c.get(owner["headers"], f"{o}/automation/incidents", status="resolved")
                if i["workflow"] == "automation-health"]
    recovered = [n for n in c.get(owner["headers"], "/api/v1/notifications", page_size=100)["items"]
                 if n["title"].startswith("Recovered:")]
    check("E. healthy again: incident resolved with a recovery notice", len(resolved) == 1 and len(recovered) >= 1)

    # ---------------------------------------------------------------- reliability: crashed worker
    print("-- Reliability: crashed worker (expired lease)")
    c.post(owner, f"{o}/automation/review-requests", {"subject_type": "work", "subject_id": s["contested"]["id"]})
    claim = c.http.post(f"{API}/api/v1/automation/events/claim", headers=auto_headers(token),
                        json={"event_types": ["review.requested"], "limit": 1, "lease_seconds": 30}).json()
    check("Simulated worker claimed an event and 'crashed' (no ack)", claim["count"] == 1)
    print("    waiting 32s for the lease to expire...", flush=True)
    time.sleep(32)
    execute("ai", "after crash")
    events = {ev["id"]: ev for ev in c.get(owner["headers"], f"{o}/automation/events")}
    ev = events.get(claim["events"][0]["id"]) if claim["count"] else None
    check("Expired lease re-claimed by the next run and completed",
          bool(ev) and ev["status"] == "completed" and ev["attempts"] == 2)

    # ---------------------------------------------------------------- server mode (N8N-08)
    print("-- Server execution: schedules and the error workflow inside the n8n server")
    probe_started = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    ps("stop-n8n.ps1")
    check("Probe workflows imported into the test instance", import_workflows(API, extra=probe_workflows()) == 0)
    for wid in ("RfTestSchedProbe", "RfTestFailProbe"):
        cli("publish:workflow", f"--id={wid}")
    ps("start-n8n.ps1", "-TimeoutSeconds", "300")
    print("    waiting 150s for scheduled executions...", flush=True)
    time.sleep(150)
    executions = n8n_executions(("RfTestSchedProbe", "RfTestFailProbe", "RfWfErrorHandler"), probe_started)
    by = {(w, m, st): n for w, m, st, n in executions}
    check("Schedule fired inside the n8n server (mode=trigger, success)",
          by.get(("RfTestSchedProbe", "trigger", "success"), 0) >= 1, str(executions))
    sched_runs = [r for r in runs(workflow="diag-schedule-probe") if r["trigger_type"] == "schedule"]
    check("Scheduled run recorded via the API with trigger_type=schedule", len(sched_runs) >= 1)
    check("Error workflow executed by the server for the failing probe (mode=error, success)",
          by.get(("RfWfErrorHandler", "error", "success"), 0) >= 2, str(executions))
    probe_incidents = [i for i in c.get(owner["headers"], f"{o}/automation/incidents")
                       if "fail" in i["workflow"]]
    check("Repeated identical failures -> one incident, one alert, repeats suppressed",
          len(probe_incidents) == 1 and probe_incidents[0]["alerts_sent"] == 1
          and probe_incidents[0]["occurrences"] >= 2 and probe_incidents[0]["suppressed"] >= 1,
          json.dumps({k: probe_incidents[0][k] for k in ("occurrences", "alerts_sent", "suppressed", "category")})
          if probe_incidents else "none")
    ps("stop-n8n.ps1")
    for wid in ("RfTestSchedProbe", "RfTestFailProbe"):
        cli("unpublish:workflow", f"--id={wid}")

    # ---------------------------------------------------------------- reliability: API unreachable
    print("-- Reliability: API unreachable from n8n")
    check("Workflows re-imported against an unreachable API", import_workflows("http://127.0.0.1:8099", error_handler_url=API) == 0)
    res = execute("health", "API unreachable")
    check("E. health fails loudly (non-zero) and reports CRITICAL/unreachable",
          res["exit"] != 0 and "CRITICAL" in res["output"] and "unreachable" in res["output"], res["output"][-300:])
    res = execute("royalty", "API unreachable")
    check("A. royalty-import fails cleanly while the API is unreachable", res["exit"] != 0)
    check("Workflows restored with the real API URL", import_workflows(API) == 0)
    res = execute("royalty", "after recovery")
    check("A. royalty-import succeeds again once the API is reachable", res["exit"] == 0)

    # ---------------------------------------------------------------- B with nothing due (org B)
    print("-- Workflow B with nothing due (organization B, test instance switched explicitly)")
    code = ps("setup-n8n-automation.ps1", "-Token", other_token, "-Mode", "test")
    check("Switching the instance to another organization is refused without -AllowOrganizationChange", code != 0)
    code = ps("setup-n8n-automation.ps1", "-Token", other_token, "-Mode", "test", "-AllowOrganizationChange")
    check("Explicit organization change accepted", code == 0)
    execute("contracts", "nothing due")
    other_headers = s["other_owner"]["headers"]
    ob = c.get(other_headers, f"/api/v1/organizations/{s['other_org']['id']}/automation/runs", workflow="contract-expiration")
    check("B. nothing-due branch completes with 0 contracts",
          bool(ob) and ob[0]["status"] == "succeeded" and (ob[0]["summary"] or {}).get("contracts") == 0,
          json.dumps(ob[0]["summary"] if ob else None))

    # ---------------------------------------------------------------- isolation of the operational instance
    check("Operational n8n instance untouched (credential, key file, active workflows, connection)",
          operational_fingerprint() == operational_before)

    # ---------------------------------------------------------------- cleanup (N8N-16)
    print("-- cleanup: revoke test keys, archive test organizations")
    for user, org_ref in ((owner, s["org"]), (s["other_owner"], s["other_org"])):
        base = f"/api/v1/organizations/{org_ref['id']}"
        for cred in c.get(user["headers"], f"{base}/automation/credentials"):
            c.http.post(f"{base}/automation/credentials/{cred['id']}/revoke", json={"reason": "live test finished"},
                        headers=user["headers"])
        c.http.post(f"{base}/archive", json={"password": PASSWORD, "confirm_slug": org_ref["slug"]},
                    headers=user["headers"])
    check("Test keys revoked (API rejects them)",
          c.http.get(f"{API}/api/v1/automation/whoami", headers=auto_headers(token)).status_code == 401)
    for leftover in INBOX.iterdir():
        if leftover.is_file():
            leftover.unlink()
    return finish(stamp, 0)


def finish(stamp: str, code: int) -> int:
    ps("stop-n8n.ps1")
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    passed = sum(1 for r in results if r["ok"])
    failed = [r for r in results if not r["ok"]]
    out = RESULTS_DIR / f"live-{stamp}.json"
    out.write_text(json.dumps({"timestamp": stamp, "api": API, "n8n_test_home": str(N8N_HOME), "n8n_port": N8N_PORT,
                               "passed": passed, "failed": len(failed), "checks": results}, indent=2), encoding="utf-8")
    print(f"\n== {passed} passed, {len(failed)} failed. Results: {out}")
    return 1 if failed or code else 0


if __name__ == "__main__":
    sys.exit(main())
