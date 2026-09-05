-- ===========================================================================
-- 008 — record_signoff(): lock the audit row before deciding the transition
-- ===========================================================================
--
-- A CORRECTNESS FIX TO MIGRATION 007. Apply it.
--
-- THE BUG
-- -------
-- record_signoff() read the audit row's current signoff_status, checked it against
-- the section 6 transition table, and then wrote. The read took no lock, so
-- check-then-act was not atomic with respect to another caller.
--
-- Under Postgres' default READ COMMITTED isolation, two concurrent calls against the
-- same audit both read PENDING, both pass the transition check, and both insert a
-- CONFIRMED row. The guard that refuses double-signing -- verified passing in
-- 007_verify.sql -- is bypassable simply by racing it.
--
-- WHY THIS IS NOT THEORETICAL HERE
-- --------------------------------
--   * Bulk desk review (section 8) is many calls at once, by design.
--   * A double-clicked button in the sign-off UI (step 7) is two calls.
--   * n8n retries. LOG_Audit already carries retryOnFail with maxTries 3, and the
--     sign-off workflow at step 5 will be built in the same style.
--
-- The outcome would be two valid-looking signatures on one audit, potentially by
-- different people with different attestations, in an append-only table that cannot
-- be tidied up afterwards -- on the one table in this system where being wrong has
-- legal consequences.
--
-- Note what did NOT catch this: 44 passing assertions in 007_verify.sql. Every one
-- of them runs in a single session, and a single-session harness cannot observe a
-- race. Those 44 passes were evidence the function was correct when nobody else was
-- calling it, which is not the same claim.
--
-- THE FIX
-- -------
-- SELECT ... FOR UPDATE on the audit row. The second caller blocks until the first
-- commits, then re-reads the now-CONFIRMED status and is refused by the transition
-- check that was already there. No new logic and no new failure mode -- the existing
-- check simply now reads a value nobody can change underneath it.
--
-- The lock is on the AUDIT row rather than on field_audit_signoffs, deliberately.
-- The audit is both the thing being signed and the thing whose status gates the
-- transition, so it is the correct serialisation point. Locking the history table
-- would serialise unrelated sign-offs against each other for no benefit.
--
-- WHY A NEW MIGRATION RATHER THAN EDITING 007
-- -------------------------------------------
-- 007 is already applied to production. Editing it in place would leave a database
-- that ran the old definition indistinguishable from one that ran the new definition
-- as far as source control is concerned -- the silent-divergence failure this
-- project has already been bitten by twice. 007 keeps its definition as the record
-- of what was applied, marked superseded; this file is authoritative.
--
-- Idempotent: CREATE OR REPLACE FUNCTION, no schema change, no data change. Safe to
-- re-run, and safe to apply while the system is live -- it replaces a function
-- definition and takes no long locks.
-- ===========================================================================

BEGIN;

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
    --
    -- FOR UPDATE is the fix this migration exists for. Without it the read below and
    -- the transition check that follows are not atomic with respect to another
    -- caller: under READ COMMITTED two concurrent calls both see PENDING, both pass
    -- the check, and both write CONFIRMED. The lock makes the second caller wait,
    -- re-read CONFIRMED, and be refused as it should be.
    IF p_region = 'US' THEN
        SELECT TRUE, signoff_status, critical, impairment_suspected
          INTO v_exists, v_current, v_critical, v_impairment
          FROM field_audit_us_logs
         WHERE audit_id = p_audit_id
           FOR UPDATE;
    ELSE
        SELECT TRUE, signoff_status, COALESCE(critical, FALSE), FALSE
          INTO v_exists, v_current, v_critical, v_impairment
          FROM field_audit_logs
         WHERE audit_id = p_audit_id
           FOR UPDATE;
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
    'the audit-row UPDATE atomically (SIGNOFF_DESIGN 14.6), locks the audit row with '
    'FOR UPDATE before evaluating the section 6 transition table (migration 008), and '
    'enforces the section 8 bulk rules and the section 5 / 15 expiry controls. '
    'Do not INSERT into field_audit_signoffs directly.';

COMMIT;

-- ===========================================================================
-- VERIFY
-- ===========================================================================
--   docker exec -i ai-stack-postgres-1 sh -c \
--     'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < scripts/db/008_verify.sql
--
-- That confirms the deployed function really carries the lock, and prints the
-- two-session procedure for watching the race be refused -- which no single-session
-- script can test.
-- ===========================================================================
