"use client";

import { useEffect, useState } from "react";
import { formatGen, formatSpan } from "../../lib/config";
import { getConfig } from "../../lib/read";
import type { ChainConfig } from "../../lib/types";
import { StateNote, VerdictStamp } from "../components/bits";

export default function Rules() {
  const [cfg, setCfg] = useState<ChainConfig | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "unreachable">("loading");
  useEffect(() => {
    getConfig().then((c) => { setCfg(c); setState("ready"); }).catch(() => setState("unreachable"));
  }, []);

  return (
    <main className="page">
      <div>
        <h1 className="doc-title">Rules of adjudication</h1>
        <p className="doc-sub" style={{ marginTop: 10 }}>
          Traditional systems answer <em>what happened</em>. Adjudex answers the
          harder question: given what happened and what the agreement says,
          what should happen next — and then it happens.
        </p>
      </div>

      <div className="sheet">
        <div className="section-head"><h2>Why this needs a panel at all</h2><span className="aside">interpretation, not measurement</span></div>
        <p className="muted">
          A monitoring system can already say &ldquo;this payment took 47
          minutes.&rdquo; It cannot say whether 47 minutes was a{" "}
          <strong>breach</strong> — that depends on the agreement&apos;s own
          exception language: compliance screening, documented outages,
          incomplete instructions. A deterministic smart contract can compare
          timestamps; it cannot weigh whether an outage notice actually covers
          a delayed payment. That judgment is what GenLayer&apos;s validators
          each make independently — and they must agree before anything moves.
        </p>
      </div>

      <div className="sheet">
        <div className="section-head"><h2>The panel judges. Code decides.</h2><span className="aside">the load-bearing design rule</span></div>
        <p className="muted">
          The model never returns a verdict and never touches an amount. Each
          validator&apos;s model returns <strong>findings only</strong> —
          eligible count, late count, excused counts per category, an evidence
          flag, conflict codes — and then <strong>pure code inside every
          validator</strong> derives the verdict from those findings,
          identically everywhere:
        </p>
        <pre className="mono small" style={{ background: "var(--well)", border: "1px solid var(--hairline)", padding: 16, overflowX: "auto" }}>
{`evidence below SUFFICIENT      -> REVIEW_REQUIRED   (a hold pays nobody)
two+ hard contradictions       -> REVIEW_REQUIRED
zero eligible payments         -> REVIEW_REQUIRED
rate = (eligible - unexcused_late) / eligible
rate below the agreed threshold -> BREACHED
otherwise                      -> NOT_BREACHED

BREACHED pays the client the agreed credit - a constant
from the instrument, never a model's number.`}
        </pre>
        <p className="muted small">
          Validators then compare: derived verdict exactly, evidence flag
          exactly, hard-conflict set exactly, the leader&apos;s own arithmetic
          re-derived, rate and score to a bucket, and the stored record row by
          row — each digest covering the exact bytes stored. Free to differ:
          the reasoning prose, soft conflicts, counts within the bucket.
        </p>
      </div>

      <div className="sheet">
        <div className="section-head"><h2>The record</h2><span className="aside">bytes, not links</span></div>
        <p className="muted">
          Everything the panel reads is committed <strong>as bytes
          on-chain</strong> — hashed item by item into a canonical manifest,
          append-only, versioned. There are no URLs to edit after the fact. A
          challenge appends a new version and is judged at it; if a challenge
          round never concludes, any party alone can lapse it, restoring
          exactly the snapshot taken at filing. The provider answers items
          with its own wallet — acknowledge or dispute — which are the chain
          facts the panel is told: the one posture the filing party cannot
          manufacture.
        </p>
      </div>

      <div className="sheet">
        <div className="section-head"><h2>Worked example</h2><span className="aside">illustrative — not contract state</span></div>
        <p className="muted small">
          Bank A routes international payments through correspondent Bank B.
          Their instrument: 95% of eligible payments within 30 minutes;
          falling short in a period owes a service credit.
        </p>
        <div className="table-scroll">
          <table className="ledger">
            <tbody>
              <tr><td>Payments processed in the period</td><td className="num">14,291</td><td /></tr>
              <tr><td>Exceeded 30 minutes</td><td className="num">73</td><td /></tr>
              <tr><td style={{ paddingLeft: 22 }}>excused · compliance holds (documented)</td><td className="num">−11</td><td /></tr>
              <tr><td style={{ paddingLeft: 22 }}>excused · infrastructure outage (notified)</td><td className="num">−8</td><td /></tr>
              <tr><td><strong>Unexcused late</strong></td><td className="num"><strong>54</strong></td><td /></tr>
              <tr>
                <td>On-time rate on eligible payments</td>
                <td className="num">99.62%</td>
                <td className="muted small">…but the agreed threshold for this tier was 99.70%</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
          <VerdictStamp verdict="BREACHED" />
          <span className="muted small">
            54 delays fell outside the permitted exceptions and pushed the
            period below the agreed service level. The predefined consequence
            — the service credit — settles by code, and the whole docket
            (terms hash, evidence digests, findings, consensus) is the
            permanent record.
          </span>
        </div>
      </div>

      <div className="sheet">
        <div className="section-head"><h2>Windows and escapes</h2><span className="aside">no fund traps</span></div>
        <p className="muted small">
          Every non-terminal state names who can move it and what happens if
          they never do. Response window: the counterparty&apos;s answer time
          after every commit. Finality window: a verdict assigns nothing until
          it lapses. Challenge window: either party, with a bond. Stale
          challenge: any party lapses it alone. Idle case: after the abandon
          window the reservation returns. Close-out: an enforced notice window
          during which the client keeps full case rights.
        </p>
        {state === "loading" && <StateNote kind="loading">Reading the live limits…</StateNote>}
        {state === "unreachable" && (
          <StateNote kind="unreachable">The live limits could not be read just now.</StateNote>
        )}
        {cfg && (
          <dl className="schedule">
            <dt>Contract version</dt><dd className="mono small">{cfg.version}</dd>
            <dt>Credit bounds</dt><dd className="figure">{formatGen(cfg.min_credit_atto)} – {formatGen(cfg.max_credit_atto)} GEN</dd>
            <dt>Threshold bounds</dt><dd className="figure">{cfg.threshold_bps[0] / 100}% – {cfg.threshold_bps[1] / 100}%</dd>
            <dt>Window bounds</dt><dd className="figure">{formatSpan(cfg.window_seconds[0])} – {formatSpan(cfg.window_seconds[1])}</dd>
            <dt>Challenge bond</dt><dd className="figure">{cfg.challenge_bond_bps / 100}% of the credit, floor {formatGen(cfg.challenge_bond_floor_atto)} GEN</dd>
            <dt>Stale challenge</dt><dd className="figure">{formatSpan(cfg.stale_challenge_seconds)}</dd>
            <dt>Abandon window</dt><dd className="figure">{formatSpan(cfg.abandon_seconds)}</dd>
            <dt>Record limits</dt><dd className="figure">{cfg.items_total} items · {cfg.versions_max} versions</dd>
          </dl>
        )}
      </div>

      <div className="sheet">
        <div className="section-head"><h2>Honest limits</h2><span className="aside">stated, not softened</span></div>
        <p className="muted small">
          Evidence is party-committed bytes: provenance is wallet signatures
          plus the counterparty&apos;s on-chain answers, not bank-system
          attestation — the panel is told exactly that, and weighs a
          single-voice record accordingly. The consensus clock carries a ±300s
          envelope, so every window is at least three envelopes wide. An idle
          open case returns its reservation to the provider after the abandon
          window — a client who wants the period judged keeps the case alive
          by committing evidence. StudioNet finalizes about thirty seconds
          after accepting a write; the interface reports acceptance and
          finality as two different words.
        </p>
      </div>
    </main>
  );
}
