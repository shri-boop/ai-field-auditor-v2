-- ---------------------------------------------------------------------------
-- 002 — Index the India audit log for records lookup
-- ---------------------------------------------------------------------------
-- The US table ships with idx_faus_site_time on (site_id, audit_timestamp DESC)
-- from migration 001. The India table has no DDL in this repo — it was created
-- ad hoc — and carries only its primary key index:
--
--   Table "public.field_audit_logs"
--     id              integer  PRIMARY KEY (field_audit_logs_pkey)
--     equipment_type  text
--     status          text
--     confidence      text
--     observations    text
--     violations      text
--     site_id         text
--     audit_timestamp text          <-- NOT a timestamp type
--     created_at      timestamptz DEFAULT now()
--
-- So "audits for this site, newest first" is a sequential scan plus a sort.
--
-- ⚠️ THE INDEX IS ON created_at, NOT audit_timestamp.
-- audit_timestamp is text. `text >= timestamptz` has no operator in Postgres, so
-- the records query cannot filter it against a typed parameter and instead uses
-- created_at, which is a real timestamptz written by DEFAULT now() in the same
-- statement. The index has to match the column the query actually orders and
-- filters on, or it will never be used.
--
-- WHY EVERY STEP IS GUARDED
-- A bare CREATE INDEX would abort the whole migration on a server where this
-- ad-hoc table differs. Each column is checked first, so this file is safe to
-- re-run and safe on a server that has never recorded an India audit.
--
-- Run:
--   docker exec -i ai-stack-postgres-1 sh -c \
--     'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < scripts/db/002_field_audit_logs_index.sql
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'field_audit_logs'
    ) THEN
        RAISE NOTICE 'field_audit_logs does not exist - nothing to index. Skipping.';
        RETURN;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'field_audit_logs'
          AND column_name = 'site_id'
    ) OR NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'field_audit_logs'
          AND column_name = 'created_at'
    ) THEN
        RAISE NOTICE 'field_audit_logs is missing site_id or created_at - the '
                     'assumed shape is wrong. Skipping, no changes made.';
        RETURN;
    END IF;

    -- The records query's hot path: WHERE site_id = $1 ORDER BY created_at DESC.
    -- DESC matches the ORDER BY so the index can satisfy the sort rather than
    -- requiring a separate sort step.
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'idx_fa_site_created'
    ) THEN
        CREATE INDEX idx_fa_site_created
            ON field_audit_logs (site_id, created_at DESC);
        RAISE NOTICE 'Created idx_fa_site_created on field_audit_logs.';
    ELSE
        RAISE NOTICE 'idx_fa_site_created already present.';
    END IF;

    -- Supports a date-range-only query, with no site filter.
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'idx_fa_created'
    ) THEN
        CREATE INDEX idx_fa_created
            ON field_audit_logs (created_at DESC);
        RAISE NOTICE 'Created idx_fa_created on field_audit_logs.';
    END IF;
END $$;
