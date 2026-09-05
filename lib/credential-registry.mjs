/**
 * CREDENTIAL_REGISTRY — step 1 of the sign-off build order.
 *
 * See docs/SIGNOFF_DESIGN.md §3 (jurisdiction-scoped credentials), §5 (expiry as
 * the central control), §14.2 (signing_authority), §14.3 (expiry_semantics) and
 * §15 (verification provenance).
 *
 * Pure data plus pure functions. No schema, no database, no network, no UI. This
 * is deliberately the first thing built: it is the piece §3 and §4 depend on, it
 * is independently reviewable by someone who does not read code, and it is the
 * cheapest thing to get wrong now rather than after signatures exist.
 *
 * ---------------------------------------------------------------------------
 * WHY .mjs AND NOT .ts
 * ---------------------------------------------------------------------------
 * Two consumers in two runtimes: the Next app (credential management, the expiry
 * dashboard) and, later, the n8n sign-off workflow. package.json has no
 * "type": "module", so a .js file with ESM exports would be read as CommonJS by
 * Node and fail; .mjs is unambiguous, is importable directly by the offline test
 * harness, and is resolved by TypeScript under allowJs + moduleResolution
 * bundler. Types are expressed in JSDoc rather than lost.
 *
 * The n8n copy is NOT generated yet. It is needed at step 6 (the
 * jurisdiction-match check), and building a codegen pipeline for a consumer that
 * does not exist would be speculative. When it is needed, generate the node from
 * this file and add a `--check`, exactly as the workflow artifacts do — do not
 * hand-copy it. A second hand-maintained copy of licensing data is the same class
 * of divergence that renaming a node in the n8n UI produced.
 *
 * ---------------------------------------------------------------------------
 * THE HONESTY RULE — READ BEFORE ADDING A JURISDICTION
 * ---------------------------------------------------------------------------
 * Only Florida is seeded as verified, because Florida is the target market and its
 * statute has been read. Everything else is a stub carrying
 * `requires_confirmation: true`.
 *
 * This mirrors CODE_BASIS_REGISTRY, where only NFPA 10 (2022) carries
 * `edition_verified: true` and every other edition is surfaced to a reviewer
 * rather than silently asserted.
 *
 * Fabricating a state's licensing rules to make this table look complete would be
 * the single most dangerous thing in this repository. A wrong expiry rule does not
 * fail loudly — it permits a signature that should have been blocked. If a fact is
 * not confirmed against a primary source, encode it as `null` plus
 * `requires_confirmation: true`; never as a plausible guess.
 */

// ---------------------------------------------------------------------------
// Sentinel jurisdictions, per SIGNOFF_DESIGN §3.
// ---------------------------------------------------------------------------
export const PORTABLE_JURISDICTION = 'US-NICET';
export const NO_CREDENTIAL = 'NONE';

/**
 * Who the licensed party is. §14.2.
 *
 * Florida and Maharashtra genuinely disagree, and this is not a difference that
 * more fields can absorb:
 *
 *   INDIVIDUAL  the person holds the operative instrument; the firm's permit is a
 *               required accompaniment that qualifies its scope. Florida.
 *   FIRM        the organisation holds the operative instrument; the signing
 *               individual's standing is a qualification that accompanies it.
 *               Maharashtra, where the Licensed Agency is the licensed entity.
 *
 * Getting this wrong is directionally harmful, not merely untidy. Forcing a FIRM
 * jurisdiction into the INDIVIDUAL model attributes statutory responsibility to a
 * person the statute does not license.
 */
export const SIGNING_AUTHORITY = {
  INDIVIDUAL: 'INDIVIDUAL',
  FIRM: 'FIRM'
};

/**
 * What "expires" means for a credential. §14.3.
 *
 *   EXPIRES    has a renewal date. §5 applies in full: blocked when expired,
 *              warned within the notice window.
 *   PERPETUAL  genuinely does not expire — a B.E. in Fire Engineering does not
 *              lapse, nor does an NFSC Nagpur qualification. The expiry check
 *              cannot apply, so it is REPLACED by a verification review date
 *              (§15), not dropped.
 *   UNKNOWN    no expiry has been recorded. An honest state, and the conservative
 *              one: desk review only.
 *
 * PERPETUAL and UNKNOWN are opposite epistemic states and conflating them is what
 * would have excluded every Indian engineer from field verification.
 */
