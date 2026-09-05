/**
 * Offline test harness for the INDIA audit pipeline. (Roadmap 7.7)
 *
 * India had no tests at all. Every change to it was unverifiable except by
 * running it in production, against a live model, on a live database — which is a
 * poor way to find out that a verdict is wrong.
 *
 * This simulates the n8n Code-node runtime ($input, $('NodeName'), $env) and runs
 * the five Code nodes in sequence against mocked OpenRouter responses, so the
 * part that actually matters — how a photograph becomes a verdict that triggers
 * escalation — is checked without n8n, Postgres or a model call.
 *
 * It also asserts structural facts about AI_Field_Audit_v2.json itself, because
 * that file is hand-maintained and the wiring is as capable of being wrong as the
 * JavaScript.
 *
 * Run:  node scripts/test_india.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const NODES = join(HERE, 'nodes');

// Globals the n8n Code node's restricted `vm` context does NOT reliably provide.
// Shadowing them as undefined reproduces the production sandbox — this is how a
// `new URL(...)` ReferenceError went undetected in the US pipeline the first
// time, under a friendlier harness that passed 85/85.
const ABSENT_IN_SANDBOX = ['URL', 'URLSearchParams', 'require', 'process',
                           'fetch', 'Buffer', 'TextEncoder', 'structuredClone'];

function loadNode(file) {
  const src = readFileSync(join(NODES, file), 'utf8');
  // Code-node sources are function bodies: they end in `return [...]`.
  const fn = new Function('$input', '$', '$env', ...ABSENT_IN_SANDBOX, src);
  const blanks = ABSENT_IN_SANDBOX.map(() => undefined);
  return (input, ref, env) => fn(input, ref, env, ...blanks);
}

const N = {
  parseInput: loadNode('ind_01_validate_input.js'),
  payload: loadNode('ind_02_build_payload.js'),
  derive: loadNode('ind_03_derive_verdict.js'),
  response: loadNode('ind_04_shape_response.js'),
  alert: loadNode('ind_05_build_alert.js')
};

const items = (arr) => ({
  first: () => arr[0],
  all: () => arr,
  last: () => arr[arr.length - 1]
});

/**
 * Runs the executing chain. `modelContent` is the raw string the model
 * "returned" — a string, deliberately, so malformed output can be tested.
 */
function runPipeline(body, modelContent, opts = {}) {
  const bag = {};
  const ref = (name) => {
    if (!bag[name]) throw new Error('Test harness: node not yet run: ' + name);
    return items(bag[name]);
  };
  const env = opts.env || {};

  bag.Webhook = [{ json: { body } }];
  bag.PARSE_Input = N.parseInput(items(bag.Webhook), ref, env);

  // Mirrors ROUTE_Validation: a rejected request short-circuits to HTTP 400 via
  // RESPOND_BadRequest and never reaches the vision model. (Roadmap 7.5)
  if (bag.PARSE_Input[0].json.validation_ok !== true) {
    return {
      rejected: bag.PARSE_Input[0].json,
      input: bag.PARSE_Input[0].json,
      modelWasCalled: false
    };
  }

  bag.BUILD_Vision_Payload = N.payload(items(bag.PARSE_Input), ref, env);

  // Mock the OpenRouter chat-completions envelope.
  bag.Claude_Vision_API = [{
    json: opts.rawApiResponse !== undefined ? opts.rawApiResponse : {
      model: 'anthropic/claude-sonnet-4-5',
      choices: [{ message: { content: modelContent }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1500, completion_tokens: 500 }
    }
  }];

  bag.PARSE_Response = N.derive(items(bag.Claude_Vision_API), ref, env);

  // The Postgres node echoes the inserted row on success; with
  // onError: continueRegularOutput it emits an error object on failure.
  bag.LOG_Audit = opts.dbFails
    ? [{ json: { error: 'connection refused' } }]
    : [{ json: { id: opts.rowId === undefined ? 4711 : opts.rowId } }];

  bag.SHAPE_Response = N.response(items(bag.LOG_Audit), ref, env);

  // IF_NonCompliant: true branch reaches NOTIFY_OpsManager.
  const shaped = bag.SHAPE_Response[0].json;
  const alerted = shaped.alert_required === true;
  bag.NOTIFY_OpsManager = alerted
    ? N.alert(items(bag.SHAPE_Response), ref, env)
    : null;

  return {
    input: bag.PARSE_Input[0].json,
    payload: bag.BUILD_Vision_Payload[0].json,
    derived: bag.PARSE_Response[0].json,
    response: shaped,
    alerted: alerted,
    alert: bag.NOTIFY_OpsManager ? bag.NOTIFY_OpsManager[0].json : null,
    modelWasCalled: true
  };
}

// ---------------------------------------------------------------- assertions
let pass = 0;
let fail = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    pass++;
    console.log('  \u2713 ' + label);
  } else {
    fail++;
    failures.push(label + (detail ? ' \u2014 ' + detail : ''));
    console.log('  \u2717 ' + label + (detail ? '  [' + detail + ']' : ''));
  }
}

function section(title) {
  console.log('\n' + title);
}

// --------------------------------------------------------------- fixtures
const BODY = {
  image_url: 'https://abc.public.blob.vercel-storage.com/ext.jpg',
  site_id: 'SITE-MUM-401',
  asset_tag: 'EXT-401-02',
  inspector_id: 'TECH-8891'
};

const model = (o) => JSON.stringify(o);

/** A well-formed model reply with the given deficiencies and no other problems. */
function reply(deficiencies, extra = {}) {
  return model({
    equipment_type: 'Dry Powder Type Fire Extinguisher',
    confidence: 'HIGH',
    image_quality: 'GOOD',
    observations: 'A 6 kg ABC dry powder extinguisher wall-mounted beside the lift lobby.',
    deficiencies: deficiencies,
    unverifiable_items: [],
    reinspect_required: false,
    ...extra
  });
}

