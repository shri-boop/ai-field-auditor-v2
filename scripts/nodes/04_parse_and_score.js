/**
 * NODE 4 — PARSE_And_Score
 * Mode: Run Once for All Items
 *
 * The v2 (India) workflow took the model's own `status` field at face value.
 * That is the wrong trust boundary for a compliance system: the verdict that
 * drives escalation must be derived from the evidence by deterministic code, so
 * that it is reviewable, testable and stable across model versions.
 *
 * This node therefore:
 *   1. Extracts JSON defensively (fences, preamble, trailing prose, trailing commas).
 *   2. Coerces and normalises the payload against the expected schema.
 *   3. DERIVES status, criticality, risk score and routing itself.
 *   4. Applies a fail-safe bias: a CRITICAL finding escalates even when the model
 *      reports LOW confidence. We would rather over-escalate a life-safety issue
 *      than suppress it behind a confidence gate.
 *   5. Records what the photograph could not settle, and refuses to present the
 *      result as a certified inspection.
 */

const raw = $input.first().json;
const meta = $('BUILD_Vision_Payload').first().json;

// ---------------------------------------------------------------- extraction
function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();

  // Strip fenced code blocks anywhere in the response.
  s = s.replace(/```(?:json)?/gi, '').trim();

  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  const candidate = s.slice(start, end + 1);

  try {
    return JSON.parse(candidate);
  } catch (e) { /* fall through to repair */ }

  try {
    // Most common LLM JSON defect: trailing commas before } or ].
    return JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1'));
  } catch (e) { /* give up */ }

  return null;
}

const choice = raw && raw.choices && raw.choices[0] ? raw.choices[0] : null;
const content = choice && choice.message ? choice.message.content : '';
const parsed = extractJson(content);

const model_used = (raw && raw.model) || meta.primary_model || 'unknown';
const usage = (raw && raw.usage) || {};
const finish_reason = choice ? choice.finish_reason : null;

const audit_timestamp = new Date().toISOString();
const latency_ms = meta.dispatched_at
  ? Math.max(0, new Date(audit_timestamp).getTime() - new Date(meta.dispatched_at).getTime())
  : null;

// Base envelope carried on every outcome, including hard failures.
const base = {
  audit_id: meta.audit_id,
  idempotency_key: meta.idempotency_key,
  site_id: meta.site_id,
  asset_tag: meta.asset_tag,
  inspector_id: meta.inspector_id,
  occupancy_type: meta.occupancy_type,
  image_url: meta.image_url,
  jurisdiction: meta.code_basis.jurisdiction_resolved,
  code_basis: meta.code_basis,
  unverified_standard_editions: meta.unverified_standard_editions,
  model_used: model_used,
  prompt_tokens: usage.prompt_tokens || null,
  completion_tokens: usage.completion_tokens || null,
  latency_ms: latency_ms,
  audit_timestamp: audit_timestamp,
  // Non-negotiable framing: this is a screening aid, never a certified inspection.
  advisory_only: true,
  certification_eligible: false,
  requires_licensed_inspector_signoff: true,
  signoff_status: 'PENDING'
};

// ------------------------------------------------------- hard failure path
if (!parsed) {
  const detail = finish_reason === 'length'
    ? 'The model response was truncated before the JSON object closed (finish_reason=length).'
    : 'No parsable JSON object was found in the model response.';

  return [{
    json: Object.assign({}, base, {
      status: 'ERROR',
      route_index: 4,
      critical: false,
      confidence: 'LOW',
      image_quality: 'UNKNOWN',
      equipment_type: 'UNDETERMINED',
      equipment_subtype: null,
      observations: 'Automated audit could not be completed. ' + detail,
      deficiencies: [],
      violations: ['SYSTEM_ERROR: ' + detail],
      unverifiable_items: ['Entire checklist — the automated pass did not produce a usable result.'],
      reinspect_required: true,
      reinspect_reasons: ['Automated analysis failed; resubmit the photograph or inspect manually.'],
      impairment_suspected: false,
      impairment_basis: null,
      risk_score: 0,
      critical_count: 0,
      major_count: 0,
      minor_count: 0,
      deficiency_count: 0,
      remediation_due_at: null,
      raw_model_excerpt: String(content || '').slice(0, 600)
    })
  }];
}

// ------------------------------------------------------------ normalisation
function enumOf(value, allowed, fallback) {
  const v = String(value === undefined || value === null ? '' : value).trim().toUpperCase();
  return allowed.indexOf(v) !== -1 ? v : fallback;
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  if (typeof value === 'string') {
    try {
      const j = JSON.parse(value);
      return Array.isArray(j) ? j : [value];
    } catch (e) {
      return [value];
    }
  }
  return [value];
}

// Bias unknown severities UPWARD, never downward.
function normaliseSeverity(value) {
  const v = String(value || '').trim().toUpperCase();
  if (['CRITICAL', 'IMMEDIATE', 'LIFE-SAFETY', 'LIFE SAFETY', 'SEVERE'].indexOf(v) !== -1) return 'CRITICAL';
  if (['MAJOR', 'HIGH', 'SERIOUS', 'SIGNIFICANT'].indexOf(v) !== -1) return 'MAJOR';
  if (['MINOR', 'LOW', 'MODERATE', 'ADMINISTRATIVE', 'DOCUMENTATION'].indexOf(v) !== -1) return 'MINOR';
  return 'MAJOR';
}

const equipment_type = String(parsed.equipment_type || 'UNDETERMINED').trim().toUpperCase().replace(/[\s-]+/g, '_');
const equipment_subtype = parsed.equipment_subtype ? String(parsed.equipment_subtype).slice(0, 200) : null;
const image_quality = enumOf(parsed.image_quality, ['GOOD', 'FAIR', 'POOR'], 'FAIR');
const confidence = enumOf(parsed.confidence, ['HIGH', 'MEDIUM', 'LOW'], 'LOW');

// Normalise, de-duplicate by checklist id, and cap to keep notifications sane.
const seen = {};
const deficiencies = toArray(parsed.deficiencies)
  .filter(function (d) { return d && typeof d === 'object'; })
  .map(function (d) {
    return {
      code: String(d.code || 'UNSPECIFIED').trim().toUpperCase().replace(/[\s-]+/g, '_').slice(0, 64),
      severity: normaliseSeverity(d.severity),
      finding: String(d.finding || '').trim().slice(0, 500),
      observed: String(d.observed || '').trim().slice(0, 500),
      requirement: String(d.requirement || '').trim().slice(0, 500),
      code_reference: String(d.code_reference || '').trim().slice(0, 240),
      remediation: String(d.remediation || '').trim().slice(0, 500),
      verification_needed: d.verification_needed === true
    };
  })
  .filter(function (d) {
    if (!d.finding) return false;
    if (seen[d.code]) return false;
    seen[d.code] = true;
    return true;
  })
  .slice(0, 25);

const unverifiable_items = toArray(parsed.unverifiable_items)
  .map(function (u) { return String(u).trim().slice(0, 300); })
  .filter(Boolean)
  .slice(0, 25);

const reinspect_reasons = toArray(parsed.reinspect_reasons)
  .map(function (r) { return String(r).trim().slice(0, 300); })
  .filter(Boolean)
  .slice(0, 15);

// ------------------------------------------------------------------ scoring
const critical_count = deficiencies.filter(function (d) { return d.severity === 'CRITICAL'; }).length;
const major_count = deficiencies.filter(function (d) { return d.severity === 'MAJOR'; }).length;
const minor_count = deficiencies.filter(function (d) { return d.severity === 'MINOR'; }).length;

const SEVERITY_WEIGHT = { CRITICAL: 100, MAJOR: 25, MINOR: 5 };
const risk_score = Math.min(
  100,
  critical_count * SEVERITY_WEIGHT.CRITICAL +
  major_count * SEVERITY_WEIGHT.MAJOR +
  minor_count * SEVERITY_WEIGHT.MINOR
);

const impairment_suspected = parsed.impairment_suspected === true;
const impairment_basis = parsed.impairment_basis ? String(parsed.impairment_basis).slice(0, 500) : null;

const model_wants_reinspect = parsed.reinspect_required === true;
const evidence_is_weak = confidence === 'LOW' || image_quality === 'POOR';
const needs_reinspect = model_wants_reinspect || evidence_is_weak;

const has_critical = critical_count > 0 || impairment_suspected;

// ------------------------------------------------- deterministic status
// Precedence is deliberate:
//   critical first (fail-safe: never let a confidence gate hide a life-safety
//   finding), then weak evidence, then ordinary deficiencies, then clean.
let status;
let route_index;

if (has_critical) {
  status = 'NON-COMPLIANT';
  route_index = 0;                       // CRITICAL escalation
} else if (needs_reinspect) {
  status = 'REINSPECT';
  route_index = 2;
} else if (major_count > 0) {
  status = 'NON-COMPLIANT';
  route_index = 1;
} else if (minor_count > 0) {
  status = 'CONDITIONAL';                // deficiencies noted, not an outright fail
  route_index = 1;
} else {
  status = 'COMPLIANT';
  route_index = 3;
}

// Remediation SLA driven by the worst severity present.
const SLA_HOURS = { CRITICAL: 0, MAJOR: 72, MINOR: 720 };
let sla_hours = null;
if (critical_count > 0 || impairment_suspected) sla_hours = SLA_HOURS.CRITICAL;
else if (major_count > 0) sla_hours = SLA_HOURS.MAJOR;
else if (minor_count > 0) sla_hours = SLA_HOURS.MINOR;

const remediation_due_at = sla_hours === null
  ? null
  : new Date(new Date(audit_timestamp).getTime() + sla_hours * 3600 * 1000).toISOString();

// Backward-compatible flat string list, so the existing FIREHAWK UI (which
// renders `violations` as strings) keeps working against this workflow unchanged.
const violations = deficiencies.map(function (d) {
  return '[' + d.severity + '] ' + d.finding + (d.code_reference ? ' (' + d.code_reference + ')' : '');
});

// A still photograph can never certify compliance. Say so explicitly.
const scope_note = status === 'COMPLIANT'
  ? 'No deficiencies were visible in this photograph. This is not a certification of compliance: ' +
    unverifiable_items.length + ' check(s) cannot be settled from a still image and require a physical inspection.'
  : 'Photo-based screening result. A licensed or certified inspector must verify findings on site before ' +
    'any enforcement, certification or record-of-inspection use.';

return [{
  json: Object.assign({}, base, {
    status: status,
    route_index: route_index,
    critical: has_critical,
    equipment_type: equipment_type,
    equipment_subtype: equipment_subtype,
    image_quality: image_quality,
    confidence: confidence,
    confidence_gated: has_critical && evidence_is_weak,
    observations: String(parsed.observations || '').trim().slice(0, 2000),
    deficiencies: deficiencies,
    violations: violations,
    unverifiable_items: unverifiable_items,
    reinspect_required: needs_reinspect,
    reinspect_reasons: reinspect_reasons,
    impairment_suspected: impairment_suspected,
    impairment_basis: impairment_basis,
    risk_score: risk_score,
    critical_count: critical_count,
    major_count: major_count,
    minor_count: minor_count,
    deficiency_count: deficiencies.length,
    sla_hours: sla_hours,
    remediation_due_at: remediation_due_at,
    scope_note: scope_note
  })
}];