export const EXPIRY_SEMANTICS = {
  EXPIRES: 'EXPIRES',
  PERPETUAL: 'PERPETUAL',
  UNKNOWN: 'UNKNOWN'
};

/**
 * How a credential was verified, weakest to strongest. §15.
 *
 * `rank` exists so a jurisdiction can declare a minimum rather than enumerate
 * every acceptable method, and so a future stricter jurisdiction does not require
 * editing the ones already confirmed.
 *
 * SELF_DECLARED is present precisely so it can be rejected. It is not a weak form
 * of verification; it is the absence of verification, and it must never satisfy a
 * sufficiency test. Recording it explicitly is more honest than leaving the field
 * empty, because "nobody has checked this" is a fact worth storing.
 */
export const VERIFICATION_METHODS = {
  SELF_DECLARED: { rank: 0, label: 'Self-declared by the holder; nobody has checked it', is_verification: false },
  SCANNED_COPY: { rank: 1, label: 'A scan or photograph of the document was reviewed', is_verification: true },
  CERTIFIED_COPY: { rank: 2, label: 'An attested or notarised copy was reviewed', is_verification: true },
  ORIGINAL_DOCUMENT_SEEN: { rank: 3, label: 'The original document was physically inspected', is_verification: true },
  PRIMARY_SOURCE_REGISTER: { rank: 4, label: "Confirmed against the issuing authority's own register or portal", is_verification: true }
};

/** Outcomes of an eligibility assessment. Mirrors SIGNOFF_DESIGN §1 and §5. */
export const ELIGIBILITY = {
  FIELD_VERIFIED: 'FIELD_VERIFIED',
  DESK_REVIEW: 'DESK_REVIEW',
  BLOCKED: 'BLOCKED'
};

/** §5: signing is allowed but warned inside this window. */
export const EXPIRY_WARNING_DAYS = 30;

