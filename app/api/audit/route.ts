import { NextResponse } from 'next/server';
import { REGIONS, isRegionKey, parseEnabledRegions, US_DEFAULTS } from '@/lib/regions';

/**
 * Server-side audit proxy.
 *
 * Why this route exists at all (the browser used to POST to n8n directly):
 *
 *  1. REGION ENFORCEMENT. A US-only customer deployment must be unable to
 *     reach the India workflow and vice versa. Hiding a toggle in the client
 *     is not enforcement — anyone can craft a POST. The allow-list check
 *     below is the actual boundary.
 *  2. The n8n hostname leaves the client bundle. It used to be a string
 *     literal in app/page.tsx, which meant changing n8n hosts required a code
 *     commit and redeploy. It is now an env var.
 *  3. Same-origin. No dependence on n8n's CORS configuration.
 *  4. A single place to add customer auth later.
 *
 * NOTE ON TIMEOUT. The browser talking to n8n directly had no execution
 * limit; a Vercel function does. Observed audits run 11-13 s, but the US
 * workflow allows Vision_Primary 120 s plus retries plus a fallback model, so
 * a worst-case run can exceed a Hobby plan's 60 s function ceiling. maxDuration
 * below requests 300 s; Vercel clamps it to whatever the plan permits.
 */

export const maxDuration = 300;

/** Leave headroom under maxDuration so we return a real message, not a 504. */
const UPSTREAM_TIMEOUT_MS = Number(process.env.AUDIT_TIMEOUT_MS ?? 240_000);

function n8nBaseUrl(): string {
  const raw = (process.env.N8N_BASE_URL ?? 'https://n8n.kratuailabs.com').trim();
  return raw.replace(/\/+$/, '');
}

export async function POST(request: Request) {
  const enabledRegions = parseEnabledRegions(process.env.ENABLED_REGIONS);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { status: 'REJECTED', error_code: 'BODY_NOT_JSON', error: 'Request body was not valid JSON.' },
      { status: 400 },
    );
  }

  // ---------------------------------------------------------------- region
  const region = body.region;
  if (!isRegionKey(region)) {
    return NextResponse.json(
      {
        status: 'REJECTED',
        error_code: 'REGION_INVALID',
        error: `"region" must be one of: ${Object.keys(REGIONS).join(', ')}.`,
        received_value: String(region ?? ''),
      },
      { status: 400 },
    );
  }

  // The enforcement boundary. Do not weaken this into a client-side concern.
  if (!enabledRegions.includes(region)) {
    return NextResponse.json(
      {
        status: 'REJECTED',
        error_code: 'REGION_NOT_ENABLED',
        error: `Region "${region}" is not enabled on this deployment.`,
      },
      { status: 403 },
    );
  }

  const regionDef = REGIONS[region];

  // ------------------------------------------------------------ image_url
  const imageUrl = typeof body.image_url === 'string' ? body.image_url.trim() : '';
  if (!imageUrl) {
    return NextResponse.json(
      { status: 'REJECTED', error_code: 'IMAGE_URL_MISSING', error: '"image_url" is required.' },
      { status: 400 },
    );
  }

  const siteId = typeof body.site_id === 'string' ? body.site_id.trim() : '';

  // ------------------------------------------------------- upstream payload
  // Built per region rather than forwarded wholesale, so the India workflow
  // receives exactly the two fields its PARSE_Input reads and nothing new.
  const payload: Record<string, unknown> = {
    image_url: imageUrl,
    site_id: siteId || 'UNKNOWN-SITE',
  };

  if (regionDef.fields.includes('jurisdiction')) {
    payload.jurisdiction = pickString(body.jurisdiction, US_DEFAULTS.jurisdiction);
  }
  if (regionDef.fields.includes('occupancy_type')) {
    payload.occupancy_type = pickString(body.occupancy_type, US_DEFAULTS.occupancy_type);
  }
  if (regionDef.fields.includes('equipment_hint')) {
    payload.equipment_hint = pickString(body.equipment_hint, US_DEFAULTS.equipment_hint);
  }
  if (regionDef.fields.includes('osha_workplace')) {
    // The backend treats anything !== false as true; mirror that explicitly.
    payload.osha_workplace = body.osha_workplace !== false;
  }
  if (typeof body.inspector_id === 'string' && body.inspector_id.trim()) {
    payload.inspector_id = body.inspector_id.trim();
  }
  if (typeof body.asset_tag === 'string' && body.asset_tag.trim()) {
    payload.asset_tag = body.asset_tag.trim();
  }

  const target = `${n8nBaseUrl()}/webhook/${regionDef.webhookPath}`;
  const startedAt = Date.now();

  // --------------------------------------------------------------- dispatch
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return NextResponse.json(
      {
        status: 'ERROR',
        error_code: timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE',
        error: timedOut
          ? `The audit engine did not respond within ${Math.round(UPSTREAM_TIMEOUT_MS / 1000)}s.`
          : 'Could not reach the audit engine.',
        // Deliberately not echoing `target`: the upstream host is server-side
        // configuration and should not be disclosed to the browser.
        region,
        elapsed_ms: Date.now() - startedAt,
      },
      { status: 504 },
    );
  }

  const text = await upstream.text();

  // n8n returns JSON for both the 200 and the structured 400 from
  // RESPOND_BadRequest. Pass the status through so the client can distinguish
  // "you sent something invalid" from "the engine broke".
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return NextResponse.json(
      {
        status: 'ERROR',
        error_code: 'UPSTREAM_NOT_JSON',
        error: `The audit engine returned a non-JSON response (HTTP ${upstream.status}).`,
        upstream_status: upstream.status,
        upstream_body: text.slice(0, 500),
        region,
      },
      { status: 502 },
    );
  }

  const withMeta =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, unknown>), region, proxy_elapsed_ms: Date.now() - startedAt }
      : parsed;

  return NextResponse.json(withMeta, { status: upstream.status });
}

function pickString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}
