import { describe, expect, it } from "vitest";
import { findWorkspaceConflicts } from "../../../src/workspace/workspace-conflicts.js";

describe("findWorkspaceConflicts", () => {
  it("returns no conflicts when no two agents share a file", () => {
    expect(
      findWorkspaceConflicts([
        { agent: "alice", files: ["a.ts", "b.ts"] },
        { agent: "bob", files: ["c.ts"] },
      ]),
    ).toEqual([]);
  });

  it("reports the shared files for an overlapping pair", () => {
    expect(
      findWorkspaceConflicts([
        { agent: "alice", files: ["a.ts", "shared.ts"] },
        { agent: "bob", files: ["shared.ts", "c.ts"] },
      ]),
    ).toEqual([{ a: "alice", b: "bob", files: ["shared.ts"] }]);
  });

  it("emits each pair once (a < b) and sorts pairs/files deterministically", () => {
    const out = findWorkspaceConflicts([
      { agent: "carol", files: ["x.ts", "y.ts"] },
      { agent: "alice", files: ["y.ts", "x.ts"] },
      { agent: "bob", files: ["x.ts"] },
    ]);
    // pairs: alice-bob (x), alice-carol (x,y), bob-carol (x)
    expect(out).toEqual([
      { a: "alice", b: "bob", files: ["x.ts"] },
      { a: "alice", b: "carol", files: ["x.ts", "y.ts"] },
      { a: "bob", b: "carol", files: ["x.ts"] },
    ]);
  });

  it("ignores agents with no changes and dedupes file lists", () => {
    const out = findWorkspaceConflicts([
      { agent: "alice", files: ["a.ts", "a.ts"] },
      { agent: "idle", files: [] },
      { agent: "bob", files: ["a.ts"] },
    ]);
    expect(out).toEqual([{ a: "alice", b: "bob", files: ["a.ts"] }]);
  });
});
