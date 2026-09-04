# FIREHAWK US — NFPA / IFC Field Audit Workflow

Companion to the India workflow (`AI_Field_Audit_v2.json`, NBC 2016 + CFO Mumbai).
This document covers `AI_Field_Audit_US.json`.

- **Workflow name:** `AI_Field_Audit_US_NFPA_IFC`
- **Webhook:** `POST /webhook/audit-field-photo-us`
- **Table:** `field_audit_us_logs` (new; the India table is untouched)
- **Source of truth:** `scripts/nodes/*.js` → assembled by `scripts/build_us_workflow.py`

---

## 1. Why this is a new workflow and not a prompt swap

The India workflow hardcodes `"You are a strict Fire Safety Compliance Auditor
operating under NBC 2016 and CFO Mumbai norms"` into a string. That works because
India has one national code and one local authority.

The US has no single answer to "which code applies":

| Jurisdiction | Governing fire code | Consequence |
|---|---|---|
| ~41 states, DC, NYC, Guam, PR | **International Fire Code (IFC)**, current edition 2024 | ICC chapter numbering |
| **Florida** | **Florida Fire Prevention Code 8th Ed. (2023)** — Florida editions of NFPA 1 (2021) + NFPA 101 (2021) | NFPA numbering; IFC citations are simply *wrong* here |
| **California** | California Fire Code, Title 24 Part 9 (IFC republication) + Title 19 CCR | Triennial cycle; OSFM licenses extinguisher servicing companies |
| **New York City** | NYC Fire Code (Title 29), FDNY-administered | Home rule; FDNY Certificate of Fitness duties |
| **Massachusetts** | 527 CMR 1.00 (NFPA 1 based) | NFPA numbering |
| **Chicago** | Chicago Fire Prevention Code | Home rule, separate from Illinois |
| Any workplace | **Federal OSHA 29 CFR 1910** Subpart L / E — displaced by a State Plan in 21+ states (Cal/OSHA, MIOSHA, WISHA …) | A second, independently citable authority |

A single hardcoded prompt cannot express this. So **the code basis is data**,
resolved per request by `RESOLVE_CodeBasis`, and the prompt is *rendered* from it.
Adding a jurisdiction is a registry edit — no prompt rewriting, no re-testing of
the audit logic.

Where a jurisdiction is not in the registry, the workflow falls back to the
model-code baseline and **says so** (`code_basis_confident: false`) rather than
silently guessing. Every entry also carries `verified_on` and
`requires_ahj_confirmation`, because code adoption changes and local amendments
routinely override state defaults.

---

## 2. Pipeline

```
Webhook
  └─ VALIDATE_Input        schema + SSRF guard, mint audit_id / idempotency_key
      └─ ROUTE_Validation
           ├─ rejected → RESPOND_BadRequest (HTTP 400, structured reason, no model call)
           └─ ok ↓
          RESOLVE_CodeBasis  jurisdiction → fire code, edition, AHJ, OSHA overlay, timezone
          └─ BUILD_Vision_Payload   render prompt from code basis + checklist registry
              └─ Vision_Primary     Claude Sonnet 4.5, 120 s timeout, 3 retries
                   ├─ ok ──────────────────┐
                   └─ error → Vision_Fallback (GPT-4o, same payload) ─┐
                                                                      ▼
                                            PARSE_And_Score   ← deterministic verdict
                                              └─ SHAPE_DbRow → LOG_Audit (continue-on-error)
                                                   └─ BUILD_Report
                                                        └─ ROUTE_Outcome (5 outputs)
                                                             ├ 0 CRITICAL    Slack+TG+email+work order
                                                             ├ 1 DEFICIENT   Slack+TG+email
                                                             ├ 2 REINSPECT   Telegram only
                                                             ├ 3 COMPLIANT   respond only
                                                             └ 4 SYSTEM_ERROR Slack
                                                                  └─ SHAPE_Response → Respond
```

---

## 3. What changed from v2, and why

