/**
 * ARC III — evidence authenticity, live on v0.2.0 (the reviewer-round
 * answer): the S34 floor holding an uncorroborated breach for review, the
 * REVIEW hold reopening the case, a chain-anchored record whose anchor
 * every validator verifies itself (VERIFIED) beside a fabricated anchor
 * the chain refutes (NOT_FOUND) in the same dossier, the corroborated
 * breach paying, and two intake walls (unknown chain, malformed hash).
 *
 * Run SOLO and DETACHED (Start-Process): StudioNet allows 30 req/min.
 */
import { createAccount, createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { readFileSync, appendFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CONTRACT = (process.env.ADJUDEX_CONTRACT ?? "0x8B20EF7440085bd987207933923a3c68Ef8030d6");
const DEPLOY_TX = "0x9d36fbb996b89d89f5d23290f46ce1ef8e661d67425c40a1547db3eed6aeac97";
const FABRICATED_TX = "0x" + "00".repeat(31) + "aa";
const KEYS = JSON.parse(readFileSync(new URL("../.data/keys.json", import.meta.url), "utf-8"));

const CREDIT = 5n * 10n ** 16n;     // 0.05 GEN per period
const MARGIN_S = 380;
const PERIOD = "2026-09";

const LOG = fileURLToPath(new URL("../arc3.log", import.meta.url));
const OUT = fileURLToPath(new URL("../arc3.transcript.json", import.meta.url));
const FLAGS = fileURLToPath(new URL("../.data/arc3.flags.json", import.meta.url));

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
    if (status === "FINALIZED") {
      // Ground truth probed live on this network: a VETOED round finalizes
      // MAJORITY_DISAGREE with every leader receipt reading SUCCESS — the
      // receipts describe the rounds, the consensus result decides whether
      // the write's state ever landed. Run 1 of this arc misread exactly
      // that and silently skipped a panel.
      const resultName = t?.result_name ?? "";
      if (resultName === "MAJORITY_DISAGREE") {
        const err = new Error(`${label}: finalized MAJORITY_DISAGREE — the round was vetoed, nothing written`);
        err.disagreed = true;
        throw err;
      }
      // The receipt array mixes the leader entry with per-validator
      // entries; idle validators legitimately show ERROR
      // (CONSENSUS_VALIDATOR_QUORUM_REACHED) after quorum. Only the
      // LEADER entry decides execution.
      const receipts = t?.consensus_data?.leader_receipt ?? [];
      const arr = Array.isArray(receipts) ? receipts : [receipts];
      const leader = arr.find((r) => r?.mode !== "validator") ?? arr[0];
      const deciding = leader?.execution_result;
      if (deciding === "ERROR") {
        const err = new Error(`${label}: finalized REFUSED`);
        err.refused = true;
        throw err;
      }
      log(`   ${label}: FINALIZED (${resultName || "?"}; leader ${deciding || "?"})`);
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
    try {
      await landed(hash, fn);
    } catch (err) {
      if (err?.disagreed) {
        // An honest veto: validators refused the leader's packet and the
        // protocol wrote nothing. Absence is the record — and the crank is
        // permissionless, so the honest response is to turn it again.
        log(`   ${fn}: vetoed (MAJORITY_DISAGREE) — retrying the round`);
        record({ kind: "veto", actor: actor.name, fn, hash });
        await sleep(20_000);
        continue;
      }
      throw err;
    }
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

function expect(cond, what) {
  if (!cond) throw new Error(`EXPECTATION FAILED: ${what}`);
  log(`   ok: ${what}`);
}

const TERMS = `SERVICE LEVEL AGREEMENT (ARC-III) between the correspondent bank (provider) and the institution (client). 95% of eligible cross-border payments must be processed within 30 minutes of instruction receipt in each service period. EXCEPTIONS: delays caused by regulatory or compliance screening are excepted; delays caused by documented infrastructure outages the provider notified within 24 hours are excepted; payments with incomplete beneficiary information are not eligible until completed. CONSEQUENCE: falling below the threshold in a service period owes the client the agreed service credit.`;

const LOG_ITEM = {
  kind: "payment_log", label: "Payment processing log",
  content: "PAYMENT PROCESSING LOG, period 2026-09. 100 eligible cross-border payments received. 90 processed within 30 minutes. 10 exceeded 30 minutes: TXN-0041 (44m), TXN-0102 (47m), TXN-0177 (61m), TXN-0203 (39m), TXN-0264 (52m), TXN-0311 (35m), TXN-0362 (88m), TXN-0410 (41m), TXN-0455 (49m), TXN-0489 (73m).",
};
const EXC_ITEM = {
  kind: "exception_record", label: "Exception records",
  content: "EXCEPTION RECORDS, period 2026-09. TXN-0041: regulatory compliance screening hold, cleared after 41 minutes, screening reference SCR-3312. TXN-0102: compliance screening hold, reference SCR-3319. TXN-0177: in flight during the settlement gateway degradation notified as incident INC-91 at 09:41 UTC the same day.",
};
const ANCHORED_ITEM = {
  kind: "payment_log", label: "Anchored settlement batch record",
  content: "SETTLEMENT BATCH RECORD, period 2026-09. The on-chain transaction this item anchors is the settlement-rail commitment for batch BATCH-2026-09-A, the batch containing the ten late transactions itemized in the payment processing log. The anchor binds this record to a transaction the adjudicating validators verify on the chain themselves.",
  anchor_chain: "genlayer-studionet", anchor_tx: DEPLOY_TX,
};
const FABRICATED_ITEM = {
  kind: "correspondence", label: "Wire confirmation (unverifiable reference)",
  content: "WIRE CONFIRMATION INDEX, period 2026-09. Supplementary reference relayed by the client back office: counterparty confirmation digest for batch BATCH-2026-09-A. Anchored to the transaction reference provided by the counterparty desk.",
  anchor_chain: "genlayer-studionet", anchor_tx: FABRICATED_TX,
};

async function main() {
  log(`ARC-III ${existsSync(FLAGS) ? "RESUME" : "START"} — contract ${CONTRACT}`);
  log(`provider ${P.address} · client ${C.address} · stranger ${N.address}`);

  // ── ACT I — instrument ─────────────────────────────────────────────────
  let ag = null;
  if (flags["aid"]) ag = await jview("get_agreement", [flags["aid"]]);
  if (!ag) {
    const before = (await jview("get_agreements_for", [P.address])) ?? [];
    const createTx = await write(P, "create_agreement",
      [C.address, TERMS, 9500, CREDIT.toString(), 900, 900, 900, 900], CREDIT,
      async () => ((await jview("get_agreements_for", [P.address])) ?? []).length > before.length);
    const after = await jview("get_agreements_for", [P.address]);
    ag = after[after.length - 1];
    flag("aid", ag.agreement_id);
    if (createTx) flag("create_tx", createTx);
  }
  const AID = flags["aid"];
  log(`instrument ${AID} — status ${ag.status}`);

  if (ag.status === "CREATED") {
    await write(C, "accept_agreement", [AID], 0n,
      async () => (await jview("get_agreement", [AID])).status !== "CREATED");
  }

  // ── ACT II — the case, then the intake walls: the anchor cannot be
  // gamed at the door ────────────────────────────────────────────────────
  let cs = ((await jview("get_cases_for", [AID])) ?? [])
    .find((k) => k.period_label === PERIOD) ?? null;
  if (!cs) {
    await write(C, "open_case", [AID, PERIOD], 0n,
      async () => ((await jview("get_cases_for", [AID])) ?? []).some((k) => k.period_label === PERIOD));
    cs = ((await jview("get_cases_for", [AID])) ?? []).find((k) => k.period_label === PERIOD);
  }
  const CID = cs.case_id;
  log(`case ${CID} — status ${cs.status}, version ${cs.evidence_version}`);

  await wall("anchor-unknown-chain", C, "commit_evidence",
    [CID, JSON.stringify([{ ...LOG_ITEM, anchor_chain: "dogechain", anchor_tx: DEPLOY_TX }])]);
  await wall("anchor-bad-hash", C, "commit_evidence",
    [CID, JSON.stringify([{ ...LOG_ITEM, anchor_chain: "genlayer-studionet", anchor_tx: "0x1234" }])]);
  await wall("anchor-chain-without-tx", C, "commit_evidence",
    [CID, JSON.stringify([{ ...LOG_ITEM, anchor_chain: "genlayer-studionet" }])]);

  // ── ACT III — the uncorroborated breach holds (S34 live) ───────────────
  cs = await jview("get_case", [CID]);
  if (cs.status === "OPEN" && cs.evidence_version === 0) {
    await write(C, "commit_evidence", [CID, JSON.stringify([LOG_ITEM, EXC_ITEM])], 0n,
      async () => (await jview("get_case", [CID])).item_count > 0);
    cs = await jview("get_case", [CID]);
  }
  if (cs.status === "OPEN" && cs.evidence_version === 1 &&
      !(await view("get_assessment", [CID, 1]))) {
    const agNow = await jview("get_agreement", [AID]);
    await waitUntil(cs.last_commit_epoch + agNow.response_window, "response window (v1, provider silent)");
    await write(N, "adjudicate", [CID], 0n,
      async () => (await jview("get_case", [CID])).status !== "OPEN");
  }
  // Run 1's v1 panel finalized MAJORITY_DISAGREE — a live veto: validators
  // refused the leader's packet over the uncorroborated record and the
  // protocol wrote nothing. Recorded as the honest fact it is; the S34
  // floor itself is proven on a second case below, where the record's
  // version is frozen for it.
  if (!flags["v1_veto_recorded"] &&
      !(await view("get_assessment", [CID, 1]))) {
    record({
      kind: "fact", what: "live_veto_observed",
      tx: "0xd22b915856419e17f90e7ddf8b69e1f4c6cdbbf7fc9fbf124a813365d71df2e5",
      result: "MAJORITY_DISAGREE",
      note: "failed consensus wrote nothing; the case stayed OPEN and retriable",
    });
    log("   v1 veto recorded: MAJORITY_DISAGREE observed live, absence is the record");
    flag("v1_veto_recorded");
  }
  const a1 = await jview("get_assessment", [CID, 1]);
  if (a1 && !flags["a1_checked"]) {
    log(`PANEL v1: ${a1.verdict} · corroboration ${a1.corroboration} · evidence ${a1.evidence_flag}`);
    flag("a1_checked");
  }

  cs = await jview("get_case", [CID]);
  if (cs.status === "PENDING_FINALITY") {
    await waitUntil(cs.pending_until_epoch, "finality window (v1 hold)");
    await write(N, "promote", [CID], 0n,
      async () => (await jview("get_case", [CID])).status !== "PENDING_FINALITY");
    cs = await jview("get_case", [CID]);
    log(`promoted — status ${cs.status} (the REVIEW hold reopened the case; reservation stays held)`);
    expect(cs.status === "OPEN", "REVIEW promotion reopened the case");
  }

  // ── ACT IV — the anchored record: VERIFIED beside NOT_FOUND ────────────
  cs = await jview("get_case", [CID]);
  if (cs.status === "OPEN" && cs.evidence_version === 1) {
    await write(C, "commit_evidence", [CID, JSON.stringify([ANCHORED_ITEM, FABRICATED_ITEM])], 0n,
      async () => (await jview("get_case", [CID])).evidence_version >= 2);
    cs = await jview("get_case", [CID]);
  }
  if (cs.status === "OPEN" && cs.evidence_version === 2 &&
      !(await view("get_assessment", [CID, 2]))) {
    const agNow = await jview("get_agreement", [AID]);
    await waitUntil(cs.last_commit_epoch + agNow.response_window, "response window (v2, anchored)");
    await write(N, "adjudicate", [CID], 0n,
      async () => (await jview("get_case", [CID])).status !== "OPEN");
  }
  const a2 = await jview("get_assessment", [CID, 2]);
  if (a2 && !flags["a2_checked"]) {
    log(`PANEL v2: ${a2.verdict} · corroboration ${a2.corroboration} · rate ${a2.rate_bps} vs ${a2.threshold_bps} · evidence ${a2.evidence_flag} · score ${a2.score}`);
    log(`   reason: ${a2.reason}`);
    for (const r of a2.rows) {
      if (r.anchor_state) log(`   ${r.id}: anchor ${r.anchor_state} (${r.anchor_chain} ${String(r.anchor_tx).slice(0, 18)}…)`);
    }
    const anchored = a2.rows.find((r) => r.anchor_tx === DEPLOY_TX);
    const fabricated = a2.rows.find((r) => r.anchor_tx === FABRICATED_TX);
    expect(anchored?.anchor_state === "VERIFIED", "the real anchor was VERIFIED by the panel's own nodes");
    expect(fabricated?.anchor_state === "NOT_FOUND", "the fabricated anchor was refuted by the chain");
    expect(a2.corroboration === "INDEPENDENT", "corroboration is INDEPENDENT via the verified anchor");
    expect(a2.verdict === "BREACHED", "the corroborated breach stands");
    record({ kind: "fact", what: "anchored_breach_live", verdict: a2.verdict, corroboration: a2.corroboration, anchor_verified: anchored?.anchor_state, anchor_fabricated: fabricated?.anchor_state, conflicts: a2.conflicts });
    flag("a2_checked");
  }

  // ── ACT V — finality, settlement, custody zero ─────────────────────────
  cs = await jview("get_case", [CID]);
  if (cs.status === "PENDING_FINALITY") {
    await waitUntil(cs.pending_until_epoch, "finality window (v2 breach)");
    await write(N, "promote", [CID], 0n,
      async () => (await jview("get_case", [CID])).status !== "PENDING_FINALITY");
    cs = await jview("get_case", [CID]);
    log(`promoted — status ${cs.status}, verdict ${cs.verdict}`);
  }
  if (cs.status === "FINAL") {
    await waitUntil(cs.challenge_until_epoch, "challenge window (unchallenged)");
    await write(N, "settle", [CID], 0n,
      async () => (await jview("get_case", [CID])).status === "SETTLED");
    cs = await jview("get_case", [CID]);
    expect(cs.status === "SETTLED" && cs.verdict === "BREACHED", "settled BREACHED");
  }

  const ledger = await view("get_claimable", [C.address]);
  log(`client ledger: ${ledger}`);
  if (BigInt(ledger) > 0n) {
    await write(C, "claim", [], 0n,
      async () => (await view("get_claimable", [C.address])) === "0");
    log(`client claimed the service credit — the anchored breach paid`);
  }

  // ── ACT VI — the S34 floor, on a case whose version stays frozen ───────
  const PERIOD_B = "2026-10";
  let cs2 = ((await jview("get_cases_for", [AID])) ?? [])
    .find((k) => k.period_label === PERIOD_B) ?? null;
  if (!cs2) {
    const agNow = await jview("get_agreement", [AID]);
    if (BigInt(agNow.reserve_free_atto) < CREDIT) {
      await write(P, "top_up_reserve", [AID], CREDIT,
        async () => BigInt((await jview("get_agreement", [AID])).reserve_free_atto) >= CREDIT);
    }
    await write(C, "open_case", [AID, PERIOD_B], 0n,
      async () => ((await jview("get_cases_for", [AID])) ?? []).some((k) => k.period_label === PERIOD_B));
    cs2 = ((await jview("get_cases_for", [AID])) ?? []).find((k) => k.period_label === PERIOD_B);
  }
  const CID2 = cs2.case_id;
  log(`floor case ${CID2} — status ${cs2.status}, version ${cs2.evidence_version}`);

  cs2 = await jview("get_case", [CID2]);
  if (cs2.status === "OPEN" && cs2.evidence_version === 0) {
    const items = [
      { ...LOG_ITEM, content: LOG_ITEM.content.replaceAll("2026-09", PERIOD_B) },
      { ...EXC_ITEM, content: EXC_ITEM.content.replaceAll("2026-09", PERIOD_B) },
    ];
    await write(C, "commit_evidence", [CID2, JSON.stringify(items)], 0n,
      async () => (await jview("get_case", [CID2])).item_count > 0);
    cs2 = await jview("get_case", [CID2]);
  }
  if (cs2.status === "OPEN" && cs2.evidence_version === 1 &&
      !(await view("get_assessment", [CID2, 1]))) {
    const agNow = await jview("get_agreement", [AID]);
    await waitUntil(cs2.last_commit_epoch + agNow.response_window,
      "response window (floor case, provider silent, no anchors)");
    await write(N, "adjudicate", [CID2], 0n,
      async () => (await jview("get_case", [CID2])).status !== "OPEN");
  }
  const b1 = await jview("get_assessment", [CID2, 1]);
  if (b1 && !flags["b1_checked"]) {
    log(`PANEL floor-case: ${b1.verdict} · corroboration ${b1.corroboration} · evidence ${b1.evidence_flag} · eligible ${b1.eligible_total} · late ${b1.late_total} · score ${b1.score}`);
    log(`   reason: ${b1.reason}`);
    expect(b1.corroboration === "NONE", "floor-case record is uncorroborated (no ack, no anchor)");
    expect(b1.verdict === "REVIEW_REQUIRED", "S34 floor held the uncorroborated breach for review — live");
    record({ kind: "fact", what: "s34_floor_live", verdict: b1.verdict, corroboration: b1.corroboration, evidence: b1.evidence_flag, rate_bps: b1.rate_bps });
    flag("b1_checked");
  }

  cs2 = await jview("get_case", [CID2]);
  if (cs2.status === "PENDING_FINALITY") {
    await waitUntil(cs2.pending_until_epoch, "finality window (floor hold)");
    await write(N, "promote", [CID2], 0n,
      async () => (await jview("get_case", [CID2])).status !== "PENDING_FINALITY");
    cs2 = await jview("get_case", [CID2]);
    expect(cs2.status === "OPEN", "the floor hold reopened the case with the reservation held");
    log(`floor case reopened — the client can now anchor or the provider can answer`);
  }
  if (cs2.status === "OPEN" && flags["b1_checked"] && !flags["reopen_recorded"]) {
    // The reopen promote landed in the previous run (leader returned
    // "review_required"); the runner died misreading a validator row.
    record({
      kind: "fact", what: "review_hold_reopened_case",
      tx: "0x708f6f36633df7586fe69266b18b55f081199a5a5e4869ae5e0afebc58570e27",
      note: "promote of the S34 hold returned review_required; the case reopened with the reservation held",
    });
    log("floor case reopened (recorded from the landed promote)");
    flag("reopen_recorded");
  }
  if (cs2.status === "OPEN" && flags["b1_checked"]) {
    await write(C, "withdraw_case", [CID2], 0n,
      async () => (await jview("get_case", [CID2])).status === "WITHDRAWN");
    log(`floor case withdrawn — the reservation returned to the free reserve`);
  }

  // ── ACT VII — close-out, custody zero ──────────────────────────────────
  let agEnd = await jview("get_agreement", [AID]);
  if (agEnd.status === "ACTIVE" && BigInt(agEnd.reserve_held_atto) === 0n) {
    await write(P, "begin_close", [AID], 0n,
      async () => (await jview("get_agreement", [AID])).status !== "ACTIVE");
    agEnd = await jview("get_agreement", [AID]);
  }
  if (agEnd.status === "CLOSING") {
    await waitUntil(agEnd.closing_epoch + agEnd.notice_window, "close-out notice window");
    await write(P, "finalize_close", [AID], 0n,
      async () => (await jview("get_agreement", [AID])).status === "CLOSED");
  }
  const pLedger = await view("get_claimable", [P.address]);
  if (BigInt(pLedger) > 0n) {
    await write(P, "claim", [], 0n,
      async () => (await view("get_claimable", [P.address])) === "0");
    log(`provider claimed the returned reserve`);
  }

  const stats = await jview("get_stats", []);
  log(`STATS ${JSON.stringify(stats)}`);
  record({ kind: "done", stats });
  log("ARC-III COMPLETE — the authenticity ladder proven live.");
}

main().catch((err) => {
  log(`FATAL: ${err?.stack ?? err}`);
  process.exitCode = 1;
});
