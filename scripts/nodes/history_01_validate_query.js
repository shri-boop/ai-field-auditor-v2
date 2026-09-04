/**
 * HISTORY NODE 1 — VALIDATE_Query
 * Mode: Run Once for All Items
 *
 * Validates a records lookup and builds the positional parameter array for the
 * region's SQL. Nothing here interpolates caller input into a query string.
 *
 * ---------------------------------------------------------------------------
 * WHY PARAMETERS AND NOT STRING BUILDING
 * ---------------------------------------------------------------------------
 * site_id, asset_tag and status are caller-controlled and land in a WHERE
 * clause. Assembling that clause with an n8n expression would be a textbook
 * SQL-injection hole into the safety log — and this table is append-only
 * evidence, so a successful injection could read or destroy audit history.
 *
 * The queries therefore use a FIXED parameter count per region, with each
 * optional filter expressed as ($n IS NULL OR column = $n). Fixed arity means
 * the array this node emits always lines up with the placeholders, whatever
 * subset of filters the caller supplied. The cost is that Postgres may choose a
 * sequential scan over idx_faus_site_time on some plans; at this table's size
 * that is the right trade against a hand-built WHERE clause.
 *
 * ---------------------------------------------------------------------------
 * THE TWO REGIONS ARE NOT SYMMETRIC
 * ---------------------------------------------------------------------------
 * field_audit_us_logs has audit_id as its primary key plus asset_tag,
 * jurisdiction, deficiencies, code_basis and sign-off columns.
 *
 * field_audit_logs (India) was created ad hoc — there is no DDL for it in this
 * repo. Its real shape, confirmed against the live database:
 *
 *   id              integer  PRIMARY KEY (field_audit_logs_pkey)
 *   equipment_type  text
 *   status          text
 *   confidence      text
 *   observations    text
 *   violations      text      (a stringified JSON array)
 *   site_id         text
 *   audit_timestamp text      <-- NOT a timestamp type
 *   created_at      timestamptz DEFAULT now()
 *
 * Two consequences drive the India query:
 *
 * 1. `audit_timestamp` is TEXT. Comparing it against a timestamptz parameter
 *    raises "operator does not exist: text >= timestamp with time zone", so the
 *    date range filters on `created_at` — a real timestamptz — instead. The two
 *    are written milliseconds apart in the same n8n execution, so they are
 *    interchangeable for range purposes. `audit_timestamp` is still returned for
 *    display.
 *
 * 2. There IS a primary key after all: `id`. India records therefore have a
 *    stable identifier, exposed as `record_id`, which is the IND analogue of the
 *    US `audit_id`. `audit_id` itself stays rejected for IND — it is a minted
 *    string that only the US workflow produces.
 *
 * Migration 003 added asset_tag, inspector_id and image_url to this table, so
 * asset_tag is now a valid IND filter and India records finally carry evidence.
 * Rows written before that migration have NULL in all three.
 *
 * Authentication is handled by the Webhook node's Header Auth credential, not
 * here: the Code node sandbox blocks env access, so a secret compared in JS
 * would have to be committed to this file.
 */

const body = $input.first().json.body || {};

function reject(code, message, received) {
  return [{
    json: {
      route_index: 0,
      query_ok: false,
      error_code: code,
      error: message,
      received_value: received === undefined ? null : String(received).slice(0, 200)
    }
  }];
}

// ------------------------------------------------------------------- region
const region = String(body.region || '').trim().toUpperCase();
if (region !== 'US' && region !== 'IND') {
  return reject('REGION_INVALID', '"region" must be "US" or "IND".', body.region);
}

// -------------------------------------------------------------- text filters
function cleanText(value, maxLength) {
  if (value === undefined || value === null) return null;
  const out = String(value).trim();
  if (!out) return null;
  return out.slice(0, maxLength || 64);
}

const site_id = cleanText(body.site_id, 64);
const asset_tag = cleanText(body.asset_tag, 64);
const audit_id = cleanText(body.audit_id, 96);
const status_raw = cleanText(body.status, 32);

// Constrain status to the values the US CHECK constraint allows, so a typo
// returns an explicit error instead of an empty result the caller reads as
// "this site is clean".
const STATUSES = ['COMPLIANT', 'CONDITIONAL', 'NON-COMPLIANT', 'REINSPECT', 'ERROR'];
let status = null;
if (status_raw) {
  status = status_raw.toUpperCase();
  if (STATUSES.indexOf(status) === -1) {
    return reject(
      'STATUS_INVALID',
      'Unknown "status". Expected one of: ' + STATUSES.join(', ') + '.',
      status_raw
    );
  }
}

// ------------------------------------------------------- record_id (IND only)
// The India analogue of audit_id: field_audit_logs.id, an integer primary key.
let record_id = null;
if (body.record_id !== undefined && body.record_id !== null && String(body.record_id).trim() !== '') {
  if (region !== 'IND') {
    return reject(
      'FILTER_UNSUPPORTED_FOR_REGION',
      'record_id applies to the India log only. Use audit_id for US records.',
      body.record_id
    );
  }
  const raw = String(body.record_id).trim();
  if (!/^\d+$/.test(raw)) {
    return reject('RECORD_ID_INVALID', '"record_id" must be a positive integer.', body.record_id);
  }
  record_id = parseInt(raw, 10);
  if (!(record_id > 0)) {
    return reject('RECORD_ID_INVALID', '"record_id" must be a positive integer.', body.record_id);
  }
}

