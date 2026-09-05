# ai-field-auditor-v2

This is a [Next.js](https://nextjs.org) project bootstrapped with [v0](https://v0.app).

## n8n audit workflows

| File | Region | Code basis | Webhook |
|---|---|---|---|
| `AI_Field_Audit_v2.json` | India | NBC 2016 + CFO Mumbai | `/webhook/audit-field-photov2` |

| `AI_Field_Audit_US.json` | United States | IFC 2024 / NFPA 1 + NFPA 10, 25, 72, 80, 96, 101, 110, with an OSHA 29 CFR 1910 overlay — resolved per jurisdiction at runtime | `/webhook/audit-field-photo-us` |
| `AI_Field_Audit_History.json` | Both | Read-only records lookup over both audit logs | `/webhook/audit-history` |

### The India workflow is patched, not generated

`AI_Field_Audit_v2.json` is edited in place by `scripts/patch_india_workflow.py`,
which is idempotent. It is not rebuilt from scratch like the US workflow, because it
carries live credential references and an `active: true` flag that a from-scratch
rebuild would be liable to drop.

Its JavaScript still lives in files — `scripts/nodes/ind_*.js` — and the patch script
writes those into the JSON. **Never hand-edit the JSON.**

```bash
node --check scripts/nodes/ind_03_derive_verdict.js   # syntax, per file
python3 scripts/patch_india_workflow.py               # idempotent
python3 scripts/patch_india_workflow.py --check       # verify committed JSON
node scripts/test_india.mjs                           # 265 assertions, no n8n or DB
node scripts/test_credentials.mjs                     # 80 assertions, credential registry
node scripts/test_signoff_sql.mjs                     # 158 assertions, sign-off SQL (structure only)
```

`test_india.mjs` asserts byte equality between each node's `jsCode` in the JSON and
its source file, so the tests cannot pass against code that is not what runs.

⚠️ **`test_signoff_sql.mjs` does not execute SQL.** It asserts that the rules in
`scripts/db/007_*.sql` still match the rules in
[SIGNOFF_DESIGN.md](docs/SIGNOFF_DESIGN.md) — nothing more. The sign-off SQL is the
one part of this repo with no offline execution coverage, because no Postgres is
available where it is developed. `scripts/db/007_verify.sql` is the real test: it
runs every rule on the actual engine and prints PASS/FAIL inside a transaction it
rolls back, and it must be run after applying migration 007. See
[SIGNOFF_DESIGN.md §16](docs/SIGNOFF_DESIGN.md).

Things to know before re-importing it into n8n:

- **Apply `scripts/db/004_field_audit_logs_severity.sql` first.** The workflow writes
  eleven new columns. Migration first is the safe order: until the import they stay
  NULL and nothing changes. Import first and every insert fails on unknown columns.
- **Update the existing workflow — do not import a second copy.** Two workflows
  registering `/webhook/audit-field-photov2` will conflict, and India audits break.
- The file carries `"active": true`, matching production. Confirm it is still
  active after the import.
- `DOWNLOAD_Image → EXTRACT_Base64` is an orphaned pair, left over from an earlier
  base64 approach. It is not in the executing chain
  (`Webhook → VALIDATE_Input → ROUTE_Validation → BUILD_Vision_Payload →
  Claude_Vision_API → PARSE_Response → LOG_Audit → SHAPE_Response →
  IF_NonCompliant`) and is left alone deliberately.

The US workflow is a **build artifact**. Its logic lives in `scripts/nodes/*.js`;
regenerate with `python3 scripts/build_us_workflow.py` and test offline with
`node scripts/test_pipeline.mjs`.

Per-region documentation — architecture, API contract, migrations, current state
and roadmap:

- **[docs/US_FIRE_AUDIT_WORKFLOW.md](docs/US_FIRE_AUDIT_WORKFLOW.md)** — IFC / NFPA
- **[docs/IND_FIRE_AUDIT_WORKFLOW.md](docs/IND_FIRE_AUDIT_WORKFLOW.md)** — NBC 2016 / CFO Mumbai
- **[docs/SIGNOFF_DESIGN.md](docs/SIGNOFF_DESIGN.md)** — sign-off design proposal (not built)

The two are **not** mirror images. India is the original build. It has since caught
up on derived status, severity tiers, database-failure tolerance and offline tests,
but still lacks the SSRF guard, structured HTTP 400s and model retries the US
workflow was designed with — and its audit webhook is still unauthenticated. The
India document opens with the full comparison.

## Configuration

Both variables are server-side only — neither is `NEXT_PUBLIC_`, so the n8n
hostname no longer ships in the browser bundle. See
[`.env.example`](.env.example).

| Variable | Default | Purpose |
|---|---|---|
| `N8N_BASE_URL` | `https://n8n.kratuailabs.com` | n8n origin. The per-region webhook path is appended by `app/api/audit/route.ts`. |
| `ENABLED_REGIONS` | `IND` | Which regions this deployment may serve: `IND`, `US`, or `IND,US`. |
| `AUDIT_TIMEOUT_MS` | `240000` | How long the proxy waits on n8n before returning HTTP 504. |
| `AUDIT_ACCESS_USER` | — | Basic-auth username. See Access control below. |
| `AUDIT_ACCESS_PASSWORD` | — | Basic-auth password. Both must be set for auth to apply. |
| `HISTORY_API_KEY` | — | Shared secret for the records webhook. Unset = records disabled. |
| `HISTORY_TIMEOUT_MS` | `30000` | Records lookup timeout. |

## Audit Records

`AI_Field_Audit_History.json` — `POST /webhook/audit-history` — read-only
retrieval over both audit logs, reached through `app/api/history/route.ts`.

**Why it goes through n8n rather than querying Postgres directly:** the database
has no `ports:` mapping in the stack's compose file, so it is reachable only on
the internal docker network. Vercel cannot reach it, and that is correct —
exposing Postgres to serve a history page would be a worse problem than the one
it solves. n8n is already public, already holds the credential, and already sits
on that network.

### In the UI

A **Records** tab appears beside **New audit** once `HISTORY_API_KEY` is set —
and only then, because without it `/api/history` returns 503 and a tab that
cannot work is worse than no tab.

Search by site ID, reference, asset tag (US), date range and status; results list
newest first; clicking a row opens the full report and **Print / Save as PDF**
works on it exactly as on a live audit.

That last part is why `components/audit-report.tsx` exists. The report renderer
was extracted out of `audit-console.tsx` so a retrieved record and a fresh one go
through the same component — one renderer, one print stylesheet, one set of
page-break rules. `SHAPE_Results` normalising both tables into the live response
contract is the other half of that arrangement.

The reference field means different things per region because the tables do: US
records are addressed by `audit_id`, India records by `record_id` (its integer
primary key). Asset tag is US-only. Those controls are driven off the region
because the backend **rejects** a filter that does not exist for a region rather
than ignoring it.

### Setup

1. Import `AI_Field_Audit_History.json` into n8n.
2. Create an **httpHeaderAuth** credential — suggested name `Audit History Key` —
   with header `x-audit-history-key` and a long random value.
3. Bind it to the **Webhook** node. Until it is bound the webhook rejects every
   request, which is the intended default for this endpoint.
4. Set the same value as `HISTORY_API_KEY` in Vercel, then redeploy.
5. Activate the workflow.

Optionally run `scripts/db/002_field_audit_logs_index.sql` to index the India
table on `(site_id, created_at DESC)`. It carried only its primary-key index, so
"audits for this site, newest first" was a sequential scan plus a sort. Fully
guarded — safe to re-run, and it skips cleanly if the table's shape differs.

### Safety properties

- **Positional SQL parameters only.** `site_id`, `asset_tag` and `status` are
  caller-controlled and land in a `WHERE` clause; none of them reaches the query
  text. Each region uses a fixed parameter count with optional filters written as
  `($n IS NULL OR col = $n)`, so the array always aligns with the placeholders.
- **At least one filter is mandatory.** Unbounded listing of an append-only
  safety log is both a slow query and an enumeration primitive.
- `limit` capped at 100.
- **Read-only** — the workflow contains no write path.
- Region allow-listed in the proxy, same as `/api/audit`.

### The two regions are not symmetric

| | `field_audit_us_logs` | `field_audit_logs` (India) |
|---|---|---|
| Source of truth | `scripts/db/001_field_audit_us_logs.sql` | created ad hoc; extended by `003` and `004` |
| Columns | ~40, incl. `deficiencies` jsonb, `code_basis` snapshot, sign-off | 23; `deficiencies` jsonb and severity counts added by `004`; no `code_basis` snapshot, no sign-off |
| Primary key | `audit_id` (text, minted) | `id` (integer, serial) |
| `audit_timestamp` type | `timestamptz` | **`text`** |
| Range filter / ordering | `audit_timestamp` | `created_at` (see below) |
| Filters | site, asset tag, audit id, status, date range | site, record id, asset tag, status, date range |

`audit_id` is **rejected** for `IND` rather than ignored — it is a minted string
only the US workflow produces, and silently dropping a filter would return rows
the caller did not ask for. India records are addressed by `record_id`, its
integer primary key.

Migration `003` added `asset_tag`, `inspector_id` and `image_url` to the India
table, bringing it to parity on the three fields that mattered: telling two
devices at one site apart, recording who captured the evidence, and being able to
show that evidence on a retrieved record. **Rows written before that migration
have NULL in all three**, so an older India record still has no photograph.

Migration `004` added the severity model — `deficiencies` jsonb, per-tier counts, a
risk score, `image_quality` and the reinspect fields. The records lookup names those
columns explicitly, so **`AI_Field_Audit_History.json` must not be re-imported until
`004` is applied**, or every India lookup fails with
`column "deficiencies" does not exist`.

Rows written before `004` have NULL in all of them, and the lookup returns the counts
as **`null` rather than `0`** — "0 critical findings" reads as a clean bill when in
fact nothing was ever counted.

**India range filtering uses `created_at`, not `audit_timestamp`.** That column is
`text` on this table, and `text >= timestamptz` has no operator in Postgres — the
comparison raises `operator does not exist`. `created_at` is a real `timestamptz`
written by `DEFAULT now()` in the same statement, so for range purposes it is the
same instant. Ordering uses it too: ordering by the text column only appears
correct because every value happens to be a fixed-width ISO-8601 `Z` string,
which makes lexicographic order match chronological order — true today, silently
wrong the first time anything writes a different format. `audit_timestamp` is
still returned, because it is what the record should display.

`impairment_notice` and `scope_note` are rendered at audit time and never
persisted, so a retrieved US record shows that an impairment was suspected and
its basis, but not the full NFPA 25 Ch. 15 action checklist.

### Development

```bash
node --check scripts/nodes/history_01_validate_query.js   # and _02
node scripts/test_history.mjs                             # 98 assertions, no n8n or DB needed
python3 scripts/build_history_workflow.py                 # regenerate
python3 scripts/build_history_workflow.py --check         # verify committed JSON
```

`test_history.mjs` runs under the same restricted sandbox as
`test_pipeline.mjs`, and cross-checks the positional parameter array against the
`$1..$n` placeholders in the generated SQL. Those two live in different files and
nothing at runtime would notice them drifting — the query would simply bind
`site_id` where it meant `status` and return confidently wrong rows.

`AI_Field_Audit_History.json` is a **build artifact** — edit
`scripts/nodes/history_*.js`, never the JSON.

### Access control

`middleware.ts` gates the page **and** the API routes behind HTTP Basic auth.
Every audit is a paid vision call, so an open URL is a metered spend endpoint —
and you cannot hand an open URL to a customer.

It is **opt-in**: with either variable missing the middleware is inert, so
deploying it cannot lock you out. Protection starts the moment both are set in
Vercel, with no code change. Set them per deployment so each customer has its
own credential.

```bash
openssl rand -hex 24        # AUDIT_ACCESS_PASSWORD
```

Prefer hex over `-base64`: you have to type this into a browser prompt, and
base64's `+`, `/` and trailing `=` are easy to mistype and easy to lose from the
end of a copy-paste.

Surrounding whitespace is trimmed from both variables, so a trailing newline
picked up from a pasted value or a piped `printf` will not lock you out. On a
rejected attempt the middleware logs a non-secret diagnostic to the Vercel
runtime log — which half failed, the two lengths, and whether either stored value
had surrounding whitespace.

**Locked out?** Delete either variable and redeploy. The middleware is inert
unless both are set, so that is the emergency exit.

What this is not: one shared credential, no logout, no per-user attribution. It
closes the spend hole and gates the URL. Real accounts arrive with sign-off,
which legally needs to name a person.

### Webhook authentication (the engine, not the app)

Basic auth protects the **app**. It does nothing for the **engine**: anyone who
learns an n8n webhook URL can call it directly, and every audit is a paid vision
call. All three webhooks now require Header Auth.

| Webhook | Header name | n8n credential | Env var | Guards |
|---|---|---|---|---|
| `audit-field-photov2` (IND) | `x-audit-api-key` | `Audit IND Key` | `AUDIT_API_KEY` | model spend |
| `audit-field-photo-us` (US) | `x-audit-api-key` | `Audit US Key` | `AUDIT_API_KEY` | model spend |
| `audit-history` | `x-audit-history-key` | `Audit History Key` | `HISTORY_API_KEY` | data read |

All three are bound and enforced. Verify any of them with a request that costs
nothing — `{}` is rejected before the vision call, so this is free to repeat after a
rotation or a re-import:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://n8n.kratuailabs.com/webhook/audit-field-photov2 \
  -H 'Content-Type: application/json' -d '{}'
# 403
```

**One header name for both audit regions**, because `/api/audit` is a single proxy
serving both. Two credentials sharing one value costs nothing and means rotating one
region later is a config change rather than re-plumbing — optional
`AUDIT_API_KEY_IND` / `AUDIT_API_KEY_US` overrides exist for that day.

**The audit secret is different from `HISTORY_API_KEY`, deliberately.** Records are
read-only; the audit endpoints spend money per call. If they shared a secret, handing
the records key to a BI tool or a client's dashboard would also hand over unlimited
model spend, and neither could be revoked without breaking the other.

**Credential IDs are committed** in `CRED_WEBHOOK_AUTH` in each builder, so all three
workflows import ready-to-run — as the Postgres and OpenRouter credentials always
did. The ID is an opaque reference, not the secret. This matters because an unbound
`headerAuth` webhook fails closed: a re-import that dropped the binding would present
as *every audit being rejected*, not as a missing checkbox. Each test suite asserts
its webhook's credential ID.

⚠️ **`AUDIT_API_KEY` unset fails OPEN** — no header is sent, which was the behaviour
before this existed, with a warning logged per audit. That is the migration path, not
the destination: failing closed would have meant deploying the code took every audit
down before anyone could configure it. Now that the credentials are bound an unset key
is not silent — n8n returns 403 and the API answers `AUDIT_AUTH_REJECTED` naming what
to check.

**If you ever rotate a key**, the order is: change the value in n8n → update
`AUDIT_API_KEY` in Vercel → redeploy. In between, audits fail closed with
`AUDIT_AUTH_REJECTED`, which is the correct direction to fail.

### No workflow carries `pinData`

None of the three artifacts emits pinned webhook data, and none is pinned in n8n. A
pinned webhook body makes n8n replay the pin instead of the real request — wrong
behaviour on a production workflow — and request data accumulates things nobody meant
to commit: `AI_Field_Audit_v2.json`'s `pinData` had to be stripped once because it
contained an operator IP address.

The US regression fixture that used to live there is now `PINNED_REGRESSION_BODY` in
`scripts/test_pipeline.mjs`, where it runs on every invocation rather than only when
someone opens n8n. All three suites assert their artifact has no `pinData`, so a
future export-and-paste cannot reintroduce it.

### Type checking

The Next build does **not** type-check — `next.config.mjs` sets
`typescript.ignoreBuildErrors` because `components/ui/*` carries pre-existing
implicit-any errors from the v0 scaffold. A green deploy is therefore not a type
gate. Run it explicitly:

```bash
npm run typecheck
```

### Region gating

One codebase serves both regions, but **each customer deployment is scoped to
its own region** via `ENABLED_REGIONS`. Two Vercel projects can point at this
same repo with different values and different domains:

```
ENABLED_REGIONS=IND      India customer   — no US surface rendered or callable
ENABLED_REGIONS=US       US customer      — no India surface rendered or callable
ENABLED_REGIONS=IND,US   internal / demo  — region switch visible
```

Enforcement is server-side. `app/api/audit/route.ts` rejects any region outside
the allow-list with HTTP 403, so hiding the toggle is not what keeps regions
apart — the route is. **Unset fails closed to `IND`**, so a misconfigured
deployment can never accidentally expose the US workflow.

This is deployment scoping, not authentication. Add customer login before
there is more than one account per region.

## Request flow

```
browser ──> POST /api/upload  ──> Vercel Blob            (public https URL)
        └─> POST /api/audit   ──> region allow-list check (403 if not enabled)
                               └─> $N8N_BASE_URL/webhook/<region path>
```

The browser no longer talks to n8n directly, which means the audit is
same-origin (no dependence on n8n's CORS config), the n8n host is an env var
rather than a code constant, and there is one server-side place to add auth.

## Built with v0

This repository is linked to a [v0](https://v0.app) project. You can continue developing by visiting the link below -- start new chats to make changes, and v0 will push commits directly to this repo. Every merge to `main` will automatically deploy.

[Continue working on v0 →](https://v0.app/chat/projects/prj_YhTSglAs8mkkNqZL8FyX7V2oDZSN)

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

## Learn More

To learn more, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.
- [v0 Documentation](https://v0.app/docs) - learn about v0 and how to use it.

<a href="https://v0.app/chat/api/kiro/clone/shri-boop/ai-field-auditor-v2" alt="Open in Kiro"><img src="https://pdgvvgmkdvyeydso.public.blob.vercel-storage.com/open%20in%20kiro.svg?sanitize=true" /></a>
