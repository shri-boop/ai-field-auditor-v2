# Production readiness — conformance record

Audit of all three workflows against **Production Ready Workflow Requirements** and
the **Pre-Return Checklist** in `.claude/n8n-workflow.md` (which lives in the parent
superproject, not in this repository).

Enforced by `node scripts/test_production_ready.mjs` — 96 assertions read the
**committed artifacts**, the same files n8n imports, rather than the generators. That
distinction caught a real bug during this work: `fallbackOutput` was set in the branch
of `ensure_validation_nodes()` that *creates* the router and not in the branch that
*updates* an existing one, so new installs had it and the live workflow did not.

Two items are **not** conforming and are recorded as such below rather than asserted
as passing. An assertion that went green on them would be a lie.

---

## Conforming

| Item | Where |
|---|---|
| 1. Input validation after Webhook | `VALIDATE_Input` / `VALIDATE_Query` → `ROUTE_*` → `RESPOND_BadRequest` (400) |
| 2. Error path on every failable node | every Code node `continueErrorOutput`; every Postgres retries; notifiers tolerate |
| 3. Retry logic | HTTP `retryOnFail` + timeout everywhere; Postgres `retryOnFail` everywhere |
| 5. One central Error Handler | `ERROR_Handler` → `RESPOND_Error` → `BUILD_ErrorAlert` → `CALL_ErrorHandler`, one per workflow |
| 7. No silent failures | asserted by graph traversal in all three workflows |
| 8. Switch `fallbackOutput: extra` | all four routers, **and the extra output is wired** |
| Pre-return #2 unique ids, #3 no orphans, #5 `contentType: raw`, #7 no control chars, #10 credential ids | asserted |
| n8n 2.12.2: no `crypto` in Code nodes | FNV-1a, and the reason is documented in the node |
| Pattern #1: Postgres erases the incoming item | `BUILD_Report` and `SHAPE_Response` read `$('PARSE_And_Score')` / `$('PARSE_Response')` by name; only `dbResult` comes from `$input` |
| Pattern #9: generate JSON from a script | `build_us_workflow.py`, `patch_india_workflow.py`, `build_history_workflow.py` |
| Pattern #10: LLM output is advisory, authority server-side | the project's core design — the verdict is derived in code from severities |
| Pattern #12: emoji as JS escapes | `\ud83d\udd34` surrogate pairs |

### What was actually broken, and is now fixed

**India's notifiers aborted the execution.** `SEND_Telegram` and `SEND_Slack` had no
retry and no `onError`, so a Telegram 429 stopped the workflow — on a CRITICAL
finding, and when `persisted: false` the alert is the *only* copy of that finding. US
already had this; India is now at parity. This was the same class of bug §7.3 fixed
for `LOG_Audit` and never applied to the notifiers.

**History's Postgres reads had no error path at all.** `QUERY_US` and `QUERY_IND`
stopped the workflow on a transient blip, so a Records lookup returned *nothing* — no
response, no error, a hanging request until the proxy timed out. The plainest possible
violation of item 7.

**No Switch had a fallback.** An unroutable value was dropped and no response was
ever sent. `ROUTE_Outcome` is the worst case: its index comes from a derived status,
so an unrecognised value means the verdict logic produced something the router does
not know about — exactly what §7.1 was written to prevent.

**No workflow had `errorWorkflow` set**, so an unhandled failure told nobody.

---

## Deliberate deviations

Each of these keeps working behaviour and adds the conforming part alongside. None of
them breaks a caller.

### Item 4 — the error response is HTTP 400 / 500, not 200 with a flag

The checklist asks for errors at HTTP 200 with `success: false`. This project returns
**400** for bad input and **500** for a runtime failure, with the checklist's *body*
shape (`success`, `error`, `code`, `timestamp`).

Three reasons. Correct status codes are what make failures visible to HTTP-level
monitoring — a 200 hides every error from every uptime check and rate alarm. The 400
has been verified in production repeatedly and `app/api/audit/route.ts` deliberately
passes the upstream status through so the client can distinguish *"you sent something
invalid"* from *"the engine broke"*. And returning 200 for a failed audit in a
compliance product invites a caller to treat the absence of findings as a clean
result.

