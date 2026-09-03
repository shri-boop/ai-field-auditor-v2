import { AuditConsole } from '@/components/audit-console';
import { parseEnabledRegions } from '@/lib/regions';

/**
 * Server component. Its only job is to resolve which regions this deployment
 * is allowed to offer, then hand that list to the client console.
 *
 * Reading ENABLED_REGIONS here (rather than a NEXT_PUBLIC_ mirror) keeps one
 * env var as the single source of truth for both the UI and the API route's
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
 * Read ENABLED_REGIONS per request rather than at build time.
 *
 * This page uses no dynamic API (no cookies, headers or searchParams), so Next
 * would otherwise statically prerender it and inline whatever ENABLED_REGIONS
 * held during `next build`. Vercel does not rebuild when you edit an
 * environment variable, so changing the region scope would silently do nothing
 * until the next unrelated deploy — the exact failure that looks like "I set
 * the variable and the US switch still isn't there".
 *
 * The cost is one function invocation per page load instead of a static hit,
 * which is irrelevant for an internal audit console and well worth paying to
 * make the region scope a live setting.
 */
export const dynamic = 'force-dynamic';

export default function Page() {
  const enabledRegions = parseEnabledRegions(process.env.ENABLED_REGIONS);

  return <AuditConsole enabledRegions={enabledRegions} />;
}