// ---------------------------------------------------------------------------
// THE REGISTRY
//
// Jurisdiction keys are deliberately the SAME keys as CODE_BASIS_REGISTRY in
// scripts/nodes/02_resolve_code_basis.js — FL, CA, TX, NY, NY-NYC, MA, WA,
// IL-CHICAGO, US-DEFAULT — plus the two sentinels and IN-MH. One vocabulary
// across code basis and credentials is what makes §4's jurisdiction-match check
// possible without translation.
// ---------------------------------------------------------------------------
export const CREDENTIAL_REGISTRY = {
  // -------------------------------------------------------------- verified
  FL: {
    label: 'Florida',
    authority: 'Florida State Fire Marshal (Division of State Fire Marshal)',
    signing_authority: SIGNING_AUTHORITY.INDIVIDUAL,
    individual_types: {
      FIRESAFETY_INSPECTOR: {
        label: 'Firesafety inspector certification',
        basis: 's. 633.216, Florida Statutes',
        expiry_semantics: EXPIRY_SEMANTICS.EXPIRES,
        renewal_interval_months: null,
        field_verify: true,
        scope_note: 'Statutory firesafety inspections may only be performed by a certified firesafety inspector.',
        requires_confirmation: true
      },
      FIRE_EQUIPMENT_TECHNICIAN: {
        label: 'Fire equipment technician permit',
        basis: 'Chapter 633 Part V, Florida Statutes',
        expiry_semantics: EXPIRY_SEMANTICS.EXPIRES,
        renewal_interval_months: null,
        field_verify: true,
        scope_note: 'Field verification is limited to the permit class held.',
        requires_confirmation: true
      }
    },
    // Florida licenses the dealer as well as the individual. Under
    // signing_authority INDIVIDUAL this is the required accompaniment: a
    // technician's signature on a kitchen suppression system means little if the
    // company holds no permit covering that equipment.
    firm_licence: {
      label: 'Fire equipment dealer permit',
      basis: 'Chapter 633 Part V, Florida Statutes',
      classes: ['A', 'B', 'C', 'D'],
      class_note: 'Class scopes by equipment type. Which class covers which equipment is NOT confirmed here.',
      expiry_semantics: EXPIRY_SEMANTICS.EXPIRES,
      renewal_interval_months: null,
      required_for_field_verify: true,
      requires_confirmation: true
    },
    // Whether Florida recognises NICET for any statutory purpose is UNVERIFIED.
    // Carried forward from SIGNOFF_DESIGN §3, where it is flagged as unverified.
    // Encoded as null rather than false: "we have not checked" is not "no".
    accepts_portable: null,
    minimum_verification_rank: VERIFICATION_METHODS.SCANNED_COPY.rank,
    verification_review_months: 12,
    verified_on: '2026-09-05',
    requires_confirmation: false,
    notes:
      'Seeded as verified because Florida is the target market and its statute has been read. ' +
      'Statute references are confirmed; renewal intervals and dealer class-to-equipment mappings are NOT ' +
      'and each carries requires_confirmation: true at the level it appears.'
  },

  // ------------------------------------------------------------ India stub
  // The reason IN-MH exists at this stage rather than later: it is the entry that
  // PROVES the two-authority model actually holds, before anything depends on it.
  // A registry that only ever describes INDIVIDUAL jurisdictions would let the
  // FIRM path rot untested until the first Indian customer.
  'IN-MH': {
    label: 'Maharashtra, India',
    authority: 'Director, Maharashtra Fire Services (licensing) / Chief Fire Officer of the Municipal Corporation (AHJ)',
    signing_authority: SIGNING_AUTHORITY.FIRM,
    statute: 'Maharashtra Fire Prevention and Life Safety Measures Act 2006, with the Rules 2009',
    statutory_artefact: {
      name: 'Form B',
      description: 'Fire safety compliance certificate',
      cadence: 'HALF_YEARLY',
      periods: ['H1', 'H2'],
      period_months: { H1: [1, 6], H2: [7, 12] },
      filed_in: ['January', 'July'],
      // §14.5: the wording of Form B is PRESCRIBED by the Rules. It is not ours to
      // compose. Until the prescribed text is obtained from a primary source, the
      // product produces the evidence pack and stops short of rendering the form.
      prescribed_wording_obtained: false
    },
    // The Licensed Agency is the licensed entity. This is the operative
    // instrument, and it is the one the expiry control reads for this
    // jurisdiction — see §14.3: for FIRM jurisdictions §5 relocates onto the firm.
    firm_licence: {
      label: 'Licensed Agency licence',
      basis: 'Licensed by the Director of Maharashtra Fire Services, in categories by scope of work',
      classes: null,
      class_note: 'Categories are by scope of work. The category list is NOT confirmed here.',
      expiry_semantics: EXPIRY_SEMANTICS.EXPIRES,
      renewal_interval_months: null,
      required_for_field_verify: true,
      requires_confirmation: true
    },
    // The signing engineer's standing is a QUALIFICATION, not a numbered personal
    // licence. These do not expire, which is exactly why EXPIRY_SEMANTICS has a
    // PERPETUAL value and why §15's verification review date exists.
    individual_types: {
      FIRE_ENGINEER_DEGREE: {
        label: 'B.E. or Diploma in Fire Engineering',
        basis: 'Academic qualification',
        expiry_semantics: EXPIRY_SEMANTICS.PERPETUAL,
        renewal_interval_months: null,
        field_verify: true,
        scope_note: 'Accompanies the Licensed Agency licence; it is not itself a licence to certify.',
        requires_confirmation: true
      },
      NFSC_NAGPUR: {
        label: 'National Fire Service College, Nagpur qualification',
        basis: 'Institutional qualification',
        expiry_semantics: EXPIRY_SEMANTICS.PERPETUAL,
        renewal_interval_months: null,
        field_verify: true,
        scope_note: 'Accompanies the Licensed Agency licence.',
        requires_confirmation: true
      },
      IFE_INDIA: {
        label: 'Institution of Fire Engineers (India) membership',
        basis: 'Professional body membership',
        // Membership in a professional body typically requires renewal, unlike a
        // degree. NOT confirmed, so UNKNOWN rather than a guess in either
        // direction — and UNKNOWN is the conservative outcome.
        expiry_semantics: EXPIRY_SEMANTICS.UNKNOWN,
        renewal_interval_months: null,
        field_verify: true,
        scope_note: 'Accompanies the Licensed Agency licence.',
        requires_confirmation: true
      }
    },
    accepts_portable: false,
    // A stronger floor than Florida: a scan is not enough to establish a
    // qualification that never expires, because the verification is doing the work
    // the expiry date would otherwise do.
    minimum_verification_rank: VERIFICATION_METHODS.CERTIFIED_COPY.rank,
    verification_review_months: 24,
    verified_on: null,
    requires_confirmation: true,
    notes:
      'STUB. The Act, the Rules, the Licensed Agency concept, Form B and its half-yearly cadence are ' +
      'recorded from research (IND_FIRE_AUDIT_WORKFLOW.md §7.9) and still need confirming against a ' +
      'primary source. Licence categories, renewal intervals and the prescribed Form B wording are ' +
      'all unconfirmed. Do not present Form B output to a customer on this basis.'
  },

  // --------------------------------------------------------- portable certs
  'US-NICET': {
    label: 'NICET (portable across states)',
    authority: 'National Institute for Certification in Engineering Technologies',
    signing_authority: SIGNING_AUTHORITY.INDIVIDUAL,
    portable: true,
    individual_types: {
      NICET_II: { label: 'NICET Level II', basis: 'By subfield', expiry_semantics: EXPIRY_SEMANTICS.UNKNOWN, renewal_interval_months: null, field_verify: false, scope_note: 'Field verification only where the jurisdiction records that it accepts NICET.', requires_confirmation: true },
      NICET_III: { label: 'NICET Level III', basis: 'By subfield', expiry_semantics: EXPIRY_SEMANTICS.UNKNOWN, renewal_interval_months: null, field_verify: false, scope_note: 'Field verification only where the jurisdiction records that it accepts NICET.', requires_confirmation: true },
      NICET_IV: { label: 'NICET Level IV', basis: 'By subfield', expiry_semantics: EXPIRY_SEMANTICS.UNKNOWN, renewal_interval_months: null, field_verify: false, scope_note: 'Field verification only where the jurisdiction records that it accepts NICET.', requires_confirmation: true }
    },
    firm_licence: null,
    accepts_portable: null,
    minimum_verification_rank: VERIFICATION_METHODS.SCANNED_COPY.rank,
    verification_review_months: 12,
    verified_on: null,
    requires_confirmation: true,
    notes:
      'STUB. NICET recertification requirements are NOT confirmed, hence UNKNOWN expiry semantics, which ' +
      'yields desk review only until confirmed. A portable certification never grants field verification ' +
      'on its own — the target jurisdiction must record that it accepts it (accepts_portable).'
  },

  // ------------------------------------------------------------- no credential
  // An honest state, not an error. Recorded so a desk review by an uncredentialed
  // reviewer is representable rather than requiring a fake credential.
  NONE: {
    label: 'No credential recorded',
    authority: null,
    signing_authority: null,
    individual_types: {},
    firm_licence: null,
    accepts_portable: false,
    minimum_verification_rank: null,
    verification_review_months: null,
    verified_on: '2026-09-05',
    requires_confirmation: false,
    notes: 'Desk review only, by construction. A desk review is a real, sellable service and does not require a licence.'
  }
};

