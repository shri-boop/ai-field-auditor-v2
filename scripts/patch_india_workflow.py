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
      -> PARSE_Input            ind_01_validate_input.js   SSRF guard, never throws
      -> ROUTE_Validation       NEW NODE, on validation_ok
           |- 0 valid
           `- 1 rejected -> RESPOND_BadRequest   NEW NODE, HTTP 400 with a reason
      -> BUILD_Vision_Payload   ind_02_build_payload.js    severity-tagged checklist
      -> Claude_Vision_API      120 s timeout, 3 tries, onError: continueErrorOutput
           |- 0 ok
           `- 1 failed -> Vision_Fallback  NEW NODE, openai/gpt-4o
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

7.4  PARSE_Input restricts image_url to https on an allow-listed object-store
     host, with no userinfo, no IP literals and no private ranges. The URL is
     caller-controlled and OpenRouter dereferences it, which made the audit
     webhook a request-forgery primitive pointed at whatever the caller named.

7.5  ROUTE_Validation + RESPOND_BadRequest. PARSE_Input no longer throws, so a
     malformed request gets HTTP 400 and a reason instead of a 500 with an empty
     body, and never reaches the paid vision call.

7.6  Claude_Vision_API gets a 120 s timeout and 3 tries, and on failure routes to
     Vision_Fallback on openai/gpt-4o. Previously one provider incident lost the
     audit outright: no timeout meant a hung request held the execution open, and
     with no fallback there was nothing to fail over to.

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
    "PARSE_Input": "ind_01_validate_input.js",
    "BUILD_Vision_Payload": "ind_02_build_payload.js",
    "PARSE_Response": "ind_03_derive_verdict.js",
    "NOTIFY_OpsManager": "ind_05_build_alert.js",
}

SHAPE_NODE_NAME = "SHAPE_Response"
SHAPE_NODE_FILE = "ind_04_shape_response.js"
SHAPE_NODE_ID = "ind-shape-response-0001"

# ---------------------------------------------------------------- roadmap 7.5
ROUTE_NODE_NAME = "ROUTE_Validation"
ROUTE_NODE_ID = "ind-route-validation-0002"
RESPOND_400_NAME = "RESPOND_BadRequest"
RESPOND_400_ID = "ind-respond-badrequest-0003"

# ---------------------------------------------------------------- roadmap 7.6
FALLBACK_NODE_NAME = "Vision_Fallback"
FALLBACK_NODE_ID = "ind-vision-fallback-0004"

# Same fallback as the US workflow (FALLBACK_MODEL in build_us_workflow.py). A
# different vendor on purpose: failing over from Claude to another Anthropic model
# would share the outage being failed over from.
FALLBACK_MODEL = "openai/gpt-4o"

# A vision call on a large photo is slow, but not unbounded. Without a timeout a
# hung provider connection holds the n8n execution open indefinitely and the
# caller's HTTP request with it.
VISION_TIMEOUT_MS = 120000

# OpenRouter credential, reused by the fallback node. Recorded for the same reason
# as the webhook and Postgres credentials: so the workflow imports ready-to-run.
CRED_OPENROUTER = {"httpHeaderAuth": {"id": "Yo4OGxALKxIBKco8", "name": "OpenRouter"}}

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