| # | v2 (India) behaviour | US workflow | Why it matters |
|---|---|---|---|
| 1 | Code basis hardcoded in the prompt string | Runtime registry keyed by jurisdiction | Correctness. IFC citations are wrong in Florida. |
| 2 | **Model's own `status` is trusted verbatim** | Status **derived** in code from severity counts | The verdict that triggers escalation must be reviewable and stable across model versions. |
| 3 | No severity model — flat list of violation strings | CRITICAL / MAJOR / MINOR with per-tier SLA (0 h / 72 h / 30 d) | US inspection and insurance practice is tiered; "non-compliant" alone is not actionable. |
| 4 | Any `image_url` accepted and handed to a third party | https-only, host allow-list, private-range refusal | SSRF. The URL is caller-controlled and dereferenced by OpenRouter. |
| 5 | `REINSPECT` handled in the notifier but **never produced** by the prompt — dead code | Prompt emits it; confidence/quality gate routes it | Removes an unreachable branch and makes low-quality photos a first-class outcome. |
| 6 | DB write failure aborts the run | `continueRegularOutput` → `persisted: false` on the alert | A Postgres outage must not swallow a blocked fire exit. |
| 7 | Single model, no timeout, no retry | Timeout + retries + second-model fallback | One provider incident shouldn't drop an audit. |
| 8 | `violations` stored as a stringified JSON text column | `jsonb` + GIN index + exploded view | Enables "which checklist item fails most often across the portfolio". |
| 9 | Telegram sent with `parse_mode: HTML` but content unescaped | All dynamic content entity-escaped | Fire-door findings legitimately contain `<1/8 in` and `>3/4 in`, which break the Telegram API. |
| 10 | Timestamps hardcoded to `Asia/Kolkata` | Per-jurisdiction timezone with zone abbreviation | The US spans six zones; Arizona ignores DST. |
| 11 | No audit identity | `audit_id` + `idempotency_key` | Traceability and duplicate detection. |
| 12 | Implies a compliance verdict | `advisory_only`, `certification_eligible: false`, `signoff_status`, `unverifiable_items` | A photograph cannot certify compliance. Florida statutorily reserves firesafety inspections to inspectors certified under s. 633.216, F.S. |
| 13 | Full `$json` returned (incl. email HTML) | Curated response contract | Smaller payload, explicit API surface. |

### Bugs this work surfaced

**1. `toLocaleString` and `timeZoneName`.** Combining `dateStyle`/`timeStyle`
with `timeZoneName` throws — a spec violation, not an environment quirk. The
first implementation did exactly that, and the `try/catch` silently degraded
every notification timestamp to a raw UTC ISO string. Explicit component options
are required to render `PDT` / `EDT` / `MST`.

**2. `new URL(...)` is not available in the n8n Code node.** The Code node runs
in a restricted `vm` context (the task runner) where web globals are not
guaranteed. `new URL(...)` threw a `ReferenceError`, and because it was wrapped
in `try { … } catch { throw 'not a valid absolute URL' }`, **a broken sandbox
looked exactly like bad caller input** — the reported cause pointed at a URL that
was completely valid.

Two rules came out of that, both now enforced by tests:

- Never let a `catch` block conflate "the input is wrong" with "my code cannot
  run here". Distinguish the cases and name them (`IMAGE_URL_MALFORMED` vs a
  genuine runtime failure).
- **Run the test suite under the restricted sandbox, not a friendlier one.**
  `scripts/test_pipeline.mjs` now shadows `URL`, `require`, `process`, `fetch`,
  `Buffer` and friends as `undefined` by default, plus a static grep that fails
  the suite if any node references them. The original suite passed 85/85 while
  the workflow was broken in production, purely because Node provides `URL`
  globally and n8n does not.

---

## 4. Design decisions worth knowing

**Fail-safe escalation.** A `CRITICAL` finding escalates *even at LOW confidence
or POOR image quality*. Precedence is: critical → weak evidence → ordinary
deficiency → clean. A confidence gate must never be able to suppress a
life-safety finding; the cost asymmetry between a false alarm and a missed
blocked exit is not close.

**Severity bias is upward.** An unrecognised severity string normalises to
`MAJOR`, never `MINOR`.

**Only-minor is `CONDITIONAL`, not a fail.** Real inspection reports distinguish
"deficiencies noted" from "failed". Collapsing them trains operators to ignore
alerts.

