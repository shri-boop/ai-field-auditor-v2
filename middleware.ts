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
 * change. That also doubles as the emergency exit: remove either variable,
 * redeploy, and the app is open again.
 *
 * Honest about what this is NOT: one shared credential, no logout, no per-user
 * attribution. It closes the spend hole and gates the URL. It is not the
 * identity layer that sign-off will need — a legally meaningful signoff_by has
 * to name a person, so real accounts come with that feature.
 */

const REALM = 'KRATU Field Audit';

export function middleware(request: NextRequest) {
  /**
   * Trimmed deliberately.
   *
   * A stored credential picks up a trailing newline embarrassingly easily — a
   * piped `printf`, a copy-paste into the Vercel dashboard that grabs the line
   * ending, an editor that adds a final newline. Compared byte-for-byte, that
   * invisible character produces a total lockout with no diagnostic whatsoever:
   * the prompt reappears forever and the correct password looks wrong.
   *
   * The theoretical cost is a password whose leading or trailing whitespace is
   * meaningful. That is a pathological credential, and losing it is a far better
   * outcome than an operator locked out of a live tool by a character they
   * cannot see.
   */
  const user = process.env.AUDIT_ACCESS_USER?.trim();
  const password = process.env.AUDIT_ACCESS_PASSWORD?.trim();

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
    // Safe to do on the decoded string even though it holds raw bytes — a
    // UTF-8 continuation byte can never be 0x3A, so the first ':' is always the
    // real separator.
    const separator = decoded.indexOf(':');
    if (separator !== -1) {
      const suppliedUser = decoded.slice(0, separator);
      const suppliedPassword = decoded.slice(separator + 1);

      if (
        safeEqual(suppliedUser, user) &&
        safeEqual(suppliedPassword, password)
      ) {
        return NextResponse.next();
      }

      // A rejected credential is otherwise indistinguishable from a
      // misconfigured one, which is exactly the situation that wastes an
      // afternoon. This says which half failed and whether the stored value
      // looked malformed, without ever emitting a secret. Server-side only —
      // Vercel runtime logs.
      console.warn(
        '[auth] credential rejected',
        JSON.stringify({
          username_matched: safeEqual(suppliedUser, user),
          stored_user_had_surrounding_whitespace:
            process.env.AUDIT_ACCESS_USER !== process.env.AUDIT_ACCESS_USER?.trim(),
          stored_password_had_surrounding_whitespace:
            process.env.AUDIT_ACCESS_PASSWORD !== process.env.AUDIT_ACCESS_PASSWORD?.trim(),
          supplied_password_length: suppliedPassword.length,
          expected_password_length: password.length,
        }),
      );
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
 * Byte-wise, length-independent comparison.
 *
 * `supplied` arrives from atob(), which yields a binary string: one character
 * per byte, values 0–255. `expected` is an ordinary JS string from the
 * environment. Encoding BOTH with TextEncoder would be wrong — it would re-encode
 * the already-decoded bytes as UTF-8 and double-encode anything above U+007F, so
 * a password containing é or ö could never authenticate no matter what was typed.
 * Instead the binary string is read back byte by byte and the expected value is
 * encoded once.
 *
 * Not a substitute for a real constant-time primitive, but it avoids the trivial
 * early-return leak of `===` on a secret and works in the Edge runtime, where
 * node:crypto.timingSafeEqual is unavailable.
 */
function safeEqual(supplied: string, expected: string): boolean {
  const left = binaryStringToBytes(supplied);
  const right = new TextEncoder().encode(expected);

  let diff = left.length ^ right.length;
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

function binaryStringToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) {
    bytes[i] = value.charCodeAt(i) & 0xff;
  }
  return bytes;
}

/**
 * Cover the page AND the API routes. Gating only the page would leave
 * /api/audit, /api/upload and /api/history open, which is where the spend and
 * the customer data are. Static assets and the favicon are excluded so the 401
 * prompt renders cleanly.
 */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.*|apple-icon.*|brand/).*)'],
};
