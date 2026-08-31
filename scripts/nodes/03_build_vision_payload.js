/**
 * NODE 3 — BUILD_Vision_Payload
 * Mode: Run Once for All Items
 *
 * Renders the audit prompt from (a) the resolved code basis and (b) a
 * per-equipment-class checklist registry. The prompt is generated, never
 * hardcoded, so adding a checklist item or a jurisdiction never requires
 * touching prose.
 *
 * DESIGN NOTES
 *  - Severity is assigned by US inspection practice, not invented by the model:
 *    CRITICAL = immediate life-safety hazard or system impairment
 *    MAJOR    = real reduction in protection, not immediately life-threatening
 *    MINOR    = documentation / administrative
 *  - The model is explicitly required to declare what it CANNOT determine from a
 *    photograph (weight, internal condition, functional tests). A still image can
 *    never certify compliance, and the system must say so rather than imply it.
 *  - temperature 0 for run-to-run stability on the same photo.
 */

const input = $input.first().json;
const cb = input.code_basis;
const std = cb.referenced_standards;

function ref(key) {
  const s = std[key];
  return s ? s.std + ' (' + s.edition + ')' : '';
}

// ---------------------------------------------------------------------------
// CHECKLIST REGISTRY
// ---------------------------------------------------------------------------
const CHECKLISTS = {
  PORTABLE_FIRE_EXTINGUISHER: {
    label: 'Portable fire extinguisher (and its cabinet / bracket / signage)',
    primary: ref('PORTABLE_FIRE_EXTINGUISHER'),
    checks: [
      { id: 'UNIT_MISSING_OR_DISCHARGED', sev: 'CRITICAL', text: 'Unit absent from its designated bracket or cabinet, visibly discharged, or the gauge needle sits in the recharge/overcharge zone rather than the operable (green) range.', ref: 'NFPA 10 7.2.2; 29 CFR 1910.157(c)(4)' },
      { id: 'ACCESS_FULLY_BLOCKED', sev: 'CRITICAL', text: 'Access to the unit is fully blocked or the unit is completely obscured from view by stock, equipment or furniture.', ref: 'NFPA 10 6.1.3.3; 29 CFR 1910.157(c)(1)' },
      { id: 'GAUGE_OUT_OF_RANGE', sev: 'MAJOR', text: 'Pressure gauge needle is outside the operable range, gauge face is fogged, cracked, corroded or unreadable.', ref: 'NFPA 10 7.2.2' },
      { id: 'SEAL_OR_PIN_COMPROMISED', sev: 'MAJOR', text: 'Pull pin missing or not seated, or the tamper seal / tamper indicator is broken, missing or previously actuated.', ref: 'NFPA 10 7.2.2' },
      { id: 'ANNUAL_TAG_MISSING_OR_LAPSED', sev: 'MAJOR', text: 'Annual maintenance tag absent, illegible, unsigned, or the most recent punch/date is more than 12 months old.', ref: 'NFPA 10 7.3.1; 29 CFR 1910.157(e)(3)' },
      { id: 'INTERNAL_OR_HYDRO_OVERDUE', sev: 'MAJOR', text: 'Six-year internal maintenance or hydrostatic test appears overdue based on dates stamped on the shell, collar or verification-of-service collar. Typical hydrostatic intervals: 12 years for stored-pressure dry chemical, 5 years for CO2, water, wet chemical and AFFF.', ref: 'NFPA 10 7.3.3 and 8.3.1; 29 CFR 1910.157(f)' },
      { id: 'MOUNTING_HEIGHT_WRONG', sev: 'MAJOR', text: 'Mounting height non-compliant: for gross weight up to and including 40 lb the top must be no more than 5 ft above the floor; above 40 lb (other than wheeled units) no more than 3.5 ft; and in all cases the clearance between the bottom of the unit and the floor must be at least 4 in.', ref: 'NFPA 10 6.1.3.8 and 6.1.3.9' },
      { id: 'NOT_CONSPICUOUS_OR_UNSIGNED', sev: 'MAJOR', text: 'Unit is not in a conspicuous location, or the location marking/sign is missing where the unit is not plainly visible (e.g. recessed cabinet, behind an obstruction, high-rack area).', ref: 'NFPA 10 6.1.3.3' },
      { id: 'PHYSICAL_DAMAGE_OR_CORROSION', sev: 'MAJOR', text: 'Corrosion, pitting, dents, damaged or missing hose/horn/nozzle, cracked or clogged nozzle, damaged carrying handle or lever, or an illegible operating nameplate.', ref: 'NFPA 10 7.2.2' },
      { id: 'WRONG_CLASS_FOR_HAZARD', sev: 'MAJOR', text: 'Extinguisher class does not match the hazard visible in the scene — for example no Class K unit serving a commercial cooking appliance with vegetable or animal fat, or a water-based unit sited at an energised electrical hazard.', ref: 'NFPA 10 5.5 and 6.6' },
      { id: 'LISTING_LABEL_MISSING', sev: 'MINOR', text: 'UL Listing or FM Approval mark absent, painted over or illegible. (This is the US analogue of the Indian ISI mark — do NOT look for an ISI mark.)', ref: 'NFPA 10 5.2.1' },
      { id: 'CABINET_DEFECT', sev: 'MINOR', text: 'Cabinet glass broken or missing, latch or door damaged, cabinet not marked to identify the extinguisher inside, or break-glass tool missing.', ref: 'NFPA 10 6.1.3' }
    ]
  },

  SPRINKLER_SYSTEM: {
    label: 'Automatic sprinkler system, riser, control valve or sprinkler head',
    primary: ref('SPRINKLER_SYSTEM'),
    checks: [
      { id: 'CONTROL_VALVE_CLOSED', sev: 'CRITICAL', text: 'A sprinkler control valve appears closed or partially closed. A closed valve is a system impairment, not merely a deficiency.', ref: 'NFPA 25 13.3.2 and Chapter 15' },
      { id: 'HEAD_MISSING_OR_PAINTED', sev: 'CRITICAL', text: 'Sprinkler head missing, painted over, coated, plugged, or fitted with a foreign object; escutcheon absent in a way that exposes the ceiling void.', ref: 'NFPA 25 5.2.1' },
      { id: 'VALVE_NOT_SUPERVISED', sev: 'MAJOR', text: 'Control valve not sealed, locked or electrically supervised in the open position, or missing its identification signage.', ref: 'NFPA 25 13.3.2' },
      { id: 'GAUGE_ABNORMAL_OR_EXPIRED', sev: 'MAJOR', text: 'System gauge reads outside the normal range, or the gauge appears more than 5 years old without replacement or calibration.', ref: 'NFPA 25 13.2.7' },
      { id: 'CLEARANCE_UNDER_HEADS', sev: 'MAJOR', text: 'Storage or obstruction encroaches on the required clear space below sprinkler deflectors (commonly 18 in minimum), or shelving/ductwork blocks the discharge pattern.', ref: 'NFPA 13; IFC 315 storage provisions' },
      { id: 'HEAD_CORROSION_OR_LOADING', sev: 'MAJOR', text: 'Heads show corrosion, mechanical damage, or loading with dust, grease, lint or overspray.', ref: 'NFPA 25 5.2.1' },
      { id: 'FDC_DEFECT', sev: 'MAJOR', text: 'Fire department connection missing caps or plugs, damaged or fouled threads, visible debris in the intake, obstructed approach, or missing identification signage.', ref: 'NFPA 25 13.7' },
      { id: 'ITM_RECORD_MISSING', sev: 'MINOR', text: 'Inspection, testing and maintenance tag or record absent, illegible or lapsed at the riser.', ref: 'NFPA 25 4.3' },
      { id: 'SPARE_HEAD_CABINET', sev: 'MINOR', text: 'Spare sprinkler cabinet missing, under-stocked for the head types installed, or missing the correct sprinkler wrench.', ref: 'NFPA 25 5.4.1' }
    ]
  },

  FIRE_ALARM: {
    label: 'Fire alarm control panel, initiating device or notification appliance',
    primary: ref('FIRE_ALARM'),
    checks: [
      { id: 'PANEL_NOT_NORMAL', sev: 'CRITICAL', text: 'Fire alarm control panel shows a trouble, supervisory, alarm or silenced condition, has devices disabled or bypassed, or the panel is powered down.', ref: ref('FIRE_ALARM') + ' Chapter 14' },
      { id: 'DETECTOR_COVERED', sev: 'CRITICAL', text: 'Smoke or heat detector bagged, taped, capped with a construction dust cover, painted, or physically removed from its base.', ref: ref('FIRE_ALARM') + ' Chapter 17' },
      { id: 'PULL_STATION_OBSTRUCTED', sev: 'MAJOR', text: 'Manual fire alarm box obstructed, obscured, painted over, damaged, or mounted outside the reachable range (commonly 42 in to 48 in above the floor to the operable part).', ref: ref('FIRE_ALARM') + ' Chapter 17' },
      { id: 'NOTIFICATION_APPLIANCE_DEFECT', sev: 'MAJOR', text: 'Horn, speaker or strobe damaged, painted, obstructed, or with the strobe lens blocked or removed.', ref: ref('FIRE_ALARM') + ' Chapter 18' },
      { id: 'SECONDARY_POWER_SUSPECT', sev: 'MAJOR', text: 'Standby batteries visibly swollen, leaking, corroded, or dated beyond their service life.', ref: ref('FIRE_ALARM') + ' Chapter 10' },
      { id: 'ALARM_ITM_RECORD_MISSING', sev: 'MINOR', text: 'Annual inspection and test record or tag missing, illegible or lapsed at the panel.', ref: ref('FIRE_ALARM') + ' Chapter 14' }
    ]
  },

  KITCHEN_SUPPRESSION: {
    label: 'Commercial kitchen hood, duct and wet-chemical suppression system',
    primary: ref('KITCHEN_SUPPRESSION'),
    checks: [
      { id: 'NOZZLE_MISALIGNED_OR_UNCAPPED', sev: 'CRITICAL', text: 'Discharge nozzles missing their blow-off caps or foil seals, aimed away from the appliance hazard, or clearly not matched to the appliance line-up below (a common failure after appliances are swapped or moved).', ref: ref('KITCHEN_SUPPRESSION') + '; NFPA 17A' },
      { id: 'SYSTEM_DISABLED', sev: 'CRITICAL', text: 'Suppression cylinder gauge outside the operable range, actuator disconnected, or the system otherwise visibly out of service while cooking appliances remain in use.', ref: 'NFPA 17A' },
      { id: 'HOOD_GREASE_ACCUMULATION', sev: 'MAJOR', text: 'Measurable grease accumulation on filters, hood interior, plenum or accessible duct surfaces.', ref: ref('KITCHEN_SUPPRESSION') + ' Chapter 11' },
      { id: 'FILTERS_DEFECTIVE', sev: 'MAJOR', text: 'Grease filters missing, damaged, gapped, incorrectly oriented, or not forming a continuous barrier across the hood opening.', ref: ref('KITCHEN_SUPPRESSION') + ' Chapter 6' },
      { id: 'FUSIBLE_LINKS_OVERDUE', sev: 'MAJOR', text: 'Fusible links or detectors visibly greased, painted, or dated more than 12 months ago where an annual replacement is required.', ref: 'NFPA 17A' },
      { id: 'MANUAL_PULL_DEFECT', sev: 'MAJOR', text: 'Manual actuation station missing, obstructed, unlabelled, or not located in a path of egress at an accessible height (commonly 42 in to 48 in above the floor).', ref: ref('KITCHEN_SUPPRESSION') + ' Chapter 10' },
      { id: 'NO_CLASS_K_NEARBY', sev: 'MAJOR', text: 'No Class K portable extinguisher visible serving the cooking hazard (maximum 30 ft travel distance), or the required placard instructing users to actuate the hood system first is missing.', ref: 'NFPA 10 6.6; ' + ref('KITCHEN_SUPPRESSION') },
      { id: 'SEMIANNUAL_TAG_LAPSED', sev: 'MAJOR', text: 'Semi-annual inspection tag for the suppression system missing, illegible or more than 6 months old.', ref: ref('KITCHEN_SUPPRESSION') + ' Chapter 11' }
    ]
  },

  MEANS_OF_EGRESS: {
    label: 'Means of egress — exit doors, corridors, stairs, exit and emergency lighting',
    primary: cb.fire_code + ' ' + cb.fire_code_edition + '; ' + ref('MEANS_OF_EGRESS'),
    checks: [
      { id: 'EGRESS_OBSTRUCTED', sev: 'CRITICAL', text: 'Exit door, corridor, stair, landing or exit discharge obstructed by storage, equipment, furniture, waste or parked vehicles, or the required egress width is encroached upon.', ref: ref('MEANS_OF_EGRESS') + ' Chapter 7; 29 CFR 1910.37(a)(3)' },
      { id: 'EXIT_DOOR_LOCKED', sev: 'CRITICAL', text: 'Exit door chained, padlocked, bolted, fitted with an unapproved add-on lock, or otherwise not openable from the egress side without a key, tool or special knowledge.', ref: ref('MEANS_OF_EGRESS') + ' 7.2.1; 29 CFR 1910.36(d)' },
      { id: 'FIRE_DOOR_WEDGED', sev: 'CRITICAL', text: 'Self-closing fire door or smoke barrier door wedged, blocked, tied or propped open by unapproved means.', ref: ref('FIRE_DOOR') },
      { id: 'PANIC_HARDWARE_DEFECT', sev: 'CRITICAL', text: 'Required panic or fire exit hardware missing, disabled, or supplemented with additional locking devices.', ref: cb.fire_code + ' means-of-egress door provisions' },
      { id: 'EXIT_SIGN_DEFECT', sev: 'MAJOR', text: 'Exit sign missing, not illuminated, damaged, obscured, or a directional exit sign absent where the path of travel is not obvious.', ref: ref('MEANS_OF_EGRESS') + ' 7.10' },
      { id: 'EMERGENCY_LIGHTING_DEFECT', sev: 'MAJOR', text: 'Emergency egress illumination unit missing, damaged, indicator lamp dark, or the monthly test evidence absent.', ref: ref('MEANS_OF_EGRESS') + ' 7.9' },
      { id: 'DEAD_END_OR_MISLEADING_PATH', sev: 'MAJOR', text: 'Path of egress is misleading — for example a mirrored or draped opening, or an exit that discharges into an enclosed or locked area.', ref: ref('MEANS_OF_EGRESS') + ' Chapter 7' }
    ]
  },

  FIRE_DOOR: {
    label: 'Fire-rated door assembly and opening protective',
    primary: ref('FIRE_DOOR'),
    checks: [
      { id: 'DOOR_HELD_OPEN', sev: 'CRITICAL', text: 'Assembly wedged, tied, propped or held open other than by a listed hold-open device that releases on alarm.', ref: ref('FIRE_DOOR') + ' Chapter 5' },
      { id: 'NO_LATCH_OR_CLOSE', sev: 'CRITICAL', text: 'Door fails to self-close and positively latch, latch bolt does not engage the strike, or the closer is removed, disconnected or leaking.', ref: ref('FIRE_DOOR') + ' Chapter 5' },
      { id: 'LABEL_MISSING_OR_PAINTED', sev: 'MAJOR', text: 'Fire door or frame label missing, painted over, removed or illegible.', ref: ref('FIRE_DOOR') + ' 5.2' },
      { id: 'CLEARANCES_EXCESSIVE', sev: 'MAJOR', text: 'Perimeter clearances exceed the permitted tolerance — commonly a maximum of 1/8 in along the top and sides of swinging doors, and a maximum of 3/4 in at the bottom.', ref: ref('FIRE_DOOR') + ' Chapter 6' },
      { id: 'UNAPPROVED_FIELD_MODIFICATION', sev: 'MAJOR', text: 'Unlisted field modification — drilled holes, added louvres or vision panels, applied signage or kick plates beyond the permitted size, or holes left by removed hardware.', ref: ref('FIRE_DOOR') + ' Chapter 5' },
      { id: 'GASKETING_DAMAGED', sev: 'MINOR', text: 'Smoke seals, gasketing or the door bottom seal torn, missing or painted.', ref: ref('FIRE_DOOR') },
      { id: 'DOOR_ITM_RECORD_MISSING', sev: 'MINOR', text: 'Annual fire door inspection record or tag absent for the assembly.', ref: ref('FIRE_DOOR') + ' 5.2.1' }
    ]
  },

  STANDPIPE_HOSE: {
    label: 'Standpipe, hose valve, hose cabinet or fire pump',
    primary: ref('STANDPIPE_HOSE'),
    checks: [
      { id: 'PUMP_NOT_AUTO', sev: 'CRITICAL', text: 'Fire pump controller not in the automatic position, showing an alarm, or the pump is visibly isolated or out of service.', ref: 'NFPA 25 Chapter 8; NFPA 20' },
      { id: 'HOSE_VALVE_INACCESSIBLE', sev: 'CRITICAL', text: 'Hose valve or standpipe outlet obstructed, buried behind storage, or the cabinet locked without an approved means of access.', ref: 'NFPA 25 Chapter 6' },
      { id: 'HOSE_VALVE_DEFECT', sev: 'MAJOR', text: 'Missing cap, damaged or fouled threads, visible leakage, corroded handwheel, or missing pressure-reducing valve identification.', ref: 'NFPA 25 Chapter 6' },
      { id: 'PUMP_ROOM_DEFECT', sev: 'MAJOR', text: 'Fire pump room shows water leakage, abnormal suction or discharge gauge readings, blocked ventilation, or is used for unrelated storage.', ref: 'NFPA 25 Chapter 8' },
      { id: 'STANDPIPE_ITM_MISSING', sev: 'MINOR', text: 'Standpipe or fire pump inspection, testing and maintenance record absent or lapsed.', ref: 'NFPA 25 4.3' }
    ]
  },

  ELECTRICAL_HOUSEKEEPING: {
    label: 'Electrical equipment clearances and fire-related housekeeping',
    primary: cb.fire_code + ' ' + cb.fire_code_edition + '; ' + ref('ELECTRICAL_HOUSEKEEPING'),
    checks: [
      { id: 'PANEL_EXPOSED_LIVE_PARTS', sev: 'CRITICAL', text: 'Electrical panel cover missing, dead front removed, open unused breaker spaces or unsealed knockouts exposing energised parts.', ref: 'NFPA 70 408; 29 CFR 1910.303' },
      { id: 'PANEL_WORKING_SPACE_BLOCKED', sev: 'MAJOR', text: 'Required working space in front of electrical equipment is used for storage or obstructed (commonly 36 in depth for equipment operating at 150 V or less to ground), or the dedicated equipment space above the panel is encroached upon.', ref: 'NFPA 70 110.26' },
      { id: 'IMPROPER_WIRING_METHODS', sev: 'MAJOR', text: 'Relocatable power taps or extension cords used as permanent wiring, daisy-chained power strips, cords run through walls, doorways or ceilings, or damaged cords and open splices.', ref: cb.fire_code + ' electrical provisions; 29 CFR 1910.305' },
      { id: 'COMBUSTIBLE_ACCUMULATION', sev: 'MAJOR', text: 'Accumulation of combustible waste, cardboard, pallets or flammable liquids in a manner creating a fire hazard, or storage against heat-producing equipment.', ref: cb.fire_code + ' general fire safety provisions' },
      { id: 'PANEL_NOT_LABELLED', sev: 'MINOR', text: 'Circuit directory missing or inaccurate, or disconnect not legibly marked for its purpose.', ref: 'NFPA 70 110.22 and 408.4' }
    ]
  },

  EMERGENCY_POWER: {
    label: 'Emergency or standby power system (generator, transfer switch)',
    primary: ref('EMERGENCY_POWER'),
    checks: [
      { id: 'GENERATOR_NOT_AVAILABLE', sev: 'CRITICAL', text: 'Generator in the off or manual position, control panel in alarm, batteries disconnected, or the unit visibly out of service.', ref: ref('EMERGENCY_POWER') + ' Chapter 8' },
      { id: 'FUEL_OR_LEAK_ISSUE', sev: 'MAJOR', text: 'Fuel level below the required minimum, or visible fuel, oil or coolant leakage.', ref: ref('EMERGENCY_POWER') + ' Chapter 8' },
      { id: 'ENCLOSURE_OBSTRUCTED', sev: 'MAJOR', text: 'Combustion air louvres, exhaust path or access clearances blocked, or the room is used for unrelated storage.', ref: ref('EMERGENCY_POWER') },
      { id: 'GEN_TEST_RECORD_MISSING', sev: 'MINOR', text: 'Weekly inspection or monthly load-test log absent or lapsed.', ref: ref('EMERGENCY_POWER') + ' Chapter 8' }
    ]
  }
};

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------
const hint = input.equipment_hint;
const hintedKey = CHECKLISTS[hint] ? hint : null;
const activeKeys = hintedKey ? [hintedKey] : Object.keys(CHECKLISTS);

