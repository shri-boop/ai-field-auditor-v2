-- ===========================================================================
-- 006 — India: minted audit_id, and audit_timestamp text -> timestamptz
-- ===========================================================================
--
-- Two changes in one migration because they rewrite the same table and are both
-- prerequisites for Form B. Doing them separately would mean two table rewrites
-- and two workflow re-imports for no benefit.
--
-- WHY audit_id
-- -----------
-- docs/SIGNOFF_DESIGN.md §14.1: `field_audit_signoffs` is keyed on `audit_id` as
-- a reference to the audit being signed. India has never had one — `field_audit_logs`
-- is keyed on `id`, an integer serial — so the sign-off table as designed could only
-- ever hold US rows. A Form B evidence pack also has to cite individual audits, and
-- "row 4711 of field_audit_logs" is not a citation.
--
-- WHY timestamptz
-- ---------------
-- Form B is defined by a date range: H1 is January to June, H2 is July to December.
-- Postgres has no `text >= timestamptz` operator, so a half-yearly evidence pack
-- cannot be selected from a text column at all. This is a hard prerequisite for the
-- `compliance_periods` work in SIGNOFF_DESIGN §14.4, not a tidy-up.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS WILL CHANGE — BOTH QUESTIONS, PER THE 005 LESSON
-- ---------------------------------------------------------------------------
-- Migration 005 was predicted to be a no-op and changed 3 rows, because the
-- pre-flight asked "will anything collide?" and not "is anything un-normalised?".
-- Those were different questions.
--
-- So this migration asks and REPORTS both of its own, and refuses to run rather
-- than half-apply if the answer to the first is unsafe:
--
--   1. Are all existing audit_timestamp values parseable as timestamptz?
--      If any are not, this migration ABORTS with a count. A failed cast would
--      otherwise abort the transaction anyway, but with a Postgres type error
--      instead of a number a human can act on.
--   2. How many rows will receive a backfilled audit_id?
--      Reported, not predicted. Expect it to equal the current row count.
--
-- ---------------------------------------------------------------------------
-- BACKFILLED IDS ARE VISIBLY BACKFILLED
-- ---------------------------------------------------------------------------
-- New audits get `FA-IN-<date>-<hash>-<rand>`, minted by VALIDATE_Input at the
-- moment of the audit, mirroring the US format.
--
-- Rows that predate this migration get `FA-INB-<date>-<zero-padded id>` — note the
-- **B**. They are derived, not minted, and the identifier says so wherever it
-- appears, which will include Form B evidence packs.
--
-- That distinction is deliberate. An identifier assigned retroactively by a
-- migration is a different kind of fact from one assigned when the photograph was
-- judged, and this repository's standing rule is that the weaker fact is labelled
-- rather than blended in. Compare `edition_verified: false` and
-- `code_basis_confident: false`.
--
-- Backfilling is legitimate here in a way that migration 003 was not: `image_url`
-- could not be backfilled because the value was never captured, whereas an
-- identifier is derivable from data the row already holds. Nothing evidentiary is
-- being invented — `id` is unique, so the derived ids are unique too.
--
-- ---------------------------------------------------------------------------
-- audit_id IS NULLABLE ON PURPOSE
-- ---------------------------------------------------------------------------
-- It is NOT declared NOT NULL here, and that is the ordering rule doing its job.
-- Migration runs BEFORE the workflow re-import, so between the two there is a
-- window in which the running workflow does not yet write audit_id. A NOT NULL
-- column would make every insert in that window fail — which is precisely the
-- reverse-order failure this project avoids by migrating first.
--
-- Add NOT NULL in a later migration, once `SELECT count(*) FROM field_audit_logs
-- WHERE audit_id IS NULL` returns 0 for audits created after the re-import.
--
-- Idempotent and safe to re-run.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Pre-flight. Report both questions; abort on the unsafe one.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    already_converted boolean;
    unparseable       bigint := 0;
    to_backfill       bigint := 0;
    total             bigint := 0;
BEGIN
    SELECT data_type = 'timestamp with time zone'
      INTO already_converted
      FROM information_schema.columns
     WHERE table_name = 'field_audit_logs'
       AND column_name = 'audit_timestamp';

    IF already_converted IS NULL THEN
        RAISE EXCEPTION '006: field_audit_logs.audit_timestamp not found - refusing to guess at this table''s shape';
    END IF;

    SELECT count(*) INTO total FROM field_audit_logs;
    RAISE NOTICE '006: rows in field_audit_logs: %', total;

    IF already_converted THEN
        RAISE NOTICE '006: audit_timestamp is already timestamptz - conversion will be skipped';
    ELSE
        -- Deliberately a shape test rather than a trial cast: a failing cast would
        -- abort this transaction with a type error, losing the count that makes the
        -- problem actionable.
        SELECT count(*) INTO unparseable
          FROM field_audit_logs
         WHERE audit_timestamp IS NOT NULL
           AND btrim(audit_timestamp) <> ''
           AND audit_timestamp !~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}';

        RAISE NOTICE '006: audit_timestamp values that do not look ISO-8601: %', unparseable;

        IF unparseable > 0 THEN
            RAISE EXCEPTION '006: % row(s) have an audit_timestamp that will not cast. '
                            'Refusing to run. Inspect with: SELECT id, audit_timestamp FROM '
                            'field_audit_logs WHERE audit_timestamp !~ ''^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}'';',
                            unparseable;
        END IF;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name = 'field_audit_logs' AND column_name = 'audit_id') THEN
        SELECT count(*) INTO to_backfill FROM field_audit_logs WHERE audit_id IS NULL;
    ELSE
        to_backfill := total;
    END IF;
    RAISE NOTICE '006: rows that will receive a backfilled FA-INB- audit_id: %', to_backfill;