**The Switch is a dumb demultiplexer.** `route_index` is computed in
`PARSE_And_Score`; the node just switches on it. All business logic stays in one
testable file instead of being split between JS and node UI config.

**Impairment is a distinct workflow.** NFPA 25 Chapter 15 requires a formal
procedure when a water-based system is out of service: impairment tag, evaluate
the need for a fire watch, notify the AHJ *and the insurer*, record start and
restoration. `BUILD_Report` emits that checklist as `impairment_notice` rather
than burying it in prose.

**Honesty about what a photo can't do.** The model must populate
`unverifiable_items` — agent weight, internal shell condition, functional
discharge tests, water flow, audibility. A clean screen returns
`certification_eligible: false` and a `scope_note` stating explicitly that it is
not a certification.

**Terminology.** The prompt forbids NBC 2016 / ISI references and teaches the US
analogue: **UL Listing or FM Approval**.

---

## 5. Checklists

Nine equipment classes, each with per-item severity and citation:

| Key | Governing standard |
|---|---|
| `PORTABLE_FIRE_EXTINGUISHER` | NFPA 10 (2022), IFC 906, 29 CFR 1910.157 |
| `SPRINKLER_SYSTEM` | NFPA 25, NFPA 13 |
| `FIRE_ALARM` | NFPA 72 |
| `KITCHEN_SUPPRESSION` | NFPA 96, NFPA 17A, NFPA 10 (Class K) |
| `MEANS_OF_EGRESS` | NFPA 101 Ch. 7, IFC Ch. 10, 29 CFR 1910.36/.37 |
| `FIRE_DOOR` | NFPA 80 |
| `STANDPIPE_HOSE` | NFPA 25, NFPA 14, NFPA 20 |
| `ELECTRICAL_HOUSEKEEPING` | NFPA 70 (110.26), IFC electrical provisions |
| `EMERGENCY_POWER` | NFPA 110 |

With `equipment_hint` set, only that checklist is sent. With `AUTO`, all are sent
and the model classifies first, then applies one.

> **Edition caveat.** NFPA 10 (2022) was confirmed against the NFPA catalogue.
> The other editions in the registry are marked `edition_verified: false` and are
> surfaced to reviewers via `unverified_standard_editions`. Confirm the editions
> your AHJ has actually adopted before relying on a citation.

---

## 6. API

### Request

```http
POST /webhook/audit-field-photo-us
Content-Type: application/json
```

```json
{
  "image_url": "https://<id>.public.blob.vercel-storage.com/photo.jpg",
  "site_id": "SITE-CA-LAX-014",
  "jurisdiction": "CA",
  "occupancy_type": "MERCANTILE",
  "equipment_hint": "PORTABLE_FIRE_EXTINGUISHER",
  "inspector_id": "TECH-4471",
  "asset_tag": "EXT-014-03",
  "osha_workplace": true
}
```

`image_url` is the only required field.

| Field | Default | Notes |
|---|---|---|
| `jurisdiction` | `US-DEFAULT` | `CA`, `FL`, `NY`, `NY-NYC`, `TX`, `MA`, `WA`, `IL-CHICAGO`. `TX-AUSTIN` → falls back to `TX`; unknown → model-code baseline, flagged. |
| `equipment_hint` | `AUTO` | One of the nine checklist keys. |
| `occupancy_type` | `BUSINESS` | NFPA 101 / IFC occupancy hint. |
| `osha_workplace` | `true` | Set `false` to drop the OSHA overlay. |

**Allow-listed image hosts:** Vercel Blob, S3, Cloudflare R2, Azure Blob, GCS.
Add hosts in `scripts/nodes/01_validate_input.js` (`ALLOWED_IMAGE_HOSTS`).

### Response (HTTP 200)

Backward compatible with the existing dashboard — `status`, `confidence`,
`equipment_type`, `observations`, `violations` (array of strings), `site_id`,
`audit_timestamp` all keep their names and types. Additive fields:

```json
{
  "status": "NON-COMPLIANT",
  "critical": true,
  "risk_score": 100,
  "severity_counts": { "critical": 2, "major": 1, "minor": 0 },
  "audit_id": "FA-US-20260831-2EBA11A3-121XQ",
  "persisted": true,
  "deficiencies": [
    {
      "code": "EXIT_DOOR_LOCKED",
      "severity": "CRITICAL",
      "finding": "Required exit door chained and padlocked through the panic hardware.",
      "observed": "Steel chain and closed padlock threaded through the push bar.",
      "requirement": "Exit doors must be openable from the egress side at all times without a key, tool or special knowledge.",
      "code_reference": "NFPA 101 (2024) 7.2.1; 29 CFR 1910.36(d)",
      "remediation": "Remove the chain and padlock immediately and restore free egress.",
      "verification_needed": false
    }
  ],
  "unverifiable_items": ["Emergency lighting battery duration cannot be tested from a photograph."],
  "impairment_suspected": false,
  "impairment_notice": "SUSPECTED FIRE PROTECTION SYSTEM IMPAIRMENT — ACTION CHECKLIST …",
  "sla_hours": 0,
  "remediation_due_at": "2026-08-31T11:18:00.000Z",
  "local_timestamp": "Aug 31, 2026, 06:18 AM CDT",
  "code_basis": {
    "jurisdiction_resolved": "TX",
    "fire_code": "International Fire Code (IFC) as adopted by the state and by local ordinance",
    "ahj_label": "Local fire marshal; State Fire Marshal's Office for state-regulated occupancies",
    "osha_overlay": "Federal OSHA 29 CFR 1910 — Subpart L …",
    "code_basis_confident": false,
    "requires_ahj_confirmation": true
  },
  "advisory_only": true,
  "certification_eligible": false,
  "requires_licensed_inspector_signoff": true,
  "signoff_status": "PENDING",
  "model_used": "anthropic/claude-sonnet-4-5",
  "latency_ms": 8420
}
```

### Rejected requests (HTTP 400)

Validation failures return a structured body instead of an empty one, and never
reach the vision model — so malformed input costs nothing:

```json
{
  "status": "REJECTED",
  "error_code": "IMAGE_HOST_NOT_ALLOWED",
  "error": "Image host is not allow-listed: evil.example.com. Add it to ALLOWED_IMAGE_HOSTS in VALIDATE_Input if this is intentional.",
  "received_value": "https://evil.example.com/x.png",
  "advisory_only": true
}
```

Codes: `IMAGE_URL_MISSING`, `IMAGE_URL_MALFORMED`, `IMAGE_URL_NOT_HTTPS`,
`IMAGE_URL_HAS_USERINFO`, `IMAGE_URL_NO_HOST`, `IMAGE_URL_IP_LITERAL`,
`IMAGE_HOST_NOT_ALLOWED`, `IMAGE_HOST_PRIVATE`.

### Status values

| `status` | `route_index` | Meaning |
|---|---|---|
| `COMPLIANT` | 3 | Nothing visible. **Not** a certification. |
| `CONDITIONAL` | 1 | Minor/administrative only. |
| `NON-COMPLIANT` | 0 or 1 | 0 when `critical` is true. |
| `REINSPECT` | 2 | Photo inadequate or confidence low. |
| `ERROR` | 4 | Automated pass failed; ops alerted. |

---

## 7. Development

```bash
# Edit the audit logic (real JS, lintable):
#   scripts/nodes/*.js

# Syntax check
for f in scripts/nodes/*.js; do node --check "$f"; done

# Run the 106-assertion offline test suite (no n8n, DB or model needed)
node scripts/test_pipeline.mjs

# Regenerate the importable workflow
python3 scripts/build_us_workflow.py

# Verify the committed JSON matches the sources
python3 scripts/build_us_workflow.py --check
```

`AI_Field_Audit_US.json` is a **build artifact**. Edit `scripts/nodes/*.js` and
regenerate; do not hand-edit the JSON, or the next build will overwrite you.

The harness loads each Code node with `new Function(...)` and chains them with
mocked model responses, so verdict logic, JSON repair, escaping, timezones and
the DB projection are all covered offline. It runs in the **restricted sandbox by
default** — `URL`, `require`, `process`, `fetch` and `Buffer` are shadowed as
`undefined` to match the n8n Code node — and replays the workflow's own pinned
fixture as a regression test.

