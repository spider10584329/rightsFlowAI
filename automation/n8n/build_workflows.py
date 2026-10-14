"""Generates the RightsFlow AI n8n workflow exports in ``workflows/``.

    backend\\.venv\\Scripts\\python.exe automation\\n8n\\build_workflows.py

The JSON files are the source of truth for import; this script keeps the six
workflows consistent (same credential, headers, retry and error-workflow
settings). Exports contain **no secrets**: HTTP nodes reference the credential
"RightsFlow automation key" by id/name only. Three placeholders are replaced at
import time by scripts/setup-n8n-automation.ps1:

- ``__RIGHTSFLOW_API_URL__``      e.g. http://127.0.0.1:8000
- ``__RIGHTSFLOW_INBOX__``        the local statement intake folder (forward slashes)
- ``__RIGHTSFLOW_N8N_URL__``       this n8n instance's own URL (health check)
- ``__RIGHTSFLOW_INSTANCE_ID__``  this n8n installation's id (stored in its data
  folder). Sent as X-Automation-Instance (the API binds a key to one instance)
  and used to namespace Idempotency-Keys, so a reset n8n whose execution ids
  restart at 1 can't collide with stored keys (audit N8N-07).

Design rules:
- n8n orchestrates; FastAPI decides. No money is calculated here and nothing
  writes to MariaDB directly.
- Every run is recorded (POST /automation/runs ... /finish) with the n8n
  execution id as correlation id.
- Every mutating call sends an Idempotency-Key derived from the execution and
  the business item, so node retries are replay-safe.
- Failures trigger the "RightsFlow - Automation error handler" workflow.
"""

import json
import uuid
from pathlib import Path

OUT = Path(__file__).resolve().parent / "workflows"

CREDENTIAL = {"httpHeaderAuth": {"id": "RfAutomationKey1", "name": "RightsFlow automation key"}}
INSTANCE_EXPR = "={{ $('Config').first().json.instanceId }}"
INSTANCE_PREFIX = "{{ $('Config').first().json.instanceId }}:"
ERROR_WORKFLOW_ID = "RfWfErrorHandler"
API = "={{ $('Config').first().json.apiBaseUrl }}/api/v1/automation"

VERSIONS = {
    "manualTrigger": 1,
    "scheduleTrigger": 1.2,
    "code": 2,
    "httpRequest": 4.2,
    "if": 2.2,
    "readWriteFile": 1,
    "errorTrigger": 1,
    "noOp": 1,
}


def _id(workflow: str, name: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"rightsflow/n8n/{workflow}/{name}"))


class Flow:
    def __init__(self, key: str, wid: str, name: str, description: str):
        self.key, self.wid, self.name, self.description = key, wid, name, description
        self.nodes: list[dict] = []
        self.connections: dict[str, dict] = {}
        self._x = 0

    def node(self, name: str, kind: str, parameters: dict, *, x: int | None = None, y: int = 300,
             **extra) -> str:
        if x is None:
            self._x += 240
            x = self._x
        node = {"id": _id(self.key, name), "name": name, "type": f"n8n-nodes-base.{kind}",
                "typeVersion": VERSIONS[kind], "position": [x, y], "parameters": parameters}
        node.update(extra)
        self.nodes.append(node)
        return name

    def link(self, source: str, target: str, output: int = 0) -> None:
        outputs = self.connections.setdefault(source, {"main": []})["main"]
        while len(outputs) <= output:
            outputs.append([])
        outputs[output].append({"node": target, "type": "main", "index": 0})

    def chain(self, *names: str) -> None:
        for a, b in zip(names, names[1:]):
            self.link(a, b)

    def export(self, *, error_workflow: bool = True) -> dict:
        settings = {"executionOrder": "v1", "saveManualExecutions": True, "saveDataErrorExecution": "all",
                    "saveDataSuccessExecution": "all", "saveExecutionProgress": True,
                    "callerPolicy": "workflowsFromSameOwner", "timezone": "UTC"}
        if error_workflow:
            settings["errorWorkflow"] = ERROR_WORKFLOW_ID
        return {"id": self.wid, "name": self.name, "active": False, "nodes": self.nodes,
                "connections": self.connections, "settings": settings, "pinData": {},
                "meta": {"rightsflow": {"workflow": self.key, "description": self.description,
                                        "generated_by": "automation/n8n/build_workflows.py"}},
                "tags": []}


