# AQUILA IND — NBC 2016 / CFO Mumbai Field Audit Workflow

Companion to the US workflow (`AI_Field_Audit_US.json`, IFC / NFPA — see
[US_FIRE_AUDIT_WORKFLOW.md](US_FIRE_AUDIT_WORKFLOW.md)).
This document covers `AI_Field_Audit_v2.json`.

- **Workflow name:** `AI_Field_Audit_V2_URL_To_Base64`
- **Webhook:** `POST /webhook/audit-field-photov2`
- **Table:** `field_audit_logs`
- **Code basis:** NBC 2016 + CFO Mumbai norms, **hardcoded in the prompt**
- **Source of truth:** the JSON itself — this workflow is **hand-maintained**,
  not generated

---

## 1. Read this first: the two workflows are not siblings

It is tempting to treat India and US as mirror images. They are not, and most
confusion about this project comes from assuming otherwise.

| | India (`v2`) | US |
|---|---|---|
| Origin | the original build, evolved in place | designed from scratch afterwards |
| Code basis | one hardcoded prompt string | runtime registry, 9 jurisdictions |
| Maintenance | hand-edited JSON | build artifact from `scripts/nodes/*.js` |
| Nodes | 14 (2 orphaned) | 23 |
| Test coverage | **none** | 106 offline assertions |
| Status derivation | **the model's own `status` is trusted verbatim** | derived in code from severity counts |
| Findings model | flat list of strings | CRITICAL / MAJOR / MINOR with SLA + citation |
| Input validation | throws on missing `image_url` | full schema + SSRF guard, structured HTTP 400 |
| DB write failure | **aborts the run** | `continueRegularOutput`, reports `persisted: false` |
| Model resilience | single model, no timeout, no retry | timeout + retries + second-model fallback |
| `violations` storage | stringified JSON in a `text` column | `jsonb` + GIN index |
| Primary key | `id` (integer serial) | `audit_id` (minted text) |
| `audit_timestamp` type | **`text`** | `timestamptz` |

Section 3 of the US document enumerates all thirteen differences and why each one
mattered. **India has none of those improvements.** It works, it is in production,
and it is materially less robust than the US path.

---

## 2. Pipeline

```
Webhook
  └─ PARSE_Input            image_url + site_id + asset_tag + inspector_id
      └─ BUILD_Vision_Payload    hardcoded NBC 2016 / CFO Mumbai prompt
          └─ Claude_Vision_API   anthropic/claude-sonnet-4-5, no timeout, no retry
              └─ PARSE_Response  model's status trusted as-is
                  └─ LOG_Audit   -> field_audit_logs   (failure ABORTS the run)
                      └─ IF_NonCompliant
                           ├─ true  → NOTIFY_OpsManager → SEND_Slack + SEND_Telegram
                           └─ false → Respond_to_Webhook1
```

`DOWNLOAD_Image → EXTRACT_Base64` is an **orphaned pair**, left from an earlier
base64 approach that the workflow name still advertises. Both are disabled and
neither is in the executing chain. Left alone deliberately — removing them is
cosmetic and re-importing the workflow carries more risk than the tidiness is
worth.

---

## 3. The checklist

Eight checks, all inside one hardcoded prompt string in `BUILD_Vision_Payload`:

1. Pressure gauge needle in the green zone
2. Safety pin intact and sealed with a tamper tag
3. **ISI mark** visible on the cylinder body
4. Hose reel glass unbroken
5. Expiry date not passed
6. No physical damage — dents, rust, corrosion
7. Correctly mounted at the correct height
8. Inspection tag present and current

Two consequences worth knowing:

- **ISI is the India-specific marking.** The US prompt explicitly forbids looking
  for it and teaches the analogue (UL Listing / FM Approval). Feeding an Indian
  extinguisher to the US workflow correctly reports "no UL/FM mark" — technically
  right, and a poor demo.
- **There is no equipment classification.** The prompt assumes an extinguisher or
  hose reel. The US workflow has nine equipment classes and either classifies or
  takes a hint; India has one implicit class.

---

## 4. API

### Request

```http
POST /webhook/audit-field-photov2
Content-Type: application/json
```

```json
{
  "image_url": "https://<id>.public.blob.vercel-storage.com/photo.jpg",
  "site_id": "SITE-MUM-401",
  "asset_tag": "EXT-401-02",
  "inspector_id": "TECH-8891"
}
```

`image_url` is the only required field. `asset_tag` and `inspector_id` were added
with migration 003 (see §6).

