-- ===========================================================================
-- 008_verify.sql — confirm the deployed record_signoff() carries the row lock
-- ===========================================================================
--
-- Run after applying 008:
--   docker exec -i ai-stack-postgres-1 sh -c \
--     'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < scripts/db/008_verify.sql
--
-- WHAT THIS CAN CHECK, AND WHAT IT CANNOT
-- ---------------------------------------
-- It inspects the function AS DEPLOYED, via pg_get_functiondef, rather than reading
-- the migration file. That distinction is the point: the file on disk and the
-- function in the database are different things, and only the second one runs. This
-- is the same reasoning as test_india.mjs asserting byte equality between a node's
-- jsCode and its source file.
--
-- It CANNOT test the race itself. A race needs two concurrent sessions and psql
-- gives one, which is exactly why 007_verify.sql went green on a function that could
-- be raced. The manual two-session procedure is printed at the end; it takes about a
-- minute and is worth doing once.
--
-- Read-only apart from a rolled-back transaction. Safe against production.
-- ===========================================================================

\set ON_ERROR_STOP off

BEGIN;

CREATE TEMP TABLE _v8 (id serial, label text, ok boolean, detail text) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION _chk8(p_label text, p_ok boolean, p_detail text DEFAULT NULL)
RETURNS void AS $$
BEGIN
    -- Detail is recorded only on failure. A bracketed value beside a PASS line reads
    -- like a warning and makes a clean run harder to scan, which 007_verify.sql got
    -- slightly wrong.
    INSERT INTO _v8 (label, ok, detail)
    VALUES (p_label, COALESCE(p_ok, FALSE),
            CASE WHEN COALESCE(p_ok, FALSE) THEN NULL ELSE p_detail END);
END; $$ LANGUAGE plpgsql;

DO $$
DECLARE
    v_def       text;
    v_locks     int;
    v_us_pos    int;
    v_in_pos    int;
    v_chk_pos   int;
BEGIN
    SELECT pg_get_functiondef(p.oid) INTO v_def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.proname = 'record_signoff'
     LIMIT 1;

    PERFORM _chk8('record_signoff() is deployed', v_def IS NOT NULL);

    IF v_def IS NULL THEN
        RETURN;
    END IF;

    -- Both reads must be locked. One would leave the other region racy, and India is
    -- the region heading for a statutory artefact.
    v_locks := (length(v_def) - length(replace(upper(v_def), 'FOR UPDATE', ''))) / length('FOR UPDATE');
    PERFORM _chk8('the deployed function locks BOTH audit reads (US and India)',
        v_locks >= 2, 'found ' || v_locks || ' FOR UPDATE clause(s)');

    v_us_pos  := position('field_audit_us_logs' in v_def);
    v_in_pos  := position('field_audit_logs' in v_def);
    PERFORM _chk8('it still reads both audit tables', v_us_pos > 0 AND v_in_pos > 0);

    -- The lock has to be taken BEFORE the transition check, or it protects nothing.
    v_chk_pos := position('is not permitted' in v_def);
    PERFORM _chk8('the lock is taken before the transition check is evaluated',
        position('FOR UPDATE' in upper(v_def)) < v_chk_pos,
        'lock at ' || position('FOR UPDATE' in upper(v_def)) || ', check at ' || v_chk_pos);

    -- The guards 007 shipped must all still be present: 008 replaces the whole
    -- function body, so a transcription slip would silently drop one.
    PERFORM _chk8('the section 6 catch-all refusal survived the replacement',
        position('is not permitted' in v_def) > 0);
    PERFORM _chk8('the SUPERVISOR requirement survived', position('SUPERVISOR' in v_def) > 0);
    PERFORM _chk8('the role gate survived', position('may not sign' in v_def) > 0);
    PERFORM _chk8('the bulk CRITICAL guard survived', position('one at a time' in v_def) > 0);
    PERFORM _chk8('the expired-credential guard survived',
        position('lapsed certificate' in v_def) > 0);
    PERFORM _chk8('the SELF_DECLARED guard survived', position('SELF_DECLARED' in v_def) > 0);
    PERFORM _chk8('the FIRM licence guard survived', position('firm licence number' in v_def) > 0);
    PERFORM _chk8('the atomic pair survived: history INSERT and audit UPDATE',
        position('INSERT INTO field_audit_signoffs' in v_def) > 0
        AND position('UPDATE field_audit_us_logs' in v_def) > 0
        AND position('UPDATE field_audit_logs' in v_def) > 0);

    PERFORM _chk8('the comment records that the lock is deliberate',
        position('FOR UPDATE' in COALESCE(obj_description(
            (SELECT p.oid FROM pg_proc p WHERE p.proname = 'record_signoff' LIMIT 1),
            'pg_proc'), '')) > 0);

    -- Nothing else should have changed.
    PERFORM _chk8('the append-only trigger is still attached',
        EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgname = 'trg_fas_append_only' AND NOT tgisinternal));
    PERFORM _chk8('the expired-credential audit view still returns nothing',
        (SELECT count(*) FROM v_signoff_expired_credential) = 0);
END $$;

\echo ''
\echo '============================== RESULTS =============================='
SELECT lpad(id::text, 3) || '  ' ||
       CASE WHEN ok THEN 'PASS  ' ELSE 'FAIL  ' END || label ||
       CASE WHEN detail IS NOT NULL THEN '   [' || detail || ']' ELSE '' END AS result
FROM _v8 ORDER BY id;

\echo ''
SELECT 'RESULT: ' || count(*) FILTER (WHERE ok) || ' passed, '
                   || count(*) FILTER (WHERE NOT ok) || ' failed' AS summary
FROM _v8;

ROLLBACK;

\echo ''
\echo '--------------------------------------------------------------------'
\echo 'OPTIONAL: watch the race be refused. Needs TWO psql sessions.'
\echo 'A single-session script cannot test this, which is why the bug survived'
\echo '44 green assertions in 007_verify.sql.'
\echo ''
\echo 'Pick a PENDING audit id first:'
\echo "  SELECT audit_id FROM field_audit_logs WHERE signoff_status = 'PENDING' LIMIT 1;"
\echo ''
\echo 'SESSION A:'
\echo '  BEGIN;'
\echo "  SELECT record_signoff('IND','<audit_id>','CONFIRMED','A. One','TECHNICIAN',"
\echo "         'DESK_REVIEW','concur',NULL,NULL,'{}'::jsonb,FALSE,FALSE);"
\echo '  -- leave the transaction OPEN'
\echo ''
\echo 'SESSION B (while A is still open):'
\echo "  SELECT record_signoff('IND','<audit_id>','CONFIRMED','B. Two','TECHNICIAN',"
\echo "         'DESK_REVIEW','concur',NULL,NULL,'{}'::jsonb,FALSE,FALSE);"
\echo '  -- BEFORE 008: returns a second id immediately -> two signatures, one audit'
\echo '  -- AFTER  008: BLOCKS, waiting on the row lock'
\echo ''
\echo 'SESSION A:'
\echo '  COMMIT;'
\echo ''
\echo 'SESSION B then unblocks and must FAIL with:'
\echo '  transition CONFIRMED -> CONFIRMED is not permitted'
\echo ''
\echo 'Then undo the test signature (it is real, A committed it):'
\echo "  -- the audit row can be reset; the history row is append-only by design"
\echo "  UPDATE field_audit_logs SET signoff_status='PENDING', signoff_by=NULL,"
\echo "         signoff_at=NULL, signoff_notes=NULL WHERE audit_id='<audit_id>';"
\echo '--------------------------------------------------------------------'
