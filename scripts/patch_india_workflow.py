#!/usr/bin/env python3
"""
Surgical, idempotent edit of AI_Field_Audit_v2.json — the India workflow.

That file is hand-maintained rather than generated (unlike the US workflow, which
build_us_workflow.py produces whole), because it carries live credential
references and an `active: true` flag that a from-scratch rebuild would be liable
to lose. So this script edits it in place and asserts the things that must not
change.

The JavaScript lives in scripts/nodes/ind_*.js rather than in string literals
here, so it is reviewable as JavaScript, diffable line by line, and loadable by
the offline test harness (scripts/test_india.mjs). The US workflow does the same.

CHAIN AFTER PATCHING
--------------------
    Webhook
      -> PARSE_Input            ind_01_parse_input.js
      -> BUILD_Vision_Payload   ind_02_build_payload.js    severity-tagged checklist
      -> Claude_Vision_API
      -> PARSE_Response         ind_03_derive_verdict.js   DERIVES status in code
      -> LOG_Audit              onError: continueRegularOutput
      -> SHAPE_Response         ind_04_shape_response.js   NEW NODE, sets persisted
      -> IF_NonCompliant        branches on the boolean alert_required
           |- true  -> NOTIFY_OpsManager  ind_05_build_alert.js  -> Slack + Telegram
           |          + Respond_to_Webhook1
           `- false -> Respond_to_Webhook1

WHAT CHANGED AND WHY (roadmap 7.1 / 7.2 / 7.3 in docs/IND_FIRE_AUDIT_WORKFLOW.md)
--------------------------------------------------------------------------------
7.1  The model is no longer asked for a status, and PARSE_Response no longer
     copies one. A model revision emitting "PASS" instead of "COMPLIANT" used to
     route every audit — including a discharged extinguisher — down the compliant
     branch with no alert, silently. The verdict is now arithmetic on severities.

7.2  CRITICAL / MAJOR / MINOR with clause citations, counts and a 0-100 risk
     score, same weights as the US workflow.

7.3  LOG_Audit gains onError: continueRegularOutput. A Postgres outage used to
     abort the execution, so the alert never fired and the caller got an empty
     body: a blocked fire exit unreported because a database blinked. The audit
     now continues and reports persisted: false, which the dashboard already
     renders and the alert body states outright.

RUN
---
    python3 scripts/patch_india_workflow.py            # idempotent
    python3 scripts/patch_india_workflow.py --check    # verify, write nothing
"""

import json
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PATH = os.path.join(REPO, "AI_Field_Audit_v2.json")
NODES = os.path.join(REPO, "scripts", "nodes")

TABLE = "field_audit_logs"

# name -> source file. PARSE_Response keeps its name although its job changed
# from transcribing the model's verdict to deriving one: renaming it would break
# every $('PARSE_Response') reference and the node's own execution history.
JS_NODES = {
    "PARSE_Input": "ind_01_parse_input.js",
    "BUILD_Vision_Payload": "ind_02_build_payload.js",
    "PARSE_Response": "ind_03_derive_verdict.js",
    "NOTIFY_OpsManager": "ind_05_build_alert.js",
}

SHAPE_NODE_NAME = "SHAPE_Response"
SHAPE_NODE_FILE = "ind_04_shape_response.js"
SHAPE_NODE_ID = "ind-shape-response-0001"

