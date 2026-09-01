import { describe, expect, it, vi } from "vitest";
import {
  STAGE_LABEL, STAGE_TRACK, stageClass, writeAndConfirm, type TxProgress,
  type WriteArgs, inFlight, stateVisible,
} from "@/lib/tx";
import type { TxFinalityView } from "@/lib/read";

const okClient = (hash = "0xabc") => ({
  writeContract: vi.fn().mockResolvedValue(hash),
});

/** A status reader with a fixed answer — the finality watch's collaborator. */
const status =
  (statusName: string, executed: TxFinalityView["executed"] = "UNKNOWN") =>
  async (): Promise<TxFinalityView> => ({
    statusName,
    finalized: statusName === "FINALIZED",
    executed,
  });

const FINAL_OK = status("FINALIZED", "SUCCESS");

describe("the transaction stepper", () => {
  it("lights the current stage and marks earlier ones done", () => {
    expect(stageClass("wallet", "wallet")).toBe("step on");
    expect(stageClass("wallet", "pending")).toBe("step done");
    expect(stageClass("confirmed", "pending")).toBe("step");
    expect(stageClass("confirmed", "confirmed")).toBe("step on");
    expect(stageClass("accepted", "accepted")).toBe("step on");
    expect(stageClass("accepted", "confirmed")).toBe("step done");
    expect(stageClass("confirmed", "accepted")).toBe("step");
  });

  it("marks the track failed when the user declines", () => {
    expect(stageClass("wallet", "rejected")).toBe("step fail");
    expect(stageClass("wallet", "failed")).toBe("step fail");
  });

  it("labels every stage", () => {
    for (const s of STAGE_TRACK) expect(STAGE_LABEL[s]).toBeTruthy();
    expect(STAGE_LABEL.rejected).toMatch(/declined/i);
  });
});

describe("writeAndConfirm — confirmation is a contract read, not a receipt", () => {
  it("does not accept until the view predicate says the chain caught up", async () => {
    vi.useFakeTimers();
    const seen: TxProgress[] = [];
    let landed = false;
    const p = writeAndConfirm({
      client: okClient(),
      address: "0x" + "1".repeat(40),
      functionName: "stake",
      args: ["m-1", "YES"],
      valueAtto: 10n ** 18n,
      predicate: async () => landed,
      txStatus: FINAL_OK,
      onProgress: (x) => seen.push({ ...x }),
    });

    await vi.advanceTimersByTimeAsync(6000);
    // the write was submitted, but the state has NOT been observed yet
    expect(seen.map((s) => s.stage)).toContain("submitted");
    expect(seen.some((s) => s.stage === "accepted")).toBe(false);
    expect(seen.some((s) => s.stage === "confirmed")).toBe(false);

    landed = true;
    await vi.advanceTimersByTimeAsync(6000);
    await p;
    // resolution happens at accepted — the state is readable from here —
    // and the finality watch reports confirmed on its own clock
    expect(seen.at(-1)?.stage).toBe("accepted");
    await vi.advanceTimersByTimeAsync(6000);
    expect(seen.at(-1)?.stage).toBe("confirmed");
    vi.useRealTimers();
  });

  it("passes the staked value through to the contract call", async () => {
    vi.useFakeTimers();
    const client = okClient();
    const p = writeAndConfirm({
      client,
      address: "0x" + "2".repeat(40),
      functionName: "stake",
      args: ["m-2", "NO"],
      valueAtto: 2n * 10n ** 18n,
      predicate: async () => true,
      txStatus: FINAL_OK,
    });
    await vi.advanceTimersByTimeAsync(6000);
    await p;
    await vi.advanceTimersByTimeAsync(6000); // let the finality watch close
    expect(client.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "stake", value: 2n * 10n ** 18n }),
    );
    vi.useRealTimers();
  });

  it("reports a declined signature as REJECTED, not as a failure", async () => {
    const seen: TxProgress[] = [];
    const client = { writeContract: vi.fn().mockRejectedValue({ code: 4001 }) };
    await expect(
      writeAndConfirm({
        client,
        address: "0x" + "3".repeat(40),
        functionName: "stake",
        args: [],
        predicate: async () => true,
        onProgress: (x) => seen.push({ ...x }),
      }),
    ).rejects.toBeDefined();
    expect(seen.at(-1)?.stage).toBe("rejected");
    expect(seen.at(-1)?.detail).toMatch(/declined/i);
  });

  it("refuses to pretend when no wallet is connected", async () => {
    const seen: TxProgress[] = [];
    await expect(
      writeAndConfirm({
        client: null,
        address: "0x" + "4".repeat(40),
        functionName: "stake",
        args: [],
        predicate: async () => true,
        onProgress: (x) => seen.push({ ...x }),
      }),
    ).rejects.toThrow(/no wallet/i);
    expect(seen.at(-1)?.stage).toBe("failed");
  });

  it("keeps polling through transient read noise", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const p = writeAndConfirm({
      client: okClient(),
      address: "0x" + "5".repeat(40),
      functionName: "stake",
      args: [],
      predicate: async () => {
        calls++;
        if (calls < 3) throw new Error("429 rate limit");  // throttled, not failed
        return true;
      },
      txStatus: FINAL_OK,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(p).resolves.toBe("0xabc");
    expect(calls).toBeGreaterThanOrEqual(3);
    await vi.advanceTimersByTimeAsync(6000); // let the finality watch close
    vi.useRealTimers();
  });

  it("says a slow write is not lost, rather than calling it failed", async () => {
    vi.useFakeTimers();
    const seen: TxProgress[] = [];
    const p = writeAndConfirm({
      client: okClient(),
      address: "0x" + "6".repeat(40),
      functionName: "stake",
      args: [],
      predicate: async () => false,          // never observed
      onProgress: (x) => seen.push({ ...x }),
      predicateTries: 2,
    });
    await vi.advanceTimersByTimeAsync(20_000);
    await p;
    const last = seen.at(-1)!;
    // NOT "failed": the write may well have landed and we simply stopped
    // looking. NOT "pending" either, which every `working` check counts as in
    // flight and which left the button that fired the write disabled forever.
    expect(last.stage).toBe("unresolved");
    expect(last.detail).toMatch(/not lost/i);
    expect(inFlight(last.stage)).toBe(false);
    vi.useRealTimers();
  });
});

