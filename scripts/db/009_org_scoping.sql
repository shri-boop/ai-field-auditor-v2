-- ===========================================================================
-- 009 — org_id: multi-tenant scoping on the audit and sign-off tables
-- ===========================================================================
--
-- WHY THIS EXISTS, AND WHY NOW
-- ---------------------------
-- The sign-off design settled on organisation-scoped roles: a Phoenix supervisor
-- must not be able to override a rejection in Denver, because that is not a
-- permissions nicety, it is who carries the licence risk for that job.
--
-- Org-scoped roles commit the product to multi-tenancy, and multi-tenancy has to
-- reach the audit data. It did not. Before this migration:
--
--   * neither field_audit_us_logs nor field_audit_logs had any tenant column
--   * the Records query filtered on site_id only -- and site_id is CALLER-SUPPLIED
--   * one shared HTTP Basic credential served every user
--
-- Harmless with one tenant and one password. The moment there are two customers it
-- is a data-isolation breach: a user in one organisation could read another's audits
-- by guessing a site_id, and two customers who both name a building SITE-001 would
-- share rows, history, and each other's Form B evidence.
--
-- Doing this now costs one column and a handful of rows. Doing it after signatures
-- exist means re-scoping audits that append-only signature rows already reference,
-- across two regions. That is the same unrecoverable-if-deferred argument that
-- migration 006 made for audit_id.
--
-- THE TENANCY MODEL, STATED SO IT IS NOT REDISCOVERED LATER
-- --------------------------------------------------------
-- Shared database, row-level scoping by org_id. Not one deployment per customer
-- (which forbids trials and caps the product at bespoke consulting), and not one
-- database per tenant (over-built before revenue).
--
-- This keeps the door open in the direction that matters: a demanding enterprise
-- tenant can later be extracted to its own database. The reverse migration --
-- single-tenant to multi-tenant -- is the one nobody survives.
--
-- org_id IS A REFERENCE, NOT A SNAPSHOT
-- -------------------------------------
-- Deliberately different from how credentials are handled. Snapshot what was
-- attested; reference what is merely scoped.
--
-- A credential is frozen onto each signature because its historical value IS the
-- point (SIGNOFF_DESIGN section 2). An audit's owning organisation is a scoping key:
-- if a company rebrands, every one of its audits should show the new name. So org_id
-- holds a stable identifier and no org_name is frozen onto audit rows. Names are
-- resolved at render time from the accounts database.
--
-- NULLABLE, FOR THE SAME REASON audit_id WAS
-- ------------------------------------------
-- org_id cannot be populated yet. Nothing in the audit path carries a user
-- identity: /api/audit authenticates to n8n with a shared key and has no session,
-- so there is nothing to derive an organisation from. That arrives with step 4.
--
-- The column exists now anyway, because its absence is what would cause steps 5
-- through 8 to be written against an unscoped model and then need revisiting. A NOT
-- NULL constraint here would instead fail every insert until auth ships.
--
-- Add NOT NULL in a later migration once no post-auth row has a null org_id.
--
-- ⚠️⚠️ THIS MIGRATION DOES NOT MAKE THE SYSTEM SAFE FOR TWO CUSTOMERS ⚠️⚠️
-- ---------------------------------------------------------------------------
-- It adds the column, the indexes, and the guarantee that a caller cannot inject a
-- tenant scope. It does NOT deliver tenant isolation, and nothing here should be read
-- as saying it does.
--
-- What is still true after this migration:
--
--   * NOTHING POPULATES org_id. New rows are NULL. There is no session in the audit
--     path to derive an organisation from until SIGNOFF_DESIGN section 11 step 4.
--   * NO READ PATH FILTERS ON IT. The Records query in build_history_workflow.py
--     still filters on site_id alone, and site_id is caller-supplied.
--   * ONE SHARED HTTP BASIC CREDENTIAL still serves every user.
--
-- So a user in one organisation could still read another's audits by guessing a
-- site_id, and two customers who both name a building SITE-001 would still share
-- rows. This migration makes that FIXABLE; it does not fix it.
--
-- DO NOT ONBOARD A SECOND CUSTOMER until all three are true:
--   1. authentication exists and the proxy resolves a real org_id (steps 4-5)
--   2. every read path filters on that server-derived org_id, not on request input
--   3. org_id is NOT NULL, verified with zero nulls on post-auth rows
--
-- Written at length because a schema that looks multi-tenant is exactly the thing that
-- produces false confidence six months from now, when the reasoning has been forgotten
-- and only the column remains.
--
-- ⚠️ org_id MUST NEVER BE CALLER-SUPPLIED
-- ---------------------------------------
-- That is the mistake site_id already makes and the reason this migration is
-- needed. When auth lands, the chain is:
--
--   authenticated session -> proxy resolves the org -> proxy sends org_id -> workflow writes it
--
-- The request body is not part of that chain. VALIDATE_Input ignores any org_id in
-- the body, and a test asserts it. Every read must filter on a server-derived
-- org_id, never on a value the caller chose.
--
-- Idempotent and safe to re-run.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Pre-flight. Both questions, per the lesson from 005.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    us_rows  bigint := 0;
    in_rows  bigint := 0;
    sig_rows bigint := 0;