const DEF_CRITICAL = {
  code: 'UNIT_MISSING_OR_DISCHARGED', severity: 'CRITICAL',
  finding: 'Pressure gauge needle sits in the recharge zone.',
  observed: 'Needle left of the green band.',
  requirement: 'Needle must sit within the green operable range.',
  code_reference: 'IS 2190', remediation: 'Withdraw and refill the cylinder.'
};
const DEF_MAJOR = {
  code: 'INSPECTION_TAG_MISSING', severity: 'MAJOR',
  finding: 'No inspection tag on the cylinder.',
  code_reference: 'IS 2190; MFPLSM Rules 2009', remediation: 'Attach a current tag.'
};
const DEF_MINOR = {
  code: 'ISI_MARK_MISSING', severity: 'MINOR',
  finding: 'ISI mark not legible on the cylinder body.',
  code_reference: 'IS 15683', remediation: 'Replace with a BIS-marked unit.'
};

// ===========================================================================
section('1. PARSE_Input');
{
  const r = runPipeline(BODY, reply([]));
  check('normalises the request body', r.input.image_url === BODY.image_url &&
    r.input.site_id === 'SITE-MUM-401');
  check('carries asset_tag through', r.input.asset_tag === 'EXT-401-02');
  check('carries inspector_id through', r.input.inspector_id === 'TECH-8891');

  const bare = runPipeline({ image_url: BODY.image_url }, reply([]));
  check('site_id defaults rather than throwing', bare.input.site_id === 'unknown');
  check('absent asset_tag becomes null, not an empty string', bare.input.asset_tag === null);
  check('absent inspector_id becomes UNASSIGNED', bare.input.inspector_id === 'UNASSIGNED');

  check('whitespace-only asset_tag is treated as absent',
    runPipeline({ ...BODY, asset_tag: '   ' }, reply([])).input.asset_tag === null);
  check('over-long asset_tag is truncated, not rejected',
    runPipeline({ ...BODY, asset_tag: 'X'.repeat(200) }, reply([])).input.asset_tag.length === 64);

  check('a valid request is marked validation_ok', r.input.validation_ok === true);
  check('the allow-listed host is extracted without a URL global',
    r.input.image_host === 'abc.public.blob.vercel-storage.com', r.input.image_host);
}

// ===========================================================================
section('1a. SSRF hardening on image_url (roadmap 7.4, restricted sandbox)');
{
  // These run under the same shadowed-globals harness as everything else, so a
  // `new URL(...)` creeping back into the validator fails here rather than in
  // production. That is exactly how the US pipeline's ReferenceError was caught.
  function rejectionOf(overrides) {
    return runPipeline({ ...BODY, ...overrides }, reply([])).rejected;
  }

  const http = rejectionOf({ image_url: 'http://abc.public.blob.vercel-storage.com/x.jpg' });
  check('rejects plain http', http && http.validation_error_code === 'IMAGE_URL_NOT_HTTPS',
    http && http.validation_error_code);

  const host = rejectionOf({ image_url: 'https://evil.example.com/x.jpg' });
  check('rejects a non-allow-listed host',
    host && host.validation_error_code === 'IMAGE_HOST_NOT_ALLOWED', host && host.validation_error_code);

  const malformed = rejectionOf({ image_url: 'not-a-url-at-all' });
  check('rejects a malformed URL',
    malformed && malformed.validation_error_code === 'IMAGE_URL_MALFORMED',
    malformed && malformed.validation_error_code);

  // Allow-list bypass via userinfo: the real host is the part after the "@".
  const userinfo = rejectionOf({ image_url: 'https://abc.public.blob.vercel-storage.com@evil.example/x.jpg' });
  check('rejects the credentials-in-URL allow-list bypass',
    userinfo && userinfo.validation_error_code === 'IMAGE_URL_HAS_USERINFO',
    userinfo && userinfo.validation_error_code);

  const ipv6 = rejectionOf({ image_url: 'https://[::1]/x.jpg' });
  check('rejects an IPv6 literal host',
    ipv6 && /IP_LITERAL|NOT_ALLOWED/.test(ipv6.validation_error_code), ipv6 && ipv6.validation_error_code);

  // The metadata endpoint is the payload that makes SSRF worth having: on Oracle
  // Cloud and every other provider it hands out instance credentials.
  const meta = rejectionOf({ image_url: 'https://169.254.169.254/latest/meta-data/' });
  check('rejects the cloud metadata address',
    meta && /IMAGE_HOST_PRIVATE|IMAGE_HOST_NOT_ALLOWED/.test(meta.validation_error_code),
    meta && meta.validation_error_code);

  const loopback = rejectionOf({ image_url: 'https://localhost:5678/rest/workflows' });
  check('rejects loopback, which is where n8n itself listens',
    loopback && /IMAGE_HOST_PRIVATE|IMAGE_HOST_NOT_ALLOWED/.test(loopback.validation_error_code),
    loopback && loopback.validation_error_code);

  const rfc1918 = rejectionOf({ image_url: 'https://192.168.1.1/admin' });
  check('rejects an RFC1918 literal',
    rfc1918 && /IMAGE_HOST_PRIVATE|IMAGE_HOST_NOT_ALLOWED/.test(rfc1918.validation_error_code),
    rfc1918 && rfc1918.validation_error_code);

  const file = rejectionOf({ image_url: 'file:///etc/passwd' });
  check('rejects a non-http scheme',
    file && /NOT_HTTPS|MALFORMED/.test(file.validation_error_code), file && file.validation_error_code);

  // A suffix allow-list must not match a lookalike registered domain.
  const lookalike = rejectionOf({ image_url: 'https://evil-public.blob.vercel-storage.com.attacker.test/x.jpg' });
  check('a suffix match cannot be spoofed by appending a domain',
    lookalike && lookalike.validation_error_code === 'IMAGE_HOST_NOT_ALLOWED',
    lookalike && lookalike.validation_error_code);

  // Accepts, so the guard is not simply refusing everything.
  const ok = runPipeline({ ...BODY, image_url: 'https://x.s3.amazonaws.com/a.jpg' }, reply([]));
  check('accepts another allow-listed object store', ok.rejected === undefined,
    ok.rejected && ok.rejected.validation_error);
  const withQuery = runPipeline({ ...BODY, image_url: BODY.image_url + '?v=2&x=1' }, reply([]));
  check('tolerates a query string', withQuery.rejected === undefined,
    withQuery.rejected && withQuery.rejected.validation_error);
  const withPort = runPipeline({ ...BODY, image_url: 'https://abc.public.blob.vercel-storage.com:443/a.jpg' }, reply([]));
  check('tolerates an explicit port on an allowed host', withPort.rejected === undefined,
    withPort.rejected && withPort.rejected.validation_error);
}