### Item 4 / #15 — the success response is not wrapped in `data`

The checklist wants `{success, data, metadata}`. The success response keeps its
**flat** shape.

`components/audit-console.tsx`, `components/audit-report.tsx` and `lib/audit-types.ts`
all read `result.status`, `result.deficiencies` and so on. Wrapping would break the
dashboard, and — more sharply — **Vercel auto-deploys on merge while a workflow
re-import is manual**, so there is necessarily a window where the app and the workflow
disagree about the envelope. That window is a broken product.

Available later as a coordinated change: add the envelope, have the app accept both
shapes, deploy, re-import, then remove the old reader. Not worth it before there is a
second consumer of the response.

### Item 2 — `LOG_Audit` uses `continueRegularOutput`, not `continueErrorOutput`

The checklist says Postgres nodes must use `continueErrorOutput`. `LOG_Audit`
deliberately does not, and this is §7.3: a database outage must **not** suppress a
CRITICAL alert. With `continueErrorOutput` the item would route to `ERROR_Handler` and
the alert would never fire — a blocked fire exit unreported because a database
blinked.

`continueRegularOutput` already guarantees the path reaches a responder, which is item
2's *stated purpose*: *"error paths must always lead to a Respond to Webhook node."*
`SHAPE_Response` sets `persisted: false`, the dashboard renders it, and the alert body
says so outright. It satisfies the requirement's intent more completely than its
letter.

The same reasoning applies to `Vision_Fallback`: `continueRegularOutput` lets
`PARSE_Response` derive a `SYSTEM_ERROR` verdict that is still logged and still
alerted, rather than discarding the audit.

### Item 5 — the Error Handler is a Code node, not a Set node

Following the hard-won rule in the same document: *Set node assignments sometimes
render empty in the n8n UI after import even when the JSON looks correct.*

Survivable in a content pipeline. In the one node responsible for reporting failures
it would mean silently reporting nothing — the worst possible node to carry that bug.
A Code node's body is either present or a syntax error, and the test suite asserts
byte equality between the JSON and `scripts/nodes/shared_error_handler.js`.

### Pre-return #9 — India ships `active: true`

The checklist says `active` must be `false`. `AI_Field_Audit_v2.json` ships `true`
because it **is** live: shipping `false` risks a re-import silently taking India
audits down, which is a worse failure than the one the rule prevents. US and History
ship `false`. Asserted per region so neither can drift.

### Item 3 — retries exceed the stated minimums

The checklist says HTTP `maxTries: 2` and database `maxTries: 2`. The primary vision
call uses 3 and `LOG_Audit` uses 3. Treated as a floor rather than a ceiling; reducing
them would make the system less resilient for no benefit.

---

## Open

### Item 6 — execution logging

**Not implemented.** No `execution_id`, tokens, cost or `response_time_ms` is
recorded anywhere. `LOG_Audit` writes the *domain* record, which is a different thing.

Deliberately deferred rather than forgotten, because the table overlaps almost exactly
with the `usage_counters` work for subscription billing — **tokens and cost per audit
are the quota and the unit economics.** Designing it once for both beats building it
twice.

The data is already flowing: the OpenRouter envelope returns
`usage.prompt_tokens` / `usage.completion_tokens`, and `VALIDATE_Input` already mints
`received_at`, which gives `response_time_ms` for free.

### Alert-delivery failure is not visible to the caller

A `SEND_Telegram` failure now retries twice and no longer aborts the run — but it
happens *after* the response has been sent, and n8n permits one response per
execution. So it cannot be reported to the caller, and is currently only visible in
the n8n execution list.

This is the correct trade: routing it to `RESPOND_Error` would raise *"Webhook
response already sent"* and convert a lost Telegram message into a failed execution.
Surfacing it properly belongs to item 6, which will record `alert_sent` per channel.

---

## Layer 2 — the shared asynchronous handler

