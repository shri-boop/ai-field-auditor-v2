#!/usr/bin/env python3
"""
Surgical edit of AI_Field_Audit_v2.json (the India workflow) to record
asset_tag, inspector_id and image_url.

That file is hand-maintained rather than generated, so this script exists to make
the change reviewable and repeatable instead of a hand-edit inside a 500-line
JSON blob. It is idempotent: re-running detects the fields are already threaded
and makes no change.

Chain:  Webhook -> PARSE_Input -> BUILD_Vision_Payload -> Claude_Vision_API
        -> PARSE_Response -> LOG_Audit

BUILD_Vision_Payload is deliberately NOT touched. PARSE_Response reads the new
fields straight from $('PARSE_Input'), which n8n resolves by node name regardless
of position in the chain — so the payload builder keeps its narrow contract and
the diff stays confined to the two nodes that actually need the data.
"""

import json
import sys

PATH = "AI_Field_Audit_v2.json"

PARSE_INPUT = """const body = $input.first().json.body || {};

const image_url = body.image_url || null;
const site_id = body.site_id || 'unknown';

if (!image_url || image_url.trim().length === 0) {
  throw new Error('Missing required field: image_url not found in request body.');
}

// asset_tag identifies WHICH device at the site. A site holds many devices and is
// audited repeatedly, so without it two audits of one address are
// indistinguishable. inspector_id records who captured the evidence; it is what
// prints as "Captured by" on the report, and it is deliberately NOT the sign-off
// name — that requires a qualified reviewer, not whoever ran the scan.
function clean(value, fallback, maxLength) {
  const out = String(value === undefined || value === null ? '' : value).trim();
  return (out || fallback).slice(0, maxLength || 64);
}

return [{
  json: {
    image_url: image_url.trim(),
    site_id: site_id,
    asset_tag: clean(body.asset_tag, '', 64) || null,
    inspector_id: clean(body.inspector_id, 'UNASSIGNED', 64)
  }
}];"""

PARSE_RESPONSE = """const raw = $input.first().json.choices?.[0]?.message?.content || '';

let cleaned = raw
  .replace(/```json\\s*/gi, '')
  .replace(/```\\s*/g, '')
  .trim();

let parsed;
try {
  parsed = JSON.parse(cleaned);
} catch (e) {
  parsed = {
    equipment_type: 'Unknown',
    status: 'ERROR',
    confidence: 'LOW',
    observations: 'Failed to parse AI response: ' + e.message,
    violations: ['AI_PARSE_ERROR']
  };
}

const site_id = $('BUILD_Vision_Payload').first().json.site_id || 'unknown';

// Read straight from PARSE_Input rather than threading these through
// BUILD_Vision_Payload: n8n resolves a node reference by name wherever it sits in
// the chain, so the payload builder keeps its narrow contract.
//
// image_url is persisted so a retrieved record can show its evidence. Without it
// an archived India audit has no photograph at all, and a fire-safety record
// whose evidence cannot be reproduced is barely a record.
const source = $('PARSE_Input').first().json;

return [{
  json: {
    ...parsed,
    site_id: site_id,
    asset_tag: source.asset_tag || null,
    inspector_id: source.inspector_id || 'UNASSIGNED',
    image_url: source.image_url || null,
    audit_timestamp: new Date().toISOString()
  }
}];"""

NEW_COLUMNS = {
    "asset_tag": "={{ $json.asset_tag }}",
    "inspector_id": "={{ $json.inspector_id }}",
    "image_url": "={{ $json.image_url }}",
}

# Alert recipient for the Gmail node, matching ALERT_RECIPIENT in
# build_us_workflow.py.
#
# Was a hardcoded personal Gmail address. The node ships disabled, so nothing was
# ever sent there — but the moment anyone enabled it, a customer's fire-safety
# findings would have gone to an individual's personal mailbox.
#
# Resolved from the n8n environment at run time with a role-address fallback, so
# the failure mode is "goes to a company inbox", never "goes to a person".
# Deliberately NOT from the request body: the audit webhook is unauthenticated, so
# a caller-supplied recipient would make it an open email relay on our Gmail
# credential.
ALERT_RECIPIENT = "={{ $env.AUDIT_ALERT_EMAIL_TO || 'alerts@kratuailabs.com' }}"
GMAIL_NODE = "Send a message"


def schema_entry(name):
    return {
        "id": name,
        "displayName": name,
        "required": False,
        "defaultMatch": False,
        "display": True,
        "type": "string",
        "canBeUsedToMatch": True,
    }


def main():
    with open(PATH, "r", encoding="utf-8") as fh:
        original = fh.read()
    wf = json.loads(original)

    by_name = {n["name"]: n for n in wf["nodes"]}
    for required in ("PARSE_Input", "PARSE_Response", "LOG_Audit"):
        if required not in by_name:
            print("FAIL: node not found: " + required)
            return 1

    by_name["PARSE_Input"]["parameters"]["jsCode"] = PARSE_INPUT
    by_name["PARSE_Response"]["parameters"]["jsCode"] = PARSE_RESPONSE

    columns = by_name["LOG_Audit"]["parameters"]["columns"]
    values = columns["value"]
    schema = columns["schema"]
    existing = {entry["id"] for entry in schema}

    for name, expression in NEW_COLUMNS.items():
        values[name] = expression
        if name not in existing:
            schema.append(schema_entry(name))

    if GMAIL_NODE in by_name:
        by_name[GMAIL_NODE]["parameters"]["sendTo"] = ALERT_RECIPIENT

    # Guard the table name: this workflow writes the India log, and pointing it at
    # the US table would corrupt a differently-shaped table.
    table = by_name["LOG_Audit"]["parameters"]["table"]["value"]
    if table != "field_audit_logs":
        print("FAIL: LOG_Audit targets unexpected table: " + str(table))
        return 1

    rendered = json.dumps(wf, indent=2, ensure_ascii=False) + "\n"
    if rendered == original:
        print("No change needed - already threaded.")
        return 0

    with open(PATH, "w", encoding="utf-8") as fh:
        fh.write(rendered)

    print("Patched " + PATH)
    print("  LOG_Audit columns: " + ", ".join(sorted(values.keys())))
    print("  schema entries:    " + str(len(schema)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
