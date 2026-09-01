"use client";

import { formatGen } from "../../lib/config";

/** The verdict as a physical stamp. */
export function VerdictStamp({
  verdict,
  big = false,
}: {
  verdict: string;
  big?: boolean;
}) {
  if (!verdict) return null;
  const cls =
    verdict === "BREACHED"
      ? "breached"
      : verdict === "NOT_BREACHED"
        ? "not_breached"
        : "review";
  const text = verdict.replace(/_/g, " ");
  return <span className={`stamp ${cls}${big ? " big" : ""}`}>{text}</span>;
}

export function StatusChip({ status }: { status: string }) {
  return (
    <span className={`chip ${status.toLowerCase()}`}>
      <span className="dot" />
      {status.replace(/_/g, " ")}
    </span>
  );
}

/** Whole address in the DOM, truncated by CSS, one-click copy. */
export function Addr({ value }: { value: string }) {
  if (!value) return <span className="faint">—</span>;
  return (
    <span title={value} style={{ whiteSpace: "nowrap" }}>
      <span className="addr">{value}</span>
      <button
        className="copy-btn"
        onClick={() => void navigator.clipboard?.writeText(value)}
        aria-label="Copy address"
      >
        copy
      </button>
    </span>
  );
}

/** GEN figure — the number always outweighs its label. */
export function Gen({ atto, big = false }: { atto: string; big?: boolean }) {
  return (
    <span className={big ? "big-figure" : "figure"}>
      {formatGen(atto)} <span className="small muted">GEN</span>
    </span>
  );
}

/** The reserve as length: held (committed to open cases) vs free. */
export function ReserveMeter({
  freeAtto,
  heldAtto,
}: {
  freeAtto: string;
  heldAtto: string;
}) {
  const free = Number(BigInt(freeAtto || "0") / 10n ** 12n);
  const held = Number(BigInt(heldAtto || "0") / 10n ** 12n);
  const total = free + held;
  const heldPct = total > 0 ? (held / total) * 100 : 0;
  return (
    <div>
      <div className="meter" aria-hidden>
        <div className="held" style={{ width: `${heldPct}%` }} />
        <div className="free" style={{ width: `${100 - heldPct}%` }} />
      </div>
      <div
        className="small muted"
        style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}
      >
        <span>
          reserved to open cases: <span className="figure">{formatGen(heldAtto)}</span>
        </span>
        <span>
          free: <span className="figure">{formatGen(freeAtto)}</span>
        </span>
      </div>
    </div>
  );
}

/** The on-time rate against the agreed threshold — magnitude is length,
 *  the threshold is a mark, and color never encodes the number. */
export function RateMeter({
  rateBps,
  thresholdBps,
}: {
  rateBps: number;
  thresholdBps: number;
}) {
  // The interesting range is the top: show 80%..100%.
  const lo = 8_000;
  const clamp = (v: number) => Math.max(0, Math.min(100, ((v - lo) / (10_000 - lo)) * 100));
  return (
    <div>
      <div className="meter-rate" aria-hidden>
        <div className="fill" style={{ width: `${clamp(rateBps)}%` }} />
        <div className="mark" style={{ left: `${clamp(thresholdBps)}%` }} />
      </div>
      <div
        className="small muted"
        style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}
      >
        <span>
          measured on-time rate:{" "}
          <span className="figure">{(rateBps / 100).toFixed(2)}%</span>
        </span>
        <span>
          agreed threshold:{" "}
          <span className="figure">{(thresholdBps / 100).toFixed(2)}%</span>
        </span>
      </div>
    </div>
  );
}

/** loading / empty / unreachable — three states, three sentences. */
export function StateNote({
  kind,
  children,
}: {
  kind: "loading" | "empty" | "unreachable";
  children: React.ReactNode;
}) {
  return <div className={`note${kind === "unreachable" ? " error" : ""}`}>{children}</div>;
}