BEGIN
    SELECT count(*) INTO us_rows  FROM field_audit_us_logs;
    SELECT count(*) INTO in_rows  FROM field_audit_logs;
    SELECT count(*) INTO sig_rows FROM field_audit_signoffs;

    RAISE NOTICE '009: rows to scope -- US %, India %, signoffs %', us_rows, in_rows, sig_rows;
    RAISE NOTICE '009: all of them will be assigned to the internal sentinel org';
END $$;

-- ---------------------------------------------------------------------------
-- 2. The columns.
-- ---------------------------------------------------------------------------
ALTER TABLE field_audit_us_logs   ADD COLUMN IF NOT EXISTS org_id text;
ALTER TABLE field_audit_logs      ADD COLUMN IF NOT EXISTS org_id text;

-- On the signoff table too. It could be derived by joining back to the audit, but
-- denormalising it makes "everything my organisation signed" a single-table query,
-- and makes an accidental cross-tenant read harder to write rather than merely
-- unlikely. record_signoff() copies it from the audit row, so the two cannot
-- disagree -- see scripts/db/functions/record_signoff.sql.
ALTER TABLE field_audit_signoffs  ADD COLUMN IF NOT EXISTS org_id text;

COMMENT ON COLUMN field_audit_us_logs.org_id IS
    'Owning organisation. Server-derived from the authenticated session, NEVER from '
    'the request body. A reference, not a snapshot: org names resolve at render time. '
    'Nullable until auth ships (migration 009).';
COMMENT ON COLUMN field_audit_logs.org_id IS
    'Owning organisation. Server-derived, never caller-supplied. See migration 009.';
COMMENT ON COLUMN field_audit_signoffs.org_id IS
    'Copied from the audit row by record_signoff(), so it cannot disagree with it.';

-- ---------------------------------------------------------------------------
-- 3. Backfill to a visibly-internal sentinel.
--
-- Every existing row is KRATU's own test and demo data, not a customer's. The
-- sentinel says so in the value itself, for the same reason migration 006 marked
-- backfilled identifiers FA-INB- rather than blending them in: a reader should be
-- able to tell provenance from the row, without consulting a migration history.
--
-- It also means the first real customer's data is trivially separable from the
-- demo data it will sit beside.
-- ---------------------------------------------------------------------------
UPDATE field_audit_us_logs  SET org_id = 'ORG-KRATU-INTERNAL' WHERE org_id IS NULL;
UPDATE field_audit_logs     SET org_id = 'ORG-KRATU-INTERNAL' WHERE org_id IS NULL;
UPDATE field_audit_signoffs SET org_id = 'ORG-KRATU-INTERNAL' WHERE org_id IS NULL;

