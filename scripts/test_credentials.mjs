/**
 * Offline test harness for CREDENTIAL_REGISTRY — step 1 of the sign-off build.
 *
 * No database, no network, no n8n. The registry is pure data and pure functions
 * precisely so the rules that decide whether a signature is legally meaningful can
 * be tested before any of the surrounding machinery exists.
 *
 * The assertions fall into three groups:
 *   1-3  the data itself, including the honesty flags
 *   4-6  §14.2 signing_authority, §14.3 expiry_semantics, §15 verification
 *   7-8  the §4 jurisdiction match, and the expiry dashboard
 *
 * Run:  node scripts/test_credentials.mjs
 */

import {
  CREDENTIAL_REGISTRY, VERIFICATION_METHODS, SIGNING_AUTHORITY, EXPIRY_SEMANTICS,
  ELIGIBILITY, EXPIRY_WARNING_DAYS, PORTABLE_JURISDICTION, NO_CREDENTIAL,
  resolveJurisdiction, assessVerification, assessSigningEligibility,
  credentialsNeedingAttention
} from '../lib/credential-registry.mjs';

let pass = 0, fail = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) { pass++; console.log('  \u2713 ' + label); }
  else {
    fail++; failures.push(label + (detail ? ' \u2014 ' + detail : ''));
    console.log('  \u2717 ' + label + (detail ? '  [' + detail + ']' : ''));
  }
}
const section = (t) => console.log('\n' + t);

// A fixed clock. Time-dependent rules tested against "now" drift into passing or
// failing with the calendar, which is how an expiry bug survives a test suite.
const NOW = new Date('2026-09-05T00:00:00Z');
const iso = (d) => d.toISOString().slice(0, 10);
const daysFromNow = (n) => iso(new Date(NOW.getTime() + n * 86400000));

const goodVerification = {
  subject_account_id: 'acct-eng-1',
  verified_by_account_id: 'acct-admin-9',
  verified_by_name: 'A. Admin',
  verified_at: daysFromNow(-30),
  method: 'CERTIFIED_COPY',
  document_ref: 'doc-123'
};

// ===========================================================================
section('1. The registry is shaped as the design requires');
{
  check('Florida is present and seeded as verified',
    CREDENTIAL_REGISTRY.FL && CREDENTIAL_REGISTRY.FL.requires_confirmation === false);
  check('Florida records a verified_on date', typeof CREDENTIAL_REGISTRY.FL.verified_on === 'string');
  check('IN-MH is present', CREDENTIAL_REGISTRY['IN-MH'] !== undefined);
  check('IN-MH is a STUB, not asserted as verified',
    CREDENTIAL_REGISTRY['IN-MH'].requires_confirmation === true &&
    CREDENTIAL_REGISTRY['IN-MH'].verified_on === null);

  // The jurisdiction vocabulary must match CODE_BASIS_REGISTRY or §4's check
  // needs a translation layer, which is the thing §3 exists to avoid.
  ['FL', 'CA', 'TX', 'NY', 'NY-NYC', 'MA', 'WA', 'IL-CHICAGO', 'US-DEFAULT'].forEach((k) => {
    check('jurisdiction key ' + k + ' exists, matching CODE_BASIS_REGISTRY', CREDENTIAL_REGISTRY[k] !== undefined);
  });
  check('the two sentinels from \u00a73 exist',
    CREDENTIAL_REGISTRY[PORTABLE_JURISDICTION] !== undefined && CREDENTIAL_REGISTRY[NO_CREDENTIAL] !== undefined);
}

