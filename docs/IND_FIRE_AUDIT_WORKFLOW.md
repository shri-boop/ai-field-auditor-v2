# AQUILA IND — NBC 2016 / CFO Mumbai Field Audit Workflow

Companion to the US workflow (`AI_Field_Audit_US.json`, IFC / NFPA — see
[US_FIRE_AUDIT_WORKFLOW.md](US_FIRE_AUDIT_WORKFLOW.md)).
This document covers `AI_Field_Audit_v2.json`.

- **Workflow name:** `AI_Field_Audit_V2_URL_To_Base64`
- **Webhook:** `POST /webhook/audit-field-photov2`
- **Table:** `field_audit_logs`
- **Code basis:** NBC 2016 Part 4 with MFPLSM Act 2006 / Rules 2009 and IS 2190 /
  IS 15683, **hardcoded in the prompt** (no runtime registry)
- **Source of truth:** `scripts/nodes/ind_*.js`, written into the JSON by
  `scripts/patch_india_workflow.py`. The JSON is **patched in place**, not
  regenerated — see §6.
- **Tests:** `node scripts/test_india.mjs` — 164 assertions, no n8n or database

---

## 1. Read this first: the two workflows are not siblings

It is tempting to treat India and US as mirror images. They are not, and most
confusion about this project comes from assuming otherwise.

| | India (`v2`) | US |
|---|---|---|
| Origin | the original build, evolved in place | designed from scratch afterwards |
| Code basis | one hardcoded prompt string | runtime registry, 9 jurisdictions |
| Maintenance | JSON patched in place from `scripts/nodes/ind_*.js` | JSON generated whole from `scripts/nodes/*.js` |
| Nodes | 15 (2 orphaned) | 23 |
| Test coverage | 164 offline assertions | 106 offline assertions |
| Status derivation | derived in code from severity counts | derived in code from severity counts |
| Findings model | CRITICAL / MAJOR / MINOR + citation, **no SLA tier** | same tiers, plus per-tier SLA (0 h / 72 h / 30 d) |
| Input validation | throws on missing `image_url` | full schema + SSRF guard, structured HTTP 400 |
| DB write failure | `continueRegularOutput`, reports `persisted: false` | same |
| Model resilience | single model, no timeout, no retry | timeout + retries + second-model fallback |
| `violations` storage | stringified JSON in `text`, **plus** structured `jsonb` `deficiencies` | `jsonb` + GIN index |
| Primary key | `id` (integer serial) | `audit_id` (minted text) |
| `audit_timestamp` type | **`text`** | `timestamptz` |

Section 3 of the US document enumerates the thirteen original differences. India
has since closed the ones that governed correctness — derived status, severity
tiers, database-failure tolerance, notifier escaping — and the offline suite that
proves it. What remains open is real but narrower: SSRF, structured 400s, model
resilience, and the `text` timestamp column. See §7.

The deliberate non-parity is the **SLA tier**. The US model runs on remediation
clocks; a Maharashtra owner works to Form B's half-yearly calendar, so copying
0 h / 72 h / 30 d would answer a question nobody in that regime is asking. See
§7.9.

---

## 2. Pipeline

```
Webhook
  └─ PARSE_Input            ind_01_parse_input.js
      │                     image_url + site_id + asset_tag + inspector_id
      └─ BUILD_Vision_Payload    ind_02_build_payload.js
          │                      13-item severity-tagged checklist
          │                      does NOT ask the model for a status
          └─ Claude_Vision_API   anthropic/claude-sonnet-4-5, no timeout, no retry
              └─ PARSE_Response  ind_03_derive_verdict.js
                  │              DERIVES the verdict from severities
                  └─ LOG_Audit   -> field_audit_logs
                      │          onError: continueRegularOutput, 3 tries
                      └─ SHAPE_Response   ind_04_shape_response.js
                          │               sets `persisted`, declares the contract
                          └─ IF_NonCompliant   branches on `alert_required`
                               ├─ true  → NOTIFY_OpsManager  ind_05_build_alert.js
                               │            → SEND_Slack + SEND_Telegram
                               │          + Respond_to_Webhook1
                               └─ false → Respond_to_Webhook1
```

Every Code node's JavaScript lives in `scripts/nodes/ind_*.js` and is written into
the JSON by `scripts/patch_india_workflow.py`. `scripts/test_india.mjs` asserts the
two are identical, so the tests cannot pass against code that is not what runs.

