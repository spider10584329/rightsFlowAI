"""Server-mode probe: do schedules, credentials, Code nodes and the error
workflow work inside the running n8n *server* (not only via `n8n execute`)?

    backend\\.venv\\Scripts\\python.exe scripts\\diagnostics\\n8n_server_probe.py

What it does (diagnostic only, reversible):
1. Imports two temporary workflows, clearly named "RF DIAG - ...":
   - RfDiagSchedProbe: every-minute Schedule -> Config (same trigger detection as
     the real workflows) -> POST /automation/runs -> finish (via the real credential).
   - RfDiagFailProbe: every-minute Schedule -> HTTP call to a closed port (fails)
     -> error workflow RfWfErrorHandler must alert admins.
2. Publishes them and restarts n8n (the server loads triggers at start).
3. Waits up to --wait seconds, then reads evidence (read-only):
   n8n execution rows (mode/status) and RightsFlow automation_runs / notifications.
4. Unpublishes the probes and restarts n8n again, so nothing keeps running.
Only start/finish run rows and one alert notification are written to the
organization the configured automation key belongs to. No financial data.
"""

import argparse
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "automation" / "n8n"))
sys.path.insert(0, str(ROOT / "scripts"))

import build_workflows as bw  # noqa: E402
from n8n_live_test import N8N_BIN, N8N_HOME, n8n_env, ps  # noqa: E402

API_URL = os.environ.get("RIGHTSFLOW_API_URL", "http://127.0.0.1:8000")
PROBES = ("RfDiagSchedProbe", "RfDiagFailProbe")


def probe_workflows() -> list[dict]:
    sched = bw.Flow("diag-schedule-probe", "RfDiagSchedProbe", "RF DIAG - schedule probe (temporary)",
                    "Temporary audit probe; safe to delete.")
    trigger = sched.node("Every minute", "scheduleTrigger", {"rule": {"interval": [{"field": "minutes", "minutesInterval": 1}]}}, x=0)
    sched._x = 0
    cfg = sched.node("Config", "code", bw.config("diag-schedule-probe", "Every minute"))
    start = bw.start_run(sched)
    finish = bw.api_node(sched, "Finish run", bw.http(
        "POST", f"{bw.API}/runs/{{{{ $('Start run').first().json.id }}}}/finish", idem="=run-finish-{{ $execution.id }}",
        body="={{ JSON.stringify({ status: 'succeeded', summary: { trigger: $('Config').first().json.trigger, "
             "execution: $('Config').first().json.executionId } }) }}"))
    sched.chain(trigger, cfg, start, finish)

    fail = bw.Flow("diag-fail-probe", "RfDiagFailProbe", "RF DIAG - failing probe (temporary)",
                   "Temporary audit probe; fails on purpose to exercise the error workflow.")
    t2 = fail.node("Every minute", "scheduleTrigger", {"rule": {"interval": [{"field": "minutes", "minutesInterval": 1}]}}, x=0)
    fail._x = 0
    boom = fail.node("Call closed port", "httpRequest", bw.http("GET", "http://127.0.0.1:8099/unreachable", auth=False))
    fail.chain(t2, boom)
    out = []
    for flow in (sched, fail):
        text = json.dumps(flow.export()).replace("__RIGHTSFLOW_API_URL__", API_URL)
        out.append(json.loads(text))
    return out


def cli(*args: str) -> int:
    return subprocess.run(["node", str(N8N_BIN), *args], env=n8n_env(), capture_output=True, text=True).returncode


def n8n_rows() -> list[tuple]:
    db = N8N_HOME / "data" / ".n8n" / "database.sqlite"
    cur = sqlite3.connect(f"file:{db}?mode=ro", uri=True).cursor()
    return cur.execute(
        "select workflowId, mode, status, count(*) from execution_entity "
        "where workflowId in ('RfDiagSchedProbe','RfDiagFailProbe','RfWfErrorHandler') and startedAt > ? "
        "group by workflowId, mode, status", (STARTED,)).fetchall()


def api_rows() -> dict:
    from dotenv import dotenv_values
    from sqlalchemy import create_engine, text

    eng = create_engine(dotenv_values(ROOT / "backend" / ".env")["DATABASE_URL"])
    with eng.connect() as c:
        runs = c.execute(text("select workflow, trigger_type, status, summary from automation_runs "
                              "where workflow like 'diag-%' and started_at > :t order by started_at"),
                         {"t": STARTED}).all()
        alerts = c.execute(text("select title, created_at from notifications where type='automation_failed' "
                                "and title like '%diag%' and created_at > :t"), {"t": STARTED}).all()
    return {"runs": [tuple(r) for r in runs], "alerts": [tuple(map(str, a)) for a in alerts]}


def main() -> int:
    global STARTED
    parser = argparse.ArgumentParser()
    parser.add_argument("--wait", type=int, default=150)
    args = parser.parse_args()
    STARTED = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())
    tmp = Path(tempfile.mkdtemp(prefix="rf-probe-"))
    for wf in probe_workflows():
        (tmp / f"{wf['id']}.json").write_text(json.dumps(wf), encoding="utf-8")
    ps("stop-n8n.ps1")
    print("import:", cli("import:workflow", "--separate", f"--input={tmp}"))
    for wid in PROBES:
        print("publish", wid, cli("publish:workflow", f"--id={wid}"))
    ps("start-n8n.ps1")
    print(f"waiting {args.wait}s for scheduled executions...", flush=True)
    time.sleep(args.wait)
    evidence = {"n8n_executions": n8n_rows(), **api_rows()}
    print(json.dumps(evidence, indent=2, default=str))
    ps("stop-n8n.ps1")
    for wid in PROBES:
        print("unpublish", wid, cli("unpublish:workflow", f"--id={wid}"))
    ps("start-n8n.ps1")
    out = ROOT / "automation" / "n8n" / "test-results" / f"server-probe-{STARTED.replace(':', '').replace(' ', 'T')}Z.json"
    out.write_text(json.dumps({"started_utc": STARTED, **evidence}, indent=2, default=str), encoding="utf-8")
    print("evidence written to", out)
    return 0


STARTED = ""
if __name__ == "__main__":
    sys.exit(main())
