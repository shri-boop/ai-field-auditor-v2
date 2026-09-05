# Sign-off — design proposal

**Status: proposal, reviewed. Nothing here is built.** This exists to be argued with
before code is written, because sign-off is the first legally meaningful thing this
product will do.

> **Read [§14](#14-review--what-has-to-change-before-this-is-built) alongside §1–§13.**
> A review against the schema as it actually stands found three blockers — the
> signoff table cannot reference an India audit (§14.1), the firm-vs-individual
> distinction is structural rather than a field (§14.2), and §5's expiry control
> silently excludes every Indian signer (§14.3) — plus four gaps and one missed open
> question. The spine of the design survives the review; the sections below are not
> superseded, but §2, §5, §6, §11 and §12 each need the amendment §14 describes.

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

**New table `field_audit_signoffs`** — one row per action, never updated.

✅ **Built in migration 007.** The shipped schema, which differs from the sketch
this section originally carried in three ways — each explained below it:

```
id                          bigserial PK
region                      text   -- US | IND        ◀ added
audit_id                    text   -- no FK possible  ◀ changed
action                      text   -- CONFIRMED | REJECTED | SUPERSEDED
signoff_kind                text   -- DESK_REVIEW | FIELD_VERIFIED
audit_jurisdiction          text   -- §4: what the audit was judged against
eligibility_reason          text   -- §4: WHY this kind, not just which
signing_authority           text   -- §14.2: INDIVIDUAL | FIRM
actor_account_id            text   -- snapshot
actor_name                  text   -- snapshot
actor_email                 text   -- snapshot
actor_role                  text   -- snapshot
credential_jurisdiction     text   -- snapshot
credential_type             text   -- snapshot
credential_no               text   -- snapshot
credential_expiry           date   -- snapshot: what it was AT SIGNING
credential_expiry_semantics text   -- §14.3: EXPIRES | PERPETUAL | UNKNOWN
verification_method         text   -- §15: the substituted control, snapshotted
verified_by_name            text   -- §15
verified_at                 timestamptz
verification_review_due_at  timestamptz
firm_name                   text   -- §14.2
firm_licence_no             text   -- §14.2
firm_licence_expiry         date
firm_licence_category       text
attestation                 text   -- the verbatim wording agreed to
reason_code                 text   -- rejections only, see §7
notes                       text
supersedes                  bigint -- points BACKWARDS               ◀ inverted
bulk                        boolean
created_at                  timestamptz DEFAULT now()
```

**1. `supersedes` on the new row, not `superseded_by` on the old one.** The sketch
had both a `superseded_by` self-reference *and* "never updated". Those cannot both
hold — setting `superseded_by` on an existing row is an update. Inverting the
pointer makes append-only a property of the schema rather than a promise about how
callers behave. Current state comes from `v_signoff_current`.

**2. `region`, because the foreign key is not available.** US audits live in
`field_audit_us_logs` and India audits in `field_audit_logs`; one column cannot
reference two tables. `record_signoff()` checks the row exists in the right table
and refuses if it does not. Region is deliberately **not** inferred from the
`FA-US-` / `FA-IN-` prefix — deriving integrity from a string convention is the
kind of implicit coupling that breaks silently later.

**3. `company_licence` became four firm columns.** §14.2: under
`signing_authority = FIRM` the agency licence *is* the operative instrument, so it
needs its own expiry and category, not a single string.

Enforced in the schema rather than by convention: append-only via a trigger,
`CONFIRMED` requires attestation wording, `REJECTED` requires a reason code,
`FIELD_VERIFIED` requires `signing_authority`, and `FIELD_VERIFIED` can never be
`bulk` (§8).

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
001, which is the hook this design uses. Migration 007 gives India the same four
columns and the same CHECK, so one query shape serves both regions.

**Enforced in `record_signoff()`, not in the UI**, and enumerated positively —
anything not on the list is refused, so a status added later fails closed instead of
quietly becoming signable. `SUPERSEDED` is terminal: a re-audit mints a new
`audit_id`, so there is nothing to re-sign. `CONFIRMED → CONFIRMED` is refused too;
supersede first.

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

1. ✅ **SHIPPED** — `CREDENTIAL_REGISTRY` (`lib/credential-registry.mjs`, 80
   offline assertions). Florida verified, `IN-MH` and every other jurisdiction as
   flagged stubs. Pure data, no schema. `signing_authority` and `expiry_semantics`
   present from the first commit per §14.10.
2. ✅ **SHIPPED** — `field_audit_signoffs` (migration 007), with the
   jurisdiction-scoped credential snapshot, the §15 verification snapshot,
   append-only enforcement, `record_signoff()` for atomicity (§14.6), India's
   denormalised columns, and `scripts/db/007_verify.sql` to test it on the engine.
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

     **Amended by review.** The first of those two reasons to hold is now discharged:
     the India workflow derives its verdict in code and no longer aborts on a database
     failure (IND §7.1–7.3, shipped). The second is larger than "a variant": see
     §14.2. `signing_authority` has to be declared per jurisdiction because Florida
     and Maharashtra disagree about which credential is the licensed instrument, and
     §14.3 shows §5's expiry control has to be relocated onto the firm for India
     rather than applied to the engineer. Both belong in the registry schema from its
     first commit (§14.10).

   Meanwhile the cheap credibility win is already taken: the dashboard now states the
   Maharashtra statute correctly rather than "NBC 2016 + CFO Mumbai norms".


---

## 14. Review — what has to change before this is built

A read-through of §1–§13 against the schema as it actually stands, before step 1 of
§11's migration order starts. **The spine of this design is right and is not what
follows disputes.** Specifically: two kinds of sign-off, snapshot-not-reference,
jurisdiction-scoped credentials reusing `CODE_BASIS_REGISTRY` keys, registries with
honest `requires_confirmation` stubs, reason codes as the accuracy feedback loop, and
starting with the registry because it is the cheapest thing to get wrong now. Those
hold, and India strengthens rather than weakens them.

What follows is three blockers, four gaps, and one open question that was missed.

### 14.1 BLOCKER — `field_audit_signoffs` cannot reference an India audit at all

§6 declares:

```
audit_id        text        -- FK to field_audit_us_logs.audit_id
```

**India has no `audit_id`.** `field_audit_logs` is keyed on `id`, an integer serial,
and this is stated outright in `scripts/nodes/history_01_validate_query.js`:

> `audit_id` is a MINTED identifier and exists only on the US table. India has no
> such column — India records are identified by `site_id` and timestamp.

So the signoff table as designed can only ever hold US rows. The options are a
polymorphic reference (`region` + `audit_ref`), which pushes the problem into every
query, or **minting a real `audit_id` for India**, which is the right answer: it is
the same identifier shape the US already uses, it is what a Form B evidence pack has
to cite per finding, and `site_id` + a `text` timestamp is not a key.

This lands with the queued `audit_timestamp` migration (§14.8) because both rewrite
the same table and both are Form B prerequisites. Do them together, once.

### 14.2 BLOCKER — the firm-vs-individual distinction is structural, not a field

This is the one that most needs changing, and it is deeper than §3's closing
paragraph treats it.

§2 lists **"Company licence number"** as a field on the individual's account, and §3
adds that it is "separate and also jurisdiction-scoped". That models the firm licence
as an *accompaniment* to a primary individual credential. For Florida that is
correct: the individual holds the permit, the dealer permit qualifies it.

**Maharashtra inverts it.** The **Licensed Agency** is the licensed entity — licensed
by the Director of Maharashtra Fire Services, in categories by scope of work. The
signing engineer's standing is a *qualification* (B.E./Diploma Fire, NFSC Nagpur, IFE
India), not a personal licence number. The signature is the Agency's, prepared by a
qualified engineer.