**No SSRF guard.** Unlike the US workflow, `image_url` is accepted as given and
handed to OpenRouter. There is no scheme check, no host allow-list and no
private-range refusal. See §7.4.

### Response (HTTP 200)

```json
{
  "equipment_type": "Dry Powder Type Fire Extinguisher",
  "status": "NON-COMPLIANT",
  "confidence": "HIGH",
  "observations": "…",
  "violations": ["ISI mark not clearly visible on cylinder body", "…"],
  "site_id": "SITE-BAN-502",
  "asset_tag": "EXT-401-02",
  "inspector_id": "TECH-8891",
  "image_url": "https://…",
  "audit_timestamp": "2026-09-03T08:52:37.169Z"
}
```

`status` and `confidence` are whatever the model returned. Nothing validates them
against an enumeration, so a model revision that starts emitting "PARTIAL" or
"PASS" would flow straight through `IF_NonCompliant` and into the database.

### Failure

There is no structured error path. A missing `image_url` **throws**, which aborts
the execution before `Respond_to_Webhook1` — so the caller receives an empty body
with no explanation. The US workflow's `RESPOND_BadRequest` exists precisely
because of this.

---

## 5. Database — `field_audit_logs`

Created ad hoc; there is no `CREATE TABLE` for it in this repo. Confirmed shape:

```
 id              integer  PRIMARY KEY  (field_audit_logs_pkey)
 equipment_type  text
 status          text
 confidence      text
 observations    text
 violations      text          -- a stringified JSON array
 site_id         text
 audit_timestamp text          -- NOT a timestamp type
 created_at      timestamptz   DEFAULT now()
 asset_tag       text          -- migration 003
 inspector_id    text          -- migration 003
 image_url       text          -- migration 003
```

Two quirks that shape every query against it:

**`audit_timestamp` is `text`.** Postgres has no `text >= timestamptz` operator, so
range filtering it against a typed parameter raises `operator does not exist`. The
records lookup therefore filters and orders on `created_at`, a real `timestamptz`
written by `DEFAULT now()` in the same statement. `audit_timestamp` is still
returned, because it is what the record should display.

Ordering by the text column was not erroring — it only looked correct because every
value happens to be a fixed-width ISO-8601 `Z` string, which makes lexicographic
order match chronological order. True today, silently wrong the first time anything
writes a different format.

**`violations` is stringified JSON in a `text` column.** Every reader has to parse
it, and unparseable text is kept as a single finding rather than dropped — losing a
violation line is not an acceptable failure mode.

### Migrations

- `002_field_audit_logs_index.sql` — `(site_id, created_at DESC)` and
  `(created_at DESC)`. The table previously carried only its primary-key index, so
  a site lookup was a sequential scan plus a sort.
- `003_field_audit_logs_parity.sql` — adds `asset_tag`, `inspector_id`,
  `image_url` and a partial index on `asset_tag`.

Both are fully guarded: they verify the table and each column first and skip
cleanly, because that table's shape cannot be proved from source control.

**Rows written before `003` have NULL in all three columns.** There is no backfill
and cannot be — the values were never captured. An older India record shows no
evidence photo and no asset tag.

---

## 6. Editing this workflow

`AI_Field_Audit_v2.json` is **hand-maintained**, not generated. Non-trivial edits
go through:

```bash
python3 scripts/patch_india_workflow.py        # idempotent
```

The script threads `asset_tag`, `inspector_id` and `image_url` from the request
through `PARSE_Input` → `PARSE_Response` → `LOG_Audit`, and sets the Gmail
recipient. It asserts `LOG_Audit` still targets `field_audit_logs` before writing,
since pointing it at the US table would corrupt a differently-shaped one.

`BUILD_Vision_Payload` is deliberately untouched: `PARSE_Response` reads straight
from `$('PARSE_Input')`, which n8n resolves by node name wherever it sits in the
chain, so the payload builder keeps its narrow contract.

### Re-importing into n8n

⚠️ **Update the existing workflow. Do not import a second copy.** Two workflows
registering `/webhook/audit-field-photov2` will conflict and India audits break.

The file carries `"active": true`, matching production — confirm it is still active
after the import.

---

## 7. Roadmap — next phases

India's roadmap is mostly **catching up to the US workflow**, and the ordering
below reflects risk, not effort.

### 7.1 Trust the code, not the model, for `status`

**Highest priority.** `PARSE_Response` writes whatever the model put in `status`
straight into the database, and `IF_NonCompliant` branches on it. The verdict that
triggers escalation is therefore neither reviewable nor stable across model
versions. A model revision that returns "PASS" instead of "COMPLIANT" would route
every audit down the compliant branch and no alert would fire.

