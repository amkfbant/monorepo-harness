import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verifyEvidence } from "../../../../src/hitch/jury/evidence.js";
import type {
  EvidenceCheckContext,
  RawJuryEvidence,
} from "../../../../src/hitch/jury/types.js";
import type { GlobalPolicy, RepoPolicy } from "../../../../src/policy/schema.js";

/**
 * #230 Task B5 — verifyEvidence deterministic existence check (design §4.4 /
 * §0.1 R1 / P3 kind-boundary). Builds a real tmp fixture worktree so the file
 * and spec kinds resolve against actual fs state.
 */

let worktreePath: string;

const GLOBAL: GlobalPolicy = {
  always_deny_write: [],
  ignore_untracked: [],
};

// repo policy with one domain whose read/write/deny_write globs and domain key
// drive the deterministic policy-citation grammar.
const REPO: RepoPolicy = {
  repo_id: "fixture-repo",
  read: [],
  domains: {
    "apps/web": {
      read: ["apps/web/**", "packages/shared/**"],
      write: ["apps/web/src/**"],
      deny_write: ["apps/web/secrets/**"],
    },
  },
};

const ctx = (): EvidenceCheckContext => ({
  worktreePath,
  compiledPolicy: { global: GLOBAL, repo: REPO },
});

beforeAll(() => {
  worktreePath = mkdtempSync(join(tmpdir(), "harness-jury-evidence-"));
  mkdirSync(join(worktreePath, "src"), { recursive: true });
  mkdirSync(join(worktreePath, "docs", "specs"), { recursive: true });
  // src/x.ts — exactly 5 lines.
  writeFileSync(
    join(worktreePath, "src", "x.ts"),
    ["export const a = 1;", "export const b = 2;", "const c = 3;", "void c;", "// end"].join(
      "\n",
    ),
  );
  // docs/specs/foo.md — a "## Bar" heading.
  writeFileSync(
    join(worktreePath, "docs", "specs", "foo.md"),
    ["# Foo", "", "intro text", "", "## Bar", "", "bar body", ""].join("\n"),
  );
  // docs/specs/dup.md — two headings that slugify to the SAME anchor ("bar").
  // The duplicate-anchor case must fail-closed (ambiguous -> verified false).
  writeFileSync(
    join(worktreePath, "docs", "specs", "dup.md"),
    ["# Dup", "", "## Bar", "", "first bar", "", "## Bar", "", "second bar", ""].join(
      "\n",
    ),
  );
});

afterAll(() => {
  rmSync(worktreePath, { recursive: true, force: true });
});

describe("verifyEvidence — file kind", () => {
  it("existing path + line in range -> verified true, resolvedRef absolute", () => {
    const out = verifyEvidence(
      { citation: "src/x.ts:3", kind: "file", claim: "c" },
      ctx(),
    );
    expect(out.verified).toBe(true);
    expect(out.resolvedRef).toBe(resolve(worktreePath, "src/x.ts"));
  });

  it("existing path with NO line -> verified true", () => {
    const out = verifyEvidence(
      { citation: "src/x.ts", kind: "file", claim: "c" },
      ctx(),
    );
    expect(out.verified).toBe(true);
  });

  it("existing path + line range fully in range -> verified true", () => {
    const out = verifyEvidence(
      { citation: "src/x.ts:2-5", kind: "file", claim: "c" },
      ctx(),
    );
    expect(out.verified).toBe(true);
  });

  it("existing path but line OUT of range -> verified false (P3)", () => {
    const out = verifyEvidence(
      { citation: "src/x.ts:6", kind: "file", claim: "c" },
      ctx(),
    );
    expect(out.verified).toBe(false);
  });

  it("existing path but line range END out of range -> verified false", () => {
    const out = verifyEvidence(
      { citation: "src/x.ts:4-9", kind: "file", claim: "c" },
      ctx(),
    );
    expect(out.verified).toBe(false);
  });

  it("non-existent path -> verified false", () => {
    const out = verifyEvidence(
      { citation: "src/nope.ts:1", kind: "file", claim: "c" },
      ctx(),
    );
    expect(out.verified).toBe(false);
  });
});