# --------------------------------------------------------------------------- node helpers


def code(js: str, *, each: bool = False) -> dict:
    params = {"jsCode": js.strip()}
    if each:
        params["mode"] = "runOnceForEachItem"
    return params


def http(method: str, url: str, *, body: str | None = None, query: dict | None = None,
         idem: str | None = None, never_error: bool = False, timeout: int = 30000,
         auth: bool = True, one_at_a_time: bool = False) -> dict:
    headers = [{"name": "X-Correlation-ID", "value": "=n8n-{{ $execution.id }}"}]
    if auth:
        headers.append({"name": "X-Automation-Instance", "value": INSTANCE_EXPR})
    if idem:
        assert idem.startswith("="), idem
        headers.append({"name": "Idempotency-Key", "value": "=" + INSTANCE_PREFIX + idem[1:]})
    params: dict = {"method": method, "url": url, "sendHeaders": True,
                    "headerParameters": {"parameters": headers}, "options": {"timeout": timeout}}
    if auth:
        params.update({"authentication": "genericCredentialType", "genericAuthType": "httpHeaderAuth"})
    if query:
        params["sendQuery"] = True
        params["queryParameters"] = {"parameters": [{"name": k, "value": v} for k, v in query.items()]}
    if body is not None:
        params.update({"sendBody": True, "specifyBody": "json", "jsonBody": body})
    if never_error:
        params["options"]["response"] = {"response": {"neverError": True, "fullResponse": True}}
    if one_at_a_time:
        # n8n sends a node's items in parallel by default; AI calls go one by one.
        params["options"]["batching"] = {"batch": {"batchSize": 1, "batchInterval": 500}}
    return params


def api_node(flow: Flow, name: str, params: dict, *, retry: bool = True, **extra) -> str:
    settings = {"credentials": CREDENTIAL}
    if retry:
        settings.update({"retryOnFail": True, "maxTries": 3, "waitBetweenTries": 5000})
    return flow.node(name, "httpRequest", params, **settings, **extra)


def if_true(expression: str) -> dict:
    return {
        "conditions": {
            "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose", "version": 2},
            "conditions": [{"id": str(uuid.uuid5(uuid.NAMESPACE_URL, expression)), "leftValue": expression,
                            "rightValue": "", "operator": {"type": "boolean", "operation": "true",
                                                           "singleValue": True}}],
            "combinator": "and",
        },
        "looseTypeValidation": True,
        "options": {},
    }


def config(workflow: str, schedule_node: str, extra_js: str = "") -> dict:
    return code(f"""
// Non-secret settings. The API key is in the "RightsFlow automation key" credential.
const triggeredBySchedule = $('{schedule_node}').isExecuted;
const settings = {{
  apiBaseUrl: '__RIGHTSFLOW_API_URL__',
  instanceId: '__RIGHTSFLOW_INSTANCE_ID__',
  workflow: '{workflow}',
  trigger: triggeredBySchedule ? 'schedule' : 'manual',
  executionId: String($execution.id),
}};
{extra_js}
return [{{ json: settings }}];
""")


def start_run(flow: Flow, body_extra: str = "") -> str:
    return api_node(flow, "Start run", http(
        "POST", f"{API}/runs", idem="=run-start-{{ $execution.id }}",
        body="={{ JSON.stringify({ workflow: $('Config').first().json.workflow, "
             "trigger_type: $('Config').first().json.trigger, execution_id: $('Config').first().json.executionId"
             + body_extra + " }) }}"))


def finish_run(flow: Flow, name: str = "Finish run", y: int = 300) -> str:
    return api_node(flow, name, http(
        "POST", f"{API}/runs/{{{{ $('Start run').first().json.id }}}}/finish",
        idem="=run-finish-{{ $execution.id }}",
        body="={{ JSON.stringify({ status: $json.status || 'succeeded', summary: $json.summary || {} }) }}"),
        y=y)


def triggers(flow: Flow, schedule_rule: dict, schedule_name: str) -> tuple[str, str]:
    manual = flow.node("Run now", "manualTrigger", {}, x=0, y=200)
    schedule = flow.node(schedule_name, "scheduleTrigger", {"rule": {"interval": [schedule_rule]}}, x=0, y=400)
    flow._x = 0
    return manual, schedule


# --------------------------------------------------------------------------- A: royalty statements