/**
 * States named in SIGNOFF_DESIGN §3 and present in CODE_BASIS_REGISTRY, seeded as
 * stubs so the key vocabulary stays aligned across the two registries.
 *
 * Each is a placeholder recording WHO licenses and nothing more, because that much
 * is stated in SIGNOFF_DESIGN §3. Credential types, expiry rules and firm licence
 * shapes are absent rather than invented, and every one is
 * requires_confirmation: true, so §4's check degrades to desk review rather than
 * asserting an eligibility it cannot justify.
 */
const STATE_STUBS = {
  CA: 'Office of the State Fire Marshal (OSFM) licenses extinguisher servicing companies and technicians under Title 19 CCR; CSLB issues the C-16 fire protection contractor licence',
  TX: "Texas Department of Insurance, State Fire Marshal's Office licenses extinguisher and alarm contractors and individual technicians",
  'NY-NYC': 'FDNY Certificate of Fitness — a distinct instrument, not a state licence',
  NY: 'New York State — licensing arrangement not researched',
  MA: 'Department of Fire Services, under 527 CMR',
  WA: 'Washington — licensing arrangement not researched',
  'IL-CHICAGO': 'Chicago — licensing arrangement not researched',
  'US-DEFAULT': 'No state-specific credential rules resolved; the local AHJ governs'
};