-- ---------------------------------------------------------------------------
-- 4. A blank org_id is worse than a null one: null is honestly "not yet scoped",
--    whereas '' or '  ' looks scoped and matches nothing.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'faus_org_id_not_blank') THEN
        ALTER TABLE field_audit_us_logs ADD CONSTRAINT faus_org_id_not_blank
            CHECK (org_id IS NULL OR btrim(org_id) <> '');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fal_org_id_not_blank') THEN
        ALTER TABLE field_audit_logs ADD CONSTRAINT fal_org_id_not_blank
            CHECK (org_id IS NULL OR btrim(org_id) <> '');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fas_org_id_not_blank') THEN
        ALTER TABLE field_audit_signoffs ADD CONSTRAINT fas_org_id_not_blank
            CHECK (org_id IS NULL OR btrim(org_id) <> '');
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Indexes. Every tenant-facing query leads with org_id, so it leads here too.
--    A scoped query that cannot use an index becomes a full scan across every
--    tenant's data, which is both slow and the wrong shape of risk.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_faus_org_time
    ON field_audit_us_logs (org_id, audit_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_fal_org_time
    ON field_audit_logs (org_id, audit_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_fal_org_site_time
    ON field_audit_logs (org_id, site_id, audit_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_faus_org_site_time
    ON field_audit_us_logs (org_id, site_id, audit_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_fas_org
    ON field_audit_signoffs (org_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 6. Pending-signoff views gain org_id, so the queue can be scoped per tenant.
--
-- DROP then CREATE, not CREATE OR REPLACE.
--
-- CREATE OR REPLACE VIEW can only APPEND columns; it cannot reorder or rename
-- existing ones. Migration 007 created this view with audit_id first, so replacing it
-- with org_id first is read by Postgres as renaming column 1, and it refuses:
--
--     ERROR:  cannot change name of view column "audit_id" to "org_id"
--
-- The first attempt at this migration hit exactly that and rolled back whole, which
-- is why this is worth a comment rather than a silent reordering.
--
-- org_id leads deliberately rather than being appended at the end where REPLACE would
-- have tolerated it: it is the primary scoping key, and a column list starting with it
-- is a standing reminder that every query against this view must filter on it.
--
-- DROP ... IF EXISTS without CASCADE is the safe form. If anything ever comes to
-- depend on this view, the DROP fails loudly here instead of silently taking the
-- dependent object with it.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_fal_awaiting_signoff;

CREATE VIEW v_fal_awaiting_signoff AS
SELECT org_id,
       audit_id,
       id AS record_id,
       site_id,
       asset_tag,
       equipment_type,
       status,
       COALESCE(critical, FALSE) AS critical,
       risk_score,
       confidence,
       image_quality,
       audit_timestamp
FROM   field_audit_logs
WHERE  signoff_status = 'PENDING'
  AND  COALESCE(status, '') <> 'ERROR'
ORDER BY COALESCE(critical, FALSE) DESC, risk_score DESC NULLS LAST, audit_timestamp ASC;

-- A tenant-scoped read is only safe if the caller cannot omit the scope. This view
-- is deliberately NOT a substitute for a WHERE org_id = ... in the query that uses
-- it; it exposes the column so that filter is possible, and nothing more.
COMMENT ON VIEW v_fal_awaiting_signoff IS
    'India pending sign-off queue, worst first. Exposes org_id: every caller MUST '
    'filter on a server-derived org_id. Selecting from this view unfiltered returns '
    'every tenant.';

COMMIT;

-- ===========================================================================
-- NEXT
-- ===========================================================================
--   1. Apply scripts/db/functions/record_signoff.sql. It replaces the function so
--      that a sign-off copies org_id from the audit row it is signing.
--
--   2. Verify:
--        psql ... < scripts/db/009_verify.sql
--        psql ... < scripts/db/functions/record_signoff_verify.sql
--
--   3. Re-import BOTH workflows. India's VALIDATE_Input gains an explicit guard
--      that ignores a caller-supplied org_id; the US node drops its now-unreachable
--      'UNKNOWN-SITE' default in the same import.
--
--   4. Still open, by design: nothing populates org_id yet. It stays
--      'ORG-KRATU-INTERNAL' on backfilled rows and NULL on new ones until step 4
--      delivers authentication and the proxy can resolve a real organisation.
--      Add NOT NULL only after that.
-- ===========================================================================
