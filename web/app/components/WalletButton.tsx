"use client";

import { useEffect, useRef, useState } from "react";
import { truncAddr } from "../../lib/chain";
import { useWallet } from "../../lib/wallet";

export function WalletButton() {
  const { address, chainOk, connecting, wallets, error, connect, disconnect, switchNetwork } =
    useWallet();
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  if (address) {
    return (
      <div className="wallet-pop" ref={boxRef}>
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setOpen((v) => !v);
          }}
          className={chainOk ? "" : "on"}
          title={address}
        >
          {chainOk ? truncAddr(address) : "wrong network"}
        </a>
        {open && (
          <div className="wallet-menu">
            {!chainOk && (
              <button onClick={() => void switchNetwork()}>
                Switch to StudioNet
              </button>
            )}
            <button
              onClick={() => {
                void navigator.clipboard?.writeText(address);
                setOpen(false);
              }}
            >
              Copy address
            </button>
            <button
              onClick={() => {
                disconnect();
                setOpen(false);
              }}
            >
              Disconnect
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="wallet-pop" ref={boxRef}>
      <a
        href="#"
        onClick={(e) => {
          e.preventDefault();
          setOpen((v) => !v);
        }}
      >
        {connecting ? "connecting…" : "Connect wallet"}
      </a>
      {open && (
        <div className="wallet-menu">
          {wallets.length === 0 && (
            <button disabled>No wallet extension found</button>
          )}
          {wallets.map((w) => (
            <button
              key={w.info.uuid}
              onClick={() => {
                void connect(w).then(() => setOpen(false)).catch(() => {});
              }}
            >
              {w.info.icon ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={w.info.icon} alt="" />
              ) : null}
              {w.info.name}
            </button>
          ))}
          {error && <button disabled>{error}</button>}
        </div>
      )}
    </div>
  );
}