for (const [key, authority] of Object.entries(STATE_STUBS)) {
  CREDENTIAL_REGISTRY[key] = {
    label: key,
    authority: authority,
    // Unknown, deliberately. Assuming INDIVIDUAL because most US states work that
    // way is exactly the guess this registry exists to avoid.
    signing_authority: null,
    individual_types: {},
    firm_licence: null,
    accepts_portable: null,
    minimum_verification_rank: null,
    verification_review_months: null,
    verified_on: null,
    requires_confirmation: true,
    notes: 'STUB. Seeded to keep the jurisdiction vocabulary aligned with CODE_BASIS_REGISTRY. ' +
           'Confirming a state is a registry edit, not a schema change.'
  };
}

// ---------------------------------------------------------------------------
// PURE FUNCTIONS
// ---------------------------------------------------------------------------

/** @returns the registry entry, or the NONE entry for an unknown key. */
export function resolveJurisdiction(key) {
  const k = String(key === undefined || key === null ? '' : key).trim().toUpperCase();
  return CREDENTIAL_REGISTRY[k] || null;
}

/**
 * Is a verification record strong enough, recent enough, and properly attributed?
 * SIGNOFF_DESIGN §15.
 *
 * This is the function that answers "is evidence_on_file an unaudited boolean?".
 * It is not a boolean: a verification must name a human, carry a timestamp, state
 * a method, and — for a PERPETUAL credential — still be within its review window.
 */
export function assessVerification(verification, entry, asOf) {
  const now = asOf instanceof Date ? asOf : new Date(asOf || Date.now());

  if (!verification) {
    return { ok: false, reason: 'VERIFICATION_ABSENT', detail: 'No verification record. Nothing is verified by omission.' };
  }
  // Attributable to a person. A verification with no verifier is the unaudited
  // boolean this design set out to avoid.
  if (!verification.verified_by_name || !String(verification.verified_by_name).trim()) {
    return { ok: false, reason: 'VERIFIER_UNATTRIBUTED', detail: 'A verification must name the person who performed it.' };
  }
  if (!verification.verified_at) {
    return { ok: false, reason: 'VERIFICATION_UNDATED', detail: 'A verification must be timestamped.' };
  }
  // Separation of duties. §10 already separates administering from signing; a
  // holder verifying their own credential collapses that separation.
  if (verification.subject_account_id !== undefined &&
      verification.verified_by_account_id !== undefined &&
      verification.subject_account_id === verification.verified_by_account_id) {
    return { ok: false, reason: 'SELF_VERIFIED', detail: 'A credential holder cannot verify their own credential.' };
  }

  const method = VERIFICATION_METHODS[verification.method];
  if (!method) {
    return { ok: false, reason: 'VERIFICATION_METHOD_UNKNOWN', detail: 'Unrecognised verification method: ' + verification.method };
  }
  if (!method.is_verification) {
    return { ok: false, reason: 'NOT_A_VERIFICATION', detail: method.label };
  }
  const floor = entry && entry.minimum_verification_rank;
  if (typeof floor === 'number' && method.rank < floor) {
    return { ok: false, reason: 'VERIFICATION_TOO_WEAK', detail: 'Method rank ' + method.rank + ' is below this jurisdiction\'s minimum of ' + floor + '.' };
  }

  // The credential may not expire, but our confidence in the record does. This is
  // what stops PERPETUAL becoming a permanent free pass.
  const months = entry && entry.verification_review_months;
  if (typeof months === 'number') {
    const verifiedAt = new Date(verification.verified_at);
    const due = new Date(verifiedAt.getTime());
    due.setMonth(due.getMonth() + months);
    if (now > due) {
      return {
        ok: false,
        reason: 'VERIFICATION_STALE',
        detail: 'Verified ' + verifiedAt.toISOString().slice(0, 10) + '; review was due ' + due.toISOString().slice(0, 10) + '.',
        review_due_at: due.toISOString()
      };
    }
    return { ok: true, reason: 'VERIFIED', method: verification.method, review_due_at: due.toISOString() };
  }

  return { ok: true, reason: 'VERIFIED', method: verification.method, review_due_at: null };
}

