/**
 * Offline test harness for the audit records lookup.
 *
 * Runs both history Code nodes under the same RESTRICTED sandbox as
 * test_pipeline.mjs — URL, require, process, fetch and friends shadowed as
 * undefined — so a node that only works because Node provides a global n8n does
 * not cannot pass here.
 *
 * The centrepiece is the parameter-contract check. VALIDATE_Query emits a
 * positional array and the SQL in the built workflow consumes it as $1..$n.
 * Those are two files that must change together, and nothing at runtime would
 * complain if they drifted — the query would simply bind site_id where it meant
 * status and return confidently wrong rows from a safety log. So the test parses
 * the generated JSON and asserts the arity matches.
 *
 * Run:  node scripts/test_history.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const NODES = join(HERE, 'nodes');
const WORKFLOW = join(HERE, '..', 'AI_Field_Audit_History.json');

const ABSENT_IN_SANDBOX = ['URL', 'URLSearchParams', 'require', 'process',
                           'fetch', 'Buffer', 'TextEncoder', 'structuredClone'];

function loadNode(file) {
  const src = readFileSync(join(NODES, file), 'utf8');
  const fn = new Function('$input', '$', '$env', ...ABSENT_IN_SANDBOX, src);
  const blanks = ABSENT_IN_SANDBOX.map(() => undefined);
  return (input, ref, env) => fn(input, ref, env, ...blanks);
}

const validateQuery = loadNode('history_01_validate_query.js');
const shapeResults = loadNode('history_02_shape_results.js');

const items = (arr) => ({
  first: () => arr[0],
  all: () => arr,
  last: () => arr[arr.length - 1]
});

let pass = 0;
let fail = 0;

function check(label, condition) {
  if (condition) {
    pass++;
    console.log('  \u2713 ' + label);
  } else {
    fail++;
    console.log('  \u2717 ' + label);
  }
}

function validate(body) {
  return validateQuery(items([{ json: { body } }]), () => {}, {})[0].json;
}

function shape(region, applied, rows) {
  const ref = (name) => {
    if (name === 'VALIDATE_Query') {
      return items([{ json: { region, applied } }]);
    }
    throw new Error('unexpected node reference: ' + name);
  };
  return shapeResults(items(rows.map((json) => ({ json }))), ref, {})[0].json;
}

// ---------------------------------------------------------------- region
console.log('\nregion');
check('rejects a missing region', validate({}).error_code === 'REGION_INVALID');
check('rejects an unknown region', validate({ region: 'EU', site_id: 'S' }).error_code === 'REGION_INVALID');
check('accepts lowercase us', validate({ region: 'us', site_id: 'S' }).query_ok === true);
check('US routes to index 1', validate({ region: 'US', site_id: 'S' }).route_index === 1);
check('IND routes to index 2', validate({ region: 'IND', site_id: 'S' }).route_index === 2);
check('a rejection routes to index 0', validate({ region: 'EU' }).route_index === 0);

// -------------------------------------------------------- mandatory filter
console.log('\nunbounded listing');
check('refuses a query with no filter at all',
  validate({ region: 'US' }).error_code === 'FILTER_REQUIRED');
check('refuses when only limit is supplied',
  validate({ region: 'US', limit: 50 }).error_code === 'FILTER_REQUIRED');
check('a date bound alone is a sufficient filter',
  validate({ region: 'US', from: '2026-09-01' }).query_ok === true);
check('blank strings do not count as a filter',
  validate({ region: 'US', site_id: '   ' }).error_code === 'FILTER_REQUIRED');

// ------------------------------------------------------- region asymmetry
console.log('\nregion asymmetry (India has an id PK and, since migration 003, asset_tag)');
check('IND now ACCEPTS an asset_tag filter (migration 003)',
  validate({ region: 'IND', asset_tag: 'EXT-1' }).query_ok === true);
check('IND rejects an audit_id filter — that identifier is minted by the US workflow only',
  validate({ region: 'IND', audit_id: 'FA-US-1' }).error_code === 'FILTER_UNSUPPORTED_FOR_REGION');
check('US accepts asset_tag', validate({ region: 'US', asset_tag: 'EXT-1' }).query_ok === true);
check('US accepts audit_id', validate({ region: 'US', audit_id: 'FA-US-1' }).query_ok === true);

// India has no minted audit_id, but it does have an integer primary key.
check('IND accepts record_id', validate({ region: 'IND', record_id: 7 }).query_ok === true);
check('record_id alone satisfies the mandatory-filter rule',
  validate({ region: 'IND', record_id: 7 }).applied.record_id === 7);
check('US rejects record_id (that is the IND analogue of audit_id)',
  validate({ region: 'US', record_id: 7 }).error_code === 'FILTER_UNSUPPORTED_FOR_REGION');
check('rejects a non-integer record_id',
  validate({ region: 'IND', record_id: 'abc' }).error_code === 'RECORD_ID_INVALID');
check('rejects a zero record_id',
  validate({ region: 'IND', record_id: 0 }).error_code === 'RECORD_ID_INVALID');
check('rejects a negative record_id',
  validate({ region: 'IND', record_id: -5 }).error_code === 'RECORD_ID_INVALID');

// ------------------------------------------------------------------ status
console.log('\nstatus');
check('rejects an unknown status instead of returning zero rows',
  validate({ region: 'US', site_id: 'S', status: 'PASSED' }).error_code === 'STATUS_INVALID');
check('accepts NON-COMPLIANT',
  validate({ region: 'US', site_id: 'S', status: 'non-compliant' }).applied.status === 'NON-COMPLIANT');

// ------------------------------------------------------------------- dates
console.log('\ndates');
check('accepts a bare YYYY-MM-DD and anchors it at UTC midnight',
  validate({ region: 'US', from: '2026-09-01' }).applied.from === '2026-09-01T00:00:00.000Z');
check('accepts a full ISO instant',
  validate({ region: 'US', from: '2026-09-01T10:30:00Z' }).applied.from === '2026-09-01T10:30:00.000Z');
check('rejects a malformed date', validate({ region: 'US', from: '01-09-2026' }).error_code === 'DATE_INVALID');
check('rejects an impossible date', validate({ region: 'US', from: '2026-02-31' }).error_code === 'DATE_INVALID');
check('rejects from >= to',
  validate({ region: 'US', from: '2026-09-02', to: '2026-09-01' }).error_code === 'DATE_RANGE_INVALID');
check('rejects an identical from and to (to is exclusive, so it matches nothing)',
  validate({ region: 'US', from: '2026-09-01', to: '2026-09-01' }).error_code === 'DATE_RANGE_INVALID');

// ------------------------------------------------------------------ paging
console.log('\npaging');
check('defaults limit to 25', validate({ region: 'US', site_id: 'S' }).applied.limit === 25);
check('caps limit at 100', validate({ region: 'US', site_id: 'S', limit: 5000 }).applied.limit === 100);
check('floors a nonsense limit to the default',
  validate({ region: 'US', site_id: 'S', limit: -3 }).applied.limit === 25);
check('rejects nothing for a negative offset, clamps to 0',
  validate({ region: 'US', site_id: 'S', offset: -10 }).applied.offset === 0);

// ------------------------------------------------- THE PARAMETER CONTRACT
console.log('\nparameter contract with the SQL');
const usParams = validate({
  region: 'US', site_id: 'S1', asset_tag: 'A1', audit_id: 'ID1',
  status: 'COMPLIANT', from: '2026-09-01', to: '2026-09-30', limit: 10, offset: 5
}).params;
const indParams = validate({
  region: 'IND', site_id: 'S1', record_id: 42, asset_tag: 'A1', status: 'COMPLIANT',
  from: '2026-09-01', to: '2026-09-30', limit: 10, offset: 5
}).params;

check('US emits 8 parameters', usParams.length === 8);
check('IND emits 8 parameters', indParams.length === 8);
check('US order is site, asset, audit, status, from, to, limit, offset',
  usParams[0] === 'S1' && usParams[1] === 'A1' && usParams[2] === 'ID1' &&
  usParams[3] === 'COMPLIANT' && usParams[4] === '2026-09-01T00:00:00.000Z' &&
  usParams[5] === '2026-09-30T00:00:00.000Z' && usParams[6] === 10 && usParams[7] === 5);
check('IND order is site, record_id, asset_tag, status, from, to, limit, offset',
  indParams[0] === 'S1' && indParams[1] === 42 && indParams[2] === 'A1' &&
  indParams[3] === 'COMPLIANT' && indParams[4] === '2026-09-01T00:00:00.000Z' &&
  indParams[5] === '2026-09-30T00:00:00.000Z' && indParams[6] === 10 && indParams[7] === 5);
check('record_id is bound as a number, not a string (the column is integer)',
  typeof indParams[1] === 'number');
check('omitted filters become null, never undefined (undefined breaks pg binding)',
  validate({ region: 'US', site_id: 'S' }).params.slice(1, 6).every((p) => p === null));

// Cross-check against the SQL that will actually consume the array.
const wf = JSON.parse(readFileSync(WORKFLOW, 'utf8'));
const nodeByName = {};
for (const n of wf.nodes) nodeByName[n.name] = n;

function placeholderCount(sql) {
  const found = new Set((sql.match(/\$\d+/g) || []).map((m) => m));
  return found.size;
}
const usSql = nodeByName.QUERY_US.parameters.query;
const indSql = nodeByName.QUERY_IND.parameters.query;

check('QUERY_US placeholder count matches the US array length',
  placeholderCount(usSql) === usParams.length);
check('QUERY_IND placeholder count matches the IND array length',
  placeholderCount(indSql) === indParams.length);
check('US placeholders are contiguous $1..$8',
  Array.from({ length: 8 }, (_, i) => '$' + (i + 1)).every((p) => usSql.includes(p)));
check('IND placeholders are contiguous $1..$8',
  Array.from({ length: 8 }, (_, i) => '$' + (i + 1)).every((p) => indSql.includes(p)));

// --------------------------------------------------------- SQL properties
console.log('\nSQL safety properties');
const allSql = usSql + '\n' + indSql;
check('no string concatenation of caller input into SQL',
  !/\{\{/.test(allSql));
check('read-only: no write verb in either query',
  !/\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|GRANT)\b/i.test(allSql));
check('no SELECT * (a schema change must error, not silently drop fields)',
  !/SELECT\s+\*/i.test(allSql));