So the two jurisdictions disagree about **which credential is load-bearing**, and no
amount of adding fields resolves that. The registry has to say which:

```
FL:
  signing_authority: INDIVIDUAL     # firm permit is a required accompaniment
IN-MH:
  signing_authority: FIRM           # engineer qualification is a required accompaniment
```

Three consequences that follow:

1. **The firm becomes a first-class entity, not a string.** It has its own licence
   number, its own expiry, and its own category limiting scope of work. A string
   field on a user cannot carry an expiry, and §5's control is an expiry check.
2. **Membership is a dated relationship.** A signature must snapshot *which agency,
   under which licence, the engineer signed on behalf of* — engineers change
   employer, and §2's own argument ("a record signed in 2026 must still show the
   credential as it stood in 2026") applies with equal force to the firm.
3. **Validity is evaluated per `signing_authority`.** Under `INDIVIDUAL`: the
   individual permit must be unexpired and the firm permit must cover the equipment
   class. Under `FIRM`: the Agency licence must be unexpired *and its category must
   cover the scope of work*, and the engineer must hold a recorded qualification.

Getting this wrong in either direction is bad in a specific way. Force India into the
individual-shaped model and every Indian signature misattributes statutory
responsibility to a person the Act does not license. Make everything firm-shaped and
Florida loses the individual permit that is the actual instrument there.

