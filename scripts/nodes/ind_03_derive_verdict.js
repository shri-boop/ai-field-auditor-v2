/**
 * INDIA NODE 3 — PARSE_Response
 * Mode: Run Once for All Items
 *
 * Parses the model output and DERIVES the verdict. The node keeps its original
 * name so nothing downstream breaks, but its job has changed: it no longer
 * transcribes what the model said, it decides.
 *
 * ---------------------------------------------------------------------------
 * WHY THE STATUS IS COMPUTED HERE AND NOT READ FROM THE MODEL
 * ---------------------------------------------------------------------------
 * Previously this node did `{...parsed}` and the model's own `status` string went
 * straight into the database and into IF_NonCompliant. Two failures followed from
 * that:
 *
 *   1. A model revision emitting "PASS", "OK" or "PARTIAL" instead of
 *      "COMPLIANT" would not match "NON-COMPLIANT" in the IF node, so every
 *      audit — including one showing a discharged extinguisher — would have taken
 *      the compliant branch and raised no alert. Silently.
 *   2. The verdict that triggers escalation was unreviewable. Nobody could say
 *      why a given photograph was judged compliant, because the reason lived in
 *      the model's head.
 *
 * Now the model reports observations and severities; the status is arithmetic on
 * those. It is inspectable, stable across model versions, and testable offline —
 * which is what scripts/test_india.mjs does.
 *
 * PRECEDENCE IS DELIBERATE, and copied from the US workflow:
 *   critical  ->  weak evidence  ->  ordinary deficiency  ->  clean
 * A confidence gate must never be able to suppress a life-safety finding. The
 * cost asymmetry between a false alarm and a missed blocked exit is not close.
 */

const source = $('PARSE_Input').first().json;
const payloadMeta = $('BUILD_Vision_Payload').first().json;
const audit_timestamp = new Date().toISOString();

/** Shared shape so every exit from this node returns the same fields. */
function base(extra) {
  const out = {
    site_id: payloadMeta.site_id || source.site_id || 'unknown',
    asset_tag: source.asset_tag || null,
    inspector_id: source.inspector_id || 'UNASSIGNED',
    image_url: source.image_url || null,
    audit_timestamp: audit_timestamp
  };
  for (const k in extra) out[k] = extra[k];
  return out;
}

// ------------------------------------------------------------------ parsing
const raw = $input.first().json.choices?.[0]?.message?.content || '';

const cleaned = String(raw)
  .replace(/```json\s*/gi, '')
  .replace(/```\s*/g, '')
  .trim();

let parsed = null;
let parseError = null;
try {
  parsed = JSON.parse(cleaned);
} catch (e) {
  parseError = e.message;
}

