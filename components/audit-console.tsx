'use client';

import { useMemo, useState, type ChangeEvent } from 'react';
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
import { AlertCircle, AlertTriangle, Crosshair, Info, ShieldAlert, Upload } from 'lucide-react';
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

type Tone = 'good' | 'warn' | 'bad' | 'neutral';

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

const TONE_PANEL: Record<Tone, string> = {
  good: 'border-emerald-500/40 bg-emerald-950/20',
  warn: 'border-amber-500/40 bg-amber-950/20',
  bad: 'border-red-500/40 bg-red-950/20',
  neutral: 'border-white/10 bg-slate-900/30',
};

const TONE_BADGE: Record<Tone, string> = {
  good: 'bg-emerald-500/20 border-emerald-400 text-emerald-300 drop-shadow-[0_0_10px_rgba(16,185,129,0.5)]',
  warn: 'bg-amber-500/20 border-amber-400 text-amber-300 drop-shadow-[0_0_10px_rgba(251,191,36,0.5)]',
  bad: 'bg-red-500/20 border-red-400 text-red-300 drop-shadow-[0_0_10px_rgba(248,113,113,0.5)]',
  neutral: 'bg-slate-500/20 border-slate-400 text-slate-300',
};

const SEVERITY_BADGE: Record<string, string> = {
  CRITICAL: 'bg-red-500/20 border-red-400/70 text-red-300',
  MAJOR: 'bg-orange-500/20 border-orange-400/70 text-orange-300',
  MINOR: 'bg-sky-500/15 border-sky-400/60 text-sky-300',
};

const SEVERITY_ORDER: Record<string, number> = { CRITICAL: 0, MAJOR: 1, MINOR: 2 };

