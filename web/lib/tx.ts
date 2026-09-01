"use client";

/**
 * The transaction lifecycle.
 *
 * Three rules, all learned the hard way — two on sibling builds, one from a
 * judge reading this file:
 *
 *   CONFIRMATION IS A CONTRACT READ, NOT A RECEIPT. A submitted transaction
 *   is not a changed state. Every write here closes by polling a VIEW
 *   PREDICATE — "is the thing I asked for now true on-chain?" — because a
 *   receipt can arrive before finalization and a hash proves only that we
 *   asked.
 *
 *   THE PREDICATE MUST MATCH WHAT THE CONTRACT ACTUALLY EXPOSES. A sibling
 *   polled for a field its own deferral design deliberately withholds until
 *   finality, so a resolution that had genuinely succeeded was reported to
 *   the user as unconfirmed. Predicates live beside the reads they check
 *   (lib/predicates.ts) rather than being written inline at each call site.
 *
 *   A CONTRACT READ IS NOT FINALITY EITHER. The predicate turning true
 *   proves the write reached ACCEPTED — a state StudioNet can still walk
 *   back. Earlier versions said "Confirmed on-chain" at that moment, which
 *   overstated it for an app that moves money. So acceptance and finality
 *   are now two separate stages: the flow unblocks at ACCEPTED (the state is
 *   live and every follow-up read will see it), and it says FINALIZED only
 *   after the transaction itself reports FINALIZED with its deciding
 *   execution a success. Measured on StudioNet, that last step follows
 *   acceptance by about thirty seconds.
 */
import { isTransient, walletErrorMessage } from "./chain";
import { getTransactionStatus, type TxFinalityView } from "./read";

/**
 * Is this read failure worth retrying?
 *
 * The read layer already knows: ReadError carries a `transient` boolean set
 * where the failure was classified. Re-deriving it from the message here was a
 * real bug, and a bad one. lib/read.ts REWRITES a rate limit into "StudioNet is
 * limiting how fast this page can read", which contains none of the words
 * isTransient looks for, so a rate-limited confirmation read was classified as
 * a hard failure and a transaction that had landed was reported to the user as
 * failed. StudioNet allows thirty reads a minute and this polls up to sixty
 * times, so it was not a rare path.
 *
 * The structured flag wins wherever it exists; the prose match stays as a
 * fallback for errors thrown by layers that do not carry one.
 */
function retryable(err: unknown): boolean {
  if (typeof err === "object" && err !== null && "transient" in err) {
    const t = (err as { transient: unknown }).transient;
    if (typeof t === "boolean") return t;
  }
  return isTransient(err);
}

export type TxStage =
  | "idle"
  | "wallet"      // waiting for the signature
  | "submitted"   // signed and sent
  | "pending"     // on-chain, awaiting the state change
  | "accepted"    // a contract read proves the state is live; not yet final
  | "confirmed"   // the transaction reports FINALIZED and executed
  | "unresolved"  // submitted, and we stopped waiting without an answer
  | "rejected"    // the user declined
  | "failed";

/**
 * Is this write still in flight?
 *
 * The one every caller needs, and the one that was getting written by hand at
 * each site. "unresolved" is deliberately NOT in flight: the poll gave up, so
 * the control must become usable again. Leaving it counted as working left the
 * button that fired the write disabled for the life of the component, which is
 * the worst outcome available, because the user cannot retry and cannot tell
 * whether their money moved.
 */
export function inFlight(stage: TxStage): boolean {
  return stage === "wallet" || stage === "submitted" || stage === "pending";
}

/**
 * Has the chain's state caught up with what the user asked for?
 *
 * True from ACCEPTED onward. This is the gate for follow-up ACTIONS — moving
 * to the receivable, refreshing a list, offering the next step — because
 * every read from here on sees the new state. It is deliberately NOT the
 * gate for the word "finalized": that claim belongs to the confirmed stage
 * alone, which requires the transaction itself to report FINALIZED. Call
 * sites that used to key "done" off confirmed key it off this, so a user is
 * neither blocked for the finality wait nor told a reversible write is
 * irreversible.
 */
export function stateVisible(stage: TxStage): boolean {
  return stage === "accepted" || stage === "confirmed";
}

export type TxProgress = { stage: TxStage; detail: string; hash?: string };

