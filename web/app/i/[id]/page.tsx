"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { sameAddress } from "../../../lib/chain";
import { CONTRACT_ADDRESS, formatGen, formatSpan, formatStamp } from "../../../lib/config";
import {
  getAgreement, getCasesFor, getClaimable, invalidateReads,
} from "../../../lib/read";
import {
  agreementStatusIs, caseCountAbove, claimDrained, reserveFreeAtLeast,
} from "../../../lib/predicates";
import { writeAndConfirm, inFlight, type TxProgress } from "../../../lib/tx";
import type { Agreement, Case } from "../../../lib/types";
import { useWallet } from "../../../lib/wallet";
import { Addr, Gen, ReserveMeter, StateNote, StatusChip, VerdictStamp } from "../../components/bits";
import { TxFlow } from "../../components/TxFlow";

const GEN = 10n ** 18n;
function parseGen(s: string): bigint | null {
  const t = s.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(t)) return null;
  const [w, f = ""] = t.split(".");
  return BigInt(w) * GEN + BigInt((f + "0".repeat(18)).slice(0, 18));
}

export default function InstrumentRoom() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { address, client } = useWallet();

  const [ag, setAg] = useState<Agreement | null>(null);
  const [cases, setCases] = useState<Case[]>([]);
  const [claimable, setClaimable] = useState("0");
  const [state, setState] = useState<"loading" | "ready" | "missing" | "unreachable">("loading");
  const [tx, setTx] = useState<TxProgress | null>(null);
  const [period, setPeriod] = useState("");
  const [topUp, setTopUp] = useState("0.05");

  const refresh = useCallback(async (force = false) => {
    try {
      const a = await getAgreement(id, force);
      if (a === null) {
        setState("missing");
        return;
      }
      setAg(a);
      setCases(await getCasesFor(id, force));
      if (address) setClaimable(await getClaimable(address, force));
      setState("ready");
    } catch {
      setState((s) => (s === "ready" ? s : "unreachable"));
    }
  }, [id, address]);

  useEffect(() => {
    const kick = setTimeout(() => void refresh(), 0);
    const t = setInterval(() => void refresh(), 50_000);
    return () => {
      clearTimeout(kick);
      clearInterval(t);
    };
  }, [refresh]);

  const busy = inFlight(tx?.stage ?? "idle");
  const isProvider = !!ag && sameAddress(address, ag.provider);
  const isClient = !!ag && sameAddress(address, ag.client);

  async function run(
    functionName: string,
    args: unknown[],
    valueAtto: bigint,
    predicate: () => Promise<boolean>,
    confirmedDetail: string,
  ) {
    try {
      await writeAndConfirm({
        client, address: CONTRACT_ADDRESS, functionName, args, valueAtto,
        predicate, onProgress: setTx, confirmedDetail,
      });
      invalidateReads();
      await refresh(true);
    } catch {
      /* rendered by the flow */
    }
  }

  if (state === "loading") {
    return (
      <main className="page">
        <StateNote kind="loading">Reading the instrument from the contract…</StateNote>
      </main>
    );
  }
  if (state === "missing") {
    return (
      <main className="page">
        <StateNote kind="empty">
          No instrument with the id <span className="mono">{id}</span> exists on
          this contract. <Link href="/instruments" style={{ textDecoration: "underline" }}>Back to the docket.</Link>
        </StateNote>
      </main>
    );
  }
  if (state === "unreachable" || !ag) {
    return (
      <main className="page">
        <StateNote kind="unreachable">
          StudioNet could not be reached, so this instrument cannot be shown
          right now — it has not gone anywhere. The page keeps retrying.
        </StateNote>
      </main>
    );
  }

  const totalReserve = (BigInt(ag.reserve_free_atto) + BigInt(ag.reserve_held_atto)).toString();
  const canOpenCase =
    isClient &&
    (ag.status === "ACTIVE" || ag.status === "CLOSING") &&
    BigInt(ag.reserve_free_atto) >= BigInt(ag.credit_amount_atto);

  return (
    <main className="page">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div>
          <div className="label">Instrument</div>
          <h1 className="doc-title" style={{ fontSize: "clamp(26px,4vw,36px)" }}>
            <span className="mono">{ag.agreement_id}</span> · {(ag.threshold_bps / 100).toFixed(2)}% service level
          </h1>
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
            <StatusChip status={ag.status} />
            {isProvider && <span className="chip"><span className="dot" />you are the provider</span>}
            {isClient && <span className="chip"><span className="dot" />you are the client</span>}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="label">Credit per period</div>
          <Gen atto={ag.credit_amount_atto} big />
        </div>
      </div>

      <div className="sheet">
        <div className="section-head">
          <h2>Custody</h2>
          <span className="aside">total <span className="figure">{formatGen(totalReserve)}</span> GEN</span>
        </div>
        <ReserveMeter freeAtto={ag.reserve_free_atto} heldAtto={ag.reserve_held_atto} />
        <dl className="schedule">
          <dt>Provider</dt>
          <dd><Addr value={ag.provider} /></dd>
          <dt>Client</dt>
          <dd><Addr value={ag.client} /></dd>
          <dt>Terms hash</dt>
          <dd className="mono small">{ag.terms_sha256.slice(0, 20)}… <span className="faint">(frozen at assent)</span></dd>
          <dt>Drafted</dt>
          <dd className="small">{formatStamp(ag.created_epoch)}</dd>
          {ag.activated_epoch > 0 && (<><dt>Counter-signed</dt><dd className="small">{formatStamp(ag.activated_epoch)}</dd></>)}
          {ag.closing_epoch > 0 && (
            <>
              <dt>Close-out began</dt>
              <dd className="small">
                {formatStamp(ag.closing_epoch)} — the client keeps full case
                rights until {formatStamp(ag.closing_epoch + ag.notice_window)},
                then no new cases
              </dd>
            </>
          )}
        </dl>
        <div className="window-line">
          windows — response {formatSpan(ag.response_window)} · finality {formatSpan(ag.finality_window)} · challenge {formatSpan(ag.challenge_window)} · close-out notice {formatSpan(ag.notice_window)}
        </div>
      </div>

      <div className="sheet">
        <div className="section-head">
          <h2>The terms</h2>
          <span className="aside">what the panel reads — verbatim</span>
        </div>
        <details className="evidence-item" open={cases.length === 0}>
          <summary>
            <span className="ev-id">TERMS</span>
            <span className="ev-kind">sha256 {ag.terms_sha256.slice(0, 16)}…</span>
            <span className="faint small">open the full text</span>
          </summary>
          <pre>{ag.terms_text || "(terms unavailable)"}</pre>
        </details>
      </div>

      <div className="sheet">
        <div className="section-head">
          <h2>Cases</h2>
          <span className="aside">{ag.open_cases} open · {ag.case_count} filed</span>
        </div>
        {cases.length === 0 ? (
          <StateNote kind="empty">
            No case has been filed on this instrument. A case is one service
            period put to the panel — the client opens it, and the full period
            credit is reserved from the moment it opens.
          </StateNote>
        ) : (
          <div className="table-scroll">
            <table className="ledger">
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Period</th>
                  <th>Status</th>
                  <th>Verdict</th>
                  <th className="num">Record</th>
                  <th className="num">Reserved</th>
                </tr>
              </thead>
              <tbody>
                {cases.map((cs) => (
                  <tr key={cs.case_id} className="rowlink" onClick={() => router.push(`/i/${ag.agreement_id}/case/${cs.case_id}`)}>
                    <td className="mono">{cs.case_id}</td>
                    <td className="mono">{cs.period_label}</td>
                    <td><StatusChip status={cs.status} /></td>
                    <td>{cs.verdict ? <VerdictStamp verdict={cs.verdict} /> : <span className="faint">—</span>}</td>
                    <td className="num">v{cs.evidence_version} · {cs.item_count} items</td>
                    <td className="num">{formatGen(cs.reserved_atto)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="sheet">
        <div className="section-head">
          <h2>Actions</h2>
          <span className="aside">what your signature can do now</span>
        </div>
        {!address && (
          <StateNote kind="empty">
            Connect a wallet to act. Reading needs nothing — the whole record
            is public.
          </StateNote>
        )}
        <div className="action-row">
          {isClient && ag.status === "CREATED" && (
            <div className="action-card">
              <h3>Counter-sign the instrument</h3>
              <p>
                Your signature is mutual assent: the terms freeze, and the
                agreement goes live.
              </p>
              <span className="price">costs nothing but gas</span>
              <button className="btn" disabled={busy} onClick={() => void run(
                "accept_agreement", [ag.agreement_id], 0n,
                agreementStatusIs(ag.agreement_id, "ACTIVE"),
                "The instrument is active — mutual assent is on-chain, finalized.",
              )}>Accept</button>
            </div>
          )}

          {isProvider && ag.status === "CREATED" && (
            <div className="action-card">
              <h3>Withdraw the draft</h3>
              <p>Before the client signs, the draft is yours to cancel; the reserve returns to your claimable balance.</p>
              <span className="price">returns {formatGen(ag.reserve_free_atto)} GEN</span>
              <button className="btn quiet" disabled={busy} onClick={() => void run(
                "cancel_agreement", [ag.agreement_id], 0n,
                agreementStatusIs(ag.agreement_id, "CANCELLED"),
                "Cancelled — the reserve is claimable below, finalized.",
              )}>Cancel the draft</button>
            </div>
          )}

          {isClient && (ag.status === "ACTIVE" || ag.status === "CLOSING") && (
            <div className="action-card">
              <h3>Open a case</h3>
              <p>
                One service period, put on the record.{" "}
                <strong>{formatGen(ag.credit_amount_atto)} GEN is reserved
                from the free reserve the moment it opens.</strong>
              </p>
              <div className="field">
                <span className="label">Period label</span>
                <input value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="2026-08" />
              </div>
              <span className="price">reserves {formatGen(ag.credit_amount_atto)} GEN of the provider&apos;s escrow</span>
              <button className="btn" disabled={busy || !canOpenCase || period.trim().length < 3} onClick={() => void run(
                "open_case", [ag.agreement_id, period.trim().toUpperCase()], 0n,
                caseCountAbove(ag.agreement_id, ag.case_count),
                "The case is open and the credit is reserved, finalized.",
              )}>Open the case</button>
              {!canOpenCase && (
                <p className="faint small">
                  {BigInt(ag.reserve_free_atto) < BigInt(ag.credit_amount_atto)
                    ? "The free reserve cannot fund another period credit — the provider must top up first."
                    : ""}
                </p>
              )}
            </div>
          )}

          {isProvider && (ag.status === "ACTIVE" || ag.status === "CREATED") && (
            <div className="action-card">
              <h3>Top up the reserve</h3>
              <p>Each open case reserves one full credit; the free reserve is what future cases can draw on.</p>
              <div className="field">
                <span className="label">Amount (GEN)</span>
                <input value={topUp} onChange={(e) => setTopUp(e.target.value)} inputMode="decimal" />
              </div>
              <span className="price">deposits {topUp || "0"} GEN into custody</span>
              <button className="btn" disabled={busy || !parseGen(topUp)} onClick={() => {
                const amt = parseGen(topUp);
                if (!amt) return;
                const target = BigInt(ag.reserve_free_atto) + amt;
                void run("top_up_reserve", [ag.agreement_id], amt,
                  reserveFreeAtLeast(ag.agreement_id, target),
                  "The reserve is topped up, finalized.");
              }}>Deposit</button>
            </div>
          )}

          {(isProvider || isClient) && ag.status === "ACTIVE" && (
            <div className="action-card">
              <h3>Begin close-out</h3>
              <p>
                Starts the {formatSpan(ag.notice_window)} notice. The client
                keeps full case rights until it lapses — a provider cannot
                close ahead of a bad month.
              </p>
              <span className="price">costs nothing but gas</span>
              <button className="btn quiet" disabled={busy} onClick={() => void run(
                "begin_close", [ag.agreement_id], 0n,
                agreementStatusIs(ag.agreement_id, "CLOSING"),
                "Close-out has begun — the notice window is running, finalized.",
              )}>Begin close-out</button>
            </div>
          )}

          {ag.status === "CLOSING" && (
            <div className="action-card">
              <h3>Finalize close-out</h3>
              <p>
                Permissionless: after the notice window, with every case
                settled or withdrawn, the free reserve returns to the
                provider.
              </p>
              <span className="price">releases {formatGen(ag.reserve_free_atto)} GEN to the provider</span>
              <button className="btn" disabled={busy || ag.open_cases > 0} onClick={() => void run(
                "finalize_close", [ag.agreement_id], 0n,
                agreementStatusIs(ag.agreement_id, "CLOSED"),
                "The instrument is closed and the reserve released, finalized.",
              )}>Finalize</button>
              {ag.open_cases > 0 && (
                <p className="faint small">{ag.open_cases} open case(s) must settle or withdraw first.</p>
              )}
            </div>
          )}

          {address && claimable !== "0" && (
            <div className="action-card">
              <h3>Claim your balance</h3>
              <p>Everything the ledger owes this wallet, in one pull-payment.</p>
              <span className="price">pays you {formatGen(claimable)} GEN</span>
              <button className="btn" disabled={busy} onClick={() => void run(
                "claim", [], 0n, claimDrained(address),
                "Claimed — the transfer rides finalization and lands with it.",
              )}>Claim {formatGen(claimable)} GEN</button>
            </div>
          )}
        </div>
        <TxFlow p={tx} />
      </div>
    </main>
  );
}