// ===========================================================================
section('1b. Structured HTTP 400 instead of throwing (roadmap 7.5)');
{
  // The old node threw on a missing image_url. A throw aborts the execution
  // before Respond_to_Webhook1, so the caller got a 500 with an empty body and
  // could not tell a bad request from a broken workflow.
  let threw = false;
  let result = null;
  try {
    result = runPipeline({ site_id: 'S' }, reply([]));
  } catch (e) {
    threw = true;
  }
  check('a missing image_url no longer throws', threw === false);
  check('a missing image_url is reported as a structured rejection',
    result && result.rejected && result.rejected.validation_error_code === 'IMAGE_URL_MISSING',
    result && result.rejected && result.rejected.validation_error_code);
  check('a rejection sets validation_ok false, which ROUTE_Validation switches on',
    result.rejected.validation_ok === false);

  // The whole point of validating before BUILD_Vision_Payload: rejected input
  // costs nothing. Every audit is a metered vision call.
  check('a rejected request never reaches the vision model',
    result.modelWasCalled === false);

  const bad = runPipeline({ ...BODY, image_url: 'https://evil.example.com/x.jpg' }, reply([])).rejected;
  check('a rejection carries a human-readable reason',
    typeof bad.validation_error === 'string' && bad.validation_error.includes('evil.example'),
    bad.validation_error);
  check('a rejection echoes the offending value back',
    typeof bad.received_value === 'string' && bad.received_value.length > 0);
  check('a rejection is timestamped', typeof bad.rejected_at === 'string' && bad.rejected_at.length > 0);
  check('the offending value is truncated, so a huge body cannot bloat the response',
    runPipeline({ ...BODY, image_url: 'https://evil.example.com/' + 'x'.repeat(5000) }, reply([]))
      .rejected.received_value.length <= 200);

  // Reporting the wrong cause is what sent an operator debugging a valid URL in
  // the US pipeline. A disallowed host must not be described as malformed.
  check('a disallowed host is never reported as a malformed URL',
    !/not a valid absolute URL/.test(bad.validation_error), bad.validation_error);
}

// ===========================================================================
section('2. BUILD_Vision_Payload — the prompt');
{
  const p = runPipeline(BODY, reply([])).payload;
  const prompt = p.payload.messages[0].content[1].text;

  check('the model is NOT asked for a status', !/"status"\s*:/.test(prompt));
  check('the prompt says a returned verdict will be ignored',
    /Do NOT return an overall status/.test(prompt));
  check('the prompt asks for severities', /"severity": "CRITICAL or MAJOR or MINOR"/.test(prompt));

  check('cites Indian standards', /IS 2190/.test(prompt) && /IS 15683/.test(prompt) &&
    /National Building Code of India 2016/.test(prompt));
  check('states the enforcing statute, not just the code',
    /Maharashtra Fire Prevention and Life Safety Measures/.test(prompt));
  check('names the AHJ', /Chief Fire Officer/.test(prompt));
  check('forbids US instruments', /Do NOT cite NFPA, IFC or UL\/FM/.test(prompt));
  check('asks for the ISI/BIS mark, the India-specific conformity mark',
    /ISI \/ BIS mark/.test(prompt));

  check('every checklist item carries a severity tag',
    (prompt.match(/\[(CRITICAL|MAJOR|MINOR)\]/g) || []).length === p.checklist_codes.length);
  check('the checklist has an entry for blocked access, the classic critical',
    /ACCESS_BLOCKED \[CRITICAL\]/.test(prompt));

  // The prompt is built by joining an array; nulls are dropped and blank lines
  // kept. Filtering empty strings instead would collapse it into one block.
  check('blank lines survive the join (the prompt is readable, not one block)',
    /\n\nCHECKLIST:/.test(prompt));
  check('the asset tag reaches the prompt when supplied',
    /ASSET TAG \(claimed\): EXT-401-02/.test(prompt));
  check('no empty asset-tag line when absent',
    !/ASSET TAG/.test(runPipeline({ image_url: BODY.image_url }, reply([]))
      .payload.payload.messages[0].content[1].text));

  check('checklist_severity is exported for the parser to validate against',
    p.checklist_severity.ACCESS_BLOCKED === 'CRITICAL' &&
    p.checklist_severity.ISI_MARK_MISSING === 'MINOR');
  check('temperature is 0 — a compliance verdict should not be creative',
    p.payload.temperature === 0);
  check('the image is passed by URL in the OpenRouter shape',
    p.payload.messages[0].content[0].image_url.url === BODY.image_url);
}