check('to bound is exclusive', /_at\s*<\s*\$|timestamp\s*<\s*\$/.test(allSql));
check('US orders newest first on its timestamptz column',
  /ORDER BY audit_timestamp DESC/.test(usSql));

// --- regression guards for the India column-type bug ---------------------
// field_audit_logs.audit_timestamp is TEXT. Comparing it to a timestamptz
// parameter raises "operator does not exist: text >= timestamp with time zone",
// and ordering by it only looks right because the values happen to be
// fixed-width ISO-8601 Z strings. Both must use created_at, a real timestamptz.
console.log('\nIndia column types (audit_timestamp is TEXT)');
check('IND does NOT compare audit_timestamp against a parameter',
  !/audit_timestamp\s*(>=|<|=)\s*\$/.test(indSql));
check('IND range filter uses created_at', /created_at\s*>=\s*\$/.test(indSql) &&
  /created_at\s*<\s*\$/.test(indSql));
check('IND orders by created_at, not the text column',
  /ORDER BY created_at DESC/.test(indSql) && !/ORDER BY audit_timestamp/.test(indSql));
check('IND still selects audit_timestamp for display', /\baudit_timestamp\b/.test(indSql));
check('IND selects the id primary key so a record can be addressed exactly',
  /^SELECT\s+id,/m.test(indSql));
