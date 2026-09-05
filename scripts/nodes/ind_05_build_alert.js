/**
 * INDIA NODE 5 — NOTIFY_OpsManager
 * Mode: Run Once for All Items
 *
 * Composes the Slack, Telegram and email bodies. Reads SHAPE_Response's output.
 *
 * Output field names are unchanged (telegram_message, slack_message, email_html,
 * email_subject, alert, …) so SEND_Slack, SEND_Telegram and the Gmail node need
 * no edits.
 *
 * ---------------------------------------------------------------------------
 * THREE FIXES BEYOND THE SEVERITY REWRITE
 * ---------------------------------------------------------------------------
 * 1. `$input.item` -> `$input.first()`.
 *    The previous version read `$input.item.json`, which n8n only provides in
 *    "Run Once for Each Item" mode. This node has no `mode` parameter set, so it
 *    runs in the default all-items mode, where `.item` is not available. Using
 *    `.first()` is valid in either mode, so the question stops mattering.
 *
 * 2. Telegram and Slack payloads are escaped.
 *    SEND_Telegram posts with parse_mode: HTML. Findings are model prose, so a
 *    single "&" or "<" in an observation makes Telegram reject the whole message
 *    with a parse error — the alert is lost, and lost precisely on the messiest
 *    findings, which are the ones most likely to contain odd characters. Slack
 *    needs the same three characters escaped.
 *
 * 3. The footer said "FireScan Mumbai | Powered by Arvami Solutionz".
 *    Stale product name, stale company. It is now KRATU AI Labs / AQUILA, with
 *    the statute stated the way lib/regions.ts states it.
 */

const a = $input.first().json;

const status = a.status || 'UNKNOWN';
// Minted by VALIDATE_Input as of migration 006. Worth a line of its own in the
// alert: when someone forwards a Telegram message asking "what happened here?",
// this is the only string that finds the row.
const audit_id = a.audit_id || null;
const site_id = a.site_id || 'unknown';
const asset_tag = a.asset_tag || null;
const equipment = a.equipment_type || 'Unknown Equipment';
const confidence = a.confidence || 'N/A';
const image_quality = a.image_quality || 'N/A';
const risk_score = typeof a.risk_score === 'number' ? a.risk_score : null;
const persisted = a.persisted !== false;
const timestamp = a.audit_timestamp || new Date().toISOString();

const counts = a.severity_counts || {};
const critical_count = counts.critical || 0;
const major_count = counts.major || 0;
const minor_count = counts.minor || 0;

const indiaTime = new Date(timestamp).toLocaleString('en-IN', {
  timeZone: 'Asia/Kolkata',
  dateStyle: 'medium',
  timeStyle: 'short'
});

// ---------------------------------------------------------------- coercion
/**
 * Tolerates an array, a stringified JSON array, or a bare string. The India
 * table stores `violations` as stringified JSON in a text column, and this node
 * may be re-run against a row read back from it.
 */
function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === '') return [];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [trimmed];
    } catch (e) {
      // Keep the whole string as one finding. Dropping a violation line because
      // it would not parse is not an acceptable failure for a safety alert.
      return [trimmed];
    }
  }
  return [String(value)];
}

/**
 * Escapes the three characters that break Telegram's HTML parse mode and Slack's
 * mrkdwn. Applied to every interpolated value rather than to the finished string,
 * so the formatting characters we author ourselves survive.
 */