// ===========================================================================
section('3. DERIVE_Verdict — the verdict is computed, not read (roadmap 7.1)');
{
  const clean = runPipeline(BODY, reply([])).derived;
  check('no findings -> COMPLIANT', clean.status === 'COMPLIANT', clean.status);
  check('COMPLIANT raises no alert', clean.alert_required === false);
  check('risk score is 0 on a clean audit', clean.risk_score === 0);
  check('violations is an empty array, not absent', Array.isArray(clean.violations) &&
    clean.violations.length === 0);

  const minor = runPipeline(BODY, reply([DEF_MINOR])).derived;
  check('MINOR only -> CONDITIONAL, not NON-COMPLIANT', minor.status === 'CONDITIONAL', minor.status);
  check('CONDITIONAL still raises an alert', minor.alert_required === true);
  check('risk score weights MINOR at 5', minor.risk_score === 5);

  const major = runPipeline(BODY, reply([DEF_MAJOR])).derived;
  check('MAJOR -> NON-COMPLIANT', major.status === 'NON-COMPLIANT', major.status);
  check('risk score weights MAJOR at 25', major.risk_score === 25);
  check('MAJOR alone does not set the critical flag', major.critical === false);

  const crit = runPipeline(BODY, reply([DEF_CRITICAL])).derived;
  check('CRITICAL -> NON-COMPLIANT', crit.status === 'NON-COMPLIANT');
  check('CRITICAL sets the critical flag', crit.critical === true);
  check('one CRITICAL saturates the risk score', crit.risk_score === 100);

  const mixed = runPipeline(BODY, reply([DEF_MAJOR, DEF_MINOR, DEF_MINOR])).derived;
  check('counts are per tier', mixed.major_count === 1 && mixed.minor_count === 2 &&
    mixed.critical_count === 0);
  check('deficiency_count counts all tiers', mixed.deficiency_count === 3);
  check('risk score adds tiers (25 + 5 + 5)', mixed.risk_score === 35);
  check('risk score is capped at 100',
    runPipeline(BODY, reply([DEF_CRITICAL, DEF_CRITICAL, DEF_MAJOR])).derived.risk_score === 100);

  // ---- the bug this whole change exists to prevent ----
  const lying = runPipeline(BODY, reply([DEF_CRITICAL], { status: 'COMPLIANT' })).derived;
  check('a model claiming COMPLIANT alongside a CRITICAL finding is overruled',
    lying.status === 'NON-COMPLIANT', lying.status);
  const novel = runPipeline(BODY, reply([], { status: 'PASS' })).derived;
  check('an unrecognised model status ("PASS") is ignored entirely',
    novel.status === 'COMPLIANT' && novel.alert_required === false);
  const novelBad = runPipeline(BODY, reply([DEF_MAJOR], { status: 'PARTIAL' })).derived;
  check('a model status of "PARTIAL" cannot suppress the alert',
    novelBad.alert_required === true && novelBad.status === 'NON-COMPLIANT');
}

// ===========================================================================
section('4. Severity resolution biases upward, in both directions');
{
  // The checklist is a floor: policy says a discharged unit is CRITICAL.
  const downplayed = runPipeline(BODY, reply([
    { ...DEF_CRITICAL, severity: 'MINOR' }
  ])).derived;
  check('the model cannot downgrade a checklist-CRITICAL code',
    downplayed.critical_count === 1 && downplayed.status === 'NON-COMPLIANT');

  // But the model may still escalate: reaching for a MINOR code to describe
  // something worse must not be flattened back down.
  const escalated = runPipeline(BODY, reply([
    { ...DEF_MINOR, severity: 'CRITICAL' }
  ])).derived;
  check('the model CAN escalate above the checklist severity',
    escalated.critical_count === 1, 'critical_count=' + escalated.critical_count);

  const garbage = runPipeline(BODY, reply([
    { code: 'SOMETHING_ELSE', severity: 'CATASTROPHIC', finding: 'x' }
  ])).derived;
  check('an unrecognised severity normalises to MAJOR, never MINOR',
    garbage.major_count === 1 && garbage.minor_count === 0);
  check('a missing severity normalises to MAJOR',
    runPipeline(BODY, reply([{ code: 'GAUGE_OUT_OF_RANGE_TYPO', finding: 'x' }]))
      .derived.major_count === 1);

  check('a code outside the checklist is flagged, not dropped',
    garbage.deficiency_count === 1 &&
    garbage.unknown_codes.length === 1 &&
    garbage.unknown_codes[0] === 'SOMETHING_ELSE');
  check('a recognised code produces no unknown_codes noise',
    runPipeline(BODY, reply([DEF_MAJOR])).derived.unknown_codes.length === 0);
  check('a deficiency with no code at all is kept as UNSPECIFIED',
    runPipeline(BODY, reply([{ severity: 'MAJOR', finding: 'unlabelled' }]))
      .derived.deficiencies[0].code === 'UNSPECIFIED');
  check('violations carry the severity prefix, so the flat list is still ordered information',
    runPipeline(BODY, reply([DEF_CRITICAL])).derived.violations[0]
      .startsWith('[CRITICAL] '));
}

