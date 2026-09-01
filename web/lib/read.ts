"use client";

/**
 * The typed read layer.
 *
 * Every contract view returns a JSON string, or "" when the thing does not
 * exist. Callers never see that: they get a parsed, typed object or null,
 * and a named error if the chain could not be reached.
 *
 * All reads travel through the same-origin proxy at /api/rpc rather than
 * straight to StudioNet, because StudioNet allows ~30 reads per minute per
 * IP and a case page plus one confirming write exceeds that on its own. A
 * small client cache collapses a render tree's repeated questions into one
 * request.
 */
import { createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { isTransient } from "./chain";
import { CONTRACT_ADDRESS, CONTRACT_CONFIGURED } from "./config";
import type {
  Agreement, Assessment, Case, ChainConfig, Manifest, Stats,
} from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Client = any;

/** Thrown when the chain could not be read. Carries text a user can act on. */
export class ReadError extends Error {
  readonly transient: boolean;
  constructor(message: string, transient: boolean) {
    super(message);
    this.name = "ReadError";
    this.transient = transient;
  }
}

let client: Client | null = null;

/**
 * A private copy of the chain pointed at our proxy.
 *
 * NOT `createClient({chain: studionet, endpoint})`: the SDK implements that
 * option by assigning into the chain object it was handed, and `studionet`
 * is a shared module singleton — passing an endpoint rewrites StudioNet's
 * RPC URL process-wide, retroactively, for the wallet's write client too.
 * So the chain is cloned and the endpoint option is never used.
 */
const PROXY_CHAIN = {
  ...studionet,
  rpcUrls: {
    ...studionet.rpcUrls,
    default: { ...studionet.rpcUrls.default, http: ["/api/rpc"] as const },
  },
};

function readClient(): Client {
  if (!CONTRACT_CONFIGURED) {
    throw new ReadError(
      "No contract is configured for this build, so there is nothing to read.",
      false,
    );
  }
  if (!client) {
    // No account: reads are unsigned. Requiring a wallet to LOOK at an
    // instrument would make the docket private to participants.
    client = createClient({ chain: PROXY_CHAIN });
  }
  return client;
}

function asReadError(err: unknown): ReadError {
  if (err instanceof ReadError) return err;
  const msg =
    err instanceof Error ? err.message :
    typeof err === "object" && err !== null && "message" in err
      ? String((err as { message: unknown }).message)
      : String(err ?? "");
  if (/rate limit|-32029|read_budget/i.test(msg)) {
    return new ReadError(
      "StudioNet is limiting how fast this page can read. It recovers on its own.",
      true,
    );
  }
  return new ReadError(
    isTransient(err)
      ? "The chain could not be reached just now. Retrying usually works."
      : msg.slice(0, 200) || "The chain refused this read.",
    isTransient(err),
  );
}

// ── caching ─────────────────────────────────────────────────────────────────

type Entry = { at: number; value: unknown };

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

/** Chain limits cannot change without a redeploy, so they are read once. */
const TTL_IMMUTABLE = Number.POSITIVE_INFINITY;
/** Everything else: long enough to collapse a render, not to go stale. */
const TTL_LIVE = 5_000;

/** Drop cached reads so the next call goes to the chain. */
export function invalidateReads(): void {
  for (const k of cache.keys()) if (!k.startsWith("get_config")) cache.delete(k);
}

async function call<T>(
  functionName: string,
  args: unknown[],
  parse: (raw: string) => T,
  ttl: number,
  force = false,
): Promise<T> {
  const key = `${functionName}(${JSON.stringify(args)})`;

  if (!force) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value as T;
    const pending = inflight.get(key);
    if (pending) return pending as Promise<T>;
  }

  const p = (async () => {
    let raw: unknown;
    try {
      raw = await readClient().readContract({
        address: CONTRACT_ADDRESS as `0x${string}`,
        functionName,
        args,
      });
    } catch (err) {
      throw asReadError(err);
    } finally {
      inflight.delete(key);
    }
    const value = parse(typeof raw === "string" ? raw : JSON.stringify(raw));
    cache.set(key, { at: Date.now(), value });
    return value;
  })();
  inflight.set(key, p);
  return p;
}

const asObj = <T,>(raw: string): T | null =>
  raw && raw !== '""' ? (JSON.parse(raw) as T) : null;

// ── typed views ─────────────────────────────────────────────────────────────

export function getAgreement(id: string, force = false): Promise<Agreement | null> {
  return call("get_agreement", [id], asObj<Agreement>, TTL_LIVE, force);
}

export function getAgreements(
  offset = 0, limit = 20, force = false,
): Promise<{ total: number; agreements: Agreement[] }> {
  return call("get_agreements", [offset, limit],
    (raw) => JSON.parse(raw), TTL_LIVE, force);
}

export function getAgreementsFor(addr: string, force = false): Promise<Agreement[]> {
  return call("get_agreements_for", [addr], (raw) => JSON.parse(raw), TTL_LIVE, force);
}

export function getCase(id: string, force = false): Promise<Case | null> {
  return call("get_case", [id], asObj<Case>, TTL_LIVE, force);
}

export function getCasesFor(agreementId: string, force = false): Promise<Case[]> {
  return call("get_cases_for", [agreementId], (raw) => JSON.parse(raw), TTL_LIVE, force);
}

