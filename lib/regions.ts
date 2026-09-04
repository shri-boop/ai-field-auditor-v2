/**
 * Region registry — the single source of truth for which audit backend a
 * request goes to, and which extra inputs that backend accepts.
 *
 * Shared by:
 *   - app/page.tsx            (server) decides which regions to render
 *   - app/api/audit/route.ts  (server) ENFORCES which regions may be called
 *   - components/audit-console.tsx (client) renders the inputs
 *
 * Nothing secret lives here. The n8n base URL is deliberately NOT in this
 * file — it is read from process.env.N8N_BASE_URL inside the route handler so
 * it never reaches the browser bundle.
 */

export type RegionKey = 'IND' | 'US';

/** Extra request fields a region's workflow understands. */
export type RegionField =
  | 'jurisdiction'
  | 'occupancy_type'
  | 'equipment_hint'
  | 'osha_workplace'
  | 'asset_tag'
  | 'inspector_id';

export interface RegionDef {
  key: RegionKey;
  /** Short label for the segmented control. */
  label: string;
  /** Code basis shown next to the label, e.g. "NBC 2016 · CFO Mumbai". */
  codeLabel: string;
  /** n8n webhook path (appended to N8N_BASE_URL). */
  webhookPath: string;
  /**
   * Copy used while the audit is running, and as a fallback when the response
   * carries no code_basis of its own.
   *
   * For IND this text is duplicated, deliberately and exactly, in
   * scripts/nodes/ind_04_shape_response.js as `code_basis.fire_code`. India
   * resolves no registry at run time — the basis is hardcoded in the prompt — so
   * the workflow asserts a static basis, and it has to read identically to this
   * string or a live audit would display less statute than a fallback. The
   * offline suite (scripts/test_india.mjs) asserts the two are equal, so the
   * duplication cannot drift silently.
   *
   * Records retrieved from the India table still fall back to this: nothing is
   * snapshotted per row, because there was never a resolved basis to snapshot.
   */
  codeBasisFallback: string;
  /** Shown in the "zero findings" panel when the response has no code_basis. */
  compliantCopyFallback: string;
  siteIdPlaceholder: string;
  /** Locale used to format audit_timestamp when local_timestamp is absent. */
  timestampLocale: string;
  /** Which optional inputs to render and forward. */
  fields: RegionField[];
}

export const REGIONS: Record<RegionKey, RegionDef> = {
  IND: {
    key: 'IND',
    label: 'IND',
    /**
     * Maharashtra, stated properly.
     *
     * "NBC 2016 + CFO Mumbai norms" was loose. NBC 2016 is a recommendatory
     * technical code; what makes it enforceable in Maharashtra is the Maharashtra
     * Fire Prevention and Life Safety Measures Act 2006 and its Rules 2009, and
     * the authority is the Chief Fire Officer of the Municipal Corporation —
     * MCGM for Brihanmumbai.
     *
     * An Indian buyer tests exactly this within the first minute. Getting the
     * statute right costs a string and is the difference between a generic AI
     * demo and something that reads as though it knows the regime.
     *
     * NOTE: the workflow's prompt still says "NBC 2016 and CFO Mumbai norms"
     * verbatim, hardcoded in BUILD_Vision_Payload. Correcting that is a separate
     * change requiring a re-import — see IND_FIRE_AUDIT_WORKFLOW.md §7.10.
     */
    codeLabel: 'NBC 2016 · MFPLSM · CFO Mumbai',
    webhookPath: 'audit-field-photov2',
    codeBasisFallback:
      'NBC 2016 Part 4, enforceable under the Maharashtra Fire Prevention and Life Safety ' +
      'Measures Act 2006 and Rules 2009 · AHJ: Chief Fire Officer, MCGM',
    compliantCopyFallback:
      'Nothing visible against NBC 2016 Part 4 and the Maharashtra Fire Prevention and Life ' +
      'Safety Measures Rules 2009. This is not a Form B certificate.',
    siteIdPlaceholder: 'SITE-MUM-401',
    timestampLocale: 'en-IN',
    /**
     * India has no jurisdiction registry — the workflow hardcodes NBC 2016 + CFO
     * Mumbai — but migration 003 gave field_audit_logs asset_tag, inspector_id
     * and image_url, so those two inputs now apply to both regions. Requires the
     * re-imported AI_Field_Audit_v2.json to be live; before that the values are
     * accepted and simply not persisted.
     */
    fields: ['asset_tag', 'inspector_id'],
  },
  US: {
    key: 'US',
    label: 'US',
    codeLabel: 'NFPA / IFC · OSHA overlay',
    webhookPath: 'audit-field-photo-us',
    codeBasisFallback: 'IFC 2024 / NFPA model codes',
    compliantCopyFallback:
      'No deficiencies visible in this photograph. This is not a certification.',
    siteIdPlaceholder: 'SITE-CA-LAX-014',
    timestampLocale: 'en-US',
    /**
     * A site is audited repeatedly and holds many devices, so asset_tag is what
     * distinguishes "the extinguisher by the kitchen door" from "the one in the
     * corridor" — without it two audits of one site are genuinely ambiguous.
     */
    fields: [
      'jurisdiction',
      'occupancy_type',
      'equipment_hint',
      'osha_workplace',
      'asset_tag',
      'inspector_id',
    ],
  },
};

export const ALL_REGION_KEYS: RegionKey[] = ['IND', 'US'];

export function isRegionKey(value: unknown): value is RegionKey {
  return value === 'IND' || value === 'US';
}