`PARSE_Response` keeps its name although its job changed from transcribing the
model's verdict to computing one. Renaming it would break every
`$('PARSE_Response')` reference and discard the node's execution history in n8n,
for no gain.

`DOWNLOAD_Image → EXTRACT_Base64` is an **orphaned pair**, left from an earlier
base64 approach that the workflow name still advertises. Both are disabled and
neither is in the executing chain. Left alone deliberately — removing them is
cosmetic and re-importing the workflow carries more risk than the tidiness is
worth.

---

## 3. The checklist

Thirteen checks, defined as data in `scripts/nodes/ind_02_build_payload.js` and
rendered into the prompt. Each carries a **severity we assign** and an Indian
citation. Severity is authored here rather than left to the model so it is
reviewable and consistent between audits.

| Code | Severity | What it catches | Reference |
|---|---|---|---|
| `UNIT_MISSING_OR_DISCHARGED` | CRITICAL | absent, discharged, or gauge in the recharge zone | IS 2190; NBC 2016 Part 4 |
| `ACCESS_BLOCKED` | CRITICAL | access fully blocked or unit obscured | IS 2190 cl. 4; NBC 2016 Part 4 |
| `HOSE_REEL_UNUSABLE` | CRITICAL | hose missing or severed, cabinet won't open | NBC 2016 Part 4 |
| `GAUGE_OUT_OF_RANGE` | MAJOR | needle outside green, or unreadable gauge face | IS 2190 |
| `SEAL_OR_PIN_COMPROMISED` | MAJOR | pin missing/unseated, tamper seal broken | IS 2190 |
| `REFILL_OR_EXPIRY_OVERDUE` | MAJOR | refill or expiry date passed | IS 2190 cl. 7 |
| `INSPECTION_TAG_MISSING` | MAJOR | tag absent, illegible, unsigned or stale | IS 2190; MFPLSM Rules 2009 |
| `PHYSICAL_DAMAGE_OR_CORROSION` | MAJOR | corrosion, dents, damaged hose/horn/nozzle | IS 2190 |
| `MOUNTING_HEIGHT_WRONG` | MAJOR | insecure, or top above ~1.5 m for hand-portable | IS 2190 cl. 4 |
| `WRONG_CLASS_FOR_HAZARD` | MAJOR | e.g. water-based unit at an energised electrical hazard | IS 2190 cl. 3; NBC 2016 Part 4 |
| `ISI_MARK_MISSING` | MINOR | ISI / BIS mark absent, painted over or illegible | IS 15683; BIS certification |
| `CABINET_DEFECT` | MINOR | glass/latch/break-glass defects, equipment still usable | NBC 2016 Part 4 |
| `SIGNAGE_MISSING` | MINOR | no location marking where the unit is not plainly visible | NBC 2016 Part 4 |

The severity boundary is a judgement, stated so it can be argued with:

- **CRITICAL** — the equipment cannot be relied on to work, or cannot be reached.
- **MAJOR** — a defect that defeats certification or maintenance requirements.
- **MINOR** — marking, documentation or housekeeping.

Two consequences worth knowing:

- **ISI is the India-specific marking.** The US prompt explicitly forbids looking
  for it and teaches the analogue (UL Listing / FM Approval); the India prompt
  forbids NFPA, IFC and UL/FM for the same reason in reverse. Feeding an Indian
  extinguisher to the US workflow correctly reports "no UL/FM mark" — technically
  right, and a poor demo.
- **There is no equipment classification.** The prompt assumes an extinguisher or
  hose reel. The US workflow has nine equipment classes and either classifies or
  takes a hint; India has one implicit class.

### How a verdict is computed

The model is asked for observations and severities, **never for a status**. The
prompt says outright that a returned verdict will be ignored, and
`ind_03_derive_verdict.js` ignores it. Precedence, copied from the US workflow:

```
CRITICAL present            -> NON-COMPLIANT
else weak evidence          -> REINSPECT      (confidence LOW or image POOR,
                                               or the model asked for a retake)
else MAJOR present          -> NON-COMPLIANT
else MINOR present          -> CONDITIONAL
else                        -> COMPLIANT
unparseable model output    -> ERROR
```