describe("verifyEvidence — spec kind", () => {
  it("existing md heading anchor -> verified true", () => {
    const out = verifyEvidence(
      { citation: "docs/specs/foo.md#bar", kind: "spec", claim: "c" },
      ctx(),
    );
    expect(out.verified).toBe(true);
  });

  it("missing heading anchor -> verified false", () => {
    const out = verifyEvidence(
      { citation: "docs/specs/foo.md#nonexistent", kind: "spec", claim: "c" },
      ctx(),
    );
    expect(out.verified).toBe(false);
  });

  it("FINDING 4: duplicate-anchor (two headings slugify to the same anchor) -> verified false (ambiguous -> fail-closed)", () => {
    // dup.md has two "## Bar" headings that both slugify to "bar"; the
    // matches===1 logic in verifySpec must reject the ambiguous citation.
    const out = verifyEvidence(
      { citation: "docs/specs/dup.md#bar", kind: "spec", claim: "c" },
      ctx(),
    );
    expect(out.verified).toBe(false);
  });

  it("anchor in a md file outside specDocsGlobs -> verified false", () => {
    // foo.md exists under docs/specs (in default glob), but a citation to a
    // path NOT covered by the glob must not verify.
    const out = verifyEvidence(
      { citation: "src/x.ts#bar", kind: "spec", claim: "c" },
      ctx(),
    );
    expect(out.verified).toBe(false);
  });
});

describe("verifyEvidence — policy kind", () => {
  it("citation matching a domain read glob -> verified true", () => {
    const out = verifyEvidence(
      { citation: "apps/web/**", kind: "policy", claim: "c" },
      ctx(),
    );
    expect(out.verified).toBe(true);
  });

  it("citation naming an existing domain -> verified true", () => {
    const out = verifyEvidence(
      { citation: "apps/web", kind: "policy", claim: "c" },
      ctx(),
    );
    expect(out.verified).toBe(true);
  });

  it("citation matching a deny_write glob -> verified true", () => {
    const out = verifyEvidence(
      { citation: "apps/web/secrets/**", kind: "policy", claim: "c" },
      ctx(),
    );
    expect(out.verified).toBe(true);
  });

  it("zero-match policy citation -> verified false", () => {
    const out = verifyEvidence(
      { citation: "services/api/**", kind: "policy", claim: "c" },
      ctx(),
    );
    expect(out.verified).toBe(false);
  });
});

describe("verifyEvidence — R1: LLM-claimed verified is discarded", () => {
  it("LLM-supplied verified=true on a non-existent citation -> verified false", () => {
    const out = verifyEvidence(
      { citation: "nope.ts:1", kind: "file", claim: "c", verified: true } as RawJuryEvidence & {
        verified: true;
      },
      ctx(),
    );
    expect(out.verified).toBe(false);
  });

  it("LLM-supplied verified=true on an out-of-range line -> verified false", () => {
    const out = verifyEvidence(
      { citation: "src/x.ts:99", kind: "file", claim: "c", verified: true } as RawJuryEvidence & {
        verified: true;
      },
      ctx(),
    );
    expect(out.verified).toBe(false);
  });

  it("LLM-supplied verified=false on a real, in-range citation -> verified true (recomputed)", () => {
    const out = verifyEvidence(
      { citation: "src/x.ts:1", kind: "file", claim: "c", verified: false } as RawJuryEvidence & {
        verified: false;
      },
      ctx(),
    );
    expect(out.verified).toBe(true);
  });
});

describe("verifyEvidence — unknown / unresolvable kind", () => {
  it("unknown kind -> verified false", () => {
    const out = verifyEvidence(
      { citation: "whatever", kind: "mystery", claim: "c" } as unknown as RawJuryEvidence,
      ctx(),
    );
    expect(out.verified).toBe(false);
  });
});

describe("verifyEvidence — determinism", () => {
  it("same evidence + ctx twice -> deep-equal output", () => {
    const ev: RawJuryEvidence = { citation: "src/x.ts:3", kind: "file", claim: "c" };
    expect(verifyEvidence(ev, ctx())).toEqual(verifyEvidence(ev, ctx()));
  });

  it("preserves citation/kind/claim on output", () => {
    const ev: RawJuryEvidence = { citation: "src/x.ts:3", kind: "file", claim: "supports X" };
    const out = verifyEvidence(ev, ctx());
    expect(out.citation).toBe("src/x.ts:3");
    expect(out.kind).toBe("file");
    expect(out.claim).toBe("supports X");
  });
});
