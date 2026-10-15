"""Static audit of the n8n workflow exports against the FastAPI OpenAPI schema.

    backend\\.venv\\Scripts\\python.exe scripts\\diagnostics\\n8n_workflow_lint.py

Read-only. Checks, per workflow:
- JSON parses; node names unique; every connection points at an existing node;
  every node is reachable from a trigger; no orphan nodes.
- every $('Node') reference names an existing node;
- HTTP Request nodes: method + path exist in the API schema; JSON body keys are
  accepted by the request schema (schemas use extra="forbid"); credential
  reference is the expected one; mutating automation calls send Idempotency-Key;
- trigger nodes present (manual + schedule) and the error workflow setting.

Without an argument it checks both the self-hosted exports
(automation/n8n/workflows) and the managed-mode templates
(backend/app/services/automation/n8n_templates), which use ``__RF_*__``
placeholders and also have an authenticated "Run on request" webhook.
Exit code 1 when any ERROR is found.
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from app.main import app  # noqa: E402

WORKFLOW_DIRS = [Path(sys.argv[1])] if len(sys.argv) > 1 else [
    ROOT / "automation" / "n8n" / "workflows",
    ROOT / "backend" / "app" / "services" / "automation" / "n8n_templates",
]
EXPECTED_CREDENTIAL = {"id": "RfAutomationKey1", "name": "RightsFlow automation key"}
MANAGED_CREDENTIAL = {"id": "__RF_API_CREDENTIAL_ID__", "name": "__RF_API_CREDENTIAL_NAME__"}
TRIGGERS = {"n8n-nodes-base.manualTrigger", "n8n-nodes-base.scheduleTrigger", "n8n-nodes-base.errorTrigger",
            "n8n-nodes-base.webhook"}

schema = app.openapi()
components = schema.get("components", {}).get("schemas", {})
errors: list[str] = []
validated_calls = 0
warnings: list[str] = []


def err(wf: str, msg: str) -> None:
    errors.append(f"[ERROR] {wf}: {msg}")


def warn(wf: str, msg: str) -> None:
    warnings.append(f"[WARN]  {wf}: {msg}")


def resolve(ref_schema: dict) -> dict:
    if "$ref" in ref_schema:
        return components[ref_schema["$ref"].split("/")[-1]]
    return ref_schema


def match_route(method: str, path: str):
    """Match a concrete path (expressions replaced by {x}) to an OpenAPI path template."""
    for template, ops in schema["paths"].items():
        pattern = "^" + re.sub(r"\{[^}]+\}", r"[^/]+", template) + "$"
        if re.match(pattern, path) and method.lower() in ops:
            return template, ops[method.lower()]
    return None, None


def body_keys(expr: str) -> list[str] | None:
    """Top-level keys of `JSON.stringify({ a: ..., b: ... })` in an n8n expression."""
    m = re.search(r"JSON\.stringify\(\{(.*)\}\s*\)", expr, re.S)
    if not m:
        return None
    inner, depth, keys, token = m.group(1), 0, [], ""
    for ch in inner:
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        if depth == 0 and ch == ",":
            token = ""
            continue
        token += ch
        km = re.match(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:", token)
        if depth == 0 and km and km.group(1) not in keys:
            keys.append(km.group(1))
    return keys


for path in sorted(p for directory in WORKFLOW_DIRS for p in directory.glob("*.json")):
    wf = f"{path.parent.name}/{path.name}"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        err(wf, f"invalid JSON: {exc}")
        continue
    managed = "__RF_" in path.read_text(encoding="utf-8")
    expected_credential = MANAGED_CREDENTIAL if managed else EXPECTED_CREDENTIAL
    nodes = {n["name"]: n for n in data["nodes"]}
    if len(nodes) != len(data["nodes"]):
        err(wf, "duplicate node names")
    conns = data.get("connections", {})
    targets: dict[str, set] = {}
    for src, outs in conns.items():
        if src not in nodes:
            err(wf, f"connection from unknown node '{src}'")
        for branch in outs.get("main", []):
            for link in branch:
                if link["node"] not in nodes:
                    err(wf, f"connection to unknown node '{link['node']}'")
                targets.setdefault(src, set()).add(link["node"])
    # reachability from triggers
    triggers = [n for n, v in nodes.items() if v["type"] in TRIGGERS]
    seen, stack = set(), list(triggers)
    while stack:
        cur = stack.pop()
        if cur in seen:
            continue
        seen.add(cur)
        stack.extend(targets.get(cur, ()))
    for name in nodes:
        if name not in seen:
            err(wf, f"node '{name}' is not reachable from any trigger")
    types = {v["type"] for v in nodes.values()}
    if "n8n-nodes-base.errorTrigger" not in types:
        if "n8n-nodes-base.manualTrigger" not in types:
            err(wf, "no manual trigger (local testing needs one)")
        if "n8n-nodes-base.scheduleTrigger" not in types:
            err(wf, "no schedule trigger")
        expected_error_workflow = "__RF_ERROR_WORKFLOW_ID__" if managed else "RfWfErrorHandler"
        if data.get("settings", {}).get("errorWorkflow") != expected_error_workflow:
            err(wf, f"error workflow not set to {expected_error_workflow}")
        if managed:
            hooks = [v for v in nodes.values() if v["type"] == "n8n-nodes-base.webhook"]
            if len(hooks) != 1 or hooks[0]["parameters"].get("authentication") != "headerAuth":
                err(wf, "managed workflows need one header-authenticated 'Run on request' webhook")
    config_node = nodes.get("Config")
    if config_node is None or ("__RIGHTSFLOW_INSTANCE_ID__" not in config_node["parameters"].get("jsCode", "")
                               and "__RF_INSTANCE_ID__" not in config_node["parameters"].get("jsCode", ""))             and "instanceId" not in config_node["parameters"].get("jsCode", ""):
        err(wf, "Config node must define instanceId (placeholder __RIGHTSFLOW_INSTANCE_ID__)")
    text = json.dumps(data)
    for ref in set(re.findall(r"\$\('([^']+)'\)", text)):
        if ref not in nodes:
            err(wf, f"expression references unknown node $('{ref}')")
    if re.search(r"rfa_[0-9a-f]{16}_|Bearer [A-Za-z0-9]", text):
        err(wf, "export contains what looks like a secret")
    for name, node in nodes.items():
        if node["type"] != "n8n-nodes-base.httpRequest":
            continue
        p = node["parameters"]
        url = p.get("url", "")
        method = p.get("method", "GET")
        if "/api/v1/automation" not in url and "{{ $('Config').first().json.apiBaseUrl }}/api" not in url:
            # external checks (n8n healthz, public /health) are unauthenticated by design
            continue
        concrete = re.sub(r"\{\{.*?\}\}", "{x}", url.split("}}", 1)[1] if url.startswith("={{ $('Config')") else url)
        concrete = concrete.replace("{x}", "X")
        template, op = match_route(method, concrete)
        if not op:
            err(wf, f"'{name}': {method} {concrete} does not exist in the API")
            continue
        validated_calls += 1
        cred = (node.get("credentials") or {}).get("httpHeaderAuth")
        if cred != expected_credential:
            err(wf, f"'{name}': credential reference {cred} != expected")
        header_values = {h["name"]: h["value"] for h in p.get("headerParameters", {}).get("parameters", [])}
        headers = set(header_values)
        if header_values.get("X-Automation-Instance") != "={{ $('Config').first().json.instanceId }}":
            err(wf, f"'{name}': missing X-Automation-Instance header (instance binding, N8N-07)")
        idem_value = header_values.get("Idempotency-Key")
        if idem_value and not idem_value.startswith("={{ $('Config').first().json.instanceId }}:"):
            err(wf, f"'{name}': Idempotency-Key not namespaced by the instance id (N8N-07)")
        if method in ("POST", "PUT", "PATCH", "DELETE") and not template.endswith("/events/claim") \
                and "Idempotency-Key" not in headers:
            err(wf, f"'{name}': mutating call without Idempotency-Key")
        rb = op.get("requestBody", {}).get("content", {})
        if "application/json" in rb and p.get("specifyBody") == "json":
            props = resolve(rb["application/json"]["schema"]).get("properties", {})
            keys = body_keys(p.get("jsonBody", ""))
            if keys is None:
                if p.get("jsonBody", "").strip() not in ("={{ '{}' }}",):
                    warn(wf, f"'{name}': could not parse JSON body keys")
            else:
                unknown = [k for k in keys if k not in props]
                if unknown:
                    err(wf, f"'{name}': body keys {unknown} not accepted by {template} (allowed {sorted(props)})")
                required = resolve(rb["application/json"]["schema"]).get("required", [])
                missing = [k for k in required if k not in keys]
                if missing:
                    err(wf, f"'{name}': required body keys missing {missing}")
        if "multipart/form-data" in rb:
            form = resolve(rb["multipart/form-data"]["schema"])
            sent = {b.get("name") for b in p.get("bodyParameters", {}).get("parameters", [])}
            missing = [k for k in form.get("required", []) if k not in sent]
            if missing:
                err(wf, f"'{name}': multipart fields missing {missing}")
        for qp in p.get("queryParameters", {}).get("parameters", []):
            names = {prm["name"] for prm in op.get("parameters", []) if prm.get("in") == "query"}
            if qp["name"] not in names:
                err(wf, f"'{name}': query parameter '{qp['name']}' not accepted by {template}")
    print(f"checked {wf}: {len(nodes)} nodes, triggers={triggers}")

print()
for line in errors + warnings:
    print(line)
print(f"\n{validated_calls} authenticated API call(s) validated; {len(errors)} error(s), {len(warnings)} warning(s)")
sys.exit(1 if errors else 0)
