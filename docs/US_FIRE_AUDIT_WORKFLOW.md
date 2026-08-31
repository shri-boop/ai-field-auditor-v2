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
      └─ RESOLVE_CodeBasis jurisdiction → fire code, edition, AHJ, OSHA overlay, timezone
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

### A bug this work surfaced

`toLocaleString` **throws** when `dateStyle`/`timeStyle` are combined with
`timeZoneName` — it is a spec violation, not an environment quirk. The first
implementation did exactly that, and the `try/catch` silently degraded every
notification timestamp to a raw UTC ISO string. Caught by
`scripts/test_pipeline.mjs`, not by inspection. Explicit component options are
required to render `PDT` / `EDT` / `MST`.

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

# Run the 85-assertion offline test suite (no n8n, DB or model needed)
node scripts/test_pipeline.mjs

# Regenerate the importable workflow
python3 scripts/build_us_workflow.py

# Verify the committed JSON matches the sources
python3 scripts/build_us_workflow.py --check
```

`AI_Field_Audit_US.json` is a **build artifact**. Edit `scripts/nodes/*.js` and
regenerate; do not hand-edit the JSON, or the next build will overwrite you.

The test harness loads each Code node with `new Function('$input','$','$env', src)`
and chains them with mocked model responses, so verdict logic, JSON repair,
escaping, timezones and the DB projection are all covered offline.

---

## 8. Frontend wiring (not yet done)

`app/page.tsx` still points at the India webhook and hardcodes NBC 2016 copy. The
US workflow is response-compatible, so the minimum change is the URL:

```ts
const WEBHOOK_URL = 'https://n8n.arvamisolutionz.com/webhook/audit-field-photo-us';
```

To make it genuinely useful, add:

1. A **jurisdiction selector** (`CA`, `FL`, `TX`, `NY-NYC`, …) posted as `jurisdiction`.
2. Replace the two hardcoded NBC strings — `"Running NBC 2016 compliance checks"`
   and `"Equipment meets all NBC 2016 and CFO Mumbai norms"` — with
   `code_basis.fire_code` from the response.
3. Render `deficiencies[]` (severity badge + citation + remediation) instead of
   flat `violations[]` strings.
4. Surface `advisory_only` / `signoff_status` so no one mistakes the screen for a
   certified inspection.
5. Show `unverifiable_items` — it is the honest boundary of the automated pass.
6. Use `local_timestamp` rather than re-formatting with `en-IN`.

Left out of this change deliberately: the repo is v0-linked and v0 pushes commits
to `main` directly, so unrequested UI edits risk collision.

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
  `signoff_by`, `signoff_at`); the interface does not.
- **SQL is unverified against a live server** — no Postgres was available in the
  authoring environment. It is reviewed and column-consistency is enforced by
  test, but run it against staging first.
