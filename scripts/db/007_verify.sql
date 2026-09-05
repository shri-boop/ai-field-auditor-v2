-- ===========================================================================
-- 007_verify.sql — self-checking harness for migration 007
-- ===========================================================================
--
-- WHY THIS FILE EXISTS
-- --------------------
-- Every other decision-making component in this repository has an offline test
-- suite: test_india.mjs, test_pipeline.mjs, test_history.mjs, test_credentials.mjs.
-- The SQL in 007 has none, because no Postgres was available where it was written.
--
-- That is a real gap and this closes it, on the engine that matters rather than a
-- simulation of one. It exercises the section 6 transition table, the append-only
-- trigger, the section 8 bulk rules, the section 5 / 15 expiry controls, and the
-- atomicity claim, and prints PASS or FAIL per assertion.
--
-- SAFE TO RUN AGAINST PRODUCTION
-- ------------------------------
-- Everything happens inside a transaction that ends in ROLLBACK. Scratch audit
-- rows use audit_ids prefixed FA-VERIFY- so they are unmistakable in the unlikely
-- event a rollback is skipped. No existing row is read for its content, updated,
-- or deleted.
--
-- Run:
--   docker exec -i ai-stack-postgres-1 sh -c \
--     'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < scripts/db/007_verify.sql
--
-- Expect the final line to read: RESULT: n passed, 0 failed.
-- A failure here is the migration telling you something, not a surprise — read the
-- assertion name and the detail beside it.
-- ===========================================================================

\set ON_ERROR_STOP off

BEGIN;

CREATE TEMP TABLE _v (id serial, label text, ok boolean, detail text) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION _chk(p_label text, p_ok boolean, p_detail text DEFAULT NULL)
RETURNS void AS $$
BEGIN
    INSERT INTO _v (label, ok, detail) VALUES (p_label, COALESCE(p_ok, FALSE), p_detail);
END; $$ LANGUAGE plpgsql;

-- Runs a statement expected to fail, and records whether it did. This is most of
-- the suite: nearly every rule in 007 is a refusal, and a refusal that does not
-- refuse is the failure mode that matters.
CREATE OR REPLACE FUNCTION _expect_fail(p_label text, p_sql text, p_expect_substr text DEFAULT NULL)
RETURNS void AS $$
DECLARE v_msg text;
BEGIN
    BEGIN
        EXECUTE p_sql;
        PERFORM _chk(p_label, FALSE, 'statement unexpectedly SUCCEEDED');
    EXCEPTION WHEN OTHERS THEN
        v_msg := SQLERRM;
        IF p_expect_substr IS NULL OR position(lower(p_expect_substr) in lower(v_msg)) > 0 THEN
            PERFORM _chk(p_label, TRUE, NULL);
        ELSE
            PERFORM _chk(p_label, FALSE, 'wrong error: ' || left(v_msg, 120));
        END IF;
    END;
END; $$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Scratch fixtures.
-- ---------------------------------------------------------------------------
INSERT INTO field_audit_us_logs
    (audit_id, site_id, jurisdiction, status, critical, impairment_suspected, audit_timestamp)
VALUES
    ('FA-VERIFY-US-CLEAN',    'SITE-VERIFY', 'FL', 'COMPLIANT',     FALSE, FALSE, now()),
    ('FA-VERIFY-US-CRITICAL', 'SITE-VERIFY', 'FL', 'NON-COMPLIANT', TRUE,  FALSE, now()),
    ('FA-VERIFY-US-IMPAIR',   'SITE-VERIFY', 'FL', 'NON-COMPLIANT', FALSE, TRUE,  now());

INSERT INTO field_audit_logs (audit_id, site_id, status, audit_timestamp, critical)
VALUES ('FA-VERIFY-IN-1', 'SITE-VERIFY', 'REINSPECT', now(), FALSE);

-- ===========================================================================
DO $$
DECLARE
    v_id      bigint;
    v_status  text;
    v_snap    jsonb;
    v_count   bigint;