// ===========================================================================
section('5. Precedence: a confidence gate must never hide a life-safety finding');
{
  const lowConf = runPipeline(BODY, reply([], { confidence: 'LOW' })).derived;
  check('LOW confidence with no findings -> REINSPECT', lowConf.status === 'REINSPECT', lowConf.status);
  check('REINSPECT raises an alert', lowConf.alert_required === true);
  check('REINSPECT explains itself', lowConf.reinspect_reasons.some(function (r) {
    return /confidence is LOW/.test(r);
  }));

  const poor = runPipeline(BODY, reply([], { image_quality: 'POOR' })).derived;
  check('POOR image quality with no findings -> REINSPECT', poor.status === 'REINSPECT');
  check('POOR image quality says to retake the photograph',
    poor.reinspect_reasons.some(function (r) { return /retake/i.test(r); }));

  check('a model-flagged reinspect_required is honoured',
    runPipeline(BODY, reply([], { reinspect_required: true })).derived.status === 'REINSPECT');

  // The asymmetry that matters: a false alarm costs a van; a missed blocked exit
  // does not.
  const critLow = runPipeline(BODY, reply([DEF_CRITICAL], {
    confidence: 'LOW', image_quality: 'POOR'
  })).derived;
  check('CRITICAL outranks weak evidence -> NON-COMPLIANT, not REINSPECT',
    critLow.status === 'NON-COMPLIANT', critLow.status);
  check('the reinspect flag is still recorded alongside the failure',
    critLow.reinspect_required === true);

  // Weak evidence outranks an ordinary deficiency: a MAJOR seen badly should be
  // re-shot rather than reported as a confident failure.
  const majorLow = runPipeline(BODY, reply([DEF_MAJOR], { confidence: 'LOW' })).derived;
  check('weak evidence outranks a MAJOR -> REINSPECT', majorLow.status === 'REINSPECT',
    majorLow.status);
  check('the MAJOR finding is not lost when the status is REINSPECT',
    majorLow.major_count === 1 && majorLow.deficiencies.length === 1);
}

// ===========================================================================
section('6. Malformed model output');
{
  const broken = runPipeline(BODY, 'I am afraid I cannot help with that.').derived;
  check('unparseable output -> ERROR, not a silent pass', broken.status === 'ERROR', broken.status);
  check('ERROR raises an alert (a broken pass is not a clean bill)',
    broken.alert_required === true);
  check('ERROR is not reported as critical', broken.critical === false);
  check('ERROR demands reinspection', broken.reinspect_required === true);
  check('ERROR records AI_PARSE_ERROR in violations',
    broken.violations.indexOf('AI_PARSE_ERROR') !== -1);
  check('ERROR says the whole checklist is unverified',
    broken.unverifiable_items.length === 1);
  check('ERROR keeps a model excerpt for debugging',
    typeof broken.raw_model_excerpt === 'string' && broken.raw_model_excerpt.length > 0);
  check('ERROR still carries site identity',
    broken.site_id === 'SITE-MUM-401' && broken.asset_tag === 'EXT-401-02');
  check('ERROR still carries the evidence URL', broken.image_url === BODY.image_url);

  check('markdown code fences are stripped before parsing',
    runPipeline(BODY, '```json\n' + reply([DEF_MAJOR]) + '\n```').derived.status === 'NON-COMPLIANT');
  check('an empty model response -> ERROR',
    runPipeline(BODY, '').derived.status === 'ERROR');
  check('a JSON array instead of an object -> ERROR',
    runPipeline(BODY, '[]').derived.status === 'ERROR');
  check('a missing choices envelope -> ERROR',
    runPipeline(BODY, null, { rawApiResponse: {} }).derived.status === 'ERROR');

  // Type confusion, not absence: the model returns the right keys with wrong types.
  const sloppy = runPipeline(BODY, model({
    equipment_type: 'Extinguisher', confidence: 'high', image_quality: 'good',
    observations: 'ok', deficiencies: 'not an array', unverifiable_items: 'one thing'
  })).derived;
  check('lowercase enum values are accepted case-insensitively', sloppy.confidence === 'HIGH');
  check('a non-array deficiencies value degrades to no findings, not a crash',
    sloppy.deficiency_count === 0);
  check('a bare string unverifiable_items becomes a one-element array',
    sloppy.unverifiable_items.length === 1);
  check('an out-of-enum confidence falls back to MEDIUM, not LOW',
    runPipeline(BODY, reply([], { confidence: 'VERY HIGH' })).derived.confidence === 'MEDIUM');
}