/** Whole days from `now` until `dateish`; negative when past. */
function daysUntil(dateish, now) {
  const then = new Date(dateish);
  return Math.floor((then.getTime() - now.getTime()) / 86400000);
}

/**
 * The §4 + §5 + §14.2 + §14.3 decision, in one place.
 *
 * @param {object} claim
 *   claim.audit_jurisdiction   the jurisdiction the AUDIT was judged against
 *   claim.credential_jurisdiction  where the signer's credential is from
 *   claim.credential_type      key within individual_types
 *   claim.credential_expiry    ISO date, or null
 *   claim.verification         verification record, see assessVerification
 *   claim.firm                 { licence_no, expiry, verification } or null
 * @param {Date|string} [asOf]
 */
export function assessSigningEligibility(claim, asOf) {
  const now = asOf instanceof Date ? asOf : new Date(asOf || Date.now());
  const notes = [];

  const auditEntry = resolveJurisdiction(claim.audit_jurisdiction);
  const credEntry = resolveJurisdiction(claim.credential_jurisdiction);

  const desk = (reason, detail) => ({
    eligibility: ELIGIBILITY.DESK_REVIEW, reason, detail, notes
  });
  const blocked = (reason, detail) => ({
    eligibility: ELIGIBILITY.BLOCKED, reason, detail, notes
  });

  if (!credEntry || claim.credential_jurisdiction === NO_CREDENTIAL) {
    return desk('NO_CREDENTIAL', 'No credential recorded. Desk review is still available and is a legitimate service.');
  }
  if (!auditEntry) {
    notes.push('The audit jurisdiction is not in the credential registry; treated as unresolved.');
  }

  const type = credEntry.individual_types && credEntry.individual_types[claim.credential_type];
  if (!type) {
    return desk('CREDENTIAL_TYPE_UNKNOWN',
      'Credential type "' + claim.credential_type + '" is not recorded for ' + credEntry.label + '.');
  }

  // ---- §5, applied according to §14.3's semantics --------------------------
  if (type.expiry_semantics === EXPIRY_SEMANTICS.EXPIRES) {
    if (!claim.credential_expiry) {
      return desk('EXPIRY_NOT_RECORDED', 'This credential type expires, but no expiry date is on file.');
    }
    const left = daysUntil(claim.credential_expiry, now);
    if (left < 0) {
      // The single most valuable control in the design. An audit signed under an
      // expired certificate is worse than an unsigned one: it looks valid, and
      // nobody re-checks a signature.
      return blocked('CREDENTIAL_EXPIRED',
        'Credential expired on ' + String(claim.credential_expiry).slice(0, 10) + '.');
    }
    if (left <= EXPIRY_WARNING_DAYS) {
      notes.push('Credential expires in ' + left + ' day(s) — renew now.');
    }
  } else if (type.expiry_semantics === EXPIRY_SEMANTICS.UNKNOWN) {
    return desk('EXPIRY_SEMANTICS_UNKNOWN',
      'Whether this credential expires has not been established, so field verification is withheld.');
  } else if (type.expiry_semantics === EXPIRY_SEMANTICS.PERPETUAL) {
    // §15: the expiry control does not vanish, it moves onto the verification.
    const v = assessVerification(claim.verification, credEntry, now);
    if (!v.ok) {
      return desk('PERPETUAL_VERIFICATION_' + v.reason,
        'A non-expiring credential requires a current verification instead of an expiry date. ' + v.detail);
    }
    notes.push('Non-expiring credential; verification reviewed, next review due ' + String(v.review_due_at).slice(0, 10) + '.');
  }

  // ---- §14.2: which party must hold the operative instrument ---------------
  const authority = credEntry.signing_authority;
  if (!authority) {
    return desk('SIGNING_AUTHORITY_UNKNOWN',
      'The registry does not yet record whether ' + credEntry.label + ' licenses the individual or the firm.');
  }

  const firmSpec = credEntry.firm_licence;
  const firmNeeded = authority === SIGNING_AUTHORITY.FIRM ||
    (firmSpec && firmSpec.required_for_field_verify === true);

  if (firmNeeded) {
    const firm = claim.firm;
    if (!firm || !firm.licence_no) {
      return desk(
        authority === SIGNING_AUTHORITY.FIRM ? 'FIRM_LICENCE_REQUIRED' : 'FIRM_LICENCE_ACCOMPANIMENT_MISSING',
        authority === SIGNING_AUTHORITY.FIRM
          ? credEntry.label + ' licenses the firm; a Licensed Agency licence is the operative instrument and none is recorded.'
          : credEntry.label + ' requires the firm permit to qualify an individual signature, and none is recorded.');
    }
    if (firmSpec && firmSpec.expiry_semantics === EXPIRY_SEMANTICS.EXPIRES) {
      if (!firm.expiry) {
        return desk('FIRM_EXPIRY_NOT_RECORDED', 'The firm licence expires, but no expiry date is on file.');
      }
      const firmLeft = daysUntil(firm.expiry, now);
      if (firmLeft < 0) {
        return blocked('FIRM_LICENCE_EXPIRED',
          'Firm licence expired on ' + String(firm.expiry).slice(0, 10) + '.');
      }
      if (firmLeft <= EXPIRY_WARNING_DAYS) {
        notes.push('Firm licence expires in ' + firmLeft + ' day(s).');
      }
    }
  }

  // ---- §4: is the signer credentialed where the audit was judged? ----------
  const auditKey = String(claim.audit_jurisdiction || '').trim().toUpperCase();
  const credKey = String(claim.credential_jurisdiction || '').trim().toUpperCase();

  if (credKey !== auditKey) {
    if (credEntry.portable === true) {
      if (auditEntry && auditEntry.accepts_portable === true) {
        notes.push('Portable certification accepted by ' + auditEntry.label + '.');
      } else {
        return desk('PORTABLE_NOT_ACCEPTED',
          'The signer holds a portable certification. Whether ' +
          ((auditEntry && auditEntry.label) || auditKey) +
          ' accepts it is ' + (auditEntry && auditEntry.accepts_portable === false ? 'no' : 'not recorded') +
          '; recorded as desk review.');
      }
    } else {
      // The sentence the product can print, from §4.
      return desk('JURISDICTION_MISMATCH',
        'This audit was judged under ' + ((auditEntry && auditEntry.label) || auditKey) +
        '. The signer holds a ' + credEntry.label +
        ' credential. Field verification is unavailable; recorded as desk review.');
    }
  }

  if (type.field_verify !== true) {
    return desk('TYPE_NOT_FIELD_VERIFY_CAPABLE', type.scope_note || 'This credential type does not support field verification.');
  }

  // A stub jurisdiction must never be the basis of an eligibility claim.
  if (credEntry.requires_confirmation === true) {
    return desk('JURISDICTION_UNCONFIRMED',
      credEntry.label + ' is a registry stub pending confirmation against a primary source, ' +
      'so field verification is withheld rather than asserted.');
  }

  return {
    eligibility: ELIGIBILITY.FIELD_VERIFIED,
    reason: 'ELIGIBLE',
    detail: 'Credential matches the audit jurisdiction, is current, and supports field verification.',
    notes
  };
}

/** Everything a §5 expiry dashboard needs, without a database. */
export function credentialsNeedingAttention(records, asOf) {
  const now = asOf instanceof Date ? asOf : new Date(asOf || Date.now());
  const out = [];
  for (const r of records || []) {
    const entry = resolveJurisdiction(r.credential_jurisdiction);
    const type = entry && entry.individual_types && entry.individual_types[r.credential_type];
    if (!type) continue;

    if (type.expiry_semantics === EXPIRY_SEMANTICS.EXPIRES && r.credential_expiry) {
      const left = daysUntil(r.credential_expiry, now);
      if (left < 0) out.push({ ...r, kind: 'EXPIRED', days: left });
      else if (left <= EXPIRY_WARNING_DAYS) out.push({ ...r, kind: 'EXPIRING', days: left });
    }
    if (type.expiry_semantics === EXPIRY_SEMANTICS.PERPETUAL) {
      const v = assessVerification(r.verification, entry, now);
      if (!v.ok) out.push({ ...r, kind: 'VERIFICATION_' + v.reason, days: null });
    }
  }
  return out.sort((a, b) => (a.days === null ? 1 : b.days === null ? -1 : a.days - b.days));
}
