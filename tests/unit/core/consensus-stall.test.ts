import { describe, it, expect } from "vitest";
import {
  detectConsensusStall,
  type ConsensusProgressSnapshot,
} from "../../../src/core/consensus-stall.js";

function snap(
  input: Partial<ConsensusProgressSnapshot> & { evaluatedAt: string },
): ConsensusProgressSnapshot {
  return {
    status: input.status ?? "pending",
    totalApprovals: input.totalApprovals ?? 0,
    totalParticipants: input.totalParticipants ?? 0,
    blocked: input.blocked ?? false,
    ...input,
  };
}

const CONFIG = { stallAfterSnapshots: 3 };

describe("detectConsensusStall (Phase 2-3)", () => {
  it("empty history → not stalled", () => {
    expect(detectConsensusStall([], CONFIG).stalled).toBe(false);
  });

  it("fewer snapshots than the window → not stalled (undecided)", () => {
    const r = detectConsensusStall(
      [
        snap({ evaluatedAt: "2026-06-05T09:00:00Z", totalParticipants: 1 }),
        snap({ evaluatedAt: "2026-06-05T10:00:00Z", totalParticipants: 1 }),
      ],
      CONFIG,
    );
    expect(r.stalled).toBe(false);
  });

  it("latest snapshot approved → not stalled (resolved)", () => {
    const r = detectConsensusStall(
      [
        snap({ evaluatedAt: "2026-06-05T09:00:00Z" }),
        snap({ evaluatedAt: "2026-06-05T10:00:00Z" }),
        snap({ evaluatedAt: "2026-06-05T11:00:00Z", status: "approved", totalApprovals: 2 }),
      ],
      CONFIG,
    );
    expect(r.stalled).toBe(false);
  });

  it("latest snapshot rejected → not stalled (decisive outcome)", () => {
    const r = detectConsensusStall(
      [
        snap({ evaluatedAt: "2026-06-05T09:00:00Z" }),
        snap({ evaluatedAt: "2026-06-05T10:00:00Z" }),
        snap({ evaluatedAt: "2026-06-05T11:00:00Z", status: "rejected" }),
      ],
      CONFIG,
    );
    expect(r.stalled).toBe(false);
  });

  it("pending with no approval/participant progress across the window → stalled", () => {
    const r = detectConsensusStall(
      [
        snap({ evaluatedAt: "2026-06-05T09:00:00Z", totalApprovals: 1, totalParticipants: 1 }),
        snap({ evaluatedAt: "2026-06-05T10:00:00Z", totalApprovals: 1, totalParticipants: 1 }),
        snap({ evaluatedAt: "2026-06-05T11:00:00Z", totalApprovals: 1, totalParticipants: 1 }),
      ],
      CONFIG,
    );
    expect(r.stalled).toBe(true);
    expect(r.reason).toContain("no progress");
  });

  it("participation increasing across the window → not stalled (progress)", () => {
    const r = detectConsensusStall(
      [
        snap({ evaluatedAt: "2026-06-05T09:00:00Z", totalParticipants: 1 }),
        snap({ evaluatedAt: "2026-06-05T10:00:00Z", totalParticipants: 2 }),
        snap({ evaluatedAt: "2026-06-05T11:00:00Z", totalParticipants: 3 }),
      ],
      CONFIG,
    );
    expect(r.stalled).toBe(false);
  });

  it("approvals increasing across the window → not stalled (progress)", () => {
    const r = detectConsensusStall(
      [
        snap({ evaluatedAt: "2026-06-05T09:00:00Z", totalApprovals: 0, totalParticipants: 2 }),
        snap({ evaluatedAt: "2026-06-05T10:00:00Z", totalApprovals: 1, totalParticipants: 2 }),
        snap({ evaluatedAt: "2026-06-05T11:00:00Z", totalApprovals: 2, totalParticipants: 2 }),
      ],
      CONFIG,
    );
    expect(r.stalled).toBe(false);
  });

  it("persistent blocking with no new participation → stalled", () => {
    const r = detectConsensusStall(
      [
        snap({ evaluatedAt: "2026-06-05T09:00:00Z", status: "changes_requested", blocked: true, totalParticipants: 2 }),
        snap({ evaluatedAt: "2026-06-05T10:00:00Z", status: "changes_requested", blocked: true, totalParticipants: 2 }),
        snap({ evaluatedAt: "2026-06-05T11:00:00Z", status: "changes_requested", blocked: true, totalParticipants: 2 }),
      ],
      CONFIG,
    );
    expect(r.stalled).toBe(true);
  });

  it("only the trailing window matters — early progress then a stalled streak → stalled", () => {
    const r = detectConsensusStall(
      [
        snap({ evaluatedAt: "2026-06-05T08:00:00Z", totalParticipants: 1 }),
        snap({ evaluatedAt: "2026-06-05T09:00:00Z", totalParticipants: 2, totalApprovals: 1 }),
        snap({ evaluatedAt: "2026-06-05T10:00:00Z", totalParticipants: 2, totalApprovals: 1 }),
        snap({ evaluatedAt: "2026-06-05T11:00:00Z", totalParticipants: 2, totalApprovals: 1 }),
      ],
      CONFIG,
    );
    expect(r.stalled).toBe(true);
  });

  it("maxPendingHours: pending streak older than threshold → stalled", () => {
    const r = detectConsensusStall(
      [
        snap({ evaluatedAt: "2026-06-04T09:00:00Z", totalParticipants: 1 }),
        snap({ evaluatedAt: "2026-06-05T11:00:00Z", totalParticipants: 1 }),
      ],
      { stallAfterSnapshots: 3, maxPendingHours: 24 },
    );
    expect(r.stalled).toBe(true);
    expect(r.reason).toContain("max");
  });

  it("throws on a misconfigured window (stallAfterSnapshots <= 0)", () => {
    expect(() =>
      detectConsensusStall(
        [snap({ evaluatedAt: "2026-06-05T09:00:00Z" })],
        { stallAfterSnapshots: 0 },
      ),
    ).toThrow(/stallAfterSnapshots/);
  });

  it("fail-closed: unparseable timestamp under maxPendingHours → stalled", () => {
    const r = detectConsensusStall(
      [
        snap({ evaluatedAt: "not-a-date" }),
        snap({ evaluatedAt: "2026-06-05T11:00:00Z" }),
      ],
      { stallAfterSnapshots: 3, maxPendingHours: 24 },
    );
    expect(r.stalled).toBe(true);
    expect(r.reason).toContain("unparseable");
  });

  it("maxPendingHours: within threshold → not stalled", () => {
    const r = detectConsensusStall(
      [
        snap({ evaluatedAt: "2026-06-05T09:00:00Z", totalParticipants: 1 }),
        snap({ evaluatedAt: "2026-06-05T11:00:00Z", totalParticipants: 1 }),
      ],
      { stallAfterSnapshots: 3, maxPendingHours: 24 },
    );
    expect(r.stalled).toBe(false);
  });
});
