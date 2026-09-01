"use client";

import { STAGE_LABEL, STAGE_TRACK, stageClass, type TxProgress } from "../../lib/tx";
import { explorerTx } from "./Shell";

/** The transaction stepper: signing → submitted → pending → accepted →
 *  finalized, with the chain's own hash linked the moment one exists. */
export function TxFlow({ p }: { p: TxProgress | null }) {
  if (!p || p.stage === "idle") return null;
  return (
    <div className="txflow" role="status">
      <div className="txsteps">
        {STAGE_TRACK.map((s) => (
          <span key={s} className={stageClass(s, p.stage)}>
            {STAGE_LABEL[s]}
          </span>
        ))}
        {(p.stage === "failed" || p.stage === "rejected" || p.stage === "unresolved") && (
          <span className="step fail">{STAGE_LABEL[p.stage]}</span>
        )}
      </div>
      <div className="txdetail">
        {p.detail}{" "}
        {p.hash ? (
          <a href={explorerTx(p.hash)} target="_blank" rel="noreferrer">
            view transaction
          </a>
        ) : null}
      </div>
    </div>
  );
}