function renderChecklist(key) {
  const c = CHECKLISTS[key];
  const lines = c.checks.map(function (chk, i) {
    return '   ' + (i + 1) + '. [' + chk.sev + '] (' + chk.id + ') ' + chk.text +
           '\n      Authority: ' + chk.ref;
  }).join('\n');
  return '## ' + key + ' — ' + c.label + '\n' +
         'Governing standard: ' + c.primary + '\n' + lines;
}

const checklistBlock = activeKeys.map(renderChecklist).join('\n\n');

const overlayLines = (cb.state_overlays || []).map(function (o) { return '  - ' + o; }).join('\n');

const codeBasisBlock = [
  'JURISDICTION      : ' + cb.jurisdiction_label + ' (' + cb.jurisdiction_resolved + ')',
  'GOVERNING FIRE CODE: ' + cb.fire_code,
  'EDITION           : ' + cb.fire_code_edition,
  'LIFE SAFETY CODE  : ' + cb.life_safety_code,
  'AHJ               : ' + cb.ahj_label,
  'OCCUPANCY (claimed): ' + input.occupancy_type,
  cb.osha_overlay ? 'WORKPLACE OVERLAY : ' + cb.osha_overlay : 'WORKPLACE OVERLAY : not applied (caller declared non-workplace)',
  overlayLines ? 'STATE / LOCAL OVERLAYS:\n' + overlayLines : ''
].filter(Boolean).join('\n');

