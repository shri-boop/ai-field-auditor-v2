# Sign-off — design proposal

**Status: proposal. Nothing here is built.** This exists to be argued with before
code is written, because sign-off is the first legally meaningful thing this
product will do.

Written from the point of view of the person who carries the risk: the owner of a
Florida fire protection company whose licence is on the line when a record leaves
the building.

---

## 1. The central decision: there are two kinds of sign-off, not one

Everything else follows from this.

A technician sitting in the office triaging forty photographs is **not performing
an inspection**. A technician standing in front of the extinguisher is. Those are
different acts, with different billing, different liability, and different
evidentiary weight — and if the product offers one "Sign off" button, every desk
review prints as though it were an inspection. That is the precise failure this
system has been engineered to avoid everywhere else.

So two distinct actions:

| | **Desk review** | **Field verification** |
|---|---|---|
| The claim | "I have reviewed this automated screening and concur with its findings." | "I have physically inspected this equipment and confirm these findings." |
| Constitutes an inspection? | **No** | Yes, subject to the reviewer's credential |
| Can support a compliance record? | No — triage only | Yes |
| Where | Anywhere | On site |
| `signoff_kind` | `DESK_REVIEW` | `FIELD_VERIFIED` |

The printed record carries the **verbatim attestation** for whichever was used, and
`advisory_only` stays `true` for a desk review. A desk-reviewed record still says
it is not a certification, because it isn't.

This also solves a commercial problem: desk review is a service you can sell at
volume without a licensed inspector's time, and it stays honest about what it is.

---

## 2. Credentials live on the account **and** are snapshotted onto the record

Asked whether the licence number belongs on the account or is typed per sign-off.
The answer is both, and the "both" is the important part.

**On the account**, because a certificate belongs to a person, not to an audit:

| Field | Why |
|---|---|
| Full legal name | what prints |
| Credential type | see §3 — a technician certificate and a firesafety inspector certification are not interchangeable |
| Credential number | as issued |
| Issuing authority | Florida SFM, NICET, state fire marshal of another state |
| Expiry date | the control that matters — see §5 |
| Company licence number | organisation-level; Florida licenses the *dealer*, not just the individual |

Typed per sign-off it would be mistyped, never validated, and impossible to query.
"Show me everything signed by a certificate that had expired" is a question an SFM
audit or an insurance adjuster will ask, and per-sign-off free text cannot answer it.

**Snapshotted onto the record at the moment of signing**, because the record must
remain true forever. If the technician renews, changes employer, or leaves, a
record signed in 2026 must still show the credential as it stood in 2026 — not a
dangling reference to a mutated row.

This is the same principle already used for `code_basis`, which is stored as a
snapshot rather than a reference so a historical audit stays interpretable after
the jurisdiction registry moves to a newer edition. Consistency with that decision
is deliberate.

---

## 3. Credentials are jurisdiction-scoped from day one

**Decision made.** This resolves what was open question §12.4.

A credential is not a type. It is a **(jurisdiction, type, number, expiry)** tuple,
because US fire protection licensing is genuinely per-state and nothing about it
converges:

| State | Who licenses, and what |
|---|---|
| Florida | State Fire Marshal — fire equipment dealer permits by class; individual technician permits; firesafety inspectors certified under **s. 633.216, F.S.** |
| California | **OSFM** licenses extinguisher servicing companies and technicians (Title 19 CCR); CSLB issues the C-16 fire protection contractor licence |
| Texas | **TDI** State Fire Marshal's Office licenses extinguisher and alarm contractors, and individual technicians |
| New York City | **FDNY Certificate of Fitness** — a distinct instrument, not a state licence |
| Massachusetts | Department of Fire Services, under 527 CMR |

Against that, two credentials are **portable across states**: NICET certification
(Levels I–IV, by subfield) and NFPA "trained person" status, which is not a licence
at all.

### This mirrors a decision already made in this codebase

`RESOLVE_CodeBasis` treats jurisdiction as **data in a registry** rather than
branching logic, specifically so that "adding a jurisdiction is a registry edit — no
prompt rewriting, no re-testing of the audit logic" (US doc §1). The credential model
takes the identical shape for the identical reason.

Concretely, it **reuses the same jurisdiction keys** — `FL`, `CA`, `TX`, `NY`,
`NY-NYC`, `MA`, `WA`, `IL-CHICAGO`, `US-DEFAULT` — rather than inventing a parallel
vocabulary. That is what makes §4's jurisdiction-match check possible at all: one
vocabulary across code basis and credentials, so the two can be compared without
translation.