/**
 * Hint for the currently selected option, rendered as helper text beneath the
 * Select rather than inside the list items.
 *
 * shadcn's SelectItem wraps *all* its children in Radix's ItemText, and Radix
 * mirrors ItemText content into the trigger. A two-line item therefore renders
 * both lines stacked inside the closed trigger, which looks broken. Keeping
 * items single-line and surfacing the hint separately avoids that entirely —
 * and it stays visible when the list is closed, which is when it actually
 * matters (e.g. "Florida is NFPA-based, not IFC").
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

const CARD = 'glass rounded-lg border-white/5';
const CARD_SHADOW = { boxShadow: '0 4px 12px rgba(255, 140, 0, 0.08)' };
const FIELD_LABEL = 'text-xs uppercase tracking-widest text-amber-400/70 font-semibold';
const SELECT_TRIGGER =
  'glass-amber w-full h-11 text-sm text-white border-amber-500/25 data-[placeholder]:text-gray-600 focus:ring-0 focus:border-amber-400/60';

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
    <div className="relative min-h-screen overflow-hidden bg-slate-950">
      <div className="relative z-10 p-8">
        <div className="max-w-7xl mx-auto">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">
            {/* ================= LEFT COLUMN ================= */}
            <div className="space-y-8">
              <div>
                <h1
                  className="text-6xl font-black gold-text leading-none"
                  style={{ filter: 'drop-shadow(0 0 10px rgba(255, 170, 0, 0.25))' }}
                >
                  FIREHAWK
                </h1>
                <p className="text-amber-600/60 text-sm uppercase tracking-widest mt-3 font-medium">
                  AI Compliance Command Center
                </p>
              </div>

              {/* Region switch — rendered only when this deployment permits
                  more than one region. A single-region deployment shows a
                  static label instead, so a customer never sees the other
                  jurisdiction exists. */}
              {showRegionSwitch ? (
                <div className="space-y-3">
                  <span className={FIELD_LABEL}>Code Region</span>
                  <div className="glass-amber rounded-lg p-1 grid grid-cols-2 gap-1">
                    {enabledRegions.map((key) => {
                      const def = REGIONS[key];
                      const active = key === region;
                      return (
                        <button
                          key={key}
                          type="button"
                          onClick={() => {
                            if (key === region) return;
                            setRegion(key);
                            resetOutput();
                          }}
                          className={`rounded-md px-4 py-3 text-left transition-all duration-200 ${
                            active
                              ? 'bg-gradient-to-b from-orange-500 to-orange-600 text-black shadow-[0_0_18px_rgba(255,140,0,0.35)]'
                              : 'text-amber-400/70 hover:bg-amber-500/10 hover:text-amber-300'
                          }`}
                        >
                          <span className="block text-sm font-bold uppercase tracking-wider">
                            {def.label}
                          </span>
                          <span
                            className={`block text-[10px] mt-1 tracking-wide ${
                              active ? 'text-black/70' : 'text-amber-600/50'
                            }`}
                          >
                            {def.codeLabel}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-amber-500/50 font-semibold">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400/70" />
                  {regionDef.label} · {regionDef.codeLabel}
                </div>
              )}

              <div className="space-y-3">
                <label htmlFor="site-id" className={FIELD_LABEL}>
                  Site ID / Location Code
                </label>
                <Input
                  id="site-id"
                  placeholder={regionDef.siteIdPlaceholder}
                  value={siteId}
                  onChange={(e) => setSiteId(e.target.value)}
                  className="glass-amber placeholder:text-gray-600 text-white focus:ring-0 focus:border-amber-400/60 pl-4 h-12 text-sm"
                />
              </div>

              {/* US-only inputs. The India workflow has no jurisdiction concept
                  — it hardcodes NBC 2016 + CFO Mumbai — so these are driven off
                  the region registry rather than shown unconditionally. */}
              {region === 'US' && (
                <div className="space-y-5 rounded-lg border border-amber-500/20 bg-amber-500/[0.03] p-5">
                  <p className="text-[10px] uppercase tracking-widest text-amber-500/60 font-semibold">
                    Jurisdiction & Scope
                  </p>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <label className={FIELD_LABEL}>Jurisdiction</label>
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
                        <p className="text-[10px] text-gray-500 leading-relaxed">
                          {hintFor(US_JURISDICTIONS, jurisdiction)}
                        </p>
                      )}
                    </div>

                    <div className="space-y-2">
                      <label className={FIELD_LABEL}>Occupancy</label>
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
                    <label className={FIELD_LABEL}>Equipment Checklist</label>
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
                      <p className="text-[10px] text-gray-500 leading-relaxed">
                        {hintFor(US_EQUIPMENT, equipmentHint)}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center justify-between gap-4 pt-1">
                    <div>
                      <p className="text-xs text-white font-semibold">OSHA overlay</p>
                      <p className="text-[10px] text-gray-500 mt-1">
                        Apply 29 CFR 1910 workplace duties
                      </p>
                    </div>
                    <Switch checked={oshaWorkplace} onCheckedChange={setOshaWorkplace} />
                  </div>
                </div>
              )}

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
                className={`relative glass-amber rounded-lg cursor-pointer transition-all duration-300 overflow-hidden ${
                  dragActive
                    ? 'border-amber-400/60 bg-amber-500/5'
                    : 'border-amber-500/20 hover:border-amber-400/40'
                }`}
                style={{ boxShadow: '0 4px 15px rgba(255, 140, 0, 0.1)' }}
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
                    <img
                      src={preview}
                      alt="Uploaded equipment"
                      className="w-full h-64 object-cover opacity-80"
                    />
                    <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-slate-950 via-slate-950/80 to-transparent p-4">
                      <p className="text-amber-400 text-xs font-mono truncate">✓ {file?.name}</p>
                    </div>
                  </div>
                ) : (
                  <div className="p-12 flex flex-col items-center justify-center space-y-4">
                    <div className="p-4 rounded-lg bg-orange-500/20 border border-orange-500/50">
                      <Upload className="w-8 h-8 text-orange-400" />
                    </div>
                    <div className="text-center">
                      <p className="text-white font-semibold text-sm">UPLOAD EQUIPMENT IMAGE</p>
                      <p className="text-amber-600/50 text-xs mt-2 uppercase tracking-wide">
                        Drag &amp; drop or click
                      </p>
                    </div>
                  </div>
                )}
              </div>

              <Button
                onClick={handleRunAudit}
                disabled={!siteId || !file || loading}
                className={`w-full h-14 font-bold uppercase tracking-wider text-sm rounded-lg transition-all duration-300 ${
                  siteId && file && !loading
                    ? 'bg-gradient-to-b from-orange-500 to-orange-600 hover:shadow-[0_0_20px_rgba(255,140,0,0.4)] text-black'
                    : 'bg-gradient-to-b from-orange-600/30 to-orange-500/30 text-gray-500 cursor-not-allowed'
                }`}
              >
                {loading
                  ? 'PROCESSING...'
                  : siteId && file
                    ? 'INITIATE AUDIT SEQUENCE'
                    : 'AWAITING INPUT'}
              </Button>

              {error && (
                <div className="flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-950/20 px-4 py-3">
                  <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    {error.code && (
                      <p className="text-red-400 text-[10px] font-mono uppercase tracking-widest">
                        {error.code}
                      </p>
                    )}
                    <p className="text-red-300 text-xs font-mono">{error.message}</p>
                  </div>
                </div>
              )}

              <div className="text-xs text-gray-600/60 uppercase tracking-wider font-mono">
                Status: {loading ? 'Processing' : siteId && file ? 'Ready' : 'Incomplete'}
              </div>

              <div className="pt-4">
                <p className="text-[10px] uppercase tracking-widest text-amber-500/40 font-semibold">
                  Engineered by <span className="text-amber-400/60">Arvami Solutionz</span>
                </p>
              </div>
            </div>

            {/* ================= RIGHT COLUMN ================= */}
            <div className="flex items-center justify-center min-h-96">
              {state === 'empty' && (
                <div
                  className="w-full glass rounded-lg p-12 flex flex-col items-center justify-center space-y-6 border-amber-500/20 hover:border-amber-500/30 transition-colors"
                  style={CARD_SHADOW}
                >
                  <div className="relative w-20 h-20">
                    <Crosshair className="w-full h-full text-amber-600/40 radar-pulse" />
                  </div>
                  <div className="text-center">
                    <p className="text-amber-400/60 uppercase text-xs tracking-widest font-semibold">
                      awaiting target acquisition
                    </p>
                    <p className="text-gray-600 text-xs mt-3">
                      Ready to scan equipment · {regionDef.codeLabel}
                    </p>
                  </div>
                </div>
              )}

              {state === 'loading' && (
                <div className="w-full space-y-8 flex flex-col items-center justify-center">
                  <div className="relative w-32 h-32">
                    <svg className="w-full h-full glow-ring" viewBox="0 0 100 100">
                      <circle cx="50" cy="50" r="40" fill="none" stroke="rgba(255, 140, 0, 0.4)" strokeWidth="2" />
                      <circle
                        cx="50"
                        cy="50"
                        r="40"
                        fill="none"
                        stroke="url(#grad)"
                        strokeWidth="3"
                        strokeDasharray="251"
                        strokeDashoffset="0"
                        style={{ animation: 'spin 3s linear infinite' }}
                      />
                      <circle
                        cx="50"
                        cy="10"
                        r="4"
                        fill="rgba(255, 140, 0, 1)"
                        style={{ filter: 'drop-shadow(0 0 12px rgba(255, 140, 0, 1))' }}
                      />
                      <defs>
                        <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
                          <stop offset="0%" stopColor="rgba(255, 140, 0, 1)" />
                          <stop offset="50%" stopColor="rgba(255, 100, 0, 0.8)" />
                          <stop offset="100%" stopColor="rgba(255, 140, 0, 0.3)" />
                        </linearGradient>
                      </defs>
                    </svg>
                  </div>
                  <div className="text-center space-y-2">
                    <p className="glow-text-orange uppercase font-bold text-lg">
                      ANALYZING VISUAL DATA
                    </p>
                    {/* Was hardcoded "Running NBC 2016 compliance checks". */}
                    <p className="text-gray-600 text-sm uppercase tracking-wider">
                      Running {regionDef.codeLabel} checks
                    </p>
                  </div>
                  <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
                </div>
              )}

              {state === 'success' && result && (
                <div className="w-full space-y-4">
                  {/* -------- status header -------- */}
                  <div className={`glass rounded-lg p-6 border-2 ${TONE_PANEL[tone]}`} style={CARD_SHADOW}>
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <h2 className="text-white font-bold uppercase tracking-wider text-sm">
                          Compliance Status
                        </h2>
                        <p className="text-[10px] text-gray-500 mt-1 font-mono">{codeBasisText}</p>
                      </div>
                      <span
                        className={`px-4 py-2 rounded-full text-xs font-bold uppercase tracking-wider border animate-pulse shrink-0 ${TONE_BADGE[tone]}`}
                      >
                        {result.status ?? 'UNKNOWN'}
                      </span>
                    </div>

                    {(typeof result.risk_score === 'number' || result.severity_counts) && (
                      <div className="flex items-center gap-4 mt-5 pt-4 border-t border-white/10 flex-wrap">
                        {typeof result.risk_score === 'number' && (
                          <span className="text-[10px] uppercase tracking-widest text-gray-500 font-mono">
                            Risk <span className="text-white font-bold">{result.risk_score}</span>
                          </span>
                        )}
                        {(['critical', 'major', 'minor'] as const).map((key) => {
                          const count = result.severity_counts?.[key];
                          if (!count) return null;
                          return (
                            <span
                              key={key}
                              className={`px-2 py-1 rounded border text-[10px] font-bold uppercase tracking-wider ${
                                SEVERITY_BADGE[key.toUpperCase()]
                              }`}
                            >
                              {count} {key}
                            </span>
                          );
                        })}
                        {typeof result.sla_hours === 'number' && (
                          <span className="text-[10px] uppercase tracking-widest text-gray-500 font-mono">
                            SLA{' '}
                            <span className="text-white font-bold">
                              {result.sla_hours === 0 ? 'IMMEDIATE' : `${result.sla_hours}h`}
                            </span>
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  {/* -------- advisory banner (US) -------- */}
                  {result.advisory_only && (
                    <div className="flex items-start gap-3 rounded-lg border border-sky-500/30 bg-sky-950/20 px-4 py-3">
                      <Info className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
                      <div className="space-y-1">
                        <p className="text-sky-300 text-xs font-semibold uppercase tracking-wider">
                          Advisory only · not a certification
                          {result.signoff_status ? ` · sign-off ${result.signoff_status}` : ''}
                        </p>
                        {result.scope_note && (
                          <p className="text-sky-200/60 text-[11px] leading-relaxed">
                            {result.scope_note}
                          </p>
                        )}
                      </div>
                    </div>
                  )}

                  {/* -------- impairment notice -------- */}
                  {result.impairment_suspected && result.impairment_notice && (
                    <div className="rounded-lg border-2 border-red-500/50 bg-red-950/30 p-5">
                      <h3 className="text-red-300 font-bold uppercase tracking-wider text-xs mb-3 flex items-center gap-2">
                        <ShieldAlert className="w-4 h-4" />
                        Suspected system impairment
                      </h3>
                      <p className="text-red-200/70 text-xs leading-relaxed whitespace-pre-line">
                        {result.impairment_notice}
                      </p>
                    </div>
                  )}

                  {/* -------- info grid -------- */}
                  <div className="grid grid-cols-2 gap-4">
                    <InfoCell label="Site ID" value={result.site_id ?? siteId} />
                    <InfoCell label="AI Confidence" value={result.confidence ?? '—'} />
                    <InfoCell
                      label="Equipment Type"
                      value={result.equipment_type ?? '—'}
                      small
                    />
                    <InfoCell label="Timestamp" value={timestamp} small />
                  </div>

                  {/* -------- code basis (US) -------- */}
                  {result.code_basis?.fire_code && (
                    <div className={`${CARD} p-6`} style={CARD_SHADOW}>
                      <h3 className="text-white font-bold uppercase tracking-wider text-sm mb-4">
                        Code Basis Applied
                      </h3>
                      <dl className="space-y-3 text-xs">
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
                        <div className="flex items-start gap-2 mt-4 pt-4 border-t border-white/10">
                          <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                          <p className="text-amber-300/80 text-[11px] leading-relaxed">
                            No exact registry match for the requested jurisdiction — the model-code
                            baseline was applied. Confirm the adopted code and local amendments with
                            the AHJ before relying on any citation.
                          </p>
                        </div>
                      )}
                    </div>
                  )}

                  {/* -------- observations -------- */}
                  <div className={`${CARD} p-6`} style={CARD_SHADOW}>
                    <h3 className="text-white font-bold uppercase tracking-wider text-sm mb-4">
                      Key Observations
                    </h3>
                    <p className="text-gray-400 text-sm leading-relaxed">
                      {result.observations || 'No observations returned.'}
                    </p>
                  </div>

                  {/* -------- deficiencies (US) -------- */}
                  {deficiencies.length > 0 && (
                    <div
                      className="glass rounded-lg p-6 border-2 border-red-500/30 bg-red-950/10"
                      style={CARD_SHADOW}
                    >
                      <h3 className="text-white font-bold uppercase tracking-wider text-sm mb-5 flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse drop-shadow-[0_0_6px_rgba(248,113,113,0.8)]" />
                        Deficiencies · {deficiencies.length}
                      </h3>
                      <ul className="space-y-5">
                        {deficiencies.map((d, i) => {
                          const severity = (d.severity ?? 'MAJOR').toUpperCase();
                          return (
                            <li
                              key={d.code ?? i}
                              className="border-l-2 border-white/10 pl-4 space-y-2"
                            >
                              <div className="flex items-center gap-2 flex-wrap">
                                <span
                                  className={`px-2 py-0.5 rounded border text-[10px] font-bold uppercase tracking-wider ${
                                    SEVERITY_BADGE[severity] ?? SEVERITY_BADGE.MAJOR
                                  }`}
                                >
                                  {severity}
                                </span>
                                {d.code && (
                                  <span className="text-[10px] font-mono text-gray-500 uppercase tracking-wider">
                                    {d.code}
                                  </span>
                                )}
                                {d.verification_needed && (
                                  <span className="text-[10px] font-mono text-amber-400/70 uppercase tracking-wider">
                                    needs field verification
                                  </span>
                                )}
                              </div>

                              {d.finding && (
                                <p className="text-gray-300 text-sm leading-relaxed">{d.finding}</p>
                              )}
                              {d.observed && (
                                <p className="text-gray-500 text-xs leading-relaxed">
                                  <span className="text-gray-600 uppercase tracking-wider text-[10px]">
                                    Observed ·{' '}
                                  </span>
                                  {d.observed}
                                </p>
                              )}
                              {d.requirement && (
                                <p className="text-gray-500 text-xs leading-relaxed">
                                  <span className="text-gray-600 uppercase tracking-wider text-[10px]">
                                    Requirement ·{' '}
                                  </span>
                                  {d.requirement}
                                </p>
                              )}
                              {d.remediation && (
                                <p className="text-emerald-300/70 text-xs leading-relaxed">
                                  <span className="text-emerald-600/70 uppercase tracking-wider text-[10px]">
                                    Remediation ·{' '}
                                  </span>
                                  {d.remediation}
                                </p>
                              )}
                              {d.code_reference && (
                                <p className="text-amber-400/60 text-[11px] font-mono">
                                  {d.code_reference}
                                </p>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                      <p className="text-gray-600 text-[10px] leading-relaxed mt-5 pt-4 border-t border-white/10">
                        Clause numbers are model-generated pointers for a human reviewer, not
                        authority. Verify against the edition your AHJ has adopted.
                      </p>
                    </div>
                  )}

                  {/* -------- flat violations (India, or US with no structured
                       deficiencies) -------- */}
                  {deficiencies.length === 0 && violations.length > 0 && (
                    <div
                      className="glass rounded-lg p-6 border-2 border-red-500/30 bg-red-950/10"
                      style={CARD_SHADOW}
                    >
                      <h3 className="text-white font-bold uppercase tracking-wider text-sm mb-4 flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse drop-shadow-[0_0_6px_rgba(248,113,113,0.8)]" />
                        Violations Detected
                      </h3>
                      <ul className="space-y-3">
                        {violations.map((v, i) => (
                          <li key={i} className="flex items-start gap-3">
                            <span className="text-red-400 font-bold text-lg leading-none">•</span>
                            <span className="text-gray-400 text-sm">{v}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* -------- clean -------- */}
                  {!hasFindings && (
                    <div
                      className="glass rounded-lg p-6 border-2 border-emerald-500/30 bg-emerald-950/10"
                      style={CARD_SHADOW}
                    >
                      <h3 className="text-white font-bold uppercase tracking-wider text-sm mb-2 flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse drop-shadow-[0_0_6px_rgba(16,185,129,0.8)]" />
                        Zero Violations
                      </h3>
                      {/* Was hardcoded NBC 2016 / CFO Mumbai copy. */}
                      <p className="text-gray-400 text-sm">
                        {result.code_basis?.fire_code
                          ? `No deficiencies visible against ${result.code_basis.fire_code}.`
                          : regionDef.compliantCopyFallback}
                      </p>
                    </div>
                  )}

                  {/* -------- unverifiable items (US) -------- */}
                  {unverifiable.length > 0 && (
                    <div className={`${CARD} p-6`} style={CARD_SHADOW}>
                      <h3 className="text-white font-bold uppercase tracking-wider text-sm mb-2">
                        Cannot be verified from a photograph
                      </h3>
                      <p className="text-gray-600 text-[11px] mb-4">
                        The honest boundary of this automated pass. These require a physical
                        inspection.
                      </p>
                      <ul className="space-y-2">
                        {unverifiable.map((item, i) => (
                          <li key={i} className="flex items-start gap-3">
                            <span className="text-gray-600 text-lg leading-none">–</span>
                            <span className="text-gray-500 text-xs leading-relaxed">{item}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* -------- reinspect reasons -------- */}
                  {result.reinspect_required && asArray<string>(result.reinspect_reasons).length > 0 && (
                    <div className="rounded-lg border border-amber-500/30 bg-amber-950/20 p-5">
                      <h3 className="text-amber-300 font-bold uppercase tracking-wider text-xs mb-3 flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4" />
                        Re-inspection required
                      </h3>
                      <ul className="space-y-2">
                        {asArray<string>(result.reinspect_reasons).map((reason, i) => (
                          <li key={i} className="text-amber-200/70 text-xs leading-relaxed">
                            • {reason}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* -------- trace footer -------- */}
                  {(result.audit_id || result.model_used) && (
                    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-2 text-[10px] font-mono text-gray-700 uppercase tracking-wider">
                      {result.audit_id && <span>{result.audit_id}</span>}
                      {result.model_used && <span>{result.model_used}</span>}
                      {typeof result.latency_ms === 'number' && <span>{result.latency_ms}ms</span>}
                      {result.persisted === false && (
                        <span className="text-amber-500/70">not persisted</span>
                      )}
                    </div>
                  )}

                  <Button
                    onClick={() => {
                      resetOutput();
                      setFile(null);
                      setPreview(null);
                    }}
                    className="w-full h-12 font-bold uppercase tracking-wider text-xs rounded-lg border border-amber-500/30 bg-amber-500/5 text-amber-400 hover:bg-amber-500/10 hover:border-amber-400/50 transition-all duration-300"
                  >
                    NEW AUDIT
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function InfoCell({
  label,
  value,
  small,
}: {
  label: string;
  value: string;
  small?: boolean;
}) {
  return (
    <div className={`${CARD} p-5`} style={CARD_SHADOW}>
      <p className="text-xs uppercase tracking-wider text-amber-600/60 font-semibold">{label}</p>
      <p className={`text-white font-bold mt-3 font-mono ${small ? 'text-sm' : 'text-lg'}`}>
        {value}
      </p>
    </div>
  );
}

function BasisRow({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="grid grid-cols-[88px_1fr] gap-3">
      <dt className="text-[10px] uppercase tracking-widest text-amber-600/60 font-semibold pt-0.5">
        {label}
      </dt>
      <dd className="text-gray-400 leading-relaxed">{value}</dd>
    </div>
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