def royalty_import() -> Flow:
    f = Flow("royalty-import", "RfWfRoyaltyImprt", "RightsFlow - A. Royalty statement import",
             "Imports statements from the local inbox and processes statements users uploaded "
             "(statement.uploaded events), then raises review tasks for unmatched or held lines. Never posts.")
    manual, schedule = triggers(f, {"field": "minutes", "minutesInterval": 15}, "Every 15 minutes")
    cfg = f.node("Config", "code", config("royalty-import", "Every 15 minutes",
                                          "// Every file is offered to the API, which accepts CSV/TSV/TXT/XLSX and records an explicit\n"
                                          "// rejection for anything else (e.g. legacy .xls), instead of ignoring it.\n"
                                          "settings.inboxGlob = '__RIGHTSFLOW_INBOX__/*.*';"))
    f.link(manual, cfg)
    f.link(schedule, cfg)
    start = start_run(f)
    read = f.node("Read inbox files", "readWriteFile",
                  {"operation": "read", "fileSelector": "={{ $('Config').first().json.inboxGlob }}",
                   "options": {}}, alwaysOutputData=True, onError="continueRegularOutput")
    has_file = f.node("Any files?", "if", if_true("={{ !!($binary && $binary.data) }}"))
    describe = f.node("Describe file", "code", code(r"""
// Inbox naming convention: <source_category>__<source name>__<YYYY-MM>[__<CUR>].csv
// e.g. distributor__Distro Inc__2026-09__USD.csv. Anything else is sent with an
// invalid category so the API rejects it (422) and the run summary lists it.
const fileName = $input.item.binary.data.fileName || 'unknown.csv';
const stem = fileName.replace(/\.[^.]+$/, '');
const parts = stem.split('__');
const [category, source, period, currency] = parts;
let periodStart = null, periodEnd = null;
const m = /^(\d{4})-(\d{2})$/.exec(period || '');
if (m) {
  const year = Number(m[1]), month = Number(m[2]);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  periodStart = `${m[1]}-${m[2]}-01`;
  periodEnd = `${m[1]}-${m[2]}-${String(last).padStart(2, '0')}`;
}
const valid = parts.length >= 3 && !!periodStart;
return {
  json: {
    file_name: fileName,
    valid_name: valid,
    source_category: valid ? category : 'invalid_file_name',
    source_name: (source || stem).slice(0, 200),
    period_start: periodStart || '1970-01-01',
    period_end: periodEnd || '1970-01-31',
    currency: (currency || 'USD').toUpperCase(),
  },
  binary: $input.item.binary,
};
""", each=True))
    upload = api_node(f, "Upload statement", {
        **http("POST", f"{API}/statements", idem="=upload-{{ $execution.id }}-{{ $itemIndex }}",
               never_error=True, timeout=120000),
        "contentType": "multipart-form-data",
        "sendBody": True,
        "bodyParameters": {"parameters": [
            {"parameterType": "formBinaryData", "name": "file", "inputDataFieldName": "data"},
            {"name": "source_name", "value": "={{ $json.source_name }}"},
            {"name": "source_category", "value": "={{ $json.source_category }}"},
            {"name": "period_start", "value": "={{ $json.period_start }}"},
            {"name": "period_end", "value": "={{ $json.period_end }}"},
            {"name": "currency", "value": "={{ $json.currency }}"},
        ]},
    })
    claim = api_node(f, "Claim statement events", http(
        "POST", f"{API}/events/claim",
        body="={{ JSON.stringify({ event_types: ['statement.uploaded', 'statement.ready'], limit: 10, "
             "lease_seconds: 600 }) }}"),
        executeOnce=True)
    collect = f.node("Collect statements", "code", code("""
// One item per statement to process: inbox uploads (new or already imported)
// plus statements users uploaded in the app (outbox events, leased to this run).
const work = [];
if ($('Upload statement').isExecuted) {
  const described = $('Describe file').all();
  $('Upload statement').all().forEach((item, i) => {
    const r = item.json;
    if ((r.statusCode === 200 || r.statusCode === 201) && r.body && r.body.id) {
      work.push({ statement_id: r.body.id, origin: r.body.duplicate ? 'inbox_duplicate' : 'inbox',
                  file_name: (described[i] || {}).json?.file_name });
    }
  });
}
const claim = $('Claim statement events').first().json;
for (const event of claim.events || []) {
  work.push({ statement_id: event.payload.statement_id, origin: 'event', event_id: event.id,
              lease_token: claim.lease_token });
}
if (!work.length) {
  return [{ json: { hasWork: false, status: 'succeeded', summary: { statements: 0 } } }];
}
return work.map((w) => ({ json: { hasWork: true, ...w } }));
"""))
    has_work = f.node("Anything to process?", "if", if_true("={{ $json.hasWork }}"))
    process = api_node(f, "Start processing", http(
        "POST", f"{API}/statements/{{{{ $json.statement_id }}}}/process",
        idem="=process-{{ $execution.id }}-{{ $json.statement_id }}", never_error=True))
    wait = api_node(f, "Wait for processing", http(
        "GET", f"{API}/statements/{{{{ $('Collect statements').item.json.statement_id }}}}",
        query={"wait_seconds": "45"}, timeout=70000))
    review = api_node(f, "Review results", http(
        "POST", f"{API}/statements/{{{{ $('Collect statements').item.json.statement_id }}}}/review",
        idem="=review-{{ $execution.id }}-{{ $('Collect statements').item.json.statement_id }}",
        body="={{ JSON.stringify({ calculate: true, run_id: $('Start run').first().json.id, "
             "event_id: $('Collect statements').item.json.event_id || null, "
             "lease_token: $('Collect statements').item.json.lease_token || null }) }}",
        never_error=True))
    summarize = f.node("Summarize", "code", code("""
const started = $('Start processing').all();
const results = $input.all().map((item, i) => {
  const source = $('Collect statements').all()[i]?.json || {};
  const r = item.json;
  const body = r.body || {};
  const progress = started[i]?.json?.body?.automation || {};
  return {
    statement_id: source.statement_id, origin: source.origin, http_status: r.statusCode,
    automation: progress.outcome || null, attempts: progress.attempts ?? null,
    needs_review: body.needs_review === true, review_task: body.task_change || null,
    error: r.statusCode >= 300 ? (body.error?.code || `http_${r.statusCode}`) : null,
  };
});
const rejected = [];
if ($('Upload statement').isExecuted) {
  const described = $('Describe file').all();
  $('Upload statement').all().forEach((item, i) => {
    if (![200, 201].includes(item.json.statusCode)) {
      rejected.push({ file: (described[i] || {}).json?.file_name, http_status: item.json.statusCode,
                      code: item.json.body?.error?.code || null,
                      seen_before: (item.json.body?.inbox_file?.times_seen || 1) > 1 });
    }
  });
}
const failed = results.filter((r) => r.error);
return [{ json: {
  status: failed.length || rejected.length ? 'partial' : 'succeeded',
  summary: {
    statements: results.length,
    needing_review: results.filter((r) => r.needs_review).length,
    from_inbox: results.filter((r) => r.origin !== 'event').length,
    awaiting_mapping: results.filter((r) => (r.automation || '').startsWith('awaiting') || r.automation === 'mapping_required').length,
    retry_waiting: results.filter((r) => ['retry_scheduled', 'retry_waiting'].includes(r.automation)).length,
    needs_manual_review: results.filter((r) => r.automation === 'needs_manual_review').length,
    from_events: results.filter((r) => r.origin === 'event').length,
    failed: failed.length, rejected_files: rejected.length, rejected, results,
  },
} }];
"""))
    finish = finish_run(f)
    f.chain(cfg, start, read, has_file)
    f.link(has_file, describe, 0)
    f.link(has_file, claim, 1)
    f.chain(describe, upload, claim, collect, has_work)
    f.link(has_work, process, 0)
    f.link(has_work, finish, 1)
    f.chain(process, wait, review, summarize, finish)
    return f