# LOG_Audit column mappings. Existing entries are preserved; these are set or
# overwritten.
#
# jsonb columns are written as JSON text. n8n sends the parameter untyped and
# Postgres coerces a valid JSON literal into jsonb, which is exactly how the
# existing `violations` mapping already works.
#
# `violations` stays stringified JSON in a text column on purpose — see the note
# in scripts/db/004_field_audit_logs_severity.sql. `deficiencies` is the
# structured record; `violations` is the flat human-readable line kept for
# continuity with every row written before this change.
COLUMNS = {
    "equipment_type": ("={{ $json.equipment_type }}", "string"),
    "status": ("={{ $json.status }}", "string"),
    "confidence": ("={{ $json.confidence }}", "string"),
    "observations": ("={{ $json.observations }}", "string"),
    "violations": ("={{ JSON.stringify($json.violations) }}", "string"),
    "site_id": ("={{ $json.site_id }}", "string"),
    "audit_timestamp": ("={{ $json.audit_timestamp }}", "string"),
    # migration 003
    "asset_tag": ("={{ $json.asset_tag }}", "string"),
    "inspector_id": ("={{ $json.inspector_id }}", "string"),
    "image_url": ("={{ $json.image_url }}", "string"),
    # migration 004 — the severity model
    "deficiencies": ("={{ JSON.stringify($json.deficiencies) }}", "string"),
    "unverifiable_items": ("={{ JSON.stringify($json.unverifiable_items) }}", "string"),
    "reinspect_reasons": ("={{ JSON.stringify($json.reinspect_reasons) }}", "string"),
    "critical": ("={{ $json.critical }}", "boolean"),
    "critical_count": ("={{ $json.critical_count }}", "number"),
    "major_count": ("={{ $json.major_count }}", "number"),
    "minor_count": ("={{ $json.minor_count }}", "number"),
    "deficiency_count": ("={{ $json.deficiency_count }}", "number"),
    "risk_score": ("={{ $json.risk_score }}", "number"),
    "image_quality": ("={{ $json.image_quality }}", "string"),
    "reinspect_required": ("={{ $json.reinspect_required }}", "boolean"),
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


def js(filename):
    with open(os.path.join(NODES, filename), "r", encoding="utf-8") as fh:
        return fh.read()


def schema_entry(name, col_type):
    return {
        "id": name,
        "displayName": name,
        "required": False,
        "defaultMatch": False,
        "display": True,
        "type": col_type,
        "canBeUsedToMatch": True,
    }


def patch_log_audit(node):
    """onError tolerance + the full column mapping."""
    # A database outage must not swallow a life-safety finding. SHAPE_Response
    # inspects this node's output and sets persisted accordingly.
    node["onError"] = "continueRegularOutput"
    # Without this, a continued error can yield no item at all and SHAPE_Response
    # never runs — which would reproduce the very failure being fixed.
    node["alwaysOutputData"] = True
    # A transient connection blip is far more likely than a real outage, so retry
    # before degrading to persisted: false. Matches the US LOG_Audit.
    node["retryOnFail"] = True
    node["maxTries"] = 3
    node["waitBetweenTries"] = 1000

    columns = node["parameters"]["columns"]
    values = columns["value"]
    schema = columns["schema"]
    by_id = {entry["id"]: entry for entry in schema}

    for name, (expression, col_type) in COLUMNS.items():
        values[name] = expression
        if name in by_id:
            by_id[name]["type"] = col_type
        else:
            schema.append(schema_entry(name, col_type))


def patch_webhook_auth(node):
    """
    Require Header Auth on the audit webhook.

    Every audit is a paid vision call, so an unauthenticated webhook is a metered
    spend endpoint that anyone who learns the URL can drain. audit-history has used
    Header Auth from the start; this brings the audit endpoints to the same footing.

    No credentials block is written, and that is intentional: the credential ID is
    generated by n8n and cannot be committed here. Bind an httpHeaderAuth credential
    with header `x-audit-api-key` in the n8n UI.

    ⚠️ Until that credential is bound, this webhook rejects every request. Which is
    the correct default for this endpoint, but it means the ORDER of deployment
    matters — app/api/audit/route.ts must be sending the header first. See
    docs/IND_FIRE_AUDIT_WORKFLOW.md §7.11.
    """
    node["parameters"]["authentication"] = "headerAuth"


def patch_if_node(node):
    """Branch on the derived boolean, not on a status string."""
    node["parameters"]["conditions"]["conditions"] = [
        {
            "id": "audit-if-alert-required",
            "leftValue": "={{ $json.alert_required }}",
            "rightValue": "",
            "operator": {"type": "boolean", "operation": "true", "singleValue": True},
        }
    ]


def ensure_shape_node(wf, by_name):
    """Insert SHAPE_Response between LOG_Audit and IF_NonCompliant."""
    source = js(SHAPE_NODE_FILE)

    if SHAPE_NODE_NAME in by_name:
        by_name[SHAPE_NODE_NAME]["parameters"]["jsCode"] = source
    else:
        log_pos = by_name["LOG_Audit"]["position"]
        wf["nodes"].append({
            "parameters": {"jsCode": source},
            "id": SHAPE_NODE_ID,
            "name": SHAPE_NODE_NAME,
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            # Between LOG_Audit and IF_NonCompliant, offset vertically so it does
            # not land on top of the existing IF node on the canvas.
            "position": [log_pos[0] + 120, log_pos[1] + 176],
        })

    # Rewire: LOG_Audit -> SHAPE_Response -> IF_NonCompliant. IF_NonCompliant's
    # own outgoing connections are untouched.
    wf["connections"]["LOG_Audit"] = {
        "main": [[{"node": SHAPE_NODE_NAME, "type": "main", "index": 0}]]
    }
    wf["connections"][SHAPE_NODE_NAME] = {
        "main": [[{"node": "IF_NonCompliant", "type": "main", "index": 0}]]
    }


def main():
    check_only = "--check" in sys.argv

    with open(PATH, "r", encoding="utf-8") as fh:
        original = fh.read()
    wf = json.loads(original)

    by_name = {n["name"]: n for n in wf["nodes"]}

    required = list(JS_NODES) + ["LOG_Audit", "IF_NonCompliant", "Respond_to_Webhook1"]
    missing = [name for name in required if name not in by_name]
    if missing:
        print("FAIL: node(s) not found: " + ", ".join(missing))
        return 1

    # Guard the table name before writing anything: this workflow writes the India
    # log, and pointing it at the US table would corrupt a differently-shaped one.
    table = by_name["LOG_Audit"]["parameters"]["table"]["value"]
    if table != TABLE:
        print("FAIL: LOG_Audit targets unexpected table: " + str(table))
        return 1

    # The webhook path is what the dashboard calls (lib/regions.ts). Changing it
    # silently breaks production, so assert rather than trust.
    path = by_name["Webhook"]["parameters"]["path"]
    if path != "audit-field-photov2":
        print("FAIL: Webhook path changed: " + str(path))
        return 1

    patch_webhook_auth(by_name["Webhook"])

    for node_name, filename in JS_NODES.items():
        by_name[node_name]["parameters"]["jsCode"] = js(filename)

    patch_log_audit(by_name["LOG_Audit"])
    patch_if_node(by_name["IF_NonCompliant"])
    ensure_shape_node(wf, by_name)

    if GMAIL_NODE in by_name:
        by_name[GMAIL_NODE]["parameters"]["sendTo"] = ALERT_RECIPIENT

    rendered = json.dumps(wf, indent=2, ensure_ascii=False) + "\n"

    if rendered == original:
        print("No change needed - AI_Field_Audit_v2.json is already up to date.")
        return 0

    if check_only:
        print("FAIL: AI_Field_Audit_v2.json is stale. Run:")
        print("  python3 scripts/patch_india_workflow.py")
        return 1

    with open(PATH, "w", encoding="utf-8") as fh:
        fh.write(rendered)

    print("Patched " + os.path.relpath(PATH, REPO))
    print("  nodes with JS from scripts/nodes/: "
          + ", ".join(sorted(list(JS_NODES) + [SHAPE_NODE_NAME])))
    print("  LOG_Audit columns: " + str(len(COLUMNS))
          + "  (onError=continueRegularOutput, maxTries=3)")
    print("  IF_NonCompliant now branches on the boolean alert_required")
    print()
    print("NEXT, IN THIS ORDER:")
    print("  1. Apply scripts/db/004_field_audit_logs_severity.sql")
    print("  2. Re-import this file into n8n, UPDATING the existing workflow")
    print("     (a second copy would fight over /webhook/audit-field-photov2)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