// ===========================================================================
section('2. The honesty rule holds — nothing is fabricated');
{
  const verified = Object.keys(CREDENTIAL_REGISTRY)
    .filter((k) => CREDENTIAL_REGISTRY[k].requires_confirmation === false);
  check('exactly two entries are non-stub: FL and the NONE sentinel',
    verified.length === 2 && verified.includes('FL') && verified.includes('NONE'), verified.join(','));

  // Every stub must be unusable as the basis of a field-verification claim.
  Object.keys(CREDENTIAL_REGISTRY).forEach((k) => {
    const e = CREDENTIAL_REGISTRY[k];
    if (e.requires_confirmation === true) {
      check(k + ' is a stub and carries no verified_on date', e.verified_on === null);
    }
  });

  // "We have not checked" must not be encoded as "no".
  check('FL accepts_portable is null (unchecked), not false (a decision)',
    CREDENTIAL_REGISTRY.FL.accepts_portable === null);
  check('unconfirmed renewal intervals are null, never a plausible guess',
    CREDENTIAL_REGISTRY.FL.individual_types.FIRESAFETY_INSPECTOR.renewal_interval_months === null &&
    CREDENTIAL_REGISTRY['IN-MH'].firm_licence.renewal_interval_months === null);
  check('Form B prescribed wording is explicitly NOT obtained (\u00a714.5)',
    CREDENTIAL_REGISTRY['IN-MH'].statutory_artefact.prescribed_wording_obtained === false);
}

// ===========================================================================
section('3. \u00a714.2 — signing_authority is declared, and the two models differ');
{
  check('Florida licenses the INDIVIDUAL',
    CREDENTIAL_REGISTRY.FL.signing_authority === SIGNING_AUTHORITY.INDIVIDUAL);
  check('Maharashtra licenses the FIRM',
    CREDENTIAL_REGISTRY['IN-MH'].signing_authority === SIGNING_AUTHORITY.FIRM);
  check('Florida still requires the dealer permit as an accompaniment',
    CREDENTIAL_REGISTRY.FL.firm_licence.required_for_field_verify === true);
  check('Maharashtra records the Licensed Agency licence as the firm instrument',
    /Licensed Agency/.test(CREDENTIAL_REGISTRY['IN-MH'].firm_licence.label));
  // The guess this registry exists to avoid.
  check('an unresearched state does NOT assume INDIVIDUAL',
    CREDENTIAL_REGISTRY.WA.signing_authority === null);
}

// ===========================================================================
section('4. \u00a714.3 — PERPETUAL and UNKNOWN are not the same thing');
{
  const mh = CREDENTIAL_REGISTRY['IN-MH'].individual_types;
  check('an Indian fire engineering degree is PERPETUAL',
    mh.FIRE_ENGINEER_DEGREE.expiry_semantics === EXPIRY_SEMANTICS.PERPETUAL);
  check('NFSC Nagpur is PERPETUAL',
    mh.NFSC_NAGPUR.expiry_semantics === EXPIRY_SEMANTICS.PERPETUAL);
  // Professional-body membership plausibly renews; unconfirmed means UNKNOWN,
  // not a guess in either direction.
  check('IFE India membership is UNKNOWN, not assumed perpetual',
    mh.IFE_INDIA.expiry_semantics === EXPIRY_SEMANTICS.UNKNOWN);
  check('Florida credentials EXPIRE',
    CREDENTIAL_REGISTRY.FL.individual_types.FIRESAFETY_INSPECTOR.expiry_semantics === EXPIRY_SEMANTICS.EXPIRES);
  check('the Maharashtra FIRM licence expires, so \u00a75 relocates onto the firm',
    CREDENTIAL_REGISTRY['IN-MH'].firm_licence.expiry_semantics === EXPIRY_SEMANTICS.EXPIRES);
}