# --------------------------------------------------------------------------- B: contract expiration


def contract_expiration() -> Flow:
    f = Flow("contract-expiration", "RfWfContractExpr", "RightsFlow - B. Contract expiration reminders",
             "Daily: reminds managers about contracts expiring within 30/14/7 days or already expired. "
             "One reminder per contract, end date and threshold.")
    manual, schedule = triggers(f, {"field": "cronExpression", "expression": "0 7 * * *"}, "Daily 07:00 UTC")
    cfg = f.node("Config", "code", config("contract-expiration", "Daily 07:00 UTC",
                                          "settings.thresholds = [30, 14, 7]; // days before end date"))
    f.link(manual, cfg)
    f.link(schedule, cfg)
    start = start_run(f)
    expiring = api_node(f, "List expiring contracts", http(
        "GET", f"{API}/contracts/expiring",
        query={"within_days": "={{ Math.max(...$('Config').first().json.thresholds) }}"}))
    plan = f.node("Plan reminders", "code", code("""
// Pick the tightest threshold each contract has reached (0 = already expired).
const thresholds = [...$('Config').first().json.thresholds].sort((a, b) => a - b);
const items = $('List expiring contracts').first().json.items || [];
const plan = [];
for (const c of items) {
  const threshold = c.days_until_expiry < 0 ? 0 : thresholds.find((t) => c.days_until_expiry <= t);
  if (threshold === undefined) continue;
  plan.push({ hasWork: true, contract_id: c.contract_id, threshold_days: threshold,
              days_until_expiry: c.days_until_expiry });
}
if (!plan.length) return [{ json: { hasWork: false, status: 'succeeded', summary: { contracts: 0 } } }];
return plan.map((p) => ({ json: p }));
"""))
    has_work = f.node("Any reminders due?", "if", if_true("={{ $json.hasWork }}"))
    send = api_node(f, "Send reminder", http(
        "POST", f"{API}/contracts/{{{{ $json.contract_id }}}}/reminders",
        idem="=reminder-{{ $execution.id }}-{{ $json.contract_id }}-{{ $json.threshold_days }}",
        body="={{ JSON.stringify({ threshold_days: $json.threshold_days, run_id: $('Start run').first().json.id }) }}",
        never_error=True))
    summarize = f.node("Summarize", "code", code("""
const outcomes = $input.all().map((item, i) => {
  const plan = $('Plan reminders').all()[i]?.json || {};
  const body = item.json.body || {};
  let outcome = body.duplicate ? 'duplicate' : body.status;
  if (item.json.statusCode >= 300) outcome = body.error?.code || `http_${item.json.statusCode}`;
  return { contract_id: plan.contract_id, threshold_days: plan.threshold_days, outcome,
           recipients: body.recipient_count ?? 0 };
});
const count = (o) => outcomes.filter((x) => x.outcome === o).length;
const errors = outcomes.filter((x) => !['sent', 'duplicate', 'skipped'].includes(x.outcome));
return [{ json: {
  status: errors.length ? 'partial' : 'succeeded',
  summary: { contracts: outcomes.length, sent: count('sent'), duplicates: count('duplicate'),
             skipped_no_recipients: count('skipped'), errors: errors.length, outcomes },
} }];
"""))
    finish = finish_run(f)
    f.chain(cfg, start, expiring, plan, has_work)
    f.link(has_work, send, 0)
    f.link(has_work, finish, 1)
    f.chain(send, summarize, finish)
    return f


