# Security notes

A hostile read of Adjudex, written before anyone else does it.

## Money paths

- **Single exit.** `claim()` is the only external value path: pull-payment,
  ledger zeroed before the transfer is emitted, transfer rides
  `on="finalized"` through an empty contract-interface proxy. There is no
  inline payout anywhere.
- **Exact payables.** `create_agreement` requires the reserve to cover at
  least one credit; `challenge` requires the bond to the atto, in both
  directions (an overpay would strand value with no ledger row). `top_up`
  takes any positive amount and books all of it.
- **Reservation at open (S23).** The solvency check debits. Two cases racing
  one reserve: the second is refused on the balance the first consumed.
  Tested as an invariant, and the settle path reads only the case's own
  `reserved_atto`.
- **Atomic settle (S24).** Reservation release, ledger credit, counters and
  status move in one call. A second settle is refused at the boundary.
- **Conservation.** `escrow_atto == Σ(reserve_free + reserve_held) +
  Σclaimable + Σopen challenge bonds` — asserted across the direct suite
  after every scenario.

## Judgment paths

- **No privileged reader.** Adjudication, promotion, re-adjudication, lapse,
  settlement and close-out finalization are permissionless: liveness never
  depends on a party's cooperation (S17/S26). Due process comes from
  windows, not from who may call.
- **One judgment per record version.** Re-rolling the same bytes hunting for
  a kinder panel is structurally impossible; a REVIEW hold requires new
  material to reopen.
- **Tamper-evident dossiers.** Validators compare the stored rows byte for
  byte with digests over the stored bytes (S21/S28); a leader agreeing on
  the verdict while forging the record is refused by every honest validator.
- **Prompt-injection posture (S19).** Both fence delimiters are defused in
  every party string at commitment time, so every intact fence in a prompt
  was emitted by the contract; the prompt instructs the panel that fenced
  content is material, never instructions, and that a forged fence inside a
  document weighs against its author. The mutation sweep pins the sanitizer
  in both directions.

## Known residual surfaces (stated, not softened)

- **Party-authored evidence.** Provenance is wallet signatures plus the
  counterparty's on-chain answers — not bank-system attestation. A colluding
  pair can fabricate a coherent record; the design's protection is the
  counterparty's incentive to dispute, not external truth. The panel is told
  a single-voice record is one voice.
- **Clock envelope.** All timed rights carry the consensus clock's ±300s
  envelope; windows are sized ≥3× the envelope so a right can never be
  refused for its entire life, but second-precision fairness is out of scope.
- **Abandon path.** An idle OPEN case returns its reservation to the provider
  after 30 days — a deliberate anti-hostage trade-off, documented in the app
  where the case is opened.
- **Proxy scope.** `/api/rpc` is per-instance rate-limited; several serverless
  instances multiply the effective upstream rate. It forwards only reads of
  this one contract and transaction-status lookups, so it is not a general
  relay.