// ===========================================================================
section('5. \u00a715 — a verification is an attestation, not a boolean');
{
  const mh = CREDENTIAL_REGISTRY['IN-MH'];

  check('absent verification fails, so nothing is verified by omission',
    assessVerification(null, mh, NOW).reason === 'VERIFICATION_ABSENT');
  check('a verification with no named verifier is rejected',
    assessVerification({ ...goodVerification, verified_by_name: '' }, mh, NOW).reason === 'VERIFIER_UNATTRIBUTED');
  check('a verification with no timestamp is rejected',
    assessVerification({ ...goodVerification, verified_at: null }, mh, NOW).reason === 'VERIFICATION_UNDATED');

  // Separation of duties: without this the control is theatre.
  check('a holder cannot verify their own credential',
    assessVerification({ ...goodVerification, verified_by_account_id: 'acct-eng-1' }, mh, NOW).reason === 'SELF_VERIFIED');

  check('SELF_DECLARED is not verification',
    assessVerification({ ...goodVerification, method: 'SELF_DECLARED' }, mh, NOW).reason === 'NOT_A_VERIFICATION');
  check('SELF_DECLARED is flagged as not-a-verification in the method table',
    VERIFICATION_METHODS.SELF_DECLARED.is_verification === false);

  // Maharashtra sets a higher floor than Florida, because there the verification
  // is doing the work an expiry date would otherwise do.
  check('a scan is too weak for IN-MH, which requires a certified copy',
    assessVerification({ ...goodVerification, method: 'SCANNED_COPY' }, mh, NOW).reason === 'VERIFICATION_TOO_WEAK');
  check('the same scan IS sufficient for Florida, whose floor is lower',
    assessVerification({ ...goodVerification, method: 'SCANNED_COPY' }, CREDENTIAL_REGISTRY.FL, NOW).ok === true);
  check('a primary-source register check is always sufficient',
    assessVerification({ ...goodVerification, method: 'PRIMARY_SOURCE_REGISTER' }, mh, NOW).ok === true);

  // THE POINT of §15: the credential does not expire, but the verification does.
  const stale = assessVerification(
    { ...goodVerification, verified_at: daysFromNow(-40 * 30) }, mh, NOW);
  check('a verification older than the review window goes STALE',
    stale.ok === false && stale.reason === 'VERIFICATION_STALE', stale.reason);
  check('a stale verification reports when review was due',
    typeof stale.detail === 'string' && /review was due/.test(stale.detail));
  const fresh = assessVerification(goodVerification, mh, NOW);
  check('a current verification reports its next review date',
    fresh.ok === true && typeof fresh.review_due_at === 'string', fresh.review_due_at);
}