A critical finding outranks the confidence gate deliberately. The cost of a false
alarm is a wasted van; the cost of a suppressed blocked-access finding is not
comparable.

`CONDITIONAL` exists because real inspection practice distinguishes "deficiencies
noted" from "failed". Collapsing the two trains operators to ignore alerts.

**Severity resolution biases upward in both directions.** The checklist severity is
a floor — the model cannot downgrade a checklist-CRITICAL code — but the model may
still escalate above it, because reaching for a MINOR code to describe something
worse is a likelier error than inventing a critical finding. An unrecognised
severity string normalises to MAJOR, never MINOR. A code outside the checklist is
flagged in `unknown_codes` and still counted, never dropped.

`risk_score` is `min(100, 100·critical + 25·major + 5·minor)` — the same weights as
the US workflow, so a risk score means the same thing in both regions.

`alert_required` is a boolean computed as `status !== 'COMPLIANT'`, and
`IF_NonCompliant` branches on it. Keeping the branch condition in code means
adding a status can never silently create an unrouted path — which is exactly how
`REINSPECT` came to be handled in the notifier while being unreachable from the IF
node.

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

Declared explicitly by `SHAPE_Response`, not whatever node happened to run last.

```json
{
  "status": "NON-COMPLIANT",
  "confidence": "HIGH",
  "equipment_type": "Dry Powder Type Fire Extinguisher",
  "observations": "…",
  "violations": ["[CRITICAL] Pressure gauge needle sits in the recharge zone.", "…"],
  "site_id": "SITE-MUM-401",
  "asset_tag": "EXT-401-02",
  "inspector_id": "TECH-8891",
  "image_url": "https://…",
  "audit_timestamp": "2026-09-03T08:52:37.169Z",

  "audit_id": null,
  "record_id": 4711,
  "persisted": true,
  "alert_required": true,

  "critical": true,
  "risk_score": 100,
  "severity_counts": { "critical": 1, "major": 0, "minor": 2 },
  "deficiency_count": 3,
  "deficiencies": [
    {
      "code": "UNIT_MISSING_OR_DISCHARGED",
      "code_known": true,
      "severity": "CRITICAL",
      "finding": "…", "observed": "…", "requirement": "…",
      "code_reference": "IS 2190",
      "remediation": "Withdraw and refill the cylinder."
    }
  ],
  "unverifiable_items": ["Refill date not legible"],
  "unknown_codes": [],
  "image_quality": "GOOD",
  "reinspect_required": false,
  "reinspect_reasons": [],

  "code_basis": { "jurisdiction_resolved": "IN-MH", "…": "…" },

  "advisory_only": true,
  "certification_eligible": false,
  "requires_licensed_inspector_signoff": true,
  "signoff_status": "PENDING",
  "scope_note": "… Not a Form B certification …",
  "region": "IND"
}
```

Notes on the fields that carry weight:

- **`status` is computed, not reported.** Enumerated: `COMPLIANT`, `CONDITIONAL`,
  `NON-COMPLIANT`, `REINSPECT`, `ERROR`. A model emitting "PASS" or "PARTIAL"
  changes nothing.
- **`persisted: false`** means the verdict is real but the database write failed.
  The alert still fired and says it is the only copy of the finding. The dashboard
  renders this state.
- **`record_id`** is the row's integer primary key — India's analogue of the US
  `audit_id`, and what the Records browser searches on. `null` when the write
  failed, because there is no record to address.
- **`violations`** is the flat list, now severity-prefixed. `deficiencies` is the
  structured version. Both are returned: the flat list is what pre-existing
  consumers read, the structured one is what the report renders.
- **`code_basis`** is a static assertion of what the prompt claimed, not a registry
  lookup — India resolves nothing at run time. Its `fire_code` text is kept
  identical to `REGIONS.IND.codeBasisFallback` in `lib/regions.ts`, and the offline
  suite asserts that, so a live audit can never display less statute than a
  fallback.
- **`advisory_only` / `certification_eligible` / `signoff_status`** are now stated
  by the workflow. They were previously supplied by the dashboard on its own
  authority, which meant the claim depended on which client rendered the record.
  This is a statement of scope only — there are still no sign-off columns on the
  table and no write path (§7.8, §7.9).

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
 deficiencies       jsonb      -- migration 004
 unverifiable_items jsonb      -- migration 004
 reinspect_reasons  jsonb      -- migration 004
 critical           boolean    -- migration 004
 critical_count     integer    -- migration 004
 major_count        integer    -- migration 004
 minor_count        integer    -- migration 004
 deficiency_count   integer    -- migration 004
 risk_score         integer    -- migration 004
 image_quality      text       -- migration 004
 reinspect_required boolean    -- migration 004
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

