/**
 * NODE 6 — BUILD_Report
 * Mode: Run Once for All Items
 *
 * Builds every outbound representation of the audit in one place: Slack mrkdwn,
 * Telegram HTML, an HTML email body, a plain-text alert, and — where a protection
 * system appears to be out of service — a formal impairment notice.
 *
 * Reads the audit from PARSE_And_Score by name rather than from the immediate
 * input, because the preceding Postgres node replaces the item payload with its
 * own result. Persistence success is inferred from that Postgres output.
 *
 * Two bugs carried by the v2 (India) builder are fixed here:
 *   - Telegram is sent with parse_mode HTML, so any &, < or > in model-generated
 *     text (dimensions such as <1/8 in are common) must be entity-escaped or the
 *     Telegram API rejects the message.
 *   - Timestamps are rendered in the site's own US timezone rather than a single
 *     hardcoded zone.
 */

const a = $('PARSE_And_Score').first().json;
const dbResult = $input.first().json || {};

// The Postgres node runs with onError=continueRegularOutput, so a database
// outage degrades to "not persisted" instead of losing the audit entirely.
const persisted = !(dbResult.error || dbResult.$error);

const cb = a.code_basis || {};
const tz = cb.timezone || 'America/New_York';

// NOTE: do NOT use dateStyle/timeStyle here. Intl forbids combining those
// shorthands with component options such as timeZoneName, and throws
// "Invalid option" — which silently degraded every notification timestamp to a
// raw UTC ISO string. Explicit components are required to render the zone
// abbreviation (PDT / EDT / MST ...), which US field crews rely on.
function localTime(iso) {
  if (!iso) return 'n/a';
  try {
    return new Date(iso).toLocaleString('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short'
    });
  } catch (e) {
    // Unknown zone or a runtime without full ICU: degrade to UTC ISO rather
    // than losing the timestamp entirely.
    return iso + ' (UTC)';
  }
}