BEGIN
    -- ------------------------------------------------------- schema is present
    PERFORM _chk('the signoff table exists',
        to_regclass('field_audit_signoffs') IS NOT NULL);
    PERFORM _chk('India gained its denormalised signoff columns',
        EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'field_audit_logs' AND column_name = 'signoff_status'));
    PERFORM _chk('India rows default to PENDING, not to signed',
        (SELECT signoff_status FROM field_audit_logs WHERE audit_id = 'FA-VERIFY-IN-1') = 'PENDING');
    PERFORM _chk('the India pending queue view exists',
        to_regclass('v_fal_awaiting_signoff') IS NOT NULL);
    PERFORM _chk('the expired-credential audit view exists',
        to_regclass('v_signoff_expired_credential') IS NOT NULL);

    -- ------------------------------------------------ a desk review, end to end
    v_snap := jsonb_build_object(
        'audit_jurisdiction', 'FL', 'eligibility_reason', 'NO_CREDENTIAL',
        'actor_email', 'tech@example.test');
    v_id := record_signoff('US', 'FA-VERIFY-US-CLEAN', 'CONFIRMED', 'T. Tech', 'TECHNICIAN',
        'DESK_REVIEW', 'I have reviewed this automated screening and concur.',
        NULL, 'looks fine', v_snap, FALSE, FALSE);
    PERFORM _chk('a desk review is recorded and returns its row id', v_id IS NOT NULL);

    SELECT signoff_status INTO v_status FROM field_audit_us_logs WHERE audit_id = 'FA-VERIFY-US-CLEAN';
    PERFORM _chk('the audit row index was updated in the same call (14.6)',
        v_status = 'CONFIRMED', 'got ' || COALESCE(v_status, '<null>'));
    PERFORM _chk('the history row and the index agree',
        (SELECT action FROM v_signoff_current
          WHERE region = 'US' AND audit_id = 'FA-VERIFY-US-CLEAN') = 'CONFIRMED');
    PERFORM _chk('advisory_only is untouched by a desk review',
        (SELECT advisory_only FROM field_audit_us_logs WHERE audit_id = 'FA-VERIFY-US-CLEAN') = TRUE);

    -- ------------------------------------------------------- 6: transitions
    -- CONFIRMED -> CONFIRMED must be refused: supersede first.
    PERFORM _expect_fail('double-signing a confirmed audit is refused',
        $q$SELECT record_signoff('US','FA-VERIFY-US-CLEAN','CONFIRMED','T. Tech','TECHNICIAN',
             'DESK_REVIEW','again',NULL,NULL,'{}'::jsonb,FALSE,FALSE)$q$,
        'not permitted');

    -- CONFIRMED -> SUPERSEDED requires SUPERVISOR.
    PERFORM _expect_fail('a technician cannot supersede a confirmed sign-off',
        $q$SELECT record_signoff('US','FA-VERIFY-US-CLEAN','SUPERSEDED','T. Tech','TECHNICIAN',
             NULL,NULL,NULL,NULL,'{}'::jsonb,FALSE,FALSE)$q$,
        'SUPERVISOR');

    v_id := record_signoff('US', 'FA-VERIFY-US-CLEAN', 'SUPERSEDED', 'S. Super', 'SUPERVISOR',
        NULL, NULL, NULL, 're-audited', '{}'::jsonb, FALSE, FALSE);
    PERFORM _chk('a supervisor can supersede', v_id IS NOT NULL);
    PERFORM _chk('the superseding row points BACK at what it replaced (append-only lineage)',
        (SELECT supersedes FROM field_audit_signoffs WHERE id = v_id) IS NOT NULL);
    PERFORM _chk('nothing was mutated: the original row is still CONFIRMED',
        (SELECT count(*) FROM field_audit_signoffs
          WHERE region='US' AND audit_id='FA-VERIFY-US-CLEAN' AND action='CONFIRMED') = 1);

    -- SUPERSEDED is terminal — a re-audit mints a new audit_id.
    PERFORM _expect_fail('a superseded audit cannot be signed again',
        $q$SELECT record_signoff('US','FA-VERIFY-US-CLEAN','CONFIRMED','S. Super','SUPERVISOR',
             'DESK_REVIEW','x',NULL,NULL,'{}'::jsonb,FALSE,FALSE)$q$,
        'not permitted');

    -- 7: rejection needs a reason code.
    PERFORM _expect_fail('a rejection without a reason code is refused',
        $q$SELECT record_signoff('IND','FA-VERIFY-IN-1','REJECTED','T. Tech','TECHNICIAN',
             NULL,NULL,NULL,'nope','{}'::jsonb,FALSE,FALSE)$q$,
        'reason');

    v_id := record_signoff('IND', 'FA-VERIFY-IN-1', 'REJECTED', 'T. Tech', 'TECHNICIAN',
        NULL, NULL, 'FALSE_POSITIVE', 'gauge reflection misread', '{}'::jsonb, FALSE, FALSE);
    PERFORM _chk('a rejection with a reason code is recorded', v_id IS NOT NULL);
    PERFORM _chk('the India audit row reflects the rejection',
        (SELECT signoff_status FROM field_audit_logs WHERE audit_id = 'FA-VERIFY-IN-1') = 'REJECTED');

    -- REJECTED -> CONFIRMED is supervisor-only and needs a reason.
    PERFORM _expect_fail('a technician cannot override a rejection',
        $q$SELECT record_signoff('IND','FA-VERIFY-IN-1','CONFIRMED','T. Tech','TECHNICIAN',
             'DESK_REVIEW','concur',NULL,'override','{}'::jsonb,FALSE,FALSE)$q$,
        'SUPERVISOR');

    -- ----------------------------------------------------------- 10: roles
    PERFORM _expect_fail('a VIEWER may not sign',
        $q$SELECT record_signoff('US','FA-VERIFY-US-IMPAIR','CONFIRMED','V. Viewer','VIEWER',
             'DESK_REVIEW','x',NULL,NULL,'{}'::jsonb,FALSE,FALSE)$q$,
        'may not sign');
    PERFORM _expect_fail('an ADMIN may not sign',
        $q$SELECT record_signoff('US','FA-VERIFY-US-IMPAIR','CONFIRMED','A. Admin','ADMIN',
             'DESK_REVIEW','x',NULL,NULL,'{}'::jsonb,FALSE,FALSE)$q$,
        'may not sign');

    -- ------------------------------------------------- referential integrity
    PERFORM _expect_fail('a signature against a non-existent audit is refused',
        $q$SELECT record_signoff('US','FA-DOES-NOT-EXIST','CONFIRMED','T. Tech','TECHNICIAN',
             'DESK_REVIEW','x',NULL,NULL,'{}'::jsonb,FALSE,FALSE)$q$,
        'no US audit');
    PERFORM _expect_fail('an unknown region is refused',
        $q$SELECT record_signoff('EU','FA-VERIFY-IN-1','CONFIRMED','T. Tech','TECHNICIAN',
             'DESK_REVIEW','x',NULL,NULL,'{}'::jsonb,FALSE,FALSE)$q$,
        'region');
    PERFORM _expect_fail('an unnamed signer is refused',
        $q$SELECT record_signoff('US','FA-VERIFY-US-IMPAIR','CONFIRMED','','TECHNICIAN',
             'DESK_REVIEW','x',NULL,NULL,'{}'::jsonb,FALSE,FALSE)$q$,
        'actor_name');

    -- ------------------------------------------------------------ 8: bulk
    PERFORM _expect_fail('bulk sign-off is refused on a CRITICAL finding',
        $q$SELECT record_signoff('US','FA-VERIFY-US-CRITICAL','CONFIRMED','T. Tech','TECHNICIAN',
             'DESK_REVIEW','concur',NULL,NULL,'{}'::jsonb,TRUE,FALSE)$q$,
        'CRITICAL');
    PERFORM _expect_fail('bulk sign-off is refused on a suspected impairment',
        $q$SELECT record_signoff('US','FA-VERIFY-US-IMPAIR','CONFIRMED','T. Tech','TECHNICIAN',
             'DESK_REVIEW','concur',NULL,NULL,'{}'::jsonb,TRUE,FALSE)$q$,
        'impairment');
    -- The same critical audit signs fine one at a time. Bulk is the restriction,
    -- not the finding.
    v_id := record_signoff('US', 'FA-VERIFY-US-CRITICAL', 'CONFIRMED', 'T. Tech', 'TECHNICIAN',
        'DESK_REVIEW', 'concur', NULL, NULL, '{}'::jsonb, FALSE, FALSE);
    PERFORM _chk('a CRITICAL audit can still be signed individually', v_id IS NOT NULL);

    -- ------------------------------------------------- 5 / 15: field verify
    PERFORM _expect_fail('field verification on an expired credential is refused',
        $q$SELECT record_signoff('US','FA-VERIFY-US-IMPAIR','CONFIRMED','T. Tech','TECHNICIAN',
             'FIELD_VERIFIED','I have physically inspected...',NULL,NULL,
             jsonb_build_object('signing_authority','INDIVIDUAL',
               'credential_expiry_semantics','EXPIRES',
               'credential_expiry', (current_date - 1)::text),
             FALSE,FALSE)$q$,
        'expired');
    PERFORM _expect_fail('field verification with unknown expiry semantics is refused',
        $q$SELECT record_signoff('US','FA-VERIFY-US-IMPAIR','CONFIRMED','T. Tech','TECHNICIAN',
             'FIELD_VERIFIED','x',NULL,NULL,
             jsonb_build_object('signing_authority','INDIVIDUAL',
               'credential_expiry_semantics','UNKNOWN'),
             FALSE,FALSE)$q$,
        'expiry semantics');
    PERFORM _expect_fail('a perpetual credential with no verification is refused',
        $q$SELECT record_signoff('US','FA-VERIFY-US-IMPAIR','CONFIRMED','T. Tech','TECHNICIAN',
             'FIELD_VERIFIED','x',NULL,NULL,
             jsonb_build_object('signing_authority','INDIVIDUAL',
               'credential_expiry_semantics','PERPETUAL'),
             FALSE,FALSE)$q$,
        'verification');
    PERFORM _expect_fail('SELF_DECLARED cannot support field verification (15.3)',
        $q$SELECT record_signoff('US','FA-VERIFY-US-IMPAIR','CONFIRMED','T. Tech','TECHNICIAN',
             'FIELD_VERIFIED','x',NULL,NULL,
             jsonb_build_object('signing_authority','INDIVIDUAL',
               'credential_expiry_semantics','PERPETUAL',
               'verified_at', now()::text, 'verified_by_name','A. Admin',
               'verification_method','SELF_DECLARED'),
             FALSE,FALSE)$q$,
        'SELF_DECLARED');
    PERFORM _expect_fail('a stale verification is refused (15.4 — the expiry moved)',
        $q$SELECT record_signoff('US','FA-VERIFY-US-IMPAIR','CONFIRMED','T. Tech','TECHNICIAN',
             'FIELD_VERIFIED','x',NULL,NULL,
             jsonb_build_object('signing_authority','INDIVIDUAL',
               'credential_expiry_semantics','PERPETUAL',
               'verified_at',(now() - interval '5 years')::text,
               'verified_by_name','A. Admin','verification_method','CERTIFIED_COPY',
               'verification_review_due_at',(now() - interval '1 day')::text),
             FALSE,FALSE)$q$,
        'review');
    PERFORM _expect_fail('a FIRM jurisdiction without an agency licence is refused (14.2)',
        $q$SELECT record_signoff('IND','FA-VERIFY-IN-1','CONFIRMED','E. Engineer','SUPERVISOR',
             'FIELD_VERIFIED','x',NULL,'ok',
             jsonb_build_object('signing_authority','FIRM',
               'credential_expiry_semantics','PERPETUAL',
               'verified_at', now()::text,'verified_by_name','A. Admin',
               'verification_method','CERTIFIED_COPY'),
             FALSE,FALSE)$q$,
        'firm licence');

    -- A valid field verification, so the suite proves the gate is not simply shut.
    v_id := record_signoff('US', 'FA-VERIFY-US-IMPAIR', 'CONFIRMED', 'F. Inspector', 'TECHNICIAN',
        'FIELD_VERIFIED', 'I have physically inspected the equipment described...', NULL, NULL,
        jsonb_build_object(
            'signing_authority', 'INDIVIDUAL',
            'audit_jurisdiction', 'FL', 'credential_jurisdiction', 'FL',
            'credential_type', 'FIRE_EQUIPMENT_TECHNICIAN',
            'credential_no', 'FL-TECH-9911',
            'credential_expiry_semantics', 'EXPIRES',
            'credential_expiry', (current_date + 400)::text,
            'firm_licence_no', 'FL-DEALER-22',
            'eligibility_reason', 'ELIGIBLE'),
        FALSE, FALSE);
    PERFORM _chk('a valid field verification is accepted', v_id IS NOT NULL);
    PERFORM _chk('the credential is snapshotted onto the row, not referenced',
        (SELECT credential_no FROM field_audit_signoffs WHERE id = v_id) = 'FL-TECH-9911');
    PERFORM _chk('the expiry as at signing is snapshotted (4: the SFM question)',
        (SELECT credential_expiry FROM field_audit_signoffs WHERE id = v_id) IS NOT NULL);
    PERFORM _chk('the eligibility reason is recorded, not just the outcome',
        (SELECT eligibility_reason FROM field_audit_signoffs WHERE id = v_id) = 'ELIGIBLE');
    PERFORM _chk('no sign-off sits in the expired-credential view',
        (SELECT count(*) FROM v_signoff_expired_credential) = 0);

    -- --------------------------------------------------- 6: append-only
    SELECT id INTO v_id FROM field_audit_signoffs ORDER BY id LIMIT 1;
    PERFORM _chk('there is at least one row to attempt to mutate', v_id IS NOT NULL);

    -- ------------------------------------------------- the queue is populated
    SELECT count(*) INTO v_count FROM v_fal_awaiting_signoff;
    PERFORM _chk('the India pending queue is queryable', v_count IS NOT NULL);