describe("a control must never be stranded by an unresolved confirmation", () => {
  it("does not count unresolved as in flight", () => {
    // The poll gave up without an answer. The state is genuinely unknown, so
    // it must not read as failed, but it must stop disabling the control:
    // leaving it "pending" kept the button that fired the write disabled for
    // the life of the component, so the user could neither retry nor find out
    // whether their money had moved.
    expect(inFlight("unresolved")).toBe(false);
  });

  it("counts every genuinely in-flight stage", () => {
    expect(inFlight("wallet")).toBe(true);
    expect(inFlight("submitted")).toBe(true);
    expect(inFlight("pending")).toBe(true);
  });

  it("counts every settled stage as not in flight", () => {
    // accepted is settled for CONTROL purposes: the state is live, every
    // read sees it, and holding the button disabled for the finality watch
    // would block a user whose write has already taken effect.
    for (const s of ["idle", "accepted", "confirmed", "failed", "rejected"] as const) {
      expect(inFlight(s), s).toBe(false);
    }
  });

  it("gives unresolved a label that claims neither success nor failure", () => {
    expect(STAGE_LABEL.unresolved).toBe("Not yet visible");
    expect(STAGE_LABEL.unresolved).not.toMatch(/fail|error|success|confirmed/i);
  });

  it("shows the progress an unresolved write actually made", () => {
    // It reached pending. Blanking the track would hide that the write was
    // sent at all.
    expect(stageClass("submitted", "unresolved")).toContain("done");
    expect(stageClass("accepted", "unresolved")).not.toContain("done");
    expect(stageClass("confirmed", "unresolved")).not.toContain("done");
  });
});

