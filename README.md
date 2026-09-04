# ai-field-auditor-v2

This is a [Next.js](https://nextjs.org) project bootstrapped with [v0](https://v0.app).

## n8n audit workflows

| File | Region | Code basis | Webhook |
|---|---|---|---|
| `AI_Field_Audit_v2.json` | India | NBC 2016 + CFO Mumbai | `/webhook/audit-field-photov2` |
| `AI_Field_Audit_US.json` | United States | IFC 2024 / NFPA 1 + NFPA 10, 25, 72, 80, 96, 101, 110, with an OSHA 29 CFR 1910 overlay — resolved per jurisdiction at runtime | `/webhook/audit-field-photo-us` |
| `AI_Field_Audit_History.json` | Both | Read-only records lookup over both audit logs | `/webhook/audit-history` |

The US workflow is a **build artifact**. Its logic lives in `scripts/nodes/*.js`;
regenerate with `python3 scripts/build_us_workflow.py` and test offline with
`node scripts/test_pipeline.mjs`. See
**[docs/US_FIRE_AUDIT_WORKFLOW.md](docs/US_FIRE_AUDIT_WORKFLOW.md)** for the
architecture, API contract, database migration and known limitations.

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
| Source of truth | `scripts/db/001_field_audit_us_logs.sql` | none — created ad hoc |
| Columns | ~40, incl. `deficiencies` jsonb, `code_basis` snapshot, sign-off | 9 |
| Primary key | `audit_id` (text, minted) | `id` (integer, serial) |
| `audit_timestamp` type | `timestamptz` | **`text`** |
| Range filter / ordering | `audit_timestamp` | `created_at` (see below) |
| Filters | site, asset tag, audit id, status, date range | site, record id, status, date range |

`asset_tag` and `audit_id` filters are **rejected** for `IND` rather than
ignored — silently dropping a filter would return rows the caller did not ask
for, which on an audit log is worse than an error. India records are addressed by
`record_id`, its integer primary key, which the API exposes as the `audit_id`
analogue.

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
node scripts/test_history.mjs                             # 57 assertions, no n8n or DB needed
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
