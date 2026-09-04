'use client';

import Image from 'next/image';
import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { AlertTriangle, Info, ShieldAlert } from 'lucide-react';
import { BRAND } from '@/lib/brand';
import { REGIONS, type RegionKey } from '@/lib/regions';
import {
  asArray,
  SEVERITY_COLOR,
  sortedDeficiencies,
  statusTone,
  TONES,
  type AuditResult,
} from '@/lib/audit-types';

/**
 * The audit report — the single renderer for a verdict, whether it just came
 * back from the vision model or was retrieved from the audit log years later.
 *
 * This was inline in audit-console.tsx. Extracting it is what makes the records
 * browser possible without a second rendering path, and it means the print
 * stylesheet, the page-break rules and the sign-off block are written once. The
 * backend cooperates: SHAPE_Results normalises both database tables into the same
 * contract the audit workflows return, so there is nothing to translate here.
 *
 * Two fields are composed at audit time and never persisted — impairment_notice
 * and scope_note — so a retrieved record renders slightly thinner. That is
 * handled by the same optional-field checks that already cover the India
 * workflow's smaller response, not by branching on `retrieved`.
 */

export interface AuditReportProps {
  result: AuditResult;
  region: RegionKey;
  /** Used when the record itself carries no site_id. */
  siteIdFallback?: string;
  /**
   * Evidence image. A `blob:` object URL for a live audit, or the stored
   * `image_url` for a retrieved US record. India does not persist an image URL,
   * so retrieved India records have no evidence plate.
   */
  evidenceUrl?: string | null;
  evidenceLabel?: string | null;
  /** Screen-only controls (Print, New audit, Back to results). */
  actions?: ReactNode;
}

