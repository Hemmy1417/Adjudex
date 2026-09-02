"use client";

import { useEffect, useState } from "react";
import { formatGen, formatSpan } from "../../lib/config";
import { getConfig } from "../../lib/read";
import type { ChainConfig } from "../../lib/types";
import { StateNote } from "../components/bits";

export default function Rules() {
  const [cfg, setCfg] = useState<ChainConfig | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "unreachable">("loading");
  useEffect(() => {
    getConfig().then((c) => { setCfg(c); setState("ready"); }).catch(() => setState("unreachable"));
  }, []);

  return (
    <main className="page">
      <div>
        <h1 className="doc-title">Rules</h1>
        <p className="doc-sub" style={{ marginTop: 10 }}>
          The panel judges. Code decides. The credit is a constant from the
          instrument — no model number ever moves money.
        </p>
      </div>

      <div className="sheet">
        <div className="section-head"><h2>The life of a case</h2></div>
        <div className="table-scroll">
          <table className="ledger">
            <tbody>
              <tr>
                <td className="mono" style={{ width: 40 }}>01</td>
                <td><strong>Open.</strong> <span className="muted">One case per service period; the full credit is reserved from the provider&apos;s escrow at that moment.</span></td>
              </tr>
              <tr>
                <td className="mono">02</td>
                <td><strong>Record.</strong> <span className="muted">Evidence is committed as bytes — frozen, append-only. The provider acknowledges, disputes, or responds on-chain. Every commit restarts the response window.</span></td>
              </tr>
              <tr>
                <td className="mono">03</td>
                <td><strong>Judge.</strong> <span className="muted">Anyone calls the panel, once per record version. Validators count independently; code derives the verdict.</span></td>
              </tr>
              <tr>
                <td className="mono">04</td>
                <td><strong>Challenge.</strong> <span className="muted">Within the window, either party may post the exact bond with new material. The bond returns if the verdict changes. A stale challenge lapses back to the exact snapshot.</span></td>
              </tr>
              <tr>
                <td className="mono">05</td>
                <td><strong>Settle.</strong> <span className="muted">Anyone, after the challenge window. BREACHED pays the client the credit; otherwise the reservation returns. Claim is the only exit for value.</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="sheet well">
        <div className="section-head"><h2>How a verdict is derived</h2></div>
        <pre className="mono small" style={{ background: "#fff", borderRadius: 16, padding: 18, overflowX: "auto" }}>
{`evidence below SUFFICIENT       -> REVIEW_REQUIRED   (a hold pays nobody)
two+ hard contradictions        -> REVIEW_REQUIRED
zero eligible payments          -> REVIEW_REQUIRED
rate = (eligible - unexcused late) / eligible
rate below the agreed threshold -> BREACHED
otherwise                       -> NOT_BREACHED`}
        </pre>
        <p className="muted small">
          Validators must agree exactly on the derived verdict, the evidence
          flag and the hard conflicts — and on each other&apos;s arithmetic.
          Wording, and counts within a small band, are free to differ.
        </p>
      </div>

      <div className="sheet">
        <div className="section-head"><h2>Live limits</h2><span className="aside">read from the contract</span></div>
        {state === "loading" && <StateNote kind="loading">Reading the live limits…</StateNote>}
        {state === "unreachable" && (
          <StateNote kind="unreachable">The live limits could not be read just now.</StateNote>
        )}
        {cfg && (
          <dl className="schedule">
            <dt>Credit per period</dt><dd className="figure">{formatGen(cfg.min_credit_atto)} – {formatGen(cfg.max_credit_atto)} GEN</dd>
            <dt>Threshold</dt><dd className="figure">{cfg.threshold_bps[0] / 100}% – {cfg.threshold_bps[1] / 100}%</dd>
            <dt>Windows</dt><dd className="figure">{formatSpan(cfg.window_seconds[0])} – {formatSpan(cfg.window_seconds[1])}</dd>
            <dt>Challenge bond</dt><dd className="figure">{cfg.challenge_bond_bps / 100}% of the credit · floor {formatGen(cfg.challenge_bond_floor_atto)} GEN</dd>
            <dt>Stale challenge</dt><dd className="figure">{formatSpan(cfg.stale_challenge_seconds)}</dd>
            <dt>Idle case</dt><dd className="figure">released after {formatSpan(cfg.abandon_seconds)}</dd>
            <dt>Record</dt><dd className="figure">{cfg.items_total} items · {cfg.versions_max} versions</dd>
          </dl>
        )}
      </div>

      <div className="sheet well">
        <div className="section-head"><h2>Honest limits</h2></div>
        <p className="muted small">
          Evidence provenance is wallet signatures plus the counterparty&apos;s
          on-chain answers — not bank-system attestation. The consensus clock
          carries a ±5-minute envelope, so every window is sized well past it.
          An idle open case returns its reservation to the provider after the
          release window above.
        </p>
      </div>
    </main>
  );
}
