'use client';

import Image from 'next/image';
import { useState, type ChangeEvent } from 'react';
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
import { AlertCircle, Archive, Printer, ScanLine, Upload } from 'lucide-react';
import { AuditReport } from '@/components/audit-report';
import { RecordsBrowser } from '@/components/records-browser';
import { BRAND } from '@/lib/brand';
import { TONES, type AuditError, type AuditResult } from '@/lib/audit-types';
import {
  REGIONS,
  US_DEFAULTS,
  US_EQUIPMENT,
  US_JURISDICTIONS,
  US_OCCUPANCIES,
  type Option,
  type RegionKey,
} from '@/lib/regions';

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

const SELECT_TRIGGER = 'kr-field w-full h-11 rounded-md text-sm data-[placeholder]:text-kr-muted';

type View = 'audit' | 'records';

export function AuditConsole({
  enabledRegions,
  recordsEnabled,
}: {
  enabledRegions: RegionKey[];
  recordsEnabled: boolean;
}) {
  const [view, setView] = useState<View>('audit');
  const [region, setRegion] = useState<RegionKey>(enabledRegions[0] ?? 'IND');

  const [siteId, setSiteId] = useState('');
  const [jurisdiction, setJurisdiction] = useState<string>(US_DEFAULTS.jurisdiction);
  const [occupancy, setOccupancy] = useState<string>(US_DEFAULTS.occupancy_type);
  const [equipmentHint, setEquipmentHint] = useState<string>(US_DEFAULTS.equipment_hint);
  const [oshaWorkplace, setOshaWorkplace] = useState<boolean>(US_DEFAULTS.osha_workplace);
  const [assetTag, setAssetTag] = useState('');
  const [inspectorId, setInspectorId] = useState('');

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
        if (assetTag.trim()) payload.asset_tag = assetTag.trim();
        if (inspectorId.trim()) payload.inspector_id = inspectorId.trim();
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

  return (
    <div className="relative min-h-screen">
      <div className="relative z-10 px-6 py-10 sm:px-10">
        <div className="mx-auto max-w-7xl">
          {/* ===================== MASTHEAD =====================
              Three zones: company lockup, code region, product wordmark. The
              region control lives here rather than in the input column because
              it is not an input — it selects which engine and which code basis
              the whole screen is operating under, and in Records it scopes which
              table is searched. */}
          <header className="kr-screen-only mb-6 flex flex-wrap items-center justify-between gap-x-8 gap-y-6 border-b border-[var(--kr-hairline)] pb-6">
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

          {/* View switch. Rendered only when the records backend is configured —
              HISTORY_API_KEY unset means /api/history returns 503, so offering a
              tab that cannot work would be worse than not offering it. */}
          {recordsEnabled && (
            <nav className="kr-screen-only mb-8 flex gap-1 border-b border-[var(--kr-hairline-2)]">
              <ViewTab
                active={view === 'audit'}
                onClick={() => setView('audit')}
                icon={<ScanLine className="h-3.5 w-3.5" />}
                label="New audit"
              />
              <ViewTab
                active={view === 'records'}
                onClick={() => setView('records')}
                icon={<Archive className="h-3.5 w-3.5" />}
                label="Records"
              />
            </nav>
          )}

          {view === 'records' ? (
            <RecordsBrowser region={region} />
          ) : (
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

                {/* US-only. The India workflow hardcodes NBC 2016 + CFO Mumbai
                    and has no jurisdiction concept, so these come from the
                    registry rather than being shown unconditionally. */}
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

                    {/* Asset tag and inspector. A site holds many devices and is
                        audited repeatedly, so site_id alone cannot identify what
                        was inspected — two extinguishers at one address produce
                        two records that read identically without these. */}
                    <div className="grid grid-cols-1 gap-4 border-t border-[var(--kr-hairline-2)] pt-4 sm:grid-cols-2">
                      <div className="space-y-2">
                        <label htmlFor="asset-tag" className="kr-label block">
                          Asset tag
                        </label>
                        <Input
                          id="asset-tag"
                          placeholder="EXT-014-03"
                          value={assetTag}
                          onChange={(e) => setAssetTag(e.target.value)}
                          className="kr-field kr-data h-11 rounded-md px-3 text-sm placeholder:text-kr-muted/50"
                        />
                      </div>
                      <div className="space-y-2">
                        <label htmlFor="inspector-id" className="kr-label block">
                          Inspector
                        </label>
                        <Input
                          id="inspector-id"
                          placeholder="TECH-4471"
                          value={inspectorId}
                          onChange={(e) => setInspectorId(e.target.value)}
                          className="kr-field kr-data h-11 rounded-md px-3 text-sm placeholder:text-kr-muted/50"
                        />
                      </div>
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
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={preview} alt="Audit subject" className="h-60 w-full object-cover" />
                      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[var(--kr-ink)] via-[var(--kr-ink)]/85 to-transparent p-4">
                        <p className="kr-data truncate text-[11px] text-kr-gold-soft">
                          {file?.name}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center gap-4 p-12">
                      <div className="rounded-md border border-[var(--kr-hairline)] p-3.5">
                        <Upload className="h-6 w-6 text-kr-gold" />
                      </div>
                      <div className="text-center">
                        <p className="text-sm font-semibold text-kr-light">
                          Upload equipment image
                        </p>
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
                      <p className="mt-3 text-xs text-kr-muted">Upload a photograph to begin</p>
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
                  <AuditReport
                    result={result}
                    region={region}
                    siteIdFallback={siteId}
                    evidenceUrl={preview}
                    evidenceLabel={file?.name ?? null}
                    actions={
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
                    }
                  />
                )}
              </div>
            </div>
          )}

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

function ViewTab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`-mb-px flex items-center gap-2 border-b-2 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.16em] transition-colors ${
        active
          ? 'border-[var(--kr-gold)] text-kr-gold'
          : 'border-transparent text-kr-muted hover:text-kr-light'
      }`}
    >
      {icon}
      {label}
    </button>
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