# --------------------------------------------------------------------------- C: AI review


def ai_review() -> Flow:
    f = Flow("ai-metadata-review", "RfWfAiReview0001", "RightsFlow - C. AI metadata and rights review",
             "Reviews new works/recordings, requested reviews and high-severity rights conflicts with the "
             "app's AI layer. Results are pending suggestions or advisory review tasks; people decide.")
    manual, schedule = triggers(f, {"field": "minutes", "minutesInterval": 30}, "Every 30 minutes")
    cfg = f.node("Config", "code", config("ai-metadata-review", "Every 30 minutes"))
    f.link(manual, cfg)
    f.link(schedule, cfg)
    start = start_run(f)
    claim = api_node(f, "Claim review events", http(
        "POST", f"{API}/events/claim",
        body="={{ JSON.stringify({ event_types: ['work.created', 'recording.created', 'review.requested', "
             "'rights_conflict.opened'], limit: 10, lease_seconds: 600 }) }}"))
    collect = f.node("Collect subjects", "code", code("""
const claim = $input.first().json;
const subjects = [];
for (const event of claim.events || []) {
  const p = event.payload || {};
  let subject = null;
  if (event.event_type === 'rights_conflict.opened') subject = { subject_type: 'rights_conflict', subject_id: p.conflict_id };
  else if (event.event_type === 'review.requested') subject = { subject_type: p.subject_type, subject_id: p.subject_id };
  else subject = { subject_type: p.entity_type, subject_id: p.entity_id };
  subjects.push({ hasWork: true, ...subject, event_id: event.id, event_type: event.event_type,
                  lease_token: claim.lease_token });
}
if (!subjects.length) return [{ json: { hasWork: false } }];
return subjects.map((s) => ({ json: s }));
"""))
    has_work = f.node("Anything to review?", "if", if_true("={{ $json.hasWork }}"))
    review = api_node(f, "AI review", http(
        "POST", f"{API}/ai/review",
        idem="=ai-review-{{ $execution.id }}-{{ $json.event_id }}",
        body="={{ JSON.stringify({ subject_type: $json.subject_type, subject_id: $json.subject_id, "
             "event_id: $json.event_id, lease_token: $json.lease_token, run_id: $('Start run').first().json.id }) }}",
        never_error=True, timeout=120000, one_at_a_time=True))
    sync = api_node(f, "Record human decisions", http(
        "POST", f"{API}/ai/sync-decisions", idem="=ai-sync-{{ $execution.id }}", body="={{ '{}' }}"),
        executeOnce=True)
    summarize = f.node("Summarize", "code", code("""
const reviewed = $('AI review').isExecuted ? $('AI review').all().map((item) => {
  const body = item.json.body || {};
  return { subject_type: body.subject_type, subject_id: body.subject_id, http_status: item.json.statusCode,
           outcome: item.json.statusCode < 300 ? body.outcome : (body.error?.code || `http_${item.json.statusCode}`),
           suggestions: (body.suggestion_ids || []).length };
}) : [];
const sync = $('Record human decisions').first().json;
const errors = reviewed.filter((r) => r.http_status >= 300 || r.outcome === 'ai_error');
const count = (o) => reviewed.filter((r) => r.outcome === o).length;
return [{ json: {
  status: errors.length ? 'partial' : 'succeeded',
  summary: { subjects: reviewed.length, suggested: count('suggested'), explained: count('explained'),
             ai_unavailable: count('ai_unavailable'), errors: errors.length,
             decisions_recorded: (sync.resolved || []).length, awaiting_decision: sync.still_waiting || 0,
             reviewed },
} }];
"""))
    finish = finish_run(f)
    f.chain(cfg, start, claim, collect, has_work)
    f.link(has_work, review, 0)
    f.link(has_work, sync, 1)
    f.chain(review, sync, summarize, finish)
    return f


