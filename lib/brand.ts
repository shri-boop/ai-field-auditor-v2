/**
 * KRATU AI Labs brand constants.
 *
 * Single source of truth for anything a reader sees that identifies the company
 * or the product. The product name in particular is isolated here deliberately:
 * naming is still settling, and this way a rename is a one-line change rather
 * than a hunt through JSX.
 *
 * Palette and type tokens live in app/globals.css as CSS variables (--kr-*),
 * mirroring blog/branding/assets/kratu-blog.css in the agentic-dev-stack repo so
 * the dashboard, the blog and outbound email stay visually continuous.
 */

export const BRAND = {
  /** Company. Rendered as KRATU (light) + AI LABS (gold). */
  companyFirst: 'KRATU',
  companySecond: 'AI LABS',
  companyFull: 'KRATU AI Labs',

  /**
   * Casing is LOCKED by .kiro/steering/kratu-email-template.md in the
   * agentic-dev-stack repo. Do not restyle to title case or drop the period.
   */
  tagline: 'Intelligence, Engineered to Act.',

  /** Product name. See the note above before changing. */
  productName: 'AQUILA',

  /**
   * Title case, for the script wordmark. Script faces have no real uppercase —
   * setting a calligraphic face in all caps breaks the letter joins and reads as
   * a mistake — so the display form is stored separately rather than derived
   * from productName with text-transform.
   */
  productWordmark: 'Aquila',

  productDescriptor: 'Fire Compliance',

  /** Logomark. Effectively transparent, so it composites onto ink with no seam. */
  markSrc: '/brand/kratu-mark.png',
} as const;

/** e.g. "AQUILA · Fire Compliance" */
export const PRODUCT_LOCKUP = `${BRAND.productName} · ${BRAND.productDescriptor}`;
