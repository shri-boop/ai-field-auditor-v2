/**
 * NODE 2 — RESOLVE_CodeBasis
 * Mode: Run Once for All Items
 *
 * WHY THIS NODE EXISTS
 * --------------------
 * The India workflow could hardcode "NBC 2016 + CFO Mumbai" into the prompt
 * because India has a single national code and one local AHJ. The United States
 * does not work that way:
 *
 *   - ~41 states + DC, NYC, Guam and Puerto Rico use the International Fire Code
 *     (ICC), currently the 2024 edition.
 *   - Florida is NOT on the IFC. It uses the Florida Fire Prevention Code,
 *     8th Edition (2023), built from Florida-specific editions of NFPA 1 (2021)
 *     and NFPA 101 (2021), per Fla. Admin. Code R. 69A-3.012.
 *   - California republishes the IFC as the California Fire Code (Title 24
 *     Part 9) on a triennial cycle, and layers Title 19 CCR on top.
 *   - New York City runs its own FDNY-administered Fire Code.
 *   - Independently of all of the above, workplaces carry federal OSHA duties
 *     under 29 CFR 1910 Subpart L / Subpart E, which OSHA can cite directly.
 *
 * Therefore the applicable code is DATA, resolved per request, and the prompt is
 * rendered from that data. Adding a jurisdiction is a registry edit, not a
 * prompt rewrite.
 *
 * HONESTY REQUIREMENT
 * -------------------
 * Code adoption changes, and local amendments routinely override state defaults.
 * Every registry entry therefore carries `verified_on` and
 * `requires_ahj_confirmation`. Unknown jurisdictions fall back to the model-code
 * baseline and are explicitly flagged rather than silently guessed at.
 */

const input = $input.first().json;

// ---------------------------------------------------------------------------
// Nationally referenced inspection/testing/maintenance standards.
// `edition_verified` records whether the edition was confirmed against a
// primary source during authoring. Unverified editions still drive the prompt,
// but the report tells the human reviewer to confirm them.
// ---------------------------------------------------------------------------
const REFERENCED_STANDARDS = {
  PORTABLE_FIRE_EXTINGUISHER: { std: 'NFPA 10',   edition: '2022', title: 'Standard for Portable Fire Extinguishers', edition_verified: true },
  SPRINKLER_SYSTEM:           { std: 'NFPA 25',   edition: '2023', title: 'ITM of Water-Based Fire Protection Systems', edition_verified: false },
  STANDPIPE_HOSE:             { std: 'NFPA 25',   edition: '2023', title: 'ITM of Water-Based Fire Protection Systems', edition_verified: false },
  FIRE_ALARM:                 { std: 'NFPA 72',   edition: '2025', title: 'National Fire Alarm and Signaling Code', edition_verified: false },
  KITCHEN_SUPPRESSION:        { std: 'NFPA 96',   edition: '2024', title: 'Ventilation Control and Fire Protection of Commercial Cooking Operations', edition_verified: false },
  FIRE_DOOR:                  { std: 'NFPA 80',   edition: '2025', title: 'Fire Doors and Other Opening Protectives', edition_verified: false },
  MEANS_OF_EGRESS:            { std: 'NFPA 101',  edition: '2024', title: 'Life Safety Code', edition_verified: false },
  EMERGENCY_POWER:            { std: 'NFPA 110',  edition: '2025', title: 'Emergency and Standby Power Systems', edition_verified: false },
  ELECTRICAL_HOUSEKEEPING:    { std: 'NFPA 70',   edition: '2023', title: 'National Electrical Code', edition_verified: false }
};

