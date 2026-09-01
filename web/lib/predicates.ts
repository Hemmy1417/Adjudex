"use client";

/**
 * One predicate per write: "has the chain caught up with what was asked?"
 *
 * They live here, beside the reads they poll, because a predicate written
 * inline at a call site once polled for a field the contract deliberately
 * withholds until finality — and a write that had succeeded was reported as
 * unconfirmed. Each one forces a fresh read (`force = true`): confirming
 * against the cache would confirm nothing.
 */
import {
  getAgreement, getAgreements, getCase, getClaimable, getStats,
} from "./read";
import { sameAddress } from "./chain";

/** create_agreement landed: the docket total grew past what it was. */
export function agreementCountAbove(before: number) {
  return async () => (await getAgreements(0, 1, true)).total > before;
}

export function agreementStatusIs(id: string, ...statuses: string[]) {
  return async () => {
    const ag = await getAgreement(id, true);
    return !!ag && statuses.includes(ag.status);
  };
}

/** top_up landed: the free reserve reads at or above the expected total. */
export function reserveFreeAtLeast(id: string, atto: bigint) {
  return async () => {
    const ag = await getAgreement(id, true);
    return !!ag && BigInt(ag.reserve_free_atto) >= atto;
  };
}

/** open_case landed: the agreement counts one more case. */
export function caseCountAbove(agreementId: string, before: number) {
  return async () => {
    const ag = await getAgreement(agreementId, true);
    return !!ag && ag.case_count > before;
  };
}

export function caseStatusIs(caseId: string, ...statuses: string[]) {
  return async () => {
    const cs = await getCase(caseId, true);
    return !!cs && statuses.includes(cs.status);
  };
}

/** commit_evidence landed: the record advanced past the version we saw. */
export function evidenceVersionAbove(caseId: string, before: number) {
  return async () => {
    const cs = await getCase(caseId, true);
    return !!cs && cs.evidence_version > before;
  };
}

/** review_evidence landed when the position reads back. */
export function ackRecorded(caseId: string, itemId: string, position: string) {
  return async () => {
    const { getAcks } = await import("./read");
    const acks = await getAcks(caseId, true);
    return acks[itemId] === position;
  };
}

/** adjudicate landed: this version now has a pending verdict (or the case
 *  advanced past OPEN through someone else's identical call). */
export function adjudicationPending(caseId: string, version: number) {
  return async () => {
    const cs = await getCase(caseId, true);
    return !!cs && (cs.pending_version >= version || cs.status !== "OPEN");
  };
}

/** challenge landed: the case reports an open challenge. */
export function challengeOpen(caseId: string) {
  return async () => {
    const cs = await getCase(caseId, true);
    return !!cs && cs.challenge_open;
  };
}

/** re_adjudicate / lapse landed: the challenge is no longer open. */
export function challengeClosed(caseId: string) {
  return async () => {
    const cs = await getCase(caseId, true);
    return !!cs && !cs.challenge_open;
  };
}

/** settle landed. */
export function caseSettled(caseId: string) {
  return caseStatusIs(caseId, "SETTLED");
}

/** claim landed: the ledger for this wallet reads zero again. */
export function claimDrained(addr: string) {
  return async () => (await getClaimable(addr, true)) === "0";
}

/** Anything that changes the global counters. */
export function statsChanged(before: { agreements: number; cases: number; settled: number }) {
  return async () => {
    const s = await getStats(true);
    return (
      s.agreements !== before.agreements ||
      s.cases !== before.cases ||
      s.settled !== before.settled
    );
  };
}

/** For ownership-gated UI, not for writes: is this wallet a party? */
export function isParty(addr: string, provider: string, client: string): boolean {
  return sameAddress(addr, provider) || sameAddress(addr, client);
}
