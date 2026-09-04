#!/usr/bin/env python3
"""
Assembles AI_Field_Audit_History.json (an importable n8n workflow) from the
Code-node sources in scripts/nodes/history_*.js.

Same rationale as build_us_workflow.py: the node logic lives as real .js files
that can be linted and syntax-checked (`node --check`), and this script performs
the JSON escaping. Do not hand-edit the generated JSON — the next build
overwrites it.

Usage:
    python3 scripts/build_history_workflow.py
    python3 scripts/build_history_workflow.py --check   # verify committed JSON is current
"""

import json
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODES = os.path.join(REPO, "scripts", "nodes")
OUT = os.path.join(REPO, "AI_Field_Audit_History.json")

# Reused from the audit workflows so this imports ready-to-run on the same n8n.
CRED_POSTGRES = {"postgres": {"id": "n7fXon6ujJTrnF7w", "name": "Postgres account"}}

WEBHOOK_PATH = "audit-history"
US_TABLE = "field_audit_us_logs"
IND_TABLE = "field_audit_logs"

# ---------------------------------------------------------------------------
# SQL
# ---------------------------------------------------------------------------
# Fixed parameter arity per region, each optional filter written as
# ($n IS NULL OR col = $n). VALIDATE_Query builds the array in exactly this
# order — the two must be changed together.
#
# `to` is exclusive (< not <=) so a caller passing one calendar day for both
# bounds gets that entire day.
#
# Columns are listed explicitly rather than SELECT *: a schema change should
# surface here as a Postgres error, not as silently missing fields in a report.

US_QUERY = """SELECT
  audit_id, site_id, asset_tag, inspector_id, jurisdiction, ahj_label, occupancy_type,
  code_basis, equipment_type, equipment_subtype,
  status, critical, confidence, image_quality, risk_score,
  deficiency_count, critical_count, major_count, minor_count,
  deficiencies, violations, unverifiable_items, observations,
  impairment_suspected, impairment_basis,
  reinspect_required, reinspect_reasons,
  image_url, model_used, latency_ms,
  advisory_only, signoff_status, signoff_by, signoff_at,
  sla_hours, remediation_due_at, remediation_status,
  audit_timestamp, created_at
FROM field_audit_us_logs
WHERE ($1::text        IS NULL OR site_id  = $1)
  AND ($2::text        IS NULL OR asset_tag = $2)
  AND ($3::text        IS NULL OR audit_id  = $3)
  AND ($4::text        IS NULL OR status    = $4)
  AND ($5::timestamptz IS NULL OR audit_timestamp >= $5)
  AND ($6::timestamptz IS NULL OR audit_timestamp <  $6)
ORDER BY audit_timestamp DESC
LIMIT $7::int OFFSET $8::int"""

# The India table has no audit_id, asset_tag, jurisdiction or deficiencies —
# VALIDATE_Query rejects those filters for IND rather than ignoring them.
IND_QUERY = """SELECT
  site_id, equipment_type, status, confidence, observations, violations, audit_timestamp
FROM field_audit_logs
WHERE ($1::text        IS NULL OR site_id = $1)
  AND ($2::text        IS NULL OR status  = $2)
  AND ($3::timestamptz IS NULL OR audit_timestamp >= $3)
  AND ($4::timestamptz IS NULL OR audit_timestamp <  $4)
ORDER BY audit_timestamp DESC
LIMIT $5::int OFFSET $6::int"""


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


def query_node(node_id, name, query, position):
    return {
        "parameters": {
            "operation": "executeQuery",
            "query": query,
            "options": {
                # Positional bindings. An expression resolving to an array is
                # what keeps caller input out of the SQL text entirely.
                "queryReplacement": "={{ $json.params }}"
            },
        },
        "id": node_id,
        "name": name,
        "type": "n8n-nodes-base.postgres",
        "typeVersion": 2.5,
        "position": position,
        "credentials": CRED_POSTGRES,
        # A search with no matches must still reach SHAPE_Results, or the caller
        # receives an empty body instead of an honest count of 0.
        "alwaysOutputData": True,
    }


def sticky(node_id, content, position, width, height, color):
    return {
        "parameters": {
            "content": content,
            "height": height,
            "width": width,
            "color": color,
        },
        "id": node_id,
        "name": "Note " + node_id[-4:],
        "type": "n8n-nodes-base.stickyNote",
        "typeVersion": 1,
        "position": position,
    }


