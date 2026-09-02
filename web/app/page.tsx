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

      <p className="doc-sub">
        How adjudication, challenges and settlement work is written once, on
        the <Link href="/rules" style={{ textDecoration: "underline" }}>rules page</Link>.
      </p>
    </main>
  );
}
