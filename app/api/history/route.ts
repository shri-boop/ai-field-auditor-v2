import { NextResponse } from 'next/server';
import { isRegionKey, parseEnabledRegions } from '@/lib/regions';

/**
 * Audit records lookup — server-side proxy to the n8n history workflow.
 *
 * WHY A PROXY AND NOT A DIRECT DATABASE QUERY
 * Postgres has no `ports:` mapping in the stack's docker-compose; it is reachable
 * only on the internal docker network. Vercel therefore cannot reach it, and that
 * is the correct arrangement — exposing the database to the internet to serve a
 * history page would be a far worse problem than the one it solves. n8n is
 * already public via Caddy, already holds the Postgres credential, and already
 * sits on that network, so retrieval goes the same route audits do.
 *
 * THREE THINGS THIS ENFORCES
 *  1. Region. An India deployment must not be able to read the US table. Same
 *     allow-list as /api/audit, checked server-side because a hidden tab is not
 *     a boundary.
 *  2. The shared secret. HISTORY_API_KEY is attached here so it never reaches
 *     the browser. The n8n webhook has Header Auth bound, so an unauthenticated
 *     caller who finds the webhook URL still gets nothing.
 *  3. Nothing else. This route cannot write. The workflow behind it is SELECT
 *     only.
 *
 * The endpoint reads customer site identifiers and their fire-safety
 * deficiencies, so it sits behind the Basic auth middleware as well.
 */

export const maxDuration = 60;

const UPSTREAM_TIMEOUT_MS = Number(process.env.HISTORY_TIMEOUT_MS ?? 30_000);

/** Must match the header configured on the n8n Header Auth credential. */
const AUTH_HEADER = 'x-audit-history-key';

function n8nBaseUrl(): string {
  const raw = (process.env.N8N_BASE_URL ?? 'https://n8n.kratuailabs.com').trim();
  return raw.replace(/\/+$/, '');
}

export async function POST(request: Request) {
  const apiKey = process.env.HISTORY_API_KEY;

  // Fail loudly rather than letting n8n return an opaque 403. Absence of the key
  // is a deployment-configuration state, not a caller error.
  if (!apiKey) {
    return NextResponse.json(
      {
        query_ok: false,
        error_code: 'RECORDS_NOT_CONFIGURED',
        error:
          'Audit records are not configured on this deployment. Set HISTORY_API_KEY to the ' +
          'value of the Audit History Key credential bound to the n8n webhook.',
      },
      { status: 503 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { query_ok: false, error_code: 'BODY_NOT_JSON', error: 'Request body was not valid JSON.' },
      { status: 400 },
    );
  }

  // ---------------------------------------------------------------- region
  const region = body.region;
  if (!isRegionKey(region)) {
    return NextResponse.json(
      {
        query_ok: false,
        error_code: 'REGION_INVALID',
        error: '"region" must be one of: IND, US.',
        received_value: String(region ?? ''),
      },
      { status: 400 },
    );
  }

  if (!parseEnabledRegions(process.env.ENABLED_REGIONS).includes(region)) {
    return NextResponse.json(
      {
        query_ok: false,
        error_code: 'REGION_NOT_ENABLED',
        error: `Region "${region}" is not enabled on this deployment.`,
      },
      { status: 403 },
    );
  }

  // ---------------------------------------------------- forwarded filters
  // Allow-listed rather than spread, so a caller cannot inject unexpected keys
  // into the workflow's body and reach a code path this route did not intend.
  const payload: Record<string, unknown> = { region };
  for (const field of ['site_id', 'asset_tag', 'audit_id', 'status', 'from', 'to'] as const) {
    const value = body[field];
    if (typeof value === 'string' && value.trim()) payload[field] = value.trim();
  }
  for (const field of ['limit', 'offset'] as const) {
    const value = Number(body[field]);
    if (Number.isFinite(value)) payload[field] = value;
  }

  const target = `${n8nBaseUrl()}/webhook/audit-history`;
  const startedAt = Date.now();

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [AUTH_HEADER]: apiKey,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return NextResponse.json(
      {
        query_ok: false,
        error_code: timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE',
        error: timedOut
          ? `The records service did not respond within ${Math.round(UPSTREAM_TIMEOUT_MS / 1000)}s.`
          : 'Could not reach the records service.',
        region,
        elapsed_ms: Date.now() - startedAt,
      },
      { status: 504 },
    );
  }

  const text = await upstream.text();

  // n8n's own 403 for a missing/incorrect Header Auth credential is not JSON.
  // Translate it, because "the credential is not bound in n8n" is the single
  // most likely failure on first use and deserves to say so.
  if (upstream.status === 401 || upstream.status === 403) {
    return NextResponse.json(
      {
        query_ok: false,
        error_code: 'RECORDS_AUTH_REJECTED',
        error:
          'The records workflow rejected the request key. Confirm the n8n Header Auth ' +
          `credential is bound to the audit-history webhook, uses header "${AUTH_HEADER}", ` +
          'and that its value matches HISTORY_API_KEY.',
        upstream_status: upstream.status,
        region,
      },
      { status: 502 },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return NextResponse.json(
      {
        query_ok: false,
        error_code: 'UPSTREAM_NOT_JSON',
        error: `The records service returned a non-JSON response (HTTP ${upstream.status}).`,
        upstream_status: upstream.status,
        upstream_body: text.slice(0, 500),
        region,
      },
      { status: 502 },
    );
  }

  const withMeta =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, unknown>), proxy_elapsed_ms: Date.now() - startedAt }
      : parsed;

  return NextResponse.json(withMeta, { status: upstream.status });
}
