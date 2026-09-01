/**
 * Repository-level proof that Adjudex contract writes are SIGNED by the
 * connected wallet: the wallet context builds its client with the chosen
 * EIP-1193 provider (createClient({chain, account, provider})), and the
 * write path (lib/tx.ts writeAndConfirm → client.writeContract) rides that
 * client — never genlayer-js's implicit window.ethereum fallback.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { writeAndConfirm } from "@/lib/tx";

const ACCOUNT = ("0x" + "12".repeat(20)) as `0x${string}`;
const CONTRACT = ("0x" + "ab".repeat(20)) as `0x${string}`;
const TX_HASH = ("0x" + "cd".repeat(32)) as `0x${string}`;

const CONSENSUS_MAIN = {
  address: ("0x" + "01".repeat(20)) as `0x${string}`,
  abi: [
    {
      type: "function",
      name: "addTransaction",
      stateMutability: "nonpayable",
      inputs: [
        { name: "sender", type: "address" },
        { name: "recipient", type: "address" },
        { name: "numOfInitialValidators", type: "uint256" },
        { name: "maxRotations", type: "uint256" },
        { name: "txData", type: "bytes" },
      ],
      outputs: [],
    },
  ],
};

// genlayer-js 1.1.8 reads nonce/gas over a fetch-based JSON-RPC transport
// (not the wallet provider), so the stub answers each method with typed hex —
// an object for everything would throw in a BigInt() conversion before the
// write ever reached eth_sendTransaction.
function rpcResult(method: string): string {
  switch (method) {
    case "eth_chainId":              return `0x${studionet.id.toString(16)}`;
    case "eth_getTransactionCount":  return "0x0";
    case "eth_estimateGas":          return "0x30d40";
    case "eth_gasPrice":             return "0x1";
    case "eth_maxPriorityFeePerGas": return "0x1";
    case "eth_blockNumber":          return "0x1";
    case "eth_getBalance":           return "0x0";
    case "eth_call":                 return "0x";
    default:                          return "0x1";
  }
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, opts: { body?: string } | undefined) => {
      let body: unknown = {};
      try { body = JSON.parse(opts?.body ?? "{}"); } catch { /* non-JSON */ }
      const one = (b: { id?: number; method?: string }) =>
        ({ jsonrpc: "2.0", id: b?.id ?? 1, result: rpcResult(b?.method ?? "") });
      const payload = Array.isArray(body)
        ? body.map(one)
        : one(body as { id?: number; method?: string });
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});
afterEach(() => { vi.unstubAllGlobals(); });

function recordingProvider() {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const provider = {
    isMetaMask: true,
    request: async ({ method, params = [] }: { method: string; params?: unknown[] }) => {
      calls.push({ method, params });
      switch (method) {
        case "eth_chainId":             return `0x${studionet.id.toString(16)}`;
        case "eth_accounts":
        case "eth_requestAccounts":     return [ACCOUNT];
        case "eth_getTransactionCount": return "0x0";
        case "eth_estimateGas":         return "0x30d40";
        case "eth_gasPrice":            return "0x1";
        case "eth_sendTransaction":     return TX_HASH;
        default:                         return "0x1";
      }
    },
    on: () => {},
    removeListener: () => {},
  };
  return { provider, calls };
}

function providerClient() {
  const { provider, calls } = recordingProvider();
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const client: any = createClient({ chain: studionet, account: ACCOUNT, provider });
  client.chain.consensusMainContract = CONSENSUS_MAIN;
  return { client, calls };
}

describe("Adjudex writes are signed by the connected wallet provider", () => {
  it("routes writeContract through the injected EIP-1193 provider (correct from)", async () => {
    const { client, calls } = providerClient();
    const txHash = await client.writeContract({
      address: CONTRACT,
      functionName: "create_agreement",
      args: ["0x" + "34".repeat(20), "SERVICE LEVEL AGREEMENT " + "x".repeat(100),
        9500, "50000000000000000", 900, 900, 900, 900],
      value: 10n ** 17n,
    });
    expect(txHash).toBe(TX_HASH);
    const sendTx = calls.find((c) => c.method === "eth_sendTransaction");
    expect(sendTx, "eth_sendTransaction must be signed by the wallet provider").toBeDefined();
    expect(String((sendTx!.params[0] as { from: string }).from).toLowerCase())
      .toBe(ACCOUNT.toLowerCase());
  });

  it("the real writeAndConfirm path signs through the provider-backed client", async () => {
    const { client, calls } = providerClient();
    void writeAndConfirm({
      client,
      address: CONTRACT,
      functionName: "challenge",
      args: ["case-000001", "the record is contradicted for the stated reasons", "[]"],
      valueAtto: 5n * 10n ** 16n,
      predicate: async () => true,
      txStatus: async () => ({ statusName: "FINALIZED", finalized: true, executed: "SUCCESS" }),
    }).catch(() => {});
    await vi.waitFor(
      () => expect(calls.find((c) => c.method === "eth_sendTransaction")).toBeDefined(),
      { timeout: 4000 },
    );
    const sendTx = calls.find((c) => c.method === "eth_sendTransaction")!;
    expect(String((sendTx.params[0] as { from: string }).from).toLowerCase())
      .toBe(ACCOUNT.toLowerCase());
  });
});
