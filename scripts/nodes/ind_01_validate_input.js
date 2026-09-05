/**
 * INDIA NODE 1 — PARSE_Input  (validate + normalise)
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
 * WHY THE NODE IS STILL CALLED PARSE_Input
 * ---------------------------------------------------------------------------
 * Its job grew from "normalise the body" to "validate, then normalise", but two
 * downstream nodes reach back for it by name — `$('PARSE_Input')` in
 * ind_02_build_payload.js and ind_03_derive_verdict.js. Renaming the node would
 * break both references and discard the node's execution history in n8n, so the
 * name stays and the filename carries the new meaning. PARSE_Response did the
 * same when it changed from transcribing a verdict to deriving one.
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
    'Image host is not allow-listed: ' + host + '. Add it to ALLOWED_IMAGE_HOSTS in PARSE_Input if this is intentional.',
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

// site_id is NOT upper-cased and its fallback is lower-case 'unknown', unlike the
// US node. That difference is deliberate: every India row already written carries
// this normalisation, and changing it now would split the history of a site
// across two spellings of its own id.
const site_id = clean(body.site_id, 'unknown', 64);

return [{
  json: {
    validation_ok: true,
    image_url: image_url,
    image_host: host,
    site_id: site_id,
    asset_tag: clean(body.asset_tag, '', 64) || null,
    inspector_id: clean(body.inspector_id, 'UNASSIGNED', 64)
  }
}];
