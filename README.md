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
