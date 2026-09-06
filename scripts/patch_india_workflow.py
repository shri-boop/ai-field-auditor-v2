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
      -> VALIDATE_Input         ind_01_validate_input.js   SSRF guard, never throws
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

7.4  VALIDATE_Input restricts image_url to https on an allow-listed object-store
     host, with no userinfo, no IP literals and no private ranges. The URL is
     caller-controlled and OpenRouter dereferences it, which made the audit
     webhook a request-forgery primitive pointed at whatever the caller named.

7.5  ROUTE_Validation + RESPOND_BadRequest. VALIDATE_Input no longer throws, so a
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

# The workflow's own name, as it now reads in the n8n UI.
#
# It was "AI_Field_Audit_V2_URL_To_Base64" — a leftover from the abandoned approach
# that downloaded the image and base64-encoded it, which survives in this workflow
# only as the disabled DOWNLOAD_Image -> EXTRACT_Base64 pair. The name outlived the
# design by long enough to be actively misleading: it described a data path the
# workflow no longer takes.
#
# Set here rather than left to the UI because an import carries `name` with it. A
# stale name in this artifact would silently rename the live workflow back on every
# re-import, which is how it would have crept back the next time anyone deployed.
WORKFLOW_NAME = "AI_Field_Audit_V2"

# name -> source file. PARSE_Response keeps its name although its job changed
# from transcribing the model's verdict to deriving one: renaming it would break
# every $('PARSE_Response') reference and the node's own execution history.
JS_NODES = {
    "VALIDATE_Input": "ind_01_validate_input.js",
    "BUILD_Vision_Payload": "ind_02_build_payload.js",
    "PARSE_Response": "ind_03_derive_verdict.js",
    "NOTIFY_OpsManager": "ind_05_build_alert.js",
}

# ---------------------------------------------------------------- node renames
# old name -> new name. Applied before anything else looks the nodes up.
#
# PARSE_Input became VALIDATE_Input in 7.4/7.5: the node stopped merely
# normalising the body and became the workflow's input-validation boundary. A node
# that enforces a security control should say so — "where is untrusted input
# validated?" is a question a buyer's security review will ask, and "a node called
# PARSE_Input" is the wrong shape of answer. It also brings India into line with
# the US workflow, which has always called it VALIDATE_Input.
#
# The rename is done HERE, mechanically, rather than by hand in the n8n UI,
# because two Code nodes reach back for it as $('...') and those references live
# in scripts/nodes/*.js. Renaming in the UI alone splits the two: the live
# workflow gets one name and the committed JavaScript keeps the other, and the
# next re-import silently reintroduces a reference to a node that no longer
# exists. test_india.mjs now asserts every $('...') reference resolves to a real
# node, so that divergence cannot ship again.
RENAMES = {
    "PARSE_Input": "VALIDATE_Input",
}

SHAPE_NODE_NAME = "SHAPE_Response"
SHAPE_NODE_FILE = "ind_04_shape_response.js"
SHAPE_NODE_ID = "ind-shape-response-0001"

# ---------------------------------------------------------------- roadmap 7.5
ROUTE_NODE_NAME = "ROUTE_Validation"
ROUTE_NODE_ID = "ind-route-validation-0002"
RESPOND_400_NAME = "RESPOND_BadRequest"
RESPOND_400_ID = "ind-respond-badrequest-0003"

# ------------------------------------------------- production hardening
# The shared Error_Handler workflow in n8n, owned by agentic-dev-stack and reused
# unmodified. Registered as this workflow's errorWorkflow so n8n invokes it on ANY
# unhandled failure -- including ones no in-workflow path can reach, such as the
# workflow being unable to start.
#
# It is deliberately NOT called inline. It makes an LLM diagnosis call, and on the
# response path that would cost the caller 10-30 s while AUDIT_TIMEOUT_MS is 240 s;
# it would also fail in the exact case it is most needed, since OpenRouter going
# down is the most likely failure here. Asynchronous is the only correct place for
# it. See scripts/nodes/shared_error_handler.js for the synchronous half.
ERROR_WORKFLOW_ID = "iLRmjyuk5mq1hqkB"

