/**
 * BUILD_ErrorAlert — turns a CAUGHT error into the payload the shared Error_Handler
 * workflow expects.
 * Mode: Run Once for All Items
 *
 * ONE source file used verbatim by all three workflows (India, US, History), for the
 * same reason shared_error_handler.js is: the alert contract must not drift between
 * regions. Threaded in by patch_india_workflow.py, build_us_workflow.py and
 * build_history_workflow.py.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL — THE GAP IT CLOSES
 * ---------------------------------------------------------------------------
 * n8n runs a workflow's `settings.errorWorkflow` ONLY when an execution ends in
 * status *error*. A node with onError: continueErrorOutput whose error branch
 * completes leaves the execution *successful*. Every failable node in these three
 * workflows routes its error output to ERROR_Handler, so every failure they are
 * designed to survive ends as a SUCCESSFUL execution — and the shared Error_Handler
 * is never invoked for any of them.
 *
 * The consequence, before this node existed: ERROR_Handler -> RESPOND_Error ->
 * nothing. The caller received a clean HTTP 500 with a structured body, and the
 * operator was told NOTHING. No error_log row, no Telegram, no Slack. A vision
 * outage, a parse drift, a database outage or a validator crash was visible only to
 * whoever happened to be using the dashboard at the time.
 *
 * Verified on the live India workflow: the only reachable nodes that could produce an
 * *uncaught* failure are the webhook, two routers, three responders and
 * ERROR_Handler itself. DOWNLOAD_Image and EXTRACT_Base64 — the two plausible
 * failure points — are both disabled AND orphaned, so they can never run. Registering
 * the errorWorkflow therefore covers almost nothing here on its own. This node is
 * what actually makes operator alerting work.
 *
 * ---------------------------------------------------------------------------
 * WHY IT SITS AFTER RESPOND_Error, NOT BESIDE IT
 * ---------------------------------------------------------------------------
 * The caller must be answered first. Downstream-of-the-responder is the only
 * placement that GUARANTEES that ordering: a second branch off ERROR_Handler would
 * be ordered by n8n's execution-order heuristics, and correctness that depends on
 * canvas position is not correctness.
 *
 * CALL_ErrorHandler then runs with waitForSubWorkflow: false, so the diagnosis is
 * genuinely fire-and-forget. That matters twice over: the caller has already been
 * answered, and this execution does not stay open holding a worker slot while an LLM
 * thinks for 10-30 s against an AUDIT_TIMEOUT_MS of 240 s.
 *
 * ---------------------------------------------------------------------------
 * WHY IT READS $('ERROR_Handler') AND NOT $json
 * ---------------------------------------------------------------------------
 * Its input comes from RESPOND_Error, and what a respondToWebhook node emits on its
 * output is NOT something this file is willing to assume. It might pass its input
 * through, it might emit the response body, it might emit nothing. Reading the
 * handler by name makes that question irrelevant — a class of bug this project has
 * already paid for once, when ERROR_Handler read $json and got LOG_Audit's row echo
 * instead of the audit, which is why audit_id came back null on a live failure.
 *
 * RESPOND_Error carries alwaysOutputData: true so that "it might emit nothing" cannot
 * silently stop this chain. An empty item still triggers this node, and this node
 * does not care what is in it.
 *
 * ---------------------------------------------------------------------------
 * THE FIELD NAMES ARE NOT NEGOTIABLE
 * ---------------------------------------------------------------------------
 * Error_Handler's GENERATE_ErrorID reads a FLAT payload: workflow_name, run_id,
 * client_id, error_node, error_message, error_type, execution_url. Those exact names.
 * Its other entry point — the native Error Trigger — receives a completely different
 * shape ({ execution: {...}, workflow: {...} }), and the flat branch is the one this
 * node targets, so the alert will correctly report Source: executeWorkflow rather
 * than errorTrigger. See agentic-dev-stack PR #745.
 *
 * run_id <- audit_id and client_id <- site_id are deliberate: error_log's own columns
 * are generic, and mapping our identity onto them is what makes a row traceable back
 * to one audit of one building instead of being a nameless stack trace. History has
 * no audit_id at all and honestly reports 'unknown'.
 */

// The base URL is hardcoded rather than derived. A Code node has no reliable access
// to n8n's public URL: $env is blocked by configuration on some deployments, and
// there is no built-in that exposes it. A wrong link is worse than none, so if the
// ids are unavailable this emits '' and Error_Handler omits the link line entirely
// rather than printing a broken one.
const N8N_BASE_URL = 'https://n8n.kratuailabs.com';

/**
 * `$('NodeName')` THROWS when the named node has not executed. That cannot happen on
 * this path — ERROR_Handler is the only way to reach RESPOND_Error — but an error
 * handler that threw while assembling an error report would manufacture the silent
 * failure this whole chain exists to prevent. So it is guarded, and the guard is not
 * silent: a lookup failure still produces a payload, one that says so.
 */
let handler = {};
let lookupNote = '';
try {
  const rows = $('ERROR_Handler').all();
  handler = (rows && rows[0] && rows[0].json) ? rows[0].json : {};
} catch (e) {
  lookupNote = String((e && e.message) || e).slice(0, 120);
}

function str(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const out = String(value).trim();
  return out === '' ? fallback : out;
}

// ------------------------------------------------------------- execution link
let execution_url = '';
try {
  const wfId = (typeof $workflow !== 'undefined' && $workflow) ? $workflow.id : null;
  const exId = (typeof $execution !== 'undefined' && $execution) ? $execution.id : null;
  if (wfId && exId) {
    execution_url = N8N_BASE_URL + '/workflow/' + wfId + '/executions/' + exId;
  }
} catch (e) {
  execution_url = '';
}

// error_message is capped because it is bound into an INSERT and then into three
// alert channels. Error_Handler's INSERT uses the array parameter form, so a comma in
// here is safe — but an unbounded provider response body is not.
const error_message = str(handler.error_message || handler.error, 'Unknown error')
  .slice(0, 2000);

return [{
  json: {
    // ---- exactly the names Error_Handler.GENERATE_ErrorID reads ------------
    workflow_name: str(handler.workflow_name, 'unknown'),
    run_id: str(handler.audit_id, 'unknown'),
    client_id: str(handler.site_id, 'unknown'),
    error_node: str(handler.error_node, 'unknown'),
    error_message: lookupNote
      ? error_message + ' [BUILD_ErrorAlert could not read ERROR_Handler: ' + lookupNote + ']'
      : error_message,
    error_type: str(handler.error_type, 'WORKFLOW_ERROR'),
    execution_url: execution_url
  }
}];
