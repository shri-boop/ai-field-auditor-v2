/**
 * NODE 7 — SHAPE_Response
 * Mode: Run Once for All Items
 *
 * Returns a curated API surface to the caller. BUILD_Report carries several
 * kilobytes of Slack/Telegram/email bodies that no HTTP client needs, so the
 * response contract is defined explicitly here rather than dumping $json.
 *
 * Backward compatibility: every field the existing FIREHAWK dashboard reads
 * (status, confidence, equipment_type, audit_timestamp, observations,
 * violations) is preserved with the same names and types, so the UI works
 * against this workflow with no changes. Everything else is additive.
 */

const a = $input.first().json;
const cb = a.code_basis || {};

return [{
  json: {
    // ---- fields the existing dashboard already consumes ----
    status: a.status,
    confidence: a.confidence,
    equipment_type: a.equipment_type,
    observations: a.observations,
    violations: a.violations || [],
    site_id: a.site_id,
    audit_timestamp: a.audit_timestamp,

    // ---- identity / traceability ----
    audit_id: a.audit_id,
    idempotency_key: a.idempotency_key,
    persisted: a.persisted === true,

    // ---- richer US findings ----
    equipment_subtype: a.equipment_subtype,
    critical: a.critical === true,
    risk_score: a.risk_score,
    severity_counts: {
      critical: a.critical_count,
      major: a.major_count,
      minor: a.minor_count
    },
    deficiencies: a.deficiencies || [],
    unverifiable_items: a.unverifiable_items || [],
    image_quality: a.image_quality,
    reinspect_required: a.reinspect_required === true,
    reinspect_reasons: a.reinspect_reasons || [],

    // ---- impairment ----
    impairment_suspected: a.impairment_suspected === true,
    impairment_basis: a.impairment_basis,
    impairment_notice: a.impairment_notice,

    // ---- remediation ----
    sla_hours: a.sla_hours,
    remediation_due_at: a.remediation_due_at,
    local_timestamp: a.local_timestamp,
    local_remediation_due: a.local_remediation_due,
    action_text: a.action_text,

    // ---- code basis actually applied (display this in the UI) ----
    code_basis: {
      jurisdiction_requested: cb.jurisdiction_requested,
      jurisdiction_resolved: cb.jurisdiction_resolved,
      jurisdiction_label: cb.jurisdiction_label,
      exact_match: cb.exact_match,
      fire_code: cb.fire_code,
      fire_code_edition: cb.fire_code_edition,
      life_safety_code: cb.life_safety_code,
      ahj_label: cb.ahj_label,
      osha_overlay: cb.osha_overlay,
      state_overlays: cb.state_overlays || [],
      timezone: cb.timezone,
      requires_ahj_confirmation: cb.requires_ahj_confirmation,
      code_basis_confident: cb.code_basis_confident,
      verified_on: cb.verified_on
    },
    unverified_standard_editions: a.unverified_standard_editions || [],

    // ---- governance: never let a caller mistake this for a certification ----
    advisory_only: true,
    certification_eligible: false,
    requires_licensed_inspector_signoff: true,
    signoff_status: a.signoff_status || 'PENDING',
    scope_note: a.scope_note,

    // ---- observability ----
    model_used: a.model_used,
    latency_ms: a.latency_ms,
    prompt_tokens: a.prompt_tokens,
    completion_tokens: a.completion_tokens
  }
}];