ERROR_HANDLER_NAME = "ERROR_Handler"
ERROR_HANDLER_ID = "ind-error-handler-0005"
ERROR_HANDLER_FILE = "shared_error_handler.js"
RESPOND_ERROR_NAME = "RESPOND_Error"
RESPOND_ERROR_ID = "ind-respond-error-0006"

# Code nodes on the pre-response path. Each gets onError: continueErrorOutput so a
# throw becomes a structured 500 instead of an aborted execution with no response.
#
# NOT in this list, deliberately: NOTIFY_OpsManager. It sits on the notification
# branch AFTER Respond_to_Webhook1 has answered, and n8n allows one response per
# execution -- routing it to RESPOND_Error would raise "Webhook response already
# sent" and turn a lost alert into a failed run.
PRE_RESPONSE_CODE_NODES = [
    "VALIDATE_Input", "BUILD_Vision_Payload", "PARSE_Response", "SHAPE_Response",
]

# Post-response side effects. These continue on error and never reach a responder.
# India previously had NO retry and NO onError on the notifiers, so a Telegram 429
# aborted the execution -- on a CRITICAL finding, and when persisted is false the
# alert is the only copy of it. US already had this; this brings India to parity.
POST_RESPONSE_TOLERANT = ["NOTIFY_OpsManager", "SEND_Telegram", "SEND_Slack"]

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
    # migration 006 — audit_timestamp is now timestamptz, not text.
    #
    # The mapped TYPE stays "string" deliberately. DERIVE_Verdict emits
    # `new Date().toISOString()`, which is ISO-8601 with an explicit trailing Z, and
    # Postgres casts that to timestamptz unambiguously. Switching the mapping to
    # n8n's "dateTime" would hand the formatting to n8n instead, and n8n's date
    # coercion is not something this repo can test offline — the whole harness exists
    # because untestable assumptions about the n8n runtime have bitten before.
    #
    # A value that is already correct and explicitly UTC does not need a second
    # opinion about its timezone.
    "audit_timestamp": ("={{ $json.audit_timestamp }}", "string"),
    # migration 006 — the minted identifier field_audit_signoffs will reference.
    "audit_id": ("={{ $json.audit_id }}", "string"),
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


def harden_nodes(by_name):
    """
    Retry and error tolerance, per checklist items 2 and 3.

    Two classes, and the distinction is what prevents a double-response bug:

      pre-response Code nodes -> continueErrorOutput, wired to ERROR_Handler
      post-response notifiers -> continueRegularOutput, wired nowhere

    A node that fails before the caller has been answered must produce a response.
    A node that fails after must not attempt one.
    """
    for name in PRE_RESPONSE_CODE_NODES:
        node = by_name.get(name)
        if node is None:
            continue
        node["onError"] = "continueErrorOutput"

    for name in POST_RESPONSE_TOLERANT:
        node = by_name.get(name)
        if node is None:
            continue
        node["onError"] = "continueRegularOutput"
        node["alwaysOutputData"] = True
        # A transient 429 from Telegram is far more likely than an outage, and a
        # life-safety alert is worth two attempts before it is given up on.
        node["retryOnFail"] = True
        node["maxTries"] = 2
        node["waitBetweenTries"] = 3000


