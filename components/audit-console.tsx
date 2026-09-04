'use client';

import Image from 'next/image';
import { useMemo, useState, type ChangeEvent, type CSSProperties } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AlertCircle, AlertTriangle, Info, Printer, ShieldAlert, Upload } from 'lucide-react';
import { BRAND } from '@/lib/brand';
import {
  REGIONS,
  US_DEFAULTS,
  US_EQUIPMENT,
  US_JURISDICTIONS,
  US_OCCUPANCIES,
  type Option,
  type RegionKey,
} from '@/lib/regions';

// ---------------------------------------------------------------------------
// Response shape. Every field is optional: the India workflow returns a small
// flat object, the US workflow a much richer one (see scripts/nodes/
// 07_shape_response.js). The UI renders whatever is present.
// ---------------------------------------------------------------------------

interface Deficiency {
  code?: string;
  severity?: string;
  finding?: string;
  observed?: string;
  requirement?: string;
  code_reference?: string;
  remediation?: string;
  verification_needed?: boolean;
}

interface CodeBasis {
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

interface AuditResult {
  status?: string;
  confidence?: string;
  equipment_type?: string;
  equipment_subtype?: string;
  observations?: string;
  violations?: string[] | string;
  site_id?: string;
  audit_timestamp?: string;

  audit_id?: string;
  persisted?: boolean;

  critical?: boolean;
  risk_score?: number;
  severity_counts?: { critical?: number; major?: number; minor?: number };
  deficiencies?: Deficiency[];
  unverifiable_items?: string[];
  image_quality?: string;
  reinspect_required?: boolean;
  reinspect_reasons?: string[];

  impairment_suspected?: boolean;
  impairment_notice?: string;

  sla_hours?: number;
  local_timestamp?: string;
  local_remediation_due?: string;

  code_basis?: CodeBasis;
  advisory_only?: boolean;
  signoff_status?: string;
  scope_note?: string;