// Arrays are excluded explicitly. `typeof [] === 'object'` and `[]` is truthy, so
// a bare `[]` or `[{...}]` from the model would otherwise pass this gate, produce
// no deficiencies, and be recorded as a COMPLIANT audit — a false pass arriving
// through a type check that looked correct.
if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
  // ERROR is a real status, not a silent pass. alert_required is true so ops
  // hears about a broken automated pass rather than it looking like a clean bill.
  return [{
    json: base({
      status: 'ERROR',
      alert_required: true,
      critical: false,
      confidence: 'LOW',
      image_quality: 'UNKNOWN',
      equipment_type: 'Unknown',
      observations: 'Failed to parse the model response: ' + (parseError || 'empty response'),
      deficiencies: [],
      violations: ['AI_PARSE_ERROR'],
      unverifiable_items: ['Entire checklist — the automated pass did not produce a usable result.'],
      reinspect_required: true,
      reinspect_reasons: ['Automated analysis failed; resubmit the photograph or inspect manually.'],
      risk_score: 0,
      critical_count: 0,
      major_count: 0,
      minor_count: 0,
      deficiency_count: 0,
      raw_model_excerpt: cleaned.slice(0, 600)
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
  return [value];
}

function text(value, max) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max || 600) : null;
}

const confidence = enumOf(parsed.confidence, ['HIGH', 'MEDIUM', 'LOW'], 'MEDIUM');
const image_quality = enumOf(parsed.image_quality, ['GOOD', 'FAIR', 'POOR'], 'FAIR');
const equipment_type = text(parsed.equipment_type, 120) || 'Unknown';
const observations = text(parsed.observations, 4000) || 'No observations returned.';

const KNOWN_CODES = Array.isArray(payloadMeta.checklist_codes) ? payloadMeta.checklist_codes : [];
const CODE_SEVERITY = payloadMeta.checklist_severity || {};

const SEVERITY_RANK = { CRITICAL: 0, MAJOR: 1, MINOR: 2 };

/**
 * Severity bias is UPWARD, in both directions it could go wrong.
 *
 * Two inputs disagree about how bad a finding is: the checklist severity we
 * authored for that code, and whatever the model put in the deficiency. The rule
 * is to take the MORE SEVERE of the two, never to let one override the other.
 *
 *   - The checklist is a floor. The model does not get to downgrade a defect the
 *     code basis treats as critical, so a blocked extinguisher reported as MINOR
 *     is still CRITICAL.
 *   - The model can still escalate. If it tags ISI_MARK_MISSING — a marking
 *     defect, MINOR by policy — as CRITICAL, it is probably describing something
 *     worse than the code it reached for. Letting the checklist win outright there
 *     would suppress a real escalation, which is the expensive direction of the
 *     error.
 *
 * An unrecognised severity string normalises to MAJOR, never MINOR: if the model
 * invents a value we do not understand, the safe assumption is that the finding
 * matters.
 */
function severityOf(deficiency) {
  const reported = enumOf(deficiency && deficiency.severity, ['CRITICAL', 'MAJOR', 'MINOR'], 'MAJOR');
  const declared = CODE_SEVERITY[String(deficiency && deficiency.code).trim()];
  if (!declared) return reported;
  return SEVERITY_RANK[declared] <= SEVERITY_RANK[reported] ? declared : reported;
}

const deficiencies = toArray(parsed.deficiencies)
  .filter(function (d) { return d && typeof d === 'object'; })
  .map(function (d) {
    const code = text(d.code, 64);
    return {
      // Flagged rather than dropped: a finding whose code we do not recognise is
      // still a finding, and discarding it would lose a real defect.
      code: code || 'UNSPECIFIED',
      code_known: code ? KNOWN_CODES.indexOf(code) !== -1 : false,
      severity: severityOf(d),
      finding: text(d.finding, 600) || 'Unspecified finding.',
      observed: text(d.observed, 600),
      requirement: text(d.requirement, 600),
      code_reference: text(d.code_reference, 240),
      remediation: text(d.remediation, 600)
    };
  });

const unverifiable_items = toArray(parsed.unverifiable_items)
  .map(function (u) { return text(u, 400); })
  .filter(Boolean);

// -------------------------------------------------------------- arithmetic
function countAt(severity) {
  return deficiencies.filter(function (d) { return d.severity === severity; }).length;
}

const critical_count = countAt('CRITICAL');
const major_count = countAt('MAJOR');
const minor_count = countAt('MINOR');
const deficiency_count = deficiencies.length;

const SEVERITY_WEIGHT = { CRITICAL: 100, MAJOR: 25, MINOR: 5 };
const risk_score = Math.min(
  100,
  critical_count * SEVERITY_WEIGHT.CRITICAL +
  major_count * SEVERITY_WEIGHT.MAJOR +
  minor_count * SEVERITY_WEIGHT.MINOR
);

const has_critical = critical_count > 0;
const evidence_is_weak = confidence === 'LOW' || image_quality === 'POOR';
const needs_reinspect = parsed.reinspect_required === true || evidence_is_weak;

const reinspect_reasons = [];
if (parsed.reinspect_required === true) {
  reinspect_reasons.push('The automated pass flagged this photograph as inadequate to judge.');
}
if (confidence === 'LOW') {
  reinspect_reasons.push('Model confidence is LOW.');
}
if (image_quality === 'POOR') {
  reinspect_reasons.push('Image quality is POOR — retake with better framing and lighting.');
}

// ----------------------------------------------------- deterministic status
let status;
if (has_critical) {
  // Fail-safe: a critical finding escalates even at LOW confidence or POOR
  // image quality. A confidence gate must not be able to hide one.
  status = 'NON-COMPLIANT';
} else if (needs_reinspect) {
  status = 'REINSPECT';
} else if (major_count > 0) {
  status = 'NON-COMPLIANT';
} else if (minor_count > 0) {
  // Real inspection practice distinguishes "deficiencies noted" from "failed".
  // Collapsing them trains operators to ignore alerts.
  status = 'CONDITIONAL';
} else {
  status = 'COMPLIANT';
}

/**
 * IF_NonCompliant switches on this boolean rather than comparing status strings.
 * Keeping the branch condition in code means adding a status can never silently
 * create an unrouted path — which is precisely how REINSPECT ended up handled in
 * the notifier but never reachable.
 */
const alert_required = status !== 'COMPLIANT';

// Flat strings, kept for the `violations` text column and for the dashboard's
// India fallback rendering. Severity is prefixed so the flat list is still
// ordered information rather than an undifferentiated blob.
const violations = deficiencies.map(function (d) {
  return '[' + d.severity + '] ' + d.finding;
});

return [{
  json: base({
    status: status,
    alert_required: alert_required,
    critical: has_critical,
    confidence: confidence,
    image_quality: image_quality,
    equipment_type: equipment_type,
    observations: observations,
    deficiencies: deficiencies,
    violations: violations,
    unverifiable_items: unverifiable_items,
    reinspect_required: needs_reinspect,
    reinspect_reasons: reinspect_reasons,
    risk_score: risk_score,
    critical_count: critical_count,
    major_count: major_count,
    minor_count: minor_count,
    deficiency_count: deficiency_count,
    // Surfaced so a reviewer can see the model returned a code outside the
    // checklist it was given, rather than that being invisible.
    unknown_codes: deficiencies.filter(function (d) { return !d.code_known; })
      .map(function (d) { return d.code; })
  })
}];
