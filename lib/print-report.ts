import type { AuditResult } from '@/lib/audit-types';
import { BRAND } from '@/lib/brand';

/**
 * Printing a report with a meaningful filename.
 *
 * Browsers derive the default "Save as PDF" filename from `document.title`. That
 * title is set once in the metadata — "AQUILA — Fire Compliance | KRATU AI Labs" —
 * so every saved record arrived with an identical name and had to be retyped, or
 * silently overwrote the last one.
 *
 * WHY IDENTITY AND NOT A COUNTER
 * The obvious fix is an incrementing suffix, but it would be wrong: re-printing
 * the same record should produce the same file, not a -2. A counter also lives in
 * the browser, so it resets, diverges between machines, and means nothing to
 * whoever receives the PDF. Naming from the record's own identity is stable,
 * unique (audit_id is a primary key), and sorts usefully in a folder — which is
 * how these are actually filed.
 */

/** Windows/macOS reserved characters, plus anything that trips a shell. */
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;

function slug(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(ILLEGAL, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .trim();
}

/** YYYY-MM-DD, so a folder listing sorts chronologically. */
function datePart(result: AuditResult): string {
  const raw = result.audit_timestamp ?? result.created_at;
  if (!raw) return '';
  const parsed = new Date(raw);
  if (isNaN(parsed.getTime())) return '';
  return parsed.toISOString().slice(0, 10);
}

/**
 * e.g. AQUILA_SITE-CA-LAX-888_2026-09-03_COMPLIANT_FA-US-20260903-A1F0BEA2-Y24EC
 *
 * Site first because records are filed by location, then date, then verdict — the
 * three things someone scans a folder for. The reference goes last: it guarantees
 * uniqueness but nobody reads it first.
 */
export function reportFilename(result: AuditResult, siteFallback?: string): string {
  const reference =
    result.audit_id ?? (result.record_id != null ? `REC-${result.record_id}` : '');

  const parts = [
    BRAND.productName,
    slug(result.site_id ?? siteFallback),
    datePart(result),
    slug(result.status),
    slug(reference),
  ].filter(Boolean);

  // Belt and braces: never hand the browser an empty name.
  return parts.length > 1 ? parts.join('_') : `${BRAND.productName}_field-audit-record`;
}

/**
 * Set the title, print, put it back.
 *
 * The browser reads `document.title` when it builds the print preview, so the
 * restore has to happen after that — hence `afterprint` rather than a line
 * immediately following `window.print()`. The timeout is a leak guard only:
 * `afterprint` is not fired reliably by every browser and path, and without it a
 * filename would be left sitting in the browser tab. Restoring while a dialog is
 * still open is harmless, because the name has already been captured into it.
 */
export function printAuditReport(result: AuditResult, siteFallback?: string): void {
  if (typeof window === 'undefined') return;

  const previousTitle = document.title;
  document.title = reportFilename(result, siteFallback);

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    document.title = previousTitle;
    window.removeEventListener('afterprint', restore);
  };

  window.addEventListener('afterprint', restore);
  window.setTimeout(restore, 60_000);

  window.print();
}