The US workflow derives status in code from severity counts for exactly this
reason. Porting that needs a severity model (7.2) first.

### 7.2 A severity model

India returns a flat list of violation strings. "ISI mark not visible" and "gauge
in the red zone" are not the same finding, and both currently produce an
undifferentiated `NON-COMPLIANT`. The US workflow's CRITICAL / MAJOR / MINOR tiers
with per-tier SLA (0 h / 72 h / 30 d) and clause citations are what make a report
actionable.

This is the largest single change and would make the two regions comparable for the
first time.

### 7.3 Do not let a DB failure swallow a finding

`LOG_Audit` has no `onError`, so a Postgres outage aborts the execution — the alert
is never sent and the caller gets an empty body. A blocked fire exit would go
unreported because a database was briefly unavailable.

The US workflow uses `continueRegularOutput` and reports `persisted: false`, which
the UI already renders. One-line fix, disproportionate benefit.

### 7.4 SSRF guard on `image_url`

`image_url` is caller-controlled and dereferenced by a third party (OpenRouter).
India accepts anything. `scripts/nodes/01_validate_input.js` has the US
implementation: https-only, host allow-list, no userinfo, no IP literals, no
private ranges.

### 7.5 Structured errors instead of throwing

Add the equivalent of `VALIDATE_Input` + `ROUTE_Validation` +
`RESPOND_BadRequest`, so a malformed request gets an HTTP 400 with a reason
instead of an empty body — and never reaches the vision model, so bad input costs
nothing.

### 7.6 Resilience

No timeout, no retries, no fallback model. One provider incident drops the audit.
The US workflow allows 120 s with 3 retries and falls back to GPT-4o.

### 7.7 Offline tests

There are none. The US workflow has 106 assertions that run without n8n, a
database or a model call, and they have caught real bugs — including a sandbox
incompatibility that had passed 85/85 under a friendlier harness. Every change to
India is currently unverifiable except by running it in production.

### 7.8 Governance parity

See **[SIGNOFF_DESIGN.md](SIGNOFF_DESIGN.md)** §13.5 — that proposal is
Florida-shaped, and whether India needs sign-off at all is an open question. CFO
Mumbai licensing is a different regime, so the credential enumeration would not
transfer.


India returns no `advisory_only`, no `certification_eligible`, no
`unverifiable_items`, no sign-off columns. The UI supplies `advisory_only: true`
for IND so the disclaimer still shows, but the workflow itself makes no such
statement, and there is no equivalent of the US table's
`signoff_status` / `signoff_by` / `signoff_at`.

### 7.9 Shared with the US workflow

These are not India-specific — see the US document for detail:

- **Authenticate the webhook.** `/webhook/audit-field-photov2` has
  `authentication: NONE`, so anyone with the URL can run audits and spend model
  credits. `/webhook/audit-history` already uses Header Auth and is the pattern.
- **Email alerts.** The Gmail node ships disabled. Its recipient was a hardcoded
  personal address and now resolves from
  `{{ $env.AUDIT_ALERT_EMAIL_TO || 'alerts@kratuailabs.com' }}`, so the worst case
  is a company inbox rather than a person. Set `AUDIT_ALERT_EMAIL_TO` per
  deployment before enabling.
- **Sign-off.** No write path exists in either region.
- **Server-generated PDF.**

---

## 8. Current state

| Capability | State |
|---|---|
| NBC 2016 / CFO Mumbai audit | ✅ live |
| Persistence to `field_audit_logs` | ✅ live |
| Records: search, open, print | ✅ live |
| Asset tag / inspector / evidence photo | ✅ live **after** migration 003 + re-import |
| Slack + Telegram alerts | ✅ live |
| Printable record | ✅ live — shared renderer with US |
| Email alerts | ⚠️ node ships **disabled** |
| Derived status | ❌ model's `status` trusted verbatim (7.1) |
| Severity tiers | ❌ flat violation strings (7.2) |
| DB failure tolerance | ❌ aborts the run (7.3) |
| SSRF guard | ❌ none (7.4) |
| Structured HTTP 400 | ❌ throws instead (7.5) |
| Timeout / retry / fallback model | ❌ none (7.6) |
| Offline tests | ❌ none (7.7) |
| Sign-off | ❌ no columns, no write path (7.8) |
| Webhook authentication | ❌ open (7.9) |

**Honest summary:** India works and is in production, but it is the older, thinner
implementation. If India becomes commercially significant, 7.1 to 7.3 are the ones
that matter — they are the difference between a system that reports a blocked fire
exit and one that can silently fail to.
