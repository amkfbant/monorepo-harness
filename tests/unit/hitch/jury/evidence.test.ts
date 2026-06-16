import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Create a symlink, returning false if the platform does not support symlinks
 * (e.g. Windows without privilege). Tests guard on this so they skip cleanly
 * rather than fail on unsupported platforms.
 */
function trySymlink(target: string, linkPath: string): boolean {
  try {
    symlinkSync(target, linkPath);
    return true;
  } catch {
    return false;
  }
}
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
  // docs/specs/jp.md — NON-ASCII (Japanese) headings. Real specs under
  // docs/specs use Japanese headings (e.g. workflow.md), so the slugifier MUST
  // preserve Unicode word characters to verify a citation to their GitHub-style
  // anchor (codex#254-R6 FIX 4).
  writeFileSync(
    join(worktreePath, "docs", "specs", "jp.md"),
    [
      "# 安全境界",
      "",
      "本文",
      "",
      "## モード dev ops",
      "",
      "詳細",
      "",
    ].join("\n"),
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

  it("FIX 1 (codex P1): a '../'-escaping citation resolving to a REAL out-of-tree file -> verified false (guard, not ENOENT)", () => {
    // Create a sibling file just OUTSIDE the worktree, then cite it via a
    // `..`-escape. The file genuinely exists on disk, so only the
    // path-traversal guard (not ENOENT) can keep this verified:false.
    const parent = resolve(worktreePath, "..");
    const escapedName = "harness-jury-escape-target.ts";
    writeFileSync(join(parent, escapedName), "export const x = 1;\n");
    try {
      const out = verifyEvidence(
        { citation: `src/x.ts/../../${escapedName}:1`, kind: "file", claim: "c" },
        ctx(),
      );
      expect(out.verified).toBe(false);
    } finally {
      rmSync(join(parent, escapedName), { force: true });
    }
  });

  it("FIX 1 (codex P1): an ABSOLUTE-path citation -> verified false (fail-closed)", () => {
    // An absolute citation can point anywhere on the host fs; the existence
    // check must reject it outright (it is not a worktree-relative path).
    const abs = resolve(worktreePath, "src", "x.ts");
    const out = verifyEvidence(
      { citation: abs, kind: "file", claim: "c" },
      ctx(),
    );
    expect(out.verified).toBe(false);
  });

  it("FIX 1 (codex P1): an in-tree '../'-normalizing citation that stays inside the worktree -> still verifies", () => {
    // docs/specs/../../src/x.ts normalizes back to src/x.ts, which is INSIDE
    // the worktree — the guard must not over-reject legitimate in-tree paths.
    const out = verifyEvidence(
      { citation: "docs/specs/../../src/x.ts:1", kind: "file", claim: "c" },
      ctx(),
    );
    expect(out.verified).toBe(true);
  });

  it("codex#254-P2 FIX2: an IN-TREE symlink whose target is OUTSIDE the worktree -> verified false (does not follow the symlink to read the external target)", () => {
    // The lexical relative()/'..' guard passes (the citation path `link.ts` is
    // in-tree), but the symlink points at a REAL file outside the worktree, so
    // statSync/readFileSync would otherwise FOLLOW it and verify/read the
    // external target. The real-path guard must reject it (fail-closed).
    const parent = resolve(worktreePath, "..");
    const externalName = "harness-jury-symlink-external.ts";
    const externalPath = join(parent, externalName);
    writeFileSync(externalPath, "export const secret = 1;\n");
    const linkPath = join(worktreePath, "link.ts");
    if (!trySymlink(externalPath, linkPath)) {
      rmSync(externalPath, { force: true });
      return; // platform without symlink support — skip cleanly
    }
    try {
      const out = verifyEvidence(
        { citation: "link.ts:1", kind: "file", claim: "c" },
        ctx(),
      );
      expect(out.verified).toBe(false);
    } finally {
      rmSync(linkPath, { force: true });
      rmSync(externalPath, { force: true });
    }
  });

  it("codex#254-P2 FIX2: an IN-TREE symlink whose target is INSIDE the worktree -> still verifies (does not over-reject in-tree symlinks)", () => {
    // A symlink that resolves back inside the worktree is legitimate; the
    // real-path guard must not over-reject it.
    const linkPath = join(worktreePath, "link-in.ts");
    if (!trySymlink(join(worktreePath, "src", "x.ts"), linkPath)) {
      return; // platform without symlink support — skip cleanly
    }
    try {
      const out = verifyEvidence(
        { citation: "link-in.ts:1", kind: "file", claim: "c" },
        ctx(),
      );
      expect(out.verified).toBe(true);
    } finally {
      rmSync(linkPath, { force: true });
    }
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

  it("Round6 FIX 4: a NON-ASCII (Japanese) heading -> a citation to its GitHub-style anchor verifies (verified true)", () => {
    // docs/specs files use Japanese headings; the slugifier must PRESERVE Unicode
    // word characters. GitHub slug of "## モード dev ops" -> "モード-dev-ops"
    // (lowercase ASCII, spaces -> "-", Unicode letters kept). Stripping every
    // non-[a-z0-9] char would erase the Japanese chars and never match.
    const out = verifyEvidence(
      { citation: "docs/specs/jp.md#モード-dev-ops", kind: "spec", claim: "c" },
      ctx(),
    );
    expect(out.verified).toBe(true);
  });

  it("Round6 FIX 4: a pure-Japanese heading anchor verifies (no ASCII at all)", () => {
    // GitHub slug of "# 安全境界" -> "安全境界" (no punctuation, no spaces).
    const out = verifyEvidence(
      { citation: "docs/specs/jp.md#安全境界", kind: "spec", claim: "c" },
      ctx(),
    );
    expect(out.verified).toBe(true);
  });

  it("Round6 FIX 4: a genuinely-missing Japanese anchor still -> verified false (fail-closed)", () => {
    const out = verifyEvidence(
      { citation: "docs/specs/jp.md#存在しない", kind: "spec", claim: "c" },
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

  it("FIX 1 (codex P2): a '../'-escaping spec citation that glob-matches but RESOLVES outside the spec root -> verified false even with the anchor present", () => {
    // Place a markdown file with the "## Bar" anchor OUTSIDE the spec tree, at
    // docs/escape.md (the parent of docs/specs). An operator-set glob that
    // permits a `..` segment (minimatch's extglob `+(..)`) lets the RAW citation
    // `docs/specs/../escape.md` pass the glob check; the path then resolves to
    // docs/escape.md, OUTSIDE the docs/specs spec root. Without the resolved-path
    // traversal guard the code would read that out-of-tree md and verify the
    // anchor (verified:true). The guard must keep it verified:false.
    writeFileSync(
      join(worktreePath, "docs", "escape.md"),
      ["# Escape", "", "## Bar", "", "secret body", ""].join("\n"),
    );
    const escapingCtx: EvidenceCheckContext = {
      worktreePath,
      compiledPolicy: { global: GLOBAL, repo: REPO },
      // an operator-provided glob that minimatch matches against a `..` path
      specDocsGlobs: ["docs/specs/+(..)/escape.md"],
    };
    const out = verifyEvidence(
      { citation: "docs/specs/../escape.md#bar", kind: "spec", claim: "c" },
      escapingCtx,
    );
    expect(out.verified).toBe(false);
  });

  it("FIX 1 (codex P2): an ABSOLUTE-path spec citation -> verified false (fail-closed)", () => {
    // An absolute spec citation can point anywhere on the host fs; reject it
    // outright before reading (mirrors the file-kind absolute-path guard).
    const abs = join(worktreePath, "docs", "specs", "foo.md");
    const out = verifyEvidence(
      { citation: `${abs}#bar`, kind: "spec", claim: "c" },
      {
        worktreePath,
        compiledPolicy: { global: GLOBAL, repo: REPO },
        specDocsGlobs: ["**/*.md"],
      },
    );
    expect(out.verified).toBe(false);
  });

  it("codex#254-P2 FIX2: an IN-TREE spec symlink whose target is OUTSIDE the spec root -> verified false (does not follow the symlink to read the external md)", () => {
    // docs/specs/linked.md is an in-tree symlink (lexical guard + glob pass) that
    // points at an external md WITH the anchor. Without the real-path guard the
    // code would follow it and read the out-of-tree md (verified:true).
    const parent = resolve(worktreePath, "..");
    const externalName = "harness-jury-symlink-spec.md";
    const externalPath = join(parent, externalName);
    writeFileSync(
      externalPath,
      ["# External", "", "## Bar", "", "external body", ""].join("\n"),
    );
    const linkPath = join(worktreePath, "docs", "specs", "linked.md");
    if (!trySymlink(externalPath, linkPath)) {
      rmSync(externalPath, { force: true });
      return; // platform without symlink support — skip cleanly
    }
    try {
      const out = verifyEvidence(
        { citation: "docs/specs/linked.md#bar", kind: "spec", claim: "c" },
        ctx(),
      );
      expect(out.verified).toBe(false);
    } finally {
      rmSync(linkPath, { force: true });
      rmSync(externalPath, { force: true });
    }
  });

  it("codex#254-P2 FIX3: the spec-root glob PREFIX is itself a symlink to an external dir -> verified false (does not read the external md under the symlinked root)", () => {
    // The previous round-3 guard checked the cited FILE against the (possibly
    // symlinked) spec root, but never checked the spec ROOT itself stays inside
    // the worktree. Build a fresh worktree whose `docs/specs` is a SYMLINK to an
    // external dir holding `foo.md#bar`. The cited file `docs/specs/foo.md` is a
    // real (non-symlink) file under that external dir, so the per-file real-path
    // guard (root vs file) passes — only checking the root realpath against the
    // worktree realpath rejects it.
    const isolated = mkdtempSync(join(tmpdir(), "harness-jury-evroot-"));
    const externalSpecDir = mkdtempSync(join(tmpdir(), "harness-jury-extspec-"));
    try {
      mkdirSync(join(isolated, "docs"), { recursive: true });
      writeFileSync(
        join(externalSpecDir, "foo.md"),
        ["# Foo", "", "## Bar", "", "external body", ""].join("\n"),
      );
      // docs/specs -> external dir (the glob static prefix becomes a symlink).
      if (!trySymlink(externalSpecDir, join(isolated, "docs", "specs"))) {
        return; // platform without symlink support — skip cleanly
      }
      const out = verifyEvidence(
        { citation: "docs/specs/foo.md#bar", kind: "spec", claim: "c" },
        {
          worktreePath: isolated,
          compiledPolicy: { global: GLOBAL, repo: REPO },
        },
      );
      expect(out.verified).toBe(false);
    } finally {
      rmSync(isolated, { recursive: true, force: true });
      rmSync(externalSpecDir, { recursive: true, force: true });
    }
  });

  it("codex#254-P2 FIX3: a non-symlinked spec root (real dir under the worktree) still verifies (does not over-reject)", () => {
    // Defense against over-rejection from the spec-root guard: the default
    // fixture's docs/specs is a real directory under the worktree, so a valid
    // citation must still verify.
    const out = verifyEvidence(
      { citation: "docs/specs/foo.md#bar", kind: "spec", claim: "c" },
      ctx(),
    );
    expect(out.verified).toBe(true);
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