// ===========================================================================
section('6. Eligibility — \u00a75 blocks, and PERPETUAL is gated on verification');
{
  const flClaim = {
    audit_jurisdiction: 'FL', credential_jurisdiction: 'FL',
    credential_type: 'FIRE_EQUIPMENT_TECHNICIAN',
    credential_expiry: daysFromNow(400),
    firm: { licence_no: 'DEALER-1', expiry: daysFromNow(400) }
  };

  check('a current Florida technician with a current dealer permit may field verify',
    assessSigningEligibility(flClaim, NOW).eligibility === ELIGIBILITY.FIELD_VERIFIED,
    JSON.stringify(assessSigningEligibility(flClaim, NOW)));

  // The single most valuable control in the design.
  const expired = assessSigningEligibility({ ...flClaim, credential_expiry: daysFromNow(-1) }, NOW);
  check('an expired credential is BLOCKED, not downgraded to desk review',
    expired.eligibility === ELIGIBILITY.BLOCKED && expired.reason === 'CREDENTIAL_EXPIRED', expired.reason);
  check('the block states the expiry date', /2026|2025/.test(expired.detail));

  const warn = assessSigningEligibility({ ...flClaim, credential_expiry: daysFromNow(10) }, NOW);
  check('expiring within the notice window warns but still permits',
    warn.eligibility === ELIGIBILITY.FIELD_VERIFIED && warn.notes.some((n) => /expires in 10 day/.test(n)),
    JSON.stringify(warn.notes));
  check('the notice window is the \u00a75 value', EXPIRY_WARNING_DAYS === 30);

  // §14.2: the firm is load-bearing in Florida too, as an accompaniment.
  const noFirm = assessSigningEligibility({ ...flClaim, firm: null }, NOW);
  check('a Florida signature without a dealer permit falls back to desk review',
    noFirm.eligibility === ELIGIBILITY.DESK_REVIEW && noFirm.reason === 'FIRM_LICENCE_ACCOMPANIMENT_MISSING',
    noFirm.reason);
  const firmExpired = assessSigningEligibility(
    { ...flClaim, firm: { licence_no: 'DEALER-1', expiry: daysFromNow(-5) } }, NOW);
  check('an expired dealer permit BLOCKS, like an expired individual permit',
    firmExpired.eligibility === ELIGIBILITY.BLOCKED && firmExpired.reason === 'FIRM_LICENCE_EXPIRED', firmExpired.reason);

  // The India path. IN-MH is a stub, so it must NOT yield field verification yet —
  // but it must fail for the right reason, proving the FIRM path is exercised.
  const mhClaim = {
    audit_jurisdiction: 'IN-MH', credential_jurisdiction: 'IN-MH',
    credential_type: 'FIRE_ENGINEER_DEGREE',
    credential_expiry: null,
    verification: goodVerification,
    firm: { licence_no: 'MH-AGENCY-77', expiry: daysFromNow(200) }
  };
  const mh = assessSigningEligibility(mhClaim, NOW);
  check('a Maharashtra claim is withheld because the jurisdiction is an unconfirmed stub',
    mh.eligibility === ELIGIBILITY.DESK_REVIEW && mh.reason === 'JURISDICTION_UNCONFIRMED', mh.reason);
  check('it got far enough to accept the perpetual credential on verification',
    mh.notes.some((n) => /Non-expiring credential; verification reviewed/.test(n)), JSON.stringify(mh.notes));

  // With no verification, a PERPETUAL credential must not sail through.
  const mhNoVer = assessSigningEligibility({ ...mhClaim, verification: null }, NOW);
  check('a perpetual credential with NO verification is refused field verification',
    mhNoVer.eligibility === ELIGIBILITY.DESK_REVIEW &&
    /^PERPETUAL_VERIFICATION_/.test(mhNoVer.reason), mhNoVer.reason);
  check('and the refusal explains that verification replaces the expiry date',
    /requires a current verification instead of an expiry date/.test(mhNoVer.detail));

  // The FIRM instrument is mandatory where the firm is the licensed party.
  const mhNoFirm = assessSigningEligibility({ ...mhClaim, firm: null }, NOW);
  check('a Maharashtra claim without an Agency licence is refused as FIRM_LICENCE_REQUIRED',
    mhNoFirm.reason === 'FIRM_LICENCE_REQUIRED', mhNoFirm.reason);
  check('the refusal names the firm as the operative instrument',
    /operative instrument/.test(mhNoFirm.detail));

  // UNKNOWN semantics are conservative.
  const ife = assessSigningEligibility({ ...mhClaim, credential_type: 'IFE_INDIA' }, NOW);
  check('an UNKNOWN-expiry credential yields desk review only',
    ife.eligibility === ELIGIBILITY.DESK_REVIEW && ife.reason === 'EXPIRY_SEMANTICS_UNKNOWN', ife.reason);
}

