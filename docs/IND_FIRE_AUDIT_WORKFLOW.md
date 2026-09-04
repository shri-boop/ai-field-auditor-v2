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

### 7.9 Sign-off in Maharashtra is Form B — and it is a stronger hook than the US case

Researched so this is written down before anyone builds it. **Nothing here is built.**

The US design ([SIGNOFF_DESIGN.md](SIGNOFF_DESIGN.md)) is built around a reviewer
concurring with a screening. Maharashtra is different, and in one respect better:
there is already a **statutory artefact with a statutory deadline**, so sign-off has
somewhere to go.

| Concept | Maharashtra / Mumbai |
|---|---|
| Governing statute | **Maharashtra Fire Prevention and Life Safety Measures Act 2006**, with the **Rules 2009** |
| Technical code | **NBC 2016 Part 4** — recommendatory until adopted; the Act is what makes it enforceable |
| Authority (AHJ) | **Chief Fire Officer** of the Municipal Corporation — MCGM for Brihanmumbai |
| Who may certify | a **Licensed Agency**, licensed by the Director of Maharashtra Fire Services, in categories by scope of work |
| The artefact | **Form B** — the fire safety compliance certificate |
| Cadence | **half-yearly, January and July** — an owner/occupier duty under the Act |
| Equipment basis | **IS 2190** (selection, installation and maintenance of portable extinguishers), **IS 15683** (specification), ISI mark under BIS |
| Individual qualification | typically a fire engineer employed by the Licensed Agency — B.E./Diploma in Fire Engineering, **NFSC Nagpur**, or Institution of Fire Engineers (India) |

Three consequences for the design:

**1. The credential is a firm licence, not an individual certification.** In Florida
the individual holds a permit and the dealer holds another. In Maharashtra the
**Licensed Agency** is the licensed entity, and the signing engineer's standing comes
from qualification rather than a personal licence number. The credential model must
therefore accommodate *qualification-based* credentials, not only numbered licences.

**2. The cadence is calendar, not SLA.** The US model runs on remediation SLAs
(0 h / 72 h / 30 d). An Indian owner thinks in **Form B periods** — H1 (January) and
H2 (July). A sign-off queue organised by SLA age would be answering the wrong
question; it should accumulate the half-year's audits for a premises into the
evidence that supports that period's Form B.

**3. This is the commercially interesting part.** Form B is prepared twice a year,
largely out of files and spreadsheets. A tool that accumulates a premises' audits
across the half-year and produces the supporting evidence pack is solving a real,
dated, recurring obligation — not offering a nicer inspection form.

The jurisdiction key would be **`IN-MH`**, and because §3 of the sign-off design made
credentials jurisdiction-scoped with a registry, adding Maharashtra is a registry
edit rather than a schema change. That is the payoff of that decision arriving
earlier than expected.

⚠️ **Build order matters more than the feature.** Sign-off must not be added to this
workflow before 7.1–7.3. Signing a verdict that the model itself supplied
(`status` trusted verbatim) means attaching a legal signature to a value a model
revision could silently change, on a pipeline where a database outage aborts the run
entirely. The US workflow derives its verdict in code precisely so a signature means
something. India must reach that bar first.

### 7.10 Correct the hardcoded code basis in the prompt

`BUILD_Vision_Payload` says *"operating under NBC 2016 and CFO Mumbai norms"*
verbatim. That is loose: NBC 2016 is recommendatory, and what makes it enforceable in
Maharashtra is the MFPLSM Act 2006 and Rules 2009, with the CFO of the Municipal
Corporation as the authority.

The dashboard labels were corrected in `lib/regions.ts`; the prompt was not, because
changing it requires a re-import. Worth doing together with any other prompt work —
and worth adding **IS 2190** and **IS 15683** citations to the checklist at the same
time, which is the India equivalent of the US prompt citing NFPA 10 clauses.

### 7.11 Shared with the US workflow

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
| Sign-off | ❌ no columns, no write path (7.8, 7.9) |
| Form B support (half-yearly evidence pack) | ❌ researched, not built (7.9) |
| Statute stated correctly in the UI | ✅ MFPLSM 2006 / Rules 2009 · CFO MCGM |
| Statute stated correctly in the **prompt** | ❌ still says "NBC 2016 and CFO Mumbai norms" (7.10) |
| Webhook authentication | ❌ open (7.11) |

**Honest summary:** India works and is in production, but it is the older, thinner
implementation. If India becomes commercially significant, 7.1 to 7.3 are the ones
that matter — they are the difference between a system that reports a blocked fire
exit and one that can silently fail to.
