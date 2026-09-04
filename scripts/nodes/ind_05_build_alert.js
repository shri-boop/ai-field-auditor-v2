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
if (unverifiable.length) {
  caveats.push('Could not be verified from the photograph: ' + unverifiable.map(esc).join('; '));
}
if (reinspect_reasons.length && status !== 'REINSPECT') {
  caveats.push('Reinspection flagged: ' + reinspect_reasons.map(esc).join('; '));
}
if (unknown_codes.length) {
  caveats.push('Model returned checklist codes we do not recognise (' + unknown_codes.map(esc).join(', ')
    + '). The prompt and the parser may have drifted.');
}

const RULE = '\u2501'.repeat(30);
const FOOTER = 'KRATU AI Labs \u00b7 AQUILA IND \u00b7 NBC 2016 Part 4, enforceable under MFPLSM Act 2006 / Rules 2009 \u00b7 AHJ: CFO, MCGM';
const ADVISORY = 'Advisory screening from a photograph. Not a Form B certificate and not a substitute for inspection by a Licensed Agency.';

// ------------------------------------------------------------ plain (Telegram)
const plainAlert = [
  emoji + ' ' + title,
  RULE,
  'Site        : ' + esc(site_id),
  asset_tag ? 'Asset       : ' + esc(asset_tag) : null,
  'Equipment   : ' + esc(equipment),
  'Status      : ' + esc(status),
  'Severity    : ' + severityLine,
  risk_score !== null ? 'Risk score  : ' + risk_score + '/100' : null,
  'Confidence  : ' + esc(confidence) + '   Image: ' + esc(image_quality),
  'Time (IST)  : ' + esc(indiaTime),
  '',
  status === 'REINSPECT' ? 'WHY REINSPECTION IS NEEDED:' : 'FINDINGS:',
  status === 'REINSPECT' && reinspect_reasons.length
    ? reinspect_reasons.map(function (r, i) { return (i + 1) + '. ' + esc(r); }).join('\n')
    : plainFindings(),
  caveats.length ? '' : null,
  caveats.length ? caveats.map(function (c) { return '! ' + c; }).join('\n') : null,
  RULE,
  'Action: ' + actionText,
  ADVISORY
].filter(function (line) { return line !== null; }).join('\n');

// ------------------------------------------------------------------- Slack
const slackAlert = [
  ':fire: *' + esc(title) + '*',
  RULE,
  '*Site:* `' + esc(site_id) + '`' + (asset_tag ? '   *Asset:* `' + esc(asset_tag) + '`' : ''),
  '*Equipment:* ' + esc(equipment),
  '*Status:* `' + esc(status) + '`   *Severity:* ' + severityLine
    + (risk_score !== null ? '   *Risk:* ' + risk_score + '/100' : ''),
  '*Confidence:* ' + esc(confidence) + '   *Image:* ' + esc(image_quality),
  '*Time (IST):* ' + esc(indiaTime),
  '',
  '*' + (status === 'REINSPECT' ? 'WHY REINSPECTION IS NEEDED:' : 'FINDINGS:') + '*',
  status === 'REINSPECT' && reinspect_reasons.length
    ? reinspect_reasons.map(function (r) { return '\u2022 ' + esc(r); }).join('\n')
    : slackFindings(),
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
  status === 'REINSPECT' ? 'WHY REINSPECTION IS NEEDED' : 'FINDINGS',
  '</h3>',
  '<ul style="color:#4b5563;margin:0;padding-left:20px;font-size:14px;">',
  status === 'REINSPECT' && reinspect_reasons.length
    ? reinspect_reasons.map(function (r) { return '<li style="padding:4px 0;">' + esc(r) + '</li>'; }).join('')
    : htmlFindings(),
  '</ul>',
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
    telegram_message: plainAlert + '\n' + esc(FOOTER),
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
