-- ---------------------------------------------------------------------------
-- 003 — Bring the India audit log up to parity with the US one
-- ---------------------------------------------------------------------------
-- field_audit_logs was created ad hoc and records only nine columns. Three
-- absences have real consequences in the app:
--
--   asset_tag     A site holds many devices and is audited repeatedly, so
--                 without it two audits of one address are indistinguishable —
--                 the "duplicate site ID" complaint.
--   inspector_id  "Captured by" is permanently blank on an India report, so the
--                 record cannot say who took the photograph.
--   image_url     A retrieved India record has NO evidence photo at all. This is
--                 the largest of the three: a fire-safety record whose evidence
--                 cannot be reproduced is barely a record.
--
-- All three are plain nullable TEXT, so this is additive and safe on a live
-- table: existing rows get NULL, nothing is rewritten, no lock beyond a brief
-- ACCESS EXCLUSIVE for the catalogue update. Adding a nullable column with no
-- default does not rewrite the heap in PostgreSQL 11+.
--
-- ⚠️ THE MIGRATION ALONE CHANGES NOTHING VISIBLE.
-- AI_Field_Audit_v2.json must also be re-imported into n8n, because that
-- workflow is what writes the rows. Until it is, these columns stay NULL on new
-- audits and the app behaves exactly as before — which is the safe ordering:
-- run this first, re-import second.
--
-- Run:
--   docker exec -i ai-stack-postgres-1 sh -c \
--     'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < scripts/db/003_field_audit_logs_parity.sql
--
-- Verify:
--   docker exec ai-stack-postgres-1 sh -c \
--     'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "\d field_audit_logs"'
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'field_audit_logs'
    ) THEN
        RAISE NOTICE 'field_audit_logs does not exist - nothing to migrate. Skipping.';
        RETURN;
    END IF;

    -- Each column added independently so a partially-applied state converges on
    -- re-run rather than aborting.
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'field_audit_logs'
          AND column_name = 'asset_tag'
    ) THEN
        ALTER TABLE field_audit_logs ADD COLUMN asset_tag TEXT;
        RAISE NOTICE 'Added field_audit_logs.asset_tag.';
    ELSE
        RAISE NOTICE 'field_audit_logs.asset_tag already present.';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'field_audit_logs'
          AND column_name = 'inspector_id'
    ) THEN
        ALTER TABLE field_audit_logs ADD COLUMN inspector_id TEXT;
        RAISE NOTICE 'Added field_audit_logs.inspector_id.';
    ELSE
        RAISE NOTICE 'field_audit_logs.inspector_id already present.';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'field_audit_logs'
          AND column_name = 'image_url'
    ) THEN
        ALTER TABLE field_audit_logs ADD COLUMN image_url TEXT;
        RAISE NOTICE 'Added field_audit_logs.image_url.';
    ELSE
        RAISE NOTICE 'field_audit_logs.image_url already present.';
    END IF;

    -- Mirrors idx_faus_asset_tag from migration 001. Partial, because most
    -- historical rows will never have a tag and there is no reason to index
    -- their NULLs.
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'idx_fa_asset_tag'
    ) THEN
        CREATE INDEX idx_fa_asset_tag
            ON field_audit_logs (asset_tag)
            WHERE asset_tag IS NOT NULL;
        RAISE NOTICE 'Created idx_fa_asset_tag on field_audit_logs.';
    END IF;
END $$;
