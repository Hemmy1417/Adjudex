# Agent Instructions — Build Adjudex on GenLayer StudioNet

> Filled from BUILD_TEMPLATE.md. [FIXED] sections carry judge standards S1–S30
> and are folded in as written; this spec adds the Adjudex-specific slots.

---

## Mission

Build **Adjudex**, a GenLayer StudioNet dApp where financial institutions turn a
service-level agreement into an instrument that adjudicates itself. A provider
(correspondent bank, payment processor, API operator) escrows a credit reserve
in GEN behind an SLA; the client files evidence-backed cases when service slips;
a GenLayer Intelligent Contract uses non-deterministic validator consensus to
judge whether the recorded month constitutes a contractual breach under the
agreement's own exception language — and deterministic code moves the credit.

This must be a real GenLayer-native project. Not a payment monitor with AI
wording. The core:

```text
SLA terms + committed evidence record → GenLayer panel findings
→ code-derived verdict (BREACHED / NOT_BREACHED / REVIEW_REQUIRED)
→ GEN service-credit settlement
```

The one-line pitch: a payment can settle in seconds; the dispute about who was
responsible should not take weeks.

---

## Mandatory Stack — [FIXED]

Next.js App Router, TypeScript, genlayer-js, GenLayer StudioNet, Vercel-ready
frontend, Python Intelligent Contract. No backend, no database, no auth vendor,
no other chain. Wallet = EIP-6963 injected discovery; the client performing
writes carries the connected provider (`createClient({chain, account, provider})`),
traced to the actual write path. No Tailwind (Factora precedent — hand CSS).

## Network Configuration — [FIXED]

```env
NEXT_PUBLIC_CHAIN_NAME=GenLayer StudioNet
NEXT_PUBLIC_CHAIN_ID=61999
NEXT_PUBLIC_GENLAYER_RPC_URL=https://studio.genlayer.com/api
NEXT_PUBLIC_GENLAYER_EXPLORER_URL=https://explorer-studio.genlayer.com
NEXT_PUBLIC_GENLAYER_CONTRACT_ADDRESS=
```

StudioNet: 30 req/min AND 500 req/hour per IP. Calm React Query defaults,
one paced same-origin /api/rpc proxy (gen_call + eth_getTransactionByHash only),
45–60s cached ticks, `unreachable` is its own read state.

---

## Product Name

```text
Adjudex
```

Tagline:

```text
Financial agreements that adjudicate themselves.
```

---

## Core Product

Adjudex has three main actions:

1. **Bind an SLA** — a provider creates the instrument with the agreement text,
   the service threshold, the per-period service credit, and funds the credit
   reserve in GEN; the client counter-signs to activate it. Terms are frozen at
   assent (sha256 on-chain).
2. **File a case** — for one service period the client commits the evidence
   record as canonical bytes (payment logs, exception records, outage notices,
   compliance holds — append-only versions, per-item sha256 + manifest root).
   The provider answers on-chain: acknowledge or dispute each item, and commit
   RESPONSE evidence of its own. The full obligation is reserved at case-open.
3. **Adjudicate and settle** — after the response window, anyone can call the
   panel. Validators independently read the frozen terms + the recorded
   snapshot and return findings only; pure code inside every validator derives
   the verdict and the credit. A finality window, a bonded challenge with
   snapshot-restore lapse, then permissionless settlement; parties claim from
   an internal ledger through the finalized-transfer proxy.

Terminal outcome: every case ends SETTLED or WITHDRAWN, every atto of the
reserve either returns to the provider or leaves to the client as a credit, and
the whole docket — terms hash, evidence digests, findings, verdict, consensus —
is a permanent public record.

---

## Pages To Build

```text
/               — cover: the instrument, live network stats, three actions
/create         — provider: draft + fund an SLA instrument
/instruments    — docket: all agreements (bounded index reads)
/i/[id]         — Instrument Room: terms, reserve, cases, role-gated verbs
/i/[id]/case/[cid] — Case File: evidence record, ack/dispute state, findings
                  sheet, verdict seal, challenge/settle actions
/rules          — how adjudication works, equivalence, windows, trust model
```

---

## Required UI Style

Not a SaaS layout. **Direction (user-supplied mid-build, replacing the
serif letterhead draft): onbeam.com — the Beam school.**

