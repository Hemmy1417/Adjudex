"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { sameAddress } from "../../../../../lib/chain";
import { CONTRACT_ADDRESS, formatGen, formatStamp } from "../../../../../lib/config";
import {
  getAcks, getAgreement, getAssessment, getCase, getClaimable, getEvidence,
  invalidateReads,
} from "../../../../../lib/read";
import {
  ackRecorded, adjudicationPending, caseSettled, caseStatusIs,
  challengeClosed, challengeOpen, claimDrained, evidenceVersionAbove,
} from "../../../../../lib/predicates";
import { writeAndConfirm, inFlight, type TxProgress } from "../../../../../lib/tx";
import type { Agreement, Assessment, Case, Manifest } from "../../../../../lib/types";
import { useWallet } from "../../../../../lib/wallet";
import {
  Addr, Gen, RateMeter, StateNote, StatusChip, VerdictStamp,
} from "../../../../components/bits";
import { TxFlow } from "../../../../components/TxFlow";

/** A coarse now — display gating only; the CONTRACT enforces every window
 *  with its own consensus clock, and this number decides nothing. */
function useNow(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

const CLIENT_KINDS = [
  "payment_log", "exception_record", "outage_notice", "compliance_record",
  "terms_exhibit", "correspondence", "other",
];

type ItemDraft = {
  kind: string; label: string; content: string;
  anchor_chain?: string; anchor_tx?: string;
};

const ANCHOR_CHAINS = ["genlayer-studionet", "base", "base-sepolia", "ethereum"];
const TX_HASH_RE = /^0x[0-9a-f]{64}$/;

function CommitForm({
  role, busy, onCommit,
}: {
  role: "client" | "provider";
  busy: boolean;
  onCommit: (items: ItemDraft[]) => void;
}) {
  const [draft, setDraft] = useState<ItemDraft>({
    kind: role === "provider" ? "response" : "payment_log",
    label: "",
    content: "",
  });
  const anchorTx = (draft.anchor_tx ?? "").trim().toLowerCase();
  const anchorOk = !draft.anchor_chain
    || (anchorTx.length > 0 && TX_HASH_RE.test(anchorTx));
  const ok = draft.label.trim().length >= 1
    && draft.content.trim().length >= 20 && anchorOk;
  return (
    <div className="action-card">
      <h3>{role === "provider" ? "Commit a response" : "Commit evidence"}</h3>
      <p>
        {role === "provider"
          ? "Your answer joins the same record."
          : "Committed as bytes — frozen, append-only."}
      </p>
      {role === "client" && (
        <div className="field">
          <span className="label">Kind</span>
          <select
            value={draft.kind}
            onChange={(e) => setDraft((d) => ({ ...d, kind: e.target.value }))}
          >
            {CLIENT_KINDS.map((k) => (
              <option key={k} value={k}>{k.replace(/_/g, " ")}</option>
            ))}
          </select>
        </div>
      )}
      <div className="field">
        <span className="label">Label</span>
        <input
          value={draft.label}
          onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
          placeholder={role === "provider" ? "Provider answer" : "Payment processing log"}
        />
      </div>
      <div className="field">
        <span className="label">Content (20–6000 characters)</span>
        <textarea
          rows={7}
          value={draft.content}
          onChange={(e) => setDraft((d) => ({ ...d, content: e.target.value }))}
          spellCheck={false}
        />
        <span className="hint">{draft.content.trim().length} characters</span>
      </div>
      {role === "client" && (
        <>
          <div className="field">
            <span className="label">Chain anchor (optional)</span>
            <select
              value={draft.anchor_chain ?? ""}
              onChange={(e) => setDraft((d) => ({
                ...d,
                anchor_chain: e.target.value || undefined,
                anchor_tx: e.target.value ? d.anchor_tx : undefined,
              }))}
            >
              <option value="">no anchor — party-declared record</option>
              {ANCHOR_CHAINS.map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
          </div>
          {draft.anchor_chain && (
            <div className="field">
              <span className="label">Anchored transaction hash</span>
              <input
                value={draft.anchor_tx ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, anchor_tx: e.target.value }))}
                placeholder="0x…64 hex characters"
                spellCheck={false}
              />
              <span className="hint">
                The panel&apos;s validators verify this transaction on{" "}
                {draft.anchor_chain} themselves — independent proof of the
                anchored event, and a floor requirement for a breach to pay
                on an otherwise unacknowledged record.
              </span>
            </div>
          )}
        </>
      )}
      <span className="price">restarts the response window for the other side</span>
      <button
        className="btn"
        disabled={busy || !ok}
        onClick={() => {
          const item: ItemDraft = {
            kind: draft.kind,
            label: draft.label.trim(),
            content: draft.content.trim(),
          };
          if (draft.anchor_chain && anchorTx) {
            item.anchor_chain = draft.anchor_chain;
            item.anchor_tx = anchorTx;
          }
          onCommit([item]);
          setDraft((d) => ({
            ...d, label: "", content: "",
            anchor_chain: undefined, anchor_tx: undefined,
          }));
        }}
      >
        Commit to the record
      </button>
    </div>
  );
}