def build():
    nodes = [
        {
            "parameters": {
                "httpMethod": "POST",
                "path": WEBHOOK_PATH,
                "responseMode": "responseNode",
                # Header Auth, not a secret compared in a Code node: the sandbox
                # blocks env access, so an in-JS comparison would mean committing
                # the secret to this repo. Bind an httpHeaderAuth credential in
                # the n8n UI after import — until then the webhook refuses every
                # request, which is the correct default for a data-retrieval
                # endpoint over an append-only safety log.
                "authentication": "headerAuth",
                "options": {},
            },
            "id": "0001-webhook",
            "name": "Webhook",
            "type": "n8n-nodes-base.webhook",
            "typeVersion": 2,
            "position": [-260, 300],
            "webhookId": "audit-history-webhook",
        },
        code_node("0002-validate", "VALIDATE_Query", "history_01_validate_query.js", [-40, 300]),
        {
            "parameters": {
                "rules": {
                    "values": [
                        {
                            "conditions": {
                                "options": {
                                    "caseSensitive": True,
                                    "leftValue": "",
                                    "typeValidation": "strict",
                                    "version": 2,
                                },
                                "conditions": [
                                    {
                                        "id": "route-rejected",
                                        "leftValue": "={{ $json.route_index }}",
                                        "rightValue": 0,
                                        "operator": {
                                            "type": "number",
                                            "operation": "equals",
                                        },
                                    }
                                ],
                                "combinator": "and",
                            },
                            "renameOutput": True,
                            "outputKey": "rejected",
                        },
                        {
                            "conditions": {
                                "options": {
                                    "caseSensitive": True,
                                    "leftValue": "",
                                    "typeValidation": "strict",
                                    "version": 2,
                                },
                                "conditions": [
                                    {
                                        "id": "route-us",
                                        "leftValue": "={{ $json.route_index }}",
                                        "rightValue": 1,
                                        "operator": {
                                            "type": "number",
                                            "operation": "equals",
                                        },
                                    }
                                ],
                                "combinator": "and",
                            },
                            "renameOutput": True,
                            "outputKey": "us",
                        },
                        {
                            "conditions": {
                                "options": {
                                    "caseSensitive": True,
                                    "leftValue": "",
                                    "typeValidation": "strict",
                                    "version": 2,
                                },
                                "conditions": [
                                    {
                                        "id": "route-ind",
                                        "leftValue": "={{ $json.route_index }}",
                                        "rightValue": 2,
                                        "operator": {
                                            "type": "number",
                                            "operation": "equals",
                                        },
                                    }
                                ],
                                "combinator": "and",
                            },
                            "renameOutput": True,
                            "outputKey": "ind",
                        },
                    ]
                },
                "options": {},
            },
            "id": "0003-route",
            "name": "ROUTE_Query",
            "type": "n8n-nodes-base.switch",
            "typeVersion": 3.2,
            "position": [180, 300],
        },
        {
            "parameters": {
                "respondWith": "json",
                "responseBody": "={{ JSON.stringify({ query_ok: false, error_code: $json.error_code, error: $json.error, received_value: $json.received_value }) }}",
                "options": {"responseCode": 400},
            },
            "id": "0004-respond-400",
            "name": "RESPOND_BadRequest",
            "type": "n8n-nodes-base.respondToWebhook",
            "typeVersion": 1.1,
            "position": [420, 120],
        },
        query_node("0005-query-us", "QUERY_US", US_QUERY, [420, 300]),
        query_node("0006-query-ind", "QUERY_IND", IND_QUERY, [420, 480]),
        code_node("0007-shape", "SHAPE_Results", "history_02_shape_results.js", [660, 390]),
        {
            "parameters": {
                "respondWith": "json",
                "responseBody": "={{ JSON.stringify($json) }}",
                "options": {"responseCode": 200},
            },
            "id": "0008-respond-200",
            "name": "Respond_to_Webhook",
            "type": "n8n-nodes-base.respondToWebhook",
            "typeVersion": 1.1,
            "position": [900, 390],
        },
        sticky(
            "0009-note",
            "## Audit Records lookup\n\n"
            "`POST /webhook/audit-history` — read-only history over the two audit logs.\n\n"
            "### Before this will run\n"
            "**Bind a Header Auth credential on the Webhook node.** Create an *httpHeaderAuth* "
            "credential (suggested name `Audit History Key`) with header **`x-audit-history-key`** "
            "and a long random value, then set the same value as `HISTORY_API_KEY` in Vercel.\n\n"
            "Until it is bound the webhook rejects everything — deliberate, for an endpoint that "
            "reads customer sites and their fire-safety deficiencies.\n\n"
            "### Safety properties\n"
            "- SQL uses positional parameters only; no caller input reaches the query text.\n"
            "- At least one filter is mandatory — no unbounded listing of the log.\n"
            "- `limit` is capped at 100.\n"
            "- Read-only: SELECT only, no write path exists in this workflow.\n\n"
            "### Regions are not symmetric\n"
            "`field_audit_us_logs` is the rich table. `field_audit_logs` (India) holds only seven "
            "columns and has no `audit_id` or `asset_tag`, so those filters are **rejected** for "
            "IND rather than ignored.\n\n"
            "Build artifact — edit `scripts/nodes/history_*.js` and run "
            "`python3 scripts/build_history_workflow.py`.",
            [-260, 520],
            460,
            560,
            7,
        ),
    ]

    connections = {
        "Webhook": {"main": [[{"node": "VALIDATE_Query", "type": "main", "index": 0}]]},
        "VALIDATE_Query": {"main": [[{"node": "ROUTE_Query", "type": "main", "index": 0}]]},
        "ROUTE_Query": {
            "main": [
                [{"node": "RESPOND_BadRequest", "type": "main", "index": 0}],
                [{"node": "QUERY_US", "type": "main", "index": 0}],
                [{"node": "QUERY_IND", "type": "main", "index": 0}],
            ]
        },
        "QUERY_US": {"main": [[{"node": "SHAPE_Results", "type": "main", "index": 0}]]},
        "QUERY_IND": {"main": [[{"node": "SHAPE_Results", "type": "main", "index": 0}]]},
        "SHAPE_Results": {
            "main": [[{"node": "Respond_to_Webhook", "type": "main", "index": 0}]]
        },
    }

    return {
        "name": "AI_Field_Audit_History",
        "nodes": nodes,
        "connections": connections,
        # Never ship active: the operator activates after binding credentials
        # and confirming the query against their own database.
        "active": False,
        "settings": {"executionOrder": "v1"},
        "meta": {"instanceId": "kratu-aquila-history"},
        "tags": [],
    }


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
            print("FAIL: " + os.path.basename(OUT) + " is stale. Re-run the builder.")
            return 1
        print("OK: " + os.path.basename(OUT) + " matches scripts/nodes/history_*.js")
        return 0

    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write(rendered)
    print("Wrote " + OUT + " (" + str(len(workflow["nodes"])) + " nodes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