```text
White canvas, near-black ink #0d0d0d, quiet gray #868686 secondary text.
Weight-300 geometric sans at EVERY size (32→64px) with -0.02/-0.03em
tracking, sentence case. Radii 12/16/24px + full pills. Hairline #ececec
borders, shadows only on floating menus. The warm signal gradient
(#e63200 → #ff7a00 → #ffb300) RATIONED to: the hero media panel with its
gradient ring, one primary CTA pill, and verdict/ticker dots. Structure:
sticky header (striped-circle mark + lowercase wordmark + lowercase quiet
nav) · live on-chain ticker strip with colored dot bullets (Beam's news
ticker, fed by get_stats/get_agreements) · chip marquee · 4-up feature
grid · stat cards with big light figures.
```

Fonts:

```text
Display+Body: Poppins 300/400/500 (beamSansFont substitute)
Mono:         IBM Plex Mono (figures, ids, hashes)
```

Custom components:

```text
InstrumentSeal (stamped verdict mark) · DocketRow · EvidenceLedger ·
FindingsSheet · ReserveMeter · WindowClock · ActionCard (one verb, one button)
```

UI must clearly show: reserve custody, case reservations, consensus status,
verdict + derivation, claim state, explorer links.

### Layout rules — [FIXED]
(the full FIXED block from BUILD_TEMPLATE applies verbatim: tables for
comparables, numbers outweigh labels, categorical color only, one primary
action, whole addresses truncated by CSS + copy, min-width:0, price before the
control, deadlines state their consequence, review step before bonded writes,
loading/empty/unreachable as three states.)

---

## Contract Requirements

One contract. Name: `Adjudex` (`contracts/adjudex.py`).

Header (blank line after Depends is load-bearing):

```python
# v0.1.0
# { "Depends": "py-genlayer:1jb45aa8ynh2mbsyeyawtnnhgacfzbrn1jm0h9jgpk2xhkr52hqz2" }

# ADJUDEX — ...
```

Methods:

```text
create_agreement (payable: reserve) · cancel_agreement · accept_agreement ·
top_up_reserve (payable) · open_case · commit_evidence · review_evidence
(ack|dispute per item) · withdraw_case · adjudicate (nondet) · promote ·
challenge (payable bond, appends evidence) · lapse_challenge · settle ·
claim · begin_close · finalize_close
views: get_config · get_stats · get_agreement · get_case · get_evidence_page ·
get_assessment · agreements_of · cases_of · claimable_of
```

---

## Required Contract States

Agreement statuses:

```text
CREATED → ACTIVE → CLOSING → CLOSED         (cancel: CREATED → CANCELLED)
```

Case statuses:

```text
OPEN → PENDING_FINALITY → FINAL → SETTLED
       ↑ (re-adjudication after challenge)   OPEN → WITHDRAWN (client, pre-verdict)
FINAL --challenge--> CHALLENGED --adjudicate--> PENDING_FINALITY
CHALLENGED --stale lapse--> FINAL (restored snapshot, S29)
OPEN (abandoned 30d) --> WITHDRAWN (either party; reserve re-credited)
```

Verdicts (code-derived, never model-returned):

```text
BREACHED · NOT_BREACHED · REVIEW_REQUIRED
```

Findings vocab (model-returned): eligibility/lateness counts, excused
categories {COMPLIANCE_HOLD, INFRASTRUCTURE, DATA_GAP, OTHER_TERMS},
evidence ∈ {SUFFICIENT, PARTIAL, INSUFFICIENT}, conflicts (fixed vocab,
HARD/SOFT), score 0–100, reason.

**[FIXED] Terminal escape audit (S17/S26):** every non-terminal state names who
moves it and what happens if they never do — OPEN: client withdraws, or either
party closes after 30d idle; PENDING_FINALITY: anyone promotes after window;
FINAL: anyone settles after challenge window; CHALLENGED: anyone lapses after
stale window (restore + bond return); CLOSING: anyone finalizes after notice.
No state waits on a counterparty signature or an owner key.

---

## Contract Data Structures

Typed storage throughout (`@allow_storage` structs, TreeMap, DynArray, u256,
Address) — no JSON-in-string state. Every judged round records the findings +
the evidence version judged + digests; digests cover the exact stored bytes
(S21/S28).

```text
Agreement: id, provider, client, status, terms_text, terms_sha256,
  threshold_bps, credit_amount, reserve_free, reserve_held, windows
  (response, finality, challenge, stale, notice), created_at, counters
Case: id, agreement_id, period_label, status, opened_at, last_commit_at,
  evidence versions (items: id, kind, submitter, body bytes, sha256, ack_state),
  manifest_root per version, assessments (one per version: findings struct,
  derived verdict, judged_version, promoted_at, snapshot for S29),
  challenge (challenger, bond, filed_at), settled flags, ledger entries
```

