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

/**
 * Must match the header name on the n8n Header Auth credentials bound to BOTH
 * audit webhooks.
 *
 * One header name for both regions, deliberately: this route is a single proxy
 * serving both, so a per-region header name would mean looking up which name to
 * send — branching that buys nothing. The two credentials differ only in their
 * n8n label and (potentially) their value.
 *
 * Distinct from x-audit-history-key on purpose. The records endpoint is read-only;
 * these two spend money on every call. Sharing one secret across both would mean
 * that handing the records key to a BI tool or a client dashboard also hands over
 * unlimited model spend, with no way to revoke one without breaking the other.
 */
const AUTH_HEADER = 'x-audit-api-key';

function n8nBaseUrl(): string {
  const raw = (process.env.N8N_BASE_URL ?? 'https://n8n.kratuailabs.com').trim();
  return raw.replace(/\/+$/, '');
}

/**
 * Per-region key with a shared fallback.
 *
 * AUDIT_API_KEY covers both regions, which is the expected setup. AUDIT_API_KEY_IND
 * and AUDIT_API_KEY_US override it, so the day one region's key has to be rotated
 * independently — a US customer calling their webhook directly, say — it is an
 * environment change rather than a code change.
 *
 * Literal lookups rather than process.env[`AUDIT_API_KEY_${region}`]: a dynamic key
 * defeats static analysis in some bundling modes, and this value decides whether an
 * audit is authenticated at all.
 *
 * Trimmed for the reason /api/history documents: `fetch` throws TypeError on a
 * header value containing a newline, and that would surface below as
 * UPSTREAM_UNREACHABLE — blaming the network for a trailing newline picked up
 * pasting a key into Vercel.
 */
function auditApiKey(region: 'IND' | 'US'): string | undefined {
  const perRegion = region === 'US' ? process.env.AUDIT_API_KEY_US : process.env.AUDIT_API_KEY_IND;
  return perRegion?.trim() || process.env.AUDIT_API_KEY?.trim() || undefined;
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
  // Region-gated like the rest. These two were previously appended
  // unconditionally, which contradicted the promise above: India's PARSE_Input
  // reads neither and its table has no column for either, so forwarding them was
  // sending fields the workflow was documented never to receive.
  if (regionDef.fields.includes('inspector_id') && typeof body.inspector_id === 'string') {
    if (body.inspector_id.trim()) payload.inspector_id = body.inspector_id.trim();
  }
  if (regionDef.fields.includes('asset_tag') && typeof body.asset_tag === 'string') {
    if (body.asset_tag.trim()) payload.asset_tag = body.asset_tag.trim();
  }

  const target = `${n8nBaseUrl()}/webhook/${regionDef.webhookPath}`;
  const startedAt = Date.now();

  // ------------------------------------------------------------------- auth
  const apiKey = auditApiKey(region);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers[AUTH_HEADER] = apiKey;
  } else {
    /**
     * DELIBERATELY FAILS OPEN, and this is a migration path rather than the
     * destination.
     *
     * Failing closed here would mean that deploying this code before the
     * environment variable is set takes every audit down — an outage caused by
     * shipping, before anyone has had a chance to configure anything. Sending no
     * header preserves exactly today's behaviour, which is what allows the safe
     * rollout order: deploy the code (n8n ignores a header it is not checking),
     * then set the key, then bind the credentials in n8n.
     *
     * Once the credential IS bound, an unset key stops being silent: n8n returns
     * 403 and the handler below says precisely what is wrong.
     */
    console.warn(
      `[audit] AUDIT_API_KEY is not set — calling ${regionDef.webhookPath} unauthenticated. ` +
        'Anyone who knows the webhook URL can spend model credits. See .env.example.',
    );
  }

  // --------------------------------------------------------------- dispatch
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: 'POST',
      headers,
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

  // n8n's own rejection for a missing or mismatched Header Auth credential is not
  // JSON, so without this it would fall through to UPSTREAM_NOT_JSON — "the engine
  // returned a non-JSON response" — which points nowhere useful. This is the single
  // most likely failure the first time the credential is bound, and on any later
  // key rotation, so it names the exact thing to check.
  if (upstream.status === 401 || upstream.status === 403) {
    return NextResponse.json(
      {
        status: 'ERROR',
        error_code: 'AUDIT_AUTH_REJECTED',
        error:
          `The ${region} audit workflow rejected the request key. Confirm the n8n Header Auth ` +
          `credential is bound to the ${regionDef.webhookPath} webhook, uses header ` +
          `"${AUTH_HEADER}", and that its value matches ` +
          `${region === 'US' ? 'AUDIT_API_KEY_US' : 'AUDIT_API_KEY_IND'} or AUDIT_API_KEY.` +
          (apiKey ? '' : ' No key is currently configured on this deployment.'),
        upstream_status: upstream.status,
        region,
      },
      { status: 502 },
    );
  }

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
