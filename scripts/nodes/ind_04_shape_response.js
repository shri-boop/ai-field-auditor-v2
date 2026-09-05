/**
 * INDIA NODE 4 — SHAPE_Response   (NEW NODE)
 * Mode: Run Once for All Items
 * Position in chain: LOG_Audit -> SHAPE_Response -> IF_NonCompliant
 *
 * Two jobs, both of which used to have no home in this workflow.
 *
 * ---------------------------------------------------------------------------
 * 1. A DATABASE OUTAGE MUST NOT SWALLOW A FINDING  (roadmap 7.3)
 * ---------------------------------------------------------------------------
 * LOG_Audit previously had no onError, so a Postgres hiccup aborted the whole
 * execution: no Slack message, no Telegram message, and an empty HTTP body. A
 * blocked fire exit would have gone unreported because a database was briefly
 * unavailable — the finding was already computed and sitting in memory, and it
 * was thrown away.
 *
 * LOG_Audit now runs with onError: continueRegularOutput, which means its output
 * on failure is an error object rather than the inserted row. This node inspects
 * that, sets `persisted`, and lets the audit continue. The alert still fires, the
 * caller still gets the verdict, and both are told the record was not written.
 *
 * `persisted` is a degraded state, never a silent one. The dashboard already
 * renders it (it was built for the US workflow) and BUILD_Alert says so in the
 * message body, because an alert that is the ONLY copy of a finding needs to be
 * kept rather than glanced at.
 *
 * ---------------------------------------------------------------------------
 * 2. AN EXPLICIT RESPONSE CONTRACT
 * ---------------------------------------------------------------------------
 * Respond_to_Webhook1 returns `{{ $json }}` — whatever the previous node
 * happened to hold. Before this node that was LOG_Audit's output, i.e. a
 * database row echo, and the response shape was an accident of which node ran
 * last. Now it is declared here, in one place, like the US workflow's
 * SHAPE_Response.
 *
 * Backward compatibility is deliberate: every field the dashboard already reads
 * from India (status, confidence, equipment_type, observations, violations,
 * site_id, asset_tag, inspector_id, image_url, audit_timestamp) keeps its name
 * and type. Everything else is additive, and the additions are fields the shared
 * report renderer ALREADY understands because the US workflow emits them — so
 * severity tiers, risk score and unverifiable items appear on an India report
 * with no frontend change at all.
 */

const dbResult = $input.first().json || {};
const a = $('PARSE_Response').first().json;

// n8n surfaces a continued error as `error` (and `$error` in some versions).
// Same test as the US workflow's BUILD_Report, so the two regions cannot drift
// on what "persisted" means.
const persisted = !(dbResult.error || dbResult.$error);

/**
 * The India table's primary key is a serial integer, and the insert echoes the
 * row, so a successful write can hand back the exact address of the record. That
 * is what the Records browser searches on (`record_id`).
 *
 * It is kept alongside `audit_id` rather than replaced by it. They answer
 * different questions: `record_id` is where the row physically is and only exists
 * if the write succeeded, whereas `audit_id` identifies the audit itself and
 * exists even when `persisted` is false. A caller that got `persisted: false`
 * still has an `audit_id` to quote in a support request; it has no `record_id`,
 * honestly, because there is no record to address.
 */
const record_id = persisted && (typeof dbResult.id === 'number' || typeof dbResult.id === 'string')
  ? dbResult.id
  : null;

return [{
  json: {
    // ---- fields the dashboard already consumes (names and types unchanged) ----
    status: a.status,
    confidence: a.confidence,
    equipment_type: a.equipment_type,
    observations: a.observations,
    violations: a.violations || [],
    site_id: a.site_id,
    asset_tag: a.asset_tag || null,
    inspector_id: a.inspector_id || null,
    image_url: a.image_url || null,
    audit_timestamp: a.audit_timestamp,

    // ---- identity / traceability ----
    // Minted in VALIDATE_Input (migration 006). Survives a failed DB write, and is
    // what field_audit_signoffs will reference — SIGNOFF_DESIGN §14.1.
    audit_id: a.audit_id || null,
    record_id: record_id,
    persisted: persisted,

    // ---- routing ----
    // IF_NonCompliant switches on this boolean instead of comparing status
    // strings. Keeping the branch condition in code means adding a status can
    // never silently create an unrouted path, which is exactly how REINSPECT
    // came to be handled in the notifier but unreachable from the IF node.
    alert_required: a.alert_required === true,

    // ---- severity model (roadmap 7.2) ----
    critical: a.critical === true,
    risk_score: a.risk_score,
    severity_counts: {
      critical: a.critical_count,
      major: a.major_count,
      minor: a.minor_count
    },
    deficiency_count: a.deficiency_count,
    deficiencies: a.deficiencies || [],
    unverifiable_items: a.unverifiable_items || [],
    image_quality: a.image_quality,
    reinspect_required: a.reinspect_required === true,
    reinspect_reasons: a.reinspect_reasons || [],
    // Surfaced rather than hidden: a code outside the checklist the model was
    // given means the prompt and the parser have drifted, and a reviewer should
    // be able to see that from the response.
    unknown_codes: a.unknown_codes || [],

    // ---- code basis actually applied ----
    // Hardcoded in the prompt for India rather than resolved from a registry, so
    // this is a static statement of what BUILD_Vision_Payload asserted, not a
    // lookup. Shaped like the US object so the renderer needs no India branch.
    code_basis: {
      jurisdiction_resolved: 'IN-MH',
      jurisdiction_label: 'Maharashtra, India',
      exact_match: true,
      // `fire_code` is the string the report renders as its whole code-basis
      // line, and the US registry entries are correspondingly full sentences
      // rather than bare code names. It is worded to match
      // REGIONS.IND.codeBasisFallback in lib/regions.ts EXACTLY, so a record that
      // carries a basis and one that falls back read identically — otherwise
      // shipping this would have made a live India audit display LESS statute
      // than before, since the fallback spells the whole regime out.
      fire_code: 'NBC 2016 Part 4, enforceable under the Maharashtra Fire Prevention and Life '
        + 'Safety Measures Act 2006 and Rules 2009 \u00b7 AHJ: Chief Fire Officer, MCGM',
      fire_code_edition: '2016, Part 4 (Fire and Life Safety)',
      life_safety_code: 'Maharashtra Fire Prevention and Life Safety Measures Act 2006; Rules 2009',
      ahj_label: 'Chief Fire Officer, Municipal Corporation (MCGM for Brihanmumbai)',
      state_overlays: ['IS 2190', 'IS 15683', 'BIS / ISI certification'],
      code_basis_confident: true
    },

    // ---- governance ----
    // The dashboard was supplying advisory_only: true for India on the frontend's
    // own authority. Now the workflow states it, so the claim travels with the
    // record instead of depending on which client rendered it. This is a
    // statement of scope, not sign-off: there are still no signoff columns on
    // field_audit_logs and no write path (roadmap 7.8/7.9, Form B).
    advisory_only: true,
    certification_eligible: false,
    requires_licensed_inspector_signoff: true,
    signoff_status: 'PENDING',
    scope_note: 'Photograph-based screening under NBC 2016 Part 4, read with the '
      + 'Maharashtra Fire Prevention and Life Safety Measures Act 2006 and Rules 2009. '
      + 'Not a Form B certification and not a substitute for inspection by a Licensed Agency.',

    region: 'IND'
  }
}];