---

## 8. Frontend wiring

Done. The dashboard serves both regions from one codebase, scoped per
deployment by `ENABLED_REGIONS` (see the README). Relevant files:

| File | Role |
|---|---|
| `lib/regions.ts` | Region registry: webhook path, US option lists, `parseEnabledRegions` |
| `app/api/audit/route.ts` | Server-side proxy. **Enforces** the region allow-list; holds `N8N_BASE_URL` |
| `app/page.tsx` | Server component; resolves enabled regions |
| `components/audit-console.tsx` | Client UI: region switch, US inputs, results |

What the UI now does with the US response:

1. **Jurisdiction selector** (`CA`, `FL`, `TX`, `NY-NYC`, …) plus `occupancy_type`,
   `equipment_hint` and the `osha_workplace` toggle, posted through the proxy.
2. The two hardcoded NBC strings are gone — the status header and the clean-result
   panel both read `code_basis.fire_code`, falling back to region copy only when
   the response carries no code basis (i.e. India).
3. `deficiencies[]` render sorted CRITICAL → MAJOR → MINOR with severity badge,
   observed, requirement, remediation and `code_reference`, followed by a standing
   caveat that clause numbers are model-generated pointers. Flat `violations[]`
   still render for India, and as a fallback if `deficiencies` is empty.
4. `advisory_only` and `signoff_status` show as a banner, with `scope_note`.
5. `unverifiable_items` render under an explicit "cannot be verified from a
   photograph" heading.
6. `local_timestamp` is preferred; `audit_timestamp` is only re-formatted (per
   region locale) when it is absent.
7. `code_basis_confident: false` raises a visible warning that the model-code
   baseline was applied and the AHJ must confirm.
8. `impairment_notice`, `reinspect_reasons`, `risk_score`, `severity_counts`,
   `sla_hours`, `audit_id`, `model_used` and `persisted: false` are all surfaced.

Two implementation notes worth keeping:

- **The proxy introduced an execution limit that did not exist before.** When the
  browser called n8n directly there was no ceiling; a Vercel function has one.
  Observed audits run 11–13 s, but `Vision_Primary` alone allows 120 s plus
  retries plus a fallback model. `route.ts` sets `maxDuration = 300` (Vercel
  clamps to the plan limit — Hobby caps at 60 s) and returns a structured 504
  rather than letting the platform time out opaquely.
