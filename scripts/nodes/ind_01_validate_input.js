/**
 * INDIA NODE 1 — VALIDATE_Input
 * Mode: Run Once for All Items
 *
 * Responsibilities:
 *   - Hard validation of the inbound webhook body.
 *   - SSRF hardening: `image_url` is caller-controlled and is later dereferenced
 *     by a third party (OpenRouter), so the scheme and host are restricted.
 *   - Normalise the fields the rest of the chain reads by name.
 *
 * Roadmap 7.4 (SSRF guard) and 7.5 (structured HTTP 400). Ported from the US
 * implementation, scripts/nodes/01_validate_input.js.
 *
 * ---------------------------------------------------------------------------
 * THE NAME
 * ---------------------------------------------------------------------------
 * This was PARSE_Input until its job grew from "normalise the body" to "validate,
 * then normalise". A node that enforces an input-validation boundary should say
 * so: "where is untrusted input validated?" is a question a security review will
 * ask, and a node called PARSE_Input is the wrong shape of answer. It also matches
 * the US workflow, which has always called this VALIDATE_Input.
 *
 * Two Code nodes reach back for it as `$('VALIDATE_Input')` —
 * ind_02_build_payload.js and ind_03_derive_verdict.js — so the name is a runtime
 * contract, not a label. Renaming it in the n8n UI alone would leave the live
 * workflow on one name and this repository's JavaScript on the other, and the next
 * re-import would reintroduce a reference to a node that no longer exists. The
 * rename therefore lives in patch_india_workflow.py (RENAMES), and
 * test_india.mjs asserts that every `$('...')` reference resolves to a real node.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO `new URL(...)` HERE
 * ---------------------------------------------------------------------------
 * The n8n Code node runs inside a restricted `vm` context. Standard web globals
 * are NOT guaranteed to exist there, and `new URL(...)` throws a ReferenceError
 * on this deployment.
 *
 * The US node learned this the hard way: its first version wrapped the call in
 * `try { new URL(x) } catch { throw 'not a valid absolute URL' }`, so an
 * environment failure was reported as a caller mistake and the operator was sent
 * off to debug a URL that was perfectly valid. Parsing is done with a regex
 * instead, and no catch block here reports an input error for what is actually a
 * programming or environment error.
 *
 * ---------------------------------------------------------------------------
 * FAILURE MODE — WHY THIS NO LONGER THROWS
 * ---------------------------------------------------------------------------
 * This node used to `throw` on a missing image_url. Throwing aborts the
 * execution before Respond_to_Webhook1 is reached, so the caller received HTTP
 * 500 with an empty body and no way to tell a bad request from a broken
 * workflow. It now emits `validation_ok: false` plus a structured error, and
 * ROUTE_Validation sends that to RESPOND_BadRequest as a real HTTP 400.
 *
 * Cheap side benefit: a rejected request never reaches the vision model, so
 * malformed input costs nothing. Every audit is a paid call.
 */

const body = $input.first().json.body || {};

// Structured rejection -> HTTP 400 via ROUTE_Validation. Never throw.
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
const image_url = String(body.image_url === undefined || body.image_url === null ? '' : body.image_url).trim();
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
//
// Deliberately identical to ALLOWED_IMAGE_HOSTS in the US node: both regions are
// fed by the same dashboard and the same /api/upload route, so letting the two
// lists drift would mean an image host that works in one region and not the
// other, for no reason a caller could discover.
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
// Unreachable while the allow-list holds, but it is the check that still stands
// if someone widens the list carelessly.
const PRIVATE_LITERAL = /^(localhost|0\.0\.0\.0|127\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/;
if (PRIVATE_LITERAL.test(host)) {
  return reject('IMAGE_HOST_PRIVATE', 'Private, loopback or link-local image hosts are not permitted.', image_url);
}

// ------------------------------------------------------------ site metadata
// asset_tag identifies WHICH device at the site. A site holds many devices and is
// audited repeatedly, so without it two audits of one address are
// indistinguishable. inspector_id records who captured the evidence; it is what
// prints as "Captured by" on the report, and it is deliberately NOT the sign-off
// name — that requires a qualified reviewer, not whoever ran the scan.
function clean(value, fallback, maxLength) {
  const out = String(value === undefined || value === null ? '' : value).trim();
  return (out || fallback).slice(0, maxLength || 64);
}

// ---------------------------------------------------------------------------
// site_id IS REQUIRED, AND IS NORMALISED
// ---------------------------------------------------------------------------
// It used to default to the string 'unknown' and was stored exactly as sent.
// Both halves of that were wrong for this product.
//
// Not normalising splits a building's history. The Records query matches exactly
// (`WHERE site_id = $1`), so 'site-mum-401' and 'SITE-MUM-401' are two different
// buildings. A technician who varies the case between visits produces two partial
// histories, which a customer experiences not as a data-entry nuance but as "your
// system lost my audits". It also breaks Form B before it is built: a half-yearly
// pack is per-building, and a pack assembled from one of two split histories is
// incomplete in a statutory filing.
//
// Defaulting is worse. An audit filed against 'unknown' cannot be found, cannot be
// billed and cannot go into a Form B pack — it consumed a paid vision call to
// produce a record nobody can use. Before 7.5 there was no way to refuse it; there
// is now, so it is refused.
const site_id_raw = String(body.site_id === undefined || body.site_id === null ? '' : body.site_id).trim();
if (!site_id_raw) {
  return reject(
    'SITE_ID_MISSING',
    '"site_id" is required. An audit that is not attached to a site cannot be retrieved, billed, or included in a Form B pack.',
    body.site_id
  );
}

// upper + trim, matching the US node, so the two regions agree on what one site is.
const site_id = site_id_raw.toUpperCase().slice(0, 64);

const asset_tag = clean(body.asset_tag, '', 64) || null;

// ---------------------------------------------------------------------------
// IDENTITY — a minted audit_id (migration 006)
// ---------------------------------------------------------------------------
// India had no minted identifier: the table is keyed on `id`, a serial the
// database assigns. That was survivable while the record was only ever read back
// through the dashboard, and stops being survivable at sign-off, for two reasons.
//
// SIGNOFF_DESIGN §14.1: field_audit_signoffs references the audit being signed by
// audit_id, so without one India rows simply cannot be signed. And a Form B
// evidence pack has to cite the audits supporting it — "row 4711 of
// field_audit_logs" is not a citation a Chief Fire Officer can check.
//
// Minted HERE rather than in DERIVE_Verdict so it exists before the paid vision
// call: an identifier assigned at the moment of validation can be logged against a
// request that later fails, whereas one assigned after the model returns cannot.
//
// FNV-1a rather than a crypto hash because the Code node sandboxes builtins — the
// same reason the US node uses it. This is an identifier, not a security token;
// collision resistance beyond uniqueness-per-site is not the requirement, and the
// random suffix plus the unique index in migration 006 carry that.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const received_at = new Date().toISOString();

// Stable for the same device photographed from the same URL, which is what makes
// it useful for spotting an accidental double-submission of one audit.
const idempotency_key = fnv1a(site_id + '|' + image_url + '|' + (asset_tag || ''));

// FA-IN-<date>-<hash>-<rand>, mirroring the US FA-US- format so one parser reads
// both. Note FA-IN- means minted at audit time; migration 006 backfilled older
// rows as FA-INB-, and that B is load-bearing — see the migration header.
const audit_id =
  'FA-IN-' +
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
    asset_tag: asset_tag,
    inspector_id: clean(body.inspector_id, 'UNASSIGNED', 64)
  }
}];
