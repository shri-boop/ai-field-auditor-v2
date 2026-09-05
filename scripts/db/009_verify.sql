-- ===========================================================================
-- 009_verify.sql — confirm org scoping landed
-- ===========================================================================
--
-- Run after applying 009:
--   docker exec -i ai-stack-postgres-1 sh -c \
--     'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < scripts/db/009_verify.sql
--
-- Read-only apart from a transaction that ends in ROLLBACK. Safe against production.
--
-- It prints a VERDICT line rather than expecting you to match a total against a
-- number written in a PR description. That was a real mistake made once — an
-- instruction said "expect 16 passed" when the script contained 15 assertions, which
-- is exactly the sort of stale expectation that teaches people to ignore a genuine
-- failure. The only criterion that matters is that nothing failed.
-- ===========================================================================

\set ON_ERROR_STOP off

BEGIN;

CREATE TEMP TABLE _v9 (id serial, label text, ok boolean, detail text) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION _chk9(p_label text, p_ok boolean, p_detail text DEFAULT NULL)
RETURNS void AS $$
BEGIN
    INSERT INTO _v9 (label, ok, detail)
    VALUES (p_label, COALESCE(p_ok, FALSE),
            CASE WHEN COALESCE(p_ok, FALSE) THEN NULL ELSE p_detail END);
END; $$ LANGUAGE plpgsql;

DO $$
DECLARE
    v_unscoped bigint;
    v_blank    bigint;
BEGIN
    -- The columns exist on all three tables.
    PERFORM _chk9('field_audit_us_logs has org_id',
        EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'field_audit_us_logs' AND column_name = 'org_id'));
    PERFORM _chk9('field_audit_logs has org_id',
        EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'field_audit_logs' AND column_name = 'org_id'));
    PERFORM _chk9('field_audit_signoffs has org_id',
        EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'field_audit_signoffs' AND column_name = 'org_id'));

    -- Nullable on purpose: nothing can populate it until auth ships, and NOT NULL
    -- here would fail every insert in the meantime.
    PERFORM _chk9('org_id is nullable, so inserts keep working until auth ships',
        (SELECT is_nullable FROM information_schema.columns
          WHERE table_name = 'field_audit_logs' AND column_name = 'org_id') = 'YES');

    -- Backfill: existing rows are KRATU's own data and say so.
    SELECT count(*) INTO v_unscoped FROM field_audit_logs WHERE org_id IS NULL;
    PERFORM _chk9('no pre-existing India row was left unscoped', v_unscoped = 0,
        v_unscoped || ' row(s) still null');
    SELECT count(*) INTO v_unscoped FROM field_audit_us_logs WHERE org_id IS NULL;
    PERFORM _chk9('no pre-existing US row was left unscoped', v_unscoped = 0,
        v_unscoped || ' row(s) still null');
    PERFORM _chk9('backfilled rows are visibly internal, not silently tenanted',
        NOT EXISTS (SELECT 1 FROM field_audit_logs
                     WHERE org_id IS NOT NULL AND org_id <> 'ORG-KRATU-INTERNAL'));

    -- A blank scope looks scoped and matches nothing, which is worse than null.
    SELECT count(*) INTO v_blank FROM field_audit_logs WHERE org_id IS NOT NULL AND btrim(org_id) = '';
    PERFORM _chk9('no blank org_id slipped through', v_blank = 0);
    PERFORM _chk9('the not-blank constraint exists on all three tables',
        (SELECT count(*) FROM pg_constraint
          WHERE conname IN ('faus_org_id_not_blank', 'fal_org_id_not_blank', 'fas_org_id_not_blank')) = 3);

    -- A tenant-scoped query that cannot use an index scans every tenant's data.
    PERFORM _chk9('org-leading indexes exist',
        (SELECT count(*) FROM pg_indexes
          WHERE indexname IN ('idx_faus_org_time', 'idx_fal_org_time',
                              'idx_fal_org_site_time', 'idx_faus_org_site_time', 'idx_fas_org')) = 5);

    -- The queue view must expose org_id or it cannot be filtered per tenant.
    PERFORM _chk9('the India pending-queue view exposes org_id',
        EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'v_fal_awaiting_signoff' AND column_name = 'org_id'));

    -- Nothing from earlier migrations should have moved.
    PERFORM _chk9('the append-only trigger is still attached',
        EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_fas_append_only' AND NOT tgisinternal));
    PERFORM _chk9('the expired-credential view still returns nothing',
        (SELECT count(*) FROM v_signoff_expired_credential) = 0);
    PERFORM _chk9('audit_timestamp is still timestamptz (006 not disturbed)',
        (SELECT data_type FROM information_schema.columns
          WHERE table_name = 'field_audit_logs' AND column_name = 'audit_timestamp')
        = 'timestamp with time zone');
END $$;

\echo ''
\echo '============================== RESULTS =============================='
SELECT lpad(id::text, 3) || '  ' || CASE WHEN ok THEN 'PASS  ' ELSE 'FAIL  ' END || label ||
       CASE WHEN detail IS NOT NULL THEN '   [' || detail || ']' ELSE '' END AS result
FROM _v9 ORDER BY id;

\echo ''
SELECT count(*) FILTER (WHERE ok) || ' passed, ' || count(*) FILTER (WHERE NOT ok) || ' failed'
       AS tally FROM _v9;
SELECT CASE WHEN count(*) FILTER (WHERE NOT ok) = 0
            THEN 'VERDICT: OK'
            ELSE 'VERDICT: FAILED — ' || count(*) FILTER (WHERE NOT ok) || ' assertion(s) above' END
       AS verdict FROM _v9;
\echo ''

ROLLBACK;

\echo 'Reminder: org_id is populated for nobody yet. Backfilled rows read'
\echo "ORG-KRATU-INTERNAL and new rows are NULL until step 4 delivers auth."
\echo 'Do not add NOT NULL before then.'