def ensure_error_handler(wf, by_name):
    """
    Checklist items 5 and 7: exactly one central error handler, and no execution
    path that fails to reach a Respond to Webhook node.

    A Code node rather than a Set node, following the recorded rule that Set
    assignments sometimes render empty after import. That bug is survivable
    elsewhere; in the node responsible for reporting failures it would mean silently
    reporting nothing.

    RESPOND_Error answers 500, not 200-with-a-flag. A node that blew up IS a server
    error, /api/audit passes the status through with the body intact, and a 5xx is
    visible to every HTTP-level monitor whereas a 200 hides the failure from all of
    them. The BODY follows the checklist's error shape.
    """
    source = js(ERROR_HANDLER_FILE)

    if ERROR_HANDLER_NAME in by_name:
        by_name[ERROR_HANDLER_NAME]["parameters"]["jsCode"] = source
    else:
        wf["nodes"].append({
            "parameters": {"jsCode": source},
            "id": ERROR_HANDLER_ID,
            "name": ERROR_HANDLER_NAME,
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [-864, 800],
        })

    if RESPOND_ERROR_NAME not in by_name:
        wf["nodes"].append({
            "parameters": {
                "respondWith": "json",
                "responseBody": "={{ JSON.stringify({ success: false, "
                                "error: $json.error, code: $json.code, "
                                "timestamp: $json.timestamp, "
                                "error_node: $json.error_node, "
                                "workflow: $json.workflow_name, "
                                "audit_id: $json.audit_id, "
                                "advisory_only: true }) }}",
                "options": {"responseCode": 500},
            },
            "id": RESPOND_ERROR_ID,
            "name": RESPOND_ERROR_NAME,
            "type": "n8n-nodes-base.respondToWebhook",
            "typeVersion": 1,
            "position": [-624, 800],
        })

    # Error output is index 1 on a node with continueErrorOutput.
    for name in PRE_RESPONSE_CODE_NODES:
        if name not in by_name:
            continue
        existing = wf["connections"].get(name, {}).get("main", [])
        main = [list(existing[0]) if existing else []]
        main.append([{"node": ERROR_HANDLER_NAME, "type": "main", "index": 0}])
        wf["connections"][name] = {"main": main}

    # Every Switch node's fallbackOutput must actually be connected. ROUTE_Validation
    # declares fallbackOutput: extra, which n8n exposes as output index 2.
    for node_name, node in by_name.items():
        if node.get("type") != "n8n-nodes-base.switch":
            continue
        if (node.get("parameters", {}).get("options", {}) or {}).get("fallbackOutput") != "extra":
            continue
        outputs = int(node["parameters"].get("numberOutputs", 2))
        existing = wf["connections"].get(node_name, {}).get("main", [])
        main = [list(existing[i]) if i < len(existing) else [] for i in range(outputs)]
        main.append([{"node": ERROR_HANDLER_NAME, "type": "main", "index": 0}])
        wf["connections"][node_name] = {"main": main}

    wf["connections"][ERROR_HANDLER_NAME] = {
        "main": [[{"node": RESPOND_ERROR_NAME, "type": "main", "index": 0}]]
    }


def apply_renames(wf):
    """
    Rename nodes in place, preserving each node's id, and repoint every
    connection that names them.

    Preserving the id matters: n8n keys a node's identity off it, so a rename that
    also changed the id would read as "delete this node, add a different one" and
    discard its execution history for no reason.
    """
    renamed = []
    for node in wf["nodes"]:
        new_name = RENAMES.get(node["name"])
        if new_name:
            node["name"] = new_name
            renamed.append(new_name)

    if not renamed:
        return renamed

    # Connection dict keys are source node names.
    for old_name, new_name in RENAMES.items():
        if old_name in wf["connections"]:
            wf["connections"][new_name] = wf["connections"].pop(old_name)

    # Connection targets name nodes too.
    for outputs in wf["connections"].values():
        for branch in outputs.get("main", []):
            for conn in branch or []:
                if conn.get("node") in RENAMES:
                    conn["node"] = RENAMES[conn["node"]]

    return renamed


