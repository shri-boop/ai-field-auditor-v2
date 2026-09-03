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
export default function Page() {
  const enabledRegions = parseEnabledRegions(process.env.ENABLED_REGIONS);

  return <AuditConsole enabledRegions={enabledRegions} />;
}
