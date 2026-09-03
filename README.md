# ai-field-auditor-v2

This is a [Next.js](https://nextjs.org) project bootstrapped with [v0](https://v0.app).

## n8n audit workflows

| File | Region | Code basis | Webhook |
|---|---|---|---|
| `AI_Field_Audit_v2.json` | India | NBC 2016 + CFO Mumbai | `/webhook/audit-field-photov2` |
| `AI_Field_Audit_US.json` | United States | IFC 2024 / NFPA 1 + NFPA 10, 25, 72, 80, 96, 101, 110, with an OSHA 29 CFR 1910 overlay — resolved per jurisdiction at runtime | `/webhook/audit-field-photo-us` |

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

### Access control

`middleware.ts` gates the page **and** the API routes behind HTTP Basic auth.
Every audit is a paid vision call, so an open URL is a metered spend endpoint —
and you cannot hand an open URL to a customer.

It is **opt-in**: with either variable missing the middleware is inert, so
deploying it cannot lock you out. Protection starts the moment both are set in
Vercel, with no code change. Set them per deployment so each customer has its
own credential.

```bash
openssl rand -base64 32     # AUDIT_ACCESS_PASSWORD
```

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
