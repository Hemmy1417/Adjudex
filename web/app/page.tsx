"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatGen } from "../lib/config";
import { getStats } from "../lib/read";
import type { Stats } from "../lib/types";
import { StateNote } from "./components/bits";

const CHIPS = [
  "cross-border payments", "service levels", "evidence records",
  "validator panels", "bonded challenges", "service credits",
  "custody", "settlement",
];

export default function Cover() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "unreachable">("loading");

  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const s = await getStats();
        if (!live) return;
        setStats(s);
        setState("ready");
      } catch {
        if (!live) return;
        setState((prev) => (prev === "ready" ? prev : "unreachable"));
      }
    };
    const kick = setTimeout(() => void tick(), 0);
    const t = setInterval(tick, 50_000);
    return () => {
      live = false;
      clearTimeout(kick);
      clearInterval(t);
    };
  }, []);

  return (
    <main className="page">
      <section className="hero-panel">
        <div className="hero-ring">
          <div className="hero-ring-inner">
            <h1 className="doc-title">
              Agreements that adjudicate themselves.
            </h1>
            <p>
              A payment settles in seconds. The dispute about who was
              responsible should not take weeks.
            </p>
          </div>
        </div>
        <div style={{ marginTop: 34, display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
          <Link href="/create" className="btn beam">Draft an instrument</Link>
          <Link
            href="/instruments"
            className="btn"
            style={{ background: "rgba(13,13,13,0.82)", borderColor: "transparent" }}
          >
            Read the docket
          </Link>
        </div>
      </section>

      <div className="chip-marquee" aria-hidden>
        <div className="ticker-track">
          {[...CHIPS, ...CHIPS].map((c, i) => (
            <span key={i} className="big-chip">{c}</span>
          ))}
        </div>
      </div>

      <section>
        <h2 className="doc-title" style={{ fontSize: "clamp(28px,4.4vw,44px)", maxWidth: "24ch" }}>
          Adjudex escrows a service credit behind an SLA — and puts the breach
          question to a GenLayer validator panel.
        </h2>
        <p className="doc-sub" style={{ marginTop: 14 }}>
          The panel reads the frozen terms and the recorded month, and returns
          findings only. Deterministic code — identical inside every validator
          — derives the verdict and moves the credit. The model never touches
          an amount.
        </p>
      </section>

      {state === "loading" && (
        <StateNote kind="loading">Reading the live contract…</StateNote>
      )}
      {state === "unreachable" && (
        <StateNote kind="unreachable">
          StudioNet could not be reached just now, so the live figures are
          unavailable — this is a network condition, not an empty record. The
          page keeps retrying on its own.
        </StateNote>
      )}
      {state === "ready" && stats && (
        <section className="stat-strip">
          <div>
            <div className="label">In custody</div>
            <div className="big-figure">{formatGen(stats.escrow_atto)}</div>
            <div className="label">GEN</div>
          </div>
          <div>
            <div className="label">Instruments</div>
            <div className="big-figure">{stats.agreements}</div>
            <div className="label">on the docket</div>
          </div>
          <div>
            <div className="label">Cases</div>
            <div className="big-figure">{stats.cases}</div>
            <div className="label">periods filed</div>
          </div>
          <div>
            <div className="label">Settled</div>
            <div className="big-figure">{stats.settled}</div>
            <div className="label">{stats.breached} paid as breaches</div>
          </div>
        </section>
      )}

      <section className="feature-grid">
        <div className="feature">
          <h3>Reserved before judged</h3>
          <p>
            Opening a case debits the full period credit from the provider&apos;s
            escrowed reserve. A breach verdict is funded before anyone judges
            anything.
          </p>
        </div>
        <div className="feature">
          <h3>Findings, not verdicts</h3>
          <p>
            Validators count the record under the agreement&apos;s own exception
            language. Pure code derives BREACHED, NOT&nbsp;BREACHED or a hold —
            identically, everywhere.
          </p>
        </div>
        <div className="feature">
          <h3>A record in bytes</h3>
          <p>
            Evidence is committed on-chain, hashed item by item, append-only.
            The provider answers each item with its own wallet: acknowledge,
            dispute, respond.
          </p>
        </div>
        <div className="feature">
          <h3>Exits everywhere</h3>
          <p>
            Finality windows, a bonded challenge, a stale-challenge lapse that
            restores the exact snapshot, permissionless settlement — and one
            pull-payment door for value.
          </p>
        </div>
      </section>

      <section className="sheet well">
        <div className="section-head">
          <h2>How an instrument runs</h2>
          <span className="aside">three acts</span>
        </div>
        <div className="table-scroll">
          <table className="ledger">
            <tbody>
              <tr>
                <td className="mono" style={{ width: 40 }}>01</td>
                <td>
                  <strong>Bind.</strong>{" "}
                  <span className="muted">
                    A provider drafts the SLA — threshold, per-period credit,
                    exception language — and funds the credit reserve in the
                    same signature. The client counter-signs; the terms freeze
                    under a sha256 at assent.
                  </span>
                </td>
              </tr>
              <tr>
                <td className="mono">02</td>
                <td>
                  <strong>File.</strong>{" "}
                  <span className="muted">
                    For one service period the client commits the evidence
                    record as bytes. The full credit is reserved the moment the
                    case opens, and every commit restarts the other side&apos;s
                    response window.
                  </span>
                </td>
              </tr>
              <tr>
                <td className="mono">03</td>
                <td>
                  <strong>Adjudicate.</strong>{" "}
                  <span className="muted">
                    Anyone calls the panel. A finality window, a bonded
                    challenge path, then settlement — BREACHED pays the client
                    the exact agreed credit, and both parties exit through
                    claim.
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