Two additions to that key set:

- `US-NICET` — a pseudo-jurisdiction for portable certifications
- `NONE` — no credential recorded, which is an honest state, not an error

### `CREDENTIAL_REGISTRY`

A registry file mirroring `CODE_BASIS_REGISTRY`, carrying the same honesty flags it
does — `verified_on`, and a per-entry `requires_confirmation`:

```
FL:
  authority: 'Florida State Fire Marshal (Division of State Fire Marshal)'
  types:
    FIRESAFETY_INSPECTOR       s. 633.216, F.S.        field_verify: yes
    FIRE_EQUIPMENT_TECHNICIAN  Ch. 633 Part V permit   field_verify: yes, within permit class
  company_licence: 'Fire equipment dealer permit, Class A/B/C/D by equipment type'
  accepts_nicet: false          # unverified — see below
  verified_on: '2026-09-04'
  requires_confirmation: false

US-NICET:
  authority: 'NICET'
  types:
    NICET_II / III / IV        by subfield             field_verify: per §4
  portable: true

CA, TX, NY-NYC, MA, WA, IL-CHICAGO:
  seeded as STUBS with requires_confirmation: true
```

**Only Florida is seeded as verified**, because Florida is the target market and its
statute has been read. The others are stubs flagged
`requires_confirmation: true` — exactly the discipline already applied to standard
editions, where everything except NFPA 10 (2022) carries
`edition_verified: false` and is surfaced to reviewers rather than silently asserted.

Fabricating California's licensing rules to make a table look complete would be the
single most dangerous thing in this document.

### Company licence is separate and also jurisdiction-scoped

Florida licenses the **dealer**, by class, by equipment type. A technician's
signature on a kitchen suppression system means little if the company holds no
permit covering it. So the company licence is a jurisdiction-scoped credential in its
own right, snapshotted alongside the individual's.

---

## 4. The check this makes possible — and why clients will pay for it

Because the audit already resolves a jurisdiction into
`code_basis.jurisdiction_resolved`, and credentials now carry a jurisdiction in the
**same vocabulary**, the system can ask a question no spreadsheet can:

> *Is this person credentialed in the jurisdiction this audit was judged against?*

Three outcomes:

| Signer's credential | Result |
|---|---|
| Matches the audit's jurisdiction, unexpired | `FIELD_VERIFIED` available |
| Portable (NICET) or out-of-state, unexpired | `FIELD_VERIFIED` only if the registry records that the jurisdiction accepts it — otherwise `DESK_REVIEW` |
| Expired, or `NONE` | `DESK_REVIEW` only (and see §5 — expired is blocked) |

So the product can say, on screen and on paper:

> *This audit was judged under the Florida Fire Prevention Code (FFPC), 8th Edition.
> The signer holds a California OSFM licence. Field verification is unavailable;
> recorded as desk review.*

**That is the wedge.** The good customers are multi-state contractors — two hundred
technicians across five states, a real compliance budget, and a problem nobody
solves well: *which of my people may sign in which state, and whose licence lapses
next month?* Inspect Point, BuildingReports and ServiceTrade concentrate on the
inspection form. None of them governs the credential behind the signature.

A licence-expiry dashboard is worth paying for on its own. Credential-aware sign-off
is a reason to switch.

### Why not defer this

The marginal cost today is one column and one registry file. Deferred, it is
unrecoverable for anything already signed — a signature stored without the
jurisdiction it was made in cannot have one inferred later.

This project has already met that exact wall once: migration 003 added `image_url`
to the India table, and the two existing `SITE-BAN-502` records have no evidence
photograph and never will, because the value was never captured. Signed records are
append-only by §5, so the same mistake there would be permanent and would sit inside
the legally meaningful part of the product.

---

## 5. Refuse to sign on an expired credential

The single most valuable control in this whole design.

An audit signed by an expired certificate is **worse than an unsigned one**,
because it looks valid. Nobody re-checks a signature.

- Expired → signing is **blocked**, with the expiry date shown
- Expiring within 30 days → signing allowed, warning shown, owner notified
- No expiry recorded → `FIELD_VERIFIED` unavailable; desk review only

An owner would rather have a technician blocked at 4pm on a Friday than discover a
year of records signed under a lapsed certificate.

---

## 6. Append-only. A signature is never edited or deleted