# --------------------------------------------------------------------------- D: monthly reporting


def monthly_reporting() -> Flow:
    f = Flow("monthly-reporting", "RfWfMonthlyRprt1", "RightsFlow - D. Monthly royalty report",
             "Monthly: generates last month's report with the app's report job and notifies admins/owners. "
             "Once per report type and period.")
    manual, schedule = triggers(f, {"field": "cronExpression", "expression": "0 6 2 * *"}, "Monthly, 2nd 06:00 UTC")
    cfg = f.node("Config", "code", config("monthly-reporting", "Monthly, 2nd 06:00 UTC", """
settings.reportType = 'revenue_by_source';
settings.period = $now.setZone('UTC').minus({ months: 1 }).toFormat('yyyy-MM');  // last completed month
"""))
    f.link(manual, cfg)
    f.link(schedule, cfg)
    start = start_run(f, ", idempotency_key: 'monthly:' + $('Config').first().json.reportType + ':' "
                         "+ $('Config').first().json.period")
    done = f.node("Already delivered?", "if", if_true("={{ $json.replayed === true && $json.status === 'succeeded' }}"))
    skip = f.node("Nothing to do", "noOp", {}, y=150)
    request = api_node(f, "Request report", http(
        "POST", f"{API}/reports/monthly", idem="=report-{{ $execution.id }}",
        body="={{ JSON.stringify({ period: $('Config').first().json.period, "
             "report_type: $('Config').first().json.reportType, run_id: $('Start run').first().json.id }) }}"))
    wait = api_node(f, "Wait for report", http(
        "GET", f"{API}/jobs/{{{{ $json.job_id }}}}", query={"wait_seconds": "50"}, timeout=75000))
    send = f.node("Notify recipients", "httpRequest", http(
        "POST", f"{API}/reports/deliveries/{{{{ $('Request report').first().json.id }}}}/send",
        idem="=report-send-{{ $execution.id }}", body="={{ '{}' }}"),
        credentials=CREDENTIAL, retryOnFail=True, maxTries=5, waitBetweenTries=10000)
    summarize = f.node("Summarize", "code", code("""
const delivery = $input.first().json;
return [{ json: {
  status: delivery.status === 'sent' || delivery.duplicate ? 'succeeded' : 'partial',
  summary: { period: $('Config').first().json.period, report_type: $('Config').first().json.reportType,
             delivery_status: delivery.status, duplicate: delivery.duplicate === true,
             recipients: delivery.recipient_count, job_id: delivery.job_id },
} }];
"""))
    finish = finish_run(f)
    f.chain(cfg, start, done)
    f.link(done, skip, 0)
    f.link(done, request, 1)
    f.chain(request, wait, send, summarize, finish)
    return f