// ---------------------------------------------------------------------------
// Jurisdiction registry. Keys are USPS state codes, optionally suffixed with a
// home-rule city (e.g. "NY-NYC", "IL-CHICAGO").
// ---------------------------------------------------------------------------
const CODE_BASIS_REGISTRY = {
  'US-DEFAULT': {
    label: 'Model-code baseline (no state-specific override matched)',
    fire_code: 'International Fire Code (IFC)',
    fire_code_edition: '2024',
    fire_code_publisher: 'International Code Council',
    life_safety_code: 'NFPA 101, Life Safety Code (2024)',
    ahj_label: 'Local Authority Having Jurisdiction (AHJ)',
    state_overlays: [],
    verified_on: '2026-08-31',
    requires_ahj_confirmation: true,
    notes: 'The IFC is in use or adopted in roughly 41 states plus DC, NYC, Guam and Puerto Rico. Confirm the edition and local amendments with the AHJ before relying on any citation.'
  },
  'CA': {
    label: 'California',
    fire_code: 'California Fire Code (CFC), Title 24 Part 9 — California republication of the IFC',
    fire_code_edition: '2025 (triennial cycle; confirm the edition in force with the AHJ)',
    fire_code_publisher: 'California Building Standards Commission / Office of the State Fire Marshal',
    life_safety_code: 'Not separately adopted; CFC governs',
    ahj_label: 'Local fire authority under the Office of the State Fire Marshal (OSFM)',
    state_overlays: [
      'Title 19 CCR (State Fire Marshal regulations), including extinguisher servicing rules',
      'OSFM licenses the companies and technicians that service portable fire extinguishers, so servicing tags carry a California licence number',
      'Cal/OSHA operates an OSHA-approved State Plan; Title 8 CCR applies instead of federal 29 CFR 1910'
    ],
    verified_on: '2026-08-31',
    requires_ahj_confirmation: true,
    notes: 'California is on a triennial code cycle with intervening supplements. Verify whether the 2022 or 2025 CFC is in force for this project.'
  },
  'FL': {
    label: 'Florida',
    fire_code: 'Florida Fire Prevention Code (FFPC), 8th Edition (2023) — NFPA-based, NOT the IFC',
    fire_code_edition: '8th Edition (2023), comprising Florida editions of NFPA 1 (2021) and NFPA 101 (2021)',
    fire_code_publisher: 'Florida State Fire Marshal',
    life_safety_code: 'NFPA 101, Life Safety Code, Florida 2021 Edition',
    ahj_label: 'Local fire official (county, municipality or special fire district)',
    state_overlays: [
      'Fla. Admin. Code R. 69A-3.012 adopts the FFPC and its referenced NFPA standards',
      'Statutory firesafety inspections may only be performed by a firesafety inspector certified under s. 633.216, Florida Statutes',
      'The Florida Building Code is substituted wherever the code references a building code or NFPA 220'
    ],
    verified_on: '2026-08-31',
    requires_ahj_confirmation: true,
    notes: 'Cite NFPA 1 / NFPA 101 rather than IFC chapters for Florida. The FFPC is re-adopted on three-year intervals under s. 633.202, F.S.'
  },
  'NY-NYC': {
    label: 'New York City',
    fire_code: 'New York City Fire Code (Title 29, NYC Administrative Code)',
    fire_code_edition: '2022 (confirm current amendments with FDNY)',
    fire_code_publisher: 'City of New York / FDNY',
    life_safety_code: 'NYC Building Code (Title 28) governs; NFPA 101 not independently adopted',
    ahj_label: 'FDNY Bureau of Fire Prevention',
    state_overlays: [
      'FDNY Certificate of Fitness (C of F) required for many inspection, testing and impairment duties',
      'NYC operates its own code rather than the state Uniform Code',
      'Portable extinguisher servicing requires an FDNY-permitted company'
    ],
    verified_on: '2026-08-31',
    requires_ahj_confirmation: true,
    notes: 'NYC is a home-rule jurisdiction. Do not apply IFC chapter numbers here.'
  },
  'NY': {
    label: 'New York State (outside NYC)',
    fire_code: 'NYS Uniform Fire Prevention and Building Code (2020 Uniform Code, IFC-based)',
    fire_code_edition: '2020 Uniform Code Supplement (IFC 2018 base); confirm current edition',
    fire_code_publisher: 'NYS Department of State, Division of Building Standards and Codes',
    life_safety_code: 'Uniform Code governs',
    ahj_label: 'Local code enforcement official / county fire coordinator',
    state_overlays: ['NYC is excluded from the Uniform Code and is handled under jurisdiction key NY-NYC'],
    verified_on: '2026-08-31',
    requires_ahj_confirmation: true,
    notes: ''
  },
  'TX': {
    label: 'Texas',
    fire_code: 'International Fire Code (IFC) as adopted by the state and by local ordinance',
    fire_code_edition: '2021 statewide baseline; many municipalities adopt later editions with amendments',
    fire_code_publisher: 'International Code Council / adopting municipality',
    life_safety_code: 'NFPA 101 where adopted by the AHJ or required by licensing',
    ahj_label: 'Local fire marshal; State Fire Marshal\u2019s Office for state-regulated occupancies',
    state_overlays: [
      'Texas is strongly home-rule: municipal amendments frequently govern',
      'Extinguisher and alarm contractors are licensed by the Texas Department of Insurance, State Fire Marshal\u2019s Office'
    ],
    verified_on: '2026-08-31',
    requires_ahj_confirmation: true,
    notes: 'Always confirm the adopting ordinance for the specific city.'
  },
  'MA': {
    label: 'Massachusetts',
    fire_code: 'Massachusetts Comprehensive Fire Safety Code, 527 CMR 1.00 (NFPA 1 based)',
    fire_code_edition: '527 CMR 1.00 incorporating NFPA 1 with Massachusetts amendments',
    fire_code_publisher: 'Massachusetts Department of Fire Services',
    life_safety_code: 'NFPA 101 as referenced by 527 CMR 1.00',
    ahj_label: 'Local fire department head / State Fire Marshal',
    state_overlays: ['Massachusetts is NFPA-based rather than IFC-based; cite NFPA 1 chapters'],
    verified_on: '2026-08-31',
    requires_ahj_confirmation: true,
    notes: ''
  },
  'IL-CHICAGO': {
    label: 'Chicago',
    fire_code: 'Chicago Fire Prevention Code (Municipal Code of Chicago, Title 15)',
    fire_code_edition: 'Chicago Construction Codes as amended; confirm with CFD',
    fire_code_publisher: 'City of Chicago',
    life_safety_code: 'Chicago Building Code governs',
    ahj_label: 'Chicago Fire Department, Bureau of Fire Prevention',
    state_overlays: ['Chicago maintains its own code and is not covered by the Illinois state adoption'],
    verified_on: '2026-08-31',
    requires_ahj_confirmation: true,
    notes: ''
  },
  'WA': {
    label: 'Washington',
    fire_code: 'Washington State Fire Code, WAC 51-54A (IFC based)',
    fire_code_edition: 'IFC 2021 base with Washington amendments; confirm current cycle',
    fire_code_publisher: 'Washington State Building Code Council',
    life_safety_code: 'State Fire Code governs',
    ahj_label: 'Local fire marshal / Washington State Patrol Office of the State Fire Marshal',
    state_overlays: ['Washington operates an OSHA-approved State Plan (WISHA / WAC 296)'],
    verified_on: '2026-08-31',
    requires_ahj_confirmation: true,
    notes: ''
  }
};

