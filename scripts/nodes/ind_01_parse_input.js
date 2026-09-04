/**
 * INDIA NODE 1 — PARSE_Input
 * Mode: Run Once for All Items
 *
 * Normalises the webhook body into the fields the rest of the chain reads by
 * name.
 *
 * SCOPE NOTE — this node is deliberately NOT hardened yet. It still throws on a
 * missing image_url, which aborts the run before Respond_to_Webhook1 and leaves
 * the caller with an empty body, and it performs no SSRF checks on a URL that a
 * third party (OpenRouter) will dereference. Those are roadmap items 7.4 and 7.5
 * and they need a validation-routing node plus a RESPOND_BadRequest node, which
 * is a change to the workflow's shape rather than to this file. The US
 * implementation to port from is scripts/nodes/01_validate_input.js.
 *
 * It lives in a file rather than inside the patch script so the JavaScript is
 * reviewable as JavaScript — the same reason the US nodes do.
 */

const body = $input.first().json.body || {};

const image_url = body.image_url || null;
const site_id = body.site_id || 'unknown';

if (!image_url || image_url.trim().length === 0) {
  throw new Error('Missing required field: image_url not found in request body.');
}

// asset_tag identifies WHICH device at the site. A site holds many devices and is
// audited repeatedly, so without it two audits of one address are
// indistinguishable. inspector_id records who captured the evidence; it is what
// prints as "Captured by" on the report, and it is deliberately NOT the sign-off
// name — that requires a qualified reviewer, not whoever ran the scan.
function clean(value, fallback, maxLength) {
  const out = String(value === undefined || value === null ? '' : value).trim();
  return (out || fallback).slice(0, maxLength || 64);
}

return [{
  json: {
    image_url: image_url.trim(),
    site_id: site_id,
    asset_tag: clean(body.asset_tag, '', 64) || null,
    inspector_id: clean(body.inspector_id, 'UNASSIGNED', 64)
  }
}];
