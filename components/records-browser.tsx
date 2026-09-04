'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AlertCircle, ArrowLeft, Printer, Search } from 'lucide-react';
import { AuditReport, SeverityChip } from '@/components/audit-report';
import { printAuditReport } from '@/lib/print-report';
import { REGIONS, type RegionKey } from '@/lib/regions';
import {
  asArray,
  sortedDeficiencies,
  statusTone,
  TONES,
  type AuditError,
  type AuditResult,
} from '@/lib/audit-types';

/**
 * Audit records browser.
 *
 * Search -> list -> open one record, which renders through the same AuditReport
 * the live console uses, so the print layout and the sign-off block come for
 * free.
 *
 * The two regions expose different filters because the two tables genuinely
 * differ. field_audit_us_logs has a minted audit_id and an asset_tag;
 * field_audit_logs has neither, but does have an integer primary key exposed as
 * record_id. The backend REJECTS a filter that does not exist for a region
 * rather than ignoring it, so offering the wrong control here would produce a
 * confusing 400 instead of a wrong answer — the fields are therefore driven off
 * the region.
 */

const STATUS_OPTIONS = [
  { value: 'ANY', label: 'Any status' },
  { value: 'COMPLIANT', label: 'Compliant' },
  { value: 'CONDITIONAL', label: 'Conditional' },
  { value: 'NON-COMPLIANT', label: 'Non-compliant' },
  { value: 'REINSPECT', label: 'Re-inspect' },
  { value: 'ERROR', label: 'Error' },
];

const FIELD = 'kr-field kr-data h-11 rounded-md px-3 text-sm placeholder:text-kr-muted/50';
const PAGE_SIZE = 25;

interface RecordsResponse {
  query_ok?: boolean;
  count?: number;
  page_full?: boolean;
  rows?: AuditResult[];
  error_code?: string;
  error?: string;
}