check('IND binds id as ::int, not ::text', /\$2::int\s+IS NULL OR id\s*=\s*\$2/.test(indSql));

// --- migration 003 parity -------------------------------------------------
console.log('\nIndia parity (migration 003: asset_tag, inspector_id, image_url)');
check('IND selects asset_tag', /\basset_tag\b/.test(indSql));
check('IND selects inspector_id', /\binspector_id\b/.test(indSql));
check('IND selects image_url, so a retrieved record can show its evidence',
  /\bimage_url\b/.test(indSql));
check('IND can filter on asset_tag', /asset_tag\s*=\s*\$3/.test(indSql));

const parityApplied = { limit: 25, site_id: 'S' };

const indParity = shape('IND', parityApplied, [{
  id: 7, site_id: 'S', status: 'COMPLIANT', violations: '[]',
  asset_tag: 'EXT-502-01', inspector_id: 'TECH-9', image_url: 'https://x/y.png',
  audit_timestamp: '2026-09-04T08:00:00Z', created_at: '2026-09-04T08:00:01Z'
}]).rows[0];
check('IND row exposes asset_tag', indParity.asset_tag === 'EXT-502-01');
check('IND row exposes inspector_id', indParity.inspector_id === 'TECH-9');
check('IND row exposes image_url', indParity.image_url === 'https://x/y.png');