// ===========================================================================
section('7. \u00a74 — the jurisdiction match, and the sentence it prints');
{
  const cross = assessSigningEligibility({
    audit_jurisdiction: 'FL', credential_jurisdiction: 'CA',
    credential_type: 'FIRESAFETY_INSPECTOR', credential_expiry: daysFromNow(400)
  }, NOW);
  check('a CA credential against an FL audit does not field verify',
    cross.eligibility === ELIGIBILITY.DESK_REVIEW, cross.reason);

  const flAudit = assessSigningEligibility({
    audit_jurisdiction: 'CA', credential_jurisdiction: 'FL',
    credential_type: 'FIRE_EQUIPMENT_TECHNICIAN', credential_expiry: daysFromNow(400),
    firm: { licence_no: 'D-1', expiry: daysFromNow(400) }
  }, NOW);
  check('an FL credential against a CA audit is a JURISDICTION_MISMATCH',
    flAudit.reason === 'JURISDICTION_MISMATCH', flAudit.reason);
  check('the mismatch produces the printable \u00a74 sentence',
    /This audit was judged under/.test(flAudit.detail) &&
    /Field verification is unavailable; recorded as desk review/.test(flAudit.detail), flAudit.detail);

  // A portable certification never self-grants; the target jurisdiction decides.
  const nicet = assessSigningEligibility({
    audit_jurisdiction: 'FL', credential_jurisdiction: PORTABLE_JURISDICTION,
    credential_type: 'NICET_III', credential_expiry: daysFromNow(400)
  }, NOW);
  check('a portable certification does not self-grant field verification',
    nicet.eligibility === ELIGIBILITY.DESK_REVIEW, nicet.reason);

  const none = assessSigningEligibility({
    audit_jurisdiction: 'FL', credential_jurisdiction: NO_CREDENTIAL, credential_type: 'ANY'
  }, NOW);
  check('no credential still permits desk review, which is a real service',
    none.eligibility === ELIGIBILITY.DESK_REVIEW && none.reason === 'NO_CREDENTIAL', none.reason);
  check('desk review is never blocked outright for lack of a licence',
    none.eligibility !== ELIGIBILITY.BLOCKED);
}

// ===========================================================================
section('8. The expiry dashboard \u00a74 says clients will pay for');
{
  const rows = [
    { id: 1, credential_jurisdiction: 'FL', credential_type: 'FIRE_EQUIPMENT_TECHNICIAN', credential_expiry: daysFromNow(-3) },
    { id: 2, credential_jurisdiction: 'FL', credential_type: 'FIRE_EQUIPMENT_TECHNICIAN', credential_expiry: daysFromNow(12) },
    { id: 3, credential_jurisdiction: 'FL', credential_type: 'FIRE_EQUIPMENT_TECHNICIAN', credential_expiry: daysFromNow(900) },
    { id: 4, credential_jurisdiction: 'IN-MH', credential_type: 'FIRE_ENGINEER_DEGREE', verification: { ...goodVerification, verified_at: daysFromNow(-40 * 30) } }
  ];
  const flagged = credentialsNeedingAttention(rows, NOW);
  const ids = flagged.map((f) => f.id);
  check('an expired credential is flagged', ids.includes(1));
  check('a credential expiring inside the window is flagged', ids.includes(2));
  check('a credential expiring in 900 days is NOT flagged', !ids.includes(3));
  check('a PERPETUAL credential with a stale verification is flagged too', ids.includes(4));
  check('worst-first ordering: the expired one sorts before the expiring one',
    ids.indexOf(1) < ids.indexOf(2), ids.join(','));
  check('the perpetual/stale row reports its verification reason',
    (flagged.find((f) => f.id === 4) || {}).kind === 'VERIFICATION_VERIFICATION_STALE',
    (flagged.find((f) => f.id === 4) || {}).kind);
}

// ===========================================================================
section('9. Nothing here touches a database, a network, or n8n');
{
  const src = (await import('node:fs')).readFileSync(
    new URL('../lib/credential-registry.mjs', import.meta.url), 'utf8');
  check('no fetch / http in the registry', !/\bfetch\s*\(|require\(['"]https?/.test(src));
  check('no SQL in the registry', !/\bSELECT\b|\bINSERT\b|\bUPDATE\b/i.test(src));
  check('no n8n globals in the registry', !/\$input|\$\(['"]/.test(src));
  check('the registry is data plus pure functions only',
    /export const CREDENTIAL_REGISTRY/.test(src) && /export function assessSigningEligibility/.test(src));
}

console.log('\n' + '='.repeat(64));
console.log('PASS: ' + pass + '   FAIL: ' + fail);
if (fail) { console.log('\nFAILURES'); failures.forEach((f) => console.log('  - ' + f)); }
console.log('='.repeat(64));
process.exit(fail === 0 ? 0 : 1);