/**
 * Parse the ENABLED_REGIONS env var into an allow-list.
 *
 * Deliberately fails CLOSED to 'IND' when unset or unparseable, so that:
 *   - the existing India deployment keeps behaving exactly as it does today,
 *     with no US surface appearing just because this code shipped; and
 *   - a misconfigured deployment can never accidentally expose the US
 *     workflow to an India customer.
 *
 * A US customer deployment must therefore set ENABLED_REGIONS=US explicitly,
 * and an internal/demo deployment ENABLED_REGIONS=IND,US.
 */
export function parseEnabledRegions(raw: string | undefined): RegionKey[] {
  const parsed = (raw ?? '')
    .split(',')
    .map((part) => part.trim().toUpperCase())
    .filter(isRegionKey);

  const unique = ALL_REGION_KEYS.filter((key) => parsed.includes(key));
  return unique.length > 0 ? unique : ['IND'];
}

// ---------------------------------------------------------------------------
// US option lists
//
// These mirror the backend registries. Keep them in step with:
//   jurisdiction   -> scripts/nodes/02_resolve_code_basis.js CODE_BASIS_REGISTRY
//   equipment_hint -> scripts/nodes/03_build_vision_payload.js CHECKLISTS
// A value not in the backend registry is not rejected; RESOLVE_CodeBasis falls
// back to the model-code baseline and flags code_basis_confident: false.
// ---------------------------------------------------------------------------

export interface Option {
  value: string;
  label: string;
  /** Optional secondary line, e.g. why this jurisdiction is special. */
  hint?: string;
}

export const US_JURISDICTIONS: Option[] = [
  {
    value: 'US-DEFAULT',
    label: 'Model-code baseline (IFC 2024)',
    hint: 'No state override — flagged as unconfirmed',
  },
  { value: 'CA', label: 'California', hint: 'CFC Title 24 Pt 9 + Title 19 · Cal/OSHA' },
  { value: 'FL', label: 'Florida', hint: 'FFPC 8th Ed — NFPA 1 / 101, not IFC' },
  { value: 'NY', label: 'New York State (outside NYC)', hint: 'Uniform Code, IFC-based' },
  { value: 'NY-NYC', label: 'New York City', hint: 'NYC Fire Code Title 29 · FDNY' },
  { value: 'TX', label: 'Texas', hint: 'IFC as locally adopted — home rule' },
  { value: 'MA', label: 'Massachusetts', hint: '527 CMR 1.00, NFPA 1 based' },
  { value: 'WA', label: 'Washington', hint: 'WAC 51-54A · WISHA State Plan' },
  { value: 'IL-CHICAGO', label: 'Chicago', hint: 'Chicago Fire Prevention Code' },
];

/** NFPA 101 / IFC occupancy classifications. Free-form on the backend. */
export const US_OCCUPANCIES: Option[] = [
  { value: 'BUSINESS', label: 'Business' },
  { value: 'MERCANTILE', label: 'Mercantile' },
  { value: 'ASSEMBLY', label: 'Assembly' },
  { value: 'EDUCATIONAL', label: 'Educational' },
  { value: 'HEALTH_CARE', label: 'Health care' },
  { value: 'AMBULATORY_HEALTH_CARE', label: 'Ambulatory health care' },
  { value: 'RESIDENTIAL', label: 'Residential' },
  { value: 'RESIDENTIAL_BOARD_AND_CARE', label: 'Residential board & care' },
  { value: 'DETENTION_AND_CORRECTIONAL', label: 'Detention & correctional' },
  { value: 'INDUSTRIAL', label: 'Industrial' },
  { value: 'STORAGE', label: 'Storage' },
  { value: 'MIXED', label: 'Mixed occupancy' },
];

/** The nine checklist keys in CHECKLISTS, plus AUTO for model classification. */
export const US_EQUIPMENT: Option[] = [
  { value: 'AUTO', label: 'Auto-detect', hint: 'Model classifies, then applies one checklist' },
  { value: 'PORTABLE_FIRE_EXTINGUISHER', label: 'Portable fire extinguisher', hint: 'NFPA 10 · IFC 906 · 1910.157' },
  { value: 'SPRINKLER_SYSTEM', label: 'Sprinkler system / riser / head', hint: 'NFPA 25 · NFPA 13' },
  { value: 'FIRE_ALARM', label: 'Fire alarm panel / device', hint: 'NFPA 72' },
  { value: 'KITCHEN_SUPPRESSION', label: 'Kitchen hood suppression', hint: 'NFPA 96 · 17A · 10 (Class K)' },
  { value: 'MEANS_OF_EGRESS', label: 'Means of egress', hint: 'NFPA 101 Ch. 7 · IFC Ch. 10 · 1910.36/.37' },
  { value: 'FIRE_DOOR', label: 'Fire-rated door assembly', hint: 'NFPA 80' },
  { value: 'STANDPIPE_HOSE', label: 'Standpipe / hose / fire pump', hint: 'NFPA 25 · 14 · 20' },
  { value: 'ELECTRICAL_HOUSEKEEPING', label: 'Electrical clearance & housekeeping', hint: 'NFPA 70 110.26' },
  { value: 'EMERGENCY_POWER', label: 'Emergency / standby power', hint: 'NFPA 110' },
];

/** Defaults matching the backend's own defaults in 01_validate_input.js. */
export const US_DEFAULTS = {
  jurisdiction: 'US-DEFAULT',
  occupancy_type: 'BUSINESS',
  equipment_hint: 'AUTO',
  osha_workplace: true,
} as const;
