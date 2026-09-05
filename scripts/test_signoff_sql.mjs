/**
 * Structural checks on the sign-off SQL (migration 007).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS CAN AND CANNOT DO — READ THIS BEFORE TRUSTING IT
 * ---------------------------------------------------------------------------
 * It does NOT execute SQL. No Postgres is available in the environment this repo
 * is developed in, so nothing here proves the migration runs, that the PL/pgSQL
 * compiles, or that any constraint behaves as intended.
 *
 * scripts/db/007_verify.sql does that, on the real engine, and it must be run
 * after applying 007. This file is the weaker, cheaper guard that sits alongside
 * it: it asserts that the RULES IN THE SQL still match the rules in
 * docs/SIGNOFF_DESIGN.md, which is the thing most likely to drift silently as
 * either changes.
 *
 * Being explicit about that limit matters more here than elsewhere in this repo:
 * a green run of this file is not evidence that sign-off works, and a reader who
 * assumed otherwise would be badly misled about the one table where being wrong
 * has legal consequences.
 *
 * Run:  node scripts/test_signoff_sql.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);

const MIG = readFileSync(join(REPO, 'scripts', 'db', '007_field_audit_signoffs.sql'), 'utf8');
const VER = readFileSync(join(REPO, 'scripts', 'db', '007_verify.sql'), 'utf8');
const LOCK = readFileSync(join(REPO, 'scripts', 'db', '008_record_signoff_row_lock.sql'), 'utf8');
const FN = readFileSync(join(REPO, 'scripts', 'db', 'functions', 'record_signoff.sql'), 'utf8');
const FNVER = readFileSync(join(REPO, 'scripts', 'db', 'functions', 'record_signoff_verify.sql'), 'utf8');
const ORG = readFileSync(join(REPO, 'scripts', 'db', '009_org_scoping.sql'), 'utf8');
const ORGVER = readFileSync(join(REPO, 'scripts', 'db', '009_verify.sql'), 'utf8');
const DESIGN = readFileSync(join(REPO, 'docs', 'SIGNOFF_DESIGN.md'), 'utf8');

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

// ===========================================================================
section('1. The migration is one transaction, and says what it has not proved');
{
  const begins = (MIG.match(/^BEGIN;/gm) || []).length;
  const commits = (MIG.match(/^COMMIT;/gm) || []).length;
  check('exactly one BEGIN and one COMMIT', begins === 1 && commits === 1,
    'BEGIN=' + begins + ' COMMIT=' + commits);
  // A half-applied sign-off schema is the worst outcome available: the table would
  // exist and look usable while the function enforcing every rule was missing.
  check('the function and the views are inside the transaction',
    MIG.indexOf('CREATE OR REPLACE FUNCTION record_signoff') < MIG.lastIndexOf('COMMIT;') &&
    MIG.indexOf('CREATE OR REPLACE VIEW v_signoff_current') < MIG.lastIndexOf('COMMIT;'));
  check('the migration states that its author never ran it',
    /HAS NOT BEEN RUN BY ITS AUTHOR/.test(MIG));
  check('and points at the verify script',
    /007_verify\.sql/.test(MIG));

  ['$$', '$q$'].forEach(function (tag) {
    const n = (MIG.split(tag).length - 1) + (VER.split(tag).length - 1);
    check('dollar-quote ' + tag + ' is balanced across both files', n % 2 === 0, 'count=' + n);
  });
}

// ===========================================================================
section('2. Append-only is a control, not a comment (\u00a76)');
{
  check('a trigger blocks mutation', /CREATE TRIGGER trg_fas_append_only/.test(MIG));
  check('it covers UPDATE and DELETE',
    /BEFORE UPDATE OR DELETE ON field_audit_signoffs/.test(MIG));
  check('it raises rather than silently ignoring',
    /RAISE EXCEPTION[\s\S]{0,200}append-only/.test(MIG));

  // \u00a76 proposed `superseded_by` on the old row AND declared the table never
  // updated. Both cannot hold. The amendment inverts the pointer.
  check('lineage points BACKWARDS from the new row (supersedes)',
    /supersedes\s+bigint\s+REFERENCES field_audit_signoffs/.test(MIG));
  // Comments legitimately name superseded_by when explaining why it was inverted,
  // so only executable lines count. Stripping -- comments is enough here; there are
  // no string literals in this file containing "--".
  const MIG_CODE = MIG.split('\n')
    .filter(function (l) { return l.trim().startsWith('--') === false; })
    .join('\n');
  check('no superseded_by column, which would require mutating an existing row',
    /superseded_by/.test(MIG_CODE) === false);
  check('the inversion is explained, not just done',
    /Those two cannot both hold/.test(MIG));

  check('the verify script tests UPDATE is refused',
    /cannot be UPDATEd/.test(VER));
  check('the verify script tests DELETE is refused',
    /cannot be DELETEd/.test(VER));
}

// ===========================================================================
section('3. \u00a76 transitions are enforced server-side, and fail closed');
{
  check('PENDING -> CONFIRMED is permitted',
    /v_current = 'PENDING' AND p_action = 'CONFIRMED'/.test(MIG));
  check('PENDING -> REJECTED is permitted',
    /v_current = 'PENDING' AND p_action = 'REJECTED'/.test(MIG));
  check('CONFIRMED -> SUPERSEDED is permitted',
    /v_current = 'CONFIRMED' AND p_action = 'SUPERSEDED'/.test(MIG));
  check('REJECTED -> CONFIRMED is permitted',
    /v_current = 'REJECTED' AND p_action = 'CONFIRMED'/.test(MIG));

  // The important half: anything not enumerated is refused, so a status added
  // later cannot quietly become signable.
  check('the transition list ends in a catch-all refusal',
    /ELSE[\s\S]{0,400}transition % -> % is not permitted/.test(MIG));
  check('CONFIRMED -> PENDING is never permitted anywhere',
    /p_action = 'PENDING'/.test(MIG) === false);

  check('superseding requires SUPERVISOR',
    /requires SUPERVISOR/.test(MIG) && /p_actor_role <> 'SUPERVISOR'/.test(MIG));
  check('overriding a rejection requires a reason',
    /overriding a rejection requires a reason/.test(MIG));

  // \u00a710: administering the system and attesting to an inspection are unrelated.
  check('only TECHNICIAN and SUPERVISOR may sign',
    /NOT IN \('TECHNICIAN', 'SUPERVISOR'\)/.test(MIG));
  check('the verify script proves VIEWER and ADMIN are refused',
    /a VIEWER may not sign/.test(VER) && /an ADMIN may not sign/.test(VER));
}

// ===========================================================================
section('4. \u00a714.6 atomicity — one call, both writes');
{
  const fn = MIG.slice(MIG.indexOf('CREATE OR REPLACE FUNCTION record_signoff'));
  check('the function INSERTs the history row',
    /INSERT INTO field_audit_signoffs/.test(fn));
  check('the function UPDATEs the US audit row',
    /UPDATE field_audit_us_logs[\s\S]{0,200}signoff_status = p_action/.test(fn));
  check('the function UPDATEs the India audit row',
    /UPDATE field_audit_logs[\s\S]{0,200}signoff_status = p_action/.test(fn));
  check('both writes live in the same function, so they cannot half-commit',
    fn.indexOf('INSERT INTO field_audit_signoffs') <
    fn.indexOf('UPDATE field_audit_us_logs'));
  check('the contrast with LOG_Audit\u2019s error tolerance is stated',
    /continueRegularOutput/.test(MIG));
  check('callers are told not to INSERT directly',
    /Do not INSERT into field_audit_signoffs directly/.test(MIG));
  check('and a view exists to catch it if they do',
    /v_signoff_expired_credential/.test(MIG));
}

// ===========================================================================
section('5. Snapshot, not reference (\u00a72, \u00a714.2, \u00a714.3, \u00a715)');
{
  [
    'actor_name', 'actor_email', 'credential_jurisdiction', 'credential_type',
    'credential_no', 'credential_expiry', 'credential_expiry_semantics',
    'signing_authority', 'firm_name', 'firm_licence_no', 'firm_licence_expiry',
    'verification_method', 'verified_by_name', 'verified_at',
    'verification_review_due_at', 'attestation', 'audit_jurisdiction',
    'eligibility_reason'
  ].forEach(function (col) {
    check('snapshots ' + col, new RegExp('^\\s{4}' + col + '\\s', 'm').test(MIG));
  });

  check('there is no FK into a users table (accounts live on another database)',
    /REFERENCES\s+users/.test(MIG) === false);
  check('signing_authority is constrained to the two models',
    /signing_authority IN \('INDIVIDUAL', 'FIRM'\)/.test(MIG));
  check('expiry semantics are constrained to the three states',
    /IN \('EXPIRES', 'PERPETUAL', 'UNKNOWN'\)/.test(MIG));
}

// ===========================================================================
section('6. The rules match the design document, field by field');
{
  // \u00a77's reason codes, verbatim. If either list changes, this fails.
  const CODES = ['FALSE_POSITIVE', 'WRONG_EQUIPMENT', 'IMAGE_INADEQUATE',
                 'SEVERITY_DISPUTED', 'CODE_BASIS_WRONG', 'ALREADY_REMEDIATED', 'OTHER'];
  CODES.forEach(function (c) {
    check('\u00a77 reason code ' + c + ' is in the CHECK constraint', MIG.indexOf("'" + c + "'") !== -1);
    check('\u00a77 reason code ' + c + ' is still in the design doc', DESIGN.indexOf(c) !== -1);
  });

  // \u00a715.3's method ladder.
  ['SELF_DECLARED', 'SCANNED_COPY', 'CERTIFIED_COPY',
   'ORIGINAL_DOCUMENT_SEEN', 'PRIMARY_SOURCE_REGISTER'].forEach(function (m) {
    check('\u00a715.3 method ' + m + ' is accepted as a stored value', MIG.indexOf("'" + m + "'") !== -1);
  });
  // Storing it is honest; granting field verification on it is not.
  check('SELF_DECLARED is stored but cannot support field verification',
    /SELF_DECLARED is the absence of/.test(MIG));

  check('\u00a71 both kinds of sign-off exist',
    /IN \('DESK_REVIEW', 'FIELD_VERIFIED'\)/.test(MIG));
  check('\u00a78 field verification can never be bulk, in the schema itself',
    /fas_field_verify_never_bulk/.test(MIG));
  check('\u00a78 bulk is refused on a CRITICAL finding',
    /CRITICAL finding must[\s\S]{0,80}one at a time/.test(MIG));
  check('\u00a78 bulk is refused on a suspected impairment',
    /impairment must be signed[\s\S]{0,40}one at a time/.test(MIG));
  check('a CONFIRMED without attestation wording is refused',
    /fas_confirmed_requires_attestation/.test(MIG));
  check('a REJECTED without a reason code is refused',
    /fas_rejected_requires_reason/.test(MIG));
  check('\u00a75 an expired credential blocks field verification',
    /signed under a lapsed certificate is worse/.test(MIG));
}

// ===========================================================================
section('7. Both regions, and the missing foreign key is handled');
{
  check('region is constrained to US and IND', /region IN \('US', 'IND'\)/.test(MIG));
  check('why no FK is possible is written down',
    /cannot hold a foreign key into two others/.test(MIG));
  check('existence is checked in code instead',
    /refusing[\s\S]{0,80}audit that does not exist/.test(MIG));
  // Deriving integrity from a string prefix is implicit coupling that breaks late.
  check('region is NOT inferred from the audit_id prefix',
    /NOT inferred from the audit_id prefix/.test(MIG));
  check('dynamic SQL is avoided, so there is nothing to inject',
    /EXECUTE\s+format\(/.test(MIG) === false);

  check('India gains the denormalised columns the US table has had since 001',
    /field_audit_logs ADD COLUMN IF NOT EXISTS signoff_status/.test(MIG));
  check('India\u2019s CHECK matches the US one',
    /signoff_status IN \('PENDING', 'CONFIRMED', 'REJECTED', 'SUPERSEDED'\)/.test(MIG));
  check('India gets a pending-queue view mirroring v_faus_awaiting_signoff',
    /CREATE OR REPLACE VIEW v_fal_awaiting_signoff/.test(MIG));
}

// ===========================================================================
section('8. The verify script is safe to run against production');
{
  check('it rolls back', /^ROLLBACK;/m.test(VER));
  check('it has no COMMIT', /^COMMIT;/m.test(VER) === false);
  check('scratch rows are unmistakable', /FA-VERIFY-/.test(VER));
  check('it never deletes or updates a pre-existing row outside the rollback',
    /DELETE FROM field_audit_us_logs|DROP TABLE field_audit/.test(VER) === false);
  check('it reports a machine-readable summary line', /RESULT: /.test(VER));
  check('it tells the reader how to confirm nothing was kept',
    /expect 0/.test(VER));

  // The gate must be shown to open as well as shut, or the suite only proves the
  // feature is unusable.
  check('it proves a valid desk review succeeds', /a desk review is recorded/.test(VER));
  check('it proves a valid field verification succeeds',
    /a valid field verification is accepted/.test(VER));
  check('it proves a CRITICAL audit can still be signed individually',
    /can still be signed individually/.test(VER));
}

// ===========================================================================
section('9. Migration 008 — the row lock, and 007 marked superseded');
{
  // Both reads must be locked. Locking one would leave the other region racy, and
  // India is the region heading for a statutory artefact.
  const locks = (LOCK.match(/FOR UPDATE;/g) || []).length;
  check('008 locks both audit reads', locks === 2, 'found ' + locks);
  check('008 replaces the function rather than altering the schema',
    /CREATE OR REPLACE FUNCTION record_signoff/.test(LOCK) &&
    /ALTER TABLE|CREATE TABLE/.test(LOCK) === false);
  check('008 is one transaction',
    (LOCK.match(/^BEGIN;/gm) || []).length === 1 && (LOCK.match(/^COMMIT;/gm) || []).length === 1);

  // A full-body replacement is where a guard gets silently dropped, so every rule
  // 007 shipped is re-asserted against 008's copy.
  [
    ['the section 6 catch-all refusal', /is not permitted/],
    ['the SUPERVISOR requirement', /requires SUPERVISOR/],
    ['the role gate', /may not sign/],
    ['the bulk CRITICAL guard', /one at a time/],
    ['the expired-credential guard', /lapsed certificate/],
    ['the SELF_DECLARED guard', /SELF_DECLARED is the absence of/],
    ['the FIRM licence guard', /firm licence number is required/],
    ['the stale-verification guard', /fell due for review/],
    ['the history INSERT', /INSERT INTO field_audit_signoffs/],
    ['the US audit UPDATE', /UPDATE field_audit_us_logs/],
    ['the India audit UPDATE', /UPDATE field_audit_logs/]
  ].forEach(function (pair) {
    check(pair[0] + ' survived the replacement in 008', pair[1].test(LOCK));
  });

  // The lock protects nothing if it is taken after the decision.
  check('the lock is taken before the transition check',
    LOCK.indexOf('FOR UPDATE;') < LOCK.indexOf('is not permitted'));

  check('008 explains why editing 007 in place was rejected',
    /already applied to production/.test(LOCK));
  check('008 is honest that 44 green assertions did not catch this',
    /single-session/.test(LOCK));

  check('007 marks its own function definition superseded',
    /SUPERSEDED BY MIGRATION 008/.test(MIG));
  check('007 tells the reader to apply 008',
    /008_record_signoff_row_lock\.sql/.test(MIG));

  // The deployed function, not the file on disk, is what runs.
  check('the canonical verifier inspects the DEPLOYED function, not the file',
    /pg_get_functiondef/.test(FNVER));
  check('it checks both locks are present',
    /BOTH audit reads/.test(FNVER));
  check('it re-checks the guards survived',
    /survived/.test(FNVER));
  check('it documents the two-session race procedure it cannot run',
    /TWO psql sessions/.test(FNVER) && /BLOCKS, waiting on the row lock/.test(FNVER));
  check('it is read-only apart from a rolled-back transaction',
    /^ROLLBACK;/m.test(FNVER) && /^COMMIT;/m.test(FNVER) === false);

  // Cosmetic, but a bracketed detail beside a PASS reads like a warning.
  check('both verify scripts report detail only on failure',
    /CASE WHEN COALESCE\(p_ok, FALSE\) THEN NULL ELSE p_detail END/.test(VER) &&
    /CASE WHEN COALESCE\(p_ok, FALSE\) THEN NULL ELSE p_detail END/.test(FNVER));
}

// ===========================================================================
section('10. Migration 009 \u2014 org scoping, and the canonical function home');
{
  check('all three tables gain org_id',
    /field_audit_us_logs\s+ADD COLUMN IF NOT EXISTS org_id/.test(ORG) &&
    /field_audit_logs\s+ADD COLUMN IF NOT EXISTS org_id/.test(ORG) &&
    /field_audit_signoffs\s+ADD COLUMN IF NOT EXISTS org_id/.test(ORG));
  // NOT NULL now would fail every insert until auth ships.
  check('org_id is NOT declared NOT NULL yet, and says why',
    /org_id text NOT NULL/.test(ORG) === false && /cannot be populated yet/.test(ORG));
  check('existing rows are backfilled to a visibly-internal sentinel',
    /ORG-KRATU-INTERNAL/.test(ORG));
  check('a blank org_id is refused, since it looks scoped and matches nothing',
    /org_id_not_blank/.test(ORG));
  check('org-leading indexes exist, so a scoped query is not a full scan',
    /idx_fal_org_time/.test(ORG) && /idx_faus_org_time/.test(ORG));
  check('the tenancy model is written down, not left to be rediscovered',
    /Shared database, row-level scoping by org_id/.test(ORG));
  check('the snapshot-versus-reference distinction is stated',
    /Snapshot what was[\s\S]{0,12}attested; reference what is merely scoped/.test(ORG));
  check('the never-caller-supplied rule is stated in the migration',
    /MUST NEVER BE CALLER-SUPPLIED/.test(ORG));

  // The canonical function home.
  check('there is a single canonical function definition',
    /THIS FILE IS THE CURRENT FUNCTION/.test(FN));
  check('it explains why it sits outside the numbered migrations',
    /three near-identical/.test(FN));
  check('it documents the install order',
    /INSTALL ORDER/.test(FN));
  check('it retains both row locks', (FN.match(/FOR UPDATE;/g) || []).length === 2);
  check('org_id is read from the audit row, never a parameter',
    /v_org_id/.test(FN) && /p_org_id/.test(FN) === false);
  check('org_id is written onto the signoff row',
    FN.indexOf('v_org_id,') > FN.indexOf('INSERT INTO field_audit_signoffs'));
  check('the earlier copies are both marked superseded',
    /SUPERSEDED BY MIGRATION 008/.test(MIG) &&
    /SUPERSEDED BY scripts\/db\/functions\/record_signoff\.sql/.test(LOCK));

  // Every guard must survive each full-body replacement.
  [
    ['catch-all refusal', /is not permitted/],
    ['SUPERVISOR requirement', /requires SUPERVISOR/],
    ['role gate', /may not sign/],
    ['bulk CRITICAL guard', /one at a time/],
    ['expired-credential guard', /lapsed certificate/],
    ['SELF_DECLARED guard', /SELF_DECLARED is the absence of/],
    ['FIRM licence guard', /firm licence number is required/],
    ['stale-verification guard', /fell due for review/]
  ].forEach(function (pair) {
    check('the ' + pair[0] + ' survived into the canonical file', pair[1].test(FN));
  });

  // The stale-count mistake, fixed structurally.
  check('every verify script prints a VERDICT instead of a count to match',
    /VERDICT: OK/.test(VER) && /VERDICT: OK/.test(FNVER) && /VERDICT: OK/.test(ORGVER));
  check('and the reason is recorded so it is not reintroduced',
    /stale expectation|ignore a genuine failure|how people learn to ignore/.test(VER + FNVER + ORGVER));
  check('009_verify is read-only apart from a rolled-back transaction',
    /^ROLLBACK;/m.test(ORGVER) && /^COMMIT;/m.test(ORGVER) === false);
  check('009_verify warns against adding NOT NULL prematurely',
    /Do not add NOT NULL before then/.test(ORGVER));
}

console.log('\n' + '='.repeat(64));
console.log('PASS: ' + pass + '   FAIL: ' + fail);
if (fail) { console.log('\nFAILURES'); failures.forEach((f) => console.log('  - ' + f)); }
console.log('='.repeat(64));
console.log('NOTE: this file does not execute SQL. The real tests are');
console.log('      007_verify.sql, 009_verify.sql and');
console.log('      functions/record_signoff_verify.sql, against Postgres.');
process.exit(fail === 0 ? 0 : 1);
