-- ===========================================================================
-- 005 — normalise site_id on field_audit_logs (India)
-- ===========================================================================
--
-- WHY
-- ---
-- The Records query matches site_id exactly:
--
--     WHERE ($1::text IS NULL OR site_id = $1)
--
-- and until now the India workflow stored site_id exactly as the caller sent it.
-- So 'site-mum-401', 'Site-MUM-401' and 'SITE-MUM-401' were three different
-- buildings. A technician varying the case between visits produced two partial
-- histories, which a customer experiences as "your system lost my audits" — and
-- which would make a half-yearly Form B pack, assembled per building, quietly
-- incomplete.
--
-- VALIDATE_Input now upper-cases site_id and refuses a request that omits it.
-- This migration brings the rows already in the table onto the same footing, so
-- new and historical rows describe the same building with the same string.
--
-- STATE OF PRODUCTION AT THE TIME OF WRITING
-- ------------------------------------------
-- Verified on ai-stack-prod before writing this:
--
--   * the collision query returned 0 rows — no site_id has split across case
--     variants yet
--   * count of site_id IN ('unknown','UNKNOWN','') was 0
--
-- So the UPDATE below is a **safety net, not a repair**. It is written to be a
-- no-op against the data as it stands and is deliberately not built out into a
-- collision-merge procedure for a collision scenario that does not exist. If it
-- reports 0 rows updated, that is the expected result and confirms the finding.
--
-- Idempotent and safe to re-run.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Report what we are about to touch, before touching it.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    to_change  bigint;
    collisions bigint;
BEGIN
    SELECT count(*) INTO to_change
    FROM field_audit_logs
    WHERE site_id IS NOT NULL
      AND site_id <> upper(btrim(site_id));

    -- Distinct buildings that would merge: rows whose normalised form is shared
    -- by more than one raw spelling.
    SELECT count(*) INTO collisions
    FROM (
        SELECT upper(btrim(site_id))
        FROM field_audit_logs
        WHERE site_id IS NOT NULL
        GROUP BY 1
        HAVING count(DISTINCT site_id) > 1
    ) AS merged;

    RAISE NOTICE '005: rows whose site_id changes: %', to_change;
    RAISE NOTICE '005: normalised values with more than one raw spelling: %', collisions;

    IF collisions > 0 THEN
        RAISE NOTICE '005: those spellings refer to the same building and are being '
                     'merged. Their histories were previously split and returned '
                     'separately by Records.';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Normalise. Expected to affect 0 rows given the verification above.
-- ---------------------------------------------------------------------------
UPDATE field_audit_logs
   SET site_id = upper(btrim(site_id))
 WHERE site_id IS NOT NULL
   AND site_id <> upper(btrim(site_id));

-- ---------------------------------------------------------------------------
-- 3. Keep it normalised at the database boundary.
--
-- VALIDATE_Input is the only writer today, but a constraint is what makes that
-- still true after the next integration, a manual backfill, or a direct insert
-- during an incident. A compliance table should not rely on one node's good
-- behaviour for the identity of the thing being audited.
--
-- NOT VALID applies the constraint to new and updated rows without a full-table
-- validation pass; the VALIDATE below then confirms the existing rows, which is
-- safe precisely because step 2 has just normalised them.
-- ---------------------------------------------------------------------------
ALTER TABLE field_audit_logs
    DROP CONSTRAINT IF EXISTS field_audit_logs_site_id_normalised;

ALTER TABLE field_audit_logs
    ADD CONSTRAINT field_audit_logs_site_id_normalised
    CHECK (site_id IS NULL OR site_id = upper(btrim(site_id)))
    NOT VALID;

ALTER TABLE field_audit_logs
    VALIDATE CONSTRAINT field_audit_logs_site_id_normalised;

COMMIT;

-- ===========================================================================
-- ROLLBACK
-- ===========================================================================
-- The case of the original strings is not recoverable — but with 0 rows changed
-- there is nothing to recover. To lift the constraint only:
--
--   ALTER TABLE field_audit_logs
--       DROP CONSTRAINT IF EXISTS field_audit_logs_site_id_normalised;
--
-- Nothing reads a lower-case site_id, so dropping the constraint is sufficient to
-- return to the previous behaviour.
-- ===========================================================================