export function RecordsBrowser({ region }: { region: RegionKey }) {
  const regionDef = REGIONS[region];

  const [siteId, setSiteId] = useState('');
  const [assetTag, setAssetTag] = useState('');
  const [reference, setReference] = useState('');
  const [status, setStatus] = useState('ANY');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<AuditError | null>(null);
  const [rows, setRows] = useState<AuditResult[] | null>(null);
  const [pageFull, setPageFull] = useState(false);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<AuditResult | null>(null);

  const hasAnyFilter = Boolean(
    siteId.trim() || assetTag.trim() || reference.trim() || from.trim() || to.trim(),
  );

  const buildBody = (nextOffset: number) => {
    const body: Record<string, unknown> = { region, limit: PAGE_SIZE, offset: nextOffset };
    if (siteId.trim()) body.site_id = siteId.trim();
    if (from.trim()) body.from = from.trim();
    if (to.trim()) body.to = to.trim();
    if (status !== 'ANY') body.status = status;

    // The reference field means different things per region because the tables do.
    if (reference.trim()) {
      if (region === 'US') body.audit_id = reference.trim();
      else body.record_id = reference.trim();
    }
    if (region === 'US' && assetTag.trim()) body.asset_tag = assetTag.trim();
    return body;
  };

  const runSearch = async (nextOffset: number, append: boolean) => {
    setLoading(true);
    setError(null);
    if (!append) setSelected(null);

    try {
      const res = await fetch('/api/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody(nextOffset)),
      });
      const text = await res.text();

      let data: RecordsResponse;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`The records service returned a non-JSON response (HTTP ${res.status}).`);
      }

      if (!res.ok || data.query_ok === false) {
        setError({
          code: data.error_code ?? `HTTP_${res.status}`,
          message: data.error ?? `Lookup failed with HTTP ${res.status}.`,
        });
        if (!append) setRows(null);
        return;
      }

      const incoming = data.rows ?? [];
      setRows(append && rows ? [...rows, ...incoming] : incoming);
      setPageFull(data.page_full === true);
      setOffset(nextOffset);
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : 'Lookup failed.' });
      if (!append) setRows(null);
    } finally {
      setLoading(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!hasAnyFilter) {
      // Mirror the backend's rule locally so the user gets an instant answer
      // instead of a round trip that returns FILTER_REQUIRED.
      setError({
        code: 'FILTER_REQUIRED',
        message:
          'Enter at least one of: site ID, reference, or a date. Listing the whole audit log is not permitted.',
      });
      setRows(null);
      return;
    }
    void runSearch(0, false);
  };

  // ------------------------------------------------------------ detail view
  if (selected) {
    return (
      <AuditReport
        result={selected}
        region={region}
        evidenceUrl={selected.image_url ?? null}
        evidenceLabel={selected.asset_tag ?? null}
        // A retrieved record has no input column, so without this the evidence
        // would exist only in the printed output.
        evidenceOnScreen
        actions={
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Button
              onClick={() => setSelected(null)}
              className="kr-ghost h-12 w-full rounded-md text-[11px] font-bold uppercase tracking-[0.18em]"
            >
              <ArrowLeft className="mr-2 h-3.5 w-3.5" />
              Back to results
            </Button>
            <Button
              onClick={() => printAuditReport(selected)}
              className="kr-ghost h-12 w-full rounded-md text-[11px] font-bold uppercase tracking-[0.18em]"
            >
              <Printer className="mr-2 h-3.5 w-3.5" />
              Print / Save as PDF
            </Button>
          </div>
        }
      />
    );
  }

  // ------------------------------------------------------------ search view
  return (
    <div className="kr-screen-only space-y-5">
      <form onSubmit={onSubmit} className="kr-card space-y-5 p-6">
        <div className="flex items-baseline justify-between gap-4">
          <span className="kr-eyebrow">Search the audit log</span>
          <span className="kr-label">{regionDef.codeLabel}</span>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Site ID">
            <Input
              value={siteId}
              onChange={(e) => setSiteId(e.target.value)}
              placeholder={regionDef.siteIdPlaceholder}
              className={FIELD}
            />
          </Field>

          <Field label={region === 'US' ? 'Audit ID' : 'Record no.'}>
            <Input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder={region === 'US' ? 'FA-US-20260903-…' : '91'}
              inputMode={region === 'US' ? 'text' : 'numeric'}
              className={FIELD}
            />
          </Field>

          {/* US only: field_audit_logs has no asset_tag column, and the backend
              rejects the filter rather than ignoring it. */}
          {region === 'US' && (
            <Field label="Asset tag">
              <Input
                value={assetTag}
                onChange={(e) => setAssetTag(e.target.value)}
                placeholder="EXT-014-03"
                className={FIELD}
              />
            </Field>
          )}

          <Field label="From">
            <Input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className={FIELD}
            />
          </Field>

          <Field label="To" hint="Exclusive">
            <Input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className={FIELD}
            />
          </Field>

          <Field label="Status">
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="kr-field h-11 w-full rounded-md text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--kr-hairline-2)] pt-4">
          <p className="text-[10px] leading-relaxed text-kr-muted">
            At least one of site ID, reference or a date is required.
          </p>
          <Button
            type="submit"
            disabled={loading}
            className="kr-action h-11 rounded-md px-6 text-[11px] font-bold uppercase tracking-[0.16em]"
          >
            <Search className="mr-2 h-3.5 w-3.5" />
            {loading ? 'Searching…' : 'Search'}
          </Button>
        </div>
      </form>

      {error && (
        <div
          className="kr-verdict flex items-start gap-3 px-4 py-3"
          style={{ borderLeftColor: TONES.bad.rule, background: TONES.bad.fill }}
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" style={{ color: TONES.bad.text }} />
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

      {rows !== null && !error && (
        <div className="space-y-3">
          <p className="kr-label">
            {rows.length === 0
              ? 'No records matched'
              : `${rows.length} record${rows.length === 1 ? '' : 's'}`}
          </p>

          {rows.length === 0 && (
            <div className="kr-card-quiet p-8 text-center">
              <p className="text-sm text-kr-muted">
                Nothing in the log matches those filters. Check the site ID spelling and remember
                the <span className="text-kr-light">To</span> date is exclusive.
              </p>
            </div>
          )}

          <ul className="space-y-2">
            {rows.map((row, i) => (
              <RecordRow
                key={row.audit_id ?? row.record_id ?? `${row.site_id}-${row.audit_timestamp}-${i}`}
                row={row}
                region={region}
                onOpen={() => setSelected(row)}
              />
            ))}
          </ul>

          {pageFull && (
            <Button
              onClick={() => void runSearch(offset + PAGE_SIZE, true)}
              disabled={loading}
              className="kr-ghost h-11 w-full rounded-md text-[11px] font-bold uppercase tracking-[0.18em]"
            >
              {loading ? 'Loading…' : 'Load more'}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function RecordRow({
  row,
  region,
  onOpen,
}: {
  row: AuditResult;
  region: RegionKey;
  onOpen: () => void;
}) {
  const tone = statusTone(row.status);
  const toneSpec = TONES[tone];
  const deficiencies = sortedDeficiencies(row.deficiencies);
  const violations = asArray<string>(row.violations);
  const findingCount = deficiencies.length || violations.length;

  const when = row.audit_timestamp
    ? new Date(row.audit_timestamp).toLocaleString(REGIONS[region].timestampLocale, {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

  const reference = row.audit_id ?? (row.record_id != null ? `#${row.record_id}` : null);

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="kr-card w-full border-l-2 p-4 text-left transition-colors hover:border-[var(--kr-gold-deep)]"
        style={{ borderLeftColor: toneSpec.rule }}
      >
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
          <div className="min-w-0">
            <p
              className="text-[13px] font-semibold uppercase tracking-[0.1em]"
              style={{ color: toneSpec.text }}
            >
              {row.status ?? 'UNKNOWN'}
            </p>
            <p className="kr-data mt-1.5 flex flex-wrap items-baseline gap-x-2 text-sm text-kr-light">
              {row.site_id ?? '—'}
              {/* The asset tag is what tells two devices at one site apart. A
                  site is audited repeatedly and holds many devices, so without
                  it the rows read as duplicates. */}
              {row.asset_tag && (
                <span className="text-[11px] text-kr-gold">/ {row.asset_tag}</span>
              )}
            </p>
            <p className="mt-1 truncate text-[11px] text-kr-muted">
              {row.equipment_type ?? '—'}
              {row.inspector_id && row.inspector_id !== 'UNASSIGNED' && (
                <span className="ml-2 opacity-70">· {row.inspector_id}</span>
              )}
            </p>
          </div>

          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <p className="kr-data text-[11px] text-kr-muted">{when}</p>
            <div className="flex items-center gap-2">
              {typeof row.risk_score === 'number' && row.risk_score > 0 && (
                <span className="kr-label">
                  Risk <span className="kr-data text-kr-light">{row.risk_score}</span>
                </span>
              )}
              {findingCount > 0 && (
                <SeverityChip
                  severity={deficiencies[0]?.severity ?? 'MAJOR'}
                  count={findingCount}
                />
              )}
            </div>
            {reference && (
              <p className="kr-data text-[9.5px] uppercase tracking-[0.14em] text-kr-muted/60">
                {reference}
              </p>
            )}
          </div>
        </div>
      </button>
    </li>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <label className="kr-label block">
        {label}
        {hint && <span className="ml-2 normal-case tracking-normal opacity-60">({hint})</span>}
      </label>
      {children}
    </div>
  );
}