END $$;

-- Append-only has to be tested at statement level: the trigger raises, which would
-- abort the surrounding DO block.
SELECT _expect_fail('a signoff row cannot be UPDATEd',
    'UPDATE field_audit_signoffs SET notes = ''tampered'' WHERE id = (SELECT min(id) FROM field_audit_signoffs)',
    'append-only');
SELECT _expect_fail('a signoff row cannot be DELETEd',
    'DELETE FROM field_audit_signoffs WHERE id = (SELECT min(id) FROM field_audit_signoffs)',
    'append-only');
SELECT _expect_fail('the attestation constraint refuses a CONFIRMED with no wording',
    $q$INSERT INTO field_audit_signoffs (region, audit_id, action, actor_name)
        VALUES ('US','FA-VERIFY-US-CLEAN','CONFIRMED','X')$q$,
    'fas_confirmed_requires_attestation');
SELECT _expect_fail('the schema itself refuses bulk field verification (8)',
    $q$INSERT INTO field_audit_signoffs
        (region, audit_id, action, signoff_kind, actor_name, attestation, signing_authority, bulk)
        VALUES ('US','FA-VERIFY-US-CLEAN','CONFIRMED','FIELD_VERIFIED','X','att','INDIVIDUAL',TRUE)$q$,
    'fas_field_verify_never_bulk');

-- ===========================================================================
\echo ''
\echo '================================ RESULTS ================================'
SELECT lpad(id::text, 3) || '  ' ||
       CASE WHEN ok THEN 'PASS  ' ELSE 'FAIL  ' END ||
       label ||
       CASE WHEN detail IS NOT NULL THEN '   [' || detail || ']' ELSE '' END AS result
FROM _v ORDER BY id;

\echo ''
SELECT 'RESULT: ' || count(*) FILTER (WHERE ok) || ' passed, '
                   || count(*) FILTER (WHERE NOT ok) || ' failed' AS summary
FROM _v;
\echo ''

-- Nothing is kept. Every scratch audit row and every signoff row created above
-- disappears with this.
ROLLBACK;

\echo 'Rolled back — no rows were kept. Confirm with:'
\echo "  SELECT count(*) FROM field_audit_signoffs WHERE audit_id LIKE 'FA-VERIFY-%';   -- expect 0"