function esc(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Splits a model-emitted item of the form "CHECKLIST_CODE - prose" into its two
 * parts.
 *
 * The model prefixes unverifiable items with the checklist code it was reasoning
 * about. That is genuinely useful to a technician who knows the checklist, and it
 * is NOT stripped — but a bare SCREAMING_SNAKE_CASE token leading a sentence
 * inside a run-on paragraph is what made these messages unreadable. Separating the
 * two lets each channel present the code as a label and the prose as prose.
 *
 * Returns the whole string as `text` with a null `code` when there is no prefix,
 * so an item is never dropped or truncated for failing to match a shape the model
 * was never contractually required to produce.
 */
function splitCoded(item) {
  const s = String(item === undefined || item === null ? '' : item).trim();
  const m = s.match(/^([A-Z][A-Z0-9_]{2,})\s*[-\u2013\u2014:]\s+([\s\S]+)$/);
  if (!m) return { code: null, text: s };
  return { code: m[1], text: m[2].trim() };
}

/**
 * ONE ITEM PER LINE, in every channel.
 *
 * These lists were previously flattened with `join('; ')` into a single line. For a
 * REINSPECT that is the worst possible choice: the unverifiable items ARE the
 * substance of the message — the answer to "why can't you judge this photograph?"
 * — and seven of them concatenated into one paragraph is unreadable exactly when
 * the reader most needs to act on it.
 *
 * `bullet` and `strong` are supplied per channel so the same structure renders as
 * Telegram HTML, Slack mrkdwn, or plain text without three copies of this logic.
 */
function bulletise(items, bullet, strong) {
  return items.map(function (item) {
    const parts = splitCoded(item);
    const text = esc(parts.text);
    if (!parts.code) return bullet + ' ' + text;
    return bullet + ' ' + strong(esc(parts.code)) + ' \u2014 ' + text;
  }).join('\n');
}

const asHtml = function (s) { return '<b>' + s + '</b>'; };
const asMrkdwn = function (s) { return '*' + s + '*'; };
const asPlain = function (s) { return s; };

const deficiencies = toArray(a.deficiencies).filter(function (d) {
  return d && typeof d === 'object';
});
const violations = toArray(a.violations);
const unverifiable = toArray(a.unverifiable_items);
const reinspect_reasons = toArray(a.reinspect_reasons);
const unknown_codes = toArray(a.unknown_codes);

// -------------------------------------------------------------- framing
let title;
let emoji;
let actionText;

if (status === 'ERROR') {
  title = 'AUDIT SYSTEM ERROR — NOT INSPECTED';
  emoji = '\u26a0\ufe0f';
  actionText = 'The automated pass failed. This site has NOT been assessed — resubmit the photograph or inspect manually.';
} else if (critical_count > 0) {
  title = 'CRITICAL FINDING — IMMEDIATE ACTION REQUIRED';
  emoji = '\ud83d\udd34';
  actionText = 'Attend the site now. A critical finding means the equipment cannot be relied on, or cannot be reached.';
} else if (status === 'NON-COMPLIANT') {
  title = 'AUDIT FAILED — REMEDIATION REQUIRED';
  emoji = '\ud83d\udfe0';
  actionText = 'Notify the site supervisor and raise a maintenance job against the asset.';
} else if (status === 'REINSPECT') {
  title = 'REINSPECT REQUIRED — EVIDENCE INADEQUATE';
  emoji = '\ud83d\udcf8';
  actionText = 'The photograph cannot settle the checklist. Retake it with better framing and lighting; do not record this as a pass.';
} else if (status === 'CONDITIONAL') {
  title = 'DEFICIENCIES NOTED — NOT A FAILURE';
  emoji = '\ud83d\udfe1';
  actionText = 'Minor items only. Schedule with routine maintenance; no immediate attendance needed.';
} else {
  // COMPLIANT should not reach here — IF_NonCompliant branches on
  // alert_required, which is false for it. Handled anyway so a future status
  // cannot produce a headline reading "undefined".
  title = 'AUDIT STATUS: ' + status;
  emoji = '\u26aa';
  actionText = 'Review required.';
}

/**
 * The severity line is the point of this rewrite. "NON-COMPLIANT" plus five
 * undifferentiated strings told an ops manager nothing about whether to get in a
 * van. Counts by tier, with the risk score, do.
 */
const severityLine = [
  critical_count ? critical_count + ' CRITICAL' : null,
  major_count ? major_count + ' MAJOR' : null,
  minor_count ? minor_count + ' MINOR' : null
].filter(Boolean).join(' \u00b7 ') || 'no deficiencies recorded';

// ----------------------------------------------------------- finding lists
/** Plain-text finding block, severity first so it is scannable. */
function plainFindings() {
  if (deficiencies.length === 0) {
    return violations.length
      ? violations.map(function (v, i) { return (i + 1) + '. ' + esc(v); }).join('\n')
      : 'None recorded';
  }
  return deficiencies.map(function (d, i) {
    const lines = [
      (i + 1) + '. [' + esc(d.severity || 'MAJOR') + '] ' + esc(d.finding || 'Unspecified finding.')
    ];
    if (d.code_reference) lines.push('     Code: ' + esc(d.code_reference));
    if (d.remediation) lines.push('     Fix:  ' + esc(d.remediation));
    return lines.join('\n');
  }).join('\n');
}

/**
 * Telegram findings.
 *
 * Deliberately NOT htmlFindings(): that renders `<li>` and `<div style="...">` for
 * the email body, and Telegram's HTML parse mode accepts only a small tag set
 * (b, i, u, s, code, pre, a, blockquote, tg-spoiler). An unsupported tag does not
 * degrade — Telegram rejects the entire message with a parse error, so the alert
 * would be lost completely. Reusing the email renderer here would have been worse
 * than the unformatted wall of text it replaced.
 *
 * Severity leads, in <code>, because it is what decides whether someone gets in a
 * van; the citation and the fix are indented continuation lines.
 */
function telegramFindings() {
  if (deficiencies.length === 0) {
    return violations.length
      ? bulletise(violations, '\u2022', asHtml)
      : '\u2022 None recorded';
  }
  return deficiencies.map(function (d) {
    const head = '\u2022 <code>' + esc(String(d.severity || 'MAJOR').toUpperCase()) + '</code> '
      + esc(d.finding || 'Unspecified finding.');
    const ref = d.code_reference ? '\n    <i>' + esc(d.code_reference) + '</i>' : '';
    const fix = d.remediation ? '\n    <b>Fix:</b> ' + esc(d.remediation) : '';
    return head + ref + fix;
  }).join('\n');
}

function slackFindings() {
  if (deficiencies.length === 0) {
    return violations.length
      ? violations.map(function (v) { return '\u2022 ' + esc(v); }).join('\n')
      : '\u2022 None recorded';
  }
  return deficiencies.map(function (d) {
    const head = '\u2022 `' + esc(d.severity || 'MAJOR') + '` ' + esc(d.finding || 'Unspecified finding.');
    const ref = d.code_reference ? '\n    _' + esc(d.code_reference) + '_' : '';
    const fix = d.remediation ? '\n    Fix: ' + esc(d.remediation) : '';
    return head + ref + fix;
  }).join('\n');
}

function htmlFindings() {
  if (deficiencies.length === 0) {
    const items = violations.length ? violations : ['None recorded'];
    return items.map(function (v) {
      return '<li style="padding:4px 0;">' + esc(v) + '</li>';
    }).join('');
  }
  const SEV_COLOR = { CRITICAL: '#b3261e', MAJOR: '#b26a00', MINOR: '#5f6368' };
  return deficiencies.map(function (d) {
    const sev = String(d.severity || 'MAJOR').toUpperCase();
    const color = SEV_COLOR[sev] || '#5f6368';
    return '<li style="padding:6px 0;">'
      + '<span style="display:inline-block;min-width:64px;font-size:11px;font-weight:700;'
      + 'letter-spacing:.06em;color:' + color + ';">' + esc(sev) + '</span> '
      + esc(d.finding || 'Unspecified finding.')
      + (d.code_reference ? '<div style="font-size:12px;color:#6b7280;padding-left:64px;">' + esc(d.code_reference) + '</div>' : '')
      + (d.remediation ? '<div style="font-size:12px;color:#374151;padding-left:64px;">Fix: ' + esc(d.remediation) + '</div>' : '')
      + '</li>';
  }).join('');
}

// ------------------------------------------------------------- caveat block
/**
 * Caveats are appended to every channel. The un-persisted warning matters most:
 * when the database write failed, this message IS the record, and the reader has
 * to be told that rather than discovering it later.
 */
const caveats = [];
if (!persisted) {
  caveats.push('NOT WRITTEN TO THE AUDIT DATABASE. This alert is the only copy of this finding \u2014 retain it.');
}
if (reinspect_reasons.length && status !== 'REINSPECT') {
  // On a REINSPECT these are promoted into the body instead — see below.
  caveats.push('Reinspection flagged: ' + reinspect_reasons.map(esc).join('; '));
}
if (unknown_codes.length) {
  caveats.push('Model returned checklist codes we do not recognise (' + unknown_codes.map(esc).join(', ')
    + '). The prompt and the parser may have drifted.');
}

/**
 * `unverifiable` is deliberately NOT a caveat any more.
 *
 * It was one, and it was flattened onto a single line with the other caveats. That
 * mattered least on a NON-COMPLIANT, where the deficiencies carry the message, and
 * most on a REINSPECT, where there are no deficiencies by definition and these
 * items are the entire content: they say what the photograph failed to show. A
 * REINSPECT alert whose only readable line was the generic "the automated pass
 * flagged this photograph as inadequate to judge" told an ops manager nothing
 * about what to re-shoot.
 *
 * It is now its own titled section with one item per line, on every channel.
 */
const UNVERIFIABLE_TITLE = 'Could not be verified from the photograph:';

/** True when this status has no deficiency list to carry the message. */
const bodyIsEvidenceGap = status === 'REINSPECT' && deficiencies.length === 0;

const RULE = '\u2501'.repeat(30);
const FOOTER = 'KRATU AI Labs \u00b7 AQUILA IND \u00b7 NBC 2016 Part 4, enforceable under MFPLSM Act 2006 / Rules 2009 \u00b7 AHJ: CFO, MCGM';
const ADVISORY = 'Advisory screening from a photograph. Not a Form B certificate and not a substitute for inspection by a Licensed Agency.';

// ----------------------------------------------------------------- plain text
/**
 * Kept for the `alert` output field, which is plain text by contract. Telegram no
 * longer uses it — it has its own HTML build below.
 */
const plainAlert = [
  emoji + ' ' + title,
  RULE,
  audit_id ? 'Audit       : ' + esc(audit_id) : null,
  'Site        : ' + esc(site_id),
  asset_tag ? 'Asset       : ' + esc(asset_tag) : null,
  'Equipment   : ' + esc(equipment),
  'Status      : ' + esc(status),
  'Severity    : ' + severityLine,
  risk_score !== null ? 'Risk score  : ' + risk_score + '/100' : null,
  'Confidence  : ' + esc(confidence) + '   Image: ' + esc(image_quality),
  'Time (IST)  : ' + esc(indiaTime),
  '',
  bodyIsEvidenceGap ? 'WHY REINSPECTION IS NEEDED:' : 'FINDINGS:',
  bodyIsEvidenceGap && reinspect_reasons.length
    ? bulletise(reinspect_reasons, '\u2022', asPlain)
    : plainFindings(),
  unverifiable.length ? '' : null,
  unverifiable.length ? UNVERIFIABLE_TITLE : null,
  unverifiable.length ? bulletise(unverifiable, '\u2022', asPlain) : null,
  caveats.length ? '' : null,
  caveats.length ? caveats.map(function (c) { return '! ' + c; }).join('\n') : null,
  RULE,
  'Action: ' + actionText,
  ADVISORY
].filter(function (line) { return line !== null; }).join('\n');

// ------------------------------------------------------------------- Telegram
/**
 * SEND_Telegram posts with parse_mode: HTML, and until now this message contained
 * no HTML at all — every value was escaped (correctly, so an "&" could not break
 * the send) but nothing was ever marked up. The result rendered as one
 * undifferentiated wall of text with no visual hierarchy, which is what made a
 * seven-item REINSPECT unreadable.
 *
 * Structured the same way as the US notifier (scripts/nodes/06_build_report.js):
 * bold labels, <code> for identifiers so they are tap-to-copy in Telegram, a blank
 * line between the header block and the body, and one bullet per line.
 *
 * The header stays label-per-line rather than combining fields, because this is
 * read on a phone in the field where a narrow column wraps anything longer.
 */
const telegramAlert = [
  emoji + ' <b>' + esc(title) + '</b>',
  '',
  audit_id ? '<b>Audit:</b> <code>' + esc(audit_id) + '</code>' : null,
  '<b>Site:</b> <code>' + esc(site_id) + '</code>',
  asset_tag ? '<b>Asset:</b> <code>' + esc(asset_tag) + '</code>' : null,
  '<b>Equipment:</b> ' + esc(equipment),
  '<b>Status:</b> <code>' + esc(status) + '</code>'
    + (critical_count > 0 ? ' \u26a0\ufe0f' : ''),
  '<b>Severity:</b> ' + severityLine
    + (risk_score !== null ? '   <b>Risk:</b> ' + risk_score + '/100' : ''),
  '<b>Confidence:</b> ' + esc(confidence) + ' | <b>Image:</b> ' + esc(image_quality),
  '<b>Time (IST):</b> ' + esc(indiaTime),
  '',
  '<b>' + (bodyIsEvidenceGap ? 'Why reinspection is needed' : 'Findings') + ':</b>',
  bodyIsEvidenceGap && reinspect_reasons.length
    ? bulletise(reinspect_reasons, '\u2022', asHtml)
    : telegramFindings(),
  unverifiable.length ? '' : null,
  unverifiable.length ? '<b>' + UNVERIFIABLE_TITLE + '</b>' : null,
  unverifiable.length ? bulletise(unverifiable, '\u2022', asHtml) : null,
  caveats.length ? '' : null,
  caveats.length
    ? caveats.map(function (c) { return '\u26a0\ufe0f ' + c; }).join('\n')
    : null,
  '',
  '<b>Action:</b> ' + esc(actionText),
  '<i>' + esc(ADVISORY) + '</i>'
].filter(function (line) { return line !== null; }).join('\n');

// ------------------------------------------------------------------- Slack
const slackAlert = [
  ':fire: *' + esc(title) + '*',
  RULE,
  audit_id ? '*Audit:* `' + esc(audit_id) + '`' : null,
  '*Site:* `' + esc(site_id) + '`' + (asset_tag ? '   *Asset:* `' + esc(asset_tag) + '`' : ''),
  '*Equipment:* ' + esc(equipment),
  '*Status:* `' + esc(status) + '`   *Severity:* ' + severityLine
    + (risk_score !== null ? '   *Risk:* ' + risk_score + '/100' : ''),
  '*Confidence:* ' + esc(confidence) + '   *Image:* ' + esc(image_quality),
  '*Time (IST):* ' + esc(indiaTime),
  '',
  '*' + (bodyIsEvidenceGap ? 'Why reinspection is needed:' : 'Findings:') + '*',
  bodyIsEvidenceGap && reinspect_reasons.length
    ? bulletise(reinspect_reasons, '\u2022', asMrkdwn)
    : slackFindings(),
  unverifiable.length ? '' : null,
  unverifiable.length ? '*' + UNVERIFIABLE_TITLE + '*' : null,
  unverifiable.length ? bulletise(unverifiable, '\u2022', asMrkdwn) : null,
  caveats.length ? '' : null,
  caveats.length ? caveats.map(function (c) { return ':warning: ' + c; }).join('\n') : null,
  RULE,
  '*Action:* ' + actionText,
  '_' + ADVISORY + '_'
].filter(function (line) { return line !== null; }).join('\n');

// ------------------------------------------------------------------- email
const bandColor = status === 'ERROR' ? '#5f6368'
  : critical_count > 0 ? '#b3261e'
  : status === 'NON-COMPLIANT' ? '#c2410c'
  : '#b26a00';

function row(label, value, last) {
  const border = last ? '' : 'border-bottom:1px solid #e5e7eb;';
  return '<tr>'
    + '<td style="padding:8px;' + border + 'font-weight:bold;width:38%;">' + esc(label) + '</td>'
    + '<td style="padding:8px;' + border + '">' + value + '</td>'
    + '</tr>';
}

const htmlAlert = [
  '<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;border:1px solid #ddd;border-radius:8px;overflow:hidden;">',
  '<div style="background:' + bandColor + ';color:#fff;padding:18px 20px;">',
  '<div style="font-size:11px;letter-spacing:.14em;opacity:.85;">KRATU AI LABS \u00b7 AQUILA IND</div>',
  '<h2 style="margin:6px 0 0;font-size:19px;">' + esc(title) + '</h2>',
  '</div>',
  '<div style="padding:16px 20px;background:#f9fafb;">',
  '<table style="width:100%;border-collapse:collapse;font-size:14px;">',
  row('Site', '<code>' + esc(site_id) + '</code>'),
  asset_tag ? row('Asset tag', '<code>' + esc(asset_tag) + '</code>') : '',
  row('Equipment', esc(equipment)),
  row('Status', '<strong style="color:' + bandColor + ';">' + esc(status) + '</strong>'),
  row('Severity', severityLine + (risk_score !== null ? ' &nbsp;(risk ' + risk_score + '/100)' : '')),
  row('Confidence', esc(confidence) + ' &nbsp;\u00b7&nbsp; image quality ' + esc(image_quality)),
  row('Time (IST)', esc(indiaTime), true),
  '</table>',
  '</div>',
  '<div style="padding:16px 20px;">',
  '<h3 style="color:#374151;margin:0 0 8px;font-size:14px;letter-spacing:.06em;">',
  bodyIsEvidenceGap ? 'WHY REINSPECTION IS NEEDED' : 'FINDINGS',
  '</h3>',
  '<ul style="color:#4b5563;margin:0;padding-left:20px;font-size:14px;">',
  bodyIsEvidenceGap && reinspect_reasons.length
    ? reinspect_reasons.map(function (r) { return '<li style="padding:4px 0;">' + esc(r) + '</li>'; }).join('')
    : htmlFindings(),
  '</ul>',
  // Same promotion as the other channels: on a REINSPECT this is the substance,
  // and one <li> per item is the whole point.
  unverifiable.length
    ? '<h3 style="color:#374151;margin:16px 0 8px;font-size:14px;letter-spacing:.06em;">'
        + esc(UNVERIFIABLE_TITLE.replace(/:$/, '').toUpperCase()) + '</h3>'
        + '<ul style="color:#4b5563;margin:0;padding-left:20px;font-size:14px;">'
        + unverifiable.map(function (item) {
            const parts = splitCoded(item);
            return '<li style="padding:4px 0;">'
              + (parts.code ? '<strong>' + esc(parts.code) + '</strong> \u2014 ' : '')
              + esc(parts.text) + '</li>';
          }).join('')
        + '</ul>'
    : '',
  '</div>',
  caveats.length
    ? '<div style="padding:12px 20px;background:#fef3c7;border-top:1px solid #fde68a;font-size:13px;color:#78350f;">'
        + caveats.map(function (c) { return '<div style="padding:2px 0;">\u26a0\ufe0f ' + c + '</div>'; }).join('')
        + '</div>'
    : '',
  '<div style="background:#eff6ff;padding:14px 20px;border-top:1px solid #ddd;font-size:14px;">',
  '<strong>Required action:</strong> ' + esc(actionText),
  '</div>',
  '<div style="background:#f3f4f6;padding:12px 20px;font-size:11px;color:#6b7280;line-height:1.5;">',
  esc(ADVISORY) + '<br>' + esc(FOOTER) + '<br>' + esc(indiaTime),
  '</div>',
  '</div>'
].join('');

// Subject leads with the severity, because that is what determines whether the
// mail gets opened now or after lunch.
const subjectLead = critical_count > 0 ? 'CRITICAL' : status;

return [{
  json: {
    // Was plainAlert, which carried no markup at all despite being posted with
    // parse_mode: HTML. telegramAlert is the same information with hierarchy.
    telegram_message: telegramAlert + '\n\n<i>' + esc(FOOTER) + '</i>',
    slack_message: slackAlert,
    email_html: htmlAlert,
    email_subject: emoji + ' AQUILA IND \u2014 ' + subjectLead + ': ' + site_id
      + (asset_tag ? ' / ' + asset_tag : ''),

    // Field names below are unchanged so the notifier nodes need no edits.
    alert: plainAlert,
    site_id: site_id,
    status: status,
    equipment_type: equipment,
    violations: violations,
    reinspect_reasons: reinspect_reasons,
    audit_timestamp: timestamp,

    // Carried through so a downstream node (a work-order webhook, say) does not
    // have to reach back into SHAPE_Response.
    asset_tag: asset_tag,
    critical: critical_count > 0,
    risk_score: risk_score,
    severity_counts: { critical: critical_count, major: major_count, minor: minor_count },
    deficiencies: deficiencies,
    persisted: persisted
  }
}];