def ensure_validation_nodes(wf, by_name):
    """
    Roadmap 7.5 — insert ROUTE_Validation + RESPOND_BadRequest after VALIDATE_Input.

    VALIDATE_Input used to throw on bad input. A throw aborts the execution before
    Respond_to_Webhook1 runs, so the caller got HTTP 500 and an empty body and
    could not tell "I sent you a bad URL" from "your workflow is broken". It now
    emits validation_ok and this pair turns a false into a real 400.

    Placing the gate BEFORE BUILD_Vision_Payload is the point: a rejected request
    never reaches Claude_Vision_API, so malformed input costs nothing. Every audit
    is a metered vision call.
    """
    parse_pos = by_name["VALIDATE_Input"]["position"]

    if ROUTE_NODE_NAME not in by_name:
        wf["nodes"].append({
            "parameters": {
                "mode": "expression",
                "numberOutputs": 2,
                # 0 = valid, 1 = rejected. Same expression as the US ROUTE_Validation.
                "output": "={{ $json.validation_ok ? 0 : 1 }}",
                # Checklist item 8. Without a fallback an unroutable value is
                # silently dropped and NO response is ever sent -- a silent timeout,
                # which item 7 forbids outright. The extra output goes to
                # ERROR_Handler, so "the router did not recognise this" is reported
                # rather than swallowed.
                "options": {"fallbackOutput": "extra"},
            },
            "id": ROUTE_NODE_ID,
            "name": ROUTE_NODE_NAME,
            "type": "n8n-nodes-base.switch",
            "typeVersion": 3.2,
            "position": [parse_pos[0] + 240, parse_pos[1]],
        })
    else:
        # The update path must set everything the create path does, or a workflow
        # that already exists silently misses whatever was added later. That is how
        # fallbackOutput came to be declared for new installs and absent here.
        node = by_name[ROUTE_NODE_NAME]
        node["parameters"]["output"] = "={{ $json.validation_ok ? 0 : 1 }}"
        node["parameters"]["numberOutputs"] = 2
        node["parameters"].setdefault("options", {})["fallbackOutput"] = "extra"

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

    # Rewire: VALIDATE_Input -> ROUTE_Validation -> {0: BUILD_Vision_Payload,
    # 1: RESPOND_BadRequest}.
    wf["connections"]["VALIDATE_Input"] = {
        "main": [[{"node": ROUTE_NODE_NAME, "type": "main", "index": 0}]]
    }
    # Three outputs, because fallbackOutput: extra adds one. Declaring the fallback
    # in the parameters without WIRING it is worse than not declaring it: the output
    # exists, looks handled on the canvas, and still drops the item into nothing.
    # Output 2 is populated by ensure_error_handler(), which runs after this.
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

    # Before anything looks a node up by name.
    renamed = apply_renames(wf)

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

    wf["name"] = WORKFLOW_NAME
    wf.setdefault("settings", {})["errorWorkflow"] = ERROR_WORKFLOW_ID

    patch_webhook_auth(by_name["Webhook"])

    for node_name, filename in JS_NODES.items():
        by_name[node_name]["parameters"]["jsCode"] = js(filename)

    harden_nodes(by_name)
    patch_log_audit(by_name["LOG_Audit"])
    patch_if_node(by_name["IF_NonCompliant"])
    ensure_shape_node(wf, by_name)
    ensure_validation_nodes(wf, by_name)
    ensure_vision_resilience(wf, by_name)
    ensure_error_handler(wf, by_name)

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
    print("  workflow name: " + WORKFLOW_NAME)
    if renamed:
        print("  renamed node(s): " + ", ".join(renamed))
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
    print("  1. Apply scripts/db/006_field_audit_logs_audit_id_and_timestamp.sql")
    print("     (adds audit_id, converts audit_timestamp to timestamptz;")
    print("      aborts if any existing timestamp will not cast)")
    print("  2. Re-import this file into n8n, UPDATING the existing workflow")
    print("     (a second copy would fight over /webhook/audit-field-photov2)")
    print("  3. Confirm the validator node reads VALIDATE_Input on the canvas.")
    print("     Do NOT rename nodes in the n8n UI: two Code nodes reach for it")
    print("     as $('VALIDATE_Input'), and a UI-only rename breaks the happy")
    print("     path while leaving the reject path working, so a 400 smoke test")
    print("     will not catch it. Rename via RENAMES in this script instead.")
    print("  4. This adds 3 nodes and re-wires 3 connections, so confirm on the")
    print("     canvas: VALIDATE_Input -> ROUTE_Validation -> {BUILD_Vision_Payload,")
    print("     RESPOND_BadRequest} and Claude_Vision_API error output ->")
    print("     " + FALLBACK_NODE_NAME + " -> PARSE_Response.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