describe("finality is tracked, not presumed — a contract read is ACCEPTED, not FINALIZED", () => {
  const base = (
    overrides: Partial<WriteArgs> & Pick<WriteArgs, "predicate">,
  ): WriteArgs => ({
    client: okClient(),
    address: "0x" + "7".repeat(40),
    functionName: "stake",
    args: [],
    ...overrides,
  });

  it("separates the claims: accepted for the state read, finalized only from the transaction", () => {
    // The word "Finalized" must be earned by the transaction reporting
    // FINALIZED — never by a view read, which proves acceptance at most.
    expect(STAGE_LABEL.accepted).toBe("Accepted");
    expect(STAGE_LABEL.confirmed).toBe("Finalized");
    expect(STAGE_TRACK.indexOf("accepted")).toBeGreaterThan(STAGE_TRACK.indexOf("pending"));
    expect(STAGE_TRACK.indexOf("confirmed")).toBeGreaterThan(STAGE_TRACK.indexOf("accepted"));
  });

  it("says finalized only after the transaction reports FINALIZED with a successful execution", async () => {
    vi.useFakeTimers();
    const seen: TxProgress[] = [];
    let finalized = false;
    const p = writeAndConfirm(base({
      predicate: async () => true,
      txStatus: async (): Promise<TxFinalityView> =>
        finalized
          ? { statusName: "FINALIZED", finalized: true, executed: "SUCCESS" }
          : { statusName: "ACCEPTED", finalized: false, executed: "SUCCESS" },
      onProgress: (x: TxProgress) => seen.push({ ...x }),
    }));
    await vi.advanceTimersByTimeAsync(6000);
    await p;
    expect(seen.at(-1)?.stage).toBe("accepted");
    expect(seen.at(-1)?.detail).toMatch(/accepted the write/i);

    // still ACCEPTED on-chain: the watch must not upgrade the claim
    await vi.advanceTimersByTimeAsync(12_000);
    expect(seen.at(-1)?.stage).toBe("accepted");

    finalized = true;
    await vi.advanceTimersByTimeAsync(6000);
    expect(seen.at(-1)?.stage).toBe("confirmed");
    expect(seen.at(-1)?.detail).toMatch(/finalized/i);
    vi.useRealTimers();
  });

  it("stops claiming anything final when the watch runs out, and says so", async () => {
    vi.useFakeTimers();
    const seen: TxProgress[] = [];
    const p = writeAndConfirm(base({
      predicate: async () => true,
      txStatus: status("ACCEPTED"),   // never finalizes while we watch
      finalityTries: 3,
      onProgress: (x: TxProgress) => seen.push({ ...x }),
    }));
    await vi.advanceTimersByTimeAsync(6000);
    await p;
    await vi.advanceTimersByTimeAsync(3 * 6000);
    const last = seen.at(-1)!;
    expect(last.stage).toBe("accepted");
    expect(last.detail).toMatch(/not yet reported it finalized/i);
    expect(last.detail).toMatch(/irreversible only once/i);
    expect(seen.some((s) => s.stage === "confirmed")).toBe(false);
    vi.useRealTimers();
  });

  it("reports a finalized refusal as failed instead of letting the user wait out the poll", async () => {
    vi.useFakeTimers();
    const seen: TxProgress[] = [];
    const p = writeAndConfirm(base({
      predicate: async () => false,                 // the state never appears…
      txStatus: status("FINALIZED", "ERROR"),       // …because the write was refused
      onProgress: (x: TxProgress) => seen.push({ ...x }),
    }));
    const outcome = expect(p).rejects.toThrow(/refused/i);
    await vi.advanceTimersByTimeAsync(3 * 6000);    // the third miss checks the tx
    await outcome;
    expect(seen.at(-1)?.stage).toBe("failed");
    expect(seen.at(-1)?.detail).toMatch(/nothing moved/i);
    vi.useRealTimers();
  });

  it("credits the state, not this transaction, when a permissionless call was beaten to it", async () => {
    vi.useFakeTimers();
    const seen: TxProgress[] = [];
    const p = writeAndConfirm(base({
      predicate: async () => true,                  // the market state IS there…
      txStatus: status("FINALIZED", "ERROR"),       // …but this tx finalized as a no-op
      confirmedDetail: "This market now carries a ruling.",
      onProgress: (x: TxProgress) => seen.push({ ...x }),
    }));
    await vi.advanceTimersByTimeAsync(6000);
    await p;
    await vi.advanceTimersByTimeAsync(6000);
    const last = seen.at(-1)!;
    expect(last.stage).toBe("confirmed");
    expect(last.detail).toMatch(/carries a ruling/);
    expect(last.detail).toMatch(/another transaction/i);
    vi.useRealTimers();
  });

  it("stateVisible answers exactly the follow-up-action question", () => {
    for (const s of ["accepted", "confirmed"] as const) {
      expect(stateVisible(s), s).toBe(true);
    }
    for (const s of ["idle", "wallet", "submitted", "pending", "unresolved", "rejected", "failed"] as const) {
      expect(stateVisible(s), s).toBe(false);
    }
  });
});
