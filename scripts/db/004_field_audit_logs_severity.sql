-- ---------------------------------------------------------------------------
-- 004 — Severity model for the India audit log
-- ---------------------------------------------------------------------------
-- Until now field_audit_logs recorded a verdict and a flat list of violation
-- strings. "ISI mark not visible" and "gauge needle in the red zone" landed in
-- the same undifferentiated NON-COMPLIANT, so the record could not answer the
-- only question an ops manager actually has: do I send someone now?
--
-- These columns are what the workflow's DERIVE_Verdict step computes. The verdict
-- itself is now derived in code from them (roadmap 7.1) rather than taken from
-- the model's own `status` field, which means the stored status is reproducible
-- from the stored severities — you can audit the audit.
--
-- WHAT IS NOT CHANGED, DELIBERATELY:
--
--   violations  stays TEXT holding stringified JSON. Every existing row uses that
--               shape and every reader already parses it. Converting it to jsonb
--               would rewrite the table, break rows containing non-JSON text, and
--               buy nothing the new `deficiencies` column does not already give.
--               deficiencies is the structured record; violations is the flat
--               human-readable line, kept for continuity.
--
--   audit_timestamp  stays TEXT. Fixing that type is a separate, riskier
--               migration; queries filter and order on created_at instead. See
--               IND_FIRE_AUDIT_WORKFLOW.md §5.
--
-- All new columns are nullable with no default, so this is additive and safe on a
-- live table: existing rows get NULL, nothing is rewritten, and adding a nullable
-- column with no default does not rewrite the heap in PostgreSQL 11+.
--
-- ⚠️ ROWS WRITTEN BEFORE THIS MIGRATION HAVE NULL IN EVERY NEW COLUMN, and there
-- is no backfill — the severities were never computed for them. An older India
-- record therefore shows a status and violation strings but no tier breakdown.
-- The UI treats all of these as optional for exactly that reason.
--
-- ⚠️ THE MIGRATION ALONE CHANGES NOTHING VISIBLE.
-- AI_Field_Audit_v2.json must also be re-imported into n8n — that workflow is
-- what writes the rows. Run this FIRST: until the re-import these columns simply
-- stay NULL, whereas re-importing first would make every insert fail on unknown
-- columns and take India audits down.
--
-- Run:
--   docker exec -i ai-stack-postgres-1 sh -c \
--     'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < scripts/db/004_field_audit_logs_severity.sql
--
-- Verify:
--   docker exec ai-stack-postgres-1 sh -c \
--     'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "\d field_audit_logs"'
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    col   text;
    coltype text;
    spec  text[][] := ARRAY[
        -- Structured findings. jsonb, not text: these are machine-read by the
        -- report renderer, and a GIN index on them becomes possible later
        -- ("every audit with a CRITICAL access obstruction") without another
        -- rewrite.
        ARRAY['deficiencies',        'jsonb'],
        ARRAY['unverifiable_items',  'jsonb'],
        ARRAY['reinspect_reasons',   'jsonb'],

        -- Denormalised counts. Derivable from deficiencies, stored anyway: the
        -- Records list needs them for every row it renders, and extracting them
        -- from jsonb per row on every listing query is a cost paid forever to
        -- save four smallints written once.
        ARRAY['critical_count',      'integer'],
        ARRAY['major_count',         'integer'],
        ARRAY['minor_count',         'integer'],
        ARRAY['deficiency_count',    'integer'],

        -- 0-100, CRITICAL 100 / MAJOR 25 / MINOR 5, capped. Same weights as the
        -- US workflow so a risk score means the same thing in both regions.
        ARRAY['risk_score',          'integer'],

        -- critical is a boolean rather than an inference from critical_count > 0
        -- so the "attend now" queue is an index lookup, not arithmetic.
        ARRAY['critical',            'boolean'],

        -- Evidence quality. A photograph that cannot settle the checklist must be
        -- distinguishable from one that shows compliance — collapsing the two is
        -- how a REINSPECT becomes a false pass.
        ARRAY['image_quality',       'text'],
        ARRAY['reinspect_required',  'boolean']
    ];
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'field_audit_logs'
    ) THEN
        RAISE NOTICE 'field_audit_logs does not exist - nothing to migrate. Skipping.';
        RETURN;
    END IF;

    -- Each column added independently so a partially-applied state converges on
    -- re-run rather than aborting. That table's shape cannot be proved from
    -- source control, so every step checks before it acts.
    FOR i IN 1 .. array_length(spec, 1) LOOP
        col     := spec[i][1];
        coltype := spec[i][2];

        IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'field_audit_logs'
              AND column_name = col
        ) THEN
            RAISE NOTICE 'field_audit_logs.% already present.', col;
        ELSE
            EXECUTE format('ALTER TABLE field_audit_logs ADD COLUMN %I %s', col, coltype);
            RAISE NOTICE 'Added field_audit_logs.% (%).', col, coltype;
        END IF;
    END LOOP;

    -- "Show me open critical findings" is the query this table exists to answer
    -- quickly. Partial, because the overwhelming majority of rows are not
    -- critical and indexing their FALSE/NULL wastes the index.
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'idx_fa_critical'
    ) THEN
        -- EXECUTE, not a bare CREATE INDEX: the predicate references a column
        -- this same block may have just added, and a statement written inline
        -- would be parsed against the catalogue as it stood when the block was
        -- planned.
        EXECUTE 'CREATE INDEX idx_fa_critical ON field_audit_logs (created_at DESC) WHERE critical';
        RAISE NOTICE 'Created idx_fa_critical on field_audit_logs.';
    ELSE
        RAISE NOTICE 'idx_fa_critical already present.';
    END IF;

    -- Status filtering is exposed by the Records search, and the table had no
    -- index supporting it.
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'idx_fa_status_created'
    ) THEN
        EXECUTE 'CREATE INDEX idx_fa_status_created ON field_audit_logs (status, created_at DESC)';
        RAISE NOTICE 'Created idx_fa_status_created on field_audit_logs.';
    ELSE
        RAISE NOTICE 'idx_fa_status_created already present.';
    END IF;
END $$;