All three workflows set:

```json
"settings": { "errorWorkflow": "iLRmjyuk5mq1hqkB" }
```

That is the `Error_Handler` workflow owned by **`agentic-dev-stack`**, reused
unmodified. It is **not** copied into this repository — two copies of an error handler
diverging is the problem `record_signoff()` already taught us, and it is maintained at
its source (fixes for the diagnosis-write bug, the mass-overwrite bug, the LLM-outage
crash and the Slack/branding issues landed in that repo's PR #737).

n8n invokes it on any **unhandled** failure, including ones no in-workflow path can
reach. It logs to `error_log`, asks an LLM to diagnose, and alerts on three channels.

### ⚠️ Why the Error Workflow field looked blank — the import was NOT the cause

**An earlier version of this section blamed the import. That was wrong twice over, and
the record is kept here because the wrong diagnosis cost three rounds of testing.**

The field rendered blank in all three workflows, and the actual cause was in the
*target*: `Error_Handler`'s only trigger was an `executeWorkflowTrigger` that somebody
had **renamed** to "Error Trigger". n8n populates Settings → Error Workflow by scanning
for a node of *type* `n8n-nodes-base.errorTrigger`, so `Error_Handler` was never in the
list, and the UI cannot display a selection that is not in the list it just built.

The id *was* stored in `settings.errorWorkflow` the whole time. So Layer 2 was
**configured and silently doing nothing**, which is strictly worse than being
unconfigured, because everything looked wired.

Tell the two node types apart in the n8n UI by the Parameters panel: a real Error
Trigger has **no parameters**, while `Input data mode: Accept all data` is
`executeWorkflowTrigger`'s `inputSource: passthrough`.

Fixed in `agentic-dev-stack` **PR #745**, which *adds* a real `errorTrigger`
(`ERROR_Trigger_Native`) alongside the sub-workflow trigger rather than replacing it —
94 workflows call `Error_Handler` through the `executeWorkflow` path, including
`CALL_ErrorHandler` below.

🔴 **Do not open Workflow Settings and re-save to "fix" a blank field.** A blank
selection can be written back and wipe a working id.

The general lesson stands even though this instance was not an import problem: **a
structural assertion on a committed artifact cannot prove anything about the live
system.**

### 🔴 Layer 2 alone alerts nobody — n8n only runs it on a FAILED execution

n8n invokes `settings.errorWorkflow` only when an execution ends in status *error*. A
node with `onError: continueErrorOutput` whose error branch completes leaves the
execution **successful**.

Every pre-response node in all three workflows routes its error output to
`ERROR_Handler`. So **every failure these workflows are designed to survive ends as a
successful execution, and Layer 2 is never invoked for any of them.**

Measured on the live India workflow, the only *reachable* nodes that can fail uncaught
are:

| Node | Type | Can it realistically fail? |
|---|---|---|
| `Webhook` | webhook | payload limits |
| `ROUTE_Validation`, `IF_NonCompliant` | switch / if | rarely |
| `Respond_to_Webhook1`, `RESPOND_BadRequest`, `RESPOND_Error` | respondToWebhook | rarely |
| `ERROR_Handler` | code | backstop if the handler itself dies |

`DOWNLOAD_Image` and `EXTRACT_Base64` — the two genuinely likely failure points — are
both **disabled and orphaned**, so they can never run. An earlier draft of this
document listed them as Layer 2's realistic coverage; that was a reading of node
settings without checking reachability.

**Two further traps when testing this:**

- Error workflows do **not** fire on *manual* executions, only production ones. The
  editor's Execute button and the `/webhook-test/...` URL both count as manual.
- A forced `throw` in `SHAPE_Response` is *caught*, so it will never trigger Layer 2.
  That is correct behaviour, not a bug.

### Layer 2b — `CALL_ErrorHandler`, which is what actually alerts (Part B)

Because of the above, the error path used to end at the caller:

```
ERROR_Handler -> RESPOND_Error -> nothing
```

A vision outage, a parse drift, a database outage or a validator crash produced a clean
HTTP 500 for whoever was using the dashboard and **total silence for the operator** —
no `error_log` row, no Telegram, no Slack. All three workflows now end:

```
ERROR_Handler -> RESPOND_Error -> BUILD_ErrorAlert -> CALL_ErrorHandler
```

| Property | Value | Why |
|---|---|---|
| Placement | **downstream of** `RESPOND_Error` | Guarantees the caller is answered first. A second branch off `ERROR_Handler` would be ordered by n8n's execution-order heuristics, and correctness that depends on canvas position is not correctness. |
| `waitForSubWorkflow` | `false` | The diagnosis takes 10–30 s. Waiting would hold this execution and a worker slot open long after the caller was answered. |
| `onError` | `continueRegularOutput` | A hard failure here would end the execution in status *error* **after** responding, which would then fire the native trigger and log the failure as `CALL_ErrorHandler`, masking the real error. |
| `retryOnFail` | **explicitly `false`** | `POST_RESPONSE_TOLERANT` sets retry for a transient Telegram 429. A retried `CALL_ErrorHandler` re-runs the LLM diagnosis and all three alert nodes → two `error_log` rows and two Telegram messages for one failure. |
| Outgoing connections | **none** | One response per execution; nothing downstream may be a responder. |
| `RESPOND_Error.alwaysOutputData` | `true` | What a `respondToWebhook` node emits is not assumed anywhere in this repo. This guarantees an item so the chain cannot silently stall. |

`BUILD_ErrorAlert` reads `$('ERROR_Handler')` **by name, not `$json`** — so it does not
matter what `RESPOND_Error` passes through. That is the same class of bug that made
`audit_id` come back `null` on the first live error test, when `ERROR_Handler` read
`$json` and received `LOG_Audit`'s row echo.

It maps identity onto `error_log`'s generic columns:

| `error_log` column | Source | India example |
|---|---|---|
| `run_id` | `audit_id` | `FA-IN-20260906-0538023E-L2JQH` |
| `client_id` | `site_id` | `SITE-MUM-563` |
| `execution_url` | `$workflow.id` + `$execution.id` | link straight to the failed run |

History has neither, and honestly reports `unknown` rather than inventing an
identifier. The resulting alert reads `Source: executeWorkflow`, which distinguishes a
*caught* failure something chose to report from an *uncaught* crash
(`Source: errorTrigger`).

`shared_error_alert.js` is **one file used verbatim by all three workflows**, for the
same reason `shared_error_handler.js` is. `test_production_ready.mjs` executes it and
asserts the emitted **key set** exactly matches what `GENERATE_ErrorID` reads — a field
named even slightly wrong does not error, it silently logs `unknown`, which is the
failure mode this whole workstream began with.

### Why it is not called inline

It makes an LLM diagnosis call. On the response path that would cost the caller 10–30
seconds against a 240 s `AUDIT_TIMEOUT_MS`, converting a clean error into a proxy
timeout. It would also fail in the exact case it is most needed, since OpenRouter
going down is the most likely failure in this system. And a ten-minute vision outage
means a hundred failed audits, so a per-error LLM call scales its cost with the size
of the outage.

**So: respond synchronously and cheaply in-workflow; diagnose asynchronously
afterwards.** The two halves are complementary, not alternatives — the checklist's
item 5 handler exists to answer the *caller*, and the shared workflow exists to inform
the *operator*.

### The one rule that must not be broken

`ERROR_Handler` is reached only from nodes on the path **before** the caller has been
answered. Nodes on the notification branch — `SEND_Telegram`, `SEND_Slack`,
`SEND_Email`, `CREATE_WorkOrder`, `NOTIFY_OpsManager` — carry
`onError: continueRegularOutput` and reach **no** responder.

n8n permits one response per execution. A notifier failing after
`Respond_to_Webhook` already answered would reach `RESPOND_Error` and n8n would throw
*"Webhook response already sent"*, turning a minor problem into a failed run. Two
assertions enforce this in both directions: every pre-response node **can** reach a
responder, and no post-response node **can**.