# --------------------------------------------------------------------------- E: health


def automation_health() -> Flow:
    f = Flow("automation-health", "RfWfHealthCheck1", "RightsFlow - E. Automation health check",
             "Hourly: n8n, the API, the database, the automation key (expiry levels), the outbox, runs and "
             "incidents. Healthy / warning / critical; alerts admins per issue set and fails loudly when it "
             "cannot reach or authenticate to the API.")
    manual, schedule = triggers(f, {"field": "hours", "hoursInterval": 1}, "Every hour")
    cfg = f.node("Config", "code", config("automation-health", "Every hour",
                                          "settings.n8nHealthUrl = '__RIGHTSFLOW_N8N_URL__/healthz';"))
    f.link(manual, cfg)
    f.link(schedule, cfg)
    # neverError covers HTTP error statuses; continueRegularOutput also covers refused
    # connections, so an unreachable service is reported instead of failing the check.
    n8n = f.node("Check n8n", "httpRequest", http(
        "GET", "={{ $('Config').first().json.n8nHealthUrl }}", never_error=True, timeout=10000, auth=False),
        onError="continueRegularOutput")
    api = f.node("Check API", "httpRequest", http(
        "GET", "={{ $('Config').first().json.apiBaseUrl }}/health", never_error=True, timeout=10000, auth=False),
        onError="continueRegularOutput")
    auto = api_node(f, "Check automation API", http("GET", f"{API}/health", never_error=True, timeout=15000),
                    retry=False, onError="continueRegularOutput")
    diagnose = f.node("Diagnose", "code", code("""
// Availability and readiness only: this does not prove business workflows produce correct results.
const n8n = $('Check n8n').first().json;
const api = $('Check API').first().json;
const auto = $('Check automation API').first().json;
const body = auto.body || {};
const rank = { healthy: 0, warning: 1, critical: 2 };
const checks = [];
const add = (check, severity, detail) => checks.push({ check, severity, ok: severity === 'healthy', detail });
add('n8n', n8n.statusCode === 200 ? 'healthy' : 'critical', n8n.statusCode ? `HTTP ${n8n.statusCode}` : 'unreachable');
add('FastAPI', api.statusCode === 200 ? 'healthy' : 'critical', api.statusCode ? `HTTP ${api.statusCode}` : 'unreachable');
if (auto.statusCode === 401 || auto.statusCode === 403) {
  add('Automation key', 'critical', `rejected (HTTP ${auto.statusCode}: ${body.error?.code || 'unauthorized'}): the key is expired, revoked or invalid. Create or rotate it in Settings > Automation, then run scripts\\setup-n8n-automation.ps1`);
} else if (auto.statusCode === 409) {
  add('Automation key', 'critical', `bound to another n8n instance (${body.error?.code}): see docs/N8N_TROUBLESHOOTING.md`);
} else if (auto.statusCode !== 200) {
  add('Automation API', 'critical', auto.statusCode ? `HTTP ${auto.statusCode}` : 'unreachable');
} else {
  const cred = body.credential || {};
  const level = cred.expiry_level === 'critical' ? 'critical' : cred.expiry_level === 'warning' ? 'warning' : 'healthy';
  add('Automation key', level, cred.days_until_expiry == null ? 'no expiry' : `expires in ${cred.days_until_expiry} day(s)`);
  for (const issue of body.issues || []) {
    if (issue.code === 'credential_expiring') continue;  // reported above
    add(issue.code, issue.severity, issue.message);
  }
  if (!(body.issues || []).length) add('Database, outbox, runs, incidents', 'healthy', `database ${body.database?.latency_ms} ms`);
}
let overall = 'healthy';
for (const c of checks) if (rank[c.severity] > rank[overall]) overall = c.severity;
const problems = checks.filter((c) => !c.ok);
return [{ json: {
  overall, checks,
  problemCodes: problems.map((c) => c.check).sort(),
  canRecord: auto.statusCode === 200,
  report: checks.map((c) => `${c.severity.toUpperCase().padEnd(8)} ${c.check}: ${c.detail}`).join('\\n'),
  status: overall === 'healthy' ? 'succeeded' : 'partial',
  summary: { overall, problems: problems.map((c) => c.check), checks },
} }];
"""))
    can_record = f.node("API reachable?", "if", if_true("={{ $json.canRecord }}"))
    record = start_run(f)
    finish = api_node(f, "Finish run", http(
        "POST", f"{API}/runs/{{{{ $('Start run').first().json.id }}}}/finish",
        idem="=run-finish-{{ $execution.id }}",
        body="={{ JSON.stringify({ status: $('Diagnose').first().json.status, summary: $('Diagnose').first().json.summary }) }}"))
    problems = f.node("Problems found?", "if", if_true("={{ $('Diagnose').first().json.overall !== 'healthy' }}"))
    alert = api_node(f, "Alert admins", http(
        "POST", f"{API}/alerts", idem="=health-alert-{{ $execution.id }}",
        body="={{ JSON.stringify({ workflow: 'automation-health', execution_id: String($execution.id), "
             "run_id: $('Start run').first().json.id, "
             "error_code: 'health_' + $('Diagnose').first().json.overall, "
             "resource: $('Diagnose').first().json.problemCodes.join('+').slice(0, 120), "
             "error_message: $('Diagnose').first().json.report }) }}"))
    fail = f.node("Fail loudly", "code", code("""
// The API can't be reached or refuses the key: nothing can be recorded there, so
// fail this execution (visible in n8n > Executions and to the error workflow).
// scripts\\check-n8n.ps1 gives the same diagnosis locally.
throw new Error('Automation health CRITICAL:\\n' + $('Diagnose').first().json.report);
"""), y=450)
    f.chain(cfg, n8n, api, auto, diagnose, can_record)
    f.link(can_record, record, 0)
    f.link(can_record, fail, 1)
    f.chain(record, finish, problems)
    f.link(problems, alert, 0)
    return f