- **shadcn's `SelectItem` puts all children inside Radix's `ItemText`**, and Radix
  mirrors `ItemText` into the closed trigger. Two-line items therefore render both
  lines stacked inside the trigger. The jurisdiction and equipment hints are
  rendered as helper text beneath the select instead — which also keeps them
  visible while the list is closed, when they actually matter ("Florida is
  NFPA-based, not IFC").

Still not built: the sign-off UI. `signoff_status` is displayed but read-only;
the columns exist (`signoff_by`, `signoff_at`) and no interface writes them.

---

## 9. Known limitations

- **Editions need confirmation.** Only NFPA 10 (2022) was verified against a
  primary source. Others are flagged, not silently asserted.
- **Registry covers 8 jurisdictions.** Everything else falls back to IFC 2024
  with `code_basis_confident: false`. Timezones cover all 50 states.
- **Timezone is per state, not per site.** States spanning two zones map to the
  predominant one. A `timezone` field on the request would fix this.
- **No image authenticity checks.** No EXIF, GPS or capture-time validation, so
  nothing prevents an old or unrelated photo being submitted.
- **`code_reference` strings are model-generated.** Clause numbers are plausible
  but unverified. They are pointers for a human reviewer, not authority. This is
  why sign-off is mandatory.
- **No sign-off UI.** The schema and columns exist (`signoff_status`,
  `signoff_by`, `signoff_at`); the dashboard displays the status read-only and
  nothing writes it.
- **Region gating is deployment scoping, not authentication.** `ENABLED_REGIONS`
  keeps an India customer off the US workflow because they are served by a
  different Vercel project. It does not identify *who* is using a deployment.
  Anyone with the URL can run an audit. Add customer login before there is more
  than one account per region.
- **No frontend rate limiting.** `/api/upload` accepts any image and `/api/audit`
  will forward it, so an unauthenticated caller can spend model credits.
---

## 10. Current state

Verified working in production as of 2026-09-04.

| Capability | State |
|---|---|
| Jurisdiction-resolved audit (9 jurisdictions) | ✅ live — verified on Florida, citing FFPC / NFPA 1 / NFPA 101 with no IFC chapters |
| Vision fallback (Sonnet 4.5 → GPT-4o) | ✅ live |
| Persistence to `field_audit_us_logs` | ✅ live |
| Region switch, scoped per deployment | ✅ live (`ENABLED_REGIONS`) |
| Records: search, open, print | ✅ live |
| Printable record (Ctrl+P → PDF) | ✅ live — ink letterhead, evidence plate, sign-off block |
| Filename from record identity | ✅ live |
| Basic auth over app + API | ✅ live, opt-in via `AUDIT_ACCESS_*` |
| Prior-audit context on site entry | ✅ live |
| Slack + Telegram alerts | ✅ live |
| Email alerts | ⚠️ node ships **disabled** — see 11.2 |
| Work order / CMMS push | ⚠️ node ships **disabled** — see 11.3 |
| Sign-off (`signoff_by` / `signoff_at`) | ❌ **no write path exists** — see 11.1 |
| Server-generated PDF | ❌ not built |
| n8n webhook authentication | ❌ **audit webhooks are open** — see 11.4 |

---

## 11. Roadmap — next phases

Ordered by what a US buyer's compliance process will actually ask for.

### 11.1 Sign-off — the one that changes what this product *is*

**Priority: highest.** Everything else is polish by comparison.

`signoff_status` is written as `PENDING` at insert and never changes. `signoff_by`,
`signoff_at` and `signoff_notes` exist in migration 001, are read by the history
workflow, and render on the printed record when populated — but **nothing can
populate them.** The history workflow is `SELECT`-only, asserted by test, and there
is no other write path. Those columns are plumbed end-to-end for reading and are
structurally incapable of being filled.

This is what turns the product from *advisory screening* into a *defensible
record*, and it is a different order of work from everything so far. It needs four
things, none of which exist:

1. **Identity — real accounts, not a shared credential.** Access today is one
   HTTP Basic credential per deployment. `KRATU_2026_FIREAUDIT` is not a person and
   holds no licence. A signature that resolves to a shared credential is worthless,
   and worse than worthless in Florida, where firesafety inspections are reserved
   to inspectors certified under s. 633.216, F.S.
2. **A write endpoint.** The first write path in the system. Vercel cannot reach
   Postgres — it has no `ports:` mapping and should not get one — so this means a
   new n8n workflow performing a scoped `UPDATE`, reached through a proxy route,
   mirroring how `/api/history` reads.
3. **An audit trail of who signed what.** A sign-off that can be silently
   overwritten is not a sign-off. `signoff_status` already has a `SUPERSEDED` state
   in its CHECK constraint, which is the hook for this.
4. **A sign-off UI**, including capture of the reviewer's licence or certification
   number — the field a printed record currently leaves as a ruled line.

**Open architectural decision:** where the user store lives. The n8n Postgres
(consistent with everything else, but every read becomes a workflow), a separate
managed Postgres reachable from Vercel (simpler app code, second database to
operate), or a hosted identity provider (fastest to correct, adds a dependency and
a per-seat cost). This needs deciding before any of it is built.

### 11.2 Email alerts — recipient fixed, node still disabled

`SEND_Email` was hardcoded to a personal Gmail address. **The node ships
`disabled: true`, so nothing was ever sent there** — but enabling it in a hurry
would have routed a customer's fire-safety findings to an individual's mailbox.

The recipient now resolves from the n8n environment with a role-address fallback:

```
={{ $env.AUDIT_ALERT_EMAIL_TO || 'alerts@kratuailabs.com' }}
```

So the worst case is a company inbox, never a person. Deliberately **not** taken
from the request body: the audit webhook is unauthenticated (11.4), so a
caller-supplied recipient would make it an open email relay on our Gmail
credential.

Remaining before enabling:
- Set `AUDIT_ALERT_EMAIL_TO` on the n8n container per deployment, so a US
  customer's alerts reach *their* distribution list.
- Agree the distribution list — a CRITICAL finding email is an escalation, and who
  receives it is a contractual question, not a technical one.
- Verify the Gmail credential's sending domain is SPF/DKIM-aligned, or these land
  in spam and the escalation silently fails.
- Decide whether the report PDF should be attached. Today the body is an alert, not
  a report; attaching one requires 11.5.

### 11.3 Work order / CMMS integration — seam exists, target does not

`CREATE_WorkOrder` posts a P1 payload (`external_id`, `site_id`, asset, summary,
`impairment_notice`, `due_at`, `risk_score`) to
`{{ $env.FIREHAWK_WORKORDER_WEBHOOK }}` on the CRITICAL route only. It ships
`disabled: true`.

Note that if it were enabled with that variable unset, the URL would be empty and
the request would fail — and `onError: continueRegularOutput` means it would fail
**silently**, so a blocked fire exit would raise no work order and no error. Do not
enable it without confirming the target responds.

Remaining:
- Choose the target system (ServiceNow, Salesforce Field Service, Maximo,
  ServiceTrade, Inspect Point) — this is a customer-driven choice, not ours.
- Map severity to that system's priority scheme; `P1` is a placeholder.
- Add idempotency so a retried audit does not open duplicate work orders.
  `audit_id` is already passed as `external_id` for exactly this.
- Replace silent failure with a real error path once a target exists.

### 11.4 Authenticate the n8n audit webhooks

**The live gap.** `/webhook/audit-field-photo-us` and `/webhook/audit-field-photov2`
have `authentication: NONE`. The Basic auth added to the app protects the *app*,
not the *engine* — anyone who learns a webhook URL can run audits directly, and
every audit is a paid vision call.

`/webhook/audit-history` already uses Header Auth and is the pattern to copy: an
`httpHeaderAuth` credential on the webhook, the secret injected server-side by the
proxy route, never reaching the browser.

### 11.5 Server-generated PDF

Browser print covers the everyday case. A generated PDF (`@react-pdf/renderer`
behind `/api/report`) would allow a report for any `audit_id` without a browser —
which is what emailing a report, attaching one to a work order, or bulk-generating
for a portfolio all require. Deliberately deferred until retrieval existed; it now
does.

### 11.6 Smaller, still open

- **Editions need confirmation.** Only NFPA 10 (2022) verified against a primary
  source; the rest are flagged, not silently asserted.
- **Registry covers 9 jurisdictions.** Everything else falls back to IFC 2024 with
  `code_basis_confident: false`.
- **Timezone is per state, not per site.** A `timezone` field on the request would
  fix it.
- **No image authenticity checks** — no EXIF, GPS or capture-time validation, so
  nothing prevents an old or unrelated photo.
- **`code_reference` strings are model-generated** — plausible but unverified
  clause numbers. Pointers for a reviewer, not authority. This is precisely why
  11.1 matters.
- **No rate limiting** on `/api/upload` or `/api/audit`.
- **Vercel Blob URLs are public and permanent.** Fine for a demo; a client should
  use their own bucket. The SSRF allow-list already accepts S3, R2, Azure and GCS,
  and presigned URLs pass, so no code change is needed.
- **`AI_Field_Audit.json` is dead** — the original 9-node prototype, referenced by
  nothing.

---

## 12. Known limitations (design, not backlog)

These are consequences of the approach rather than things to fix.

- **A photograph cannot certify compliance.** `advisory_only: true`,
  `certification_eligible: false` and `unverifiable_items` are the honest boundary,
  not a placeholder for a future feature.
- **Region gating is deployment scoping, not authentication.** `ENABLED_REGIONS`
  keeps an India customer off the US workflow because they are served by a
  different Vercel project. It does not identify *who* is using a deployment.
- **`impairment_notice` and `scope_note` are not persisted.** Both are composed at
  audit time, so a retrieved record shows the impairment basis but not the full
  NFPA 25 Ch. 15 checklist. The record says so rather than implying no action was
  required.
- **SQL was authored without a live server.** Column consistency is enforced by
  test; `001` and `002` have since been applied successfully.