function FindingsSheet({
  a, title,
}: {
  a: Assessment;
  title: string;
}) {
  const excusedTotal = Object.values(a.excused).reduce((s, v) => s + v, 0);
  const unexcused = a.late_total - excusedTotal;
  return (
    <div className="sheet">
      <div className="section-head">
        <h2>{title}</h2>
        <span className="aside">judged at record v{a.evidence_version}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 22, flexWrap: "wrap" }}>
        <VerdictStamp verdict={a.verdict} big />
        <div style={{ flex: 1, minWidth: 260 }}>
          {a.verdict === "REVIEW_REQUIRED" ? (
            a.corroboration === "NONE" && a.evidence_flag === "SUFFICIENT" &&
            a.hard_conflicts.length < 2 && a.eligible_total > 0 ? (
              <p className="muted small">
                Held — the record is uncorroborated: no item is
                chain-verified or provider-acknowledged, and an unproven
                story cannot take money. The case reopens; anchor a
                settlement transaction or obtain an acknowledgement.
              </p>
            ) : (
              <p className="muted small">
                Held — evidence <span className="mono">{a.evidence_flag}</span>
                {a.hard_conflicts.length >= 2 ? ", unresolved contradictions" : ""}.
                The case reopens for more evidence.
              </p>
            )
          ) : (
            <RateMeter rateBps={a.rate_bps} thresholdBps={a.threshold_bps} />
          )}
        </div>
      </div>

      <div className="table-scroll">
        <table className="ledger">
          <thead>
            <tr>
              <th>Count</th>
              <th className="num">Payments</th>
              <th>Reading</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Eligible in the period</td>
              <td className="num">{a.eligible_total}</td>
              <td className="muted small">what the terms make eligible</td>
            </tr>
            <tr>
              <td>Exceeded the agreed time</td>
              <td className="num">{a.late_total}</td>
              <td className="muted small">late before exceptions</td>
            </tr>
            {Object.entries(a.excused).map(([k, v]) =>
              v > 0 ? (
                <tr key={k}>
                  <td style={{ paddingLeft: 22 }}>excused · {k.replace(/_/g, " ").toLowerCase()}</td>
                  <td className="num">−{v}</td>
                  <td className="muted small">under the terms&apos; own exception language</td>
                </tr>
              ) : null,
            )}
            <tr>
              <td><strong>Unexcused late</strong></td>
              <td className="num"><strong>{unexcused}</strong></td>
              <td className="muted small">what the rate is measured on</td>
            </tr>
          </tbody>
        </table>
      </div>

      <dl className="schedule">
        <dt>Evidence</dt>
        <dd className="mono small">{a.evidence_flag}</dd>
        {a.corroboration && (
          <>
            <dt>Corroboration</dt>
            <dd className="small">
              {a.corroboration === "INDEPENDENT" &&
                "independent — an anchored transaction was verified on a public chain by the panel's own nodes"}
              {a.corroboration === "BILATERAL" &&
                "bilateral — the provider's wallet acknowledged part of the record"}
              {a.corroboration === "NONE" &&
                "none — the record is a party's own attestation"}
            </dd>
          </>
        )}
        <dt>Panel score</dt>
        <dd className="figure">{a.score} / 100</dd>
        {a.conflicts.length > 0 && (
          <>
            <dt>Conflicts</dt>
            <dd style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {a.conflicts.map((c) => (
                <span key={c} className={`chip${a.hard_conflicts.includes(c) ? " danger" : ""}`}>
                  <span className="dot" />{c.replace(/_/g, " ")}
                </span>
              ))}
            </dd>
          </>
        )}
        <dt>The panel&apos;s reason</dt>
        <dd className="small" style={{ fontStyle: "italic" }}>&ldquo;{a.reason}&rdquo;</dd>
      </dl>

      <details className="evidence-item">
        <summary>
          <span className="ev-id">DOSSIER</span>
          <span className="faint small">
            the {a.rows.length} rows this judgment read, with their digests
          </span>
        </summary>
        <pre>
          {a.rows
            .map((r) => {
              const anchor = r.anchor_state
                ? ` · anchor ${r.anchor_state}${r.anchor_state === "VERIFIED" && r.anchor_chain ? ` (${r.anchor_chain})` : ""}`
                : "";
              return `${r.id} · ${r.kind} · ${r.submitter}${r.ack ? ` · ${r.ack}` : ""}${anchor}\n  sha256 ${r.digest}`;
            })
            .join("\n")}
        </pre>
      </details>
    </div>
  );
}