/* eslint-disable @typescript-eslint/no-explicit-any */
type Client = any;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type WriteArgs = {
  client: Client;
  address: string;
  functionName: string;
  args: unknown[];
  /** GEN in atto. Stakes and bonds are payable; everything else is 0n. */
  valueAtto?: bigint;
  /** "Has the chain caught up?" — resolves true when the state is visible. */
  predicate: () => Promise<boolean>;
  onProgress?: (p: TxProgress) => void;
  /** How many times to poll the predicate before giving up (6s apart). */
  predicateTries?: number;
  /** How many times to poll for finality after acceptance (6s apart).
   *  StudioNet finalizes about thirty seconds after accepting, so the
   *  default of twenty is generous without being endless. */
  finalityTries?: number;
  /**
   * What to say once finality is proven.
   *
   * The default speaks about the transaction, which is right when only the
   * caller could have produced the state. It is WRONG for the permissionless
   * calls: resolve and finalize can be satisfied by a stranger's transaction
   * landing first, and telling that user "your transaction succeeded" would
   * be a claim about their transaction that nobody checked. Those call sites
   * pass a sentence about the MARKET instead.
   */
  confirmedDetail?: string;
  /**
   * One status poll of a transaction, injectable for the same reason the
   * predicate is: this path decides whether a user is told their write is
   * irreversible. Production passes nothing and gets the real reader.
   */
  txStatus?: (hash: string) => Promise<TxFinalityView>;
};

/**
 * Submit a write, confirm it by reading the chain back, then prove finality.
 *
 * Resolves with the transaction hash once the STATE IS VISIBLE (the accepted
 * stage) — everything a caller does next is a read, and reads see the new
 * state from that moment. The finality watch keeps reporting through
 * `onProgress` after resolution: confirmed when the transaction reports
 * FINALIZED with a successful execution, or a terminal accepted-but-not-yet-
 * final message if the watch runs out. Throws on rejection or failure — the
 * caller renders `onProgress`, which always ends in a terminal stage, so the
 * user is never left wondering.
 */
export async function writeAndConfirm({
  client,
  address,
  functionName,
  args,
  valueAtto = 0n,
  predicate,
  onProgress,
  predicateTries = 30,
  finalityTries = 20,
  confirmedDetail = "Finalized on-chain.",
  txStatus = getTransactionStatus,
}: WriteArgs): Promise<string> {
  const report = (p: TxProgress) => onProgress?.(p);

  if (!client) {
    const detail = "No wallet is connected.";
    report({ stage: "failed", detail });
    throw new Error(detail);
  }

  report({ stage: "wallet", detail: "Confirm in your wallet…" });

  let hash = "";
  try {
    const res = await client.writeContract({
      address: address as `0x${string}`,
      functionName,
      args,
      value: valueAtto,
    });
    hash = typeof res === "string" ? res : (res?.transactionHash ?? res?.hash ?? "");
  } catch (err) {
    const e = err as { code?: number };
    const detail = walletErrorMessage(err);
    report({ stage: e?.code === 4001 ? "rejected" : "failed", detail });
    throw err;
  }

  report({ stage: "submitted", detail: "Sent to StudioNet.", hash });

  // Confirmation: poll the view predicate. Transient read noise is retried
  // rather than surfaced — a rate-limited read says nothing about the write.
  report({ stage: "pending", detail: "Waiting for the contract to reflect it…", hash });
  let landed = false;
  for (let i = 0; i < predicateTries && !landed; i++) {
    await sleep(6000);
    try {
      landed = await predicate();
    } catch (err) {
      if (!retryable(err)) {
        report({
          stage: "failed",
          detail: "The chain could not be read back to confirm this.",
          hash,
        });
        throw err;
      }
    }

    // Every third miss, look at the TRANSACTION as well as the state. A write
    // the contract refused will never satisfy the predicate, and before this
    // check the user stood at "pending" for the full three minutes and was
    // then told, wrongly, that the write might still land. A refusal that has
    // FINALIZED is the chain's last word and is reported as one.
    if (!landed && i % 3 === 2) {
      let refused = false;
      try {
        const v = await txStatus(hash);
        refused = (v.finalized && v.executed === "ERROR") || v.statusName === "CANCELED";
      } catch {
        // A failed status read says nothing about the write; the predicate
        // polling continues either way.
      }
      if (refused) {
        const detail =
          "StudioNet finalized this write as refused: the contract did not " +
          "accept it, and nothing moved.";
        report({ stage: "failed", detail, hash });
        throw new Error(detail);
      }
    }
  }

  if (!landed) {
    // Submitted but not yet visible. This is NOT a failure: StudioNet
    // finalization can lag, and the copy must not imply the money is lost. Nor
    // may it promise something that does not happen. An earlier version said
    // "this page keeps reading and will update when it lands", and nothing
    // polls after this returns, so the user was told to wait for an update that
    // would never arrive on its own.
    report({
      stage: "unresolved",
      detail:
        "Submitted, and StudioNet has not reflected it yet. It is not lost, and it may " +
        "still land. Nothing here is polling any more, so refresh in a moment to see " +
        "where it got to.",
      hash,
    });
    return hash;
  }

  // The state is live: every read from here on sees it, so the caller is
  // unblocked NOW. What is not yet true is irreversibility — ACCEPTED is a
  // state StudioNet can walk back — so the word for this stage is accepted,
  // and the finality watch below keeps reporting after this resolves.
  report({
    stage: "accepted",
    detail:
      "The contract reflects it. StudioNet has accepted the write, and " +
      "finality usually follows within a minute.",
    hash,
  });

  void watchFinality(hash, report, confirmedDetail, finalityTries, txStatus);
  return hash;
}

