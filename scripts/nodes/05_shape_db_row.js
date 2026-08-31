/**
 * NODE 5 — SHAPE_DbRow
 * Mode: Run Once for All Items
 *
 * Emits an object whose keys map 1:1 onto the columns of field_audit_us_logs, so
 * the Postgres node can use "Map Automatically". Keeping the projection in a code
 * node (rather than 30 hand-mapped fields in the node UI) means the schema is
 * reviewable in git and survives workflow re-import.
 *
 * jsonb columns are passed as JSON strings, which the Postgres driver casts
 * cleanly and which avoids ambiguity over object serialisation.
 */

const d = $input.first().json;

return [{
  json: {
    audit_id: d.audit_id,
    idempotency_key: d.idempotency_key,
    site_id: d.site_id,
    asset_tag: d.asset_tag || null,
    inspector_id: d.inspector_id,
    jurisdiction: d.jurisdiction,
    ahj_label: d.code_basis ? d.code_basis.ahj_label : null,
    occupancy_type: d.occupancy_type,
    code_basis: JSON.stringify(d.code_basis || {}),
    equipment_type: d.equipment_type,
    equipment_subtype: d.equipment_subtype,
    status: d.status,
    critical: d.critical === true,
    confidence: d.confidence,
    image_quality: d.image_quality,
    risk_score: d.risk_score,
    deficiency_count: d.deficiency_count,
    critical_count: d.critical_count,
    major_count: d.major_count,
    minor_count: d.minor_count,
    deficiencies: JSON.stringify(d.deficiencies || []),
    violations: JSON.stringify(d.violations || []),
    unverifiable_items: JSON.stringify(d.unverifiable_items || []),
    observations: d.observations,
    impairment_suspected: d.impairment_suspected === true,
    impairment_basis: d.impairment_basis,
    reinspect_required: d.reinspect_required === true,
    reinspect_reasons: JSON.stringify(d.reinspect_reasons || []),
    image_url: d.image_url,
    model_used: d.model_used,
    prompt_tokens: d.prompt_tokens,
    completion_tokens: d.completion_tokens,
    latency_ms: d.latency_ms,
    advisory_only: d.advisory_only === true,
    signoff_status: d.signoff_status,
    sla_hours: d.sla_hours,
    remediation_due_at: d.remediation_due_at,
    audit_timestamp: d.audit_timestamp
  }
}];
