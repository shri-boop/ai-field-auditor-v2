/**
 * HISTORY NODE 2 — SHAPE_Results
 * Mode: Run Once for All Items
 *
 * Normalises rows from either region's table into the SAME object shape the
 * audit workflows return from SHAPE_Response.
 *
 * That is the whole point of this node. If a retrieved record matches the live
 * response contract, the dashboard can render history through the identical
 * report component — one renderer, one print stylesheet, one place for a bug to
 * live. Any divergence here becomes a second rendering path in the frontend.
 *
 * Receives items from QUERY_US or QUERY_IND, which have different column sets,
 * so region is read back from VALIDATE_Query rather than inferred from columns.
 */

const meta = $('VALIDATE_Query').first().json;
const region = meta.region;

const items = $input.all();

/**
 * A row is only real if it has a timestamp. Both query nodes run with
 * alwaysOutputData so this node still executes on a miss — otherwise a search
 * with no matches would abort the workflow and the caller would get an empty
 * body instead of an honest "0 results".
 */
function isRow(json) {
  return json && (json.audit_timestamp !== undefined && json.audit_timestamp !== null);
}

/** The India workflow stores violations as a stringified JSON array in a text column. */
function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [trimmed];
    } catch (e) {
      // Not JSON — treat the whole string as a single finding rather than
      // discarding it. Losing a violation line is not an acceptable failure.
      return [trimmed];
    }
  }
  return [];
}

/** jsonb columns arrive as objects, but tolerate a text column holding JSON. */
function toObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (e) { /* fall through */ }
  }
  return null;
}

function iso(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function shapeUs(r) {
  return {
    // ---- shared contract ----
    audit_id: r.audit_id,
    site_id: r.site_id,
    status: r.status,
    confidence: r.confidence,
    equipment_type: r.equipment_type,
    equipment_subtype: r.equipment_subtype,
    observations: r.observations,
    violations: toArray(r.violations),
    audit_timestamp: iso(r.audit_timestamp),

    // ---- findings ----
    critical: r.critical === true,
    risk_score: r.risk_score,
    severity_counts: {
      critical: r.critical_count,
      major: r.major_count,
      minor: r.minor_count
    },
    deficiencies: toArray(r.deficiencies),
    unverifiable_items: toArray(r.unverifiable_items),
    image_quality: r.image_quality,
    reinspect_required: r.reinspect_required === true,
    reinspect_reasons: toArray(r.reinspect_reasons),

    // ---- impairment ----
    // impairment_notice is NOT stored — BUILD_REPORT renders it at audit time
    // from the checklist, and only the basis is persisted. A retrieved record
    // therefore shows that an impairment was suspected and why, without the
    // full NFPA 25 Ch. 15 action checklist.
    impairment_suspected: r.impairment_suspected === true,
    impairment_basis: r.impairment_basis,

    // ---- remediation / governance ----
    sla_hours: r.sla_hours,
    remediation_due_at: iso(r.remediation_due_at),
    remediation_status: r.remediation_status,
    advisory_only: r.advisory_only !== false,
    signoff_status: r.signoff_status,
    signoff_by: r.signoff_by,
    signoff_at: iso(r.signoff_at),

    // ---- code basis actually applied at audit time ----
    // Stored as a snapshot, so a 2026 record stays interpretable after the
    // registry moves to a newer code edition.
    code_basis: toObject(r.code_basis) || {},

    // ---- context / evidence ----
    jurisdiction: r.jurisdiction,
    occupancy_type: r.occupancy_type,
    inspector_id: r.inspector_id,
    asset_tag: r.asset_tag,
    image_url: r.image_url,

    // ---- observability ----
    model_used: r.model_used,
    latency_ms: r.latency_ms,

    // Retrieved from the log, not produced by a live run. The UI uses this to
    // label the report as an archived record.
    retrieved: true,
    region: 'US'
  };
}

function shapeInd(r) {
  return {
    // Everything the US shape carries beyond the India table's columns is absent
    // by design, not missing by accident — those fields are emitted empty so the
    // renderer's optional-field handling does the work and no separate India code
    // path is needed.
    //
    // There is no minted audit_id, but there IS an integer primary key, so an
    // India record can still be addressed exactly. record_id is its analogue.
    audit_id: null,
    record_id: r.id === undefined ? null : r.id,
    site_id: r.site_id,

    // Added by migration 003. NULL on every row written before it, which is why
    // they stay optional rather than becoming required fields in the UI.
    asset_tag: r.asset_tag === undefined ? null : r.asset_tag,
    inspector_id: r.inspector_id === undefined ? null : r.inspector_id,
    image_url: r.image_url === undefined ? null : r.image_url,
    status: r.status,
    confidence: r.confidence,
    equipment_type: r.equipment_type,
    observations: r.observations,
    violations: toArray(r.violations),

    // audit_timestamp is a TEXT column on this table. It holds ISO-8601 from
    // toISOString(), so iso() normalises it, but fall back to created_at — the
    // real timestamptz, and what the range filter and ordering actually use —
    // rather than surfacing null if anything ever wrote a different format.
    audit_timestamp: iso(r.audit_timestamp) || iso(r.created_at),
    created_at: iso(r.created_at),

    deficiencies: [],
    unverifiable_items: [],
    code_basis: {},
    advisory_only: true,

    retrieved: true,
    region: 'IND'
  };
}

const rows = [];
for (let i = 0; i < items.length; i++) {
  const json = items[i].json;
  if (!isRow(json)) continue;
  rows.push(region === 'US' ? shapeUs(json) : shapeInd(json));
}

const limit = meta.applied ? meta.applied.limit : rows.length;

return [{
  json: {
    query_ok: true,
    region: region,
    count: rows.length,
    // A full page is indistinguishable from "exactly this many rows" without a
    // second COUNT(*), which is not worth the round trip. Signal it instead so
    // the UI can offer "next page" honestly rather than claiming a total.
    page_full: rows.length === limit,
    applied: meta.applied,
    rows: rows,
    retrieved_at: new Date().toISOString()
  }
}];