export default function CaseFile() {
  const { id, cid } = useParams<{ id: string; cid: string }>();
  const { address, client } = useWallet();
  const now = useNow();

  const [ag, setAg] = useState<Agreement | null>(null);
  const [cs, setCs] = useState<Case | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [acks, setAcks] = useState<Record<string, string>>({});
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [claimable, setClaimable] = useState("0");
  const [state, setState] = useState<"loading" | "ready" | "missing" | "unreachable">("loading");
  const [tx, setTx] = useState<TxProgress | null>(null);
  const [challengeReason, setChallengeReason] = useState("");
  const [challengeDraft, setChallengeDraft] = useState("");

  const refresh = useCallback(async (force = false) => {
    try {
      const [a, k] = await Promise.all([getAgreement(id, force), getCase(cid, force)]);
      if (!a || !k) {
        setState("missing");
        return;
      }
      setAg(a);
      setCs(k);
      if (k.evidence_version > 0) {
        setManifest(await getEvidence(cid, k.evidence_version, force));
        setAcks(await getAcks(cid, force));
      }
      const v =
        k.pending_version || k.assessed_version ||
        (k.challenge_open ? k.challenged_version : 0);
      if (v > 0) setAssessment(await getAssessment(cid, v, force));
      if (address) setClaimable(await getClaimable(address, force));
      setState("ready");
    } catch {
      setState((s) => (s === "ready" ? s : "unreachable"));
    }
  }, [id, cid, address]);

  useEffect(() => {
    const kick = setTimeout(() => void refresh(), 0);
    const t = setInterval(() => void refresh(), 50_000);
    return () => {
      clearTimeout(kick);
      clearInterval(t);
    };
  }, [refresh]);

  const busy = inFlight(tx?.stage ?? "idle");
  const isProvider = !!ag && sameAddress(address, ag.provider);
  const isClient = !!ag && sameAddress(address, ag.client);
  const isParty = isProvider || isClient;

  const responseOpenUntil = useMemo(
    () => (cs && ag ? cs.last_commit_epoch + ag.response_window : 0),
    [cs, ag],
  );

  async function run(
    functionName: string,
    args: unknown[],
    valueAtto: bigint,
    predicate: () => Promise<boolean>,
    confirmedDetail: string,
  ) {
    try {
      await writeAndConfirm({
        client, address: CONTRACT_ADDRESS, functionName, args, valueAtto,
        predicate, onProgress: setTx, confirmedDetail,
      });
      invalidateReads();
      await refresh(true);
    } catch { /* rendered by the flow */ }
  }

  if (state === "loading") {
    return <main className="page"><StateNote kind="loading">Reading the case file…</StateNote></main>;
  }
  if (state === "missing") {
    return (
      <main className="page">
        <StateNote kind="empty">
          No case <span className="mono">{cid}</span> exists on this contract.{" "}
          <Link href={`/i/${id}`} style={{ textDecoration: "underline" }}>Back to the instrument.</Link>
        </StateNote>
      </main>
    );
  }
  if (state === "unreachable" || !ag || !cs) {
    return (
      <main className="page">
        <StateNote kind="unreachable">
          StudioNet could not be reached, so the case file cannot be shown
          right now — the record has not gone anywhere. The page keeps
          retrying.
        </StateNote>
      </main>
    );
  }

  const bond = ag.challenge_bond_atto;

  return (
    <main className="page">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div>
          <div className="label">
            <Link href={`/i/${ag.agreement_id}`} style={{ textDecoration: "underline" }}>
              the instrument
            </Link>{" "}
            · case file
          </div>
          <h1 className="doc-title" style={{ fontSize: "clamp(26px,4vw,40px)" }}>
            Period {cs.period_label}, on the record.
          </h1>
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
            <StatusChip status={cs.status} />
            {cs.challenge_open && <span className="chip danger"><span className="dot" />challenge open</span>}
            {isProvider && <span className="chip"><span className="dot" />you are the provider</span>}
            {isClient && <span className="chip"><span className="dot" />you are the client</span>}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="label">Reserved for this period</div>
          <Gen atto={cs.status === "SETTLED" ? "0" : cs.reserved_atto} big />
          {cs.verdict && cs.status !== "OPEN" && (
            <div style={{ marginTop: 10 }}>
              <VerdictStamp verdict={cs.verdict} />
            </div>
          )}
        </div>
      </div>

      {/* windows — every deadline with its consequence */}
      <div className="sheet well">
        <dl className="schedule">
          <dt>Opened</dt>
          <dd className="small">{formatStamp(cs.opened_epoch)}</dd>
          {cs.status === "OPEN" && cs.evidence_version > 0 && (
            <>
              <dt>Response window</dt>
              <dd className="small">
                {now <= responseOpenUntil
                  ? <>runs until {formatStamp(responseOpenUntil)} — then anyone can call the panel; every new commit restarts it</>
                  : <>closed {formatStamp(responseOpenUntil)} — the panel can be called now</>}
              </dd>
            </>
          )}
          {cs.status === "PENDING_FINALITY" && (
            <>
              <dt>Finality window</dt>
              <dd className="small">
                verdict recorded, effective only after {formatStamp(cs.pending_until_epoch)} — then anyone can promote it
              </dd>
            </>
          )}
          {cs.status === "FINAL" && (
            <>
              <dt>Challenge window</dt>
              <dd className="small">
                {now <= cs.challenge_until_epoch
                  ? <>either party can challenge with a {formatGen(bond)} GEN bond until {formatStamp(cs.challenge_until_epoch)} — then settlement opens to anyone</>
                  : <>closed {formatStamp(cs.challenge_until_epoch)} — settlement is open to anyone</>}
              </dd>
            </>
          )}
          {cs.challenge_open && (
            <>
              <dt>Challenge</dt>
              <dd className="small">
                filed {formatStamp(cs.challenge_filed_epoch)} by <Addr value={cs.challenger} /> —
                re-adjudication is open to anyone; if none concludes by{" "}
                {formatStamp(cs.challenge_filed_epoch + 3600)}, any party can
                lapse it, restoring the challenged verdict and returning the bond
              </dd>
            </>
          )}
          {cs.status === "SETTLED" && (
            <>
              <dt>Settled</dt>
              <dd className="small">
                {formatStamp(cs.settled_epoch)} —{" "}
                {cs.verdict === "BREACHED"
                  ? `the ${formatGen(ag.credit_amount_atto)} GEN credit went to the client's claimable balance`
                  : "the reservation returned to the provider's free reserve"}
              </dd>
            </>
          )}
        </dl>
        <details className="evidence-item">
          <summary>
            <span className="ev-kind">technical record</span>
            <span className="faint small">ids, hashes and full addresses</span>
          </summary>
          <pre>{`case id         ${cs.case_id}
instrument id   ${cs.agreement_id}
record root     ${cs.evidence_root || "(no evidence yet)"}
provider        ${ag.provider}
client          ${ag.client}`}</pre>
        </details>
      </div>

      {/* the verdict, when one stands or is pending */}
      {assessment && (
        <FindingsSheet
          a={assessment}
          title={
            cs.status === "PENDING_FINALITY"
              ? "The pending judgment"
              : cs.challenge_open
                ? "The challenged judgment"
                : "The judgment"
          }
        />
      )}

      {/* the record */}
      <div className="sheet">
        <div className="section-head">
          <h2>The record</h2>
          <span className="aside">
            {cs.evidence_version > 0
              ? <>version {cs.evidence_version} · {cs.item_count} items</>
              : "nothing committed yet"}
          </span>
        </div>
        {!manifest && (
          <StateNote kind="empty">
            The record is empty — the client commits the period&apos;s
            evidence to open it.
          </StateNote>
        )}
        {manifest && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {manifest.items.map((it) => {
              const ack = acks[it.id] ?? "";
              return (
                <details key={it.id} className="evidence-item">
                  <summary>
                    <span className="ev-id">{it.id}</span>
                    <span className="ev-kind">{it.kind.replace(/_/g, " ")}</span>
                    <span className="chip">
                      <span className="dot" />
                      {it.submitter === "provider" ? "provider response" : "client-declared"}
                    </span>
                    {ack === "ACK" && (
                      <span className="chip open"><span className="dot" />provider-acknowledged</span>
                    )}
                    {ack === "DISPUTE" && (
                      <span className="chip danger"><span className="dot" />provider-disputed</span>
                    )}
                    {it.anchor_chain && (
                      <span className="chip open">
                        <span className="dot" />anchored · {it.anchor_chain}
                      </span>
                    )}
                    <span className="faint small">{it.label}</span>
                    {isProvider && cs.status === "OPEN" && it.submitter === "client" && (
                      <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                        <button
                          className="copy-btn"
                          disabled={busy || ack === "ACK"}
                          onClick={(e) => {
                            e.preventDefault();
                            void run("review_evidence", [cs.case_id, it.id, "ack"], 0n,
                              ackRecorded(cs.case_id, it.id, "ACK"),
                              `${it.id} acknowledged on-chain, finalized.`);
                          }}
                        >acknowledge</button>
                        <button
                          className="copy-btn"
                          disabled={busy || ack === "DISPUTE"}
                          onClick={(e) => {
                            e.preventDefault();
                            void run("review_evidence", [cs.case_id, it.id, "dispute"], 0n,
                              ackRecorded(cs.case_id, it.id, "DISPUTE"),
                              `${it.id} disputed on-chain, finalized.`);
                          }}
                        >dispute</button>
                      </span>
                    )}
                  </summary>
                  <pre>{it.content}</pre>
                </details>
              );
            })}
          </div>
        )}
      </div>

      {/* actions */}
      <div className="sheet">
        <div className="section-head">
          <h2>Actions</h2>
          <span className="aside">what a signature can do now</span>
        </div>
        {!address && (
          <StateNote kind="empty">Connect a wallet to act on this case.</StateNote>
        )}
        <div className="action-row">
          {cs.status === "OPEN" && isClient && (
            <CommitForm role="client" busy={busy} onCommit={(items) =>
              void run("commit_evidence", [cs.case_id, JSON.stringify(items)], 0n,
                evidenceVersionAbove(cs.case_id, cs.evidence_version),
                "Committed — the record grew a version, finalized.")} />
          )}
          {cs.status === "OPEN" && isProvider && (
            <CommitForm role="provider" busy={busy} onCommit={(items) =>
              void run("commit_evidence", [cs.case_id, JSON.stringify(items)], 0n,
                evidenceVersionAbove(cs.case_id, cs.evidence_version),
                "Committed — your response is on the record, finalized.")} />
          )}

          {cs.status === "OPEN" && cs.evidence_version > 0 && (
            <div className="action-card">
              <h3>Call the panel</h3>
              <p>Runs once per record version, once the response window closes.</p>
              <span className="price">costs nothing but gas · takes ~1–2 minutes of consensus</span>
              <button className="btn" disabled={busy || now <= responseOpenUntil} onClick={() => void run(
                "adjudicate", [cs.case_id], 0n,
                adjudicationPending(cs.case_id, cs.evidence_version),
                "The panel has judged — the verdict is pending its finality window.",
              )}>Adjudicate period {cs.period_label}</button>
              {now <= responseOpenUntil && (
                <p className="faint small">The response window runs until {formatStamp(responseOpenUntil)}.</p>
              )}
            </div>
          )}

          {cs.status === "OPEN" && isClient && (
            <div className="action-card">
              <h3>Withdraw the case</h3>
              <p>Returns the reservation to the free reserve.</p>
              <span className="price">releases {formatGen(cs.reserved_atto)} GEN back to the reserve</span>
              <button className="btn quiet" disabled={busy} onClick={() => void run(
                "withdraw_case", [cs.case_id], 0n,
                caseStatusIs(cs.case_id, "WITHDRAWN"),
                "Withdrawn — the reservation is back in the free reserve, finalized.",
              )}>Withdraw</button>
            </div>
          )}

          {cs.status === "PENDING_FINALITY" && (
            <div className="action-card">
              <h3>Promote the verdict</h3>
              <p>Makes the recorded verdict the case&apos;s state; arms the challenge window.</p>
              <span className="price">costs nothing but gas</span>
              <button className="btn" disabled={busy || now <= cs.pending_until_epoch} onClick={() => void run(
                "promote", [cs.case_id], 0n,
                caseStatusIs(cs.case_id, "FINAL", "OPEN"),
                "Promoted — the verdict stands, finalized.",
              )}>Promote</button>
              {now <= cs.pending_until_epoch && (
                <p className="faint small">The finality window runs until {formatStamp(cs.pending_until_epoch)}.</p>
              )}
            </div>
          )}

          {cs.status === "FINAL" && isParty && !cs.challenge_open && now <= cs.challenge_until_epoch && (
            <div className="action-card danger">
              <h3>Challenge the verdict</h3>
              <p>The bond returns if the verdict changes; otherwise it goes to the other party.</p>
              <div className="field">
                <span className="label">Grounds (20–600 characters)</span>
                <textarea rows={2} value={challengeReason} onChange={(e) => setChallengeReason(e.target.value)} />
              </div>
              <div className="field">
                <span className="label">New evidence (20–6000 characters)</span>
                <textarea rows={5} value={challengeDraft} onChange={(e) => setChallengeDraft(e.target.value)} spellCheck={false} />
              </div>
              <span className="price">bond: exactly {formatGen(bond)} GEN</span>
              <button
                className="btn danger"
                disabled={busy || challengeReason.trim().length < 20 || challengeDraft.trim().length < 20}
                onClick={() => {
                  const items = [{
                    kind: isProvider ? "response" : "payment_log",
                    label: "Challenge exhibit",
                    content: challengeDraft.trim(),
                  }];
                  void run("challenge",
                    [cs.case_id, challengeReason.trim(), JSON.stringify(items)],
                    BigInt(bond),
                    challengeOpen(cs.case_id),
                    "Challenge filed — the bond is in custody and re-adjudication is open to anyone.");
                }}
              >Post the bond and challenge</button>
            </div>
          )}

          {cs.challenge_open && (
            <div className="action-card">
              <h3>Run the re-adjudication</h3>
              <p>A fresh panel reads the grown record.</p>
              <span className="price">costs nothing but gas</span>
              <button className="btn" disabled={busy} onClick={() => void run(
                "re_adjudicate", [cs.case_id], 0n,
                challengeClosed(cs.case_id),
                "Re-judged — the new verdict is pending its finality window.",
              )}>Re-adjudicate</button>
            </div>
          )}

          {cs.challenge_open && now > cs.challenge_filed_epoch + 3600 && (
            <div className="action-card">
              <h3>Lapse the stale challenge</h3>
              <p>Restores the challenged verdict exactly; returns the bond.</p>
              <span className="price">restores the snapshot · returns the bond</span>
              <button className="btn quiet" disabled={busy} onClick={() => void run(
                "lapse_challenge", [cs.case_id], 0n,
                challengeClosed(cs.case_id),
                "Lapsed — the challenged verdict is restored exactly, finalized.",
              )}>Lapse the challenge</button>
            </div>
          )}

          {cs.status === "FINAL" && !cs.challenge_open && now > cs.challenge_until_epoch && (
            <div className="action-card">
              <h3>Settle the case</h3>
              <p>
                {cs.verdict === "BREACHED"
                  ? `Credits the client exactly ${formatGen(cs.reserved_atto)} GEN.`
                  : "Returns the reservation to the provider's free reserve."}
              </p>
              <span className="price">costs nothing but gas</span>
              <button className="btn" disabled={busy} onClick={() => void run(
                "settle", [cs.case_id], 0n,
                caseSettled(cs.case_id),
                "Settled — the ledger reflects the verdict, finalized.",
              )}>Settle</button>
            </div>
          )}

          {address && claimable !== "0" && (
            <div className="action-card">
              <h3>Claim your balance</h3>
              <p>Everything the ledger owes this wallet.</p>
              <span className="price">pays you {formatGen(claimable)} GEN</span>
              <button className="btn" disabled={busy} onClick={() => void run(
                "claim", [], 0n, claimDrained(address),
                "Claimed — the transfer rides finalization and lands with it.",
              )}>Claim {formatGen(claimable)} GEN</button>
            </div>
          )}
        </div>
        <TxFlow p={tx} />
      </div>
    </main>
  );
}