// Timezones for correct local timestamping even when the code basis falls back.
// (States spanning multiple zones are mapped to their predominant zone; a
// per-site override via body.timezone would be the next refinement.)
const TIMEZONE_BY_STATE = {
  AL: 'America/Chicago', AK: 'America/Anchorage', AZ: 'America/Phoenix', AR: 'America/Chicago',
  CA: 'America/Los_Angeles', CO: 'America/Denver', CT: 'America/New_York', DE: 'America/New_York',
  DC: 'America/New_York', FL: 'America/New_York', GA: 'America/New_York', HI: 'Pacific/Honolulu',
  ID: 'America/Boise', IL: 'America/Chicago', IN: 'America/Indiana/Indianapolis', IA: 'America/Chicago',
  KS: 'America/Chicago', KY: 'America/New_York', LA: 'America/Chicago', ME: 'America/New_York',
  MD: 'America/New_York', MA: 'America/New_York', MI: 'America/Detroit', MN: 'America/Chicago',
  MS: 'America/Chicago', MO: 'America/Chicago', MT: 'America/Denver', NE: 'America/Chicago',
  NV: 'America/Los_Angeles', NH: 'America/New_York', NJ: 'America/New_York', NM: 'America/Denver',
  NY: 'America/New_York', NC: 'America/New_York', ND: 'America/Chicago', OH: 'America/New_York',
  OK: 'America/Chicago', OR: 'America/Los_Angeles', PA: 'America/New_York', RI: 'America/New_York',
  SC: 'America/New_York', SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago',
  UT: 'America/Denver', VT: 'America/New_York', VA: 'America/New_York', WA: 'America/Los_Angeles',
  WV: 'America/New_York', WI: 'America/Chicago', WY: 'America/Denver', PR: 'America/Puerto_Rico'
};

