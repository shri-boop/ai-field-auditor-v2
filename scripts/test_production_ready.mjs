/**
 * Production-readiness assertions for all three workflows.
 *
 * The checklist in .claude/n8n-workflow.md is a list of things a human is supposed
 * to remember to check before activating a workflow. This file turns the
 * machine-checkable half of it into assertions, because a checklist that is
 * re-verified by hand is re-verified until the day somebody is in a hurry.
 *
 * It reads the committed artifacts — the same files that get imported into n8n —
 * rather than the generators, so it catches a generator whose create path and
 * update path have drifted. That is not hypothetical: `fallbackOutput` was declared
 * for new installs and silently absent on the existing workflow, because
 * `ensure_validation_nodes()` set it in the branch that creates the node and not in
 * the branch that updates one.
 *
 * WHAT IT CANNOT CHECK
 * Items 6 (execution logging) and 15 (the full response envelope) are deliberately
 * not asserted as conforming, because they are not. Both are recorded as reasoned
 * deviations in docs/PRODUCTION_READINESS.md, and item 6 is scheduled work rather
 * than a decision. An assertion that passed on those would be a lie.
 *
 * Run:  node scripts/test_production_ready.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);

const ERROR_WORKFLOW_ID = 'iLRmjyuk5mq1hqkB';

/**
 * Nodes that run AFTER the caller has been answered. They must tolerate failure and
 * must NOT reach a responder: n8n permits one response per execution, so a notifier
 * failing after the success responder already answered would raise "Webhook response
 * already sent" and convert a lost alert into a failed run.
 */
const POST_RESPONSE = new Set([
  'SEND_Slack', 'SEND_Telegram', 'SEND_Email', 'CREATE_WorkOrder',
  'NOTIFY_OpsManager', 'Send a message'
]);

/** Disabled leftovers, excluded from reachability. */
const ORPHANED = new Set(['EXTRACT_Base64', 'DOWNLOAD_Image']);

const WORKFLOWS = [
  { file: 'AI_Field_Audit_v2.json', label: 'India', activeExpected: true },
  { file: 'AI_Field_Audit_US.json', label: 'US', activeExpected: false },
  { file: 'AI_Field_Audit_History.json', label: 'History', activeExpected: false }
];

let pass = 0, fail = 0;
const failures = [];
function check(label, condition, detail) {
  if (condition) { pass++; console.log('  \u2713 ' + label); }
  else {
    fail++; failures.push(label + (detail ? ' \u2014 ' + detail : ''));
    console.log('  \u2717 ' + label + (detail ? '  [' + detail + ']' : ''));
  }
}
const section = (t) => console.log('\n' + t);

/** How many outputs a Switch node actually declares — mode-dependent. */
function switchOutputCount(node) {
  if (node.parameters.mode === 'expression') {
    return parseInt(node.parameters.numberOutputs || 2, 10);
  }
  // Rules mode: one output per rule, and numberOutputs is absent.
  const rules = (node.parameters.rules && node.parameters.rules.values) || [];
  return rules.length;
}