export function AuditReport({
  result,
  region,
  siteIdFallback,
  evidenceUrl,
  evidenceLabel,
  actions,
}: AuditReportProps) {
  const regionDef = REGIONS[region];
  const tone = statusTone(result.status);
  const toneSpec = TONES[tone];

  const violations = useMemo(() => asArray<string>(result.violations), [result]);
  const deficiencies = useMemo(() => sortedDeficiencies(result.deficiencies), [result]);
  const unverifiable = useMemo(() => asArray<string>(result.unverifiable_items), [result]);
  const reinspectReasons = useMemo(() => asArray<string>(result.reinspect_reasons), [result]);

  const hasFindings = deficiencies.length > 0 || violations.length > 0;
  const codeBasisText = result.code_basis?.fire_code ?? regionDef.codeBasisFallback;

  // local_timestamp is rendered by the workflow with a zone abbreviation and is
  // preferred when present. A retrieved record has only the stored instant, so
  // it is formatted here with the region's locale.
  const timestamp = result.local_timestamp
    ? result.local_timestamp
    : result.audit_timestamp
      ? new Date(result.audit_timestamp).toLocaleString(regionDef.timestampLocale, {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '—';

  const recordRef = result.audit_id ?? (result.record_id != null ? `#${result.record_id}` : null);

  return (
    <div className="space-y-4">
      {/* -------- printed document header --------
          Paper needs identification the screen does not: the app masthead is
          hidden when printing, so the record carries its own letterhead plus the
          fields an AHJ or insurer looks for first. */}
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
          <PrintRow label="Reference" value={recordRef ?? undefined} />
          <PrintRow label="Site" value={result.site_id ?? siteIdFallback} />
          <PrintRow
            label="Jurisdiction"
            value={
              result.code_basis?.jurisdiction_label ??
              result.code_basis?.jurisdiction_resolved ??
              result.jurisdiction ??
              regionDef.label
            }
          />
          <PrintRow label="Recorded" value={timestamp} />
          <PrintRow label="Equipment" value={result.equipment_type} />
          <PrintRow label="Status" value={result.status} />
          <PrintRow label="Inspector" value={result.inspector_id} />
          <PrintRow label="Asset tag" value={result.asset_tag ?? undefined} />
        </dl>
      </div>

      {/* -------- evidence plate (print) --------
          On screen the photograph sits in the input column for a live audit, and
          in the record header for a retrieved one; either way it is hidden from
          the printed layout unless re-emitted here. A record without its
          evidence is not a record. */}
      {evidenceUrl && (
        <div className="kr-print-only kr-evidence kr-avoid-break mb-5">
          <p className="kr-label mb-2">Evidence</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={evidenceUrl} alt="Audit subject" />
          {evidenceLabel && (
            <p className="kr-data mt-1.5 text-[10px] text-kr-muted">{evidenceLabel}</p>
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
            <p
              className="kr-serif mt-2 text-2xl leading-tight tracking-[0.04em]"
              style={{ color: toneSpec.text }}
            >
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
          <Info className="mt-0.5 h-4 w-4 shrink-0" style={{ color: 'var(--kr-info)' }} />
          <div className="space-y-1.5">
            <p className="kr-eyebrow" style={{ color: 'var(--kr-info)' }}>
              Advisory only · not a certification
              {result.signoff_status ? ` · sign-off ${result.signoff_status}` : ''}
            </p>
            {result.scope_note && (
              <p className="text-[11px] leading-relaxed text-kr-muted">{result.scope_note}</p>
            )}
            {result.signoff_by && (
              <p className="kr-data text-[10px] text-kr-muted">
                Signed off by {result.signoff_by}
                {result.signoff_at ? ` · ${result.signoff_at}` : ''}
              </p>
            )}
          </div>
        </section>
      )}

      {/* -------- impairment -------- */}
      {result.impairment_suspected && (
        <section
          className="kr-verdict p-5"
          style={{ borderLeftColor: TONES.bad.rule, background: TONES.bad.fill }}
        >
          <h3 className="kr-eyebrow flex items-center gap-2" style={{ color: TONES.bad.text }}>
            <ShieldAlert className="h-4 w-4" />
            Suspected system impairment
          </h3>
          {result.impairment_basis && (
            <p className="mt-3 text-xs leading-relaxed text-kr-body">{result.impairment_basis}</p>
          )}
          {result.impairment_notice ? (
            <p className="mt-3 whitespace-pre-line text-xs leading-relaxed text-kr-body">
              {result.impairment_notice}
            </p>
          ) : (
            // Composed at audit time, not persisted. Say so rather than leaving
            // the reader of an archived record to assume no action was required.
            <p className="mt-3 text-[11px] leading-relaxed text-kr-muted">
              The NFPA 25 Ch. 15 impairment action checklist is generated at audit time and is not
              retained in the record. Re-run the audit to reproduce it.
            </p>
          )}
        </section>
      )}

      {/* -------- facts -------- */}
      <div className="grid grid-cols-2 gap-4">
        <Cell label="Site ID" value={result.site_id ?? siteIdFallback ?? '—'} />
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
                result.code_basis.jurisdiction_label ?? result.code_basis.jurisdiction_resolved
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
                No exact registry match for the requested jurisdiction — the model-code baseline was
                applied. Confirm the adopted code and local amendments with the AHJ before relying
                on any citation.
              </p>
            </div>
          )}
        </section>
      )}

      {/* -------- observations -------- */}
      <section className="kr-card p-6">
        <h3 className="kr-serif text-base tracking-[0.05em] text-kr-light">Key Observations</h3>
        <p className="mt-4 text-sm leading-relaxed text-kr-body">
          {result.observations || 'No observations returned.'}
        </p>
      </section>

      {/* -------- deficiencies -------- */}
      {deficiencies.length > 0 && (
        <section className="kr-card p-6">
          <h3 className="kr-serif text-base tracking-[0.05em] text-kr-light">
            Deficiencies{' '}
            <span className="kr-data text-sm text-kr-muted">({deficiencies.length})</span>
          </h3>
          <ul className="mt-5 space-y-6">
            {deficiencies.map((d, i) => {
              const severity = (d.severity ?? 'MAJOR').toUpperCase();
              return (
                <li
                  key={d.code ?? i}
                  className="kr-deficiency space-y-2 border-l-2 pl-4"
                  style={{ borderLeftColor: SEVERITY_COLOR[severity] ?? SEVERITY_COLOR.MAJOR }}
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
                  <Detail label="Remediation" value={d.remediation} color="var(--kr-pass)" />
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
            Clause numbers are model-generated pointers for a human reviewer, not authority. Verify
            against the edition your AHJ has adopted.
          </p>
        </section>
      )}

      {/* -------- flat violations (India) -------- */}
      {deficiencies.length === 0 && violations.length > 0 && (
        <section className="kr-card p-6">
          <h3 className="kr-serif text-base tracking-[0.05em] text-kr-light">
            Violations Detected{' '}
            <span className="kr-data text-sm text-kr-muted">({violations.length})</span>
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
            The evidentiary boundary of this automated pass. These require a physical inspection.
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
          <h3 className="kr-eyebrow flex items-center gap-2" style={{ color: TONES.warn.text }}>
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
      {(recordRef || result.model_used) && (
        <div className="kr-data flex flex-wrap items-center gap-x-5 gap-y-2 px-1 text-[10px] uppercase tracking-[0.14em] text-kr-muted/60">
          {recordRef && <span>{recordRef}</span>}
          {result.model_used && <span>{result.model_used}</span>}
          {typeof result.latency_ms === 'number' && <span>{result.latency_ms}ms</span>}
          {result.remediation_status && <span>{result.remediation_status}</span>}
          {result.persisted === false && (
            <span style={{ color: TONES.warn.text }}>not persisted</span>
          )}
          {result.retrieved && <span>archived record</span>}
        </div>
      )}

      {/* -------- sign-off block (print) --------
          The workflow returns signoff_status: PENDING and the schema has
          signoff_by / signoff_at, but nothing writes them yet. On paper that gap
          is closed the way the trade already closes it — a wet signature.
          Printing this makes the record's provisional status impossible to
          overlook. */}
      <div className="kr-print-only kr-avoid-break mt-6 border-t border-[var(--kr-hairline)] pt-5">
        <p className="kr-eyebrow">Review &amp; sign-off</p>
        <p className="mt-2 max-w-3xl text-[10.5px] leading-relaxed text-kr-muted">
          This record is an automated advisory screening of a photograph. It is not a certification
          of compliance and does not constitute a firesafety inspection. Findings require
          confirmation by an inspector qualified in the jurisdiction above before any remediation is
          signed off or relied upon.
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

      {actions && <div className="kr-screen-only">{actions}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function SeverityChip({ severity, count }: { severity: string; count?: number }) {
  const key = severity.toUpperCase();
  const color = SEVERITY_COLOR[key] ?? SEVERITY_COLOR.MAJOR;
  const style: CSSProperties = { color, borderColor: color, background: 'transparent' };
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