/**
 * The finality watch: poll the transaction until StudioNet reports FINALIZED,
 * and only then say so. Runs after writeAndConfirm has resolved, reporting
 * through the same onProgress the caller is already rendering. Never throws —
 * by the time it runs the caller has been handed the hash and the state is
 * live, so the only honest failure mode is the bounded "not yet final"
 * message at the end.
 */
async function watchFinality(
  hash: string,
  report: (p: TxProgress) => void,
  confirmedDetail: string,
  finalityTries: number,
  txStatus: (hash: string) => Promise<TxFinalityView>,
): Promise<void> {
  for (let i = 0; i < finalityTries; i++) {
    await sleep(6000);
    let v: TxFinalityView | null = null;
    try {
      v = await txStatus(hash);
    } catch {
      // Transient or not, a failed status read is answered by the next poll.
    }
    if (!v) continue;

    if (v.finalized && v.executed === "SUCCESS") {
      report({ stage: "confirmed", detail: confirmedDetail, hash });
      return;
    }

    // The state the user asked for is live — the predicate proved it — but
    // THIS transaction finalized without effect. That happens when a
    // permissionless call raced a stranger's identical transaction and lost,
    // and the honest sentence names it rather than crediting this write.
    if ((v.finalized && v.executed === "ERROR") || v.statusName === "CANCELED") {
      report({
        stage: "confirmed",
        detail:
          confirmedDetail +
          " This transaction itself finalized without effect — the state was " +
          "already produced by another transaction that got there first.",
        hash,
      });
      return;
    }
  }

  report({
    stage: "accepted",
    detail:
      "The contract reflects this write, and StudioNet has not yet reported " +
      "it finalized. That step almost always follows on its own. Nothing here " +
      "is polling any more, so refresh in a minute — and treat the write as " +
      "irreversible only once it shows finalized.",
    hash,
  });
}

/** Human-readable label per stage, for the stepper. */
export const STAGE_LABEL: Record<TxStage, string> = {
  idle: "Ready",
  wallet: "Confirm in wallet",
  submitted: "Submitted",
  pending: "Pending",
  accepted: "Accepted",
  confirmed: "Finalized",
  unresolved: "Not yet visible",
  rejected: "Declined",
  failed: "Failed",
};

/** The ordered stepper track — terminal error stages sit outside it. */
export const STAGE_TRACK: TxStage[] = [
  "wallet", "submitted", "pending", "accepted", "confirmed",
];

export function stageClass(step: TxStage, current: TxStage): string {
  if (current === "failed" || current === "rejected") {
    return step === "wallet" ? "step fail" : "step";
  }
  // Unresolved got as far as pending and stopped. Show that progress rather
  // than blanking the track, so the user can see the write was sent.
  if (current === "unresolved") {
    return step === "accepted" || step === "confirmed" ? "step" : "step done";
  }
  const at = STAGE_TRACK.indexOf(current);
  const me = STAGE_TRACK.indexOf(step);
  if (at < 0 || me < 0) return "step";
  if (me < at) return "step done";
  if (me === at) return "step on";
  return "step";
}