// audit_id is a MINTED identifier and exists only on the US table. India has no
// equivalent — it has an integer primary key, offered as record_id — so the
// filter is refused rather than quietly ignored. Silently dropping a filter
// returns rows the caller did not ask for, which on an audit log is worse than
// an error.
if (region === 'IND' && audit_id) {
  return reject(
    'FILTER_UNSUPPORTED_FOR_REGION',
    'The India audit log has no audit_id column. Identify India records by site_id and timestamp.',
    audit_id
  );
}

// -------------------------------------------------------------- date filters
// Accepts YYYY-MM-DD or a full ISO instant. Bare dates are anchored at UTC
// midnight; `to` is EXCLUSIVE so a caller passing the same day for both gets
// that whole day rather than nothing.
function parseBoundary(value, label) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return { ok: true, value: null };
  }
  const raw = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(raw)) {
    return {
      ok: false,
      message: '"' + label + '" must be YYYY-MM-DD or a full ISO timestamp.'
    };
  }
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw + 'T00:00:00.000Z' : raw;
  const parsed = new Date(iso);
  if (isNaN(parsed.getTime())) {
    return { ok: false, message: '"' + label + '" is not a real date.' };
  }

  // JavaScript's Date silently ROLLS OVER an impossible calendar date rather
  // than failing: new Date('2026-02-31') is 3 March 2026, and isNaN never fires.
  // Left unchecked, a caller asking for a date that does not exist would receive
  // results from a different range and never be told the range had moved. On an
  // audit log that is a wrong answer delivered confidently.
  //
  // Probing the Y-M-D through Date.UTC validates the calendar date on its own,
  // independent of any time or offset in the rest of the string.
  const ymd = raw.slice(0, 10).split('-');
  const year = Number(ymd[0]);
  const month = Number(ymd[1]);
  const day = Number(ymd[2]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() + 1 !== month ||
    probe.getUTCDate() !== day
  ) {
    return {
      ok: false,
      message: '"' + label + '" is not a real calendar date (' + raw.slice(0, 10) + ').'
    };
  }

  return { ok: true, value: parsed.toISOString() };
}

const fromParsed = parseBoundary(body.from, 'from');
if (!fromParsed.ok) return reject('DATE_INVALID', fromParsed.message, body.from);

const toParsed = parseBoundary(body.to, 'to');
if (!toParsed.ok) return reject('DATE_INVALID', toParsed.message, body.to);

if (fromParsed.value && toParsed.value && fromParsed.value >= toParsed.value) {
  return reject(
    'DATE_RANGE_INVALID',
    '"from" must be earlier than "to". Note that "to" is exclusive.',
    fromParsed.value + ' .. ' + toParsed.value
  );
}

// ------------------------------------------------------------------ paging
// Capped so a caller cannot ask for the entire table in one response.
const MAX_LIMIT = 100;
let limit = parseInt(body.limit, 10);
if (isNaN(limit) || limit < 1) limit = 25;
if (limit > MAX_LIMIT) limit = MAX_LIMIT;

let offset = parseInt(body.offset, 10);
if (isNaN(offset) || offset < 0) offset = 0;

// Require at least one narrowing filter. An unbounded "give me everything"
// query against an append-only log is both a slow query and an enumeration
// primitive; the caller must say what they are looking for.
if (!site_id && !asset_tag && !audit_id && !record_id && !fromParsed.value && !toParsed.value) {
  return reject(
    'FILTER_REQUIRED',
    'Supply at least one of: site_id, asset_tag, audit_id, record_id, from, to. ' +
      'Unfiltered listing of the audit log is not permitted.',
    null
  );
}

// ------------------------------------------------------ positional parameters
// ORDER IS THE CONTRACT with the SQL in QUERY_US / QUERY_IND. Changing either
// side without the other silently mis-binds filters.
const params = region === 'US'
  //  $1        $2         $3        $4      $5                $6              $7     $8
  ? [site_id, asset_tag, audit_id, status, fromParsed.value, toParsed.value, limit, offset]
  //  $1        $2         $3          $4      $5                $6              $7     $8
  : [site_id, record_id, asset_tag, status, fromParsed.value, toParsed.value, limit, offset];

return [{
  json: {
    route_index: region === 'US' ? 1 : 2,
    query_ok: true,
    region: region,
    params: params,
    // Echoed back so the caller can confirm what was actually applied, and so
    // the UI can label a result set it may have re-fetched with defaults.
    applied: {
      site_id: site_id,
      asset_tag: asset_tag,
      audit_id: audit_id,
      record_id: record_id,
      status: status,
      from: fromParsed.value,
      to: toParsed.value,
      limit: limit,
      offset: offset
    },
    requested_at: new Date().toISOString()
  }
}];
