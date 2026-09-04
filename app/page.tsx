import { AuditConsole } from '@/components/audit-console';
import { parseEnabledRegions } from '@/lib/regions';

/**
 * Server component. Its only job is to resolve what this deployment is allowed
 * to offer, then hand that to the client console.
 *
 * Reading the environment here (rather than through NEXT_PUBLIC_ mirrors) keeps
 * one variable as the single source of truth for both the UI and the API routes'
 * enforcement, so the two can never drift apart.
 *
 * Region gating per deployment:
 *   ENABLED_REGIONS=IND      India customer  — no US surface rendered
 *   ENABLED_REGIONS=US       US customer     — no India surface rendered
 *   ENABLED_REGIONS=IND,US   internal / demo — switch visible
 *
 * Unset falls back to IND. See parseEnabledRegions for why it fails closed.
 */

/**
 * Read the environment per request rather than at build time.
 *
 * This page uses no dynamic API (no cookies, headers or searchParams), so Next
 * would otherwise statically prerender it and inline whatever these variables
 * held during `next build`. Vercel does not rebuild when you edit an
 * environment variable, so changing the region scope would silently do nothing
 * until the next unrelated deploy — the exact failure that looks like "I set
 * the variable and the US switch still isn't there".
 *
 * The cost is one function invocation per page load instead of a static hit,
 * which is irrelevant for an internal audit console and well worth paying to
 * make the configuration a live setting.
 */
export const dynamic = 'force-dynamic';

export default function Page() {
  const enabledRegions = parseEnabledRegions(process.env.ENABLED_REGIONS);

  // Records depend on the n8n history workflow and its shared secret. Without
  // the key /api/history returns 503, so the tab is hidden rather than offered
  // and broken. Presence of the key is the whole feature flag.
  //
  // Trimmed to match how the route reads it. Without that, a value of only
  // whitespace would be truthy here and blank there — the tab would render and
  // then every search would fail with RECORDS_NOT_CONFIGURED, which is the worst
  // of both behaviours.
  const recordsEnabled = Boolean(process.env.HISTORY_API_KEY?.trim());

  return <AuditConsole enabledRegions={enabledRegions} recordsEnabled={recordsEnabled} />;
}
