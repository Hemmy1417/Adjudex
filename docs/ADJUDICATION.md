# Adjudication

## Why a panel

A monitoring system answers *what happened* — "this payment took 47 minutes."
The contractual question is different: *under this agreement, was 47 minutes a
breach?* The answer depends on the agreement's own exception language
(compliance screening, notified outages, incomplete instructions), applied to
a messy record. That is interpretation, and it is exactly what GenLayer's
optimistic-democracy consensus is for: several validators form the judgment
independently, and nothing counts until they agree.

## Findings only — the division of labour

The model **counts and classifies**. The code **decides and pays**.

Model output (per validator, structurally validated at the boundary):

```json
{"eligible_total": 100, "late_total": 10,
 "excused": {"COMPLIANCE_HOLD": 2, "INFRASTRUCTURE": 1, "DATA_GAP": 0, "OTHER_TERMS": 0},
 "evidence": "SUFFICIENT", "conflicts": [], "score": 88,
 "reason": "…cites the items that decided it…"}
```

Derivation (pure code, identical in every validator):

```text
evidence below SUFFICIENT            -> REVIEW_REQUIRED   (S22: a hold pays nobody)
two or more HARD conflicts           -> REVIEW_REQUIRED
zero eligible payments               -> REVIEW_REQUIRED
rate = (eligible - unexcused_late) * 10000 // eligible
rate < threshold_bps                 -> BREACHED
otherwise                            -> NOT_BREACHED
```

The credit is a constant from the instrument. No model number is ever
multiplied into a transfer (S7 by construction).

## The equivalence rule

Exact: derived verdict · evidence flag · hard-conflict set · the leader's own
arithmetic (each validator re-derives the leader's claimed verdict and rate
from the leader's stored counts — internally inconsistent packets are refused
whatever else matches). Bucketed ±1: on-time rate (50 bps buckets), score
(10-point buckets). Structural: dossier rows — ids in order, kinds,
submitters, ack states, byte-equal excerpts, and each digest covering the
exact bytes stored (S21/S28). Free: reasoning prose, soft conflicts, counts
inside the bucket.

Failure semantics: `[EXPECTED]`/`[EXTERNAL]` must match exactly across
leader and validator; `[TRANSIENT]` agrees when both saw it; `[LLM_ERROR]`
always disagrees, rotating the round rather than writing anything.

## The record and the counterparty

All evidence is committed **bytes on-chain** — sanitized (both fence
delimiters defused, S19), hashed per item, rooted per version, append-only.
There are no URLs for an interested party to edit afterwards (the S8 attack
class is removed rather than mitigated). The provider's per-item ACK/DISPUTE
and its `response` items are wallet-signed chain facts (S27): the filing
party cannot manufacture the counterparty's posture, and the panel is told
each item's provenance in its fence header.

## Challenges

A challenge posts an exact bond, appends the challenger's material as the
next record version, and snapshots the case (S29). Re-adjudication is
permissionless and judged at the new version; the bond returns if the verdict
changed, otherwise it compensates the other party. A challenge no round
concludes within the stale window lapses on any single party's call,
restoring the snapshot exactly and returning the bond (S17). The version cap
(6) bounds the ping-pong structurally.