# Webhook Header Auth, header name x-audit-api-key, sent by app/api/audit/route.ts.
# Same header name as the US webhook because /api/audit is a single proxy serving
# both regions; the two credentials differ in label and may later differ in value.
CRED_WEBHOOK_AUTH = {"httpHeaderAuth": {"id": "aIwM7jr752xJv7Ss", "name": "Audit IND Key"}}


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
    Require Header Auth on the audit webhook, bound to the India credential.

    Every audit is a paid vision call, so an unauthenticated webhook is a metered
    spend endpoint that anyone who learns the URL can drain. audit-history has used
    Header Auth from the start; this brings the audit endpoints to the same footing.

    Verified enforced: an unauthenticated POST to /webhook/audit-field-photov2
    returns 403.

    The credential ID is recorded so the workflow imports ready-to-run, exactly as
    the Postgres credential already is. The ID is an opaque reference, not the
    secret — the key value lives only in n8n and in AUDIT_API_KEY.

    It was deliberately omitted when the auth was first added, because nothing was
    bound yet and an unbound headerAuth webhook fails closed, which was the safe
    default then. Now that it IS bound, omitting it is the more dangerous option: a
    re-import would silently drop the binding, and fail-closed at that point means
    every India audit is rejected until someone works out why.
    """
    node["parameters"]["authentication"] = "headerAuth"
    node["credentials"] = CRED_WEBHOOK_AUTH


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


def ensure_validation_nodes(wf, by_name):
    """
    Roadmap 7.5 — insert ROUTE_Validation + RESPOND_BadRequest after PARSE_Input.

    PARSE_Input used to throw on bad input. A throw aborts the execution before
    Respond_to_Webhook1 runs, so the caller got HTTP 500 and an empty body and
    could not tell "I sent you a bad URL" from "your workflow is broken". It now
    emits validation_ok and this pair turns a false into a real 400.

    Placing the gate BEFORE BUILD_Vision_Payload is the point: a rejected request
    never reaches Claude_Vision_API, so malformed input costs nothing. Every audit
    is a metered vision call.
    """
    parse_pos = by_name["PARSE_Input"]["position"]

    if ROUTE_NODE_NAME not in by_name:
        wf["nodes"].append({
            "parameters": {
                "mode": "expression",
                "numberOutputs": 2,
                # 0 = valid, 1 = rejected. Same expression as the US ROUTE_Validation.
                "output": "={{ $json.validation_ok ? 0 : 1 }}",
                "options": {},
            },
            "id": ROUTE_NODE_ID,
            "name": ROUTE_NODE_NAME,
            "type": "n8n-nodes-base.switch",
            "typeVersion": 3.2,
            "position": [parse_pos[0] + 240, parse_pos[1]],
        })
    else:
        node = by_name[ROUTE_NODE_NAME]
        node["parameters"]["output"] = "={{ $json.validation_ok ? 0 : 1 }}"
        node["parameters"]["numberOutputs"] = 2

    if RESPOND_400_NAME not in by_name:
        wf["nodes"].append({
            "parameters": {
                "respondWith": "json",
                # advisory_only mirrors the success response: this platform screens,
                # it does not certify, and a rejection should not read as a verdict.
                "responseBody": "={{ JSON.stringify({ status: 'REJECTED', "
                                "error_code: $json.validation_error_code, "
                                "error: $json.validation_error, "
                                "received_value: $json.received_value, "
                                "advisory_only: true }) }}",
                "options": {"responseCode": 400},
            },
            "id": RESPOND_400_ID,
            "name": RESPOND_400_NAME,
            "type": "n8n-nodes-base.respondToWebhook",
            "typeVersion": 1,
            "position": [parse_pos[0] + 240, parse_pos[1] + 240],
        })
    else:
        by_name[RESPOND_400_NAME]["parameters"]["options"]["responseCode"] = 400

    # Rewire: PARSE_Input -> ROUTE_Validation -> {0: BUILD_Vision_Payload,
    # 1: RESPOND_BadRequest}.
    wf["connections"]["PARSE_Input"] = {
        "main": [[{"node": ROUTE_NODE_NAME, "type": "main", "index": 0}]]
    }
    wf["connections"][ROUTE_NODE_NAME] = {
        "main": [
            [{"node": "BUILD_Vision_Payload", "type": "main", "index": 0}],
            [{"node": RESPOND_400_NAME, "type": "main", "index": 0}],
        ]
    }


def ensure_vision_resilience(wf, by_name):
    """
    Roadmap 7.6 — timeout, retries and a fallback model on the vision call.

    Before this the node had options: {} — no timeout at all — no retryOnFail, and
    no error output. So a hung OpenRouter connection held the execution (and the
    caller's request) open indefinitely, and any transport failure ended the audit
    with nothing written and no alert: the same class of silent loss that 7.3 fixed
    for the database, still open for the model call.

    Retries come first because the overwhelming majority of failures are transient.
    Only once three attempts have failed does the fallback fire, on a different
    vendor so the second attempt is not inside the first one's outage.
    """
    vision = by_name["Claude_Vision_API"]
    vision["parameters"]["options"]["timeout"] = VISION_TIMEOUT_MS
    vision["retryOnFail"] = True
    vision["maxTries"] = 3
    vision["waitBetweenTries"] = 2000
    # Transport/provider failure routes to output 1 -> Vision_Fallback.
    vision["onError"] = "continueErrorOutput"

    vision_pos = vision["position"]

    if FALLBACK_NODE_NAME not in by_name:
        wf["nodes"].append({
            "parameters": {
                "method": "POST",
                "url": "https://openrouter.ai/api/v1/chat/completions",
                "authentication": "genericCredentialType",
                "genericAuthType": "httpHeaderAuth",
                "sendBody": True,
                "contentType": "raw",
                "rawContentType": "application/json",
                # Reuse the payload BUILD_Vision_Payload already rendered, swapping
                # only the model. Rebuilding it would risk the fallback grading
                # against a different checklist than the primary — the one thing a
                # fallback must not do.
                "body": "={{ JSON.stringify(Object.assign({}, "
                        "$('BUILD_Vision_Payload').first().json.payload, "
                        "{ model: '" + FALLBACK_MODEL + "' })) }}",
                "options": {"timeout": VISION_TIMEOUT_MS},
            },
            "id": FALLBACK_NODE_ID,
            "name": FALLBACK_NODE_NAME,
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4,
            "position": [vision_pos[0], vision_pos[1] + 260],
            "credentials": CRED_OPENROUTER,
            "retryOnFail": True,
            "maxTries": 2,
            "waitBetweenTries": 3000,
            # If the fallback fails too, continue anyway: PARSE_Response reports a
            # SYSTEM_ERROR verdict, which is visible. Aborting here would be silent.
            "onError": "continueRegularOutput",
        })
    else:
        fb = by_name[FALLBACK_NODE_NAME]
        fb["parameters"]["body"] = ("={{ JSON.stringify(Object.assign({}, "
                                    "$('BUILD_Vision_Payload').first().json.payload, "
                                    "{ model: '" + FALLBACK_MODEL + "' })) }}")
        fb["parameters"]["options"]["timeout"] = VISION_TIMEOUT_MS
        fb["credentials"] = CRED_OPENROUTER

    # Rewire: Claude_Vision_API -> {0: PARSE_Response, 1: Vision_Fallback},
    # and the fallback rejoins the same chain.
    wf["connections"]["Claude_Vision_API"] = {
        "main": [
            [{"node": "PARSE_Response", "type": "main", "index": 0}],
            [{"node": FALLBACK_NODE_NAME, "type": "main", "index": 0}],
        ]
    }
    wf["connections"][FALLBACK_NODE_NAME] = {
        "main": [[{"node": "PARSE_Response", "type": "main", "index": 0}]]
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
    ensure_validation_nodes(wf, by_name)
    ensure_vision_resilience(wf, by_name)

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
    print("  " + ROUTE_NODE_NAME + " + " + RESPOND_400_NAME
           + ": bad input gets HTTP 400, never reaches the model (7.5)")
    print("  Claude_Vision_API: timeout=" + str(VISION_TIMEOUT_MS)
           + "ms, maxTries=3, falls back to " + FALLBACK_MODEL + " (7.6)")
    print()
    print("NEXT, IN THIS ORDER:")
    print("  1. No DB migration is needed for this change - no new columns.")
    print("  2. Re-import this file into n8n, UPDATING the existing workflow")
    print("     (a second copy would fight over /webhook/audit-field-photov2)")
    print("  3. This adds 3 nodes and re-wires 3 connections, so confirm on the")
    print("     canvas: PARSE_Input -> ROUTE_Validation -> {BUILD_Vision_Payload,")
    print("     RESPOND_BadRequest} and Claude_Vision_API error output ->")
    print("     " + FALLBACK_NODE_NAME + " -> PARSE_Response.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
