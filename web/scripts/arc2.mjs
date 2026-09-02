/**
 * ARC II — every feature the first arc did not touch, on the same live
 * contract, resumable like the first: cancel, top-up, withdraw, the S23
 * solvency refusal and its recovery, the REVIEW_REQUIRED hold that reopens
 * the case, a NOT_BREACHED settlement that returns the reservation, the
 * stale-challenge lapse restoring the S29 snapshot, and five refusal walls
 * arc #1 never fired (stranger-accept, stranger-open, stranger-topup,
 * open-beyond-reserve, early-lapse).
 *
 * Run SOLO (no dev server polling): StudioNet allows 30 req/min, 500/hr.
 */
import { createAccount, createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { readFileSync, appendFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CONTRACT = (process.env.ADJUDEX_CONTRACT ?? "0xDFA6B51565e17B677085351303F8397cd28Cb54D");
const KEYS = JSON.parse(readFileSync(new URL("../.data/keys.json", import.meta.url), "utf-8"));

const CREDIT = 5n * 10n ** 16n;     // 0.05 GEN per period
const BOND = 5n * 10n ** 16n;       // challenge bond floor
const MARGIN_S = 380;
const STALE_S = 3600;
const PERIOD_A = "2026-09";
const PERIOD_B = "2026-10";

const LOG = fileURLToPath(new URL("../arc2.log", import.meta.url));
const OUT = fileURLToPath(new URL("../arc2.transcript.json", import.meta.url));
const FLAGS = fileURLToPath(new URL("../.data/arc2.flags.json", import.meta.url));

const transcript = existsSync(OUT)
  ? JSON.parse(readFileSync(OUT, "utf-8"))
  : { contract: CONTRACT, steps: [] };
const flags = existsSync(FLAGS) ? JSON.parse(readFileSync(FLAGS, "utf-8")) : {};

function log(line) {
  const msg = `[${new Date().toISOString()}] ${line}`;
  console.log(msg);
  appendFileSync(LOG, msg + "\n");
}
function record(step) {
  transcript.steps.push({ at: new Date().toISOString(), ...step });
  writeFileSync(OUT, JSON.stringify(transcript, null, 2));
}
function flag(name, value = new Date().toISOString()) {
  flags[name] = value;
  writeFileSync(FLAGS, JSON.stringify(flags, null, 2));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lane = Promise.resolve();
let lastAt = 0;
const GAP_MS = 6500;
function paced(job) {
  const run = lane.then(async () => {
    const wait = Math.max(0, lastAt + GAP_MS - Date.now());
    if (wait) await sleep(wait);
    lastAt = Date.now();
    return job();
  });
  lane = run.then(() => undefined, () => undefined);
  return run;
}

const TRANSIENT = /fetch failed|rate limit|429|-32029|timeout|ECONNRESET|socket|network|closed|terminated|other side|unknown rpc|execution slots/i;

function mk(pk) {
  const account = createAccount(pk);
  return { account, client: createClient({ chain: studionet, account }), address: account.address };
}
const P = { name: "provider", ...mk(KEYS.CREATOR.pk) };
const C = { name: "client", ...mk(KEYS.YES.pk) };
const N = { name: "stranger", ...mk(KEYS.NO.pk) };
const reader = createClient({ chain: studionet });

async function view(fn, args = [], tries = 5) {
  for (let i = 0; ; i++) {
    try {
      return await paced(() => reader.readContract({ address: CONTRACT, functionName: fn, args }));
    } catch (err) {
      if (i >= tries - 1 || !TRANSIENT.test(String(err?.message ?? err))) throw err;
      await sleep(10_000 * (i + 1));
    }
  }
}
async function jview(fn, args = []) {
  const raw = await view(fn, args);
  return raw ? JSON.parse(raw) : null;
}
async function receipt(hash) {
  return paced(() => reader.getTransaction({ hash }));
}

async function landed(hash, label) {
  for (let i = 0; i < 70; i++) {
    await sleep(15_000);
    let t = null;
    try { t = await receipt(hash); } catch { continue; }
    const status = t?.statusName ?? String(t?.status ?? "");
    const deciding = t?.consensus_data?.leader_receipt?.[0]?.execution_result;
    if (status === "FINALIZED") {
      if (deciding === "ERROR") {
        const err = new Error(`${label}: finalized REFUSED`);
        err.refused = true;
        throw err;
      }
      log(`   ${label}: FINALIZED (leader ${deciding})`);
      return;
    }
    if (status === "CANCELED") throw new Error(`${label}: CANCELED`);
    if (i % 4 === 3) log(`   ${label}: still ${status || "pending"}…`);
  }
  throw new Error(`${label}: no finality after 17 min`);
}

async function write(actor, fn, args, value = 0n, already = null) {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (already && (await already())) {
      log(`>> ${actor.name} ${fn}: already reflected on-chain — skipping send`);
      return null;
    }
    log(`>> ${actor.name} ${fn}(${args.map((a) => JSON.stringify(a).slice(0, 56)).join(", ")})${value ? ` value ${Number(value / 10n ** 15n) / 1000} GEN` : ""}${attempt ? ` [retry ${attempt}]` : ""}`);
    let hash;
    try {
      hash = await paced(() =>
        actor.client.writeContract({ address: CONTRACT, functionName: fn, args, value }),
      );
    } catch (err) {
      const msg = String(err?.message ?? err);
      if (!TRANSIENT.test(msg)) throw err;
      log(`   send failed transiently (${msg.slice(0, 90)}) — checking state before retrying`);
      await sleep(20_000);
      continue;
    }
    log(`   tx ${hash}`);
    await landed(hash, fn);
    record({ kind: "write", actor: actor.name, fn, value: value.toString(), hash });
    return hash;
  }
  throw new Error(`${fn}: could not send after retries`);
}

async function wall(name, actor, fn, args, value = 0n) {
  if (flags[`wall:${name}`]) {
    log(`WALL ${name}: already proven earlier — skipping`);
    return;
  }
  log(`>> WALL ${actor.name} ${fn} — expecting refusal (${name})`);
  let hash;
  try {
    hash = await paced(() =>
      actor.client.writeContract({ address: CONTRACT, functionName: fn, args, value }),
    );
  } catch (err) {
    const msg = String(err?.message ?? err).slice(0, 160);
    if (TRANSIENT.test(msg)) throw err;
    log(`   refused pre-flight: ${msg}`);
    record({ kind: "wall", name, refusedAt: "preflight", msg });
    flag(`wall:${name}`);
    return;
  }
  log(`   tx ${hash} (must finalize as ERROR)`);
  try {
    await landed(hash, fn);
  } catch (err) {
    if (err?.refused) {
      log(`   refused on-chain, finalized as ERROR — the wall held`);
      record({ kind: "wall", name, refusedAt: "finalized", hash });
      flag(`wall:${name}`);
      return;
    }
    throw err;
  }
  throw new Error(`WALL ${name}: was NOT refused`);
}

async function waitUntil(epoch, label) {
  for (;;) {
    const wait = epoch + MARGIN_S - Math.floor(Date.now() / 1000);
    if (wait <= 0) return;
    log(`waiting ${wait}s — ${label}`);
    await sleep(Math.min(wait, 300) * 1000);
  }
}

const TERMS_DRAFT = `SERVICE LEVEL AGREEMENT (ARC-II DRAFT — to be withdrawn before assent). The provider commits that 95% of eligible cross-border payments are processed within 30 minutes per service period. EXCEPTIONS: regulatory or compliance screening; documented infrastructure outages notified within 24 hours; incomplete instruction data supplied by the client. CONSEQUENCE: a period below the service level owes the client the agreed service credit.`;

const TERMS_MAIN = `SERVICE LEVEL AGREEMENT (ARC-II PRIMARY) between the correspondent bank (provider) and the institution (client).

SERVICE LEVEL: 95% of eligible cross-border payments must be processed within 30 minutes of instruction receipt, measured per service period.

ELIGIBILITY: a payment is eligible once complete instructions and beneficiary information are received. Payments with incomplete beneficiary information are not eligible until completed.

EXCEPTIONS: a late payment is excused where the delay was caused by (a) regulatory or compliance screening, (b) a documented infrastructure outage the provider notified within 24 hours, or (c) incomplete or incorrect instruction data supplied by the client.

CONSEQUENCE: falling below the service level in a period owes the client the agreed service credit for that period.`;

const THIN_ITEM = {
  kind: "correspondence",
  label: "Client note on September performance",
  content: "CLIENT NOTE, period 2026-09. Several counterparties mentioned that some September payments felt slower than usual. No processing log has been assembled yet; totals and timings to follow once the operations team completes its export.",
};

const GOOD_ITEMS = [
  { kind: "payment_log", label: "Payment processing log 2026-09", content: "PAYMENT PROCESSING LOG, period 2026-09. 100 eligible cross-border payments received with complete instructions. 98 processed within 30 minutes. 2 exceeded 30 minutes: TXN-1104 (41m), TXN-1188 (38m). No other payment exceeded the agreed processing time." },
  { kind: "exception_record", label: "Compliance screening records 2026-09", content: "EXCEPTION RECORDS, period 2026-09. TXN-1104: regulatory compliance screening hold, screening reference SCR-3101, cleared after 38 minutes. TXN-1188: regulatory compliance screening hold, screening reference SCR-3102, cleared after 35 minutes. No other payment in the period carried a screening hold." },
];
const GOOD_RESPONSE = {
  kind: "response",
  label: "Provider answer for 2026-09",
  content: "PROVIDER RESPONSE, period 2026-09. The provider confirms the processing log's totals: 100 eligible payments, 98 within the agreed time. The provider confirms both screening holds SCR-3101 and SCR-3102 as regulatory compliance screening under the agreement's exception (a). No unexcused late payment exists in the period.",
};
const CHALLENGE_ITEM_2 = {
  kind: "correspondence",
  label: "Client archive query",
  content: "CLIENT ARCHIVE QUERY. The client's compliance archive team could not immediately locate screening references SCR-3101 and SCR-3102 in the shared reference index and has asked the provider to confirm the issuing desk. No determination is asserted; the query is filed for the record.",
};

async function agreementByFlag(key) {
  return flags[key] ? await jview("get_agreement", [flags[key]]) : null;
}

async function main() {
  log(`ARC-II ${existsSync(FLAGS) ? "RESUME" : "START"} — contract ${CONTRACT}`);
  log(`provider ${P.address} · client ${C.address} · stranger ${N.address}`);

  const ids = async () =>
    ((await jview("get_agreements_for", [P.address])) ?? []).map((a) => a.agreement_id);

  // ── ACT I — the cancelled draft ────────────────────────────────────────
  let draft = await agreementByFlag("draft_id");
  if (!draft) {
    const before = await ids();
    await write(P, "create_agreement",
      [C.address, TERMS_DRAFT, 9500, CREDIT.toString(), 900, 900, 900, 900], CREDIT,
      async () => (await ids()).length > before.length);
    const after = await jview("get_agreements_for", [P.address]);
    draft = after[after.length - 1];
    flag("draft_id", draft.agreement_id);
  }
  log(`draft instrument ${draft.agreement_id} — status ${draft.status}`);

  if (draft.status === "CREATED") {
    await wall("stranger-accept", N, "accept_agreement", [draft.agreement_id]);
    await write(P, "cancel_agreement", [draft.agreement_id], 0n,
      async () => (await jview("get_agreement", [draft.agreement_id])).status === "CANCELLED");
    log(`draft CANCELLED — reserve returned to the provider's ledger`);
    record({ kind: "fact", what: "draft_cancelled", id: draft.agreement_id });
  }

  // ── ACT II — the living instrument, S23, top-up, withdraw ─────────────
  let ag = await agreementByFlag("main_id");
  if (!ag) {
    const before = await ids();
    await write(P, "create_agreement",
      [C.address, TERMS_MAIN, 9500, CREDIT.toString(), 900, 900, 900, 900], CREDIT,
      async () => (await ids()).length > before.length);
    const after = await jview("get_agreements_for", [P.address]);
    ag = after[after.length - 1];
    flag("main_id", ag.agreement_id);
  }
  const AID = ag.agreement_id;
  log(`primary instrument ${AID} — status ${ag.status}, free ${ag.reserve_free_atto}, held ${ag.reserve_held_atto}`);

  if (ag.status === "CREATED") {
    await write(C, "accept_agreement", [AID], 0n,
      async () => (await jview("get_agreement", [AID])).status !== "CREATED");
    ag = await jview("get_agreement", [AID]);
  }

  if (!flags["wall:stranger-open"]) {
    await wall("stranger-open", N, "open_case", [AID, PERIOD_A]);
    await wall("stranger-topup", N, "top_up_reserve", [AID], CREDIT);
  }

  let caseA = ((await jview("get_cases_for", [AID])) ?? [])
    .find((k) => k.period_label === PERIOD_A) ?? null;
  if (!caseA) {
    await write(C, "open_case", [AID, PERIOD_A], 0n,
      async () => ((await jview("get_cases_for", [AID])) ?? []).some((k) => k.period_label === PERIOD_A));
    caseA = ((await jview("get_cases_for", [AID])) ?? []).find((k) => k.period_label === PERIOD_A);
    const now = await jview("get_agreement", [AID]);
    log(`case A ${caseA.case_id} open — S23 debit: free ${now.reserve_free_atto} / held ${now.reserve_held_atto}`);
  }
  const CA = caseA.case_id;

  // S23 live: the free reserve is empty, so a second period cannot open.
  if (!flags["wall:open-beyond-reserve"]) {
    const now = await jview("get_agreement", [AID]);
    if (BigInt(now.reserve_free_atto) < CREDIT) {
      await wall("open-beyond-reserve", C, "open_case", [AID, PERIOD_B]);
    }
  }

  let caseB = ((await jview("get_cases_for", [AID])) ?? [])
    .find((k) => k.period_label === PERIOD_B) ?? null;
  if (!caseB) {
    await write(P, "top_up_reserve", [AID], CREDIT,
      async () => BigInt((await jview("get_agreement", [AID])).reserve_free_atto) >= CREDIT);
    log(`top-up landed — the refused period can now open`);
    await write(C, "open_case", [AID, PERIOD_B], 0n,
      async () => ((await jview("get_cases_for", [AID])) ?? []).some((k) => k.period_label === PERIOD_B));
    caseB = ((await jview("get_cases_for", [AID])) ?? []).find((k) => k.period_label === PERIOD_B);
    record({ kind: "fact", what: "s23_refusal_then_recovery", caseB: caseB.case_id });
  }
  if (caseB.status === "OPEN") {
    await write(C, "withdraw_case", [caseB.case_id], 0n,
      async () => (await jview("get_case", [caseB.case_id])).status === "WITHDRAWN");
    const now = await jview("get_agreement", [AID]);
    log(`case B withdrawn — reservation back to free: free ${now.reserve_free_atto} / held ${now.reserve_held_atto}`);
  }

  // ── ACT III — the hold that pays nobody ────────────────────────────────
  caseA = await jview("get_case", [CA]);
  if (caseA.status === "OPEN" && caseA.item_count === 0) {
    await write(C, "commit_evidence", [CA, JSON.stringify([THIN_ITEM])], 0n,
      async () => (await jview("get_case", [CA])).item_count > 0);
    caseA = await jview("get_case", [CA]);
  }

  if (caseA.status === "OPEN" && caseA.evidence_version === 1 &&
      !(await view("get_assessment", [CA, 1]))) {
    const agNow = await jview("get_agreement", [AID]);
    await waitUntil(caseA.last_commit_epoch + agNow.response_window, "response window (thin record)");
    await write(N, "adjudicate", [CA], 0n,
      async () => (await jview("get_case", [CA])).status !== "OPEN");
    const a1 = await jview("get_assessment", [CA, 1]);
    if (a1) {
      log(`PANEL A1 (v1): ${a1.verdict} — evidence ${a1.evidence_flag} · eligible ${a1.eligible_total} · score ${a1.score}`);
      log(`   reason: ${a1.reason}`);
      record({ kind: "panel", round: "A1", assessment: a1 });
    }
  }

  caseA = await jview("get_case", [CA]);
  if (caseA.status === "PENDING_FINALITY" && caseA.evidence_version === 1) {
    await waitUntil(caseA.pending_until_epoch, "finality window (hold)");
    await write(N, "promote", [CA], 0n,
      async () => (await jview("get_case", [CA])).status !== "PENDING_FINALITY");
    caseA = await jview("get_case", [CA]);
    const agNow = await jview("get_agreement", [AID]);
    log(`promoted — status ${caseA.status}, verdict ${caseA.verdict}; reservation still held: ${agNow.reserve_held_atto}`);
    record({ kind: "fact", what: "review_hold_reopened", status: caseA.status, verdict: caseA.verdict, held: agNow.reserve_held_atto });
  }

  // ── ACT IV — the clean period ──────────────────────────────────────────
  caseA = await jview("get_case", [CA]);
  if (caseA.status === "OPEN" && caseA.evidence_version === 1) {
    await write(C, "commit_evidence", [CA, JSON.stringify(GOOD_ITEMS)], 0n,
      async () => (await jview("get_case", [CA])).evidence_version >= 2);
    caseA = await jview("get_case", [CA]);
  }
  if (caseA.status === "OPEN" && caseA.evidence_version === 2) {
    const acks = (await jview("get_acks", [CA])) ?? {};
    if (acks["EV-002"] !== "ACK") {
      await write(P, "review_evidence", [CA, "EV-002", "ack"], 0n,
        async () => ((await jview("get_acks", [CA])) ?? {})["EV-002"] === "ACK");
    }
    if (acks["EV-003"] !== "ACK") {
      await write(P, "review_evidence", [CA, "EV-003", "ack"], 0n,
        async () => ((await jview("get_acks", [CA])) ?? {})["EV-003"] === "ACK");
    }
    caseA = await jview("get_case", [CA]);
    if (caseA.item_count < 4) {
      await write(P, "commit_evidence", [CA, JSON.stringify([GOOD_RESPONSE])], 0n,
        async () => (await jview("get_case", [CA])).item_count >= 4);
      caseA = await jview("get_case", [CA]);
    }
  }

  caseA = await jview("get_case", [CA]);
  if (caseA.status === "OPEN" && caseA.evidence_version >= 2 &&
      !(await view("get_assessment", [CA, caseA.evidence_version]))) {
    const agNow = await jview("get_agreement", [AID]);
    await waitUntil(caseA.last_commit_epoch + agNow.response_window, "response window (clean record)");
    await write(N, "adjudicate", [CA], 0n,
      async () => (await jview("get_case", [CA])).status !== "OPEN");
    caseA = await jview("get_case", [CA]);
    const a2 = await jview("get_assessment", [CA, caseA.pending_version || caseA.evidence_version]);
    if (a2) {
      log(`PANEL A2 (v${a2.evidence_version}): ${a2.verdict} — rate ${a2.rate_bps} vs ${a2.threshold_bps} · eligible ${a2.eligible_total}, late ${a2.late_total}, excused ${JSON.stringify(a2.excused)} · ${a2.evidence_flag} · score ${a2.score}`);
      log(`   reason: ${a2.reason}`);
      record({ kind: "panel", round: "A2", assessment: a2 });
    }
  }

  caseA = await jview("get_case", [CA]);
  if (caseA.status === "PENDING_FINALITY") {
    await waitUntil(caseA.pending_until_epoch, "finality window (clean verdict)");
    await write(N, "promote", [CA], 0n,
      async () => (await jview("get_case", [CA])).status !== "PENDING_FINALITY");
    caseA = await jview("get_case", [CA]);
    log(`promoted — status ${caseA.status}, verdict ${caseA.verdict}`);
  }

  if (caseA.status === "OPEN") {
    log(`the second panel ALSO held — recorded honestly; rerun the arc to continue from the grown record.`);
    record({ kind: "fact", what: "second_hold", case: caseA });
    return;
  }

  // ── ACT V — the stale challenge and the S29 lapse ─────────────────────
  caseA = await jview("get_case", [CA]);
  if (caseA.status === "FINAL" && !caseA.challenge_open && !flags["lapse_done"] &&
      Math.floor(Date.now() / 1000) < caseA.challenge_until_epoch - MARGIN_S) {
    await write(C, "challenge",
      [CA, "the screening references could not be located in the client's compliance archive index and the client asks the record to be re-read",
       JSON.stringify([CHALLENGE_ITEM_2])], BOND,
      async () => Boolean((await jview("get_case", [CA])).challenge_open));
    caseA = await jview("get_case", [CA]);
    log(`challenge filed — record now v${caseA.evidence_version}; the challenger will now go silent`);
  }

  caseA = await jview("get_case", [CA]);
  if (caseA.challenge_open) {
    await wall("early-lapse", N, "lapse_challenge", [CA]);
    await waitUntil(caseA.challenge_filed_epoch + STALE_S, "stale-challenge window (no re-adjudication will come)");
    const preLedger = await view("get_claimable", [C.address]);
    await write(N, "lapse_challenge", [CA], 0n,
      async () => !(await jview("get_case", [CA])).challenge_open);
    caseA = await jview("get_case", [CA]);
    const postLedger = await view("get_claimable", [C.address]);
    log(`LAPSED — snapshot restored: status ${caseA.status}, verdict ${caseA.verdict}, record back to v${caseA.evidence_version}; challenger ledger ${preLedger} → ${postLedger} (bond returned)`);
    record({ kind: "fact", what: "s29_lapse", restored: { status: caseA.status, verdict: caseA.verdict, version: caseA.evidence_version }, bond_back: postLedger });
    flag("lapse_done");
  }

  // ── ACT VI — settle NOT_BREACHED, close, drain ────────────────────────
  caseA = await jview("get_case", [CA]);
  if (caseA.status === "FINAL") {
    await waitUntil(caseA.challenge_until_epoch, "challenge window before settlement");
    await write(N, "settle", [CA], 0n,
      async () => (await jview("get_case", [CA])).status === "SETTLED");
    caseA = await jview("get_case", [CA]);
    const agNow = await jview("get_agreement", [AID]);
    log(`SETTLED — verdict ${caseA.verdict}; reservation returned: free ${agNow.reserve_free_atto} / held ${agNow.reserve_held_atto}`);
    record({ kind: "fact", what: "settled", verdict: caseA.verdict, free: agNow.reserve_free_atto });
  }

  let agNow = await jview("get_agreement", [AID]);
  if (agNow.status === "ACTIVE") {
    await write(P, "begin_close", [AID], 0n,
      async () => (await jview("get_agreement", [AID])).status !== "ACTIVE");
    agNow = await jview("get_agreement", [AID]);
  }
  if (agNow.status === "CLOSING") {
    await waitUntil(agNow.closing_epoch + agNow.notice_window, "close-out notice");
    await write(N, "finalize_close", [AID], 0n,
      async () => (await jview("get_agreement", [AID])).status === "CLOSED");
  }

  for (const actor of [P, C]) {
    const owed = BigInt(await view("get_claimable", [actor.address]));
    if (owed > 0n) {
      log(`${actor.name} ledger ${owed} atto — claiming`);
      await write(actor, "claim", [], 0n,
        async () => BigInt(await view("get_claimable", [actor.address])) === 0n);
    }
  }

  const stats = await jview("get_stats", []);
  log(`stats after: ${JSON.stringify(stats)}`);
  record({ kind: "fact", what: "final_stats", stats });
  if (stats.escrow_atto === "0") {
    log("CUSTODY ZERO — every atto in, accounted out. ARC-II COMPLETE.");
  } else {
    log(`ARC-II FAILED CUSTODY CHECK — escrow ${stats.escrow_atto}`);
  }
}

main().catch((err) => {
  log(`ARC-II FAILED: ${String(err?.stack ?? err).slice(0, 800)}`);
  process.exitCode = 1;
});
