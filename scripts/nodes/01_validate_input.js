/**
 * NODE 1 — VALIDATE_Input
 * Mode: Run Once for All Items
 *
 * Responsibilities:
 *   - Hard schema validation of the inbound webhook body.
 *   - SSRF hardening: the image URL is caller-controllable and is later
 *     dereferenced by a third party (OpenRouter), so restrict scheme + host.
 *   - Mint a stable audit_id and an idempotency_key.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO `new URL(...)` HERE
 * ---------------------------------------------------------------------------
 * The n8n Code node executes inside a restricted `vm` context (the task
 * runner). Standard web globals are NOT guaranteed to exist there, and
 * `new URL(...)` throws a ReferenceError on this deployment.
 *
 * The original implementation wrapped it in `try { new URL(x) } catch { throw
 * 'not a valid absolute URL' }`. That catch block conflated two completely
 * different failures — "the caller sent bad input" and "my code cannot run in
 * this environment" — and reported the wrong one, sending the operator off to
 * debug a URL that was perfectly valid.
 *
 * Lesson applied below: parse with a regex (no global dependency), and never
 * let a catch block report an input error for what is actually an environment
 * or programming error.
 * ---------------------------------------------------------------------------
 *
 * FAILURE MODE
 * This node does not throw for caller mistakes. Throwing aborts the execution
 * before Respond_to_Webhook is reached, so the HTTP caller receives an empty
 * body and has no idea what was wrong. Instead it emits
 * `validation_ok: false` plus a structured error, and ROUTE_Validation returns
 * a proper HTTP 400. Cheap side benefit: a rejected request never reaches the
 * vision model, so malformed input costs nothing.
 *
 * Contract (POST body):
 *   image_url        (required) https URL on an allow-listed object store
 *   site_id          (optional) free-form site code
 *   jurisdiction     (optional) "CA" | "FL" | "NY-NYC" | "TX" ... default US-DEFAULT
 *   occupancy_type   (optional) NFPA 101 / IFC occupancy classification hint
 *   equipment_hint   (optional) skip classification and force a checklist
 *   inspector_id     (optional) who took the photo
 *   osha_workplace   (optional) bool, default true -> apply 29 CFR 1910 overlay
 *   asset_tag        (optional) client asset identifier
 */

const body = $input.first().json.body || {};

// Structured rejection -> HTTP 400 via ROUTE_Validation.
function reject(code, message, received) {
  return [{
    json: {
      validation_ok: false,
      validation_error_code: code,
      validation_error: message,
      received_value: received === undefined ? null : String(received).slice(0, 200),
      rejected_at: new Date().toISOString()
    }
  }];
}

// ---------------------------------------------------------------- image_url
const image_url = String(body.image_url || '').trim();
if (!image_url) {
  return reject('IMAGE_URL_MISSING', '"image_url" is required and was empty.', body.image_url);
}

// Absolute-URI shape: scheme "://" authority [ path/query/fragment ]
// Deliberately regex-based; see the header note above.
const ABSOLUTE_URL_RE = /^([A-Za-z][A-Za-z0-9+.\-]*):\/\/([^/?#\s]+)([/?#][^\s]*)?$/;
const match = image_url.match(ABSOLUTE_URL_RE);
if (!match) {
  return reject(
    'IMAGE_URL_MALFORMED',
    '"image_url" is not a valid absolute URL. Expected the form https://host/path.',
    image_url
  );
}

const scheme = match[1].toLowerCase();
const authority = match[2];

if (scheme !== 'https') {
  return reject('IMAGE_URL_NOT_HTTPS', '"image_url" must use https (received scheme "' + scheme + '").', image_url);
}

// Embedded credentials are a classic allow-list bypass: a naive check on
// "https://trusted-host.com@evil.example/x" reads the wrong host entirely.
if (authority.indexOf('@') !== -1) {
  return reject('IMAGE_URL_HAS_USERINFO', '"image_url" must not contain credentials or an "@" in the host.', image_url);
}

// Strip a trailing :port. Bracketed IPv6 literals are refused outright.
const host = authority.replace(/:\d+$/, '').toLowerCase();

if (!host) {
  return reject('IMAGE_URL_NO_HOST', '"image_url" has no host component.', image_url);
}
if (host.charAt(0) === '[') {
  return reject('IMAGE_URL_IP_LITERAL', 'IPv6 literal image hosts are not permitted.', image_url);
}

// Allow-list of object-store hosts we are willing to hand to the vision
// provider. Entries beginning with "." are suffix matches on the hostname.
const ALLOWED_IMAGE_HOSTS = [
  '.public.blob.vercel-storage.com',
  '.s3.amazonaws.com',
  '.s3.us-east-1.amazonaws.com',
  '.r2.cloudflarestorage.com',
  '.blob.core.windows.net',
  'storage.googleapis.com'
];

const hostAllowed = ALLOWED_IMAGE_HOSTS.some(function (entry) {
  return entry.charAt(0) === '.' ? host.endsWith(entry) : host === entry;
});
if (!hostAllowed) {
  return reject(
    'IMAGE_HOST_NOT_ALLOWED',
    'Image host is not allow-listed: ' + host + '. Add it to ALLOWED_IMAGE_HOSTS in VALIDATE_Input if this is intentional.',
    image_url
  );
}

// Defence in depth: refuse loopback / link-local / RFC1918 literals outright.
const PRIVATE_LITERAL = /^(localhost|0\.0\.0\.0|127\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/;
if (PRIVATE_LITERAL.test(host)) {
  return reject('IMAGE_HOST_PRIVATE', 'Private, loopback or link-local image hosts are not permitted.', image_url);
}

// ------------------------------------------------------------ site metadata
function clean(value, fallback, maxLength) {
  const out = String(value === undefined || value === null ? '' : value).trim();
  return (out || fallback).slice(0, maxLength || 64);
}

const site_id = clean(body.site_id, 'UNKNOWN-SITE', 64).toUpperCase();
const jurisdiction = clean(body.jurisdiction || body.state, 'US-DEFAULT', 16).toUpperCase();
const occupancy_type = clean(body.occupancy_type, 'BUSINESS', 48).toUpperCase();
const equipment_hint = clean(body.equipment_hint, 'AUTO', 48).toUpperCase().replace(/[\s-]+/g, '_');
const inspector_id = clean(body.inspector_id, 'UNASSIGNED', 64);
const asset_tag = clean(body.asset_tag, '', 64);

// OSHA general-industry duties attach to workplaces. Default to applying them;
// callers must explicitly opt out (e.g. pure residential common areas).
const osha_workplace = body.osha_workplace !== false;

// ------------------------------------------------- identity + idempotency
// FNV-1a: no crypto module needed (the Code node sandboxes builtins).
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const received_at = new Date().toISOString();
const idempotency_key = fnv1a(site_id + '|' + image_url + '|' + equipment_hint);
const audit_id =
  'FA-US-' +
  received_at.slice(0, 10).replace(/-/g, '') +
  '-' +
  idempotency_key.toUpperCase() +
  '-' +
  Math.random().toString(36).slice(2, 7).toUpperCase();

return [{
  json: {
    validation_ok: true,
    audit_id: audit_id,
    idempotency_key: idempotency_key,
    received_at: received_at,
    image_url: image_url,
    image_host: host,
    site_id: site_id,
    jurisdiction: jurisdiction,
    occupancy_type: occupancy_type,
    equipment_hint: equipment_hint,
    inspector_id: inspector_id,
    asset_tag: asset_tag,
    osha_workplace: osha_workplace
  }
}];