**`violations` is stringified JSON in a `text` column, and stays that way.** Every
reader parses it, and unparseable text is kept as a single finding rather than
dropped — losing a violation line is not an acceptable failure mode. Migration 004
deliberately did **not** convert it to `jsonb`: that would rewrite the table, break
rows containing non-JSON text, and buy nothing the new `deficiencies` column does
not already provide. `deficiencies` is the structured record; `violations` is the
flat human-readable line, kept for continuity with every row written before it.

### Migrations

- `002_field_audit_logs_index.sql` — `(site_id, created_at DESC)` and
  `(created_at DESC)`. The table previously carried only its primary-key index, so
  a site lookup was a sequential scan plus a sort.
- `003_field_audit_logs_parity.sql` — adds `asset_tag`, `inspector_id`,
  `image_url` and a partial index on `asset_tag`.
- `004_field_audit_logs_severity.sql` — adds the eleven severity-model columns
  above, a partial index on `critical`, and `(status, created_at DESC)` for the
  Records status filter.

All are fully guarded: they verify the table and each column first and skip
cleanly, because that table's shape cannot be proved from source control. All are
re-runnable.

**Rows written before a migration have NULL in the columns it added.** There is no
backfill and cannot be — the values were never captured. An older India record
shows no evidence photo, no asset tag, and no severity breakdown.

That last one shapes how `SHAPE_Results` reads a pre-004 row: the counts are
returned as **`null`, not `0`**. "0 critical findings" reads as a clean bill, when
in fact nothing was ever counted. `critical` is the exception and returns `false`,
because it gates an "attend now" queue where a null would be worse than a
conservative answer.

---

## 6. Editing this workflow

`AI_Field_Audit_v2.json` is **patched in place**, not regenerated. The US workflow
is built whole from scratch; this one is not, because it carries live credential
references and an `active: true` flag that a from-scratch rebuild would be liable
to drop.

**Never hand-edit the JSON.** Edit `scripts/nodes/ind_*.js`, then:

```bash
node --check scripts/nodes/ind_03_derive_verdict.js   # syntax, per file
python3 scripts/patch_india_workflow.py               # idempotent
python3 scripts/patch_india_workflow.py --check       # verify committed JSON
node scripts/test_india.mjs                           # 164 assertions, no n8n or DB
```

`test_india.mjs` asserts byte equality between each node's `jsCode` in the JSON and
its source file, so tests can never pass against code that is not what runs. It
also asserts the wiring: the webhook path, the target table, `onError`, the boolean
IF condition, the column mappings, that the credential reference survived, and that
the Gmail node is still disabled.

The patch script refuses to write if `LOG_Audit` no longer targets
`field_audit_logs` (pointing it at the US table would corrupt a differently-shaped
one) or if the webhook path changed (`lib/regions.ts` depends on it).

### Re-importing into n8n

⚠️ **Order matters. Migration first, import second.**

```bash
# 1. schema
docker exec -i ai-stack-postgres-1 sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < scripts/db/004_field_audit_logs_severity.sql

# 2. then re-import AI_Field_Audit_v2.json
```

Migration first is the safe direction: until the import, the new columns simply
stay NULL and India behaves exactly as before. Importing first would make every
insert fail on unknown columns and take India audits down.

The same applies to `AI_Field_Audit_History.json` — its India query names the new
columns explicitly, so importing it before 004 makes every Records lookup fail with
`column "deficiencies" does not exist`.

⚠️ **Update the existing workflow. Do not import a second copy.** Two workflows
registering `/webhook/audit-field-photov2` will conflict and India audits break.

The file carries `"active": true`, matching production — confirm it is still active
after the import.

---

## 7. Roadmap

India's roadmap is mostly **catching up to the US workflow**, and the ordering
reflects risk, not effort. 7.1–7.3 have shipped; 7.4 onward have not.

### ✅ 7.1 Trust the code, not the model, for `status` — SHIPPED

