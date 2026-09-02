# Architecture

One intelligent contract, one Next.js app, no backend. The contract is the
system of record; the app is a reader with a wallet.

```text
web (Next.js, Vercel)                    GenLayer StudioNet
┌───────────────────────────┐            ┌──────────────────────────────┐
│ pages: cover · docket ·   │  reads     │ Adjudex (contracts/adjudex.py)│
│ instrument room · case    │──────────► │  agreements · cases ·        │
│ file · rules              │ /api/rpc   │  manifests · assessments ·   │
│                           │  (paced    │  acks · claimable ledger     │
│ wallet (EIP-6963,         │   proxy)   │                              │
│ provider-backed client)   │  writes    │  adjudicate / re_adjudicate  │
│                           │──────────► │  = validator panel rounds    │
└───────────────────────────┘  signed    └──────────────────────────────┘
```

## The contract's shape

- **Typed storage.** `Agreement` and `Case` are `@allow_storage` dataclasses in
  `TreeMap`s; evidence manifests and assessment dossiers are canonical-JSON
  strings keyed `"{case}|{version}"`. Indices (`case_index`, `actor_index`,
  `period_registry`, `agreement_ids`) keep every view a bounded read — no view
  scans an unbounded map.
- **No owner.** `__init__` sets counters. There is no privileged key anywhere
  in the contract.
- **Money.** One escrow counter (`escrow_atto`), per-agreement `reserve_free` /
  `reserve_held`, per-case `reserved_atto`, and a `claimable` pull-payment
  ledger. `_credit()` is the only way value is allocated; `claim()` is the only
  way it leaves, through an empty `@gl.evm.contract_interface` proxy with
  `on="finalized"`. Invariant (tested): custody = reserves + ledger + open
  challenge bonds.
- **The clock.** `_utc_now()` runs under consensus: three `cdn-cgi/trace`
  hosts (min of corroborated readings; >300s mutual divergence fails closed),
  an execution-layer block timestamp as a one-directional floor, and two
  keyless beacon-chain heads as an independent-mechanism bound in both
  directions. Validators agree on the epoch by integer tolerance, never prose.
  Every window minimum is 3 × the 300s envelope.

## The panel round

`_panel_round` is the heart. For a pinned evidence version:

1. Storage is read into locals **before** the nondet closures (storage handles
   do not cross the boundary).
2. `judge()` — run by the leader and every validator independently — rebuilds
   the prompt from the frozen terms and the recorded bytes, runs the model,
   parses findings, enforces structure (enums, count arithmetic, score
   bounds), and derives the verdict via `_derive_verdict` (pure code).
3. `validator_fn` compares its own judgment against the leader's packet:
   derived verdict / evidence flag / hard-conflict set exactly, the leader's
   arithmetic re-derived from the leader's own counts, rate and score to
   adjacent buckets, and the dossier rows structurally (ids, kinds,
   submitters, acks, byte-equality, digest-over-stored-bytes).
4. A validator whose own rerun throws returns disagreement (rotating the
   round) — never an exception that would discard a possibly-correct ruling.

## Write → predicate map (the app's confirmation contract)

Every UI write polls a view predicate until the change is readable, then
watches the transaction to FINALIZED (`lib/tx.ts`). The pairs:

| Write | Predicate |
|---|---|
| `create_agreement` | docket total grew |
| `accept_agreement` | agreement status left CREATED |
| `top_up_reserve` | free reserve ≥ expected total |
| `open_case` | agreement case_count grew |
| `commit_evidence` | evidence_version grew |
| `review_evidence` | ack reads back with the position |
| `adjudicate` | pending_version ≥ judged version, or status left OPEN |
| `promote` | status left PENDING_FINALITY |
| `challenge` | challenge_open true |
| `re_adjudicate` / `lapse_challenge` | challenge_open false |
| `settle` | status SETTLED |
| `begin_close` / `finalize_close` | agreement status advanced |
| `claim` | claimable reads "0" |

## The RPC proxy

`/api/rpc` forwards exactly two methods — `gen_call` reads against the one
configured contract, and `eth_getTransactionByHash` — behind a sliding-window
pacer (26/min, 2.1s spacing), a 4s coalescing cache, and bounded backpressure.
Refusals leave as valid JSON-RPC errors tagged `[transient]` where retrying is
meaningful, so the read layer classifies them correctly. Writes never touch
the proxy: they are signed by the connected wallet and sent by the browser.
