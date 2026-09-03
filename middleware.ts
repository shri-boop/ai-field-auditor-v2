import { NextResponse, type NextRequest } from 'next/server';

/**
 * HTTP Basic access control.
 *
 * Why this exists: the dashboard was completely open. Anyone with the URL could
 * run audits, and every audit is a paid Claude Sonnet 4.5 vision call — so an
 * open URL is a metered spend endpoint. It also means you cannot hand the URL to
 * a customer, which is the whole point of the per-region deployments.
 *
 * OPT-IN BY DESIGN. With AUDIT_ACCESS_USER / AUDIT_ACCESS_PASSWORD unset this
 * middleware does nothing at all. Deploying it therefore cannot lock anyone out;
 * protection begins the moment the variables are set in Vercel, with no code
 * change. Fail-open is the right default *here* precisely because the failure
 * mode of fail-closed would be locking the owner out of a live tool, and the
 * variables are trivially verifiable.
 *
 * Honest about what this is NOT: one shared credential, no logout, no per-user
 * attribution. It closes the spend hole and gates the URL. It is not the
 * identity layer that sign-off will need — a legally meaningful signoff_by has
 * to name a person, so real accounts come with that feature.
 */

const REALM = 'KRATU Field Audit';

export function middleware(request: NextRequest) {
  const user = process.env.AUDIT_ACCESS_USER;
  const password = process.env.AUDIT_ACCESS_PASSWORD;

  // Not configured -> inert.
  if (!user || !password) return NextResponse.next();

  const header = request.headers.get('authorization') ?? '';
  const [scheme, encoded] = header.split(' ');

  if (scheme === 'Basic' && encoded) {
    let decoded = '';
    try {
      decoded = atob(encoded);
    } catch {
      decoded = '';
    }

    // Split on the FIRST colon only: passwords may legitimately contain colons.
    const separator = decoded.indexOf(':');
    if (separator !== -1) {
      const suppliedUser = decoded.slice(0, separator);
      const suppliedPassword = decoded.slice(separator + 1);

      if (safeEqual(suppliedUser, user) && safeEqual(suppliedPassword, password)) {
        return NextResponse.next();
      }
    }
  }

  return new NextResponse('Authentication required.', {
    status: 401,
    headers: {
      // Prompts the browser once, then it caches for the session.
      'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * Length-independent comparison. Not a substitute for a real constant-time
 * primitive, but it avoids the trivial early-return leak of `===` on secrets
 * and works in the Edge runtime, where node:crypto.timingSafeEqual is absent.
 */
function safeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Cover the page AND the API routes. Gating only the page would leave
 * /api/audit and /api/upload open, which is where the actual spend happens.
 * Static assets and the favicon are excluded so the 401 prompt renders cleanly.
 */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.*|apple-icon.*|brand/).*)'],
};