# --------------------------------------------------------------------------- error handler


def error_handler() -> Flow:
    f = Flow("automation-error-handler", ERROR_WORKFLOW_ID, "RightsFlow - Automation error handler",
             "Error workflow for the RightsFlow workflows: marks the run failed and alerts admins "
             "(once per failed execution).")
    trigger = f.node("When a workflow fails", "errorTrigger", {}, x=0)
    f._x = 0
    cfg = f.node("Config", "code", code("""
return [{ json: { apiBaseUrl: '__RIGHTSFLOW_API_URL__', instanceId: '__RIGHTSFLOW_INSTANCE_ID__' } }];
"""))
    report = api_node(f, "Report failure", http(
        "POST", f"{API}/alerts", idem="=error-{{ $('When a workflow fails').first().json.execution.id }}",
        body="={{ JSON.stringify({ workflow: ($('When a workflow fails').first().json.workflow.name || 'unknown')"
             ".toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100), "
             "execution_id: String($('When a workflow fails').first().json.execution.id), "
             "error_code: 'workflow_failed', "
             "resource: String($('When a workflow fails').first().json.execution.lastNodeExecuted || '').slice(0, 120) || null, "
             "error_message: ($('When a workflow fails').first().json.execution.lastNodeExecuted || '') + ': ' + "
             "($('When a workflow fails').first().json.execution.error?.message || 'unknown error') }) }}"))
    f.chain(trigger, cfg, report)
    return f


FLOWS = {
    "royalty-import.json": (royalty_import, True),
    "contract-expiration.json": (contract_expiration, True),
    "ai-metadata-review.json": (ai_review, True),
    "monthly-reporting.json": (monthly_reporting, True),
    "automation-health.json": (automation_health, True),
    "automation-error-handler.json": (error_handler, False),
}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for filename, (build, uses_error_workflow) in FLOWS.items():
        data = build().export(error_workflow=uses_error_workflow)
        (OUT / filename).write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {filename}: {len(data['nodes'])} nodes")


if __name__ == "__main__":
    main()
