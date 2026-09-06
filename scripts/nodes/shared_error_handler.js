/**
 * ERROR_Handler — the synchronous half of error handling.
 * Mode: Run Once for All Items
 *
 * ONE source file, used verbatim by all three workflows (India, US, History), so
 * the error contract cannot drift between regions the way the notifier settings
 * did. Threaded in by patch_india_workflow.py, build_us_workflow.py and
 * build_history_workflow.py.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR, AND WHAT IT IS NOT FOR
 * ---------------------------------------------------------------------------
 * This exists to answer the CALLER. Its entire job is to turn a node failure into
 * a structured response so no execution can end in silence — requirement 5 and 7
 * of the production checklist.
 *
 * It deliberately does NOT diagnose, log to a database, or send an alert. That is
 * the shared Error_Handler workflow's job (`settings.errorWorkflow`,
 * iLRmjyuk5mq1hqkB), which runs asynchronously after the caller already has a
 * response.
 *
 * The split is not tidiness, it is a latency and cost decision:
 *
 *   - The shared workflow makes an LLM diagnosis call. On the response path that
 *     costs a user 10-30 s before they learn anything, and AUDIT_TIMEOUT_MS is
 *     240 s, so a slow diagnosis converts a clean error into a proxy timeout.
 *   - If OpenRouter is what failed — the single most likely failure in this
 *     system — the diagnosis call fails too, in the exact case it was needed.
 *   - A ten-minute vision outage means a hundred failed audits. Error handling
 *     must not scale its cost with the size of the outage.
 *
 * So: respond here, cheaply and immediately. Diagnose there, later.
 *
 * ---------------------------------------------------------------------------
 * WHAT ROUTES HERE, AND WHAT MUST NEVER
 * ---------------------------------------------------------------------------
 * ROUTES HERE — anything on the path BEFORE the caller has been answered:
 *   every Code node's error output, every Switch node's fallbackOutput, and the
 *   History workflow's Postgres reads.
 *
 * MUST NEVER ROUTE HERE — anything on the notification branch AFTER the responder
 * has fired: SEND_Telegram, SEND_Slack, NOTIFY_OpsManager, the Gmail node. Those
 * carry `onError: continueRegularOutput` instead.
 *
 * The reason is concrete rather than stylistic: n8n permits exactly one response
 * per execution. A notifier failing after Respond_to_Webhook has already answered
 * would reach RESPOND_Error and n8n would throw "Webhook response already sent",
 * converting a lost Telegram message into a failed execution. That trades a minor
 * problem for a worse one.
 *
 * A consequence worth stating plainly: a Telegram send that fails after the
 * response is sent cannot be reported to the caller, and is currently only visible
 * in the n8n execution list. Surfacing it belongs to the execution-logging work
 * (checklist item 6), which will record `alert_sent` per channel.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A CODE NODE AND NOT A SET NODE
 * ---------------------------------------------------------------------------
 * The checklist asks for a "Set node". It is a Code node on purpose, following the
 * hard-won rule recorded in the same document: Set node assignments sometimes
 * render empty in the n8n UI after import even when the JSON looks correct.
 *
 * That failure mode is survivable in a content pipeline. Here it would mean the one
 * node responsible for reporting failures silently reporting nothing — the worst
 * possible node to have that bug in. A Code node's body is either present or it is
 * a syntax error, and `test_*.mjs` asserts byte equality between the JSON and this
 * file, so it cannot drift unnoticed.
 */

const item = $input.first() || {};
const j = item.json || {};

/**
 * n8n's error output shape is not stable across node types and versions. It may
 * arrive as `error` (string or object), `$error`, or `error.message`, and the
 * failing node may appear at `error.node.name` or not at all.
 *
 * Read defensively and never throw. An error handler that throws while handling an
 * error produces exactly the silent failure it exists to prevent, so every branch
 * below has a fallback and none of them can raise.
 */
function firstString(candidates, fallback) {
  for (let i = 0; i < candidates.length; i++) {
    const v = candidates[i];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 500);
  }
  return fallback;
}

const raw = (j.error && typeof j.error === 'object') ? j.error
          : (j.$error && typeof j.$error === 'object') ? j.$error
          : {};

const error_message = firstString([
  raw.message,
  raw.description,
  typeof j.error === 'string' ? j.error : null,
  typeof j.$error === 'string' ? j.$error : null,
  j.message
], 'An unexpected error occurred while processing this request.');

// The node name is best-effort here. Precise attribution is the shared
// Error_Handler workflow's job — n8n hands IT the failing node directly, which is
// something an in-workflow node cannot see reliably.
const error_node = firstString([
  raw.node && typeof raw.node === 'object' ? raw.node.name : null,
  typeof raw.node === 'string' ? raw.node : null,
  raw.nodeName,
  j.error_node
], 'unknown');

const error_type = firstString([
  raw.name,
  raw.errorType,
  j.error_type,
  // A Switch node's fallbackOutput is not an exception: it means the routing value
  // was one nobody anticipated. Naming it distinctly matters, because the fix is a
  // different fix — the router needs a branch, not the failing node repairing.
  j.validation_ok !== undefined ? 'UNROUTABLE_VALUE' : null
], 'WORKFLOW_ERROR');

const workflow_name = typeof $workflow !== 'undefined' && $workflow && $workflow.name
  ? String($workflow.name)
  : 'unknown';

// Carried through when the failure happened after VALIDATE_Input, so a support
// request has something to quote and the row can be found later.
const audit_id = firstString([j.audit_id, raw.audit_id], null);
const site_id = firstString([j.site_id, raw.site_id], null);

const timestamp = new Date().toISOString();

return [{
  json: {
    // ---- the response contract, per checklist item 4 ----------------------
    success: false,
    error: error_message,
    code: error_type,
    timestamp: timestamp,

    // ---- what item 5 requires an error handler to capture ------------------
    error_type: error_type,
    error_node: error_node,
    error_message: error_message,
    workflow_name: workflow_name,

    // ---- identity, where the failure happened late enough to have it -------
    audit_id: audit_id,
    site_id: site_id,

    // This project does not certify anything, and an error is not an exception to
    // that. A caller must not read a failed audit as an absent finding.
    advisory_only: true,
    status: 'ERROR'
  }
}];
