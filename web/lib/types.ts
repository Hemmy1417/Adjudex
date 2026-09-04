/** Shapes as the contract's views serialize them — strings for atto amounts
 * (they exceed JS safe integers), numbers for epochs and counts. */

export type Agreement = {
  agreement_id: string;
  provider: string;
  client: string;
  status: "CREATED" | "ACTIVE" | "CLOSING" | "CLOSED" | "CANCELLED";
  terms_sha256: string;
  threshold_bps: number;
  credit_amount_atto: string;
  reserve_free_atto: string;
  reserve_held_atto: string;
  challenge_bond_atto: string;
  response_window: number;
  finality_window: number;
  challenge_window: number;
  notice_window: number;
  created_epoch: number;
  activated_epoch: number;
  closing_epoch: number;
  closed_epoch: number;
  cancelled_epoch: number;
  case_count: number;
  open_cases: number;
  /** present only on get_agreement (detail view) */
  terms_text?: string;
};

export type Case = {
  case_id: string;
  agreement_id: string;
  period_label: string;
  status: "OPEN" | "PENDING_FINALITY" | "FINAL" | "SETTLED" | "WITHDRAWN";
  opened_epoch: number;
  last_commit_epoch: number;
  evidence_version: number;
  evidence_root: string;
  item_count: number;
  reserved_atto: string;
  assessed_version: number;
  pending_version: number;
  pending_until_epoch: number;
  verdict: "" | "BREACHED" | "NOT_BREACHED" | "REVIEW_REQUIRED";
  rate_bps: number;
  score: number;
  evidence_flag: string;
  final_epoch: number;
  challenge_until_epoch: number;
  challenge_open: boolean;
  challenger: string;
  challenge_reason: string;
  challenge_new_version: number;
  challenged_version: number;
  challenge_filed_epoch: number;
  settled_epoch: number;
  withdrawn_epoch: number;
};

export type EvidenceItem = {
  id: string;
  kind: string;
  submitter: "client" | "provider";
  label: string;
  content: string;
  anchor_chain?: string;
  anchor_tx?: string;
  content_hash: string;
};

export type Manifest = {
  case_id: string;
  version: number;
  items: EvidenceItem[];
  root: string;
};

export type AssessmentRow = {
  id: string;
  kind: string;
  submitter: string;
  label: string;
  ack: string;
  anchor_chain?: string;
  anchor_tx?: string;
  anchor_state?: string;
  anchor_epoch?: number;
  excerpt: string;
  digest: string;
};

export type Assessment = {
  assessment_id: string;
  case_id: string;
  agreement_id: string;
  period_label: string;
  evidence_version: number;
  evidence_root: string;
  observed_epoch: number;
  threshold_bps: number;
  verdict: "BREACHED" | "NOT_BREACHED" | "REVIEW_REQUIRED";
  rate_bps: number;
  score: number;
  eligible_total: number;
  late_total: number;
  excused: Record<string, number>;
  evidence_flag: string;
  conflicts: string[];
  hard_conflicts: string[];
  corroboration?: "INDEPENDENT" | "BILATERAL" | "NONE";
  reason: string;
  rows: AssessmentRow[];
  committed_count: number;
};

export type Stats = {
  agreements: number;
  cases: number;
  settled: number;
  breached: number;
  escrow_atto: string;
};

export type ChainConfig = {
  version: string;
  min_credit_atto: string;
  max_credit_atto: string;
  threshold_bps: [number, number];
  terms_chars: [number, number];
  item_chars: [number, number];
  label_chars: [number, number];
  reason_chars: [number, number];
  items_per_commit: [number, number];
  items_total: number;
  versions_max: number;
  window_seconds: [number, number];
  default_windows: {
    response: number;
    finality: number;
    challenge: number;
    notice: number;
  };
  stale_challenge_seconds: number;
  abandon_seconds: number;
  challenge_bond_bps: number;
  challenge_bond_floor_atto: string;
  rate_bucket_bps: number;
  evidence_kinds: string[];
  excuse_categories: string[];
  conflict_codes: string[];
  hard_conflicts: string[];
  verdicts: string[];
  evidence_flags: string[];
  agreement_statuses: string[];
  case_statuses: string[];
};
