-- ===========================================================================
-- 007 — field_audit_signoffs: the sign-off history table (both regions)
-- ===========================================================================
--
-- Step 3 of the build order in docs/SIGNOFF_DESIGN.md §11. This is the first
-- legally meaningful write in the system: everything until now has been
-- append-by-workflow or read-only.
--
-- Read §6 (append-only), §2 (snapshot, not reference), §14.2 (signing_authority),
-- §14.3 (expiry_semantics), §15 (verification provenance) and §14.6 (atomicity)
-- before changing anything here.
--
-- ---------------------------------------------------------------------------
-- FOUR DESIGN POINTS THAT DIFFER FROM §6 AS WRITTEN
-- ---------------------------------------------------------------------------
--
-- 1. `supersedes` ON THE NEW ROW, NOT `superseded_by` ON THE OLD ONE.
--
--    §6 proposed `superseded_by bigint` as a self-reference, and also declared the
--    table append-only and "never updated". Those two cannot both hold: setting
--    superseded_by on an existing row IS an update.
--
--    Inverted here. A new row records what it supersedes, pointing backwards.
--    Nothing is ever mutated, so append-only is a property of the schema rather
--    than a promise about how callers behave. The current state of an audit is
--    computed by v_signoff_current, and the audit row's denormalised
--    signoff_status remains the fast index onto it.
--
-- 2. `region`, BECAUSE THERE IS NO FOREIGN KEY AVAILABLE.
--
--    US audits live in field_audit_us_logs (keyed on audit_id) and India audits in
--    field_audit_logs (keyed on id, with audit_id added by migration 006). One
--    table cannot hold a foreign key into two others, so referential integrity is
--    enforced by record_signoff() checking the row exists in the right table
--    before writing, and refusing if it does not.
--
--    Region is NOT inferred from the audit_id prefix. FA-US- / FA-IN- / FA-INB-
--    are conventions this repo controls today, and deriving integrity from a
--    string prefix is the kind of implicit coupling that breaks silently later.
--
-- 3. SIGNER IDENTITY IS SNAPSHOTTED, AND THERE IS DELIBERATELY NO USER TABLE FK.
--
--    Per §2 and §11: accounts live in a separate managed Postgres reachable from
--    Vercel, and the signature must remain true forever. A signature that depends
--    on joining a live user table is a signature that changes when the user record
--    changes. The snapshot is the legally correct arrangement, not a workaround
--    for the two-database split.
--
-- 4. THE WRITE IS A FUNCTION, NOT TWO STATEMENTS.
--
--    §14.6: two n8n Postgres nodes are two transactions, and a half-commit leaves
--    a CONFIRMED audit row with no history row in the table §6 calls the truth —
--    a signature that legally did not happen and visibly did. record_signoff()
--    does both writes in one call so the workflow cannot get it wrong, and it
--    enforces the §6 transition table server-side rather than trusting the UI.
--
--    Note the deliberate contrast with LOG_Audit's onError: continueRegularOutput.
--    Tolerating a failed write is right for audit logging, where losing a
--    life-safety finding is the worse outcome. It is exactly wrong here: a
--    half-recorded signature must fail loudly.
--
-- ---------------------------------------------------------------------------
-- THIS SQL HAS NOT BEEN RUN BY ITS AUTHOR
-- ---------------------------------------------------------------------------
-- No Postgres was available in the environment it was written in, so unlike the
-- JavaScript in this repo it carries no offline test run. It ships with
-- scripts/db/007_verify.sql, which exercises every transition and guard on the
-- real engine and prints PASS/FAIL per assertion inside a transaction it rolls
-- back. RUN THAT BEFORE TRUSTING THIS, and treat a failure there as expected
-- feedback rather than a surprise.
--
-- Idempotent and safe to re-run.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The history table. One row per action, never updated, never deleted.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS field_audit_signoffs (
    id                          bigserial PRIMARY KEY,

    -- Which audit, and which table it lives in. See design point 2.
    region                      text        NOT NULL,
    audit_id                    text        NOT NULL,

    action                      text        NOT NULL,
    -- §1: the central decision. A desk review is not an inspection, and a product
    -- offering one "Sign off" button prints every desk review as though it were.
    signoff_kind                text,

    -- §4: the record has to show WHY field verification was or was not available,
    -- not merely which was used. "The signer holds a California licence, the audit
    -- was judged under Florida" is the sentence a customer will ask about later.
    audit_jurisdiction          text,
    eligibility_reason          text,

    -- §14.2: which party held the operative instrument. Florida licenses the
    -- individual and Maharashtra the firm, so this cannot be assumed.
    signing_authority           text,

    -- Individual snapshot (§2).
    actor_account_id            text,
    actor_name                  text        NOT NULL,
    actor_email                 text,
    actor_role                  text,
    credential_jurisdiction     text,
    credential_type             text,
    credential_no               text,
    credential_expiry           date,
    -- §14.3: EXPIRES / PERPETUAL / UNKNOWN. Recorded because the rule applied at
    -- signing time is part of what makes the signature interpretable later.
    credential_expiry_semantics text,

    -- §15: for a PERPETUAL credential the expiry check is replaced by a
    -- verification review date, so the verification itself must be snapshotted or
    -- the substituted control leaves no trace.
    verification_method         text,
    verified_by_name            text,
    verified_at                 timestamptz,
    verification_review_due_at  timestamptz,

    -- Firm snapshot (§3, §14.2). Under signing_authority = FIRM this is the
    -- operative instrument; under INDIVIDUAL it is the required accompaniment.
    firm_name                   text,
    firm_licence_no             text,
    firm_licence_expiry         date,
    firm_licence_category       text,

    -- §12: the verbatim wording agreed to. Stored per row rather than looked up,
    -- because if the wording is ever revised, a 2026 signature must still show
    -- what its signer actually agreed to.
    attestation                 text,

    -- §7: rejection is a first-class outcome and the code is what makes it
    -- queryable. Aggregated rejections are the only honest accuracy feedback loop
    -- this product has.
    reason_code                 text,
    notes                       text,

    -- Design point 1: backwards-pointing lineage keeps the table append-only.
    supersedes                  bigint      REFERENCES field_audit_signoffs (id),

    -- §8: recorded so a bulk action is visible in the history rather than
    -- indistinguishable from thirty individual judgements.
    bulk                        boolean     NOT NULL DEFAULT FALSE,

    created_at                  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 2. Domain constraints. Guarded so the migration is re-runnable.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fas_region_chk') THEN
        ALTER TABLE field_audit_signoffs ADD CONSTRAINT fas_region_chk
            CHECK (region IN ('US', 'IND'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fas_action_chk') THEN
        ALTER TABLE field_audit_signoffs ADD CONSTRAINT fas_action_chk
            CHECK (action IN ('CONFIRMED', 'REJECTED', 'SUPERSEDED'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fas_kind_chk') THEN
        ALTER TABLE field_audit_signoffs ADD CONSTRAINT fas_kind_chk
            CHECK (signoff_kind IS NULL OR signoff_kind IN ('DESK_REVIEW', 'FIELD_VERIFIED'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fas_authority_chk') THEN
        ALTER TABLE field_audit_signoffs ADD CONSTRAINT fas_authority_chk
            CHECK (signing_authority IS NULL OR signing_authority IN ('INDIVIDUAL', 'FIRM'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fas_expiry_semantics_chk') THEN
        ALTER TABLE field_audit_signoffs ADD CONSTRAINT fas_expiry_semantics_chk
            CHECK (credential_expiry_semantics IS NULL
                   OR credential_expiry_semantics IN ('EXPIRES', 'PERPETUAL', 'UNKNOWN'));
    END IF;

    -- §15.3. SELF_DECLARED is accepted as a stored VALUE — "nobody has checked
    -- this" is a fact worth keeping — but record_signoff() refuses to grant
    -- FIELD_VERIFIED on it.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fas_verification_method_chk') THEN
        ALTER TABLE field_audit_signoffs ADD CONSTRAINT fas_verification_method_chk
            CHECK (verification_method IS NULL OR verification_method IN (
                'SELF_DECLARED', 'SCANNED_COPY', 'CERTIFIED_COPY',
                'ORIGINAL_DOCUMENT_SEEN', 'PRIMARY_SOURCE_REGISTER'));
    END IF;

    -- §7's list, verbatim.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fas_reason_code_chk') THEN
        ALTER TABLE field_audit_signoffs ADD CONSTRAINT fas_reason_code_chk
            CHECK (reason_code IS NULL OR reason_code IN (
                'FALSE_POSITIVE', 'WRONG_EQUIPMENT', 'IMAGE_INADEQUATE',
                'SEVERITY_DISPUTED', 'CODE_BASIS_WRONG', 'ALREADY_REMEDIATED', 'OTHER'));
    END IF;

    -- A confirmation without an attestation is not a signature, it is a click.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fas_confirmed_requires_attestation') THEN
        ALTER TABLE field_audit_signoffs ADD CONSTRAINT fas_confirmed_requires_attestation
            CHECK (action <> 'CONFIRMED'
                   OR (attestation IS NOT NULL AND btrim(attestation) <> ''
                       AND signoff_kind IS NOT NULL));
    END IF;

    -- §7: a rejection without a reason teaches nobody anything.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fas_rejected_requires_reason') THEN
        ALTER TABLE field_audit_signoffs ADD CONSTRAINT fas_rejected_requires_reason
            CHECK (action <> 'REJECTED' OR reason_code IS NOT NULL);
    END IF;

    -- §14.2: claiming physical inspection without recording which party was
    -- licensed to make that claim is the gap this whole model exists to close.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fas_field_verify_requires_authority') THEN
        ALTER TABLE field_audit_signoffs ADD CONSTRAINT fas_field_verify_requires_authority
            CHECK (signoff_kind <> 'FIELD_VERIFIED' OR signing_authority IS NOT NULL);
    END IF;

    -- §8: "FIELD_VERIFIED is never bulk. Physical presence is per device by
    -- definition." Enforced in the schema, so no future caller can decide
    -- otherwise.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fas_field_verify_never_bulk') THEN
        ALTER TABLE field_audit_signoffs ADD CONSTRAINT fas_field_verify_never_bulk
            CHECK (NOT (bulk AND signoff_kind = 'FIELD_VERIFIED'));
    END IF;
END $$;

COMMENT ON TABLE field_audit_signoffs IS
    'Append-only sign-off history. One row per action; never updated or deleted. '
    'The audit row''s signoff_status is a denormalised index onto this; this table '
    'is the truth. See docs/SIGNOFF_DESIGN.md sections 6 and 14.';

-- ---------------------------------------------------------------------------
-- 3. Append-only, enforced.
--
-- §6 says a signature is never edited or deleted. A comment saying so is not a
-- control: this is a compliance table, and the whole value of an append-only
-- history is that it cannot be quietly tidied up after an incident. Revoking
-- table privileges would not stop the owner of the table, so it is a trigger.
--
-- Corrections are made by INSERTING a superseding row, which is exactly the
-- mechanism §6 already defines for changing a verdict.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fas_block_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION
        'field_audit_signoffs is append-only (SIGNOFF_DESIGN 6). '
        'Attempted % on signoff id %. To change a verdict, INSERT a superseding '
        'row via record_signoff() instead.',
        TG_OP, COALESCE(OLD.id, -1);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fas_append_only ON field_audit_signoffs;
CREATE TRIGGER trg_fas_append_only
    BEFORE UPDATE OR DELETE ON field_audit_signoffs
    FOR EACH ROW EXECUTE FUNCTION fas_block_mutation();

-- ---------------------------------------------------------------------------
-- 4. Indexes.
-- ---------------------------------------------------------------------------
-- The hot path: "what is the current state of this audit's sign-off?"
CREATE INDEX IF NOT EXISTS idx_fas_audit
    ON field_audit_signoffs (region, audit_id, created_at DESC);

-- §4's commercial argument: "show me everything signed by a certificate that had
-- expired" is a question an SFM audit or an insurance adjuster will ask. It is
-- answerable only because credential_expiry is snapshotted per row.
CREATE INDEX IF NOT EXISTS idx_fas_credential_expiry
    ON field_audit_signoffs (credential_expiry)
    WHERE action = 'CONFIRMED';

-- §7's feedback loop: which checklist items produce false positives.
CREATE INDEX IF NOT EXISTS idx_fas_reason_code
    ON field_audit_signoffs (reason_code, created_at DESC)
    WHERE action = 'REJECTED';

-- ---------------------------------------------------------------------------
-- 5. India's denormalised current-state columns.
--
-- The US table has carried these since migration 001. India has not had them at
-- all, which is the "sign-off columns on field_audit_logs" item in
-- IND_FIRE_AUDIT_WORKFLOW.md §7.9. Same names, same CHECK, same default, so one
-- query shape serves both regions.
-- ---------------------------------------------------------------------------
ALTER TABLE field_audit_logs ADD COLUMN IF NOT EXISTS signoff_status text NOT NULL DEFAULT 'PENDING';
ALTER TABLE field_audit_logs ADD COLUMN IF NOT EXISTS signoff_by     text;
ALTER TABLE field_audit_logs ADD COLUMN IF NOT EXISTS signoff_at     timestamptz;
ALTER TABLE field_audit_logs ADD COLUMN IF NOT EXISTS signoff_notes  text;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'field_audit_logs_signoff_chk') THEN
        ALTER TABLE field_audit_logs ADD CONSTRAINT field_audit_logs_signoff_chk
            CHECK (signoff_status IN ('PENDING', 'CONFIRMED', 'REJECTED', 'SUPERSEDED'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_fal_pending_signoff
    ON field_audit_logs (created_at DESC)
    WHERE signoff_status = 'PENDING';

COMMENT ON COLUMN field_audit_logs.signoff_status IS
    'Denormalised current sign-off state. field_audit_signoffs is the truth; this '
    'is the index that keeps the records list and the pending queue fast.';


-- ===========================================================================
-- 6. record_signoff() — the single atomic write path.
-- ===========================================================================
--
-- ⚠️ SUPERSEDED BY MIGRATION 008. The definition below is retained as the record
-- of what was applied to production on first release; it is NOT the current
-- function. It reads the audit row's signoff_status without FOR UPDATE, so
-- check-then-act is not atomic against a concurrent caller and two racing calls can
-- both write CONFIRMED. See scripts/db/008_record_signoff_row_lock.sql, which is
-- authoritative, and apply it.
-- ===========================================================================
--
-- Closes SIGNOFF_DESIGN §14.6. The history INSERT and the audit-row UPDATE happen
-- in one function call, so they cannot half-commit. The n8n workflow at step 5 of
-- §11 calls this once and passes parameters; it does not compose SQL.
--
-- It also enforces §6's transition table HERE rather than in the UI, because a
-- transition rule that lives only in the front end is a suggestion.
--
-- WHY A jsonb SNAPSHOT PARAMETER
-- ------------------------------
-- The credential, firm and verification snapshots are eighteen fields. As
-- positional arguments that is a signature nobody can call correctly from n8n, and
-- one transposed pair of strings would mis-record who signed. A single jsonb blob
-- is natural to build in a Code node, and every key is destructured into a TYPED
-- column below — so the storage stays strongly typed and queryable even though the
-- transport is loose. Unknown keys are ignored rather than stored, which keeps the
-- column set the contract.
--
-- Returns the id of the new signoff row.
--
-- Roles (§10): TECHNICIAN and SUPERVISOR may sign. VIEWER cannot. ADMIN cannot —
-- administering the system and attesting to a fire inspection are unrelated
-- competencies, and an admin who is separately credentialed holds one of the other
-- two roles as well.
-- ===========================================================================
CREATE OR REPLACE FUNCTION record_signoff(
    p_region        text,
    p_audit_id      text,
    p_action        text,      -- CONFIRMED | REJECTED | SUPERSEDED
    p_actor_name    text,
    p_actor_role    text,      -- TECHNICIAN | SUPERVISOR
    p_signoff_kind  text    DEFAULT NULL,
    p_attestation   text    DEFAULT NULL,
    p_reason_code   text    DEFAULT NULL,
    p_notes         text    DEFAULT NULL,
    p_snapshot      jsonb   DEFAULT '{}'::jsonb,
    p_bulk          boolean DEFAULT FALSE,
    -- Set only by the re-audit path, which supersedes a prior signature without a
    -- human present. Never expose this to a request parameter: it bypasses the
    -- supervisor requirement on CONFIRMED -> SUPERSEDED.
    p_system        boolean DEFAULT FALSE
) RETURNS bigint AS $$
DECLARE
    v_current       text;
    v_critical      boolean := FALSE;
    v_impairment    boolean := FALSE;
    v_exists        boolean := FALSE;
    v_prior_id      bigint;
    v_new_id        bigint;
    v_kind          text := p_signoff_kind;
BEGIN
    -- ---------------------------------------------------------------- inputs
    IF p_region NOT IN ('US', 'IND') THEN
        RAISE EXCEPTION 'record_signoff: unknown region %', p_region;
    END IF;
    IF p_audit_id IS NULL OR btrim(p_audit_id) = '' THEN
        RAISE EXCEPTION 'record_signoff: audit_id is required';
    END IF;
    IF p_actor_name IS NULL OR btrim(p_actor_name) = '' THEN
        -- §2: a signature that does not name its signer is not a signature.
        RAISE EXCEPTION 'record_signoff: actor_name is required';
    END IF;

    -- §10, enforced. The system path is exempt because no human is attesting.
    IF NOT p_system AND COALESCE(p_actor_role, '') NOT IN ('TECHNICIAN', 'SUPERVISOR') THEN
        RAISE EXCEPTION
            'record_signoff: role % may not sign (SIGNOFF_DESIGN 10). '
            'VIEWER is read-only; ADMIN administers credentials and does not attest.',
            COALESCE(p_actor_role, '<null>');
    END IF;

    -- ------------------------------------------- the audit must actually exist
    -- Stands in for the foreign key that cannot exist across two audit tables.
    -- Deliberately IF/ELSE rather than dynamic SQL: the table name is not derived
    -- from input, so there is nothing to inject into.
    IF p_region = 'US' THEN
        SELECT TRUE, signoff_status, critical, impairment_suspected
          INTO v_exists, v_current, v_critical, v_impairment
          FROM field_audit_us_logs
         WHERE audit_id = p_audit_id;
    ELSE
        SELECT TRUE, signoff_status, COALESCE(critical, FALSE), FALSE
          INTO v_exists, v_current, v_critical, v_impairment
          FROM field_audit_logs
         WHERE audit_id = p_audit_id;
    END IF;

    IF NOT COALESCE(v_exists, FALSE) THEN
        RAISE EXCEPTION 'record_signoff: no % audit with audit_id % — refusing to '
                        'record a signature against an audit that does not exist',
                        p_region, p_audit_id;
    END IF;

    -- ------------------------------------------------ §6 transition table
    -- Enumerated positively: anything not listed is refused, so a new status added
    -- later fails closed instead of silently becoming signable.
    IF v_current = 'PENDING' AND p_action = 'CONFIRMED' THEN
        NULL;
    ELSIF v_current = 'PENDING' AND p_action = 'REJECTED' THEN
        NULL;
    ELSIF v_current = 'CONFIRMED' AND p_action = 'SUPERSEDED' THEN
        IF NOT p_system AND p_actor_role <> 'SUPERVISOR' THEN
            RAISE EXCEPTION 'record_signoff: superseding a confirmed sign-off '
                            'requires SUPERVISOR (SIGNOFF_DESIGN 6)';
        END IF;
    ELSIF v_current = 'REJECTED' AND p_action = 'CONFIRMED' THEN
        IF p_actor_role <> 'SUPERVISOR' THEN
            RAISE EXCEPTION 'record_signoff: overriding a rejection requires '
                            'SUPERVISOR (SIGNOFF_DESIGN 6)';
        END IF;
        IF p_reason_code IS NULL AND (p_notes IS NULL OR btrim(p_notes) = '') THEN
            RAISE EXCEPTION 'record_signoff: overriding a rejection requires a reason';
        END IF;
    ELSE
        -- Covers CONFIRMED -> PENDING (never), CONFIRMED -> CONFIRMED (supersede
        -- first), PENDING -> SUPERSEDED (nothing to supersede), and anything from
        -- SUPERSEDED, which is terminal because a re-audit mints a new audit_id.
        RAISE EXCEPTION 'record_signoff: transition % -> % is not permitted '
                        '(SIGNOFF_DESIGN 6)', v_current, p_action;
    END IF;

    -- ----------------------------------------------------------- §8 bulk rules
    IF p_bulk THEN
        IF v_kind = 'FIELD_VERIFIED' THEN
            RAISE EXCEPTION 'record_signoff: field verification is never bulk — '
                            'physical presence is per device (SIGNOFF_DESIGN 8)';
        END IF;
        IF v_critical THEN
            RAISE EXCEPTION 'record_signoff: an audit with a CRITICAL finding must '
                            'be signed one at a time, record opened (SIGNOFF_DESIGN 8)';
        END IF;
        IF v_impairment THEN
            RAISE EXCEPTION 'record_signoff: a suspected impairment must be signed '
                            'one at a time, record opened (SIGNOFF_DESIGN 8)';
        END IF;
    END IF;

    -- ------------------------------------------- §5 / §15 field-verify gating
    -- The registry in lib/credential-registry.mjs is the decision-maker and
    -- computes eligibility before this is called. These are the backstops that
    -- still hold if a caller sends a claim the registry would have refused —
    -- because "the UI checked" is not a control on a compliance table.
    IF v_kind = 'FIELD_VERIFIED' THEN
        IF (p_snapshot ->> 'credential_expiry_semantics') = 'EXPIRES' THEN
            IF (p_snapshot ->> 'credential_expiry') IS NULL THEN
                RAISE EXCEPTION 'record_signoff: field verification on an expiring '
                                'credential requires its expiry date (SIGNOFF_DESIGN 5)';
            END IF;
            IF (p_snapshot ->> 'credential_expiry')::date < current_date THEN
                RAISE EXCEPTION 'record_signoff: credential expired on % — an audit '
                                'signed under a lapsed certificate is worse than an '
                                'unsigned one (SIGNOFF_DESIGN 5)',
                                (p_snapshot ->> 'credential_expiry');
            END IF;
        ELSIF (p_snapshot ->> 'credential_expiry_semantics') = 'PERPETUAL' THEN
            -- §15.4: the expiry does not vanish for a perpetual credential, it
            -- moves onto the verification.
            IF (p_snapshot ->> 'verified_at') IS NULL
               OR COALESCE(btrim(p_snapshot ->> 'verified_by_name'), '') = '' THEN
                RAISE EXCEPTION 'record_signoff: a non-expiring credential requires '
                                'an attributed, dated verification (SIGNOFF_DESIGN 15)';
            END IF;
            IF COALESCE(p_snapshot ->> 'verification_method', 'SELF_DECLARED') = 'SELF_DECLARED' THEN
                RAISE EXCEPTION 'record_signoff: SELF_DECLARED is the absence of '
                                'verification and cannot support field verification '
                                '(SIGNOFF_DESIGN 15.3)';
            END IF;
            IF (p_snapshot ->> 'verification_review_due_at') IS NOT NULL
               AND (p_snapshot ->> 'verification_review_due_at')::timestamptz < now() THEN
                RAISE EXCEPTION 'record_signoff: the verification of this non-expiring '
                                'credential fell due for review on % (SIGNOFF_DESIGN 15.4)',
                                (p_snapshot ->> 'verification_review_due_at');
            END IF;
        ELSE
            RAISE EXCEPTION 'record_signoff: field verification requires known expiry '
                            'semantics; % yields desk review only (SIGNOFF_DESIGN 14.3)',
                            COALESCE(p_snapshot ->> 'credential_expiry_semantics', '<null>');
        END IF;

        IF (p_snapshot ->> 'signing_authority') IS NULL THEN
            RAISE EXCEPTION 'record_signoff: field verification requires signing_authority '
                            '(SIGNOFF_DESIGN 14.2)';
        END IF;
        -- Under FIRM the agency licence IS the instrument, so its absence is fatal
        -- rather than a downgrade.
        IF (p_snapshot ->> 'signing_authority') = 'FIRM'
           AND COALESCE(btrim(p_snapshot ->> 'firm_licence_no'), '') = '' THEN
            RAISE EXCEPTION 'record_signoff: this jurisdiction licenses the firm; a '
                            'firm licence number is required (SIGNOFF_DESIGN 14.2)';
        END IF;
    END IF;

    -- --------------------------------------------- the row being superseded
    IF p_action IN ('SUPERSEDED', 'CONFIRMED') AND v_current IN ('CONFIRMED', 'REJECTED') THEN
        SELECT id INTO v_prior_id
          FROM field_audit_signoffs
         WHERE region = p_region AND audit_id = p_audit_id
         ORDER BY created_at DESC, id DESC
         LIMIT 1;
    END IF;

    -- ------------------------------------------------------------- the writes
    INSERT INTO field_audit_signoffs (
        region, audit_id, action, signoff_kind,
        audit_jurisdiction, eligibility_reason, signing_authority,
        actor_account_id, actor_name, actor_email, actor_role,
        credential_jurisdiction, credential_type, credential_no,
        credential_expiry, credential_expiry_semantics,
        verification_method, verified_by_name, verified_at, verification_review_due_at,
        firm_name, firm_licence_no, firm_licence_expiry, firm_licence_category,
        attestation, reason_code, notes, supersedes, bulk
    ) VALUES (
        p_region, p_audit_id, p_action, v_kind,
        p_snapshot ->> 'audit_jurisdiction',
        p_snapshot ->> 'eligibility_reason',
        p_snapshot ->> 'signing_authority',
        p_snapshot ->> 'actor_account_id', p_actor_name,
        p_snapshot ->> 'actor_email', p_actor_role,
        p_snapshot ->> 'credential_jurisdiction',
        p_snapshot ->> 'credential_type',
        p_snapshot ->> 'credential_no',
        (p_snapshot ->> 'credential_expiry')::date,
        p_snapshot ->> 'credential_expiry_semantics',
        p_snapshot ->> 'verification_method',
        p_snapshot ->> 'verified_by_name',
        (p_snapshot ->> 'verified_at')::timestamptz,
        (p_snapshot ->> 'verification_review_due_at')::timestamptz,
        p_snapshot ->> 'firm_name',
        p_snapshot ->> 'firm_licence_no',
        (p_snapshot ->> 'firm_licence_expiry')::date,
        p_snapshot ->> 'firm_licence_category',
        p_attestation, p_reason_code, p_notes, v_prior_id, p_bulk
    ) RETURNING id INTO v_new_id;

    -- Denormalised current state. Same transaction, so §14.6's half-commit cannot
    -- happen: either the history row and the index agree, or neither was written.
    IF p_region = 'US' THEN
        UPDATE field_audit_us_logs
           SET signoff_status = p_action,
               signoff_by     = p_actor_name,
               signoff_at     = now(),
               signoff_notes  = p_notes
         WHERE audit_id = p_audit_id;
    ELSE
        UPDATE field_audit_logs
           SET signoff_status = p_action,
               signoff_by     = p_actor_name,
               signoff_at     = now(),
               signoff_notes  = p_notes
         WHERE audit_id = p_audit_id;
    END IF;

    RETURN v_new_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION record_signoff(text, text, text, text, text, text, text, text,
                                   text, jsonb, boolean, boolean) IS
    'The only sanctioned write path for a sign-off. Performs the history INSERT and '
    'the audit-row UPDATE atomically (SIGNOFF_DESIGN 14.6) and enforces the section 6 '
    'transition table, section 8 bulk rules and the section 5 / 15 expiry controls. '
    'Do not INSERT into field_audit_signoffs directly.';

-- ===========================================================================
-- 7. Views
-- ===========================================================================

-- Current sign-off state per audit, from the history rather than the index. Used
-- to reconcile the two, and to render "superseded on <date>" per §12 instead of a
-- signature quietly vanishing.
CREATE OR REPLACE VIEW v_signoff_current AS
SELECT s.*
FROM   field_audit_signoffs s
JOIN ( SELECT region, audit_id, max(id) AS id
       FROM   field_audit_signoffs
       GROUP BY region, audit_id ) latest
  ON   latest.region = s.region AND latest.audit_id = s.audit_id AND latest.id = s.id;

COMMENT ON VIEW v_signoff_current IS
    'Latest sign-off action per audit, computed from the append-only history. '
    'Compare against the audit row''s signoff_status to detect drift.';

-- India's analogue of v_faus_awaiting_signoff (migration 001). §9: an audit
-- sitting PENDING is an unresolved liability, sorted worst-first.
CREATE OR REPLACE VIEW v_fal_awaiting_signoff AS
SELECT audit_id,
       id AS record_id,
       site_id,
       asset_tag,
       equipment_type,
       status,
       COALESCE(critical, FALSE) AS critical,
       risk_score,
       confidence,
       image_quality,
       audit_timestamp
FROM   field_audit_logs
WHERE  signoff_status = 'PENDING'
  AND  COALESCE(status, '') <> 'ERROR'
ORDER BY COALESCE(critical, FALSE) DESC, risk_score DESC NULLS LAST, audit_timestamp ASC;

COMMENT ON VIEW v_fal_awaiting_signoff IS
    'India pending sign-off queue, worst first. Mirrors v_faus_awaiting_signoff.';

-- §4's commercial wedge, and the query an SFM audit or insurance adjuster asks:
-- anything confirmed under a certificate that had already expired at signing.
-- Should always be empty; if it is not, the control failed and this finds it.
CREATE OR REPLACE VIEW v_signoff_expired_credential AS
SELECT id, region, audit_id, actor_name, credential_jurisdiction, credential_type,
       credential_no, credential_expiry, signoff_kind, created_at
FROM   field_audit_signoffs
WHERE  action = 'CONFIRMED'
  AND  credential_expiry IS NOT NULL
  AND  credential_expiry < created_at::date
ORDER BY created_at DESC;

COMMENT ON VIEW v_signoff_expired_credential IS
    'Sign-offs made on an already-expired credential. Expected to be empty: '
    'record_signoff() refuses these. A non-empty result means something wrote to '
    'field_audit_signoffs without going through it.';

COMMIT;

-- ===========================================================================
-- NEXT
-- ===========================================================================
--   1. Run scripts/db/007_verify.sql. It exercises every transition and guard on
--      this engine and prints PASS/FAIL, inside a transaction it rolls back.
--
--   2. Apply scripts/db/008_record_signoff_row_lock.sql, which replaces
--      record_signoff() with a version that locks the audit row. 007 alone leaves
--      the double-signing guard raceable.
--
--   3. No workflow re-import is needed for this migration. Nothing in any n8n
--      workflow writes to these columns yet — the write path is step 5 of
--      SIGNOFF_DESIGN 11 and will call record_signoff().
--
--   4. Do NOT INSERT into field_audit_signoffs directly, from n8n or anywhere
--      else. record_signoff() is what makes the history row and the audit-row
--      index atomic, and what enforces section 6. v_signoff_expired_credential
--      exists to catch it if something bypasses it anyway.
-- ===========================================================================
