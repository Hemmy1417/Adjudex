"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { CONTRACT_ADDRESS, CONTRACT_CONFIGURED, formatGen } from "../../lib/config";
import { getAgreements, getStats } from "../../lib/read";
import { WalletButton } from "./WalletButton";

const EXPLORER = (
  process.env.NEXT_PUBLIC_GENLAYER_EXPLORER_URL ??
  "https://explorer-studio.genlayer.com"
).trim();

export function explorerAddress(addr: string): string {
  return `${EXPLORER}/address/${addr}`;
}
export function explorerTx(hash: string): string {
  return `${EXPLORER}/tx/${hash}`;
}

export function Mark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <defs>
        <clipPath id="adx-mark"><circle cx="32" cy="32" r="30" /></clipPath>
      </defs>
      <g clipPath="url(#adx-mark)">
        <rect x="0" y="0" width="64" height="17" fill="#e63200" />
        <rect x="0" y="17" width="64" height="15" fill="#ff7a00" />
        <rect x="0" y="32" width="64" height="15" fill="#ffb300" />
        <rect x="0" y="47" width="64" height="17" fill="#0d0d0d" />
      </g>
      <path
        d="M32 15 L21.5 49 M32 15 L42.5 49 M24.9 38 H39.1"
        stroke="#ffffff"
        strokeWidth="4.6"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

type Tick = { color: string; text: string };

/** Beam's news strip, fed by the chain: quiet 60s poll over the same cached
 *  read layer as the pages, so it costs at most two upstream reads a minute. */
function LiveTicker() {
  const [ticks, setTicks] = useState<Tick[]>([]);

  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const [stats, page] = await Promise.all([getStats(), getAgreements(0, 6)]);
        if (!live) return;
        const t: Tick[] = [
          {
            color: "red",
            text: `${formatGen(stats.escrow_atto)} GEN held in contract custody`,
          },
          {
            color: "green",
            text: `${stats.settled} case${stats.settled === 1 ? "" : "s"} settled by panel verdict to date`,
          },
          {
            color: "amber",
            text: `${stats.agreements} instrument${stats.agreements === 1 ? "" : "s"} on the docket · ${stats.cases} case${stats.cases === 1 ? "" : "s"} filed`,
          },
        ];
        for (const ag of page.agreements.slice(0, 3)) {
          t.push({
            color:
              ag.status === "ACTIVE" ? "green" :
              ag.status === "CREATED" ? "amber" : "gray",
            text: `a ${(ag.threshold_bps / 100).toFixed(2)}% service-level instrument · ${formatGen(ag.credit_amount_atto)} GEN credit per period · ${ag.status.toLowerCase()}`,
          });
        }
        t.push({
          color: "red",
          text: "the panel judges — deterministic code moves the money",
        });
        setTicks(t);
      } catch {
        if (!live) return;
        setTicks((prev) =>
          prev.length
            ? prev
            : [{ color: "gray", text: "StudioNet is briefly unreachable — the strip fills in when it answers" }],
        );
      }
    };
    void tick();
    const h = setInterval(tick, 60_000);
    return () => {
      live = false;
      clearInterval(h);
    };
  }, []);

  if (ticks.length === 0) return null;
  const doubled = [...ticks, ...ticks];
  return (
    <div className="ticker" aria-hidden>
      <div className="ticker-track">
        {doubled.map((t, i) => (
          <span key={i} className="tick-item">
            <span className={`dot ${t.color}`} />
            {t.text}
          </span>
        ))}
      </div>
    </div>
  );
}

const NAV = [
  { href: "/instruments", label: "Docket" },
  { href: "/create", label: "Draft" },
  { href: "/rules", label: "Rules" },
] as const;

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  return (
    <>
      <header className="masthead">
        <div className="masthead-inner">
          <Link href="/" className="wordmark" aria-label="Adjudex home">
            <Mark />
            <span className="wordmark-name">Adjudex</span>
          </Link>
          <nav>
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className={path.startsWith(n.href) ? "on" : ""}
              >
                {n.label}
              </Link>
            ))}
            <WalletButton />
          </nav>
        </div>
        <LiveTicker />
      </header>
      {children}
      <footer className="colophon">
        <div className="colophon-inner">
          <span>
            Adjudex — the decision layer between financial agreements and their
            enforcement
          </span>
          <span>
            {CONTRACT_CONFIGURED ? (
              <a
                href={explorerAddress(CONTRACT_ADDRESS)}
                target="_blank"
                rel="noreferrer"
              >
                contract {CONTRACT_ADDRESS.slice(0, 10)}…{CONTRACT_ADDRESS.slice(-4)}
              </a>
            ) : (
              "no contract configured"
            )}
          </span>
        </div>
      </footer>
    </>
  );
}
