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
| Expiry date | the control that matters — see §4 |
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

## 3. Credential types Florida actually cares about

Not free text. An enumeration, because the type determines what the signature can
support:

| Type | Basis | Can `FIELD_VERIFIED`? |
|---|---|---|
| `FIRESAFETY_INSPECTOR` | certified under **s. 633.216, F.S.** | Yes — including statutory firesafety inspections |
| `FIRE_EQUIPMENT_TECHNICIAN` | individual permit under Ch. 633, Part V | Yes, for equipment within the permit class |
| `NICET_LEVEL_II` … `IV` | NICET certification | Yes, per level and subfield |
| `TRAINED_PERSON` | NFPA 10 "trained person" | Desk review only |
| `UNCREDENTIALED` | none recorded | Desk review only |

The last two are the honest default. Someone with no recorded credential can still
triage, and the record will say exactly that.

**Company licence matters separately.** Florida licenses fire equipment dealers by
class (A/B/C/D) by equipment type. A technician's signature on a suppression system
means little if the company holds no permit covering it, so the company licence is
snapshotted alongside.

---

## 4. Refuse to sign on an expired credential

The single most valuable control in this whole design.

An audit signed by an expired certificate is **worse than an unsigned one**,
because it looks valid. Nobody re-checks a signature.

- Expired → signing is **blocked**, with the expiry date shown
- Expiring within 30 days → signing allowed, warning shown, owner notified
- No expiry recorded → `FIELD_VERIFIED` unavailable; desk review only

An owner would rather have a technician blocked at 4pm on a Friday than discover a
year of records signed under a lapsed certificate.

---

## 5. Append-only. A signature is never edited or deleted

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
reason_code     text        -- rejections only, see §6
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

## 6. Rejection is a first-class outcome, with a reason code

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

## 7. Bulk sign-off: yes, but never for CRITICAL

An owner needs to clear thirty clean screenings without thirty clicks. An owner
must also never be able to rubber-stamp a blocked fire exit.

- `COMPLIANT` and minor-only `CONDITIONAL` → bulk desk review permitted
- Anything with a `CRITICAL` finding, or `impairment_suspected` → **one at a time,
  record opened, no exceptions**
- `FIELD_VERIFIED` is never bulk. Physical presence is per device by definition.

---

## 8. The pending queue is the owner's screen

An audit sitting `PENDING` is an unresolved liability. `v_faus_awaiting_signoff`
already exists in migration 001 for this.

Sorted worst-first: CRITICAL and overdue at the top, then by age. Ageing thresholds
should follow the existing SLA tiers — 0 h for critical, 72 h major, 30 d minor —
so the sign-off clock matches the remediation clock rather than inventing a second
one.

---

## 9. Roles

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

## 10. Architecture

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
  transition not in §5's table.
- **Basic auth stays** as the outer gate during migration, then retires for signing
  users once accounts exist.

### Migration order

1. `field_audit_signoffs` table + the India equivalent
2. Users / credentials schema on the new database
3. Auth.js, login, MFA — no sign-off UI yet
4. The write workflow, exercised by curl
5. Sign-off UI: single record first, then the pending queue, then bulk
6. Retire shared Basic auth for signing users

Steps 1–4 change nothing a user sees, which is the right shape for something this
consequential.

---

## 11. What prints

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

## 12. Open questions for the owner

1. **Do desk reviews get billed, and to whom?** It affects whether the queue needs
   per-customer attribution beyond `site_id`.
2. **Who supervises?** Is `SUPERVISOR` the owner alone, or per branch? Determines
   whether roles need an organisational scope from day one.
3. **Retention.** Florida record-keeping expectations for inspection records will
   set how long signoff history must be held, and whether it may ever be deleted
   (probably not).
4. **Multi-state.** The credential enumeration in §3 is Florida-shaped. California
   licenses extinguisher servicing through the OSFM; other states differ. Worth
   deciding now whether credentials are per-state from the start, since retrofitting
   that is painful.
5. **India.** `field_audit_logs` has no sign-off columns at all. Does India need
   sign-off, and under what credential — CFO Mumbai licensing is a different regime
   entirely.
