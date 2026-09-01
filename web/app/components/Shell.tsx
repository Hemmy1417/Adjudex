"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CONTRACT_ADDRESS, CONTRACT_CONFIGURED } from "../../lib/config";
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

function Mark({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <circle cx="32" cy="32" r="26" fill="none" stroke="#7c2a1c" strokeWidth="2.5" />
      <circle cx="32" cy="32" r="21.5" fill="none" stroke="#7c2a1c" strokeWidth="1" />
      <path d="M32 15 L21 46 M32 15 L43 46" stroke="#16233a" strokeWidth="3.4" strokeLinecap="round" fill="none" />
      <path d="M20 31.5 H44" stroke="#7c2a1c" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M20 31.5 v3.2 M44 31.5 v3.2" stroke="#7c2a1c" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

const NAV = [
  { href: "/", label: "Cover" },
  { href: "/instruments", label: "The docket" },
  { href: "/create", label: "Draft an instrument" },
  { href: "/rules", label: "Rules" },
] as const;

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  return (
    <>
      <header className="masthead">
        <div className="masthead-rule" />
        <div className="masthead-inner">
          <Link href="/" className="wordmark" aria-label="Adjudex home">
            <Mark />
            <span>
              <span className="wordmark-name">ADJUDEX</span>
              <br />
              <span className="wordmark-sub">Financial adjudication · GenLayer StudioNet</span>
            </span>
          </Link>
          <nav>
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className={
                  (n.href === "/" ? path === "/" : path.startsWith(n.href)) ? "on" : ""
                }
              >
                {n.label}
              </Link>
            ))}
            <span className="spacer" />
            <WalletButton />
          </nav>
        </div>
      </header>
      {children}
      <footer className="colophon">
        <div className="colophon-inner">
          <span>
            ADJUDEX · the decision layer between financial agreements and their
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