export function getEvidence(
  id: string, version: number, force = false,
): Promise<Manifest | null> {
  return call("get_evidence", [id, version], asObj<Manifest>,
    version ? TTL_IMMUTABLE : TTL_LIVE, force);
}

export function getAssessment(
  id: string, version: number, force = false,
): Promise<Assessment | null> {
  return call("get_assessment", [id, version], asObj<Assessment>, TTL_LIVE, force);
}

export function getAcks(id: string, force = false): Promise<Record<string, string>> {
  return call("get_acks", [id], (raw) => JSON.parse(raw || "{}"), TTL_LIVE, force);
}

export function getClaimable(addr: string, force = false): Promise<string> {
  return call("get_claimable", [addr], (raw) => {
    try { return String(JSON.parse(raw)); } catch { return raw || "0"; }
  }, TTL_LIVE, force);
}

export function getStats(force = false): Promise<Stats> {
  return call("get_stats", [], (raw) => JSON.parse(raw), TTL_LIVE, force);
}

export function getConfig(): Promise<ChainConfig> {
  return call("get_config", [], (raw) => JSON.parse(raw), TTL_IMMUTABLE);
}

// ── transaction finality ────────────────────────────────────────────────────

export type TxFinalityView = {
  /** The chain's own word for where the transaction is: "ACCEPTED",
   *  "FINALIZED", … — "UNKNOWN" when the answer named no status. */
  statusName: string;
  /** True once StudioNet reports FINALIZED: it will not walk this back. */
  finalized: boolean;
  /** What the deciding execution did. Measured against live StudioNet: the
   *  consensus-level result is MAJORITY_AGREE for a refused write too (the
   *  panel agreed it errored), so success is read from the leader receipt,
   *  never from the consensus result. */
  executed: "SUCCESS" | "ERROR" | "UNKNOWN";
};

/**
 * Numeric status → name, pinned from the SDK's enum declaration order and
 * verified against live StudioNet (a FINALIZED transaction reports 7).
 */
const STATUS_BY_NUMBER: Record<number, string> = {
  0: "UNINITIALIZED", 1: "PENDING", 2: "PROPOSING", 3: "COMMITTING",
  4: "REVEALING", 5: "ACCEPTED", 6: "UNDETERMINED", 7: "FINALIZED",
  8: "CANCELED", 9: "APPEAL_REVEALING", 10: "APPEAL_COMMITTING",
  11: "READY_TO_FINALIZE", 12: "VALIDATORS_TIMEOUT", 13: "LEADER_TIMEOUT",
};

/**
 * Normalize whatever the RPC returned for a transaction into the three facts
 * lib/tx.ts acts on. Exported for tests: this function decides whether a
 * user is told their write is irreversible, so it is exercised against
 * fixtures of every shape the chain has actually produced.
 *
 * Two shapes were measured live rather than assumed:
 *
 *   a write that TOOK EFFECT    → statusName FINALIZED, result_name
 *     MAJORITY_AGREE, leader_receipt [SUCCESS, ERROR] — the trailing ERROR
 *     is a rotated round, and the DECIDING receipt is entry 0
 *   a write the contract REFUSED → statusName FINALIZED, result_name
 *     MAJORITY_AGREE again — agreement that it errored — with
 *     leader_receipt [ERROR, ERROR]
 *
 * So entry 0 of the leader receipt decides, and the consensus result is
 * never consulted. The SDK's enum spells success FINISHED_WITH_RETURN while
 * the wire says SUCCESS; both are accepted.
 */
export function normalizeTxView(t: unknown): TxFinalityView {
  const tx = (typeof t === "object" && t !== null ? t : {}) as Record<string, unknown>;

  let statusName = "UNKNOWN";
  if (typeof tx.statusName === "string" && tx.statusName) {
    statusName = tx.statusName;
  } else if (typeof tx.status === "number" && STATUS_BY_NUMBER[tx.status]) {
    statusName = STATUS_BY_NUMBER[tx.status];
  } else if (typeof tx.status === "string" && tx.status) {
    statusName = tx.status;
  }

  let executed: TxFinalityView["executed"] = "UNKNOWN";
  const consensus = tx.consensus_data as
    | { leader_receipt?: Array<{ execution_result?: unknown }> }
    | undefined;
  const deciding = consensus?.leader_receipt?.[0]?.execution_result;
  if (deciding === "SUCCESS" || deciding === "FINISHED_WITH_RETURN") {
    executed = "SUCCESS";
  } else if (deciding === "ERROR" || deciding === "FINISHED_WITH_ERROR") {
    executed = "ERROR";
  }

  return { statusName, finalized: statusName === "FINALIZED", executed };
}

/**
 * One status poll of a submitted transaction, through the same proxy and
 * pacing as every other read. Never cached: the point is to see change.
 */
export async function getTransactionStatus(hash: string): Promise<TxFinalityView> {
  let raw: unknown;
  try {
    raw = await readClient().getTransaction({ hash: hash as `0x${string}` });
  } catch (err) {
    throw asReadError(err);
  }
  if (raw === null || raw === undefined) {
    // An unknown hash is an answer, not an error: the transaction has not
    // been seen yet. Callers keep polling rather than failing.
    return { statusName: "UNKNOWN", finalized: false, executed: "UNKNOWN" };
  }
  return normalizeTxView(raw);
}