Two things must both be true: nothing is silently overwritten, and mistakes can be
corrected. That means a history table, not mutable columns.

**New table `field_audit_signoffs`** — one row per action, never updated:

```
id              bigserial PK
audit_id        text        -- FK to field_audit_us_logs.audit_id
action          text        -- CONFIRMED | REJECTED | SUPERSEDED
signoff_kind    text        -- DESK_REVIEW | FIELD_VERIFIED
actor_name      text        -- snapshot
actor_email     text        -- snapshot
credential_type text        -- snapshot
credential_no   text        -- snapshot
credential_expiry date      -- snapshot: what it was AT SIGNING
company_licence text        -- snapshot
attestation     text        -- the verbatim wording agreed to
reason_code     text        -- rejections only, see §7
notes           text
superseded_by   bigint      -- self-reference
created_at      timestamptz DEFAULT now()
```

The existing `signoff_status` / `signoff_by` / `signoff_at` columns on
`field_audit_us_logs` stay, denormalised to the **current** state so the records
list and `v_faus_awaiting_signoff` remain fast. The history table is the truth; the
audit row is the index.

**Permitted transitions:**

```
PENDING   → CONFIRMED       any credentialed user
PENDING   → REJECTED        any credentialed user, reason required
CONFIRMED → SUPERSEDED      supervisor only, or automatically on re-audit
REJECTED  → CONFIRMED       supervisor only, reason required
CONFIRMED → PENDING         NEVER
```

`SUPERSEDED` already exists in the `signoff_status` CHECK constraint from migration
001, which is the hook this design uses.

**Re-auditing supersedes automatically.** A new audit of the same `asset_tag` at
the same site should mark the prior sign-off `SUPERSEDED` rather than leaving two
live signatures on the same device.

---

## 7. Rejection is a first-class outcome, with a reason code

The model will be wrong. A technician must be able to say so, and that disagreement
is valuable in two directions.

For the technician: protection from being held to a finding they know is false —
*"the model read a reflection off the gauge glass as a needle in the red zone."*

For the owner: aggregated rejections show which checklist items produce false
positives. That is the only honest feedback loop this product has, and it is worth
more than any accuracy claim.

So rejection requires a structured `reason_code`:

- `FALSE_POSITIVE` — the finding is not present
- `WRONG_EQUIPMENT` — misclassified subject
- `IMAGE_INADEQUATE` — cannot be judged from this photograph
- `SEVERITY_DISPUTED` — present, but not at the severity assigned
- `CODE_BASIS_WRONG` — wrong jurisdiction or edition applied
- `ALREADY_REMEDIATED` — true when photographed, since fixed
- `OTHER` — free-text mandatory

Free-text notes are always available; the code is what makes it queryable.

---

## 8. Bulk sign-off: yes, but never for CRITICAL

An owner needs to clear thirty clean screenings without thirty clicks. An owner
must also never be able to rubber-stamp a blocked fire exit.

- `COMPLIANT` and minor-only `CONDITIONAL` → bulk desk review permitted
- Anything with a `CRITICAL` finding, or `impairment_suspected` → **one at a time,
  record opened, no exceptions**
- `FIELD_VERIFIED` is never bulk. Physical presence is per device by definition.

---

## 9. The pending queue is the owner's screen

An audit sitting `PENDING` is an unresolved liability. `v_faus_awaiting_signoff`
already exists in migration 001 for this.

Sorted worst-first: CRITICAL and overdue at the top, then by age. Ageing thresholds
should follow the existing SLA tiers — 0 h for critical, 72 h major, 30 d minor —
so the sign-off clock matches the remediation clock rather than inventing a second
one.

---

## 10. Roles

| Role | Can |
|---|---|
| `VIEWER` | read records, print |
| `TECHNICIAN` | run audits, desk review, field verify within credential, reject |
| `SUPERVISOR` | all of the above, plus supersede and override a rejection |
| `ADMIN` | manage accounts and credentials; **cannot sign** unless separately credentialed |

The last row is deliberate. Administering the system and attesting to a fire
inspection are unrelated competencies, and conflating them is how a signature loses
meaning.

**MFA required for anyone who can sign.** A legally meaningful signature behind a
single password is not defensible, and this is the point where the shared Basic-auth
credential must be retired for signing users.

---

## 11. Architecture

Per the agreed option B, with one refinement that falls out of §2.

```
Users, credentials, sessions   ->  managed Postgres reachable from Vercel (Neon / Vercel Postgres)
Audits + signoff history       ->  existing n8n Postgres on Oracle
```