// ===========================================================================
section('7. SHAPE_Response — a DB outage must not swallow a finding (roadmap 7.3)');
{
  const ok = runPipeline(BODY, reply([DEF_MAJOR])).response;
  check('a successful write reports persisted: true', ok.persisted === true);
  check('the row id becomes record_id, so the record is addressable', ok.record_id === 4711);
  check('audit_id is null — India mints none', ok.audit_id === null);

  const down = runPipeline(BODY, reply([DEF_CRITICAL]), { dbFails: true });
  check('a DB failure still produces a verdict', down.response.status === 'NON-COMPLIANT');
  check('a DB failure reports persisted: false', down.response.persisted === false);
  check('a DB failure yields no record_id (there is no record to address)',
    down.response.record_id === null);
  check('a DB failure STILL fires the alert', down.alerted === true);
  check('the alert says it is the only copy of the finding',
    /only copy/i.test(down.alert.telegram_message));
  check('the Slack body says so too', /only copy/i.test(down.alert.slack_message));
  check('the email body says so too', /only copy/i.test(down.alert.email_html));

  check('the response contract keeps the field names the dashboard reads',
    ok.status !== undefined && ok.confidence !== undefined &&
    ok.equipment_type !== undefined && ok.observations !== undefined &&
    Array.isArray(ok.violations) && ok.site_id !== undefined &&
    ok.audit_timestamp !== undefined);
  check('severity_counts is shaped like the US response',
    ok.severity_counts.major === 1 && ok.severity_counts.critical === 0);
  check('deficiencies reach the response', ok.deficiencies.length === 1);
  check('alert_required is exposed for IF_NonCompliant to branch on',
    ok.alert_required === true);
  check('a COMPLIANT audit sets alert_required false and skips the notifier',
    runPipeline(BODY, reply([])).response.alert_required === false &&
    runPipeline(BODY, reply([])).alerted === false);

  check('the workflow now states advisory_only itself, not just the frontend',
    ok.advisory_only === true);
  check('certification is explicitly disclaimed', ok.certification_eligible === false);
  check('sign-off is declared pending, not absent', ok.signoff_status === 'PENDING');
  check('the scope note names Form B as what this is NOT',
    /Form B/.test(ok.scope_note));
  check('code_basis names NBC 2016 Part 4',
    /2016, Part 4/.test(ok.code_basis.fire_code_edition));
  check('code_basis names the enforcing statute',
    /Maharashtra Fire Prevention/.test(ok.code_basis.life_safety_code));

  // audit-report.tsx renders code_basis.fire_code as the ENTIRE basis line and
  // falls back to REGIONS.IND.codeBasisFallback when it is absent. If the two
  // diverge, shipping a code_basis makes the displayed statute worse, not better.
  const regionsTs = readFileSync(join(REPO, 'lib', 'regions.ts'), 'utf8');
  // Both literals are written as multi-line concatenations, so compare the joined
  // values rather than searching the source for a fragment — a fragment search
  // would keep passing after either side was reworded.
  const fallbackMatch = regionsTs.match(/codeBasisFallback:\s*((?:'[^']*'\s*\+?\s*)+),/);
  const fallbackText = fallbackMatch
    ? (fallbackMatch[1].match(/'[^']*'/g) || []).map(function (s) { return s.slice(1, -1); }).join('')
    : null;
  check('the dashboard fallback text was found in lib/regions.ts',
    typeof fallbackText === 'string' && fallbackText.length > 40, String(fallbackText));
  check('code_basis.fire_code matches that fallback word for word',
    ok.code_basis.fire_code === fallbackText,
    'workflow: ' + ok.code_basis.fire_code + ' | regions.ts: ' + fallbackText);
  check('code_basis resolves to IN-MH, the jurisdiction key sign-off will reuse',
    ok.code_basis.jurisdiction_resolved === 'IN-MH');
  check('the evidence URL survives to the response', ok.image_url === BODY.image_url);
  check('audit_timestamp is a valid ISO instant',
    !isNaN(new Date(ok.audit_timestamp).getTime()));
}

// ===========================================================================
section('8. BUILD_Alert');
{
  const crit = runPipeline(BODY, reply([DEF_CRITICAL])).alert;
  check('a critical finding leads with CRITICAL', /CRITICAL FINDING/.test(crit.telegram_message));
  check('the subject leads with the severity, not the site',
    /AQUILA IND \u2014 CRITICAL:/.test(crit.email_subject));
  check('the action text says to attend now', /Attend the site now/.test(crit.telegram_message));
  check('the severity line replaces the undifferentiated verdict',
    /Severity    : 1 CRITICAL/.test(crit.telegram_message));
  check('the risk score is shown', /Risk score  : 100\/100/.test(crit.telegram_message));
  check('the asset tag is shown, so the van knows which device',
    /Asset       : EXT-401-02/.test(crit.telegram_message));
  check('the code reference travels with the finding',
    /Code: IS 2190/.test(crit.telegram_message));
  check('the remediation travels with the finding',
    /Fix:  Withdraw and refill/.test(crit.telegram_message));

  const minor = runPipeline(BODY, reply([DEF_MINOR])).alert;
  check('a MINOR-only audit is framed as not a failure',
    /DEFICIENCIES NOTED \u2014 NOT A FAILURE/.test(minor.telegram_message));
  check('a MINOR-only audit does not demand attendance',
    /no immediate attendance/.test(minor.telegram_message));

  const re = runPipeline(BODY, reply([], { confidence: 'LOW' })).alert;
  check('REINSPECT explains why rather than listing findings',
    /WHY REINSPECTION IS NEEDED/.test(re.telegram_message));
  check('REINSPECT warns against recording it as a pass',
    /do not record this as a pass/.test(re.telegram_message));

  const err = runPipeline(BODY, 'garbage').alert;
  check('ERROR says the site was NOT inspected', /NOT INSPECTED/.test(err.telegram_message));

  // Telegram posts with parse_mode: HTML. An unescaped & or < loses the entire
  // message — and loses it on exactly the messiest findings.
  const nasty = runPipeline(BODY, reply([{
    code: 'PHYSICAL_DAMAGE_OR_CORROSION', severity: 'MAJOR',
    finding: 'Hose <cracked> & nozzle missing',
    code_reference: 'IS 2190 <cl. 7>', remediation: 'Replace hose & nozzle'
  }])).alert;
  check('Telegram HTML-escapes & in a finding', !/Hose <cracked>/.test(nasty.telegram_message) &&
    /&amp;/.test(nasty.telegram_message));
  check('Telegram HTML-escapes angle brackets',
    /&lt;cracked&gt;/.test(nasty.telegram_message));
  check('Slack escapes the same characters', /&lt;cracked&gt;/.test(nasty.slack_message));
  check('the email body escapes them too', /&lt;cracked&gt;/.test(nasty.email_html));
  check('escaping does not eat our own formatting',
    /\u2501{10}/.test(nasty.telegram_message));

  check('the footer is KRATU AI Labs, not the old company',
    /KRATU AI Labs/.test(crit.telegram_message) &&
    !/Arvami/.test(crit.telegram_message) && !/FireScan/.test(crit.telegram_message));
  check('the email footer is rebranded too',
    /KRATU AI LABS/.test(crit.email_html) && !/Arvami/.test(crit.email_html));
  check('every channel disclaims Form B certification',
    /not a Form B certificate/i.test(crit.telegram_message) &&
    /not a Form B certificate/i.test(crit.slack_message) &&
    /not a Form B certificate/i.test(crit.email_html));

  check('the notifier output keeps the field names SEND_Slack/SEND_Telegram read',
    typeof crit.slack_message === 'string' && typeof crit.telegram_message === 'string' &&
    typeof crit.email_html === 'string' && typeof crit.email_subject === 'string');
  check('legacy fields the Gmail node and any downstream consumer read are intact',
    crit.site_id === 'SITE-MUM-401' && crit.status === 'NON-COMPLIANT' &&
    typeof crit.alert === 'string' && Array.isArray(crit.violations));

  const unver = runPipeline(BODY, reply([DEF_MAJOR], {
    unverifiable_items: ['Refill date not legible']
  })).alert;
  check('items that could not be verified are surfaced, not silently dropped',
    /Could not be verified from the photograph: Refill date not legible/
      .test(unver.telegram_message));

  const drift = runPipeline(BODY, reply([
    { code: 'MADE_UP_CODE', severity: 'MAJOR', finding: 'x' }
  ])).alert;
  check('checklist drift is reported to a human',
    /codes we do not recognise \(MADE_UP_CODE\)/.test(drift.telegram_message));
}

// ===========================================================================
section('9. AI_Field_Audit_v2.json wiring');
{
  const wf = JSON.parse(readFileSync(join(REPO, 'AI_Field_Audit_v2.json'), 'utf8'));
  const by = {};
  wf.nodes.forEach(function (n) { by[n.name] = n; });

  check('the webhook path is unchanged (lib/regions.ts depends on it)',
    by.Webhook.parameters.path === 'audit-field-photov2');

  // Every audit is a paid vision call, so an open webhook is a metered spend
  // endpoint. audit-history has required Header Auth from the start.
  check('the audit webhook requires Header Auth',
    by.Webhook.parameters.authentication === 'headerAuth');
  // Recorded so the workflow imports ready-to-run, like the Postgres credential.
  // Omitting it would mean a re-import silently drops the binding — and because an
  // unbound headerAuth webhook fails closed, that presents as every India audit
  // being rejected rather than as a missing setting.
  check('the audit webhook has its Header Auth credential bound',
    by.Webhook.credentials?.httpHeaderAuth?.id === 'aIwM7jr752xJv7Ss',
    JSON.stringify(by.Webhook.credentials));
  check('the IND and US webhooks use DIFFERENT credentials',
    by.Webhook.credentials.httpHeaderAuth.id !== '6MT2Rxb3T92TjMu5');
  check('the proxy sends the header the credential checks',
    readFileSync(join(REPO, 'app', 'api', 'audit', 'route.ts'), 'utf8')
      .indexOf("AUTH_HEADER = 'x-audit-api-key'") !== -1);

  // Pinned webhook data changes behaviour, and v2's pinData had to be stripped once
  // already because it contained an operator IP address. All three workflows are
  // un-pinned in n8n; no artifact may re-pin them on import.
  check('the workflow carries no pinData',
    JSON.parse(readFileSync(join(REPO, 'AI_Field_Audit_v2.json'), 'utf8')).pinData === undefined);
  check('LOG_Audit still targets field_audit_logs, not the US table',
    by.LOG_Audit.parameters.table.value === 'field_audit_logs');
  check('the workflow still ships active: true, matching production', wf.active === true);

  check('LOG_Audit tolerates failure instead of aborting the run',
    by.LOG_Audit.onError === 'continueRegularOutput');
  check('LOG_Audit always outputs data, so SHAPE_Response still runs on failure',
    by.LOG_Audit.alwaysOutputData === true);
  check('LOG_Audit retries before degrading to persisted: false',
    by.LOG_Audit.retryOnFail === true && by.LOG_Audit.maxTries === 3);
  check('the Postgres credential reference survived the patch',
    by.LOG_Audit.credentials.postgres.id === 'n7fXon6ujJTrnF7w');

  check('SHAPE_Response exists', by.SHAPE_Response !== undefined);
  check('the chain is LOG_Audit -> SHAPE_Response -> IF_NonCompliant',
    wf.connections.LOG_Audit.main[0][0].node === 'SHAPE_Response' &&
    wf.connections.SHAPE_Response.main[0][0].node === 'IF_NonCompliant');

  // ---------------------------------------------------- roadmap 7.5 wiring
  check('ROUTE_Validation exists', by.ROUTE_Validation !== undefined);
  check('RESPOND_BadRequest exists', by.RESPOND_BadRequest !== undefined);
  check('the chain is PARSE_Input -> ROUTE_Validation',
    wf.connections.PARSE_Input.main[0][0].node === 'ROUTE_Validation',
    JSON.stringify(wf.connections.PARSE_Input));
  check('ROUTE_Validation routes valid input to BUILD_Vision_Payload on output 0',
    wf.connections.ROUTE_Validation.main[0][0].node === 'BUILD_Vision_Payload');
  check('ROUTE_Validation routes a rejection to RESPOND_BadRequest on output 1',
    wf.connections.ROUTE_Validation.main[1][0].node === 'RESPOND_BadRequest');
  check('ROUTE_Validation switches on validation_ok',
    by.ROUTE_Validation.parameters.output === '={{ $json.validation_ok ? 0 : 1 }}',
    by.ROUTE_Validation.parameters.output);
  check('RESPOND_BadRequest answers 400, not 200',
    by.RESPOND_BadRequest.parameters.options.responseCode === 400,
    String(by.RESPOND_BadRequest.parameters.options.responseCode));
  check('RESPOND_BadRequest returns the error code and reason, not an empty body',
    by.RESPOND_BadRequest.parameters.responseBody.indexOf('validation_error_code') !== -1 &&
    by.RESPOND_BadRequest.parameters.responseBody.indexOf('validation_error') !== -1);
  // The gate must sit before the paid call, or it saves nothing.
  check('nothing routes PARSE_Input straight to BUILD_Vision_Payload any more',
    JSON.stringify(wf.connections.PARSE_Input).indexOf('BUILD_Vision_Payload') === -1);

  // ---------------------------------------------------- roadmap 7.6 wiring
  check('Claude_Vision_API has a timeout, so a hung provider cannot hold the run open',
    by.Claude_Vision_API.parameters.options.timeout === 120000,
    String(by.Claude_Vision_API.parameters.options.timeout));
  check('Claude_Vision_API retries before failing over',
    by.Claude_Vision_API.retryOnFail === true && by.Claude_Vision_API.maxTries === 3);
  check('Claude_Vision_API routes failure to an error output instead of aborting',
    by.Claude_Vision_API.onError === 'continueErrorOutput', by.Claude_Vision_API.onError);
  check('Vision_Fallback exists', by.Vision_Fallback !== undefined);
  check('Claude_Vision_API output 0 continues to PARSE_Response',
    wf.connections.Claude_Vision_API.main[0][0].node === 'PARSE_Response');
  check('Claude_Vision_API output 1 goes to Vision_Fallback',
    wf.connections.Claude_Vision_API.main[1][0].node === 'Vision_Fallback');
  check('Vision_Fallback rejoins the chain at PARSE_Response',
    wf.connections.Vision_Fallback.main[0][0].node === 'PARSE_Response');
  // A fallback on the same vendor shares the outage it is meant to survive.
  check('the fallback is a different vendor from the primary',
    by.Vision_Fallback.parameters.body.indexOf("'openai/gpt-4o'") !== -1,
    by.Vision_Fallback.parameters.body);
  // Re-rendering the prompt would risk grading against a different checklist.
  check('the fallback reuses the payload BUILD_Vision_Payload already rendered',
    by.Vision_Fallback.parameters.body.indexOf("$('BUILD_Vision_Payload').first().json.payload") !== -1);
  check('Vision_Fallback also has a timeout',
    by.Vision_Fallback.parameters.options.timeout === 120000);
  check('Vision_Fallback continues rather than aborting if it fails too',
    by.Vision_Fallback.onError === 'continueRegularOutput');
  check('Vision_Fallback carries the OpenRouter credential, so it imports ready-to-run',
    by.Vision_Fallback.credentials?.httpHeaderAuth?.id === 'Yo4OGxALKxIBKco8',
    JSON.stringify(by.Vision_Fallback.credentials));
  check('IF_NonCompliant still routes true to the notifier and both branches to the responder',
    wf.connections.IF_NonCompliant.main[0].some(function (c) { return c.node === 'NOTIFY_OpsManager'; }) &&
    wf.connections.IF_NonCompliant.main[0].some(function (c) { return c.node === 'Respond_to_Webhook1'; }) &&
    wf.connections.IF_NonCompliant.main[1][0].node === 'Respond_to_Webhook1');

  const cond = by.IF_NonCompliant.parameters.conditions.conditions[0];
  check('IF_NonCompliant branches on a boolean, not a status string',
    cond.leftValue === '={{ $json.alert_required }}' && cond.operator.type === 'boolean');
  check('no node still compares against the literal "NON-COMPLIANT"',
    JSON.stringify(by.IF_NonCompliant).indexOf('NON-COMPLIANT') === -1);

  const cols = by.LOG_Audit.parameters.columns.value;
  ['deficiencies', 'unverifiable_items', 'reinspect_reasons', 'critical',
   'critical_count', 'major_count', 'minor_count', 'deficiency_count',
   'risk_score', 'image_quality', 'reinspect_required'].forEach(function (c) {
    check('LOG_Audit persists ' + c, cols[c] !== undefined);
  });
  check('jsonb columns are written as JSON text',
    cols.deficiencies === '={{ JSON.stringify($json.deficiencies) }}');
  check('every mapped column has a schema entry, or the n8n UI drops it',
    by.LOG_Audit.parameters.columns.schema.length >= Object.keys(cols).length);

  check('the Gmail recipient resolves from the environment, never a personal inbox',
    by['Send a message'].parameters.sendTo.indexOf('$env.AUDIT_ALERT_EMAIL_TO') !== -1);
  check('the Gmail node still ships disabled', by['Send a message'].disabled === true);
  check('the orphaned base64 pair stays disabled',
    by.DOWNLOAD_Image.disabled === true && by.EXTRACT_Base64.disabled === true);

  // The workflow JSON must match the files this harness tested, or the tests
  // prove nothing about what actually runs.
  const fileOf = {
    PARSE_Input: 'ind_01_validate_input.js',
    BUILD_Vision_Payload: 'ind_02_build_payload.js',
    PARSE_Response: 'ind_03_derive_verdict.js',
    SHAPE_Response: 'ind_04_shape_response.js',
    NOTIFY_OpsManager: 'ind_05_build_alert.js'
  };
  Object.keys(fileOf).forEach(function (nodeName) {
    const onDisk = readFileSync(join(NODES, fileOf[nodeName]), 'utf8');
    check(nodeName + ' in the JSON matches scripts/nodes/' + fileOf[nodeName],
      by[nodeName].parameters.jsCode === onDisk,
      'run: python3 scripts/patch_india_workflow.py');
  });
}

// ------------------------------------------------------------------ report
console.log('\n' + '='.repeat(64));
console.log('PASS: ' + pass + '   FAIL: ' + fail);
if (fail) {
  console.log('\nFAILURES');
  failures.forEach(function (f) { console.log('  - ' + f); });
}
console.log('='.repeat(64));
process.exit(fail === 0 ? 0 : 1);
