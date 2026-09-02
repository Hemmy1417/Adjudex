/**
 * The live proof arc, RESUMABLE: a state machine that reads the chain and
 * performs the next missing act — create → assent → case → record →
 * provider answer → refusal walls → panel → promote → bonded challenge →
 * second panel → settle → close-out → claims → custody zero.
 *
 * Safe against interruption at any point: every decision is taken from
 * fresh views, value-carrying writes re-check state before any retry, and
 * a local flag file only gates the (harmless but budget-costly) refusal
 * walls from re-running.
 *
 * Run SOLO (no dev server polling): StudioNet allows 30 req/min, 500/hr.
 */
import { createAccount, createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { readFileSync, appendFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CONTRACT = (process.env.ADJUDEX_CONTRACT ?? "0xDFA6B51565e17B677085351303F8397cd28Cb54D");
const KEYS = JSON.parse(readFileSync(new URL("../.data/keys.json", import.meta.url), "utf-8"));

const CREDIT = 5n * 10n ** 16n;
const RESERVE = 15n * 10n ** 16n;
const BOND = 5n * 10n ** 16n;
const MARGIN_S = 380;               // clock envelope + settle margin
const PERIOD = "2026-08";

const LOG = fileURLToPath(new URL("../arc.log", import.meta.url));
const OUT = fileURLToPath(new URL("../arc.transcript.json", import.meta.url));
const FLAGS = fileURLToPath(new URL("../.data/arc.flags.json", import.meta.url));

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
function flag(name) {
  flags[name] = new Date().toISOString();
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

const TRANSIENT = /fetch failed|rate limit|429|-32029|timeout|ECONNRESET|socket|network|closed|terminated|other side|unknown rpc/i;

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

/**
 * A write that must succeed. On a TRANSIENT send failure: zero-value writes
 * retry directly; value-carrying writes first ask `already()` whether the
 * state moved (a lost response is not a lost transaction), and only retry
 * when the chain says the write did not land.
 */
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

/** A write that must be REFUSED — the walls of the proof. */
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

/** Sleep until local wall-clock passes `epoch` + margin (display estimate —
 *  the contract enforces its own consensus clock; margin absorbs the skew). */
async function waitUntil(epoch, label) {
  for (;;) {
    const wait = epoch + MARGIN_S - Math.floor(Date.now() / 1000);
    if (wait <= 0) return;
    log(`waiting ${wait}s — ${label}`);
    await sleep(Math.min(wait, 300) * 1000);
  }
}

const TERMS = `SERVICE LEVEL AGREEMENT between the correspondent bank (provider) and the institution (client).

SERVICE LEVEL: 95% of eligible cross-border payments must be processed within 30 minutes of instruction receipt, measured per service period.

ELIGIBILITY: a payment is eligible once complete instructions and beneficiary information are received. Payments with incomplete beneficiary information are not eligible until completed.

EXCEPTIONS: a late payment is excused where the delay was caused by (a) regulatory or compliance screening, (b) a documented infrastructure outage the provider notified within 24 hours, or (c) incomplete or incorrect instruction data supplied by the client.

CONSEQUENCE: falling below the service level in a period owes the client the agreed service credit for that period.`;

const ITEMS = [
  { kind: "payment_log", label: "Payment processing log 2026-08", content: "PAYMENT PROCESSING LOG, period 2026-08. 100 eligible cross-border payments received with complete instructions. 90 processed within 30 minutes. 10 exceeded 30 minutes: TXN-0041 (44m), TXN-0102 (47m), TXN-0177 (61m), TXN-0203 (39m), TXN-0264 (52m), TXN-0311 (35m), TXN-0362 (88m), TXN-0410 (41m), TXN-0455 (49m), TXN-0489 (73m)." },
  { kind: "exception_record", label: "Compliance screening records", content: "EXCEPTION RECORDS, period 2026-08. TXN-0041: regulatory compliance screening hold, cleared after 41 minutes, screening reference SCR-2216. TXN-0102: compliance screening hold, screening reference SCR-2219. No other payment in the period carried a screening hold." },
  { kind: "outage_notice", label: "Gateway outage notice INC-88", content: "OUTAGE NOTICE. On 14 August the provider's settlement gateway was degraded between 09:10 and 10:05 UTC; incident INC-88 was notified to clients at 09:41 UTC the same day. TXN-0177 was in flight during the outage window. No other flagged payment overlaps the incident." },
];
const RESPONSE = { kind: "response", label: "Provider answer for 2026-08", content: "PROVIDER RESPONSE. The provider confirms incident INC-88 and the two screening holds SCR-2216 and SCR-2219. The remaining seven late payments (TXN-0203, TXN-0264, TXN-0311, TXN-0362, TXN-0410, TXN-0455, TXN-0489) carried no exception the agreement recognises; the provider submits them to the panel's judgment on the record as it stands." };
const CHALLENGE_ITEM = { kind: "response", label: "Gateway telemetry export", content: "GATEWAY TELEMETRY EXPORT, period 2026-08. The provider's settlement-leg telemetry shows TXN-0203 completing at 29m41s and TXN-0311 at 29m52s measured at the settlement leg, and asserts the client log's 39m and 35m readings measure the notification leg instead. The export covers only these two transactions." };

async function main() {
  log(`ARC ${existsSync(FLAGS) ? "RESUME" : "START"} — contract ${CONTRACT}`);
  log(`provider ${P.address} · client ${C.address} · stranger ${N.address}`);

  // ── the instrument ─────────────────────────────────────────────────────
  let ag = null;
  for (const a of (await jview("get_agreements_for", [P.address])) ?? []) {
    if (a.client.toLowerCase() === C.address.toLowerCase() &&
        !["CANCELLED", "CLOSED"].includes(a.status)) ag = a;
  }
  if (!ag) {
    await write(P, "create_agreement",
      [C.address, TERMS, 9500, CREDIT.toString(), 900, 900, 900, 900], RESERVE,
      async () => ((await jview("get_agreements_for", [P.address])) ?? [])
        .some((a) => a.client.toLowerCase() === C.address.toLowerCase() && a.status !== "CANCELLED"));
    for (const a of (await jview("get_agreements_for", [P.address])) ?? []) {
      if (a.client.toLowerCase() === C.address.toLowerCase() && a.status !== "CANCELLED") ag = a;
    }
  }
  const AID = ag.agreement_id;
  log(`instrument ${AID} — status ${ag.status}`);

  if (ag.status === "CREATED") {
    await write(C, "accept_agreement", [AID], 0n,
      async () => (await jview("get_agreement", [AID])).status !== "CREATED");
    ag = await jview("get_agreement", [AID]);
  }

  // ── the case ───────────────────────────────────────────────────────────
  let cs = ((await jview("get_cases_for", [AID])) ?? [])
    .find((k) => k.period_label === PERIOD) ?? null;
  if (!cs) {
    await write(C, "open_case", [AID, PERIOD], 0n,
      async () => ((await jview("get_cases_for", [AID])) ?? []).some((k) => k.period_label === PERIOD));
    cs = ((await jview("get_cases_for", [AID])) ?? []).find((k) => k.period_label === PERIOD);
    const agNow = await jview("get_agreement", [AID]);
    log(`S23 visible — reserve free ${agNow.reserve_free_atto} / held ${agNow.reserve_held_atto}`);
  }
  const CID = cs.case_id;
  log(`case ${CID} — status ${cs.status}, record v${cs.evidence_version} (${cs.item_count} items)`);

  // ── the record ─────────────────────────────────────────────────────────
  if (cs.status === "OPEN") {
    if (cs.item_count === 0) {
      await write(C, "commit_evidence", [CID, JSON.stringify(ITEMS)], 0n,
        async () => (await jview("get_case", [CID])).item_count > 0);
    }
    const acks = (await jview("get_acks", [CID])) ?? {};
    if (acks["EV-002"] !== "ACK") {
      await write(P, "review_evidence", [CID, "EV-002", "ack"], 0n,
        async () => ((await jview("get_acks", [CID])) ?? {})["EV-002"] === "ACK");
    }
    if (acks["EV-003"] !== "ACK") {
      await write(P, "review_evidence", [CID, "EV-003", "ack"], 0n,
        async () => ((await jview("get_acks", [CID])) ?? {})["EV-003"] === "ACK");
    }
    cs = await jview("get_case", [CID]);
    if (cs.item_count < 4) {
      await write(P, "commit_evidence", [CID, JSON.stringify([RESPONSE])], 0n,
        async () => (await jview("get_case", [CID])).item_count >= 4);
      cs = await jview("get_case", [CID]);
    }
  }

  // ── walls, part one (only meaningful while OPEN) ───────────────────────
  if (cs.status === "OPEN") {
    const agNow = await jview("get_agreement", [AID]);
    if (Math.floor(Date.now() / 1000) < cs.last_commit_epoch + agNow.response_window - MARGIN_S) {
      await wall("early-adjudicate", N, "adjudicate", [CID]);
    }
    await wall("duplicate-period", C, "open_case", [AID, PERIOD]);
    await wall("stranger-commit", N, "commit_evidence", [CID, JSON.stringify([ITEMS[0]])]);
    await wall("settle-while-open", N, "settle", [CID]);
  }

  // ── panel #1 ───────────────────────────────────────────────────────────
  cs = await jview("get_case", [CID]);
  if (cs.status === "OPEN" && !(await view("get_assessment", [CID, cs.evidence_version]))) {
    const agNow = await jview("get_agreement", [AID]);
    await waitUntil(cs.last_commit_epoch + agNow.response_window, "response window");
    await write(N, "adjudicate", [CID], 0n,
      async () => (await jview("get_case", [CID])).status !== "OPEN");
    cs = await jview("get_case", [CID]);
    const a1 = await jview("get_assessment", [CID, cs.pending_version || cs.evidence_version]);
    if (a1) {
      log(`PANEL #1 (v${a1.evidence_version}): ${a1.verdict} — rate ${a1.rate_bps} vs ${a1.threshold_bps} · eligible ${a1.eligible_total}, late ${a1.late_total}, excused ${JSON.stringify(a1.excused)} · ${a1.evidence_flag} · score ${a1.score}`);
      log(`   reason: ${a1.reason}`);
      record({ kind: "panel", round: 1, assessment: a1 });
    }
  }

  // ── promote #1 ─────────────────────────────────────────────────────────
  cs = await jview("get_case", [CID]);
  if (cs.status === "PENDING_FINALITY" && !cs.challenge_open) {
    await waitUntil(cs.pending_until_epoch, "finality window");
    await write(N, "promote", [CID], 0n,
      async () => (await jview("get_case", [CID])).status !== "PENDING_FINALITY");
    cs = await jview("get_case", [CID]);
    log(`promoted — status ${cs.status}, verdict ${cs.verdict}`);
  }

  if (cs.status === "OPEN" && cs.verdict === "REVIEW_REQUIRED") {
    log(`the panel HELD (REVIEW_REQUIRED) — recorded honestly; the arc stops here.`);
    record({ kind: "fact", what: "review_hold", case: cs });
    return;
  }

  // ── the bonded challenge (one round) ───────────────────────────────────
  cs = await jview("get_case", [CID]);
  if (cs.status === "FINAL" && cs.evidence_version === 2 && !cs.challenge_open &&
      Math.floor(Date.now() / 1000) < cs.challenge_until_epoch - MARGIN_S) {
    await write(P, "challenge",
      [CID, "the settlement-leg telemetry contradicts the notification-leg timings the log measured for two of the flagged payments",
       JSON.stringify([CHALLENGE_ITEM])], BOND,
      async () => {
        const k = await jview("get_case", [CID]);
        return k.challenge_open || k.evidence_version > 2;
      });
    cs = await jview("get_case", [CID]);
  }
  if (cs.challenge_open) {
    await write(N, "re_adjudicate", [CID], 0n,
      async () => !(await jview("get_case", [CID])).challenge_open);
    cs = await jview("get_case", [CID]);
    const a2 = await jview("get_assessment", [CID, cs.pending_version || cs.evidence_version]);
    if (a2) {
      log(`PANEL #2 (v${a2.evidence_version}): ${a2.verdict} — rate ${a2.rate_bps} · excused ${JSON.stringify(a2.excused)} · ${a2.evidence_flag}`);
      log(`   reason: ${a2.reason}`);
      record({ kind: "panel", round: 2, assessment: a2 });
    }
    log(`bond routing — client ledger ${await view("get_claimable", [C.address])}, provider ledger ${await view("get_claimable", [P.address])}`);
  }

  // ── promote #2 ─────────────────────────────────────────────────────────
  cs = await jview("get_case", [CID]);
  if (cs.status === "PENDING_FINALITY" && !cs.challenge_open) {
    await waitUntil(cs.pending_until_epoch, "second finality window");
    await write(N, "promote", [CID], 0n,
      async () => (await jview("get_case", [CID])).status !== "PENDING_FINALITY");
    cs = await jview("get_case", [CID]);
    log(`promoted — status ${cs.status}, verdict ${cs.verdict}`);
  }
  if (cs.status === "OPEN" && cs.verdict === "REVIEW_REQUIRED") {
    log(`second round HELD — recorded honestly; stopping before settlement.`);
    record({ kind: "fact", what: "review_hold_round2", case: cs });
    return;
  }

  // ── settle ─────────────────────────────────────────────────────────────
  cs = await jview("get_case", [CID]);
  if (cs.status === "FINAL" && !cs.challenge_open) {
    if (Math.floor(Date.now() / 1000) < cs.challenge_until_epoch - MARGIN_S) {
      await wall("settle-inside-window", N, "settle", [CID]);
    }
    await waitUntil(cs.challenge_until_epoch, "challenge window before settlement");
    await write(N, "settle", [CID], 0n,
      async () => (await jview("get_case", [CID])).status === "SETTLED");
    cs = await jview("get_case", [CID]);
    log(`SETTLED — verdict ${cs.verdict}`);
  }
  if (cs.status === "SETTLED") {
    await wall("double-settle", N, "settle", [CID]);
    await wall("post-terminal-challenge", P, "challenge",
      [CID, "a post-terminal challenge must bounce off the settled case",
       JSON.stringify([CHALLENGE_ITEM])], BOND);
  }

  // ── close-out and the drain ────────────────────────────────────────────
  let agEnd = await jview("get_agreement", [AID]);
  if (agEnd.status === "ACTIVE") {
    await write(P, "begin_close", [AID], 0n,
      async () => (await jview("get_agreement", [AID])).status !== "ACTIVE");
    agEnd = await jview("get_agreement", [AID]);
  }
  if (agEnd.status === "CLOSING") {
    await waitUntil(agEnd.closing_epoch + agEnd.notice_window, "close-out notice");
    await write(N, "finalize_close", [AID], 0n,
      async () => (await jview("get_agreement", [AID])).status === "CLOSED");
  }

  const clientLedger = await view("get_claimable", [C.address]);
  const providerLedger = await view("get_claimable", [P.address]);
  log(`ledgers — client ${clientLedger} atto, provider ${providerLedger} atto`);
  record({ kind: "fact", what: "ledgers", client: clientLedger, provider: providerLedger });
  if (BigInt(clientLedger) > 0n) {
    await write(C, "claim", [], 0n,
      async () => (await view("get_claimable", [C.address])) === "0");
  }
  if (BigInt(providerLedger) > 0n) {
    await write(P, "claim", [], 0n,
      async () => (await view("get_claimable", [P.address])) === "0");
  }

  const statsEnd = await jview("get_stats");
  agEnd = await jview("get_agreement", [AID]);
  log(`stats after: ${JSON.stringify(statsEnd)}`);
  log(`agreement end — status ${agEnd.status}, free ${agEnd.reserve_free_atto}, held ${agEnd.reserve_held_atto}`);
  record({ kind: "fact", what: "end", stats: statsEnd, agreement: agEnd });
  log(statsEnd.escrow_atto === "0"
    ? "CUSTODY ZERO — every atto in, accounted out. ARC COMPLETE."
    : `NOTE: custody not zero (${statsEnd.escrow_atto}) — investigate before claiming completion.`);
}

main().catch((err) => {
  log(`ARC FAILED: ${err?.message ?? err}`);
  record({ kind: "fact", what: "failure", error: String(err?.message ?? err) });
  process.exitCode = 1;
});