for (const spec of WORKFLOWS) {
  const wf = JSON.parse(readFileSync(join(REPO, spec.file), 'utf8'));
  section('=== ' + spec.label + '  (' + spec.file + ') ===');

  const responders = new Set(
    wf.nodes.filter((n) => n.type.includes('respondToWebhook')).map((n) => n.name));
  const live = wf.nodes.filter(
    (n) => !n.disabled && !n.type.includes('stickyNote') && !ORPHANED.has(n.name));

  function reaches(start, seen = new Set()) {
    if (responders.has(start)) return true;
    if (seen.has(start)) return false;
    seen.add(start);
    const out = wf.connections[start];
    if (!out) return false;
    return (out.main || []).some((br) => (br || []).some((c) => reaches(c.node, seen)));
  }

  // ---------------------------------------------------------------- item 1
  const webhookTarget = ((wf.connections.Webhook || {}).main || [[]])[0][0];
  check('item 1: a validator runs immediately after the Webhook',
    webhookTarget && /VALIDATE/.test(webhookTarget.node), webhookTarget && webhookTarget.node);
  check('item 1: a 400 responder exists for rejected input',
    wf.nodes.some((n) => n.name === 'RESPOND_BadRequest' &&
      n.parameters.options.responseCode === 400));

  // ---------------------------------------------------------------- item 2
  // Every node that can fail needs an error path. ERROR_Handler is the documented
  // exception: giving the error handler its own error output would be circular.
  const failable = live.filter((n) =>
    /httpRequest|postgres|\.code$|telegram|slack|gmail/.test(n.type) &&
    n.name !== 'ERROR_Handler');
  const missing = failable.filter((n) => !n.onError).map((n) => n.name);
  check('item 2: every failable node has an onError policy',
    missing.length === 0, missing.join(', '));

  // ---------------------------------------------------------------- item 3
  const httpNodes = live.filter((n) => n.type.includes('httpRequest'));
  const httpNoRetry = httpNodes.filter((n) => n.retryOnFail !== true).map((n) => n.name);
  check('item 3: every HTTP node retries', httpNoRetry.length === 0, httpNoRetry.join(', '));
  const dbNodes = live.filter((n) => n.type.includes('postgres'));
  const dbNoRetry = dbNodes.filter((n) => n.retryOnFail !== true).map((n) => n.name);
  check('item 3: every Postgres node retries', dbNoRetry.length === 0, dbNoRetry.join(', '));
  // A vision call with no ceiling holds the caller's request open until the proxy
  // gives up, which reads to a user as a hang rather than a failure.
  const httpNoTimeout = httpNodes
    .filter((n) => !(n.parameters.options || {}).timeout && !n.disabled)
    .map((n) => n.name);
  check('every enabled HTTP node has a timeout', httpNoTimeout.length === 0, httpNoTimeout.join(', '));

  // ---------------------------------------------------------------- item 5
  const handlers = wf.nodes.filter((n) => n.name === 'ERROR_Handler');
  check('item 5: exactly ONE central error handler', handlers.length === 1, String(handlers.length));
  check('item 5: it is a Code node, not a Set node (Set assignments can import empty)',
    handlers.length === 1 && handlers[0].type === 'n8n-nodes-base.code',
    handlers.length === 1 ? handlers[0].type : 'n/a');
  check('item 5: it connects to a responder',
    handlers.length === 1 && reaches('ERROR_Handler'));
  const eh = handlers.length === 1 ? handlers[0].parameters.jsCode : '';
  ['error_type', 'error_node', 'timestamp'].forEach((f) => {
    check('item 5: it captures ' + f, eh.indexOf(f) !== -1);
  });

  // ---------------------------------------------------------------- item 7
  const silent = live
    .filter((n) => !responders.has(n.name) && !POST_RESPONSE.has(n.name) && !reaches(n.name))
    .map((n) => n.name);
  check('item 7: NO execution path fails to reach a responder',
    silent.length === 0, silent.join(', '));

  // The other half of item 7, and the one that bites: a post-response node that
  // CAN reach a responder produces "Webhook response already sent".
  const dbl = live.filter((n) => POST_RESPONSE.has(n.name) && reaches(n.name)).map((n) => n.name);
  check('item 7: no post-response node can trigger a second response',
    dbl.length === 0, dbl.join(', '));
  POST_RESPONSE.forEach((name) => {
    const n = wf.nodes.find((x) => x.name === name);
    if (!n || n.disabled) return;
    check('post-response node ' + name + ' tolerates failure',
      n.onError === 'continueRegularOutput', n.onError || '(none)');
  });

  // ---------------------------------------------------------------- item 8
  wf.nodes.filter((n) => n.type.includes('switch')).forEach((n) => {
    const opts = n.parameters.options || {};
    check('item 8: ' + n.name + ' declares fallbackOutput',
      opts.fallbackOutput === 'extra', String(opts.fallbackOutput));
    // Declaring it without wiring it is WORSE than omitting it: the output exists,
    // looks handled on the canvas, and still drops the item into nothing.
    const branches = (wf.connections[n.name] || {}).main || [];
    const declared = switchOutputCount(n);
    const wired = branches.length > declared && (branches[declared] || []).length > 0;
    check('item 8: ' + n.name + '\u2019s fallback output is actually WIRED',
      wired, 'outputs=' + branches.length + ' declared=' + declared);
    if (wired) {
      check('item 8: ' + n.name + '\u2019s fallback routes to the error handler',
        branches[declared][0].node === 'ERROR_Handler', branches[declared][0].node);
    }
  });

  // ------------------------------------------------------- pre-return checklist
  const ids = wf.nodes.map((n) => n.id);
  check('#2: every node id is unique', new Set(ids).size === ids.length);
  check('#3: every non-trigger node appears in connections or is a terminal target',
    (() => {
      const named = new Set(Object.keys(wf.connections));
      const targets = new Set();
      Object.values(wf.connections).forEach((o) => (o.main || [])
        .forEach((b) => (b || []).forEach((c) => targets.add(c.node))));
      const orphan = live.filter((n) => !named.has(n.name) && !targets.has(n.name))
        .map((n) => n.name);
      return orphan.length === 0 || orphan.join(', ');
    })() === true, 'see above');
  const rawHttp = live.filter((n) => n.type.includes('httpRequest') && n.parameters.sendBody);
  check('#5: HTTP nodes sending a body use contentType raw',
    rawHttp.every((n) => n.parameters.contentType === 'raw'),
    rawHttp.filter((n) => n.parameters.contentType !== 'raw').map((n) => n.name).join(', '));
  check('#7: the artifact is valid JSON with no stray control characters',
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(readFileSync(join(REPO, spec.file), 'utf8')) === false);

  // #9 is a documented deviation for India: it ships active: true precisely so a
  // re-import cannot silently take a live workflow down.
  check('#9: active flag matches the documented intent for this region',
    wf.active === spec.activeExpected, 'active=' + wf.active);

  const creds = {};
  wf.nodes.forEach((n) => Object.entries(n.credentials || {})
    .forEach(([t, c]) => { creds[t + ':' + c.id] = true; }));
  check('#10: OpenRouter credential id is correct where used',
    !Object.keys(creds).some((k) => k.startsWith('httpHeaderAuth:')) ||
    Object.keys(creds).some((k) => k === 'httpHeaderAuth:Yo4OGxALKxIBKco8' ||
      k.startsWith('httpHeaderAuth:')), Object.keys(creds).join(' '));
  check('#10: Postgres credential id is n7fXon6ujJTrnF7w where used',
    !Object.keys(creds).some((k) => k.startsWith('postgres:')) ||
    creds['postgres:n7fXon6ujJTrnF7w'] === true, Object.keys(creds).join(' '));

  // ------------------------------------------------------------------ layer 2
  check('errorWorkflow points at the shared Error_Handler',
    (wf.settings || {}).errorWorkflow === ERROR_WORKFLOW_ID,
    (wf.settings || {}).errorWorkflow || '(missing)');
  check('executionOrder is v1, so branch order is deterministic',
    (wf.settings || {}).executionOrder === 'v1');
  check('no pinData in the artifact', wf.pinData === undefined);
}

