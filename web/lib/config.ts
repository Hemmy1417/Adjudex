/** Build-time configuration. The contract address compiles into the bundle,
 * so a deployment that changes it must rebuild — set it in the host's env
 * BEFORE the first build, not after. */

export const CONTRACT_ADDRESS = (
  process.env.NEXT_PUBLIC_CONTRACT_ADDRESS ?? ""
).trim();

export const CONTRACT_CONFIGURED = /^0x[0-9a-fA-F]{40}$/.test(CONTRACT_ADDRESS);

export const GENLAYER_RPC_URL = (
  process.env.NEXT_PUBLIC_GENLAYER_RPC_URL ?? "https://studio.genlayer.com/api"
).trim();

export const GENLAYER_CHAIN_ID = Number(
  process.env.NEXT_PUBLIC_GENLAYER_CHAIN_ID ?? "61999",
);

const ATTO = 10n ** 18n;

/** "0.100" — GEN with three decimals, from an atto string. Display only. */
export function formatGen(atto: string | bigint, decimals = 3): string {
  let v: bigint;
  try {
    v = typeof atto === "bigint" ? atto : BigInt(String(atto || "0"));
  } catch {
    return "0";
  }
  const negative = v < 0n;
  if (negative) v = -v;
  const whole = v / ATTO;
  const frac = ((v % ATTO) * 10n ** BigInt(decimals)) / ATTO;
  const fracStr = frac.toString().padStart(decimals, "0");
  return `${negative ? "-" : ""}${whole.toString()}${decimals ? "." + fracStr : ""}`;
}

/** basis points → "85%" or "8.5%" — trailing zeros trimmed. */
export function formatBps(bps: number): string {
  const pct = bps / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}%`;
}

/** Seconds → "52 days" / "3 hours" / "12 min" — the largest useful unit. */
export function formatSpan(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s >= 172_800) return `${Math.floor(s / 86_400)} days`;
  if (s >= 86_400) return "1 day";
  if (s >= 7_200) return `${Math.floor(s / 3_600)} hours`;
  if (s >= 3_600) return "1 hour";
  if (s >= 120) return `${Math.floor(s / 60)} min`;
  return `${s}s`;
}

export function formatStamp(epoch: number): string {
  if (!epoch) return "—";
  const d = new Date(epoch * 1000);
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}