---

## Payable GEN Movement — [FIXED]

```text
Provider funds the reserve at create (exact value) and may top up.
open_case debits credit_amount from reserve_free → reserve_held (S23 — a
  second case cannot pass a solvency check the first already consumed).
BREACHED settle: credit_amount → client ledger; reserve_held released.
NOT_BREACHED settle: reserve_held → reserve_free.
Challenge bond: max(5% of credit_amount, 0.05 GEN) exact; returned on lapse
  (S29) or when the challenge changes the verdict; else credited to the
  non-challenging party.
claim() is the SOLE exit: ledger zeroes → escrow decrements → _Payee proxy
  emit_transfer on="finalized".
Wei conservation asserted in tests: contract balance == reserve_free +
  reserve_held + unclaimed ledger, always.
No double claim. No settle twice (S24 atomic). No claim before settlement.
```

---

## Time and Deadlines — [FIXED]

The proven portfolio clock, copied not re-derived: three `/cdn-cgi/trace`
hosts (cloudflare.com, www.digitalocean.com, medium.com) → min of corroborated
readings, >300s disagreement → 0; eth blockscout block timestamp as a
one-directional floor (a block cannot be in the future; lag tolerated); two
keyless Beacon REST heads as an independent-mechanism ceiling (S20), fail
closed. Nondet clock reads use `prompt_comparative` with the ±300s principle,
parse first-digit-run. Windows are wall-clock (S13), stored anchors self-heal,
and every minimum window ≥ 3 × 300s (a window is armed by one reading and
closed by another — D−2e must be > 0). Defaults: response 1d, finality 1d,
challenge 1d, stale 1h, notice 3d; per-agreement overrides bounded
[900s, 30d].

---

## Non-Deterministic Review

`adjudicate` is the heart. Validators each: rebuild the prompt from the FROZEN
terms + the RECORDED evidence snapshot at the pinned version (S14 — never a
live refetch; there are no URL fetches in this contract at all), run the model,
parse findings, run `_derive_verdict` (pure code) on their own findings, and
compare against the leader's stored packet.

Evaluation points:

```text
which recorded payments were eligible under the terms · which late items fall
under the agreement's own exception language (fixed excuse vocabulary) · whether
the record is sufficient to establish the period at all · contradictions inside
the record (HARD vs SOFT, fixed vocab) · the provider's on-chain ack/dispute
posture (chain facts, told to the panel as party positions — S27)
```

Canonical JSON (model output — findings ONLY, no verdict, no amounts):

```json
{"eligible_total":0,"late_total":0,
 "excused":{"COMPLIANCE_HOLD":0,"INFRASTRUCTURE":0,"DATA_GAP":0,"OTHER_TERMS":0},
 "evidence":"SUFFICIENT|PARTIAL|INSUFFICIENT",
 "conflicts":[{"code":"...","severity":"HARD|SOFT"}],
 "score":0,"reason":"..."}
```

### Fail-safe — [FIXED]
[EXPECTED]/[EXTERNAL] deterministic · [TRANSIENT] agreed · [LLM_ERROR] →
validator DISAGREES (rotation), never raises. Malformed/unparseable findings at
the boundary → structural REVIEW_REQUIRED hold (S16), never a settlement.
Arming a window on an outage saves and returns.

---

## Equivalence Principle — [FIXED rules applied]

Fields the payout math reads: derived verdict (from findings, in code) and
credit_amount (a constant from the agreement — never model-produced). Pinned in
equivalence: **derived verdict EXACT**, evidence flag EXACT,
**leader-arithmetic recheck** (every validator re-derives the leader's verdict
from the leader's own stored counts deterministically — a leader whose numbers
don't produce their claimed verdict is refused), HARD conflict set exact (SOFT
free), on-time-rate bucket (50bps buckets) within ±1, score bucket (10s) ±1,
dossier structure (S21: judged version id, item count, each item's sha256 in
order — bytes already on-chain). Free to differ: reason prose, SOFT conflicts,
exact counts within the rate bucket.

---

## Structural Validation — [FIXED]

At the boundary, before anything touches state: enums membership-checked;
counts non-negative, excused ≤ late ≤ eligible, arithmetic must hold
(unexcused = late − Σexcused); score clamped 0–100; unknown keys ignored;
eligible_total == 0 with SUFFICIENT → inconsistent → REVIEW hold; any
INSUFFICIENT/PARTIAL evidence coerces every conclusive verdict to
REVIEW_REQUIRED inside the compared block (S22); validation failure → REVIEW
hold (S16), never a settlement.

