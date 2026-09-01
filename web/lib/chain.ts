/**
 * Chain constants and pure helpers — no browser, no provider, fully testable.
 * The wallet layer builds on these; nothing in this file can touch a network.
 */
import { GENLAYER_CHAIN_ID, GENLAYER_RPC_URL } from "./config";

export const CHAIN_ID = GENLAYER_CHAIN_ID;

/** EIP-695 hex chain id: lowercase, no leading zeros. 61999 -> "0xf22f". */
export function toChainHex(id: number): `0x${string}` {
  if (!Number.isInteger(id) || id <= 0) throw new Error(`bad chain id: ${id}`);
  return `0x${id.toString(16)}` as `0x${string}`;
}

export const CHAIN_HEX = toChainHex(CHAIN_ID);

/** wallet_addEthereumChain params for GenLayer StudioNet. */
export const STUDIONET_PARAMS = {
  chainId: CHAIN_HEX,
  chainName: "GenLayer StudioNet",
  rpcUrls: [GENLAYER_RPC_URL],
  nativeCurrency: { name: "GEN", symbol: "GEN", decimals: 18 },
} as const;

/** 0x1234ab…cdef — the display form of a connected identity. */
export function truncAddr(addr: string): string {
  return addr.length > 13 ? `${addr.slice(0, 8)}…${addr.slice(-4)}` : addr;
}

/**
 * Map raw EIP-1193 errors to words a person can act on.
 *
 * The UI standard forbids "Something went wrong": every failure must say what
 * happened, why, and what to do next. These are the four the wallet actually
 * produces; anything else falls through with its own message rather than
 * being flattened into a generic string.
 */
export function walletErrorMessage(err: unknown): string {
  const e = err as { code?: number; message?: string } | undefined;
  if (e?.code === 4001) {
    return "You declined the request in your wallet. Nothing was sent.";
  }
  if (e?.code === -32002) {
    return "Your wallet already has a request open. Finish or dismiss it, then try again.";
  }
  if (e?.code === 4902) {
    return "StudioNet isn't in this wallet yet. Approve the prompt to add it.";
  }
  if (e?.code === 4900 || e?.code === 4901) {
    return "Your wallet is disconnected from the network. Reconnect and try again.";
  }
  return e?.message ? e.message.slice(0, 160) : "The wallet call failed.";
}

/** Transient RPC noise that should be retried rather than surfaced. */
const TRANSIENT =
  /\[transient\]|rate limit|429|-32029|failed to fetch|fetch failed|unreachable|doctype|not valid json|unexpected token|502|503|504|timeout|econnreset|socket|server busy|execution slots|retry later/i;

export function isTransient(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === "object" && err !== null && "message" in err
        ? String((err as { message: unknown }).message)
        : String(err ?? "");
  return TRANSIENT.test(msg);
}

/**
 * Do two addresses refer to the same account?
 *
 * They are never spelled the same way. The contract normalises every address
 * to LOWERCASE hex before storing it, while the wallet layer runs connected
 * accounts through viem's getAddress, which returns EIP-55 mixed case. So
 * `invoice.seller === address` is false for the seller's own invoice, every
 * time. Comparing raw strings would hide the creator's cancel control from
 * the creator and show "your position" to nobody.
 *
 * Every ownership check in the app goes through this.
 */
export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
