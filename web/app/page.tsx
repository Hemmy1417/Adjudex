"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatGen } from "../lib/config";
import { ReadError, getStats } from "../lib/read";
import type { Stats } from "../lib/types";
import { StateNote } from "./components/bits";

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
      } catch (err) {
        if (!live) return;
        if (state !== "ready") setState("unreachable");
        void (err as ReadError);
      }
    };
    void tick();
    const t = setInterval(tick, 50_000);
    return () => {
      live = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="page">
      <section style={{ textAlign: "center", padding: "26px 0 6px" }}>
        <h1 className="doc-title">
          Financial agreements that
          <br />
          adjudicate themselves.
        </h1>
        <p className="doc-sub" style={{ margin: "18px auto 0" }}>
          A payment settles in seconds; the dispute about who was responsible
          takes weeks. Adjudex escrows a service credit behind an SLA, records
          the month as evidence, and puts the breach question to a GenLayer
          validator panel. The panel judges — deterministic code moves the
          money.
        </p>
        <div
          style={{
            display: "flex",
            gap: 12,
            justifyContent: "center",
            marginTop: 26,
            flexWrap: "wrap",
          }}
        >
          <Link href="/create" className="btn">
            Draft an instrument
          </Link>
          <Link href="/instruments" className="btn quiet">
            Read the docket
          </Link>
        </div>
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
            <div className="label">Instruments</div>
            <div className="big-figure">{stats.agreements}</div>
          </div>
          <div>
            <div className="label">Cases filed</div>
            <div className="big-figure">{stats.cases}</div>
          </div>
          <div>
            <div className="label">Settled</div>
            <div className="big-figure">{stats.settled}</div>
          </div>
          <div>
            <div className="label">Breaches paid</div>
            <div className="big-figure">{stats.breached}</div>
          </div>
          <div>
            <div className="label">In custody</div>
            <div className="big-figure">{formatGen(stats.escrow_atto)}</div>
            <div className="label" style={{ marginTop: 2 }}>GEN</div>
          </div>
        </section>
      )}

      <section className="sheet">
        <div className="section-head">
          <h2>How an instrument works</h2>
          <span className="aside">three acts</span>
        </div>
        <div className="table-scroll">
          <table className="ledger">
            <tbody>
              <tr>
                <td className="mono" style={{ width: 34 }}>I.</td>
                <td>
                  <strong>Bind.</strong>{" "}
                  <span className="muted">
                    A provider drafts the SLA — threshold, per-period credit,
                    the agreement&apos;s own exception language — and funds the
                    credit reserve in the same signature. The client
                    counter-signs; the terms are frozen and hashed at assent.
                  </span>
                </td>
              </tr>
              <tr>
                <td className="mono">II.</td>
                <td>
                  <strong>File.</strong>{" "}
                  <span className="muted">
                    For a service period the client commits the evidence record
                    as bytes on-chain — payment logs, exception records, outage
                    notices. The full credit is reserved the moment the case
                    opens. The provider answers each item with its own wallet:
                    acknowledge, dispute, or commit a response.
                  </span>
                </td>
              </tr>
              <tr>
                <td className="mono">III.</td>
                <td>
                  <strong>Adjudicate.</strong>{" "}
                  <span className="muted">
                    After the response window, anyone can call the panel.
                    Validators independently count the record under the frozen
                    terms — the model returns findings only, and code derives
                    the verdict identically inside every validator. A finality
                    window, a bonded challenge path, then settlement: BREACHED
                    pays the client the exact agreed credit.
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
