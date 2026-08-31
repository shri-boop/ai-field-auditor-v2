-- ============================================================================
-- 001_field_audit_us_logs.sql
--
-- Audit log for the US (NFPA / IFC) field audit workflow.
--
-- A separate table from the India workflow's `field_audit_logs` is deliberate:
--   1. The India table stores `violations` as a stringified JSON text column.
--      US findings are structured objects (severity, code citation, remediation,
--      SLA) and need jsonb to be queryable.
--   2. US audits must record WHICH code basis was applied, because the answer
--      differs by state. That has no counterpart in the India schema.
--   3. Altering a live table that an active workflow writes to is avoidable
--      risk. This migration is purely additive and cannot break India.
--
-- Idempotent: safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS field_audit_us_logs (
    -- Identity ---------------------------------------------------------------
    audit_id                TEXT PRIMARY KEY,
    idempotency_key         TEXT,

    -- Site and jurisdiction --------------------------------------------------
    site_id                 TEXT NOT NULL,
    asset_tag               TEXT,
    inspector_id            TEXT,
    jurisdiction            TEXT NOT NULL,
    ahj_label               TEXT,
    occupancy_type          TEXT,
    -- Full snapshot of the code basis applied at audit time. Stored rather than
    -- referenced, so a historical audit remains interpretable even after the
    -- jurisdiction registry is updated to a newer code edition.
    code_basis              JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Subject ----------------------------------------------------------------
    equipment_type          TEXT,
    equipment_subtype       TEXT,

    -- Verdict ----------------------------------------------------------------
    status                  TEXT NOT NULL,
    critical                BOOLEAN NOT NULL DEFAULT FALSE,
    confidence              TEXT,
    image_quality           TEXT,
    risk_score              INTEGER NOT NULL DEFAULT 0,

    -- Findings ---------------------------------------------------------------
    deficiency_count        INTEGER NOT NULL DEFAULT 0,
    critical_count          INTEGER NOT NULL DEFAULT 0,
    major_count             INTEGER NOT NULL DEFAULT 0,
    minor_count             INTEGER NOT NULL DEFAULT 0,
    deficiencies            JSONB NOT NULL DEFAULT '[]'::jsonb,
    violations              JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- Checks a still photograph cannot settle. Retained because it is the
    -- evidentiary boundary of the automated pass.
    unverifiable_items      JSONB NOT NULL DEFAULT '[]'::jsonb,
    observations            TEXT,

    -- Impairment (NFPA 25 Ch. 15 and equivalents) -----------------------------
    impairment_suspected    BOOLEAN NOT NULL DEFAULT FALSE,
    impairment_basis        TEXT,

    -- Re-inspection ----------------------------------------------------------
    reinspect_required      BOOLEAN NOT NULL DEFAULT FALSE,
    reinspect_reasons       JSONB NOT NULL DEFAULT '[]'::jsonb,

    -- Evidence ---------------------------------------------------------------
    image_url               TEXT,

    -- Model observability ----------------------------------------------------
    model_used              TEXT,
    prompt_tokens           INTEGER,
    completion_tokens       INTEGER,
    latency_ms              INTEGER,

    -- Governance -------------------------------------------------------------
    -- These columns exist so that an AI screen can never be mistaken for a
    -- certified inspection. `signoff_status` is the human gate.
    advisory_only           BOOLEAN NOT NULL DEFAULT TRUE,
    signoff_status          TEXT NOT NULL DEFAULT 'PENDING',
    signoff_by              TEXT,
    signoff_at              TIMESTAMPTZ,
    signoff_notes           TEXT,

    -- Remediation ------------------------------------------------------------
    sla_hours               INTEGER,
    remediation_due_at      TIMESTAMPTZ,
    remediation_status      TEXT NOT NULL DEFAULT 'OPEN',
    remediation_closed_at   TIMESTAMPTZ,

    -- Timestamps -------------------------------------------------------------
    audit_timestamp         TIMESTAMPTZ NOT NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Constrain the enumerations that drive routing and escalation, so a code
-- regression cannot quietly write an unroutable status.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'field_audit_us_logs_status_chk') THEN
        ALTER TABLE field_audit_us_logs
            ADD CONSTRAINT field_audit_us_logs_status_chk
            CHECK (status IN ('COMPLIANT', 'CONDITIONAL', 'NON-COMPLIANT', 'REINSPECT', 'ERROR'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'field_audit_us_logs_signoff_chk') THEN
        ALTER TABLE field_audit_us_logs
            ADD CONSTRAINT field_audit_us_logs_signoff_chk
            CHECK (signoff_status IN ('PENDING', 'CONFIRMED', 'REJECTED', 'SUPERSEDED'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'field_audit_us_logs_remediation_chk') THEN
        ALTER TABLE field_audit_us_logs
            ADD CONSTRAINT field_audit_us_logs_remediation_chk
            CHECK (remediation_status IN ('OPEN', 'IN_PROGRESS', 'CLOSED', 'NOT_REQUIRED', 'DEFERRED'));
    END IF;
END $$;

-- Indexes ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_faus_site_time
    ON field_audit_us_logs (site_id, audit_timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_faus_jurisdiction
    ON field_audit_us_logs (jurisdiction);

-- Partial index: the operational hot path is "what is still open and critical".
CREATE INDEX IF NOT EXISTS idx_faus_open_critical
    ON field_audit_us_logs (remediation_due_at)
    WHERE critical = TRUE AND remediation_status IN ('OPEN', 'IN_PROGRESS');

CREATE INDEX IF NOT EXISTS idx_faus_pending_signoff
    ON field_audit_us_logs (audit_timestamp DESC)
    WHERE signoff_status = 'PENDING';

CREATE INDEX IF NOT EXISTS idx_faus_impairment
    ON field_audit_us_logs (audit_timestamp DESC)
    WHERE impairment_suspected = TRUE;

-- Query individual findings by checklist code or citation.
CREATE INDEX IF NOT EXISTS idx_faus_deficiencies_gin
    ON field_audit_us_logs USING GIN (deficiencies);

CREATE INDEX IF NOT EXISTS idx_faus_asset_tag
    ON field_audit_us_logs (asset_tag)
    WHERE asset_tag IS NOT NULL;

-- Deliberately NOT unique. Duplicate submissions of the same photo can be
-- collapsed at query time via this key, but a uniqueness constraint here would
-- make the database *reject* an audit row, and an append-only safety log must
-- never drop evidence. The key is a 32-bit FNV-1a hash, so a collision between
-- two genuinely different photographs is possible at scale; under a unique
-- constraint that collision would silently discard a real life-safety finding.
CREATE INDEX IF NOT EXISTS idx_faus_idempotency
    ON field_audit_us_logs (idempotency_key, site_id);

COMMENT ON TABLE field_audit_us_logs IS
    'AI photo-screening audit log for US fire/life-safety inspections (NFPA / IFC). '
    'Rows are advisory pre-inspection screens, NOT certified inspection records. '
    'A row becomes usable for compliance purposes only once signoff_status = CONFIRMED '
    'by a licensed or certified inspector.';

COMMENT ON COLUMN field_audit_us_logs.code_basis IS
    'Snapshot of the jurisdiction-resolved code basis applied at audit time '
    '(fire code, edition, AHJ, OSHA overlay, timezone, referenced standards).';

COMMENT ON COLUMN field_audit_us_logs.unverifiable_items IS
    'Checks that cannot be settled from a still photograph (agent weight, internal '
    'condition, functional tests). Defines the evidentiary limit of the automated pass.';

-- ============================================================================
-- Operational views
-- ============================================================================

-- Open critical findings, worst first. This is the escalation queue.
CREATE OR REPLACE VIEW v_faus_open_critical AS
SELECT audit_id,
       site_id,
       asset_tag,
       jurisdiction,
       equipment_type,
       status,
       risk_score,
       critical_count,
       major_count,
       impairment_suspected,
       remediation_due_at,
       signoff_status,
       audit_timestamp
FROM   field_audit_us_logs
WHERE  critical = TRUE
  AND  remediation_status IN ('OPEN', 'IN_PROGRESS')
ORDER BY risk_score DESC, audit_timestamp DESC;

-- Findings exploded to one row per deficiency, for trend analysis such as
-- "which checklist item fails most often across the portfolio".
CREATE OR REPLACE VIEW v_faus_deficiency_detail AS
SELECT l.audit_id,
       l.site_id,
       l.jurisdiction,
       l.equipment_type,
       l.audit_timestamp,
       d ->> 'code'            AS deficiency_code,
       d ->> 'severity'        AS severity,
       d ->> 'finding'         AS finding,
       d ->> 'code_reference'  AS code_reference,
       d ->> 'remediation'     AS remediation
FROM   field_audit_us_logs l
CROSS JOIN LATERAL jsonb_array_elements(l.deficiencies) AS d;

-- Screens awaiting a licensed inspector's decision.
CREATE OR REPLACE VIEW v_faus_awaiting_signoff AS
SELECT audit_id,
       site_id,
       jurisdiction,
       equipment_type,
       status,
       critical,
       risk_score,
       confidence,
       image_quality,
       audit_timestamp
FROM   field_audit_us_logs
WHERE  signoff_status = 'PENDING'
  AND  status <> 'ERROR'
ORDER BY critical DESC, risk_score DESC, audit_timestamp ASC;
