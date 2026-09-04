'use client';

import { useEffect, useState } from 'react';
import { History } from 'lucide-react';
import { REGIONS, type RegionKey } from '@/lib/regions';
import { statusTone, TONES, type AuditResult } from '@/lib/audit-types';

/**
 * Prior-audit context for the site being entered.
 *
 * This is the answer to "two records with the same site ID" — but as information,
 * not a block. A site_id is a LOCATION: it holds many devices and is audited
 * repeatedly, because NFPA 10 and NFPA 25 require periodic inspection. Refusing a
 * repeat would make it impossible to audit a second extinguisher at one address
 * or to re-inspect the same one next month, which is most of the product.
 *
 * What was actually missing is that the operator had no idea the site had been
 * seen before. So: show the count and the last verdict, and let them decide. If
 * it is a genuine duplicate they will recognise it; if it is the next device or
 * the next month, nothing stands in their way.
 *
 * Deliberately quiet about failure. This is advisory context on a form whose real
 * job is elsewhere — a records outage must not produce an alarming error next to
 * the audit button, so a failed lookup renders nothing at all.
 */

const DEBOUNCE_MS = 600;
const LOOKUP_LIMIT = 5;

interface State {
  status: 'idle' | 'loading' | 'found' | 'none';
  count: number;
  pageFull: boolean;
  latest?: AuditResult;
}

export function SiteHistoryNotice({
  region,
  siteId,
  enabled,
}: {
  region: RegionKey;
  siteId: string;
  enabled: boolean;
}) {
  const [state, setState] = useState<State>({ status: 'idle', count: 0, pageFull: false });

  useEffect(() => {
    const trimmed = siteId.trim();

    // Short fragments would fire a query on every early keystroke and tell the
    // operator nothing useful.
    if (!enabled || trimmed.length < 4) {
      setState({ status: 'idle', count: 0, pageFull: false });
      return;
    }

    let cancelled = false;
    setState((prev) => ({ ...prev, status: 'loading' }));

    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch('/api/history', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ region, site_id: trimmed, limit: LOOKUP_LIMIT }),
        });
        if (cancelled) return;

        if (!res.ok) {
          setState({ status: 'idle', count: 0, pageFull: false });
          return;
        }

        const data: { rows?: AuditResult[]; count?: number; page_full?: boolean } =
          await res.json();
        if (cancelled) return;

        const rows = data.rows ?? [];
        setState({
          status: rows.length > 0 ? 'found' : 'none',
          count: rows.length,
          pageFull: data.page_full === true,
          latest: rows[0],
        });
      } catch {
        if (!cancelled) setState({ status: 'idle', count: 0, pageFull: false });
      }
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [region, siteId, enabled]);

  if (state.status === 'idle' || state.status === 'loading') return null;

  if (state.status === 'none') {
    return (
      <p className="flex items-center gap-2 text-[10px] text-kr-muted">
        <History className="h-3 w-3 shrink-0" />
        No prior audits recorded at this site.
      </p>
    );
  }

  const latest = state.latest;
  const tone = statusTone(latest?.status);
  const when = latest?.audit_timestamp
    ? new Date(latest.audit_timestamp).toLocaleDateString(REGIONS[region].timestampLocale, {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      })
    : null;

  // page_full means the lookup hit its own limit, so the true total is unknown.
  // Say "5+" rather than inventing a number we did not count.
  const countLabel = state.pageFull ? `${state.count}+` : `${state.count}`;

  return (
    <div
      className="kr-verdict flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
      style={{ borderLeftColor: TONES.warn.rule, background: TONES.warn.fill }}
    >
      <History className="h-3.5 w-3.5 shrink-0" style={{ color: TONES.warn.text }} />
      <p className="text-[11px] text-kr-body">
        <span className="font-semibold">{countLabel}</span> prior audit
        {state.count === 1 && !state.pageFull ? '' : 's'} at this site
        {when && latest?.status && (
          <>
            {' · last '}
            {when}
            {', '}
            <span style={{ color: tone === 'neutral' ? undefined : TONES[tone].text }}>
              {latest.status}
            </span>
          </>
        )}
      </p>
      {latest?.asset_tag && (
        <span className="kr-data text-[10px] text-kr-muted">last asset {latest.asset_tag}</span>
      )}
    </div>
  );
}