### 14.3 BLOCKER — §5 silently excludes every Indian signer

§5 is described as "the single most valuable control in this whole design", and it
ends:

> No expiry recorded → `FIELD_VERIFIED` unavailable; desk review only

An Indian fire engineer's qualification **has no expiry**. A B.E. in Fire
Engineering does not lapse; neither does an NFSC Nagpur qualification. Under the rule
as written, no Indian engineer could ever field-verify — not as a policy decision, but
as an accident of a US-shaped assumption about what a credential is.

The fix is to stop conflating *perpetual* with *unknown*, which are opposite
epistemic states:

| `expiry_semantics` | Meaning | §5 behaviour |
|---|---|---|
| `EXPIRES` | Has a renewal date (FL permit, CA licence) | Full §5: block on expired, warn at 30 days |
| `PERPETUAL` | Genuinely does not expire (a degree, NFSC) | No expiry check. Requires `evidence_on_file: true` instead |
| `UNKNOWN` | We have not recorded one | Desk review only — today's behaviour, correctly reserved for actual ignorance |

`PERPETUAL` must not be a free pass: it substitutes a different control (evidence of
the qualification on file, verified once) for a control that cannot apply. Otherwise
`PERPETUAL` becomes the value everyone selects to skip the expiry gate.

Note this also affects the **firm** side in Maharashtra, in the opposite direction:
the Agency licence *does* expire and *is* renewable, so under `signing_authority:
FIRM` the expiry control moves onto the firm — which is where §5's value actually
lands for India. §5 is not weakened by India; it is relocated.

### 14.4 GAP — Form B is a period artefact and there is nowhere to put it

