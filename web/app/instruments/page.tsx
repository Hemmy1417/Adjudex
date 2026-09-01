"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { sameAddress } from "../../lib/chain";
import { formatGen } from "../../lib/config";
import { getAgreements } from "../../lib/read";
import type { Agreement } from "../../lib/types";
import { useWallet } from "../../lib/wallet";
import { StateNote, StatusChip } from "../components/bits";

function Row({ ag, you }: { ag: Agreement; you: string }) {
  const router = useRouter();
  const role = sameAddress(you, ag.provider)
    ? "provider"
    : sameAddress(you, ag.client)
      ? "client"
      : "";
  return (
    <tr className="rowlink" onClick={() => router.push(`/i/${ag.agreement_id}`)}>
      <td className="mono">{ag.agreement_id}</td>
      <td>
        <StatusChip status={ag.status} />
      </td>
      <td>{role ? <span className="chip"><span className="dot" />you are the {role}</span> : <span className="faint">—</span>}</td>
      <td className="num">{(ag.threshold_bps / 100).toFixed(2)}%</td>
      <td className="num">{formatGen(ag.credit_amount_atto)}</td>
      <td className="num">
        {formatGen(
          (BigInt(ag.reserve_free_atto) + BigInt(ag.reserve_held_atto)).toString(),
        )}
      </td>
      <td className="num">{ag.case_count}</td>
    </tr>
  );
}

export default function Docket() {
  const { address } = useWallet();
  const [rows, setRows] = useState<Agreement[] | null>(null);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState<"loading" | "ready" | "unreachable">("loading");

  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const page = await getAgreements(0, 50);
        if (!live) return;
        setRows(page.agreements);
        setTotal(page.total);
        setState("ready");
      } catch {
        if (!live) return;
        setState((s) => (s === "ready" ? s : "unreachable"));
      }
    };
    void tick();
    const t = setInterval(tick, 50_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  return (
    <main className="page">
      <div>
        <h1 className="doc-title">The docket</h1>
        <p className="doc-sub" style={{ marginTop: 10 }}>
          Every instrument on record — {total} drafted to date. The whole
          docket is public: terms, evidence, findings and settlements are the
          record, not the exception.
        </p>
      </div>

      {state === "loading" && (
        <StateNote kind="loading">Reading the docket from the contract…</StateNote>
      )}
      {state === "unreachable" && (
        <StateNote kind="unreachable">
          StudioNet could not be reached, so the docket cannot be shown right
          now — this is a network condition, not an empty docket. The page
          keeps retrying.
        </StateNote>
      )}
      {state === "ready" && rows && rows.length === 0 && (
        <StateNote kind="empty">
          The docket is empty: no instrument has been drafted on this contract
          yet. Drafting one takes a provider wallet, terms, and a funded
          reserve.
        </StateNote>
      )}
      {state === "ready" && rows && rows.length > 0 && (
        <div className="sheet">
          <div className="table-scroll">
            <table className="ledger">
              <thead>
                <tr>
                  <th>Instrument</th>
                  <th>Status</th>
                  <th>Your role</th>
                  <th className="num">Threshold</th>
                  <th className="num">Credit / period</th>
                  <th className="num">Reserve (GEN)</th>
                  <th className="num">Cases</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((ag) => (
                  <Row key={ag.agreement_id} ag={ag} you={address} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </main>
  );
}