// Telegram HTML parse mode: escape the three reserved entities.
function esc(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const localTs = localTime(a.audit_timestamp);
const localDue = a.remediation_due_at ? localTime(a.remediation_due_at) : null;

const PRESENTATION = {
  'NON-COMPLIANT': { emoji: '\uD83D\uDD34', color: '#dc2626', headline: 'AUDIT FAILED' },
  CONDITIONAL:     { emoji: '\uD83D\uDFE1', color: '#f59e0b', headline: 'DEFICIENCIES NOTED' },
  REINSPECT:       { emoji: '\uD83D\uDCF8', color: '#3b82f6', headline: 'RE-INSPECTION REQUIRED' },
  COMPLIANT:       { emoji: '\uD83D\uDFE2', color: '#059669', headline: 'NO DEFICIENCIES VISIBLE' },
  ERROR:           { emoji: '\u26A0\uFE0F', color: '#6b7280', headline: 'AUDIT SYSTEM ERROR' }
};

const p = PRESENTATION[a.status] || PRESENTATION.ERROR;
const headline = a.critical ? 'CRITICAL — IMMEDIATE ACTION REQUIRED' : p.headline;

// Some jurisdictions carry a full sentence as their "edition" (Texas is a good
// example, because municipal adoption varies), so only inline the edition when
// it is short enough to read as a single label.
const editionShort = String(cb.fire_code_edition || '');
const codeLine = cb.fire_code
  ? cb.fire_code + (editionShort && editionShort.length <= 24 ? ' ' + editionShort : '')
  : 'code basis unresolved';

const actionText = a.critical
  ? 'Dispatch immediately. Isolate or protect the affected area, consider a fire watch, and notify the ' + (cb.ahj_label || 'AHJ') + ' where a protection system is impaired.'
  : a.status === 'NON-COMPLIANT'
    ? 'Assign corrective work. Target completion within ' + a.sla_hours + ' hours (' + (localDue || 'n/a') + ').'
    : a.status === 'CONDITIONAL'
      ? 'Log administrative corrections; complete within 30 days (' + (localDue || 'n/a') + ').'
      : a.status === 'REINSPECT'
        ? 'Return a better photograph before this asset can be screened.'
        : 'No action required from this screen. A physical inspection is still required for certification.';

// ---------------------------------------------------------------- line items
const defLines = (a.deficiencies || []).map(function (d, i) {
  return (i + 1) + '. [' + d.severity + '] ' + d.finding +
         '\n     Observed : ' + d.observed +
         '\n     Required : ' + d.requirement +
         '\n     Authority: ' + d.code_reference +
         '\n     Fix      : ' + d.remediation;
});

const bodyItems = a.status === 'REINSPECT' && (a.deficiencies || []).length === 0
  ? (a.reinspect_reasons || [])
  : (defLines.length ? defLines : ['None recorded.']);

const itemBlockPlain = bodyItems.length ? bodyItems.join('\n') : 'None recorded.';

const unverifiableBlock = (a.unverifiable_items || []).length
  ? (a.unverifiable_items || []).map(function (u, i) { return '  ' + (i + 1) + '. ' + u; }).join('\n')
  : '  None flagged.';

// --------------------------------------------------------- impairment notice
// NFPA 25 Chapter 15 (and the equivalent NFPA 1 / IFC provisions) require a
// formal impairment procedure when a water-based protection system is out of
// service. This produces the paperwork trigger rather than burying it in prose.
let impairment_notice = null;
if (a.impairment_suspected || a.critical) {
  impairment_notice = [
    'SUSPECTED FIRE PROTECTION SYSTEM IMPAIRMENT — ACTION CHECKLIST',
    '',
    'Audit ID     : ' + a.audit_id,
    'Site         : ' + a.site_id,
    'Asset        : ' + a.equipment_type + (a.equipment_subtype ? ' / ' + a.equipment_subtype : ''),
    'Detected     : ' + localTs,
    'Basis        : ' + (a.impairment_basis || 'One or more CRITICAL deficiencies were identified.'),
    'Jurisdiction : ' + (cb.jurisdiction_label || 'unknown') + ' — ' + codeLine,
    '',
    'Required steps for the impairment coordinator:',
    '  1. Verify the condition on site. Do not act on the photograph alone.',
    '  2. If a system is confirmed out of service, assign an impairment tag at the',
    '     main control valve or panel.',
    '  3. Evaluate the need for a fire watch or other approved interim measures for',
    '     the duration of the impairment.',
    '  4. Notify the ' + (cb.ahj_label || 'Authority Having Jurisdiction') + ', the property',
    '     insurer, the building owner and affected occupants.',
    '  5. Record the start time, cause, interim measures and restoration time.',
    '  6. Confirm the system is returned to service and remove the tag.',
    '',
    'Reference: NFPA 25 Chapter 15 (impairments), plus the impairment provisions of',
    '           ' + codeLine + '.',
    '',
    'This notice was generated from an AI photo screen and is advisory. It does not',
    'itself constitute a code-required impairment record.'
  ].join('\n');
}

// ------------------------------------------------------------- plain / email
const plainAlert = [
  p.emoji + ' ' + headline,
  '\u2501'.repeat(52),
  'Audit ID    : ' + a.audit_id,
  'Site ID     : ' + a.site_id + (a.asset_tag ? '  (asset ' + a.asset_tag + ')' : ''),
  'Jurisdiction: ' + (cb.jurisdiction_label || 'unknown'),
  'Code basis  : ' + (cb.fire_code || 'unresolved'),
  'Edition     : ' + (cb.fire_code_edition || 'unresolved'),
  'AHJ         : ' + (cb.ahj_label || 'unknown'),
  'Equipment   : ' + a.equipment_type + (a.equipment_subtype ? ' / ' + a.equipment_subtype : ''),
  'Status      : ' + a.status + (a.critical ? '  [CRITICAL]' : ''),
  'Risk score  : ' + a.risk_score + '/100   (C:' + a.critical_count + ' M:' + a.major_count + ' m:' + a.minor_count + ')',
  'Confidence  : ' + a.confidence + '   Image quality: ' + a.image_quality,
  'Inspector   : ' + a.inspector_id,
  'Timestamp   : ' + localTs,
  localDue ? 'Correct by  : ' + localDue : null,
  '',
  'OBSERVATIONS:',
  '  ' + (a.observations || 'None recorded.'),
  '',
  (a.status === 'REINSPECT' && defLines.length === 0 ? 'RE-INSPECTION REASONS:' : 'FINDINGS:'),
  itemBlockPlain,
  '',
  'NOT VERIFIABLE FROM A PHOTOGRAPH:',
  unverifiableBlock,
  '',
  '\u2501'.repeat(52),
  'ACTION: ' + actionText,
  '',
  'SCOPE: ' + a.scope_note,
  cb.requires_ahj_confirmation
    ? 'NOTE: Code edition and local amendments must be confirmed with the AHJ.'
    : null,
  !cb.code_basis_confident
    ? 'NOTE: No exact jurisdiction match; the model-code baseline was applied.'
    : null,
  a.confidence_gated
    ? 'NOTE: Escalated on a CRITICAL finding despite weak photographic evidence (fail-safe).'
    : null,
  !persisted
    ? 'NOTE: This audit could not be written to the audit database. Retain this alert.'
    : null,
  'FIREHAWK US \u2014 advisory AI screen, pending licensed inspector sign-off.'
].filter(function (l) { return l !== null; }).join('\n');

// ------------------------------------------------------------------- slack
const slackItems = bodyItems.map(function (t) { return '\u2022 ' + t; }).join('\n');

const slackMessage = [
  ':fire: *' + headline + '*',
  '*Audit:* `' + a.audit_id + '`',
  '*Site:* `' + a.site_id + '`   *Equipment:* ' + a.equipment_type,
  '*Jurisdiction:* ' + (cb.jurisdiction_label || 'unknown') + '   *Code:* ' + codeLine,
  '*Status:* `' + a.status + '`' + (a.critical ? '  :rotating_light: *CRITICAL*' : ''),
  '*Risk:* ' + a.risk_score + '/100  (C:' + a.critical_count + ' M:' + a.major_count + ' m:' + a.minor_count + ')',
  '*Confidence:* ' + a.confidence + '   *Image:* ' + a.image_quality,
  '*When:* ' + localTs + (localDue ? '   *Correct by:* ' + localDue : ''),
  '',
  '*Observations:* ' + (a.observations || 'None recorded.'),
  '',
  '*' + (a.status === 'REINSPECT' && defLines.length === 0 ? 'Re-inspection reasons' : 'Findings') + ':*',
  slackItems,
  '',
  '*Action:* ' + actionText,
  '_' + a.scope_note + '_'
].join('\n');

// ---------------------------------------------------------------- telegram
const telegramMessage = [
  p.emoji + ' <b>' + esc(headline) + '</b>',
  '',
  '<b>Audit:</b> <code>' + esc(a.audit_id) + '</code>',
  '<b>Site:</b> <code>' + esc(a.site_id) + '</code>',
  '<b>Equipment:</b> ' + esc(a.equipment_type),
  '<b>Jurisdiction:</b> ' + esc(cb.jurisdiction_label || 'unknown'),
  '<b>Code basis:</b> ' + esc(codeLine),
  '<b>Status:</b> <code>' + esc(a.status) + '</code>' + (a.critical ? ' \u26A0\uFE0F' : ''),
  '<b>Risk:</b> ' + a.risk_score + '/100 (C:' + a.critical_count + ' M:' + a.major_count + ' m:' + a.minor_count + ')',
  '<b>Confidence:</b> ' + esc(a.confidence) + ' | <b>Image:</b> ' + esc(a.image_quality),
  '<b>When:</b> ' + esc(localTs),
  localDue ? '<b>Correct by:</b> ' + esc(localDue) : null,
  '',
  '<b>' + (a.status === 'REINSPECT' && defLines.length === 0 ? 'Re-inspection reasons' : 'Findings') + ':</b>',
  bodyItems.map(function (t) { return '\u2022 ' + esc(t); }).join('\n'),
  '',
  '<b>Action:</b> ' + esc(actionText),
  '<i>' + esc(a.scope_note) + '</i>'
].filter(function (l) { return l !== null; }).join('\n');

// -------------------------------------------------------------------- email
function row(label, value) {
  return '<tr><td style="padding:8px;border-bottom:1px solid #e5e7eb;font-weight:bold;width:38%">' +
         esc(label) + '</td><td style="padding:8px;border-bottom:1px solid #e5e7eb">' + esc(value) + '</td></tr>';
}

const SEV_COLOR = { CRITICAL: '#dc2626', MAJOR: '#f59e0b', MINOR: '#6b7280' };

const defHtml = (a.deficiencies || []).length
  ? (a.deficiencies || []).map(function (d) {
      return '<div style="border-left:4px solid ' + (SEV_COLOR[d.severity] || '#6b7280') +
        ';padding:10px 14px;margin:10px 0;background:#fff">' +
        '<div style="font-weight:bold;color:' + (SEV_COLOR[d.severity] || '#6b7280') + '">' +
        esc(d.severity) + ' \u2014 ' + esc(d.finding) + '</div>' +
        '<div style="font-size:13px;color:#4b5563;margin-top:6px"><b>Observed:</b> ' + esc(d.observed) + '</div>' +
        '<div style="font-size:13px;color:#4b5563"><b>Required:</b> ' + esc(d.requirement) + '</div>' +
        '<div style="font-size:13px;color:#4b5563"><b>Authority:</b> ' + esc(d.code_reference) + '</div>' +
        '<div style="font-size:13px;color:#4b5563"><b>Remediation:</b> ' + esc(d.remediation) + '</div>' +
        '</div>';
    }).join('')
  : '<p style="color:#4b5563">' +
    (a.status === 'REINSPECT'
      ? (a.reinspect_reasons || []).map(function (r) { return esc(r); }).join('<br>')
      : 'No deficiencies recorded.') +
    '</p>';

const emailHtml = [
  '<div style="font-family:Arial,Helvetica,sans-serif;max-width:720px;margin:0 auto;border:1px solid #ddd;border-radius:8px;overflow:hidden">',
  '<div style="background:' + p.color + ';color:#fff;padding:20px;text-align:center">',
  '<h2 style="margin:0">' + p.emoji + ' ' + esc(headline) + '</h2>',
  '<div style="font-size:13px;opacity:.9;margin-top:6px">' + esc(codeLine) + '</div>',
  '</div>',
  '<div style="padding:20px;background:#f9fafb"><table style="width:100%;border-collapse:collapse">',
  row('Audit ID', a.audit_id),
  row('Site ID', a.site_id + (a.asset_tag ? '  (asset ' + a.asset_tag + ')' : '')),
  row('Jurisdiction', cb.jurisdiction_label || 'unknown'),
  row('AHJ', cb.ahj_label || 'unknown'),
  row('Occupancy', a.occupancy_type),
  row('Equipment', a.equipment_type + (a.equipment_subtype ? ' / ' + a.equipment_subtype : '')),
  row('Status', a.status + (a.critical ? '  [CRITICAL]' : '')),
  row('Risk score', a.risk_score + '/100  (critical ' + a.critical_count + ', major ' + a.major_count + ', minor ' + a.minor_count + ')'),
  row('Confidence', a.confidence + '   |   Image quality: ' + a.image_quality),
  row('Inspector', a.inspector_id),
  row('Timestamp', localTs),
  localDue ? row('Correct by', localDue) : '',
  row('Model', a.model_used),
  '</table></div>',
  '<div style="padding:0 20px"><h3 style="color:#374151">Observations</h3>',
  '<p style="color:#4b5563;line-height:1.6">' + esc(a.observations || 'None recorded.') + '</p></div>',
  '<div style="padding:0 20px 10px"><h3 style="color:#374151">Findings</h3>' + defHtml + '</div>',
  '<div style="padding:0 20px 10px"><h3 style="color:#374151">Not verifiable from a photograph</h3><ul style="color:#4b5563">',
  ((a.unverifiable_items || []).length
    ? (a.unverifiable_items || []).map(function (u) { return '<li>' + esc(u) + '</li>'; }).join('')
    : '<li>None flagged.</li>'),
  '</ul></div>',
  '<div style="background:#eff6ff;padding:15px 20px;border-top:1px solid #ddd"><b>Required action:</b> ' + esc(actionText) + '</div>',
  '<div style="background:#fffbeb;padding:15px 20px;border-top:1px solid #fde68a;font-size:12px;color:#92400e">',
  '<b>Scope and limitations:</b> ' + esc(a.scope_note),
  cb.requires_ahj_confirmation ? '<br>Code edition and local amendments must be confirmed with the AHJ before enforcement use.' : '',
  !cb.code_basis_confident ? '<br>No exact jurisdiction match was found; the model-code baseline was applied.' : '',
  (a.unverified_standard_editions || []).length ? '<br>Confirm the editions in force for: ' + esc((a.unverified_standard_editions || []).join(', ')) + '.' : '',
  !persisted ? '<br><b>This audit was not written to the audit database.</b> Retain this email as the record.' : '',
  '</div>',
  '<div style="background:#f3f4f6;padding:10px 20px;font-size:12px;color:#6b7280;text-align:center">',
  'FIREHAWK US \u2014 AI pre-inspection screen \u2014 pending licensed inspector sign-off \u2014 ' + esc(localTs),
  '</div></div>'
].join('');

const subjectPrefix = a.critical ? '[CRITICAL] ' : '';

return [{
  json: Object.assign({}, a, {
    persisted: persisted,
    local_timestamp: localTs,
    local_remediation_due: localDue,
    headline: headline,
    action_text: actionText,
    impairment_notice: impairment_notice,
    alert: plainAlert,
    slack_message: slackMessage,
    telegram_message: telegramMessage,
    email_html: emailHtml,
    email_subject: subjectPrefix + p.emoji + ' Fire Audit ' + a.status + ' \u2014 ' + a.site_id + ' \u2014 ' + a.equipment_type
  })
}];