const scopeInstruction = hintedKey
  ? 'The caller has declared the subject is: ' + hintedKey + ' (' + CHECKLISTS[hintedKey].label + '). Apply that checklist. If the photograph plainly shows something else, say so in "equipment_type" and audit what is actually visible.'
  : 'FIRST classify what the photograph actually shows, choosing the single best match from: ' + Object.keys(CHECKLISTS).join(', ') + '. THEN apply only that checklist. If the image shows no recognisable fire or life-safety subject, set equipment_type to "UNDETERMINED" and set reinspect_required to true.';

const auditPrompt = [
  'You are a senior US fire and life-safety compliance inspector performing a PHOTO-BASED PRE-INSPECTION SCREEN.',
  '',
  '=== APPLICABLE CODE BASIS (authoritative for this audit) ===',
  codeBasisBlock,
  '',
  'Cite ONLY the code basis above and the standards named in the checklist. This is a United States audit:',
  'do NOT reference the National Building Code of India, NBC 2016, ISI marks, or any Indian authority. The US',
  'equivalent of an ISI mark is a UL Listing or FM Approval mark.',
  '',
  '=== SCOPE ===',
  scopeInstruction,
  '',
  '=== CHECKLIST ===',
  checklistBlock,
  '',
  '=== SEVERITY RULES ===',
  'CRITICAL — an immediate life-safety hazard or a system impairment: blocked or locked egress, a closed',
  '           sprinkler control valve, a disabled or covered detection device, a missing or discharged',
  '           extinguisher, exposed energised parts, a fire door that cannot close and latch.',
  'MAJOR    — a genuine reduction in the level of protection that is not immediately life-threatening:',
  '           lapsed servicing, out-of-range gauge, wrong mounting height, obstruction that still leaves access.',
  'MINOR    — documentation, labelling or administrative shortfalls with no direct effect on performance.',
  'Use the severity printed next to each checklist item as your baseline. You may escalate one level if the',
  'scene makes the consequence worse, but you must justify any escalation in the "finding" text.',
  '',
  '=== EVIDENTIAL DISCIPLINE (most important section) ===',
  '1. Report only what is genuinely VISIBLE. Never infer a date, a pressure reading or a tag punch you cannot read.',
  '2. If a required check cannot be judged from a still photograph, do NOT record it as a deficiency and do NOT',
  '   record it as compliant. List it in "unverifiable_items". Checks that are inherently unverifiable from a',
  '   photograph include: actual agent weight or fullness, internal shell condition, functional discharge or',
  '   trip tests, audibility and candela output, water flow and pressure readings, and travel-distance',
  '   measurement when the surrounding area is out of frame.',
  '3. If the image is too dark, blurred, distant, glared or cropped to support a finding, set image_quality to',
  '   POOR and reinspect_required to true, and state precisely what a better photograph must show.',
  '4. Set confidence LOW whenever key evidence is marginal. Understating confidence is always preferred to',
  '   overstating it.',
  '5. Set impairment_suspected true only where a protection system appears to be out of service or isolated,',
  '   because that triggers a formal impairment procedure with fire watch and AHJ/insurer notification.',
  '',
  '=== OUTPUT ===',
  'Return ONLY a single valid JSON object. No markdown, no code fences, no commentary before or after.',
  'Schema:',
  '{',
  '  "equipment_type": "one of the checklist keys, or UNDETERMINED",',
  '  "equipment_subtype": "e.g. ABC dry chemical stored pressure, 10 lb — or null",',
  '  "image_quality": "GOOD | FAIR | POOR",',
  '  "confidence": "HIGH | MEDIUM | LOW",',
  '  "reinspect_required": true or false,',
  '  "reinspect_reasons": ["what specifically must be re-photographed and why"],',
  '  "observations": "2-5 sentences describing what is actually visible in the frame",',
  '  "deficiencies": [',
  '    {',
  '      "code": "checklist item id, e.g. GAUGE_OUT_OF_RANGE",',
  '      "severity": "CRITICAL | MAJOR | MINOR",',
  '      "finding": "the deficiency in one sentence",',
  '      "observed": "the specific visual evidence in this photograph",',
  '      "requirement": "what the code or standard requires",',
  '      "code_reference": "e.g. NFPA 10 (2022) 7.2.2; 29 CFR 1910.157(e)(3)",',
  '      "remediation": "the corrective action a technician should take",',
  '      "verification_needed": true or false',
  '    }',
  '  ],',
  '  "unverifiable_items": ["checks that a photograph cannot settle"],',
  '  "impairment_suspected": true or false,',
  '  "impairment_basis": "why, or null"',
  '}',
  'Return an empty deficiencies array if nothing is wrong. Do not invent deficiencies to appear thorough.'
].join('\n');

const PRIMARY_MODEL = 'anthropic/claude-sonnet-4-5';

const payload = {
  model: PRIMARY_MODEL,
  max_tokens: 3000,
  temperature: 0,
  messages: [
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: input.image_url } },
        { type: 'text', text: auditPrompt }
      ]
    }
  ],
  usage: { include: true }
};

return [{
  json: Object.assign({}, input, {
    payload: payload,
    primary_model: PRIMARY_MODEL,
    prompt_chars: auditPrompt.length,
    checklists_offered: activeKeys,
    dispatched_at: new Date().toISOString()
  })
}];
