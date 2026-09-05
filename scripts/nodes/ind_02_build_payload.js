/**
 * INDIA NODE 2 — BUILD_Vision_Payload
 * Mode: Run Once for All Items
 *
 * Renders the audit prompt and the OpenRouter payload.
 *
 * ---------------------------------------------------------------------------
 * THE MODEL IS NOT ASKED FOR A STATUS
 * ---------------------------------------------------------------------------
 * The previous prompt asked for `"status": "COMPLIANT or NON-COMPLIANT"` and the
 * workflow wrote that answer straight into the database and branched on it. That
 * made the verdict which triggers escalation unreviewable and unstable: a model
 * revision returning "PASS" or "PARTIAL" instead of "COMPLIANT" would have routed
 * every audit down the compliant branch and fired no alert, silently.
 *
 * The model is now asked only for OBSERVATIONS — what it can see, and how serious
 * each finding is against a named clause. DERIVE_Verdict computes the status from
 * those in code. Same reasoning as the US workflow, which has done this from the
 * start.
 *
 * Severities are constrained to CRITICAL / MAJOR / MINOR and each finding must
 * carry a citation, because "non-compliant" on its own is not actionable: a
 * missing ISI mark and a discharged cylinder are not the same problem.
 */

const input = $('VALIDATE_Input').first().json;

// ---------------------------------------------------------------------------
// CHECKLIST — NBC 2016 Part 4 read with the Maharashtra Fire Prevention and Life
// Safety Measures Rules 2009, and IS 2190 for portable extinguisher practice.
//
// Severity assignment is a judgement encoded here rather than left to the model,
// so it is reviewable and consistent between audits:
//   CRITICAL  the equipment cannot be relied on to work, or cannot be reached
//   MAJOR     a defect that defeats certification or maintenance requirements
//   MINOR     marking, documentation or housekeeping
// ---------------------------------------------------------------------------
const CHECKLIST = [
  { id: 'UNIT_MISSING_OR_DISCHARGED', sev: 'CRITICAL', text: 'Unit absent from its designated bracket or location, visibly discharged, or the pressure gauge needle sits in the recharge/red zone rather than the operable green range.', ref: 'IS 2190; NBC 2016 Part 4' },
  { id: 'ACCESS_BLOCKED', sev: 'CRITICAL', text: 'Access to the unit is fully blocked or the unit is completely obscured by stock, equipment or furniture.', ref: 'IS 2190 cl. 4; NBC 2016 Part 4' },
  { id: 'HOSE_REEL_UNUSABLE', sev: 'CRITICAL', text: 'Hose reel or first-aid hose is unusable — hose missing, severed, or the cabinet cannot be opened.', ref: 'NBC 2016 Part 4' },
  { id: 'GAUGE_OUT_OF_RANGE', sev: 'MAJOR', text: 'Pressure gauge needle outside the green operable range, or the gauge face is fogged, cracked, corroded or unreadable.', ref: 'IS 2190' },
  { id: 'SEAL_OR_PIN_COMPROMISED', sev: 'MAJOR', text: 'Safety pin missing or not seated, or the tamper seal is broken, missing or previously actuated.', ref: 'IS 2190' },
  { id: 'REFILL_OR_EXPIRY_OVERDUE', sev: 'MAJOR', text: 'Refill or expiry date has passed, or the last recorded refill is more than the permitted interval old.', ref: 'IS 2190 cl. 7' },
  { id: 'INSPECTION_TAG_MISSING', sev: 'MAJOR', text: 'Inspection or maintenance tag/card absent, illegible, unsigned, or not current.', ref: 'IS 2190; MFPLSM Rules 2009' },
  { id: 'PHYSICAL_DAMAGE_OR_CORROSION', sev: 'MAJOR', text: 'Corrosion, pitting, dents, or a damaged or missing hose, horn or nozzle; illegible operating instructions.', ref: 'IS 2190' },
  { id: 'MOUNTING_HEIGHT_WRONG', sev: 'MAJOR', text: 'Mounting non-compliant — not securely mounted, or the top of the unit more than about 1.5 m above floor level for a hand-portable extinguisher.', ref: 'IS 2190 cl. 4' },
  { id: 'WRONG_CLASS_FOR_HAZARD', sev: 'MAJOR', text: 'Extinguisher class does not match the hazard visible in the scene, for example a water-based unit sited at an energised electrical hazard.', ref: 'IS 2190 cl. 3; NBC 2016 Part 4' },
  { id: 'ISI_MARK_MISSING', sev: 'MINOR', text: 'ISI mark / BIS certification mark absent, painted over or illegible on the cylinder body.', ref: 'IS 15683; BIS certification' },
  { id: 'CABINET_DEFECT', sev: 'MINOR', text: 'Cabinet or hose reel glass broken or missing, latch or door damaged, or break-glass tool absent, where the equipment itself remains usable.', ref: 'NBC 2016 Part 4' },
  { id: 'SIGNAGE_MISSING', sev: 'MINOR', text: 'Location marking or signage absent where the unit is not plainly visible.', ref: 'NBC 2016 Part 4' }
];

