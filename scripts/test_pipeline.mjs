/**
 * Offline test harness for the US audit pipeline.
 *
 * Simulates the n8n Code-node runtime ($input, $('NodeName'), $env) and runs the
 * seven Code nodes in sequence against mocked OpenRouter responses. This lets the
 * decision logic — which is the part that actually matters for a compliance
 * system — be verified without an n8n instance, a database or a model call.
 *
 * Run:  node scripts/test_pipeline.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const NODES = join(HERE, 'nodes');

function loadNode(file) {
  const src = readFileSync(join(NODES, file), 'utf8');
  // Code-node sources are function bodies: they end in `return [...]`.
  return new Function('$input', '$', '$env', src);
}

const N = {
  validate: loadNode('01_validate_input.js'),
  codeBasis: loadNode('02_resolve_code_basis.js'),
  payload: loadNode('03_build_vision_payload.js'),
  score: loadNode('04_parse_and_score.js'),
  dbRow: loadNode('05_shape_db_row.js'),
  report: loadNode('06_build_report.js'),
  response: loadNode('07_shape_response.js')
};

const items = (arr) => ({
  first: () => arr[0],
  all: () => arr,
  last: () => arr[arr.length - 1]
});

/** Runs the full chain. `modelContent` is the raw string the model "returned". */
function runPipeline(body, modelContent, opts = {}) {
  const bag = {};

  const ref = (name) => {
    if (!bag[name]) throw new Error('Test harness: node not yet run: ' + name);
    return items(bag[name]);
  };
  const env = {};

  bag.Webhook = [{ json: { body } }];
  bag.VALIDATE_Input = N.validate(items(bag.Webhook), ref, env);
  bag.RESOLVE_CodeBasis = N.codeBasis(items(bag.VALIDATE_Input), ref, env);
  bag.BUILD_Vision_Payload = N.payload(items(bag.RESOLVE_CodeBasis), ref, env);

  // Mock the OpenRouter chat-completions envelope.
  const apiResponse = opts.rawApiResponse !== undefined
    ? opts.rawApiResponse
    : {
        model: opts.model || 'anthropic/claude-sonnet-4-5',
        choices: [{ message: { content: modelContent }, finish_reason: opts.finishReason || 'stop' }],
        usage: { prompt_tokens: 1800, completion_tokens: 640 }
      };

  bag.Vision_Primary = [{ json: apiResponse }];
  bag.PARSE_And_Score = N.score(items(bag.Vision_Primary), ref, env);
  bag.SHAPE_DbRow = N.dbRow(items(bag.PARSE_And_Score), ref, env);

  // Simulate the Postgres node's output (or a failure).
  bag.LOG_Audit = opts.dbFails
    ? [{ json: { error: 'connection refused' } }]
    : [{ json: { audit_id: bag.PARSE_And_Score[0].json.audit_id } }];

  bag.BUILD_Report = N.report(items(bag.LOG_Audit), ref, env);
  bag.SHAPE_Response = N.response(items(bag.BUILD_Report), ref, env);

  return {
    validated: bag.VALIDATE_Input[0].json,
    basis: bag.RESOLVE_CodeBasis[0].json,
    payload: bag.BUILD_Vision_Payload[0].json,
    scored: bag.PARSE_And_Score[0].json,
    dbRow: bag.SHAPE_DbRow[0].json,
    report: bag.BUILD_Report[0].json,
    response: bag.SHAPE_Response[0].json
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

const GOOD_URL = 'https://abc.public.blob.vercel-storage.com/ext.png';
const baseBody = {
  image_url: GOOD_URL,
  site_id: 'site-ca-lax-014',
  jurisdiction: 'CA',
  equipment_hint: 'PORTABLE_FIRE_EXTINGUISHER',
  inspector_id: 'TECH-4471'
};

const jsonOf = (o) => JSON.stringify(o);

// ===========================================================================
section('1. Input validation and SSRF hardening');

try {
  runPipeline({ ...baseBody, image_url: 'http://abc.public.blob.vercel-storage.com/x.png' }, '{}');
  check('rejects plain http', false, 'no error thrown');
} catch (e) {
  check('rejects plain http', /must use https/.test(e.message), e.message);
}

try {
  runPipeline({ ...baseBody, image_url: 'https://evil.example.com/x.png' }, '{}');
  check('rejects non-allow-listed host', false, 'no error thrown');
} catch (e) {
  check('rejects non-allow-listed host', /not allow-listed/.test(e.message), e.message);
}

try {
  runPipeline({ ...baseBody, image_url: '' }, '{}');
  check('rejects missing image_url', false, 'no error thrown');
} catch (e) {
  check('rejects missing image_url', /image_url" is required/.test(e.message), e.message);
}

{
  const r = runPipeline(baseBody, jsonOf({
    equipment_type: 'PORTABLE_FIRE_EXTINGUISHER', image_quality: 'GOOD',
    confidence: 'HIGH', reinspect_required: false, reinspect_reasons: [],
    observations: 'Clean unit.', deficiencies: [], unverifiable_items: [],
    impairment_suspected: false, impairment_basis: null
  }));
  check('site_id normalised to upper case', r.validated.site_id === 'SITE-CA-LAX-014', r.validated.site_id);
  check('audit_id minted with US prefix', /^FA-US-\d{8}-[0-9A-F]{8}-[0-9A-Z]{5}$/.test(r.validated.audit_id), r.validated.audit_id);
  check('idempotency_key is stable for same input',
    r.validated.idempotency_key === runPipeline(baseBody, jsonOf({ deficiencies: [] })).validated.idempotency_key);
}

// ===========================================================================
section('2. Jurisdiction resolution (the core US difference)');

const cleanModel = jsonOf({
  equipment_type: 'PORTABLE_FIRE_EXTINGUISHER', equipment_subtype: 'ABC dry chemical, 10 lb',
  image_quality: 'GOOD', confidence: 'HIGH', reinspect_required: false, reinspect_reasons: [],
  observations: 'Unit mounted on bracket, gauge in green, tag legible.',
  deficiencies: [], unverifiable_items: ['Agent weight cannot be confirmed from a photograph.'],
  impairment_suspected: false, impairment_basis: null
});

{
  const ca = runPipeline({ ...baseBody, jurisdiction: 'CA' }, cleanModel).basis.code_basis;
  check('CA resolves to California Fire Code', /California Fire Code/.test(ca.fire_code), ca.fire_code);
  check('CA uses Pacific timezone', ca.timezone === 'America/Los_Angeles', ca.timezone);
  check('CA applies Cal/OSHA rather than federal 29 CFR 1910',
    /Cal\/OSHA/.test(ca.osha_overlay) && !/29 CFR 1910 \u2014 Subpart/.test(ca.osha_overlay), ca.osha_overlay);

  const fl = runPipeline({ ...baseBody, jurisdiction: 'FL' }, cleanModel).basis.code_basis;
  check('FL resolves to NFPA-based FFPC, not the IFC',
    /Florida Fire Prevention Code/.test(fl.fire_code) && /NOT the IFC/.test(fl.fire_code), fl.fire_code);
  check('FL cites NFPA 101 Florida edition', /NFPA 101/.test(fl.life_safety_code), fl.life_safety_code);
  check('FL uses federal OSHA (no State Plan)', /29 CFR 1910/.test(fl.osha_overlay), fl.osha_overlay);

  const nyc = runPipeline({ ...baseBody, jurisdiction: 'NY-NYC' }, cleanModel).basis.code_basis;
  check('NY-NYC matches the home-rule city entry',
    nyc.jurisdiction_resolved === 'NY-NYC' && /FDNY/.test(nyc.ahj_label), nyc.ahj_label);

  const tx = runPipeline({ ...baseBody, jurisdiction: 'TX-AUSTIN' }, cleanModel).basis.code_basis;
  check('unknown city falls back to its state entry', tx.jurisdiction_resolved === 'TX', tx.jurisdiction_resolved);
  check('state fallback is flagged as not an exact match', tx.code_basis_confident === false, String(tx.code_basis_confident));

  const zz = runPipeline({ ...baseBody, jurisdiction: 'ZZ' }, cleanModel).basis.code_basis;
  check('unknown jurisdiction falls back to model-code baseline',
    zz.jurisdiction_resolved === 'US-DEFAULT' && /International Fire Code/.test(zz.fire_code), zz.fire_code);
  check('fallback demands AHJ confirmation', zz.requires_ahj_confirmation === true);

  const noOsha = runPipeline({ ...baseBody, jurisdiction: 'FL', osha_workplace: false }, cleanModel).basis.code_basis;
  check('OSHA overlay can be opted out of', noOsha.osha_overlay === null, String(noOsha.osha_overlay));
}

// ===========================================================================
section('3. Prompt generation');

{
  const r = runPipeline({ ...baseBody, jurisdiction: 'FL' }, cleanModel);
  const prompt = r.payload.payload.messages[0].content[1].text;
  check('prompt embeds the resolved jurisdiction code', /Florida Fire Prevention Code/.test(prompt));
  check('prompt explicitly forbids Indian code references', /do NOT reference the National Building Code of India/.test(prompt));
  check('prompt teaches UL/FM as the ISI analogue', /UL Listing or FM Approval/.test(prompt));
  check('hinted equipment narrows to one checklist', r.payload.checklists_offered.length === 1, jsonOf(r.payload.checklists_offered));
  check('temperature pinned to 0 for stability', r.payload.payload.temperature === 0);

  const auto = runPipeline({ ...baseBody, equipment_hint: 'AUTO' }, cleanModel);
  check('AUTO offers all checklists for classification', auto.payload.checklists_offered.length >= 8,
    String(auto.payload.checklists_offered.length));
  const autoPrompt = auto.payload.payload.messages[0].content[1].text;
  check('AUTO prompt asks the model to classify first', /FIRST classify/.test(autoPrompt));
}

// ===========================================================================
section('4. Deterministic verdict derivation');

const critDef = {
  code: 'ACCESS_FULLY_BLOCKED', severity: 'CRITICAL',
  finding: 'Extinguisher completely blocked by stacked pallets.',
  observed: 'Pallets stacked in front of the cabinet.',
  requirement: 'Extinguishers must be accessible and unobstructed.',
  code_reference: 'NFPA 10 (2022) 6.1.3.3', remediation: 'Clear the obstruction immediately.',
  verification_needed: false
};
const majorDef = { ...critDef, code: 'GAUGE_OUT_OF_RANGE', severity: 'MAJOR', finding: 'Gauge needle below green.' };
const minorDef = { ...critDef, code: 'LISTING_LABEL_MISSING', severity: 'MINOR', finding: 'UL label illegible.' };

function scoreWith(overrides) {
  return runPipeline(baseBody, jsonOf({
    equipment_type: 'PORTABLE_FIRE_EXTINGUISHER', image_quality: 'GOOD', confidence: 'HIGH',
    reinspect_required: false, reinspect_reasons: [], observations: 'x',
    deficiencies: [], unverifiable_items: [], impairment_suspected: false, impairment_basis: null,
    ...overrides
  }));
}

{
  const clean = scoreWith({});
  check('no deficiencies -> COMPLIANT route 3',
    clean.scored.status === 'COMPLIANT' && clean.scored.route_index === 3, clean.scored.status);

  const minorOnly = scoreWith({ deficiencies: [minorDef] });
  check('minor only -> CONDITIONAL route 1 (not a blunt fail)',
    minorOnly.scored.status === 'CONDITIONAL' && minorOnly.scored.route_index === 1, minorOnly.scored.status);

  const majorOnly = scoreWith({ deficiencies: [majorDef] });
  check('major -> NON-COMPLIANT route 1',
    majorOnly.scored.status === 'NON-COMPLIANT' && majorOnly.scored.route_index === 1, majorOnly.scored.status);

  const crit = scoreWith({ deficiencies: [critDef] });
  check('critical -> NON-COMPLIANT route 0 with critical flag',
    crit.scored.status === 'NON-COMPLIANT' && crit.scored.route_index === 0 && crit.scored.critical === true);

  // The single most important behaviour in the whole workflow.
  const critLowConf = scoreWith({ deficiencies: [critDef], confidence: 'LOW', image_quality: 'POOR' });
  check('FAIL-SAFE: critical still escalates at LOW confidence / POOR image',
    critLowConf.scored.route_index === 0 && critLowConf.scored.status === 'NON-COMPLIANT',
    critLowConf.scored.status + ' route ' + critLowConf.scored.route_index);
  check('FAIL-SAFE escalation is recorded as confidence_gated',
    critLowConf.scored.confidence_gated === true);

  const lowConf = scoreWith({ deficiencies: [majorDef], confidence: 'LOW' });
  check('non-critical + LOW confidence -> REINSPECT route 2',
    lowConf.scored.status === 'REINSPECT' && lowConf.scored.route_index === 2, lowConf.scored.status);

  const poor = scoreWith({ image_quality: 'POOR', reinspect_required: true, reinspect_reasons: ['Too dark.'] });
  check('poor image -> REINSPECT route 2', poor.scored.route_index === 2, String(poor.scored.route_index));

  const impaired = scoreWith({ impairment_suspected: true, impairment_basis: 'Control valve appears closed.' });
  check('impairment alone escalates to route 0',
    impaired.scored.route_index === 0 && impaired.scored.critical === true);

  // Severity bias must be upward for unrecognised values.
  const weird = scoreWith({ deficiencies: [{ ...critDef, severity: 'kinda bad' }] });
  check('unrecognised severity biases up to MAJOR, never MINOR',
    weird.scored.deficiencies[0].severity === 'MAJOR', weird.scored.deficiencies[0].severity);

  // Risk scoring and de-duplication.
  const many = scoreWith({ deficiencies: [majorDef, minorDef] });
  check('risk score weights severities (25 + 5 = 30)', many.scored.risk_score === 30, String(many.scored.risk_score));
  const dupes = scoreWith({ deficiencies: [majorDef, { ...majorDef }] });
  check('duplicate deficiency codes are collapsed', dupes.scored.deficiency_count === 1, String(dupes.scored.deficiency_count));

  // SLA.
  check('critical SLA is immediate (0 h)', crit.scored.sla_hours === 0, String(crit.scored.sla_hours));
  check('major SLA is 72 h', majorOnly.scored.sla_hours === 72, String(majorOnly.scored.sla_hours));
  check('minor SLA is 30 days', minorOnly.scored.sla_hours === 720, String(minorOnly.scored.sla_hours));
  check('remediation due date is computed', typeof majorOnly.scored.remediation_due_at === 'string');

  // Honesty guarantees.
  check('clean result is never presented as a certification',
    clean.scored.certification_eligible === false && /not a certification/.test(clean.scored.scope_note));
  check('sign-off is always required', clean.scored.requires_licensed_inspector_signoff === true);
}

// ===========================================================================
section('5. Malformed model output handling');

{
  const fenced = runPipeline(baseBody, '```json\n' + cleanModel + '\n```');
  check('strips markdown code fences', fenced.scored.status === 'COMPLIANT', fenced.scored.status);

  const chatty = runPipeline(baseBody, 'Sure! Here is the audit:\n' + cleanModel + '\nLet me know if you need more.');
  check('tolerates preamble and trailing prose', chatty.scored.status === 'COMPLIANT', chatty.scored.status);

  const trailingComma = runPipeline(baseBody,
    '{"equipment_type":"PORTABLE_FIRE_EXTINGUISHER","confidence":"HIGH","image_quality":"GOOD",' +
    '"observations":"ok","deficiencies":[],"unverifiable_items":[],}');
  check('repairs trailing commas', trailingComma.scored.status === 'COMPLIANT', trailingComma.scored.status);

  const garbage = runPipeline(baseBody, 'I cannot analyse this image.');
  check('unparsable output -> ERROR route 4',
    garbage.scored.status === 'ERROR' && garbage.scored.route_index === 4, garbage.scored.status);
  check('ERROR still carries the audit_id for traceability', /^FA-US-/.test(garbage.scored.audit_id));

  const truncated = runPipeline(baseBody, '{"equipment_type":"PORT', { finishReason: 'length' });
  check('truncated response is diagnosed', truncated.scored.status === 'ERROR');

  const noChoices = runPipeline(baseBody, null, { rawApiResponse: { error: { message: 'rate limited' } } });
  check('provider error envelope -> ERROR route 4',
    noChoices.scored.status === 'ERROR' && noChoices.scored.route_index === 4);

  // String-encoded arrays (the bug that produced commit 08bdb4f in v2).
  const stringArrays = runPipeline(baseBody, jsonOf({
    equipment_type: 'PORTABLE_FIRE_EXTINGUISHER', confidence: 'HIGH', image_quality: 'GOOD',
    observations: 'ok', deficiencies: [majorDef],
    unverifiable_items: '["Weight not verifiable"]', reinspect_reasons: ''
  }));
  check('coerces string-encoded arrays', Array.isArray(stringArrays.scored.unverifiable_items) &&
    stringArrays.scored.unverifiable_items.length === 1, jsonOf(stringArrays.scored.unverifiable_items));
}

// ===========================================================================
section('6. Reporting, escaping and timezone');

{
  // A finding containing HTML-reserved characters, which is realistic because
  // fire-door clearances are written as "<1/8 in" and "3/4 in > gap".
  const trickyDef = {
    ...critDef, code: 'CLEARANCES_EXCESSIVE', severity: 'MAJOR',
    finding: 'Bottom clearance > 3/4 in and top gap <1/8 in tolerance & out of spec.'
  };
  const r = scoreWith({ deficiencies: [trickyDef] });
  const tg = r.report.telegram_message;
  check('Telegram body escapes & < >',
    tg.includes('&gt;') && tg.includes('&lt;') && tg.includes('&amp;'), 'escaping absent');
  check('Telegram markup tags survive escaping', /<b>Status:<\/b>/.test(tg));
  const bodyAfterTags = tg.replace(/<\/?(b|i|code)>/g, '');
  check('no unescaped raw angle brackets remain in Telegram body',
    !/[<>]/.test(bodyAfterTags), bodyAfterTags.match(/.{0,40}[<>].{0,40}/)?.[0]);

  check('email HTML escapes the same content', /&gt; 3\/4 in/.test(r.report.email_html));

  const ca = scoreWith({ deficiencies: [majorDef] });
  check('timestamp rendered in the site timezone (PT/PDT)',
    /P[DS]T/.test(ca.report.local_timestamp), ca.report.local_timestamp);
  const flReport = runPipeline({ ...baseBody, jurisdiction: 'FL' }, jsonOf({
    equipment_type: 'PORTABLE_FIRE_EXTINGUISHER', confidence: 'HIGH', image_quality: 'GOOD',
    observations: 'x', deficiencies: [majorDef], unverifiable_items: []
  }));
  check('Florida timestamp rendered Eastern', /E[DS]T/.test(flReport.report.local_timestamp),
    flReport.report.local_timestamp);

  const crit = scoreWith({ deficiencies: [critDef], impairment_suspected: true, impairment_basis: 'Valve closed.' });
  check('impairment notice generated for critical/impairment',
    typeof crit.report.impairment_notice === 'string' && /NFPA 25 Chapter 15/.test(crit.report.impairment_notice));
  check('impairment notice names the AHJ and insurer',
    /insurer/.test(crit.report.impairment_notice) && /fire watch/i.test(crit.report.impairment_notice));
  const cleanRep = scoreWith({});
  check('no impairment notice on a clean audit', cleanRep.report.impairment_notice === null);

  const dbDown = runPipeline(baseBody, jsonOf({
    equipment_type: 'PORTABLE_FIRE_EXTINGUISHER', confidence: 'HIGH', image_quality: 'GOOD',
    observations: 'x', deficiencies: [critDef], unverifiable_items: []
  }), { dbFails: true });
  check('database outage is surfaced, not silent', dbDown.report.persisted === false);
  check('un-persisted alert tells the operator to retain it',
    /could not be written to the audit database/.test(dbDown.report.alert));
  check('audit still escalates when the database is down', dbDown.scored.route_index === 0);
}

// ===========================================================================
section('7. Response contract and DB projection');

{
  const r = scoreWith({ deficiencies: [majorDef] });
  const resp = r.response;

  // Backward compatibility with the existing FIREHAWK dashboard.
  for (const f of ['status', 'confidence', 'equipment_type', 'observations', 'violations',
                   'site_id', 'audit_timestamp']) {
    check('response keeps dashboard field: ' + f, resp[f] !== undefined);
  }
  check('violations remains an array of strings',
    Array.isArray(resp.violations) && typeof resp.violations[0] === 'string', jsonOf(resp.violations));
  check('violations string carries severity and citation',
    /^\[MAJOR\]/.test(resp.violations[0]) && /NFPA 10/.test(resp.violations[0]), resp.violations[0]);

  check('response exposes the applied code basis', resp.code_basis && /California/.test(resp.code_basis.fire_code));
  check('response is flagged advisory-only', resp.advisory_only === true && resp.certification_eligible === false);
  check('response omits bulky notification bodies',
    resp.email_html === undefined && resp.slack_message === undefined && resp.telegram_message === undefined);
  check('response carries observability fields',
    resp.model_used !== undefined && resp.latency_ms !== undefined);

  const row = r.dbRow;
  check('db row serialises jsonb columns as strings',
    typeof row.deficiencies === 'string' && typeof row.code_basis === 'string');
  check('db jsonb columns are valid JSON', (() => {
    try { JSON.parse(row.deficiencies); JSON.parse(row.code_basis); JSON.parse(row.violations); return true; }
    catch (e) { return false; }
  })());
  check('db row carries the primary key', typeof row.audit_id === 'string' && row.audit_id.length > 0);
}

// ===========================================================================
section('8. DB projection matches the migration (autoMapInputData contract)');

{
  // The Postgres node uses "Map Automatically", which fails hard if an input key
  // has no matching column. This test makes schema drift a test failure rather
  // than a runtime error discovered in production.
  const sql = readFileSync(join(HERE, 'db', '001_field_audit_us_logs.sql'), 'utf8');
  const createStart = sql.indexOf('CREATE TABLE IF NOT EXISTS field_audit_us_logs');
  const createBody = sql.slice(createStart, sql.indexOf('\n);', createStart));

  const columns = new Set();
  for (const line of createBody.split('\n').slice(1)) {
    const m = line.match(/^\s{4}([a-z_]+)\s+(TEXT|JSONB|BOOLEAN|INTEGER|TIMESTAMPTZ)/);
    if (m) columns.add(m[1]);
  }
  check('parsed a plausible column list from the migration', columns.size >= 35, 'found ' + columns.size);

  const r = scoreWith({ deficiencies: [majorDef] });
  const rowKeys = Object.keys(r.dbRow);
  const orphans = rowKeys.filter((k) => !columns.has(k));
  check('every SHAPE_DbRow key exists as a column', orphans.length === 0, 'orphans: ' + orphans.join(', '));

  // Columns the workflow intentionally leaves to database defaults / later human action.
  const expectedUnset = new Set(['signoff_by', 'signoff_at', 'signoff_notes',
                                 'remediation_status', 'remediation_closed_at', 'created_at']);
  const unmapped = [...columns].filter((c) => !rowKeys.includes(c) && !expectedUnset.has(c));
  check('no column is unintentionally left unmapped', unmapped.length === 0, 'unmapped: ' + unmapped.join(', '));

  // NOT NULL columns must actually receive a value.
  const notNull = [];
  for (const line of createBody.split('\n')) {
    const m = line.match(/^\s{4}([a-z_]+)\s+\S+.*NOT NULL/);
    if (m && !/DEFAULT/.test(line)) notNull.push(m[1]);
  }
  const missingNotNull = notNull.filter((c) => r.dbRow[c] === undefined || r.dbRow[c] === null);
  check('all NOT NULL columns without defaults are populated',
    missingNotNull.length === 0, 'missing: ' + missingNotNull.join(', '));

  // Status values written must satisfy the CHECK constraint.
  const allowed = ['COMPLIANT', 'CONDITIONAL', 'NON-COMPLIANT', 'REINSPECT', 'ERROR'];
  const produced = [
    scoreWith({}).dbRow.status,
    scoreWith({ deficiencies: [minorDef] }).dbRow.status,
    scoreWith({ deficiencies: [majorDef] }).dbRow.status,
    scoreWith({ deficiencies: [critDef] }).dbRow.status,
    scoreWith({ image_quality: 'POOR' }).dbRow.status,
    runPipeline(baseBody, 'not json').dbRow.status
  ];
  check('every producible status satisfies the CHECK constraint',
    produced.every((s) => allowed.includes(s)), produced.join(','));
  check('all five status values are reachable',
    new Set(produced).size === 5, [...new Set(produced)].join(','));
}

// ===========================================================================
console.log('\n' + '='.repeat(64));
console.log('PASS: ' + pass + '   FAIL: ' + fail);
if (fail) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log('  - ' + f));
}
console.log('='.repeat(64));
process.exit(fail ? 1 : 0);
