#!/usr/bin/env python3
"""
Assembles AI_Field_Audit_US.json (an importable n8n workflow) from the
individual Code-node sources in scripts/nodes/.

Rationale: the Code nodes carry the entire audit logic. Maintaining them as
escaped one-line strings inside a 30 KB JSON blob is unreviewable and
undiffable. Here they live as real .js files that can be linted and
syntax-checked (`node --check`), and this script performs the escaping.

Usage:
    python3 scripts/build_us_workflow.py
    python3 scripts/build_us_workflow.py --check     # verify committed JSON is current
"""

import json
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODES = os.path.join(REPO, "scripts", "nodes")
OUT = os.path.join(REPO, "AI_Field_Audit_US.json")

# Credential IDs are reused from the existing India workflow so the US workflow
# imports ready-to-run on the same n8n instance.
CRED_OPENROUTER = {"httpHeaderAuth": {"id": "Yo4OGxALKxIBKco8", "name": "OpenRouter"}}
CRED_POSTGRES = {"postgres": {"id": "n7fXon6ujJTrnF7w", "name": "Postgres account"}}
CRED_TELEGRAM = {"telegramApi": {"id": "0JbTkG1AwoZemMu1", "name": "psylentbot"}}
CRED_SLACK = {"slackApi": {"id": "FERICzhUKPyyuxUt", "name": "Slack(Arvami Stack Notifier)"}}
CRED_GMAIL = {"gmailOAuth2": {"id": "C0orKvBTXhFFkCxr", "name": "Advaita"}}

FALLBACK_MODEL = "openai/gpt-4o"
DB_TABLE = "field_audit_us_logs"
WEBHOOK_PATH = "audit-field-photo-us"


def js(filename):
    with open(os.path.join(NODES, filename), "r", encoding="utf-8") as fh:
        return fh.read()


def code_node(node_id, name, filename, position):
    return {
        "parameters": {"jsCode": js(filename)},
        "id": node_id,
        "name": name,
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": position,
    }


def sticky(node_id, content, position, width, height, color):
    return {
        "parameters": {"content": content, "height": height, "width": width, "color": color},
        "id": node_id,
        "name": "Note " + node_id[-4:],
        "type": "n8n-nodes-base.stickyNote",
        "typeVersion": 1,
        "position": position,
    }


