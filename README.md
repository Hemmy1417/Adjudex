<p align="center">
  <img src="https://raw.githubusercontent.com/Hemmy1417/Adjudex/main/web/app/icon.svg" width="140" alt="Adjudex mark" />
</p>

# Adjudex - Financial Adjudication Infrastructure

**Financial agreements that adjudicate themselves.**

A payment settles in seconds; the dispute about who was responsible takes weeks. Adjudex escrows a service credit behind an SLA, records the service period as evidence on-chain, and puts the breach question to a GenLayer validator panel that reads the agreement's own exception language. The panel judges - deterministic contract code moves the money.

Contract: [`0xDFA6B51565e17B677085351303F8397cd28Cb54D`](https://explorer-studio.genlayer.com/address/0xDFA6B51565e17B677085351303F8397cd28Cb54D) on GenLayer StudioNet.

## What it is

- **An SLA as an instrument** - a provider drafts the terms (threshold, per-period credit, exception language) and funds a credit reserve in the same signature; the client counter-signs, and the terms freeze under a sha256 at mutual assent.
- **A case as a record** - for one service period the client commits evidence as canonical bytes on-chain: payment logs, exception records, outage notices. Append-only, hashed item by item into a manifest root. The full period credit is reserved the moment the case opens.
- **A counterparty with a voice** - the provider answers each item with its own wallet: acknowledge, dispute, or commit a response into the same record. These are the chain facts the panel is told - the one posture the filing party cannot manufacture.
- **A panel that judges and code that decides** - validators independently count the record under the frozen terms and return findings only. Pure code inside every validator derives the verdict identically; the model never returns a verdict and never touches an amount.
- **Settlement with exits everywhere** - finality windows, a bonded challenge judged on an appended record version, a stale-challenge lapse that restores the exact snapshot, permissionless settle, and a pull-payment claim as the only external value path.

## How it works

**For a provider (correspondent bank, processor, API operator)**

1. Draft the instrument: client wallet, terms text, threshold (basis points), per-period credit, windows - and escrow the reserve in the same payable call.
2. Answer a filed case on-chain: acknowledge or dispute individual items, commit `response` evidence of your own.
3. Challenge a verdict you can contradict - a bond and new material reopen the question in front of a fresh panel.
4. Recover the reserve through close-out: an enforced notice window, then permissionless release of the free reserve once every case is settled or withdrawn.

**For a client (the institution buying the service)**

1. Counter-sign the instrument. Your wallet is the identity the credit pays.
2. Open a case for a service period - one per period, and the full credit is reserved from the free reserve at that moment (a second case cannot pass a solvency check the first consumed).
3. Commit the period's evidence as bytes. Every commit restarts the response window, so the provider always has answer time.
4. After adjudication, promotion and the challenge window: settle (anyone can), and claim the credit if the period was BREACHED.

## Verdicts

| Verdict | Meaning | Money |
|---|---|---|
| `BREACHED` | The on-time rate on eligible payments, after the terms' own exceptions, fell below the agreed threshold | The exact agreed credit moves to the client's claimable balance |
| `NOT_BREACHED` | The period met the threshold | The reservation returns to the provider's free reserve |
| `REVIEW_REQUIRED` | The record could not establish the period (insufficient evidence, unresolved contradictions, or zero eligible payments) | Nothing moves; the case reopens for more evidence |

## Lifecycle

```text
Agreement:  CREATED --accept--> ACTIVE --begin_close--> CLOSING --finalize--> CLOSED
                \--cancel--> CANCELLED

Case:       OPEN --adjudicate--> PENDING_FINALITY --promote--> FINAL --settle--> SETTLED
             |        (REVIEW_REQUIRED promotes back to OPEN)     |
             |--withdraw/abandon--> WITHDRAWN                     |--challenge--> CHALLENGED
                                                                       |--re_adjudicate--> PENDING_FINALITY
                                                                       \--lapse (stale)--> FINAL (snapshot restored)
```

Every non-terminal state has a permissionless or single-party exit: promotion, settlement, re-adjudication and close-out finalization are anyone's to call; a stale challenge lapses on any party's signature; an idle open case releases its reservation after the abandon window.

## GenLayer consensus functions

| Function | Kind | What runs under consensus |
|---|---|---|
| `adjudicate` / `re_adjudicate` | non-deterministic write | Every validator rebuilds the prompt from the frozen terms + the recorded evidence version, runs the model for findings (counts, excused categories, evidence flag, conflicts, score), derives the verdict in pure code, and compares against the leader's packet |
| `_utc_now` (internal) | non-deterministic read | Three `cdn-cgi/trace` hosts (min, mutual divergence refused), an execution-layer block as a one-directional floor, two beacon heads as an independent-mechanism bound in both directions; fails closed to 0 |

**The equivalence rule.** Pinned exactly: the code-derived verdict, the evidence flag, the hard-conflict set, and the leader's own arithmetic (every validator re-derives the leader's verdict and rate from the leader's stored counts - a leader whose numbers do not produce their claimed verdict is refused). Pinned to a bucket: the on-time rate (50 bps) and the score (10 points), each within one adjacent bucket. Pinned structurally: the dossier rows - ids, kinds, submitters, ack states, and each row's sha256 covering the exact bytes stored (all evidence is committed bytes, so there is exactly one honest excerpt per row). Free to differ: the reasoning prose, soft conflict codes, counts within the rate bucket.

**Fail-safe.** A malformed or arithmetically impossible model answer raises inside the judged block and validators disagree - the round rotates instead of settling. An evidence flag below SUFFICIENT coerces every conclusive verdict to REVIEW_REQUIRED inside the compared block, and the promoter refuses a conclusive verdict over a thin record again at the boundary.

## Contract

| | |
|---|---|
| Network | GenLayer StudioNet |
| Chain id | 61999 |
| RPC | `https://studio.genlayer.com/api` |
| Explorer | [explorer-studio.genlayer.com](https://explorer-studio.genlayer.com/address/0xDFA6B51565e17B677085351303F8397cd28Cb54D) |
| Address | `0xDFA6B51565e17B677085351303F8397cd28Cb54D` |
| Source | [`contracts/adjudex.py`](contracts/adjudex.py) - deployed source byte-verified against this file |

### Write methods

| Method | Who | Payable | Notes |
|---|---|---|---|
| `create_agreement` | provider | reserve (>= one credit) | terms frozen + hashed; client named |
| `cancel_agreement` | provider | - | CREATED only; reserve to ledger |
| `accept_agreement` | named client | - | mutual assent; CREATED -> ACTIVE |
| `top_up_reserve` | provider | amount | grows the free reserve |
| `open_case` | client | - | debits one full credit into the case reservation (S23); one case per period |
| `commit_evidence` | either party | - | append-only versions; provider commits kind `response`; restarts the response window |
| `review_evidence` | provider | - | ACK / DISPUTE per client item, on-chain |
| `withdraw_case` | client | - | OPEN only; reservation returns |
| `abandon_case` | anyone | - | after 30 idle days; reservation returns |
| `adjudicate` | anyone | - | after the response window; one judgment per evidence version |
| `promote` | anyone | - | after the finality window; REVIEW reopens the case |
| `challenge` | either party | exact bond | 5% of credit, 0.05 GEN floor; appends a new evidence version; snapshots state |
| `re_adjudicate` | anyone | - | judges the challenge version; routes the bond by whether the verdict changed |
| `lapse_challenge` | anyone | - | after 1h stale; restores the snapshot exactly; returns the bond |
| `settle` | anyone | - | after the challenge window; atomic; BREACHED credits the client |
| `begin_close` / `finalize_close` | party / anyone | - | enforced notice window; needs zero open cases; releases the free reserve |
| `claim` | anyone with a balance | - | the only external value path; ledger zeroed, then transfer on finality |

### Read methods

`get_config` · `get_stats` · `get_agreement` · `get_agreements` (paged) · `get_agreements_for` · `get_case` · `get_cases_for` · `get_evidence` · `get_assessment` · `get_acks` · `get_claimable`

### Consensus guarantees

- The verdict and the rate are derived by identical code inside every validator from findings the equivalence rule constrains - never taken from a model.
- The credit is a constant from the instrument. No model-produced number is ever multiplied into a transfer.
- The dossier a later reader relies on is compared row by row, digest by digest, at judgment time (and a challenge is judged on an appended version, with the pre-challenge state snapshotted and restorable).
- Wei conservation is a tested invariant: contract custody always equals reserves plus unclaimed ledger balances plus undecided bonds.

## Verified end-to-end

Driven on-chain against `0xDFA6B51565e17B677085351303F8397cd28Cb54D` on 2026-09-02 with three real wallets (provider `0x86dD…18b5`, client `0x57a7…657C`, and a stranger for every permissionless call). Every step below finalized on StudioNet; hashes are in the repo's arc log.

```text
ACT I — BIND
  create_agreement   0.15 GEN reserve escrowed · 95.00% threshold · 0.05 GEN credit/period
                     tx 0xe5976a88…4199 -> instrument adx-000001
  accept_agreement   client counter-signs; terms frozen (sha256 on-chain)

ACT II — THE RECORD (period 2026-08)
  open_case          case-000001 · S23 visible on-chain: reserve free 0.10 / held 0.05
  commit_evidence    3 client items (payment log 100/10 late · screening records · outage INC-88)
  review_evidence    provider ACKs EV-002 and EV-003 with its own wallet
  commit_evidence    provider response: "seven have no recognised exception"

ACT III — SEVEN WALLS, ALL REFUSED ON-CHAIN (finalized as ERROR)
  adjudicate before the response window closed
  open_case for the same period twice
  commit_evidence from a stranger wallet
  settle while the case was OPEN
  settle inside the challenge window
  settle twice
  challenge after settlement

ACT IV — PANEL #1 (five validators, record v2)
  verdict BREACHED · rate 93.00% vs 95.00% · eligible 100 · late 10
  excused: 2 COMPLIANCE_HOLD + 1 INFRASTRUCTURE · evidence SUFFICIENT · score 90
  promote -> FINAL

ACT V — THE BONDED CHALLENGE
  challenge          provider posts exactly 0.05 GEN + telemetry export (record v3)
  re_adjudicate      PANEL #2: BREACHED UPHELD · rate 93.00% · SUFFICIENT
                     the failed bond routes to the client's ledger (deterministic)
  promote -> FINAL

ACT VI — SETTLE, CLOSE, DRAIN
  settle             BREACHED -> 0.05 GEN credit to the client's ledger
  begin_close        notice window enforced, then
  finalize_close     0.10 GEN free reserve released to the provider
  claim x2           client 0.10 GEN (credit + won bond) · provider 0.10 GEN
                     both transfers ride on="finalized"

FINAL STATE
  stats  {"agreements":1,"cases":1,"settled":1,"breached":1,"escrow_atto":"0"}
  agreement CLOSED · reserve free 0 · held 0
  CUSTODY ZERO — every atto in, accounted out
```

The panels reasoned, not pattern-matched. Panel #1, verbatim:

> EV-001 establishes 100 eligible payments and 10 late; EV-002 (acknowledged) covers TXN-0041 and TXN-0102 as COMPLIANCE_HOLD; EV-003 (acknowledged) covers TXN-0177 as INFRASTRUCTURE; EV-004 confirms the remaining seven have no recognized exception.

Panel #2 weighed the provider's challenge against the provider's own record — and still flagged the telemetry discrepancy as a soft conflict rather than ignoring it:

> The client record (EV-001) identifies 10 late payments, which the provider acknowledges in EV-004 while admitting 7 have no valid exception. A TIMESTAMP_CONTRADICTION exists in EV-005 regarding TXN-0203 and TXN-0311, but the provider's admission of 7 unexcused late payments in EV-004 supports the client's log of 10 total late events (3 excused + 7 unexcused).

Test counts behind the run: 114 direct tests, 41/41 mutation guards killed (control green), 29 web tests, genvm-lint clean.

### Arc II — the paths the first run never took

A second full run on the same contract (2026-09-02, `arc2.log` + `arc2.transcript.json` in the repo) drove every remaining feature:

```text
ACT I    draft instrument -> stranger's counter-sign REFUSED -> cancelled, reserve to ledger
ACT II   case A opens (S23 debit: free 0) -> second period REFUSED against the empty
         reserve -> top_up_reserve recovers it -> case B opens -> withdrawn, reservation back
ACT III  thin record ("no log yet") -> PANEL: REVIEW_REQUIRED, INSUFFICIENT, eligible 0
         -> promotion REOPENS the case, reservation still held: the hold pays nobody
ACT IV   full record (100 eligible, 2 late, both acknowledged compliance holds)
         -> PANEL: NOT_BREACHED, rate 100.00% vs 95.00%, SUFFICIENT, score 97 -> FINAL
ACT V    client challenges (0.05 GEN bond, record v4) and goes silent -> early lapse
         REFUSED -> after the 1h stale window, a stranger's lapse_challenge restores the
         S29 snapshot exactly (FINAL, NOT_BREACHED, record back to v3) and returns the bond
ACT VI   settle: NOT_BREACHED returns the reservation to the provider (no credit paid)
         -> close-out notice -> finalize_close -> both claims -> escrow_atto 0

FINAL    stats {"agreements":3,"cases":3,"settled":2,"breached":1,"escrow_atto":"0"}
         CUSTODY ZERO, second time — twelve refusal walls held across the two arcs
```

Between the two arcs every write method has been driven on the live network except `abandon_case`, whose 30-idle-day window cannot elapse in a live session — it is covered by the direct suite instead.

## Tech stack

| Layer | Choice |
|---|---|
| Contract | Python GenLayer Intelligent Contract, pinned `py-genlayer` runner |
| Frontend | Next.js App Router, TypeScript, hand-rolled CSS (no framework) |
| Chain access | genlayer-js 1.1.8; EIP-6963 wallet discovery; provider-backed write client |
| RPC discipline | same-origin `/api/rpc` proxy - allowlisted reads, paced to StudioNet's 30/min budget, coalescing cache |
| Tests | pytest direct suite (114) + mutation sweep (41/41 killed) + vitest web suite (29) |

## Repository

```text
contracts/adjudex.py        the intelligent contract
tests/direct/               direct-mode suite against a strict consensus stub
tests/mutation_sweep.py     break-each-rule sweep; a surviving mutant is an unpinned rule
web/                        the Next.js app (docket, instrument room, case file)
web/scripts/arc.mjs         the live end-to-end proof arc
docs/                       architecture, adjudication, security, deployment
```

## Getting started

```bash
# contract tests
python -m pytest tests/direct -q
PYTHONUTF8=1 genvm-lint check contracts/adjudex.py --json

# web
cd web
npm install
cp .env.example .env.local   # set NEXT_PUBLIC_CONTRACT_ADDRESS
npm run test && npm run typecheck && npm run build
npm run dev
```

## Security

- No owner. The deployer holds no key that can move an escrowed atto, alter an assessment, or unblock a settlement.
- One external value path (`claim`), pull-payment, state zeroed before the transfer is emitted, transfer rides `on="finalized"` through an empty contract-interface proxy (the supported EOA shape).
- Exact-amount payables everywhere: a wrong reserve, bond or top-up is refused, never partially absorbed.
- Every party string is sanitized before prompt assembly (both fence delimiters), so every intact fence in a panel prompt was emitted by the contract - a forged "evidence block" inside a committed document is visibly defused and weighs against its author.
- The subject of the judgment does not control the record alone: provider acknowledgements and disputes are wallet-signed chain facts, and a provider dispute the record cannot resolve surfaces as a conflict the derivation counts.

## Design notes

- **Findings-only adjudication.** Asking five models to word-match a verdict is how rounds die UNDETERMINED. Each validator's model counts; each validator's code decides; the comparison then demands exact agreement on the derived fields and tolerance on the raw counts.
- **Reservation at open, not at settlement.** The solvency check debits. N concurrent cases cannot pass against the same unreserved pool.
- **Windows are wall-clock under a consensus clock** with a ±300s envelope; every window minimum is three envelopes wide, so a window armed by one reading and closed by another still guarantees usable real time.
- **The evidence is bytes, not links.** Nothing the panel reads can be edited after commitment; challenges append rather than replace; the lapse path restores the exact snapshot taken at filing.

## Honest limitations

- Evidence provenance is wallet signatures plus counterparty answers - not bank-system attestation. The panel is told exactly which items are one party's claim and weighs a single-voice record accordingly; it cannot verify the world outside the record.
- An idle open case returns its reservation to the provider after 30 days. A client who wants the period judged keeps the case alive by committing evidence.
- StudioNet applies rate limits (30 requests/min, 500/hour per IP); the app's proxy paces within them, and heavy concurrent use degrades to honest "catching up" states rather than failures.
- The close-out path can strand a REVIEW-looping case at the version cap: after 6 evidence versions the case can only be withdrawn or abandoned. Documented as designed - a record that cannot convince a panel in six attempts is a dispute for another forum.

## Disclaimer

Adjudex is a StudioNet demonstration of adjudication infrastructure, not a production financial service. The instrument, the panel and the credits are real on-chain mechanics on a test network; nothing here is legal or financial advice, and no real-world payment obligations are created by using it.
