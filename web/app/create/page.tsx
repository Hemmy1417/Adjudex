"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { formatGen, formatSpan, CONTRACT_ADDRESS } from "../../lib/config";
import { getAgreements, getConfig } from "../../lib/read";
import { agreementCountAbove } from "../../lib/predicates";
import { writeAndConfirm, inFlight, type TxProgress } from "../../lib/tx";
import type { ChainConfig } from "../../lib/types";
import { useWallet } from "../../lib/wallet";
import { StateNote } from "../components/bits";
import { TxFlow } from "../components/TxFlow";

const TERMS_TEMPLATE = `SERVICE LEVEL AGREEMENT between the provider and the client.

SERVICE LEVEL: 95% of eligible cross-border payments must be processed within 30 minutes of instruction receipt, measured per service period.

ELIGIBILITY: a payment is eligible once complete instructions and beneficiary information are received. Payments with incomplete beneficiary information are not eligible until completed.

EXCEPTIONS: a late payment is excused where the delay was caused by
(a) regulatory or compliance screening,
(b) a documented infrastructure outage the provider notified within 24 hours, or
(c) incomplete or incorrect instruction data supplied by the client.

CONSEQUENCE: falling below the service level in a period owes the client the agreed service credit for that period.`;

const GEN = 10n ** 18n;

function parseGen(s: string): bigint | null {
  const t = s.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(t)) return null;
  const [w, f = ""] = t.split(".");
  return BigInt(w) * GEN + BigInt((f + "0".repeat(18)).slice(0, 18));
}