`PARSE_Response` used to write whatever the model put in `status` straight into the
database, and `IF_NonCompliant` branched on it. The verdict that triggers escalation
was therefore neither reviewable nor stable across model versions: a model revision
returning "PASS" instead of "COMPLIANT" would have routed every audit — including
one showing a discharged extinguisher — down the compliant branch, firing no alert,
silently.

The prompt no longer asks for a status and states that one will be ignored;
`ind_03_derive_verdict.js` computes it from severities. `IF_NonCompliant` branches on
the derived boolean `alert_required`. See §3, *How a verdict is computed*.

### ✅ 7.2 A severity model — SHIPPED

CRITICAL / MAJOR / MINOR, thirteen checklist codes with Indian citations, per-tier
counts, and a 0–100 risk score using the same weights as the US workflow. Persisted
by migration 004; rendered by the existing shared report component with no frontend
change, because the field names match what the US workflow already emitted.

The **SLA tier was deliberately not ported**. See §7.9: Maharashtra runs on Form B's
half-yearly calendar, not remediation clocks.

### ✅ 7.3 Do not let a DB failure swallow a finding — SHIPPED

`LOG_Audit` now runs with `onError: continueRegularOutput`, `alwaysOutputData` and
three tries. `SHAPE_Response` inspects the result and sets `persisted`. A Postgres
outage degrades the audit instead of aborting it: the alert still fires, the caller
still gets the verdict, and both are told in plain words that this alert is the only
copy of the finding.

Previously a blocked fire exit would have gone unreported because a database was
briefly unavailable — with the finding already computed and sitting in memory.

### Bugs this work surfaced

- **A JSON array from the model was a false pass.** `typeof [] === 'object'` and
  `[]` is truthy, so a reply of `[]` passed the parse gate, produced no
  deficiencies, and would have been recorded as COMPLIANT. Caught by the new
  offline suite, which is the argument for the suite.
- **The prompt would have collapsed into one unreadable block.** The builder joins
  an array of lines and filtered out empty strings to drop an optional asset-tag
  line — which also stripped every intentional blank line. Now it filters `null`.
- **Telegram alerts were one `&` away from silent loss.** `SEND_Telegram` posts with
  `parse_mode: HTML` and the content was never escaped, so a finding containing
  `&`, `<` or `>` made Telegram reject the whole message — losing the alert on
  exactly the messiest findings. This was item 9 in the US document's comparison
  table; it is now fixed here too. Slack and the email body are escaped as well.
- **`NOTIFY_OpsManager` read `$input.item` in all-items mode.** n8n only provides
  `.item` in "Run Once for Each Item" mode, and the node has no `mode` parameter
  set. The rewrite uses `$input.first()`, which is valid in either mode, so the
  question no longer matters — but it is worth confirming that India Slack and
  Telegram alerts were in fact arriving before this change.
- **`Respond_to_Webhook1` returned whatever ran last.** The response shape was an
  accident of node ordering — a Postgres row echo. `SHAPE_Response` now declares it.

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

### ✅ 7.7 Offline tests — SHIPPED

`scripts/test_india.mjs`, 164 assertions, no n8n, no database, no model call. It
runs under the same restricted sandbox as `test_pipeline.mjs` — globals the n8n
`vm` context does not reliably provide (`URL`, `Buffer`, `process`, `fetch`, …) are
shadowed as undefined, because a friendlier harness once let a `new URL(...)`
`ReferenceError` through at 85/85 in the US pipeline.

It found two real defects on its first run (see *Bugs this work surfaced*), which
is roughly the expected yield for a first suite over code that had none.

Still uncovered: the HTTP layer, the Postgres write itself, and the Slack/Telegram
transports. Those are integration concerns and would need a live stack.

### 7.8 Governance parity — partially shipped

**Shipped:** the workflow now states `advisory_only: true`,
`certification_eligible: false`, `requires_licensed_inspector_signoff: true`,
`signoff_status: 'PENDING'` and a `scope_note` naming Form B as what this is *not*.
It also returns `unverifiable_items`. Previously the dashboard supplied
`advisory_only` on its own authority, so the disclaimer depended on which client
rendered the record; now the claim travels with the response.

**Not shipped:** there is still no equivalent of the US table's
`signoff_status` / `signoff_by` / `signoff_at` columns and no write path. The
`PENDING` above is a constant, not a state machine.