END $$;

-- ---------------------------------------------------------------------------
-- 2. audit_timestamp -> timestamptz.
--
-- Empty strings become NULL first: ''::timestamptz is an error, and a blank
-- timestamp means "not recorded", which is what NULL is for.
--
-- The cast is explicit about input timezone handling: values written by the
-- workflow are ISO-8601 with a trailing Z, so they carry their own offset. A bare
-- value without an offset would be read in the server's timezone, which is why
-- step 1 requires the ISO shape rather than accepting anything Postgres will take.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF (SELECT data_type FROM information_schema.columns
         WHERE table_name = 'field_audit_logs' AND column_name = 'audit_timestamp')
       = 'text' THEN

        UPDATE field_audit_logs
           SET audit_timestamp = NULL
         WHERE audit_timestamp IS NOT NULL AND btrim(audit_timestamp) = '';

        ALTER TABLE field_audit_logs
            ALTER COLUMN audit_timestamp TYPE timestamptz
            USING audit_timestamp::timestamptz;

        RAISE NOTICE '006: audit_timestamp converted to timestamptz';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. audit_id — nullable, see the header.
-- ---------------------------------------------------------------------------
ALTER TABLE field_audit_logs ADD COLUMN IF NOT EXISTS audit_id text;

COMMENT ON COLUMN field_audit_logs.audit_id IS
    'Minted audit identifier. FA-IN- prefix = minted by VALIDATE_Input at audit time. '
    'FA-INB- prefix = backfilled by migration 006 from the row id, for audits that '
    'predate the column. Referenced by field_audit_signoffs (SIGNOFF_DESIGN 14.1).';

-- ---------------------------------------------------------------------------
-- 4. Backfill. FA-INB-, derived from the row id, so it is unique by construction
--    and visibly retroactive.
--
--    created_at is the fallback date because it is written by DEFAULT now() in the
--    same statement that sets audit_timestamp, so the two agree for date purposes.
-- ---------------------------------------------------------------------------
UPDATE field_audit_logs
   SET audit_id = 'FA-INB-'
                  || to_char(COALESCE(audit_timestamp, created_at, now()), 'YYYYMMDD')
                  || '-'
                  || lpad(id::text, 10, '0')
 WHERE audit_id IS NULL;

-- ---------------------------------------------------------------------------
-- 5. Uniqueness. An identifier a signature will reference must not repeat.
--    Partial, so the NULL window described in the header stays legal.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_fal_audit_id_unique
    ON field_audit_logs (audit_id)
    WHERE audit_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 6. The index Form B's date ranges will actually use.
--    (site_id, audit_timestamp DESC) is the shape of "this premises, this
--    half-year" — which is the only query Form B asks.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_fal_site_audit_time
    ON field_audit_logs (site_id, audit_timestamp DESC);

COMMIT;

-- ===========================================================================
-- VERIFY
-- ===========================================================================
--   SELECT data_type FROM information_schema.columns
--    WHERE table_name = 'field_audit_logs' AND column_name = 'audit_timestamp';
--   -- expect: timestamp with time zone
--
--   SELECT audit_id, site_id, audit_timestamp FROM field_audit_logs
--    ORDER BY audit_timestamp DESC LIMIT 5;
--   -- expect: every row has an FA-INB- id, and audit_timestamp renders as a
--   --         timestamp rather than a quoted string
--
-- After the workflow re-import, one fresh audit should show an FA-IN- id (no B):
--   SELECT audit_id FROM field_audit_logs ORDER BY created_at DESC LIMIT 1;
--
-- A half-yearly range now works, which is the whole point:
--   SELECT count(*) FROM field_audit_logs
--    WHERE site_id = 'SITE-THN-603'
--      AND audit_timestamp >= '2026-07-01' AND audit_timestamp < '2027-01-01';
--
-- ===========================================================================
-- ROLLBACK
-- ===========================================================================
--   DROP INDEX IF EXISTS idx_fal_site_audit_time;
--   DROP INDEX IF EXISTS idx_fal_audit_id_unique;
--   ALTER TABLE field_audit_logs DROP COLUMN IF EXISTS audit_id;
--   ALTER TABLE field_audit_logs
--       ALTER COLUMN audit_timestamp TYPE text
--       USING to_char(audit_timestamp, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
--
-- The text round-trip is lossless for values this workflow wrote, because it wrote
-- them in exactly that format. It would not be lossless for a value inserted by
-- hand in another format, so check before relying on it.
-- ===========================================================================