const checklistText = CHECKLIST.map(function (c) {
  return '- ' + c.id + ' [' + c.sev + '] ' + c.text + ' (Reference: ' + c.ref + ')';
}).join('\n');

const auditPrompt = [
  'You are a strict fire safety compliance auditor operating in Maharashtra, India.',
  '',
  'CODE BASIS: National Building Code of India 2016, Part 4 (Fire and Life Safety),',
  'as made enforceable by the Maharashtra Fire Prevention and Life Safety Measures',
  'Act 2006 and the Rules 2009. Portable extinguisher practice follows IS 2190 and',
  'IS 15683. The authority having jurisdiction is the Chief Fire Officer of the',
  'Municipal Corporation (MCGM for Brihanmumbai).',
  '',
  'Cite Indian standards only. Do NOT cite NFPA, IFC or UL/FM — those are US',
  'instruments and are wrong here. The Indian conformity mark is the ISI / BIS mark.',
  '',
  'Inspect the photograph against this checklist. Report ONLY what is actually',
  'visible. Do not infer a defect you cannot see, and do not report an item as',
  'compliant when the photograph cannot settle it — list that under',
  '"unverifiable_items" instead.',
  '',
  'CHECKLIST:',
  checklistText,
  '',
  'SITE (claimed): ' + input.site_id,
  // null, not '' — the join below drops nulls only. Filtering empty strings
  // would also strip every intentional blank line and collapse the prompt into
  // one unreadable block.
  input.asset_tag ? 'ASSET TAG (claimed): ' + input.asset_tag : null,
  '',
  'Do NOT return an overall status, verdict, or pass/fail judgement. That is',
  'computed downstream from the severities you assign. Returning one will be',
  'ignored.',
  '',
  'Return ONLY valid JSON, no markdown, no code fences, no commentary.',
  'Exact schema:',
  '{',
  '  "equipment_type": "string, what the photograph actually shows",',
  '  "confidence": "HIGH or MEDIUM or LOW",',
  '  "image_quality": "GOOD or FAIR or POOR",',
  '  "observations": "string, what you see, in plain prose",',
  '  "deficiencies": [',
  '    {',
  '      "code": "one of the checklist IDs above",',
  '      "severity": "CRITICAL or MAJOR or MINOR",',
  '      "finding": "what is wrong",',
  '      "observed": "what in the image shows it",',
  '      "requirement": "what the code requires instead",',
  '      "code_reference": "the Indian standard or rule",',
  '      "remediation": "the corrective action"',
  '    }',
  '  ],',
  '  "unverifiable_items": ["checks this photograph cannot settle"],',
  '  "reinspect_required": true or false',
  '}',
  '',
  'If the image shows no recognisable fire safety equipment, set equipment_type to',
  '"UNDETERMINED", return an empty deficiencies array and set reinspect_required',
  'to true.'
].filter(function (line) { return line !== null; }).join('\n');

const payload = {
  model: 'anthropic/claude-sonnet-4-5',
  max_tokens: 2048,
  temperature: 0,
  messages: [
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: input.image_url } },
        { type: 'text', text: auditPrompt }
      ]
    }
  ]
};

return [{
  json: {
    payload: payload,
    site_id: input.site_id,
    // Echoed so DERIVE_Verdict can validate the model's codes against the
    // checklist it was actually given, rather than a copy that could drift.
    checklist_codes: CHECKLIST.map(function (c) { return c.id; }),
    checklist_severity: CHECKLIST.reduce(function (acc, c) { acc[c.id] = c.sev; return acc; }, {})
  }
}];