Two databases, and **no cross-database foreign key is needed** — because §2
snapshots the signer's identity into the signoff row. That is not a workaround; it
is the legally correct arrangement. A signature that depends on joining a live user
table is a signature that changes when the user record changes.

- **Identity:** Auth.js in the Next app against the Vercel-reachable Postgres.
  Conventional, boring, well-trodden — which is what identity code should be.
- **Write path:** `POST /api/signoff` → new n8n workflow → `UPDATE
  field_audit_us_logs` + `INSERT field_audit_signoffs`. This is the **first write
  path in the system**; everything until now has been append-by-workflow or
  read-only. It must be parameterised, scoped to a single `audit_id`, and reject any
  transition not in §6's table.
- **Basic auth stays** as the outer gate during migration, then retires for signing
  users once accounts exist.

### Migration order

1. `CREDENTIAL_REGISTRY` — Florida verified, other states as flagged stubs. Pure
   data, no schema, independently reviewable. **Start here:** it is the piece §3
   and §4 depend on and the cheapest thing to get wrong now rather than later.
2. `field_audit_signoffs` table, with the jurisdiction-scoped credential snapshot
3. Users / credentials schema on the new database
4. Auth.js, login, MFA — no sign-off UI yet
5. The write workflow, exercised by curl
6. The jurisdiction-match check from §4, testable offline against the registry
7. Sign-off UI: single record first, then the pending queue, then bulk
8. Retire shared Basic auth for signing users

Steps 1–6 change nothing a user sees, which is the right shape for something this
consequential. Step 1 is also the only step that produces something worth showing a
prospective customer before any of it works — the credential registry *is* the
differentiator described in §4.

Steps 1–4 change nothing a user sees, which is the right shape for something this
consequential.

---

## 12. What prints

The attestation, verbatim, and never the word "certify" unless it is true:

> **Field verification** — *"I have physically inspected the equipment described in
> this record and confirm the findings stated. Signed under Florida fire equipment
> technician permit no. …, valid to …, on behalf of … (dealer licence no. …)."*

> **Desk review** — *"I have reviewed this automated screening and concur with its
> findings. This is a review of photographic evidence and does not constitute a
> firesafety inspection."*

Alongside: the signer's name, credential type and number, its expiry **as at the
date of signing**, the company licence, and the timestamp. A superseded signature
prints as superseded, with the date, rather than vanishing.

---

## 13. Open questions for the owner

1. **Do desk reviews get billed, and to whom?** It affects whether the queue needs
   per-customer attribution beyond `site_id`.
2. **Who supervises?** Is `SUPERVISOR` the owner alone, or per branch? Determines
   whether roles need an organisational scope from day one.
3. **Retention.** Florida record-keeping expectations for inspection records will
   set how long signoff history must be held, and whether it may ever be deleted
   (probably not).
4. ~~**Multi-state.**~~ **Resolved — see §3 and §4.** Credentials are
   jurisdiction-scoped from day one, reusing the same jurisdiction keys as
   `CODE_BASIS_REGISTRY`. Florida is seeded as verified; every other state is a stub
   flagged `requires_confirmation: true` rather than fabricated. The remaining work
   is per-state research, which is additive and safe — each state confirmed becomes a
   registry edit, not a schema change.
5. **India — researched, and the recommendation is "not yet".** See
   [IND_FIRE_AUDIT_WORKFLOW.md](IND_FIRE_AUDIT_WORKFLOW.md) §7.9. Maharashtra has a
   *stronger* hook than the US case — **Form B**, a half-yearly statutory compliance
   certificate signed by a Licensed Agency under the MFPLSM Act 2006 — so the
   eventual design is clearer there than here. Two reasons to hold:

   - The India workflow trusts the model's own `status` verbatim and aborts on a
     database failure (IND §7.1–7.3). Attaching a legal signature to a verdict a
     model revision could silently change is the wrong order of work.
   - The credential shape differs: Maharashtra licenses the **firm**, and the signing
     engineer's standing is a *qualification* (NFSC Nagpur, B.E. Fire, IFE India)
     rather than a personal licence number. §3's model accommodates this — the
     jurisdiction key would be `IN-MH` — but it needs the qualification-based variant
     designed, not assumed.

   Meanwhile the cheap credibility win is already taken: the dashboard now states the
   Maharashtra statute correctly rather than "NBC 2016 + CFO Mumbai norms".
