-- ---------------------------------------------------------------------------
-- 002 — Index the India audit log for records lookup
-- ---------------------------------------------------------------------------
-- The US table ships with idx_faus_site_time on (site_id, audit_timestamp DESC)
-- from migration 001. The India table has no DDL in this repo at all: it was
-- created ad hoc, and the India workflow writes seven columns into it. It very
-- likely has no indexes, which means every "audits for this site, newest first"
-- lookup is a sequential scan plus a sort.
--
-- WHY THIS IS GUARDED RATHER THAN A PLAIN CREATE INDEX
-- Because nobody can currently prove that table's shape from source control.
-- A bare CREATE INDEX would abort the whole migration on a server where the
-- table or a column is named differently, so every check is explicit and this
-- file is safe to run repeatedly and safe to run on a server that has never had
-- an India audit.
--
-- Run:
--   docker exec -i ai-stack-postgres-1 sh -c \
--     'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < scripts/db/002_field_audit_logs_index.sql
--
-- Confirm the assumption first, and tell us if it differs:
--   docker exec ai-stack-postgres-1 sh -c \
--     'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "\d field_audit_logs"'
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
          AND column_name = 'audit_timestamp'
    ) THEN
        RAISE NOTICE 'field_audit_logs is missing site_id or audit_timestamp - '
                     'the assumed shape is wrong. Skipping, no changes made.';
        RETURN;
    END IF;

    -- Mirrors idx_faus_site_time. DESC because every query in the records view
    -- is "newest first", and a matching sort order lets the index satisfy the
    -- ORDER BY instead of requiring a separate sort step.
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'idx_fa_site_time'
    ) THEN
        CREATE INDEX idx_fa_site_time
            ON field_audit_logs (site_id, audit_timestamp DESC);
        RAISE NOTICE 'Created idx_fa_site_time on field_audit_logs.';
    ELSE
        RAISE NOTICE 'idx_fa_site_time already present.';
    END IF;

    -- Supports the status filter, which the records view offers for both regions.
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'field_audit_logs'
          AND column_name = 'status'
    ) AND NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'idx_fa_status_time'
    ) THEN
        CREATE INDEX idx_fa_status_time
            ON field_audit_logs (status, audit_timestamp DESC);
        RAISE NOTICE 'Created idx_fa_status_time on field_audit_logs.';
    END IF;
END $$;