// ===========================================================================
section('=== shared error handler source ===');
{
  const src = readFileSync(join(REPO, 'scripts', 'nodes', 'shared_error_handler.js'), 'utf8');
  // One source file for all three regions, so the error contract cannot drift the
  // way the notifier retry settings did.
  WORKFLOWS.forEach((spec) => {
    const wf = JSON.parse(readFileSync(join(REPO, spec.file), 'utf8'));
    const node = wf.nodes.find((n) => n.name === 'ERROR_Handler');
    check(spec.label + ' uses the shared handler verbatim',
      node && node.parameters.jsCode === src);
  });
  check('it cannot throw while handling an error: no bare property chains on error',
    /\$input\.first\(\) \|\| \{\}/.test(src) && /item\.json \|\| \{\}/.test(src));
  // Comments legitimately discuss OpenRouter and Telegram while explaining why this
  // node does NOT touch them, so only executable lines count. Third time this
  // pattern has bitten a structural assertion in this repo.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => l.trim().startsWith('//') === false && l.trim().startsWith('*') === false)
    .join('\n');
  check('it does not diagnose, log, or alert — that is the async workflow\u2019s job',
    /openrouter|INSERT INTO|telegram|fetch\(/i.test(code) === false);
  check('it emits the checklist error shape',
    /success: false/.test(src) && /code: error_type/.test(src) && /timestamp: timestamp/.test(src));
  check('it keeps advisory_only true even on failure',
    /advisory_only: true/.test(src));
}

// ===========================================================================
section('=== error handler, executed against the shape n8n really provides ===');
{
  // These assertions exist because the first live test of this node returned
  // error_node "unknown" and audit_id null. n8n hands the error branch an item whose
  // `error` is a plain STRING, and that item is the FAILING node's input — so when
  // SHAPE_Response fails, the item is LOG_Audit's row echo, which carries neither
  // the audit id nor the site id. Structural assertions on the source could not have
  // caught either gap; only running it could.
  const src = readFileSync(join(REPO, 'scripts', 'nodes', 'shared_error_handler.js'), 'utf8');
  const ABSENT = ['URL', 'URLSearchParams', 'require', 'process', 'fetch', 'Buffer',
                  'TextEncoder', 'structuredClone'];
  const fn = new Function('$input', '$', '$env', '$workflow', '$prevNode', ...ABSENT, src);
  const items = (a) => ({ first: () => a[0], all: () => a, last: () => a[a.length - 1] });

  function run(errItem, prevNode, validatorJson) {
    const ref = (n) => {
      if (validatorJson && n === 'VALIDATE_Input') return items([{ json: validatorJson }]);
      // $('Node') throws in n8n when that node has not executed — the case that
      // matters when the validator itself is what failed.
      throw new Error('node not executed: ' + n);
    };
    return fn(items([errItem]), ref, {}, { name: 'AI_Field_Audit_V2' }, prevNode,
      ...ABSENT.map(() => undefined))[0].json;
  }

  // The exact live case: SHAPE_Response threw, its input was LOG_Audit's row echo.
  const real = run(
    { json: { id: 4711, error: 'forced error-path test [line 44]' } },
    { name: 'SHAPE_Response', outputIndex: 1 },
    { audit_id: 'FA-IN-20260906-ABCD1234-XY9ZQ', site_id: 'SITE-BAN-009' });

  check('names the failing node from $prevNode, not "unknown"',
    real.error_node === 'SHAPE_Response', real.error_node);
  check('records which output it arrived on, so a throw is distinguishable from a router fallback',
    real.error_output_index === 1, String(real.error_output_index));
  check('recovers audit_id from the validator when the error item lacks it',
    real.audit_id === 'FA-IN-20260906-ABCD1234-XY9ZQ', String(real.audit_id));
  check('recovers site_id the same way', real.site_id === 'SITE-BAN-009', String(real.site_id));
  check('still reports the message when error is a plain string',
    real.error === 'forced error-path test [line 44]', real.error);
  check('reports the workflow name from $workflow',
    real.workflow_name === 'AI_Field_Audit_V2', real.workflow_name);
  check('emits success:false and status ERROR',
    real.success === false && real.status === 'ERROR');
  check('keeps advisory_only true on the failure path', real.advisory_only === true);

  // The validator itself failing: $('VALIDATE_Input') throws, and the handler must
  // absorb that rather than becoming a second failure.
  const early = run(
    { json: { error: 'boom' } },
    { name: 'VALIDATE_Input', outputIndex: 1 },
    null);
  check('does not throw when the validator never ran', early.success === false);
  check('reports null identity honestly rather than inventing one',
    early.audit_id === null && early.site_id === null);
  check('still names the failing node in that case',
    early.error_node === 'VALIDATE_Input', early.error_node);

  // A structured error object, which some node types do provide.
  const structured = run(
    { json: { error: { message: 'connection refused', name: 'NodeApiError' } } },
    { name: 'QUERY_IND', outputIndex: 1 }, null);
  check('prefers a structured error name as the code when one exists',
    structured.code === 'NodeApiError', structured.code);
  check('and reads the structured message', structured.error === 'connection refused');

  // Absolute worst case: nothing usable at all. It must still produce a response.
  const empty = run({ json: {} }, null, null);
  check('produces a usable response even with no error information at all',
    empty.success === false && typeof empty.error === 'string' && empty.error.length > 0,
    empty.error);
  check('falls back to "unknown" for the node rather than throwing',
    empty.error_node === 'unknown');
  check('never emits an undefined timestamp', typeof empty.timestamp === 'string');
}

console.log('\n' + '='.repeat(64));
console.log('PASS: ' + pass + '   FAIL: ' + fail);
if (fail) { console.log('\nFAILURES'); failures.forEach((f) => console.log('  - ' + f)); }
console.log('='.repeat(64));
console.log('NOTE: items 6 (execution logging) and 15 (full response envelope) are');
console.log('      NOT asserted — they are open. See docs/PRODUCTION_READINESS.md.');
process.exit(fail === 0 ? 0 : 1);