export default function Create() {
  const { address, client } = useWallet();
  const [cfg, setCfg] = useState<ChainConfig | null>(null);
  const [cfgState, setCfgState] = useState<"loading" | "ready" | "unreachable">("loading");

  const [clientAddr, setClientAddr] = useState("");
  const [terms, setTerms] = useState(TERMS_TEMPLATE);
  const [thresholdPct, setThresholdPct] = useState("95.00");
  const [creditGen, setCreditGen] = useState("0.05");
  const [reserveGen, setReserveGen] = useState("0.15");
  const [windows, setWindows] = useState({ response: 900, finality: 900, challenge: 900, notice: 900 });
  const [review, setReview] = useState(false);
  const [tx, setTx] = useState<TxProgress | null>(null);
  const [createdId, setCreatedId] = useState("");

  useEffect(() => {
    getConfig()
      .then((c) => {
        setCfg(c);
        setCfgState("ready");
        setWindows({
          response: c.default_windows.response,
          finality: c.default_windows.finality,
          challenge: c.default_windows.challenge,
          notice: c.default_windows.notice,
        });
      })
      .catch(() => setCfgState("unreachable"));
  }, []);

  const thresholdBps = Math.round(Number(thresholdPct || "0") * 100);
  const creditAtto = useMemo(() => parseGen(creditGen), [creditGen]);
  const reserveAtto = useMemo(() => parseGen(reserveGen), [reserveGen]);

  const problems: string[] = [];
  if (!/^0x[0-9a-fA-F]{40}$/.test(clientAddr.trim()))
    problems.push("the client must be a wallet address (0x…)");
  if (address && clientAddr.trim().toLowerCase() === address.toLowerCase())
    problems.push("the client wallet cannot be your own — an agreement needs two parties");
  if (cfg && (terms.trim().length < cfg.terms_chars[0] || terms.trim().length > cfg.terms_chars[1]))
    problems.push(`terms must be ${cfg.terms_chars[0]}–${cfg.terms_chars[1]} characters (now ${terms.trim().length})`);
  if (cfg && (thresholdBps < cfg.threshold_bps[0] || thresholdBps > cfg.threshold_bps[1]))
    problems.push(`threshold must be between ${cfg.threshold_bps[0] / 100}% and ${cfg.threshold_bps[1] / 100}%`);
  if (!creditAtto || (cfg && (creditAtto < BigInt(cfg.min_credit_atto) || creditAtto > BigInt(cfg.max_credit_atto))))
    problems.push(`the period credit must be between ${cfg ? formatGen(cfg.min_credit_atto) : "0.01"} and ${cfg ? formatGen(cfg.max_credit_atto) : "1000"} GEN`);
  if (!reserveAtto || (creditAtto && reserveAtto < creditAtto))
    problems.push("the reserve must cover at least one period credit");
  for (const [k, v] of Object.entries(windows)) {
    if (cfg && (v < cfg.window_seconds[0] || v > cfg.window_seconds[1]))
      problems.push(`the ${k} window must be ${cfg.window_seconds[0]}–${cfg.window_seconds[1]} seconds`);
  }

  const ready = problems.length === 0 && !!address && !!client;

  async function sign() {
    if (!ready || !reserveAtto) return;
    const before = (await getAgreements(0, 1, true)).total;
    try {
      await writeAndConfirm({
        client,
        address: CONTRACT_ADDRESS,
        functionName: "create_agreement",
        args: [
          clientAddr.trim(),
          terms.trim(),
          thresholdBps,
          creditAtto!.toString(),
          windows.response,
          windows.finality,
          windows.challenge,
          windows.notice,
        ],
        valueAtto: reserveAtto,
        predicate: agreementCountAbove(before),
        onProgress: setTx,
        confirmedDetail: "The instrument is drafted and the reserve is in custody, finalized.",
      });
      const page = await getAgreements(0, 1, true);
      const id = page.agreements[0]?.agreement_id ?? "";
      setCreatedId(id);
    } catch {
      /* the flow rendered the failure; nothing else to do */
    }
  }

  return (
    <main className="page">
      <div>
        <h1 className="doc-title">Draft an instrument</h1>
        <p className="doc-sub" style={{ marginTop: 10 }}>
          You are the provider. You write the terms — including the exception
          language the panel will hold you both to — fund the credit reserve,
          and name the client wallet that must counter-sign before anything
          runs.
        </p>
      </div>

      {cfgState === "loading" && (
        <StateNote kind="loading">Reading the contract&apos;s limits…</StateNote>
      )}
      {cfgState === "unreachable" && (
        <StateNote kind="unreachable">
          The contract&apos;s limits could not be read, so this form cannot
          validate what it sends. Retry in a moment rather than guessing.
        </StateNote>
      )}

      {createdId ? (
        <div className="sheet">
          <div className="section-head">
            <h2>Instrument drafted</h2>
            <span className="aside mono">{createdId}</span>
          </div>
          <p className="muted">
            The reserve is in custody and the instrument now waits for the
            client wallet to counter-sign it.
          </p>
          <Link className="btn" href={`/i/${createdId}`}>
            Open the instrument
          </Link>
        </div>
      ) : (
        <div className="sheet">
          <div className="form-grid">
            <div className="field wide">
              <span className="label">Client wallet (the counter-signatory)</span>
              <input
                value={clientAddr}
                onChange={(e) => setClientAddr(e.target.value)}
                placeholder="0x…"
                spellCheck={false}
              />
              <span className="hint">
                Only this wallet can accept the instrument, open cases and be
                paid a breach credit.
              </span>
            </div>

            <div className="field wide">
              <span className="label">The agreement&apos;s terms</span>
              <textarea
                rows={14}
                value={terms}
                onChange={(e) => setTerms(e.target.value)}
                spellCheck={false}
              />
              <span className="hint">
                Frozen and hashed at assent. The panel applies exceptions FROM
                THIS TEXT and nothing else — an exception the terms do not
                state excuses nothing. {terms.trim().length} characters.
              </span>
            </div>

            <div className="field">
              <span className="label">Service threshold (%)</span>
              <input
                value={thresholdPct}
                onChange={(e) => setThresholdPct(e.target.value)}
                inputMode="decimal"
              />
              <span className="hint">
                The on-time share of eligible payments the period must meet.
              </span>
            </div>
            <div className="field">
              <span className="label">Service credit per period (GEN)</span>
              <input
                value={creditGen}
                onChange={(e) => setCreditGen(e.target.value)}
                inputMode="decimal"
              />
              <span className="hint">
                Paid to the client, in full and exactly, when a period is
                judged BREACHED.
              </span>
            </div>

            <div className="field">
              <span className="label">Reserve to escrow now (GEN)</span>
              <input
                value={reserveGen}
                onChange={(e) => setReserveGen(e.target.value)}
                inputMode="decimal"
              />
              <span className="hint">
                Held by the contract. Every open case reserves one full credit
                from it, up front.
              </span>
            </div>
            <div className="field">
              <span className="label">Windows (seconds)</span>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {(["response", "finality", "challenge", "notice"] as const).map((k) => (
                  <label key={k} className="field">
                    <span className="hint">{k} · {formatSpan(windows[k])}</span>
                    <input
                      value={windows[k]}
                      onChange={(e) =>
                        setWindows((w) => ({ ...w, [k]: Number(e.target.value || 0) }))
                      }
                      inputMode="numeric"
                    />
                  </label>
                ))}
              </div>
            </div>
          </div>

          {problems.length > 0 && (
            <div className="note">
              Before this can be signed: {problems.join("; ")}.
            </div>
          )}

          {!review ? (
            <button
              className="btn"
              disabled={problems.length > 0}
              onClick={() => setReview(true)}
            >
              Review before signing
            </button>
          ) : (
            <div className="review-box">
              <div className="label" style={{ marginBottom: 10 }}>
                What your signature sends — exactly
              </div>
              <dl className="schedule">
                <dt>Deposit now</dt>
                <dd className="figure">{reserveAtto ? formatGen(reserveAtto.toString()) : "—"} GEN into contract custody</dd>
                <dt>Client wallet</dt>
                <dd className="mono small">{clientAddr.trim()}</dd>
                <dt>Threshold</dt>
                <dd className="figure">{(thresholdBps / 100).toFixed(2)}% on-time</dd>
                <dt>Credit / period</dt>
                <dd className="figure">{creditAtto ? formatGen(creditAtto.toString()) : "—"} GEN</dd>
                <dt>Terms</dt>
                <dd className="small muted">
                  {terms.trim().length} characters, frozen at assent (sha256 on-chain)
                </dd>
                <dt>Withdrawal</dt>
                <dd className="small muted">
                  Reserve returns only through cancel (before acceptance) or
                  close-out (after the {formatSpan(windows.notice)} notice, with
                  no open cases)
                </dd>
              </dl>
              <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
                <button
                  className="btn"
                  disabled={!ready || inFlight(tx?.stage ?? "idle")}
                  onClick={() => void sign()}
                >
                  {address ? "Sign and escrow the reserve" : "Connect a wallet first"}
                </button>
                <button className="btn quiet" onClick={() => setReview(false)}>
                  Back to editing
                </button>
              </div>
            </div>
          )}

          <TxFlow p={tx} />
        </div>
      )}
    </main>
  );
}
