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
-- WHAT THIS ACTUALLY DID IN PRODUCTION (applied 2026-09-05, ai-stack-prod)
-- -----------------------------------------------------------------------
--     NOTICE:  005: rows whose site_id changes: 3
--     NOTICE:  005: normalised values with more than one raw spelling: 0
--     UPDATE 3
--
-- This migration was predicted to be a no-op. It was not: it corrected 3 rows.
-- The prediction was wrong because the pre-flight check asked the wrong question.
--
-- The check that was run beforehand was the COLLISION query:
--
--     GROUP BY upper(btrim(site_id)) HAVING count(DISTINCT site_id) > 1
--
-- which answers "will any two buildings MERGE into one?" — correctly 0. It does
-- NOT answer "is any row un-normalised?", because a row stored as
-- 'site-ban-502' with no upper-case sibling has exactly one spelling and so is
-- invisible to a HAVING count(DISTINCT ...) > 1 filter. The right pre-flight
-- question is the one this migration itself reports on:
--
--     SELECT count(*) FROM field_audit_logs
--      WHERE site_id IS NOT NULL AND site_id <> upper(btrim(site_id));
--
-- Both questions matter and they are not the same. Ask both next time.
--
-- WHY THE OUTCOME WAS STILL SAFE
-- ------------------------------
-- collisions = 0 is the load-bearing number, and it held. No building's history
-- was merged, split, or reattributed; 3 rows had their casing corrected in place
-- and each was the only spelling of its own site, so none of them joined another
-- building's history.
--
-- It was in fact a small repair rather than pure hygiene: before this ran, those
-- 3 rows could not be found by anyone searching the canonical upper-case site id,
-- because the Records query matches exactly. They are now reachable.
--
-- The honest cost: the original casing of those 3 rows is not recoverable and the
-- change was not itself logged to an audit trail. That is acceptable here because
-- site_id casing is an identifier's spelling, not evidentiary content — no
-- finding, severity, timestamp or photo reference was touched. It would not be
-- acceptable for a column that carries evidence, and a future migration that
-- rewrites one should capture the prior value first.
--
-- Idempotent and safe to re-run: a second run reports 0 and changes nothing.
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
-- The case of the original strings is not recoverable. 3 rows were normalised in
-- production; since no two spellings merged (collisions = 0), nothing was
-- conflated and there is no integrity concern to unwind — but the prior spellings
-- of those 3 rows are gone. To lift the constraint only:
--
--   ALTER TABLE field_audit_logs
--       DROP CONSTRAINT IF EXISTS field_audit_logs_site_id_normalised;
--
-- Nothing reads a lower-case site_id, so dropping the constraint is sufficient to
-- return to the previous behaviour.
-- ===========================================================================