See **[SIGNOFF_DESIGN.md](SIGNOFF_DESIGN.md)** §13.5 — that proposal is
Florida-shaped. CFO Mumbai licensing is a different regime, so the credential
enumeration would not transfer directly; §7.9 below is the India-specific design.

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

✅ **The build-order precondition is now met.** Sign-off was deliberately blocked
until 7.1–7.3 shipped: signing a verdict the model itself supplied would have meant
attaching a signature to a value a model revision could silently change, on a
pipeline where a database outage aborted the run entirely. India now derives its
verdict in code from severities that are persisted alongside it, so the stored status
is reproducible from the stored evidence — you can audit the audit. A signature can
mean something here.

What still stands between here and Form B support: sign-off columns on
`field_audit_logs`, a write path, and the credential model for a **Licensed Agency**
rather than an individual permit-holder.

### ✅ 7.10 Correct the hardcoded code basis in the prompt — SHIPPED

The prompt said *"operating under NBC 2016 and CFO Mumbai norms"* verbatim, which was
loose: NBC 2016 is recommendatory, and what makes it enforceable in Maharashtra is the
MFPLSM Act 2006 and Rules 2009, with the CFO of the Municipal Corporation as the
authority.

The prompt now states the statute the way `lib/regions.ts` does, names the CFO (MCGM
for Brihanmumbai) as the AHJ, cites **IS 2190** and **IS 15683** per checklist item,
and explicitly forbids NFPA, IFC and UL/FM citations — the mirror of the US prompt
forbidding ISI. Done as part of the §7.2 prompt rewrite, since both needed the same
re-import.

### 7.11 Shared with the US workflow

These are not India-specific — see the US document for detail:

- **✅ Authenticate the webhook — code shipped, needs binding in n8n.**
  `/webhook/audit-field-photov2` now carries `authentication: headerAuth` and
  `app/api/audit/route.ts` sends header **`x-audit-api-key`** from `AUDIT_API_KEY`.
  No credential is committed (n8n mints the ID), so it **fails closed until bound**
  in the n8n UI — create a credential labelled `Audit IND Key`, header name
  `x-audit-api-key`.

  Use a **different secret from `HISTORY_API_KEY`**: records are read-only, this
  endpoint spends money on every call.

  ⚠️ **Order matters — getting it backwards takes India audits down.** Deploy the
  code first (n8n ignores a header it is not checking), then set `AUDIT_API_KEY` and
  redeploy, then bind the credential. Full detail in the US document §11.4.
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
| Derived status | ✅ computed in code from severities (7.1) |
| Severity tiers | ✅ CRITICAL / MAJOR / MINOR + risk score (7.2) |
| DB failure tolerance | ✅ `continueRegularOutput`, reports `persisted: false` (7.3) |
| Offline tests | ✅ 164 assertions, restricted sandbox (7.7) |
| Notifier escaping | ✅ Telegram / Slack / email all escaped |
| Statute stated correctly in the UI | ✅ MFPLSM 2006 / Rules 2009 · CFO MCGM |
| Statute stated correctly in the **prompt** | ✅ with IS 2190 / IS 15683 citations (7.10) |
| Scope declared by the workflow | ✅ `advisory_only`, `certification_eligible: false` (7.8) |
| SLA tiers | ➖ deliberately absent — Form B calendar, not SLA (7.9) |
| SSRF guard | ❌ none (7.4) |
| Structured HTTP 400 | ❌ throws instead (7.5) |
| Timeout / retry / fallback model | ❌ none (7.6) |
| Sign-off columns and write path | ❌ none (7.8, 7.9) |
| Form B support (half-yearly evidence pack) | ❌ researched, not built (7.9) |
| Webhook authentication | ⚠️ code shipped; **bind the credential in n8n** (7.11) |
| `audit_timestamp` column type | ❌ still `text` (§5) |

**Honest summary:** India has caught up on the things that decide whether a finding
reaches a human. The verdict is derived in code from severities that are stored
alongside it, a database outage degrades the audit instead of discarding it, the
notifier no longer loses messages to an unescaped ampersand, and 164 assertions run
without touching production.

What remains open is a different class of problem: input hardening (7.4, 7.5) and
availability (7.6). The unauthenticated webhook (7.11) — the one item that was
actively costing money — now has its code shipped and needs only the n8n credential
bound.