  model_used?: string;
  latency_ms?: number;
}

interface AuditError {
  code?: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Verdict colour. Deliberately NOT the brand accent: green-means-pass is close
// to sacred in life-safety work, and the action orange is reserved for controls
// so a status can never be confused with something clickable.
// ---------------------------------------------------------------------------

type Tone = 'good' | 'warn' | 'bad' | 'neutral';

interface ToneSpec {
  rule: string;
  fill: string;
  text: string;
}

const TONES: Record<Tone, ToneSpec> = {
  good: { rule: 'var(--kr-pass)', fill: 'var(--kr-pass-dim)', text: 'var(--kr-pass)' },
  warn: { rule: 'var(--kr-warn)', fill: 'var(--kr-warn-dim)', text: 'var(--kr-warn)' },
  bad: { rule: 'var(--kr-fail)', fill: 'var(--kr-fail-dim)', text: 'var(--kr-fail)' },
  neutral: { rule: 'var(--kr-hairline)', fill: 'transparent', text: 'var(--kr-muted)' },
};

function statusTone(status: string | undefined): Tone {
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

const SEVERITY_COLOR: Record<string, string> = {
  CRITICAL: 'var(--kr-critical)',
  MAJOR: 'var(--kr-major)',
  MINOR: 'var(--kr-minor)',
};

const SEVERITY_ORDER: Record<string, number> = { CRITICAL: 0, MAJOR: 1, MINOR: 2 };

/**
 * Hint for the currently selected option, rendered as helper text beneath the
 * Select rather than inside the list items.
 *
 * shadcn's SelectItem wraps all its children in Radix's ItemText, and Radix
 * mirrors ItemText content into the trigger, so a two-line item renders both
 * lines stacked inside the closed trigger. Keeping items single-line and
 * surfacing the hint separately also keeps it visible while the list is closed,
 * which is when it matters — e.g. "Florida is NFPA-based, not IFC".
 */
function hintFor(options: Option[], value: string): string | undefined {
  return options.find((opt) => opt.value === value)?.hint;
}

/** Tolerates the stringified-JSON array the India workflow used to emit. */
function asArray<T>(value: T[] | string | undefined): T[] {
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

const SELECT_TRIGGER = 'kr-field w-full h-11 rounded-md text-sm data-[placeholder]:text-kr-muted';

export function AuditConsole({ enabledRegions }: { enabledRegions: RegionKey[] }) {
  const [region, setRegion] = useState<RegionKey>(enabledRegions[0] ?? 'IND');
  const [siteId, setSiteId] = useState('');
  const [jurisdiction, setJurisdiction] = useState<string>(US_DEFAULTS.jurisdiction);
  const [occupancy, setOccupancy] = useState<string>(US_DEFAULTS.occupancy_type);
  const [equipmentHint, setEquipmentHint] = useState<string>(US_DEFAULTS.equipment_hint);
  const [oshaWorkplace, setOshaWorkplace] = useState<boolean>(US_DEFAULTS.osha_workplace);

  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);

  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AuditResult | null>(null);
  const [error, setError] = useState<AuditError | null>(null);

  const regionDef = REGIONS[region];
  const showRegionSwitch = enabledRegions.length > 1;
  const state = loading ? 'loading' : result ? 'success' : 'empty';

  const resetOutput = () => {
    setResult(null);
    setError(null);
  };

  const acceptFile = (candidate: File | undefined) => {
    if (!candidate || !candidate.type.startsWith('image/')) return;
    setFile(candidate);
    setPreview(URL.createObjectURL(candidate));
    resetOutput();
  };

  const handleRunAudit = async () => {
    if (!file || !siteId) return;

    setLoading(true);
    resetOutput();

    try {
      // 1. Upload to Vercel Blob (host is on the US workflow's SSRF allow-list).
      const formData = new FormData();
      formData.append('image', file);
      const uploadRes = await fetch('/api/upload', { method: 'POST', body: formData });
      const uploadText = await uploadRes.text();

      if (!uploadRes.ok) {
        throw new AuditFailure(
          'UPLOAD_FAILED',
          `Image upload failed (${uploadRes.status}): ${uploadText.slice(0, 200)}`,
        );
      }

      let uploadData: { url?: string };
      try {
        uploadData = JSON.parse(uploadText);
      } catch {
        throw new AuditFailure('UPLOAD_BAD_JSON', 'Image upload returned a non-JSON response.');
      }
      if (!uploadData.url) {
        throw new AuditFailure('UPLOAD_NO_URL', 'Image upload succeeded but returned no URL.');
      }

      // 2. Hand off to the server-side proxy, which picks the webhook for this
      //    region and enforces that the region is enabled on this deployment.
      const payload: Record<string, unknown> = {
        region,
        image_url: uploadData.url,
        site_id: siteId,
      };
      if (region === 'US') {
        payload.jurisdiction = jurisdiction;
        payload.occupancy_type = occupancy;
        payload.equipment_hint = equipmentHint;
        payload.osha_workplace = oshaWorkplace;
      }

      const auditRes = await fetch('/api/audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const auditText = await auditRes.text();

      let data: AuditResult & { error_code?: string; error?: string };
      try {
        data = JSON.parse(auditText);
      } catch {
        throw new AuditFailure(
          'RESPONSE_BAD_JSON',
          `The audit engine returned a non-JSON response (HTTP ${auditRes.status}).`,
        );
      }

      // Structured rejections (VALIDATE_Input -> RESPOND_BadRequest, or the
      // proxy's own region/validation errors) carry error_code + error.
      if (!auditRes.ok) {
        throw new AuditFailure(
          data.error_code ?? `HTTP_${auditRes.status}`,
          data.error ?? `Audit failed with HTTP ${auditRes.status}.`,
        );
      }

      setResult(data);
    } catch (err) {
      if (err instanceof AuditFailure) {
        setError({ code: err.code, message: err.message });
      } else {
        setError({ message: err instanceof Error ? err.message : 'Audit sequence failed.' });
      }
    } finally {
      setLoading(false);
    }
  };

  // ------------------------------------------------------------- derived view
  const tone = statusTone(result?.status);
  const toneSpec = TONES[tone];
  const violations = useMemo(() => asArray<string>(result?.violations), [result]);
  const deficiencies = useMemo(() => {
    const list = asArray<Deficiency>(result?.deficiencies);
    return [...list].sort(
      (a, b) =>
        (SEVERITY_ORDER[(a.severity ?? '').toUpperCase()] ?? 9) -
        (SEVERITY_ORDER[(b.severity ?? '').toUpperCase()] ?? 9),
    );
  }, [result]);
  const unverifiable = useMemo(() => asArray<string>(result?.unverifiable_items), [result]);
  const reinspectReasons = useMemo(() => asArray<string>(result?.reinspect_reasons), [result]);

  const hasFindings = deficiencies.length > 0 || violations.length > 0;
  const codeBasisText = result?.code_basis?.fire_code ?? regionDef.codeBasisFallback;

  const timestamp = result?.local_timestamp
    ? result.local_timestamp
    : result?.audit_timestamp
      ? new Date(result.audit_timestamp).toLocaleString(regionDef.timestampLocale, {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '—';

  return (
    <div className="relative min-h-screen">
      <div className="relative z-10 px-6 py-10 sm:px-10">
        <div className="mx-auto max-w-7xl">
          {/* ===================== MASTHEAD =====================
              Three zones: company lockup, code region, product wordmark. The
              region control lives here rather than in the input column because
              it is not an input — it selects which engine and which code basis
              the whole screen is operating under, so it belongs with identity.
              Moving it up also lets the form start immediately. */}
          <header className="kr-screen-only mb-8 flex flex-wrap items-center justify-between gap-x-8 gap-y-6 border-b border-[var(--kr-hairline)] pb-6">
            <div className="flex items-center gap-4">
              <Image
                src={BRAND.markSrc}
                alt=""
                width={76}
                height={76}
                priority
                className="h-[76px] w-[76px] shrink-0"
              />
              <div>
                <div className="kr-wordmark text-[21px] leading-none">
                  {BRAND.companyFirst} <em>{BRAND.companySecond}</em>
                </div>
                <div className="mt-2 h-px w-full bg-[var(--kr-gold)] opacity-45" />
                <div className="kr-tagline mt-2">{BRAND.tagline}</div>
              </div>
            </div>

            {/* Rendered only when this deployment permits more than one region;
                a single-region deployment shows a static label instead, so a
                customer never learns the other jurisdiction exists. */}
            {showRegionSwitch ? (
              <div className="flex flex-col items-center gap-2">
                <div className="kr-seg" role="group" aria-label="Code region">
                  {enabledRegions.map((key) => {
                    const active = key === region;
                    return (
                      <button
                        key={key}
                        type="button"
                        data-active={active}
                        aria-pressed={active}
                        className="kr-seg-item"
                        onClick={() => {
                          if (key === region) return;
                          setRegion(key);
                          resetOutput();
                        }}
                      >
                        {REGIONS[key].label}
                      </button>
                    );
                  })}
                </div>
                <span className="text-[10px] tracking-wide text-kr-muted">
                  {regionDef.codeLabel}
                </span>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-1.5">
                <span className="kr-eyebrow">{regionDef.label}</span>
                <span className="text-[10px] tracking-wide text-kr-muted">
                  {regionDef.codeLabel}
                </span>
              </div>
            )}

            <div className="text-right">
              <h1 className="kr-script text-[44px]">{BRAND.productWordmark}</h1>
              <p className="kr-label mt-1">{BRAND.productDescriptor}</p>
            </div>
          </header>

          <div className="kr-report-grid grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
            {/* ===================== INPUTS ===================== */}
            <div className="kr-screen-only space-y-6">
              <section className="space-y-3">
                <label htmlFor="site-id" className="kr-eyebrow block">
                  Site ID / Location Code
                </label>
                <Input
                  id="site-id"
                  placeholder={regionDef.siteIdPlaceholder}
                  value={siteId}
                  onChange={(e) => setSiteId(e.target.value)}
                  className="kr-field kr-data h-12 rounded-md px-4 text-sm placeholder:text-kr-muted/50"
                />
              </section>

              {/* US-only. The India workflow hardcodes NBC 2016 + CFO Mumbai and
                  has no jurisdiction concept, so these come from the registry. */}
              {region === 'US' && (
                <section className="kr-card space-y-5 p-5">
                  <span className="kr-eyebrow">Jurisdiction &amp; Scope</span>

                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <label className="kr-label block">Jurisdiction</label>
                      <Select value={jurisdiction} onValueChange={setJurisdiction}>
                        <SelectTrigger className={SELECT_TRIGGER}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {US_JURISDICTIONS.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {hintFor(US_JURISDICTIONS, jurisdiction) && (
                        <p className="text-[10px] leading-relaxed text-kr-muted">
                          {hintFor(US_JURISDICTIONS, jurisdiction)}
                        </p>
                      )}
                    </div>

                    <div className="space-y-2">
                      <label className="kr-label block">Occupancy</label>
                      <Select value={occupancy} onValueChange={setOccupancy}>
                        <SelectTrigger className={SELECT_TRIGGER}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {US_OCCUPANCIES.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="kr-label block">Equipment Checklist</label>
                    <Select value={equipmentHint} onValueChange={setEquipmentHint}>
                      <SelectTrigger className={SELECT_TRIGGER}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {US_EQUIPMENT.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {hintFor(US_EQUIPMENT, equipmentHint) && (
                      <p className="text-[10px] leading-relaxed text-kr-muted">
                        {hintFor(US_EQUIPMENT, equipmentHint)}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center justify-between gap-4 border-t border-[var(--kr-hairline-2)] pt-4">
                    <div>
                      <p className="text-xs font-semibold text-kr-light">OSHA overlay</p>
                      <p className="mt-1 text-[10px] text-kr-muted">
                        Apply 29 CFR 1910 workplace duties
                      </p>
                    </div>
                    <Switch checked={oshaWorkplace} onCheckedChange={setOshaWorkplace} />
                  </div>
                </section>
              )}

              {/* Evidence */}
              <div
                onDrop={(e) => {
                  e.preventDefault();
                  setDragActive(false);
                  acceptFile(e.dataTransfer.files[0]);
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragActive(true);
                }}
                onDragLeave={() => setDragActive(false)}
                onClick={() => document.getElementById('image-input')?.click()}
                className={`kr-card cursor-pointer overflow-hidden transition-colors duration-200 ${
                  dragActive ? 'border-[var(--kr-gold)]' : 'hover:border-[var(--kr-gold-deep)]'
                }`}
              >
                <input
                  id="image-input"
                  type="file"
                  accept="image/*"
                  onChange={(e: ChangeEvent<HTMLInputElement>) => acceptFile(e.target.files?.[0])}
                  className="hidden"
                />

                {preview ? (
                  <div className="relative">
                    {/* Local blob: preview — plain img by design, next/image
                        cannot optimise an in-memory object URL. */}
                    <img src={preview} alt="Audit subject" className="h-60 w-full object-cover" />
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[var(--kr-ink)] via-[var(--kr-ink)]/85 to-transparent p-4">
                      <p className="kr-data truncate text-[11px] text-kr-gold-soft">{file?.name}</p>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center gap-4 p-12">
                    <div className="rounded-md border border-[var(--kr-hairline)] p-3.5">
                      <Upload className="h-6 w-6 text-kr-gold" />
                    </div>
                    <div className="text-center">
                      <p className="text-sm font-semibold text-kr-light">Upload equipment image</p>
                      <p className="kr-label mt-2">Drag &amp; drop or click</p>
                    </div>
                  </div>
                )}
              </div>

              <Button
                onClick={handleRunAudit}
                disabled={!siteId || !file || loading}
                className="kr-action h-14 w-full rounded-md text-[13px] font-bold uppercase tracking-[0.16em] transition-shadow duration-300"
              >
                {loading ? 'Analysing…' : siteId && file ? 'Initiate audit' : 'Awaiting input'}
              </Button>

              {error && (
                <div
                  className="kr-verdict flex items-start gap-3 px-4 py-3"
                  style={{ borderLeftColor: TONES.bad.rule, background: TONES.bad.fill }}
                >
                  <AlertCircle
                    className="mt-0.5 h-4 w-4 shrink-0"
                    style={{ color: TONES.bad.text }}
                  />
                  <div className="space-y-1">
                    {error.code && (
                      <p className="kr-data text-[10px] uppercase tracking-[0.16em] text-kr-muted">
                        {error.code}
                      </p>
                    )}
                    <p className="text-xs text-kr-body">{error.message}</p>
                  </div>
                </div>
              )}

              <p className="kr-label">
                Status: {loading ? 'Processing' : siteId && file ? 'Ready' : 'Incomplete'}
              </p>
            </div>

            {/* ===================== OUTPUT ===================== */}
            <div>
              {state === 'empty' && (
                <div className="kr-card flex min-h-[420px] flex-col items-center justify-center gap-6 p-12">
                  <svg viewBox="0 0 100 100" className="h-16 w-16">
                    <circle
                      cx="50"
                      cy="50"
                      r="34"
                      fill="none"
                      stroke="var(--kr-hairline)"
                      strokeWidth="1"
                    />
                    <circle
                      cx="50"
                      cy="50"
                      r="22"
                      fill="none"
                      stroke="var(--kr-hairline)"
                      strokeWidth="1"
                    />
                    <path
                      d="M50 8 L50 24 M50 76 L50 92 M8 50 L24 50 M76 50 L92 50"
                      stroke="var(--kr-gold)"
                      strokeWidth="1.25"
                      className="kr-sweep"
                    />
                    <circle cx="50" cy="50" r="2.5" fill="var(--kr-gold)" />
                  </svg>
                  <div className="text-center">
                    <p className="kr-eyebrow">Awaiting evidence</p>
                    <p className="mt-3 text-xs text-kr-muted">
                      Upload a photograph to begin
                    </p>
                  </div>
                </div>
              )}

              {state === 'loading' && (
                <div className="kr-card flex min-h-[420px] flex-col items-center justify-center gap-8 p-12">
                  <svg viewBox="0 0 100 100" className="h-24 w-24">
                    <circle
                      cx="50"
                      cy="50"
                      r="36"
                      fill="none"
                      stroke="var(--kr-hairline)"
                      strokeWidth="1.5"
                    />
                    <circle
                      cx="50"
                      cy="50"
                      r="36"
                      fill="none"
                      stroke="var(--kr-gold)"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeDasharray="56 170"
                      className="kr-spin"
                    />
                  </svg>
                  <div className="space-y-2 text-center">
                    <p className="kr-serif text-lg tracking-[0.06em] text-kr-light">
                      Analysing evidence
                    </p>
                    <p className="kr-label">Against {regionDef.codeLabel}</p>
                  </div>
                </div>
              )}

              {state === 'success' && result && (
                <div className="space-y-4">
                  {/* -------- printed document header --------
                      Paper needs identification the screen does not: the app
                      masthead is hidden when printing, so the record carries its
                      own letterhead plus the fields an AHJ or insurer looks for
                      first. */}
                  <div className="kr-print-only kr-avoid-break mb-5 border-b border-[var(--kr-hairline)] pb-4">
                    <div className="flex items-start justify-between gap-6">
                      <div className="flex items-center gap-3">
                        <Image src={BRAND.markSrc} alt="" width={54} height={54} />
                        <div>
                          <div className="kr-wordmark text-[15px] leading-none">
                            {BRAND.companyFirst} <em>{BRAND.companySecond}</em>
                          </div>
                          <div className="kr-tagline mt-1.5">{BRAND.tagline}</div>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="kr-script text-[28px]">{BRAND.productWordmark}</div>
                        <div className="kr-label mt-0.5">{BRAND.productDescriptor}</div>
                      </div>
                    </div>

                    <h2 className="kr-serif mt-4 text-lg tracking-[0.08em] text-kr-light">
                      Field Audit Record
                    </h2>

                    <dl className="mt-3 grid grid-cols-2 gap-x-8 gap-y-1.5 text-[11px]">
                      <PrintRow label="Audit ID" value={result.audit_id} />
                      <PrintRow label="Site" value={result.site_id ?? siteId} />
                      <PrintRow
                        label="Jurisdiction"
                        value={
                          result.code_basis?.jurisdiction_label ??
                          result.code_basis?.jurisdiction_resolved ??
                          regionDef.label
                        }
                      />
                      <PrintRow label="Recorded" value={timestamp} />
                      <PrintRow label="Equipment" value={result.equipment_type} />
                      <PrintRow label="Status" value={result.status} />
                    </dl>
                  </div>

                  {/* -------- evidence plate (print) --------
                      The photograph lives in the input column, which is hidden on
                      paper — but a record without its evidence is not a record. */}
                  {preview && (
                    <div className="kr-print-only kr-evidence kr-avoid-break mb-5">
                      <p className="kr-label mb-2">Evidence</p>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={preview} alt="Audit subject" />
                      {file?.name && (
                        <p className="kr-data mt-1.5 text-[10px] text-kr-muted">{file.name}</p>
                      )}
                    </div>
                  )}

                  {/* -------- verdict -------- */}
                  <section
                    className="kr-verdict p-6"
                    style={{ borderLeftColor: toneSpec.rule, background: toneSpec.fill }}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="min-w-0">
                        <h2 className="kr-eyebrow">Compliance Status</h2>
                        <p className="kr-serif mt-2 text-2xl leading-tight tracking-[0.04em]"
                          style={{ color: toneSpec.text }}>
                          {result.status ?? 'UNKNOWN'}
                        </p>
                        <p className="mt-2 max-w-xl text-[11px] leading-relaxed text-kr-muted">
                          {codeBasisText}
                        </p>
                      </div>

                      {typeof result.risk_score === 'number' && (
                        <div className="text-right">
                          <p className="kr-label">Risk</p>
                          <p className="kr-data mt-1 text-2xl text-kr-light">{result.risk_score}</p>
                        </div>
                      )}
                    </div>

                    {(result.severity_counts || typeof result.sla_hours === 'number') && (
                      <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-[var(--kr-hairline-2)] pt-4">
                        {(['critical', 'major', 'minor'] as const).map((key) => {
                          const count = result.severity_counts?.[key];
                          if (!count) return null;
                          return <SeverityChip key={key} severity={key} count={count} />;
                        })}
                        {typeof result.sla_hours === 'number' && (
                          <span className="kr-label ml-auto">
                            SLA{' '}
                            <span className="kr-data text-kr-light">
                              {result.sla_hours === 0 ? 'IMMEDIATE' : `${result.sla_hours}h`}
                            </span>
                          </span>
                        )}
                      </div>
                    )}
                  </section>

                  {/* -------- governance -------- */}
                  {result.advisory_only && (
                    <section
                      className="kr-verdict flex items-start gap-3 px-5 py-4"
                      style={{ borderLeftColor: TONES.neutral.rule, background: 'var(--kr-info-dim)' }}
                    >
                      <Info
                        className="mt-0.5 h-4 w-4 shrink-0"
                        style={{ color: 'var(--kr-info)' }}
                      />
                      <div className="space-y-1.5">
                        <p className="kr-eyebrow" style={{ color: 'var(--kr-info)' }}>
                          Advisory only · not a certification
                          {result.signoff_status ? ` · sign-off ${result.signoff_status}` : ''}
                        </p>
                        {result.scope_note && (
                          <p className="text-[11px] leading-relaxed text-kr-muted">
                            {result.scope_note}
                          </p>
                        )}
                      </div>
                    </section>
                  )}

                  {/* -------- impairment -------- */}
                  {result.impairment_suspected && result.impairment_notice && (
                    <section
                      className="kr-verdict p-5"
                      style={{ borderLeftColor: TONES.bad.rule, background: TONES.bad.fill }}
                    >
                      <h3
                        className="kr-eyebrow flex items-center gap-2"
                        style={{ color: TONES.bad.text }}
                      >
                        <ShieldAlert className="h-4 w-4" />
                        Suspected system impairment
                      </h3>
                      <p className="mt-3 whitespace-pre-line text-xs leading-relaxed text-kr-body">
                        {result.impairment_notice}
                      </p>
                    </section>
                  )}

                  {/* -------- facts -------- */}
                  <div className="grid grid-cols-2 gap-4">
                    <Cell label="Site ID" value={result.site_id ?? siteId} />
                    <Cell label="AI Confidence" value={result.confidence ?? '—'} />
                    <Cell label="Equipment Type" value={result.equipment_type ?? '—'} small />
                    <Cell label="Timestamp" value={timestamp} small />
                  </div>

                  {/* -------- code basis -------- */}
                  {result.code_basis?.fire_code && (
                    <section className="kr-card p-6">
                      <h3 className="kr-serif text-base tracking-[0.05em] text-kr-light">
                        Code Basis Applied
                      </h3>
                      <dl className="mt-5 space-y-3.5 text-xs">
                        <BasisRow
                          label="Jurisdiction"
                          value={
                            result.code_basis.jurisdiction_label ??
                            result.code_basis.jurisdiction_resolved
                          }
                        />
                        <BasisRow label="Fire code" value={result.code_basis.fire_code} />
                        <BasisRow label="Edition" value={result.code_basis.fire_code_edition} />
                        <BasisRow label="Life safety" value={result.code_basis.life_safety_code} />
                        <BasisRow label="AHJ" value={result.code_basis.ahj_label} />
                        <BasisRow label="OSHA" value={result.code_basis.osha_overlay} />
                      </dl>

                      {result.code_basis.code_basis_confident === false && (
                        <div className="mt-5 flex items-start gap-2 border-t border-[var(--kr-hairline-2)] pt-4">
                          <AlertTriangle
                            className="mt-0.5 h-3.5 w-3.5 shrink-0"
                            style={{ color: TONES.warn.text }}
                          />
                          <p className="text-[11px] leading-relaxed text-kr-muted">
                            No exact registry match for the requested jurisdiction — the model-code
                            baseline was applied. Confirm the adopted code and local amendments with
                            the AHJ before relying on any citation.
                          </p>
                        </div>
                      )}
                    </section>
                  )}

                  {/* -------- observations -------- */}
                  <section className="kr-card p-6">
                    <h3 className="kr-serif text-base tracking-[0.05em] text-kr-light">
                      Key Observations
                    </h3>
                    <p className="mt-4 text-sm leading-relaxed text-kr-body">
                      {result.observations || 'No observations returned.'}
                    </p>
                  </section>

                  {/* -------- deficiencies -------- */}
                  {deficiencies.length > 0 && (
                    <section className="kr-card p-6">
                      <h3 className="kr-serif text-base tracking-[0.05em] text-kr-light">
                        Deficiencies{' '}
                        <span className="kr-data text-sm text-kr-muted">
                          ({deficiencies.length})
                        </span>
                      </h3>
                      <ul className="mt-5 space-y-6">
                        {deficiencies.map((d, i) => {
                          const severity = (d.severity ?? 'MAJOR').toUpperCase();
                          return (
                            <li
                              key={d.code ?? i}
                              className="kr-deficiency space-y-2 border-l-2 pl-4"
                              style={{
                                borderLeftColor: SEVERITY_COLOR[severity] ?? SEVERITY_COLOR.MAJOR,
                              }}
                            >
                              <div className="flex flex-wrap items-center gap-2">
                                <SeverityChip severity={severity} />
                                {d.code && (
                                  <span className="kr-data text-[10px] uppercase tracking-[0.14em] text-kr-muted">
                                    {d.code}
                                  </span>
                                )}
                                {d.verification_needed && (
                                  <span
                                    className="kr-data text-[10px] uppercase tracking-[0.14em]"
                                    style={{ color: TONES.warn.text }}
                                  >
                                    needs field verification
                                  </span>
                                )}
                              </div>

                              {d.finding && (
                                <p className="text-sm leading-relaxed text-kr-body">{d.finding}</p>
                              )}
                              <Detail label="Observed" value={d.observed} />
                              <Detail label="Requirement" value={d.requirement} />
                              <Detail
                                label="Remediation"
                                value={d.remediation}
                                color="var(--kr-pass)"
                              />
                              {d.code_reference && (
                                <p className="kr-data text-[11px] text-kr-gold opacity-80">
                                  {d.code_reference}
                                </p>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                      <p className="mt-6 border-t border-[var(--kr-hairline-2)] pt-4 text-[10px] leading-relaxed text-kr-muted">
                        Clause numbers are model-generated pointers for a human reviewer, not
                        authority. Verify against the edition your AHJ has adopted.
                      </p>
                    </section>
                  )}

                  {/* -------- flat violations (India) -------- */}
                  {deficiencies.length === 0 && violations.length > 0 && (
                    <section className="kr-card p-6">
                      <h3 className="kr-serif text-base tracking-[0.05em] text-kr-light">
                        Violations Detected
                      </h3>
                      <ul className="mt-4 space-y-3">
                        {violations.map((v, i) => (
                          <li key={i} className="flex items-start gap-3">
                            <span
                              className="mt-[7px] h-1 w-1 shrink-0 rounded-full"
                              style={{ background: TONES.bad.rule }}
                            />
                            <span className="text-sm leading-relaxed text-kr-body">{v}</span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}

                  {/* -------- clean -------- */}
                  {!hasFindings && (
                    <section
                      className="kr-verdict p-6"
                      style={{ borderLeftColor: TONES.good.rule, background: TONES.good.fill }}
                    >
                      <h3 className="kr-eyebrow" style={{ color: TONES.good.text }}>
                        No deficiencies observed
                      </h3>
                      <p className="mt-2.5 text-sm leading-relaxed text-kr-body">
                        {result.code_basis?.fire_code
                          ? `Nothing visible against ${result.code_basis.fire_code}.`
                          : regionDef.compliantCopyFallback}
                      </p>
                    </section>
                  )}

                  {/* -------- unverifiable -------- */}
                  {unverifiable.length > 0 && (
                    <section className="kr-card p-6">
                      <h3 className="kr-serif text-base tracking-[0.05em] text-kr-light">
                        Cannot be verified from a photograph
                      </h3>
                      <p className="mt-2 text-[11px] text-kr-muted">
                        The evidentiary boundary of this automated pass. These require a physical
                        inspection.
                      </p>
                      <ul className="mt-4 space-y-2.5">
                        {unverifiable.map((item, i) => (
                          <li key={i} className="flex items-start gap-3">
                            <span className="mt-2 h-px w-2.5 shrink-0 bg-[var(--kr-gold)] opacity-60" />
                            <span className="text-xs leading-relaxed text-kr-muted">{item}</span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}

                  {/* -------- reinspect -------- */}
                  {result.reinspect_required && reinspectReasons.length > 0 && (
                    <section
                      className="kr-verdict p-5"
                      style={{ borderLeftColor: TONES.warn.rule, background: TONES.warn.fill }}
                    >
                      <h3
                        className="kr-eyebrow flex items-center gap-2"
                        style={{ color: TONES.warn.text }}
                      >
                        <AlertTriangle className="h-4 w-4" />
                        Re-inspection required
                      </h3>
                      <ul className="mt-3 space-y-2">
                        {reinspectReasons.map((reason, i) => (
                          <li key={i} className="text-xs leading-relaxed text-kr-body">
                            {reason}
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}

                  {/* -------- trace -------- */}
                  {(result.audit_id || result.model_used) && (
                    <div className="kr-data flex flex-wrap items-center gap-x-5 gap-y-2 px-1 text-[10px] uppercase tracking-[0.14em] text-kr-muted/60">
                      {result.audit_id && <span>{result.audit_id}</span>}
                      {result.model_used && <span>{result.model_used}</span>}
                      {typeof result.latency_ms === 'number' && <span>{result.latency_ms}ms</span>}
                      {result.persisted === false && (
                        <span style={{ color: TONES.warn.text }}>not persisted</span>
                      )}
                    </div>
                  )}

                  {/* -------- sign-off block (print) --------
                      The workflow returns signoff_status: PENDING and the schema
                      has signoff_by / signoff_at, but nothing writes them yet. On
                      paper that gap is closed the way the trade already closes it
                      — a wet signature. Printing this makes the record's
                      provisional status impossible to overlook. */}
                  <div className="kr-print-only kr-avoid-break mt-6 border-t border-[var(--kr-hairline)] pt-5">
                    <p className="kr-eyebrow">Review &amp; sign-off</p>
                    <p className="mt-2 max-w-3xl text-[10.5px] leading-relaxed text-kr-muted">
                      This record is an automated advisory screening of a
                      photograph. It is not a certification of compliance and does
                      not constitute a firesafety inspection. Findings require
                      confirmation by an inspector qualified in the jurisdiction
                      above before any remediation is signed off or relied upon.
                    </p>
                    <div className="mt-6 grid grid-cols-3 gap-6 text-[10px]">
                      {['Reviewed by', 'Licence / certification no.', 'Date'].map((label) => (
                        <div key={label}>
                          <div className="h-8 border-b border-[var(--kr-hairline)]" />
                          <p className="kr-label mt-1.5">{label}</p>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="kr-screen-only grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Button
                      onClick={() => window.print()}
                      className="kr-ghost h-12 w-full rounded-md text-[11px] font-bold uppercase tracking-[0.18em]"
                    >
                      <Printer className="mr-2 h-3.5 w-3.5" />
                      Print / Save as PDF
                    </Button>
                    <Button
                      onClick={() => {
                        resetOutput();
                        setFile(null);
                        setPreview(null);
                      }}
                      className="kr-ghost h-12 w-full rounded-md text-[11px] font-bold uppercase tracking-[0.18em]"
                    >
                      New audit
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <footer className="kr-screen-only mt-16 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--kr-hairline)] pt-6">
            <p className="kr-label">
              {BRAND.companyFull} · {BRAND.productName}
            </p>
            <p className="kr-label">Advisory screening · not a certified inspection</p>
          </footer>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function SeverityChip({ severity, count }: { severity: string; count?: number }) {
  const key = severity.toUpperCase();
  const color = SEVERITY_COLOR[key] ?? SEVERITY_COLOR.MAJOR;
  const style: CSSProperties = {
    color,
    borderColor: color,
    background: 'transparent',
  };
  return (
    <span
      className="kr-severity-chip rounded-sm border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em]"
      style={style}
    >
      {count !== undefined ? `${count} ${key}` : key}
    </span>
  );
}

/** Label/value pair for the printed document header. */
function PrintRow({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="flex gap-2">
      <dt className="kr-label shrink-0">{label}</dt>
      <dd className="kr-data text-kr-light">{value}</dd>
    </div>
  );
}

function Cell({ label, value, small }: { label: string; value: string; small?: boolean }) {
  return (
    <div className="kr-card p-5">
      <p className="kr-label">{label}</p>
      <p className={`kr-data mt-3 text-kr-light ${small ? 'text-sm' : 'text-lg'}`}>{value}</p>
    </div>
  );
}

function BasisRow({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="grid grid-cols-[92px_1fr] gap-3">
      <dt className="kr-label pt-0.5">{label}</dt>
      <dd className="leading-relaxed text-kr-body">{value}</dd>
    </div>
  );
}

function Detail({ label, value, color }: { label: string; value?: string; color?: string }) {
  if (!value) return null;
  return (
    <p className="text-xs leading-relaxed" style={{ color: color ?? 'var(--kr-muted)' }}>
      <span className="kr-label">{label} · </span>
      {value}
    </p>
  );
}

/** Carries an error_code alongside the message so the banner can show both. */
class AuditFailure extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AuditFailure';
    this.code = code;
  }
}