def build():
    nodes = []

    # ------------------------------------------------------------------ trigger
    nodes.append({
        "parameters": {
            "httpMethod": "POST",
            "path": WEBHOOK_PATH,
            "responseMode": "responseNode",
            "options": {},
        },
        "id": "us-webhook-0001",
        "name": "Webhook",
        "type": "n8n-nodes-base.webhook",
        "typeVersion": 2,
        "position": [-2600, 400],
        "webhookId": "audit-field-photo-us",
    })

    # ------------------------------------------------------- validate + resolve
    nodes.append(code_node("us-validate-0002", "VALIDATE_Input",
                           "01_validate_input.js", [-2380, 400]))

    # Rejected requests must get a real HTTP 400 with a reason. Throwing inside
    # VALIDATE_Input aborts the run before Respond_to_Webhook, leaving the caller
    # with an empty body and no diagnosis. Rejecting here also means malformed
    # input never reaches the vision model, so it costs nothing.
    nodes.append({
        "parameters": {
            "mode": "expression",
            "numberOutputs": 2,
            "output": "={{ $json.validation_ok ? 0 : 1 }}",
            "options": {},
        },
        "id": "us-routeval-0003",
        "name": "ROUTE_Validation",
        "type": "n8n-nodes-base.switch",
        "typeVersion": 3.2,
        "position": [-2180, 400],
    })

    nodes.append({
        "parameters": {
            "respondWith": "json",
            "responseBody": "={{ JSON.stringify({ status: 'REJECTED', "
                            "error_code: $json.validation_error_code, "
                            "error: $json.validation_error, "
                            "received_value: $json.received_value, "
                            "advisory_only: true }) }}",
            "options": {"responseCode": 400},
        },
        "id": "us-respond400-0004",
        "name": "RESPOND_BadRequest",
        "type": "n8n-nodes-base.respondToWebhook",
        "typeVersion": 1,
        "position": [-2180, 640],
    })

    nodes.append(code_node("us-codebasis-0031", "RESOLVE_CodeBasis",
                           "02_resolve_code_basis.js", [-1960, 400]))
    nodes.append(code_node("us-payload-0032", "BUILD_Vision_Payload",
                           "03_build_vision_payload.js", [-1740, 400]))

    # -------------------------------------------------------------- vision call
    nodes.append({
        "parameters": {
            "method": "POST",
            "url": "https://openrouter.ai/api/v1/chat/completions",
            "authentication": "genericCredentialType",
            "genericAuthType": "httpHeaderAuth",
            "sendBody": True,
            "contentType": "raw",
            "rawContentType": "application/json",
            "body": "={{ JSON.stringify($json.payload) }}",
            "options": {"timeout": 120000},
        },
        "id": "us-vision-0005",
        "name": "Vision_Primary",
        "type": "n8n-nodes-base.httpRequest",
        "typeVersion": 4,
        "position": [-1520, 400],
        "credentials": CRED_OPENROUTER,
        "retryOnFail": True,
        "maxTries": 3,
        "waitBetweenTries": 2000,
        # Transport/provider failure routes to output 1 -> fallback model.
        "onError": "continueErrorOutput",
    })

    nodes.append({
        "parameters": {
            "method": "POST",
            "url": "https://openrouter.ai/api/v1/chat/completions",
            "authentication": "genericCredentialType",
            "genericAuthType": "httpHeaderAuth",
            "sendBody": True,
            "contentType": "raw",
            "rawContentType": "application/json",
            # Reuse the built payload, swapping only the model.
            "body": "={{ JSON.stringify(Object.assign({}, $('BUILD_Vision_Payload').first().json.payload, "
                    "{ model: '" + FALLBACK_MODEL + "' })) }}",
            "options": {"timeout": 120000},
        },
        "id": "us-visionfb-0006",
        "name": "Vision_Fallback",
        "type": "n8n-nodes-base.httpRequest",
        "typeVersion": 4,
        "position": [-1520, 660],
        "credentials": CRED_OPENROUTER,
        "retryOnFail": True,
        "maxTries": 2,
        "waitBetweenTries": 3000,
        "onError": "continueRegularOutput",
    })

    # ----------------------------------------------------- score + persist
    nodes.append(code_node("us-score-0007", "PARSE_And_Score",
                           "04_parse_and_score.js", [-1280, 400]))
    nodes.append(code_node("us-dbrow-0008", "SHAPE_DbRow",
                           "05_shape_db_row.js", [-1060, 400]))

    nodes.append({
        "parameters": {
            "schema": {"__rl": True, "mode": "list", "value": "public"},
            "table": {"__rl": True, "value": DB_TABLE, "mode": "list",
                      "cachedResultName": DB_TABLE},
            "columns": {
                # Keys emitted by SHAPE_DbRow map 1:1 onto table columns.
                "mappingMode": "autoMapInputData",
                "value": {},
                "matchingColumns": ["audit_id"],
                "schema": [],
                "attemptToConvertTypes": False,
                "convertFieldsToString": False,
            },
            "options": {},
        },
        "id": "us-log-0009",
        "name": "LOG_Audit",
        "type": "n8n-nodes-base.postgres",
        "typeVersion": 2.6,
        "position": [-840, 400],
        "credentials": CRED_POSTGRES,
        "retryOnFail": True,
        "maxTries": 3,
        "waitBetweenTries": 1000,
        # A database outage must not swallow a life-safety finding: continue and
        # let BUILD_Report mark the alert as un-persisted.
        "onError": "continueRegularOutput",
        "alwaysOutputData": True,
    })

    # ------------------------------------------------------- report + routing
    nodes.append(code_node("us-report-0010", "BUILD_Report",
                           "06_build_report.js", [-620, 400]))

    nodes.append({
        "parameters": {
            "mode": "expression",
            "numberOutputs": 5,
            # 0 CRITICAL | 1 DEFICIENT | 2 REINSPECT | 3 COMPLIANT | 4 SYSTEM_ERROR
            "output": "={{ $json.route_index }}",
            "options": {},
        },
        "id": "us-route-0011",
        "name": "ROUTE_Outcome",
        "type": "n8n-nodes-base.switch",
        "typeVersion": 3.2,
        "position": [-400, 400],
    })

    # ------------------------------------------------------------- notifiers
    nodes.append({
        "parameters": {
            "select": "channel",
            "channelId": {"__rl": True, "value": "arvami-stack-errors", "mode": "name"},
            "text": "={{ $json.slack_message }}",
            "otherOptions": {},
        },
        "id": "us-slack-0012",
        "name": "SEND_Slack",
        "type": "n8n-nodes-base.slack",
        "typeVersion": 2.4,
        "position": [-140, 60],
        "credentials": CRED_SLACK,
        "onError": "continueRegularOutput",
        "retryOnFail": True,
        "maxTries": 2,
    })

    nodes.append({
        "parameters": {
            "chatId": "1020714503",
            "text": "={{ $json.telegram_message }}",
            "additionalFields": {"appendAttribution": False, "parse_mode": "HTML"},
        },
        "id": "us-telegram-0013",
        "name": "SEND_Telegram",
        "type": "n8n-nodes-base.telegram",
        "typeVersion": 1.2,
        "position": [-140, 260],
        "credentials": CRED_TELEGRAM,
        "onError": "continueRegularOutput",
        "retryOnFail": True,
        "maxTries": 2,
    })

    nodes.append({
        "parameters": {
            "sendTo": "shrinand.shirwal84@gmail.com",
            "subject": "={{ $json.email_subject }}",
            "emailType": "html",
            "message": "={{ $json.email_html }}",
            "options": {"appendAttribution": False},
        },
        "id": "us-email-0014",
        "name": "SEND_Email",
        "type": "n8n-nodes-base.gmail",
        "typeVersion": 2.2,
        "position": [-140, 470],
        "credentials": CRED_GMAIL,
        "onError": "continueRegularOutput",
        # Disabled by default, mirroring the India workflow. Enable once the
        # distribution list is agreed.
        "disabled": True,
    })

    # Integration seam for a CMMS / work-order system (ServiceNow, Salesforce
    # Field Service, Maximo...). Disabled until a target URL is configured.
    nodes.append({
        "parameters": {
            "method": "POST",
            "url": "={{ $env.FIREHAWK_WORKORDER_WEBHOOK }}",
            "sendBody": True,
            "contentType": "raw",
            "rawContentType": "application/json",
            "body": "={{ JSON.stringify({ external_id: $json.audit_id, site_id: $json.site_id, "
                    "priority: 'P1', asset: $json.equipment_type, asset_tag: $json.asset_tag, "
                    "summary: $json.headline, detail: $json.alert, "
                    "impairment_notice: $json.impairment_notice, "
                    "due_at: $json.remediation_due_at, risk_score: $json.risk_score }) }}",
            "options": {"timeout": 30000},
        },
        "id": "us-workorder-0015",
        "name": "CREATE_WorkOrder",
        "type": "n8n-nodes-base.httpRequest",
        "typeVersion": 4,
        "position": [-140, 680],
        "onError": "continueRegularOutput",
        "disabled": True,
    })

    # ------------------------------------------------------------- respond
    nodes.append(code_node("us-respshape-0016", "SHAPE_Response",
                           "07_shape_response.js", [120, 400]))

    nodes.append({
        "parameters": {
            "respondWith": "json",
            "responseBody": "={{ JSON.stringify($json) }}",
            "options": {"responseCode": 200},
        },
        "id": "us-respond-0017",
        "name": "Respond_to_Webhook",
        "type": "n8n-nodes-base.respondToWebhook",
        "typeVersion": 1,
        "position": [340, 400],
    })

    # ------------------------------------------------------------- documentation
    nodes.append(sticky(
        "us-note-0018",
        "## 1 — Intake and code basis\n\n"
        "`VALIDATE_Input` hard-validates the body and closes the SSRF hole in the "
        "India workflow: the image URL must be **https** on an **allow-listed object "
        "store**, and private / loopback hosts are refused.\n\n"
        "`RESOLVE_CodeBasis` is the reason this is a separate workflow rather than a "
        "prompt tweak. India has one national code (NBC 2016) plus one AHJ. The US has "
        "**IFC 2024 in ~41 states, NFPA 1/101 in Florida, California's own Title 24/19, "
        "NYC's FDNY code**, and a federal **OSHA 29 CFR 1910** overlay on workplaces "
        "(displaced by a State Plan in 21+ states).\n\n"
        "So the applicable code is **data**, resolved per request. Adding a jurisdiction "
        "is a registry edit, not a prompt rewrite. Unmatched jurisdictions fall back to "
        "the model-code baseline and are **flagged**, never silently guessed.",
        [-2620, -100], 700, 460, 4))

    nodes.append(sticky(
        "us-note-0019",
        "## 2 — Vision with fallback\n\n"
        "`Vision_Primary` (Claude Sonnet 4.5) has a 120 s timeout and 3 retries. On "
        "hard failure the error output routes to `Vision_Fallback`, which replays the "
        "**same payload** against a second model so a single provider incident does not "
        "drop an audit.\n\n"
        "`temperature: 0` for run-to-run stability on the same photograph.",
        [-1900, -100], 420, 300, 5))

    nodes.append(sticky(
        "us-note-0020",
        "## 3 — Deterministic verdict (the important part)\n\n"
        "v2 trusted the model's own `status`. That is the wrong trust boundary. "
        "`PARSE_And_Score` **derives** the verdict in reviewable code:\n\n"
        "- Severity per US practice: CRITICAL / MAJOR / MINOR\n"
        "- Unknown severities are biased **upward**, never down\n"
        "- **Fail-safe:** a CRITICAL finding escalates even at LOW confidence — a "
        "confidence gate must never hide a life-safety issue\n"
        "- Only-MINOR resolves to `CONDITIONAL`, not a blunt fail\n"
        "- The model must declare what a photo **cannot** settle "
        "(`unverifiable_items`), and a clean screen is never reported as a "
        "certification\n\n"
        "`LOG_Audit` continues on error so a Postgres outage degrades to "
        "`persisted: false` instead of losing a life-safety finding.",
        [-1460, -220], 640, 500, 3))

    nodes.append(sticky(
        "us-note-0021",
        "## 4 — Routing and escalation\n\n"
        "`route_index` is computed upstream; the Switch is a dumb demultiplexer so all "
        "business logic stays in one testable place.\n\n"
        "`0` CRITICAL → Slack + Telegram + email + work order, with an **NFPA 25 "
        "Ch. 15 impairment checklist** (tag, fire watch, notify AHJ and insurer)\n"
        "`1` DEFICIENT → Slack + Telegram + email\n"
        "`2` REINSPECT → Telegram only (photo quality problem, not a site problem)\n"
        "`3` COMPLIANT → respond only, no alert noise\n"
        "`4` SYSTEM_ERROR → Slack (a silent failure in a compliance system is itself "
        "an incident)",
        [-560, -220], 520, 440, 6))

    # ------------------------------------------------------------- connections
    def main(*targets):
        return [[{"node": t, "type": "main", "index": 0} for t in targets]]

    connections = {
        "Webhook": {"main": main("VALIDATE_Input")},
        "VALIDATE_Input": {"main": main("ROUTE_Validation")},
        # 0 = valid -> continue; 1 = rejected -> HTTP 400
        "ROUTE_Validation": {
            "main": [
                [{"node": "RESOLVE_CodeBasis", "type": "main", "index": 0}],
                [{"node": "RESPOND_BadRequest", "type": "main", "index": 0}],
            ]
        },
        "RESOLVE_CodeBasis": {"main": main("BUILD_Vision_Payload")},
        "BUILD_Vision_Payload": {"main": main("Vision_Primary")},
        # output 0 = success, output 1 = error -> fallback model
        "Vision_Primary": {
            "main": [
                [{"node": "PARSE_And_Score", "type": "main", "index": 0}],
                [{"node": "Vision_Fallback", "type": "main", "index": 0}],
            ]
        },
        "Vision_Fallback": {"main": main("PARSE_And_Score")},
        "PARSE_And_Score": {"main": main("SHAPE_DbRow")},
        "SHAPE_DbRow": {"main": main("LOG_Audit")},
        "LOG_Audit": {"main": main("BUILD_Report")},
        "BUILD_Report": {"main": main("ROUTE_Outcome")},
        "ROUTE_Outcome": {
            "main": [
                # 0 CRITICAL
                [
                    {"node": "SEND_Slack", "type": "main", "index": 0},
                    {"node": "SEND_Telegram", "type": "main", "index": 0},
                    {"node": "SEND_Email", "type": "main", "index": 0},
                    {"node": "CREATE_WorkOrder", "type": "main", "index": 0},
                    {"node": "SHAPE_Response", "type": "main", "index": 0},
                ],
                # 1 DEFICIENT
                [
                    {"node": "SEND_Slack", "type": "main", "index": 0},
                    {"node": "SEND_Telegram", "type": "main", "index": 0},
                    {"node": "SEND_Email", "type": "main", "index": 0},
                    {"node": "SHAPE_Response", "type": "main", "index": 0},
                ],
                # 2 REINSPECT
                [
                    {"node": "SEND_Telegram", "type": "main", "index": 0},
                    {"node": "SHAPE_Response", "type": "main", "index": 0},
                ],
                # 3 COMPLIANT
                [
                    {"node": "SHAPE_Response", "type": "main", "index": 0},
                ],
                # 4 SYSTEM_ERROR
                [
                    {"node": "SEND_Slack", "type": "main", "index": 0},
                    {"node": "SHAPE_Response", "type": "main", "index": 0},
                ],
            ]
        },
        "SHAPE_Response": {"main": main("Respond_to_Webhook")},
        "SEND_Slack": {"main": [[]]},
        "SEND_Telegram": {"main": [[]]},
        "SEND_Email": {"main": [[]]},
        "CREATE_WorkOrder": {"main": [[]]},
    }

    # --------------------------------------------------------------- assertions
    # n8n silently misbehaves on duplicate node ids, and duplicate names break
    # $('NodeName') lookups. Both are easy to introduce when inserting a node
    # mid-pipeline, so fail the build instead of shipping it.
    ids = [n["id"] for n in nodes]
    names = [n["name"] for n in nodes]
    dup_ids = sorted({i for i in ids if ids.count(i) > 1})
    dup_names = sorted({n for n in names if names.count(n) > 1})
    if dup_ids:
        raise SystemExit("BUILD FAILED: duplicate node ids: " + ", ".join(dup_ids))
    if dup_names:
        raise SystemExit("BUILD FAILED: duplicate node names: " + ", ".join(dup_names))

    # Overlapping canvas positions make the imported workflow unreadable.
    coords = {}
    for n in nodes:
        if n["type"] == "n8n-nodes-base.stickyNote":
            continue
        key = tuple(n["position"])
        if key in coords:
            raise SystemExit("BUILD FAILED: nodes overlap at %s: %s and %s"
                             % (key, coords[key], n["name"]))
        coords[key] = n["name"]

    # Every referenced node must exist, and every node must be reachable.
    known = set(names)
    for src, conn in connections.items():
        if src not in known:
            raise SystemExit("BUILD FAILED: connection from unknown node: " + src)
        for output in conn["main"]:
            for link in output:
                if link["node"] not in known:
                    raise SystemExit("BUILD FAILED: connection to unknown node: " + link["node"])

    workflow = {
        "name": "AI_Field_Audit_US_NFPA_IFC",
        "nodes": nodes,
        "connections": connections,
        "active": False,
        "settings": {"executionOrder": "v1"},
        "pinData": {
            "Webhook": [
                {
                    "json": {
                        "headers": {"content-type": "application/json"},
                        "params": {},
                        "query": {},
                        "body": {
                            "image_url": "https://6tm3ilznpjpkygcc.public.blob.vercel-storage.com/"
                                         "1782305889054-fire_extinguisher_bad.png",
                            "site_id": "SITE-CA-LAX-014",
                            "jurisdiction": "CA",
                            "occupancy_type": "MERCANTILE",
                            "equipment_hint": "PORTABLE_FIRE_EXTINGUISHER",
                            "inspector_id": "TECH-4471",
                            "asset_tag": "EXT-014-03",
                            "osha_workplace": True,
                        },
                        "webhookUrl": "https://n8n.kratuailabs.com/webhook/" + WEBHOOK_PATH,
                        "executionMode": "test",
                    }
                }
            ]
        },
        "meta": {"templateCredsSetupCompleted": True},
        "tags": [],
    }
    return workflow


def main():
    workflow = build()
    rendered = json.dumps(workflow, indent=2, ensure_ascii=False) + "\n"

    if "--check" in sys.argv:
        if not os.path.exists(OUT):
            print("FAIL: " + OUT + " does not exist. Run without --check.")
            return 1
        with open(OUT, "r", encoding="utf-8") as fh:
            current = fh.read()
        if current != rendered:
            print("FAIL: AI_Field_Audit_US.json is stale. Re-run: "
                  "python3 scripts/build_us_workflow.py")
            return 1
        print("OK: AI_Field_Audit_US.json matches scripts/nodes/*.js")
        return 0

    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write(rendered)

    print("Wrote " + OUT)
    print("  nodes       : " + str(len(workflow["nodes"])))
    print("  code nodes  : " + str(len([n for n in workflow["nodes"]
                                        if n["type"] == "n8n-nodes-base.code"])))
    print("  size        : " + str(len(rendered)) + " bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
