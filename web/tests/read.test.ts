/**
 * The finality normalizer, pinned against the transaction shapes StudioNet
 * has actually produced — this function decides whether a user is told a
 * write is irreversible, so every measured shape is a fixture.
 */
import { describe, expect, it } from "vitest";
import { normalizeTxView } from "@/lib/read";

describe("normalizeTxView — what one status poll may claim", () => {
  it("a write that took effect: FINALIZED with a deciding SUCCESS receipt", () => {
    const v = normalizeTxView({
      statusName: "FINALIZED",
      status: 7,
      result_name: "MAJORITY_AGREE",
      consensus_data: {
        // measured live: the trailing ERROR is a rotated round — entry 0 decides
        leader_receipt: [{ execution_result: "SUCCESS" }, { execution_result: "ERROR" }],
      },
    });
    expect(v.finalized).toBe(true);
    expect(v.executed).toBe("SUCCESS");
  });

  it("a refused write still finalizes MAJORITY_AGREE — the receipt says ERROR", () => {
    const v = normalizeTxView({
      statusName: "FINALIZED",
      result_name: "MAJORITY_AGREE",   // agreement that it errored
      consensus_data: {
        leader_receipt: [{ execution_result: "ERROR" }, { execution_result: "ERROR" }],
      },
    });
    expect(v.finalized).toBe(true);
    expect(v.executed).toBe("ERROR");
  });

  it("ACCEPTED is not finality", () => {
    const v = normalizeTxView({
      statusName: "ACCEPTED",
      consensus_data: { leader_receipt: [{ execution_result: "SUCCESS" }] },
    });
    expect(v.finalized).toBe(false);
    expect(v.executed).toBe("SUCCESS");
  });

  it("a numeric status maps through the pinned table", () => {
    expect(normalizeTxView({ status: 7 }).finalized).toBe(true);
    expect(normalizeTxView({ status: 5 }).statusName).toBe("ACCEPTED");
  });

  it("the SDK's enum spelling is accepted alongside the wire spelling", () => {
    const v = normalizeTxView({
      statusName: "FINALIZED",
      consensus_data: { leader_receipt: [{ execution_result: "FINISHED_WITH_RETURN" }] },
    });
    expect(v.executed).toBe("SUCCESS");
  });

  it("an empty or alien answer claims nothing", () => {
    for (const raw of [null, undefined, {}, "nonsense", 42]) {
      const v = normalizeTxView(raw);
      expect(v.finalized).toBe(false);
      expect(v.executed).toBe("UNKNOWN");
    }
  });

  it("the consensus result alone is never treated as execution success", () => {
    // No receipts at all: MAJORITY_AGREE must not read as success.
    const v = normalizeTxView({
      statusName: "FINALIZED",
      result_name: "MAJORITY_AGREE",
    });
    expect(v.executed).toBe("UNKNOWN");
  });
});
