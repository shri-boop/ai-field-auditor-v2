/**
 * NODE 1 — VALIDATE_Input
 * Mode: Run Once for All Items
 *
 * Responsibilities:
 *   - Hard schema validation of the inbound webhook body (fail fast, fail loud).
 *   - SSRF hardening: the image URL is attacker-controllable and is later
 *     dereferenced by a third party (OpenRouter), so restrict scheme + host.
 *   - Mint a stable audit_id and an idempotency_key so repeated submissions of
 *     the same photo for the same site collapse to one logical audit.
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

// ---------------------------------------------------------------- image_url
const image_url = String(body.image_url || '').trim();
if (!image_url) {
  throw new Error('VALIDATION: "image_url" is required and was empty.');
}

let parsed;
try {
  parsed = new URL(image_url);
} catch (e) {
  throw new Error('VALIDATION: "image_url" is not a valid absolute URL.');
}

if (parsed.protocol !== 'https:') {
  throw new Error('VALIDATION: "image_url" must use https (got ' + parsed.protocol + ').');
}

// Allow-list of object-store hosts we are willing to hand to the vision provider.
// Entries beginning with "." are treated as suffix matches on the hostname.
const ALLOWED_IMAGE_HOSTS = [
  '.public.blob.vercel-storage.com',
  '.s3.amazonaws.com',
  '.s3.us-east-1.amazonaws.com',
  '.r2.cloudflarestorage.com',
  '.blob.core.windows.net',
  'storage.googleapis.com'
];

const host = parsed.hostname.toLowerCase();
const hostAllowed = ALLOWED_IMAGE_HOSTS.some(function (entry) {
  return entry.charAt(0) === '.' ? host.endsWith(entry) : host === entry;
});
if (!hostAllowed) {
  throw new Error('VALIDATION: image host is not allow-listed: ' + host);
}

// Defence in depth: refuse loopback / link-local / RFC1918 literals outright.
const PRIVATE_LITERAL = /^(localhost|0\.0\.0\.0|127\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|\[?::1\]?)/;
if (PRIVATE_LITERAL.test(host)) {
  throw new Error('VALIDATION: private, loopback or link-local image hosts are not permitted.');
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
// FNV-1a: no crypto module needed (n8n sandboxes builtins by default).
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