// States running OSHA-approved State Plans covering private-sector employers.
// Federal 29 CFR 1910 citations should be reframed to the state plan there.
const STATE_PLAN_STATES = {
  AK: 'Alaska Occupational Safety and Health (AKOSH)',
  AZ: 'Arizona Division of Occupational Safety and Health (ADOSH)',
  CA: 'Cal/OSHA (Title 8 CCR)',
  HI: 'Hawaii Occupational Safety and Health (HIOSH)',
  IN: 'Indiana Occupational Safety and Health Administration (IOSHA)',
  IA: 'Iowa OSHA',
  KY: 'Kentucky Occupational Safety and Health Program',
  MD: 'Maryland Occupational Safety and Health (MOSH)',
  MI: 'Michigan Occupational Safety and Health Administration (MIOSHA)',
  MN: 'Minnesota OSHA',
  NV: 'Nevada OSHA',
  NM: 'New Mexico Occupational Health and Safety Bureau',
  NC: 'North Carolina Department of Labor OSH Division',
  OR: 'Oregon OSHA',
  SC: 'South Carolina OSHA',
  TN: 'Tennessee OSHA',
  UT: 'Utah Occupational Safety and Health (UOSH)',
  VT: 'VOSHA',
  VA: 'Virginia Occupational Safety and Health (VOSH)',
  WA: 'Washington WISHA (WAC 296)',
  WY: 'Wyoming OSHA'
};

// ---------------------------------------------------------------- resolution
const requested = input.jurisdiction || 'US-DEFAULT';
const stateCode = requested.split('-')[0];

let resolvedKey = 'US-DEFAULT';
if (CODE_BASIS_REGISTRY[requested]) {
  resolvedKey = requested;                 // exact match, incl. home-rule cities
} else if (CODE_BASIS_REGISTRY[stateCode]) {
  resolvedKey = stateCode;                 // fall back to the state entry
}

const basis = CODE_BASIS_REGISTRY[resolvedKey];
const matchedExactly = resolvedKey === requested;

const timezone = TIMEZONE_BY_STATE[stateCode] || 'America/New_York';
const statePlan = STATE_PLAN_STATES[stateCode] || null;

// OSHA overlay text: federal 29 CFR 1910 unless a State Plan displaces it.
let osha_overlay = null;
if (input.osha_workplace) {
  osha_overlay = statePlan
    ? statePlan + ' (OSHA-approved State Plan; standards are at least as effective as 29 CFR 1910)'
    : 'Federal OSHA 29 CFR 1910 — Subpart L (fire protection, incl. 1910.157 portable fire extinguishers) and Subpart E (exit routes, 1910.36 / 1910.37)';
}

const code_basis = {
  jurisdiction_requested: requested,
  jurisdiction_resolved: resolvedKey,
  jurisdiction_label: basis.label,
  exact_match: matchedExactly,
  fire_code: basis.fire_code,
  fire_code_edition: basis.fire_code_edition,
  fire_code_publisher: basis.fire_code_publisher,
  life_safety_code: basis.life_safety_code,
  ahj_label: basis.ahj_label,
  state_overlays: basis.state_overlays,
  osha_overlay: osha_overlay,
  osha_state_plan: statePlan,
  timezone: timezone,
  referenced_standards: REFERENCED_STANDARDS,
  verified_on: basis.verified_on,
  requires_ahj_confirmation: basis.requires_ahj_confirmation,
  notes: basis.notes,
  // Set false whenever we had to fall back, so the report can say so plainly.
  code_basis_confident: matchedExactly
};

const unverified_editions = Object.keys(REFERENCED_STANDARDS).filter(function (k) {
  return !REFERENCED_STANDARDS[k].edition_verified;
}).map(function (k) {
  return REFERENCED_STANDARDS[k].std + ' (' + REFERENCED_STANDARDS[k].edition + ')';
});

// De-duplicate standard names (NFPA 25 appears twice in the map).
const unique_unverified = unverified_editions.filter(function (v, i, a) {
  return a.indexOf(v) === i;
});

return [{
  json: Object.assign({}, input, {
    code_basis: code_basis,
    unverified_standard_editions: unique_unverified
  })
}];