§6 is one signoff row per audit. Form B is **one certificate per premises per
half-year, supported by many audits.** §7.9 of the India document notices the cadence
difference ("it should accumulate the half-year's audits for a premises into the
evidence that supports that period's Form B") but §6's schema has no entity for it.

These are two distinct levels of attestation and both are needed:

- **Per audit:** desk review or field verification. `field_audit_signoffs`, as designed.
- **Per premises per period:** the statutory certificate. Needs something like
  `compliance_periods` (jurisdiction, `site_id`, period `H1`/`H2` + year, status,
  artefact reference) and a link from the audits that constitute its evidence.

Collapsing them would mean either signing a period as though it were an audit, or
producing Form B with no record of what evidence it rested on — and the second is the
thing a customer is actually buying.

### 14.5 GAP — Form B's wording is prescribed; §12's model assumes we author it

§12 authors attestation wording, which is right for Florida: that text is ours, and
the discipline of never saying "certify" unless true is exactly correct.

Form B is different. It is a **form prescribed under the Rules 2009**. Its wording is
not ours to compose, and composing something that looks like it would be worse than
not offering it. So the model needs to distinguish:

- an **attestation we author** — Florida, wording under our control, §12 applies
- a **statutory form we populate** — Form B, wording fixed by rule, our job is
  correct population and an honest evidence pack

Until the prescribed text is obtained from a primary source, Form B support should
produce the *evidence pack* and stop short of rendering the form — the same
discipline as `edition_verified: false` on standard editions.

### 14.6 GAP — the write path will not be atomic as described

§11 describes the write as:

> `POST /api/signoff` → new n8n workflow → `UPDATE field_audit_us_logs` +
> `INSERT field_audit_signoffs`

Two n8n Postgres nodes are **two transactions**. If the first succeeds and the second
fails, the audit row says `CONFIRMED` while the history table — which §6 designates
as "the truth" — has no row for it. That is a signature that legally did not happen
and visibly did. The reverse order fails the other way.

This repo's prevailing pattern makes the risk worse rather than better: `LOG_Audit`
carries `onError: continueRegularOutput` precisely so a database failure cannot
discard a finding. That tolerance is correct for audit logging and **exactly wrong
here** — a sign-off that half-committed must fail loudly, not continue.

So the write must be a single statement: one `WITH ... AS (INSERT ...) UPDATE ...`,
or a stored function called once. And it needs the §6 transition table enforced
server-side, not just in the UI.

✅ **Closed in migration 007.** `record_signoff()` performs the history INSERT and
the audit-row UPDATE in one call and enforces §6's transitions, §10's roles, §8's
bulk rules and §5/§15's expiry controls. The workflow at step 5 calls it once and
passes parameters; it does not compose SQL, so it cannot get atomicity wrong.

A `jsonb` snapshot parameter carries the eighteen credential, firm and verification
fields. As positional arguments that is a signature nobody could call correctly from
n8n, and one transposed pair of strings would mis-record who signed — but every key
is destructured into a typed column, so storage stays strongly typed and queryable
while the transport stays loose enough to build in a Code node.

`v_signoff_expired_credential` exists to catch anything that bypasses the function
anyway. It should always return zero rows; a non-empty result means something wrote
to the table directly.

### 14.7 GAP — supersede-on-re-audit keys on a column India allows to be null

§6: "A new audit of the same `asset_tag` at the same site should mark the prior
sign-off `SUPERSEDED`."

India's `asset_tag` is optional — `VALIDATE_Input` emits `null` when it is absent.
With a null asset tag, that rule either matches nothing or matches every audit at
the site, and the second would supersede signatures on unrelated devices.

So either `asset_tag` becomes **required for any audit that can be signed** (defensible:
§7.9 already argues a site holds many devices and a site id alone cannot identify
what was inspected), or supersede scoping is declared explicitly and narrowly. The
first is preferable and is a small change to make now.

### 14.8 Queued, and their relationship to this design

Two cleanups agreed to be folded into the next relevant change rather than given
their own PR:

- **US `site_id` dead code.** `scripts/nodes/01_validate_input.js:138` still defaults
  `site_id` to `'UNKNOWN-SITE'`. Since `/api/audit` now rejects an empty `site_id`
  for both regions, that default is unreachable through the proxy. Remove it on the
  **next US workflow re-import** — not before, so the change ships with an import
  rather than sitting as a divergence between the artifact and the running workflow.
- **India `audit_timestamp` `text` → `timestamptz`.** This is a **prerequisite for
  Form B**, not a tidy-up. Form B is defined by a date range — H1 is January to June
  — and Postgres has no `text >= timestamptz` operator, so a half-yearly evidence
  pack cannot be selected from the column as it stands. §14.4's `compliance_periods`
  work is blocked on it.

  Do it in the same migration as §14.1's `audit_id`: same table, same rewrite, both
  Form B prerequisites, one re-import.

  **Both shipped in migration 006.** `audit_timestamp` is `timestamptz`, `audit_id`
  is minted by `VALIDATE_Input` as `FA-IN-…`, and rows predating the column were
  backfilled as `FA-INB-…` — the `B` marks an identifier derived retroactively by a
  migration rather than assigned when the photograph was judged, which is a weaker
  fact and is labelled rather than blended in. 006 also added
  `(site_id, audit_timestamp DESC)`, which is the only shape of query Form B asks:
  *this premises, this half-year.* §14.1 is therefore closed and §14.4's
  `compliance_periods` is unblocked.

### 14.9 Open question that was missed — India personal data

§13.3 asks about Florida retention. There is no India equivalent, and there needs to
be one, because §6 commits to append-only and §13.3 anticipates "probably never
deleted".

Storing an engineer's name, qualification, employer and signature history is personal
data under India's **Digital Personal Data Protection Act 2023**. Statutory retention
generally prevails over an erasure request, so the likely answer is that append-only
survives — but that is an assumption, and this document's own standard is that
assumptions about statute get verified against a primary source or flagged, not
asserted. It belongs in §13 as a question for counsel before India sign-off is built,
alongside who the data fiduciary is when the signing engineer is employed by a
customer's Licensed Agency rather than by us.

### 14.10 What this does to the build order

§11's step 1 — `CREDENTIAL_REGISTRY` first — is still right, and India makes the
argument stronger rather than weaker. But the registry's **schema** must carry
`signing_authority` and `expiry_semantics` from its first commit, even while only
Florida is seeded as verified.

That is §4's own "why not defer this" argument applied to itself: adding a field to a
registry is free today and unrecoverable for anything already signed. A signature
stored without knowing whether the individual or the firm was the licensed party
cannot have that inferred later, exactly as a signature stored without its
jurisdiction cannot.

Revised step 1, therefore: registry with Florida verified, `IN-MH` as a stub flagged
`requires_confirmation: true`, and both new fields present from the start. `IN-MH`
seeded as a stub is what proves the two-authority model actually holds before any of
it is load-bearing.


---

## 15. Verification provenance — resolving `evidence_on_file`

§14.3 proposed that a `PERPETUAL` credential substitutes `evidence_on_file: true`
for an expiry check. **As a boolean that is a softer version of the problem §5
exists to close**, and it does not survive the question "who set it, when, and can
that be audited?". An unaudited flag that unlocks field verification is worse than
no flag, for the same reason an expired signature is worse than an unsigned one: it
looks like a control.

Resolved, and built in step 1 rather than retrofitted.

### 15.1 A verification is itself an attestation

It is a claim by a named human that must remain true forever, which makes it the
same kind of object as a sign-off — so it obeys the same three rules §2 and §6
already establish:

| Rule | Consequence for verification |
|---|---|
| Attributable | names the person who performed it, not a system default |
| Snapshotted | captures the verifier's name as it stood, per §2 |
| Append-only | a re-verification is a new row; a verification is never edited, per §6 |

Concretely, replacing the boolean:

```
subject_account_id        whose credential this is
verified_by_account_id    who checked it
verified_by_name          snapshot, because §2 applies here too
verified_at               timestamptz
method                    enum, see §15.3
document_ref              pointer to the stored artefact
source_detail             which register was checked, or which document was seen
```

### 15.2 Separation of duties, and the self-verification bar

§10 already separates administering the system from attesting to an inspection:
`ADMIN` manages credentials and **cannot sign**. Verification is the mirror of
that — an `ADMIN` act, not a `TECHNICIAN` one.

And a holder may never verify their own credential. Without that single rule the
whole mechanism is theatre: anyone able to grant themselves
`evidence_on_file: true` has an expiry check they can switch off. Enforced in code,
not policy — `assessVerification` returns `SELF_VERIFIED` when the subject and the
verifier are the same account.

### 15.3 Method is graded, and sufficiency is a jurisdiction's judgement

"I looked at a scan" and "I checked the issuing authority's register" are not the
same evidence and should not produce the same permission.

| Method | Rank | Is it verification? |
|---|---|---|
| `SELF_DECLARED` | 0 | **No** — recorded so it can be refused |
| `SCANNED_COPY` | 1 | Yes |
| `CERTIFIED_COPY` | 2 | Yes |
| `ORIGINAL_DOCUMENT_SEEN` | 3 | Yes |
| `PRIMARY_SOURCE_REGISTER` | 4 | Yes |

`SELF_DECLARED` exists precisely to be rejected. It is not weak verification, it is
the absence of it — and storing it explicitly is more honest than an empty field,
because "nobody has checked this" is a fact worth keeping.

Each jurisdiction sets `minimum_verification_rank`, because sufficiency is a
per-jurisdiction call and belongs in registry data like everything else. Florida's
floor is `SCANNED_COPY`; **`IN-MH`'s is `CERTIFIED_COPY`**, deliberately higher —
there the verification is doing the work an expiry date would otherwise do, so it
has to carry more weight.

### 15.4 The answer to "isn't this still just a flag?": the expiry moves, it does not vanish

This is the part that makes `PERPETUAL` safe. The **credential** does not expire.
**Our confidence in the record does.**

So every verification carries a review date, derived from the jurisdiction's
`verification_review_months` (Florida 12, `IN-MH` 24). When it lapses the
credential falls back to `DESK_REVIEW` — exactly as an expired credential would.

§5 is therefore not weakened for perpetual credentials and not skipped: **the same
gate fires, reading a different date.** A qualification verified once in 2026 and
never revisited does not stay eligible; it goes `VERIFICATION_STALE` and appears in
the same §5 dashboard as an expiring licence.

That is what stops `PERPETUAL` becoming the value everyone selects to escape the
expiry gate — selecting it does not remove a date, it exchanges one date for
another that someone must actively maintain.

### 15.5 Nothing is verified by omission

Absent verification fails closed (`VERIFICATION_ABSENT`), mirroring
`edition_verified: false` and `requires_confirmation: true`: this codebase does not
treat silence as assurance.

### 15.6 What step 1 actually shipped

`lib/credential-registry.mjs` and `scripts/test_credentials.mjs` — **80 offline
assertions**, no database, no network, no n8n, asserted as such by section 9 of the
suite.

- `signing_authority` and `expiry_semantics` present from the first commit, per
  §14.10
- Florida seeded verified; **statute references confirmed, renewal intervals and
  dealer class-to-equipment mappings explicitly not**, each carrying
  `requires_confirmation: true` at the level it appears
- `IN-MH` seeded as a stub — which is what proves the `FIRM` path holds before
  anything depends on it, rather than letting it rot untested until the first
  Indian customer
- Registry keys identical to `CODE_BASIS_REGISTRY`, asserted in the suite, so §4
  needs no translation layer
- A stub jurisdiction can never yield `FIELD_VERIFIED` — it returns
  `JURISDICTION_UNCONFIRMED`

Deliberately **not** built: the n8n copy. It is needed at step 6, and when it is,
generate it from this file with a `--check` rather than hand-copying. A second
hand-maintained copy of licensing data is the same class of divergence as renaming
a node in the n8n UI.

---

## 16. The SQL in 007 was not run by its author

Worth stating plainly, because every other decision-making component in this
repository ships with an offline suite and this one does not.

No Postgres was available in the environment migration 007 was written in — no
`psql`, no client library, and the container registries are unreachable, so a
throwaway instance was not an option either. Nothing about the migration was
executed before it was committed.

Two things were done about that rather than none.

**`scripts/db/007_verify.sql`** exercises the migration on the real engine and
prints PASS or FAIL per assertion: every transition in §6, the role rules in §10,
the bulk rules in §8, the expiry and verification gates from §5 and §15, the
append-only trigger, and the constraint-level guards. It also proves the gate
*opens* — a valid desk review, a valid field verification, and a CRITICAL audit
signed individually — because a suite that only tests refusals would pass just as
happily if the feature were entirely unusable.

It runs inside a transaction ending in `ROLLBACK`, uses `FA-VERIFY-` prefixed
scratch rows, and never modifies a pre-existing row, so it is safe against
production.

**`scripts/test_signoff_sql.mjs`** (96 assertions) is the weaker guard that runs
offline. It does *not* execute SQL and says so in its header and its final line. What
it does is assert that the rules in the SQL still match the rules in this document
— §7's reason codes, §15.3's method ladder, the transition list, the append-only
trigger, the absence of a `superseded_by` column — which is the thing most likely to
drift silently as either file changes.

The distinction matters: a green `test_signoff_sql.mjs` is **not** evidence that
sign-off works. Only `007_verify.sql` is, and it has to be run against the box.