// Rows written before migration 003 have no such columns at all.
const indLegacy = shape('IND', parityApplied, [{
  id: 1, site_id: 'S', status: 'COMPLIANT', violations: '[]',
  audit_timestamp: '2026-09-03T08:00:00Z'
}]).rows[0];
check('a pre-migration IND row yields null, not undefined, for the new columns',
  indLegacy.asset_tag === null && indLegacy.inspector_id === null &&
  indLegacy.image_url === null);
check('webhook requires header auth',
  nodeByName.Webhook.parameters.authentication === 'headerAuth');
check('both query nodes always output data, so a miss still reaches SHAPE_Results',
  nodeByName.QUERY_US.alwaysOutputData === true && nodeByName.QUERY_IND.alwaysOutputData === true);
check('workflow ships inactive', wf.active === false);

// ----------------------------------------------------------------- shaping
console.log('\nshaping');
const applied = { limit: 25, site_id: 'S1' };

const emptyResult = shape('US', applied, [{}]);
check('a miss yields count 0 rather than aborting', emptyResult.count === 0);
check('a miss is still query_ok', emptyResult.query_ok === true);
check('a miss is not reported as a full page', emptyResult.page_full === false);

const usRow = shape('US', applied, [{
  audit_id: 'FA-US-1', site_id: 'S1', status: 'NON-COMPLIANT', confidence: 'HIGH',
  equipment_type: 'PORTABLE_FIRE_EXTINGUISHER', observations: 'obs',
  violations: ['v1'], deficiencies: [{ code: 'X', severity: 'CRITICAL' }],
  unverifiable_items: ['u1'], critical: true, critical_count: 1, major_count: 2, minor_count: 0,
  risk_score: 100, code_basis: { fire_code: 'FFPC' }, advisory_only: true,
  signoff_status: 'PENDING', audit_timestamp: '2026-09-03T10:43:00Z',
  reinspect_reasons: [], impairment_suspected: false
}]).rows[0];

check('US row keeps the live response field names', usRow.status === 'NON-COMPLIANT' &&
  usRow.equipment_type === 'PORTABLE_FIRE_EXTINGUISHER');
check('US row rebuilds severity_counts from the three columns',
  usRow.severity_counts.critical === 1 && usRow.severity_counts.major === 2);
check('US row preserves the code_basis snapshot', usRow.code_basis.fire_code === 'FFPC');
check('US row carries deficiencies through', usRow.deficiencies.length === 1);
check('US row is flagged as retrieved', usRow.retrieved === true && usRow.region === 'US');
check('timestamps are normalised to ISO', usRow.audit_timestamp === '2026-09-03T10:43:00.000Z');

// India stores violations as a stringified JSON array in a text column.
const indRow = shape('IND', applied, [{
  site_id: 'SITE-MUM-401', status: 'NON-COMPLIANT', confidence: 'HIGH',
  equipment_type: 'Dry Powder Type Fire Extinguisher', observations: 'obs',
  violations: '["ISI mark not visible","Expiry date not visible"]',
  audit_timestamp: '2026-09-03T08:13:00Z'
}]).rows[0];

check('IND stringified violations are parsed into an array',
  Array.isArray(indRow.violations) && indRow.violations.length === 2);
check('IND row exposes the absent US fields as empty, not undefined',
  Array.isArray(indRow.deficiencies) && indRow.deficiencies.length === 0 &&
  indRow.audit_id === null);
check('IND row is flagged as retrieved', indRow.retrieved === true && indRow.region === 'IND');

const indKeyed = shape('IND', applied, [{
  id: 91, site_id: 'S', status: 'COMPLIANT', violations: '[]',
  audit_timestamp: '2026-09-03T08:13:00.000Z', created_at: '2026-09-03T08:13:01Z'
}]).rows[0];
check('IND row exposes the integer primary key as record_id', indKeyed.record_id === 91);
check('IND row carries created_at through', indKeyed.created_at === '2026-09-03T08:13:01.000Z');
check('IND falls back to created_at if the text timestamp is unusable',
  shape('IND', applied, [{
    id: 1, site_id: 'S', violations: '[]',
    audit_timestamp: 'not a date', created_at: '2026-09-03T08:13:01Z'
  }]).rows[0].audit_timestamp === '2026-09-03T08:13:01.000Z');