---

## Evidence Integrity — [FIXED]

All evidence is committed canonical BYTES on-chain (no URLs anywhere) —
sanitized (`<<<` → `‹‹‹`, S19, applied to terms, items, and every party string
at prompt assembly; evidence fenced with the sanitized-away delimiter and
per-item sha256 headers). Per-item sha256 + per-version manifest root stored at
commit; adjudication and appeal read the recorded version only (S14);
challenges append a NEW version and are judged at it, with the pre-challenge
assessment snapshotted and restorable (S29). Item provenance labels
(CLIENT-DECLARED / PROVIDER-RESPONSE / PROVIDER-ACKNOWLEDGED /
PROVIDER-DISPUTED) are chain facts the panel is told (S27: the judged party's
counter-signature cannot be minted by the filer).

---

## Validation Rules

Reject:

```text
terms > 12000 chars · item body > 6000 chars · > 40 items per version ·
> 6 versions per case · period_label not ^[A-Z0-9-]{3,24}$ · duplicate period
per agreement · open_case when reserve_free < credit_amount (S23) ·
adjudicate before response window elapses (S2) · second adjudication of the
same evidence version (no re-roll) · challenge without bond or after window ·
settle before challenge window closes · any action from a non-party where a
role is required · accept by the provider's own wallet (self-dealing) ·
credit_amount == 0 · threshold_bps outside [5000, 10000] · windows outside
[900s, 30d]
```

---

## Frontend Contract Integration — [FIXED]
Full template block applies: five-phase tx lifecycle (signing → submitted →
confirming → reconciling → done) with per-write view predicates, ERROR receipts
surfaced by walking payload fields, three read states, no domain data in React
state, explorer links everywhere, accepted-vs-FINALIZED tracked (a write is
done when FINALIZED + leader_receipt[0] SUCCESS — SignalCourt/Factora tx.ts
ported). Write retries only when value == 0n.

---

## Demo Data

UI-seed only, never fake contract state: a worked example agreement in /rules
(Bank A ↔ Bank B, 95% / 30 min, 14,291 payments, 73 late, 11 compliance holds,
8 outage, 54 unexcused → BREACHED, 2% credit) rendered as an illustrated
walkthrough, clearly labelled illustrative.

---

## Important Build Warnings — [FIXED]
Template list verbatim. Plus: no AI-assistant attribution anywhere; keys only
in gitignored .env; python file writes must not CRLF-ify the contract
(normalize + .gitattributes); StudioNet arcs run SOLO with dev-server polling
killed.

---

## Narrative Honesty — [FIXED]
README claims only what the contract does. Known honest limits to state
plainly: evidence is party-committed bytes (authenticated provenance = wallet
signatures + counterparty ack/dispute, not bank-system attestation); StudioNet
finality ≈ 30s after ACCEPTED; the clock's 300s envelope; abandoned-case
closure returns the reserve to the provider after 30 idle days.

---

## Testing — [FIXED]

```bash
python -m pytest tests/direct -q
PYTHONUTF8=1 genvm-lint check contracts/adjudex.py --json
npx vitest run   # web: signed-write + predicates + finality fixtures
```

Direct suite must cover: every settlement branch, S22 coercion, S16 malformed
findings, S23 double-open race, S24 double-settle, S29 restore, S30
concurrency + post-terminal invariants, window enforcement incl. dead clock +
lagging explorer (fixture defaults chain_lag > tolerance, per-source skew),
bond routing every direction, index bounds, wei conservation. Then
mutation-check the suite (mutate.py, control included, one check per
mutation).

---

## Final Acceptance Checklist — [FIXED]
Template checklist verbatim, plus: deployed source byte-verified
(`genlayer code <addr>` diff), live arc driven with a real wallet before
"done", README verified-E2E block with real numbers, npm@10 lockfile, CI
green.

---

## README Must Explain
Template list; the Adjudex-specific ones: why adjudication (not execution) is
the hard problem in payments; the findings-only / code-derived-verdict design
and exactly which fields are pinned; the S23 reservation model; the challenge
economics; the trust model of party-committed evidence + counterparty
ack/dispute; the worked Bank A/B example; verified E2E transcript.

---

## Final Instruction

Build Adjudex like a serious GenLayer-native demo. The goal is to show that
GenLayer can settle what financial infrastructure cannot automate today: not
what happened, but what the agreement means about what happened — using the
recorded evidence and consensus-backed judgment.
