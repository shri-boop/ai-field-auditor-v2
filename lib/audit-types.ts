/**
 * The audit response contract, shared by a live audit and a retrieved record.
 *
 * These types were inline in audit-console.tsx while there was exactly one
 * consumer. The records browser is the second, and the whole reason
 * SHAPE_Results normalises both database tables into this same shape is so that
 * one renderer can serve both — a retrieved record and a fresh one are the same
 * object as far as the UI is concerned. Keeping the contract here is what stops
 * that promise quietly decaying into two divergent shapes.
 *
 * Every field is optional. The India workflow returns a small flat object, the
 * US workflow a much richer one (scripts/nodes/07_shape_response.js), and a
 * retrieved record is missing the couple of fields that are composed at audit
 * time and never persisted.
 */

export interface Deficiency {
  code?: string;
  severity?: string;
  finding?: string;
  observed?: string;
  requirement?: string;
  code_reference?: string;
  remediation?: string;
  verification_needed?: boolean;
}

export interface CodeBasis {
  jurisdiction_resolved?: string;
  jurisdiction_label?: string;
  exact_match?: boolean;
  fire_code?: string;
  fire_code_edition?: string;
  life_safety_code?: string;
  ahj_label?: string;
  osha_overlay?: string;
  state_overlays?: string[];
  requires_ahj_confirmation?: boolean;
  code_basis_confident?: boolean;
}

export interface AuditResult {
  status?: string;
  confidence?: string;
  equipment_type?: string;
  equipment_subtype?: string;
  observations?: string;
  violations?: string[] | string;
  site_id?: string;
  audit_timestamp?: string;

  audit_id?: string | null;
  /** India's integer primary key — its analogue of audit_id. */
  record_id?: number | null;
  persisted?: boolean;

  critical?: boolean;
  risk_score?: number;
  severity_counts?: { critical?: number; major?: number; minor?: number };
  deficiencies?: Deficiency[] | string;
  unverifiable_items?: string[] | string;
  image_quality?: string;
  reinspect_required?: boolean;
  reinspect_reasons?: string[] | string;

  impairment_suspected?: boolean;
  impairment_basis?: string;
  /** Composed by BUILD_Report at audit time and never persisted, so a retrieved
   *  record has the basis but not the full NFPA 25 Ch. 15 action checklist. */
  impairment_notice?: string;

  sla_hours?: number;
  remediation_due_at?: string;
  remediation_status?: string;
  local_timestamp?: string;
  local_remediation_due?: string;

  code_basis?: CodeBasis;
  advisory_only?: boolean;
  signoff_status?: string;
  signoff_by?: string | null;
  signoff_at?: string | null;
  /** Also composed at audit time and not persisted. */
  scope_note?: string;

  jurisdiction?: string;
  occupancy_type?: string;
  inspector_id?: string;
  asset_tag?: string | null;
  image_url?: string | null;

  model_used?: string;
  latency_ms?: number;

  /** Set by SHAPE_Results so the UI can label an archived record. */
  retrieved?: boolean;
  created_at?: string;
}

export interface AuditError {
  code?: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Verdict colour. Deliberately NOT the brand accent: green-means-pass is close
// to sacred in life-safety work, and the action orange is reserved for controls
// so a status can never be confused with something clickable.
// ---------------------------------------------------------------------------

export type Tone = 'good' | 'warn' | 'bad' | 'neutral';

export interface ToneSpec {
  rule: string;
  fill: string;
  text: string;
}

export const TONES: Record<Tone, ToneSpec> = {
  good: { rule: 'var(--kr-pass)', fill: 'var(--kr-pass-dim)', text: 'var(--kr-pass)' },
  warn: { rule: 'var(--kr-warn)', fill: 'var(--kr-warn-dim)', text: 'var(--kr-warn)' },
  bad: { rule: 'var(--kr-fail)', fill: 'var(--kr-fail-dim)', text: 'var(--kr-fail)' },
  neutral: { rule: 'var(--kr-hairline)', fill: 'transparent', text: 'var(--kr-muted)' },
};

export function statusTone(status: string | undefined): Tone {
  switch ((status ?? '').toUpperCase()) {
    case 'COMPLIANT':
      return 'good';
    case 'CONDITIONAL':
    case 'REINSPECT':
      return 'warn';
    case 'NON-COMPLIANT':
    case 'ERROR':
    case 'REJECTED':
      return 'bad';
    default:
      return 'neutral';
  }
}

export const SEVERITY_COLOR: Record<string, string> = {
  CRITICAL: 'var(--kr-critical)',
  MAJOR: 'var(--kr-major)',
  MINOR: 'var(--kr-minor)',
};

export const SEVERITY_ORDER: Record<string, number> = { CRITICAL: 0, MAJOR: 1, MINOR: 2 };

/**
 * Tolerates the stringified-JSON array the India workflow emits, and the same
 * value arriving already parsed from a jsonb column.
 */
export function asArray<T>(value: T[] | string | undefined): T[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Deficiencies sorted CRITICAL → MAJOR → MINOR, unknown severities last. */
export function sortedDeficiencies(value: Deficiency[] | string | undefined): Deficiency[] {
  return [...asArray<Deficiency>(value)].sort(
    (a, b) =>
      (SEVERITY_ORDER[(a.severity ?? '').toUpperCase()] ?? 9) -
      (SEVERITY_ORDER[(b.severity ?? '').toUpperCase()] ?? 9),
  );
}