const indBadJson = shape('IND', applied, [{
  site_id: 'S', status: 'COMPLIANT', violations: 'not json at all',
  audit_timestamp: '2026-09-03T08:13:00Z'
}]).rows[0];
check('unparseable violations text is kept as one finding, never dropped',
  indBadJson.violations.length === 1 && indBadJson.violations[0] === 'not json at all');

// ------------------------------------------- IND severity model (migration 004)
console.log('\nIND severity model (migration 004)');

check('IND query selects the severity columns',
  /\bdeficiencies\b/.test(indSql) && /\bcritical_count\b/.test(indSql) &&
  /\brisk_score\b/.test(indSql) && /\bimage_quality\b/.test(indSql) &&
  /\breinspect_required\b/.test(indSql));

const indSeverity = shape('IND', applied, [{
  id: 12, site_id: 'SITE-MUM-401', status: 'NON-COMPLIANT', confidence: 'HIGH',
  violations: '["[CRITICAL] Cylinder discharged"]',
  deficiencies: [{ code: 'UNIT_MISSING_OR_DISCHARGED', severity: 'CRITICAL', finding: 'discharged' }],
  unverifiable_items: ['Refill date'], reinspect_reasons: [],
  critical: true, critical_count: 1, major_count: 0, minor_count: 2,
  deficiency_count: 3, risk_score: 100, image_quality: 'GOOD',
  reinspect_required: false,
  audit_timestamp: '2026-09-04T09:00:00Z', created_at: '2026-09-04T09:00:01Z'
}]).rows[0];

check('a retrieved IND record carries structured deficiencies',
  indSeverity.deficiencies.length === 1 &&
  indSeverity.deficiencies[0].severity === 'CRITICAL');
check('a retrieved IND record rebuilds severity_counts',
  indSeverity.severity_counts.critical === 1 && indSeverity.severity_counts.minor === 2);
check('a retrieved IND record carries the risk score and critical flag',
  indSeverity.risk_score === 100 && indSeverity.critical === true);
check('a retrieved IND record carries image_quality', indSeverity.image_quality === 'GOOD');
check('a retrieved IND record carries unverifiable_items',
  indSeverity.unverifiable_items.length === 1);

// jsonb normally arrives parsed, but tolerate a text column holding JSON.
check('IND deficiencies survive arriving as a JSON string',
  shape('IND', applied, [{
    id: 13, site_id: 'S', violations: '[]', audit_timestamp: '2026-09-04T09:00:00Z',
    deficiencies: '[{"severity":"MAJOR","finding":"gauge low"}]'
  }]).rows[0].deficiencies[0].finding === 'gauge low');

// A pre-004 row has no severities. Reporting them as 0 would be a fabrication:
// "0 critical findings" reads as a clean bill, when in fact nothing was counted.
const indPre004 = shape('IND', applied, [{
  id: 3, site_id: 'S', status: 'NON-COMPLIANT',
  violations: '["ISI mark not visible"]',
  audit_timestamp: '2026-05-01T08:00:00Z', created_at: '2026-05-01T08:00:01Z'
}]).rows[0];

check('a pre-004 IND row reports null severity counts, never zero',
  indPre004.severity_counts.critical === null &&
  indPre004.severity_counts.major === null &&
  indPre004.severity_counts.minor === null);
check('a pre-004 IND row reports null risk_score, never zero',
  indPre004.risk_score === null);
check('a pre-004 IND row reports null image_quality', indPre004.image_quality === null);
check('a pre-004 IND row still carries its flat violations',
  indPre004.violations.length === 1);
check('a pre-004 IND row has empty structured findings, not undefined',
  Array.isArray(indPre004.deficiencies) && indPre004.deficiencies.length === 0 &&
  Array.isArray(indPre004.unverifiable_items) && indPre004.unverifiable_items.length === 0);
check('critical is false, not null, on a pre-004 row (it gates an "attend now" queue)',
  indPre004.critical === false);

const fullPage = shape('US', { limit: 2 }, [
  { audit_id: 'a', audit_timestamp: '2026-09-03T10:00:00Z' },
  { audit_id: 'b', audit_timestamp: '2026-09-02T10:00:00Z' }
]);
check('a full page is signalled so the UI can offer paging honestly',
  fullPage.count === 2 && fullPage.page_full === true);

// ------------------------------------------------------------------ report
console.log('\n' + '='.repeat(64));
console.log('PASS: ' + pass + '   FAIL: ' + fail);
console.log('='.repeat(64));
process.exit(fail === 0 ? 0 : 1);
