import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(process.cwd(), "src/cli/run.ts");

function setup(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-ops-cli-"));
  mkdirSync(join(root, ".harness"), { recursive: true });
  return root;
}

function run(
  args: string[],
  harnessRoot: string,
): { stdout: string; stderr: string; status: number } {
  const r = spawnSync("node", ["--import", "tsx", CLI, ...args], {
    env: { ...process.env, HARNESS_ROOT: harnessRoot },
    encoding: "utf8",
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? 1 };
}

describe("harness knowledge ops", () => {
  it("adds, lists, shows and deprecates an operational entry", () => {
    const root = setup();

    const add = run(
      [
        "knowledge", "ops", "add",
        "--key", "ci-spend",
        "--title", "CI spending limit",
        "--body", "All jobs fail instantly once the limit is hit.",
        "--kind", "ci",
        "--tag", "github",
        "--tag", "billing",
        "--actor", "op",
      ],
      root,
    );
    expect(add.status).toBe(0);
    expect(add.stdout).toContain("ops/ci-spend");

    const list = run(["knowledge", "ops", "list", "--json"], root);
    expect(list.status).toBe(0);
    const listed = JSON.parse(list.stdout);
    expect(listed.entries).toHaveLength(1);
    expect(listed.entries[0].entryId).toBe("ops/ci-spend");
    expect(listed.entries[0].tags).toEqual(["github", "billing"]);

    const show = run(["knowledge", "ops", "show", "ops/ci-spend"], root);
    expect(show.status).toBe(0);
    expect(show.stdout).toContain("All jobs fail instantly");

    const dep = run(
      ["knowledge", "ops", "deprecate", "ops/ci-spend", "--actor", "op"],
      root,
    );
    expect(dep.status).toBe(0);

    const afterList = run(["knowledge", "ops", "list", "--json"], root);
    expect(JSON.parse(afterList.stdout).entries).toHaveLength(0);
    const withDep = run(
      ["knowledge", "ops", "list", "--json", "--include-deprecated"],
      root,
    );
    expect(JSON.parse(withDep.stdout).entries).toHaveLength(1);
  });

  it("scopes ops list by project while keeping portable entries", () => {
    const root = setup();
    run(
      ["knowledge", "ops", "add", "--key", "portable", "--title", "P", "--body", "tool fact", "--actor", "op"],
      root,
    );
    run(
      ["knowledge", "ops", "add", "--key", "alpha-note", "--title", "A", "--body", "a fact", "--project", "alpha", "--actor", "op"],
      root,
    );
    run(
      ["knowledge", "ops", "add", "--key", "beta-note", "--title", "B", "--body", "b fact", "--project", "beta", "--actor", "op"],
      root,
    );
    const list = run(["knowledge", "ops", "list", "--json", "--project", "alpha"], root);
    const ids = JSON.parse(list.stdout).entries.map((e: any) => e.entryId).sort();
    expect(ids).toEqual(["ops/alpha-note", "ops/portable"]);

    // text rendering shows the full scope (not just "portable").
    const text = run(["knowledge", "ops", "list", "--project", "alpha"], root);
    expect(text.stdout).toMatch(/ops\/alpha-note\t\S+\tproject=alpha\t/);
    expect(text.stdout).toMatch(/ops\/portable\t\S+\tportable\t/);
  });

  it("requires a title and a body", () => {
    const root = setup();
    const noTitle = run(["knowledge", "ops", "add", "--body", "x", "--actor", "op"], root);
    expect(noTitle.status).not.toBe(0);
    const noBody = run(["knowledge", "ops", "add", "--title", "t", "--actor", "op"], root);
    expect(noBody.status).not.toBe(0);
  });

  it("keeps codebase and operational surfaces separate", () => {
    const root = setup();
    run(
      ["knowledge", "ops", "add", "--key", "sep", "--title", "Sep", "--body", "ops body", "--actor", "op"],
      root,
    );
    // The codebase `knowledge show` must refuse an operational entry.
    const codebaseShow = run(["knowledge", "show", "ops/sep"], root);
    expect(codebaseShow.status).not.toBe(0);
    // The operational `knowledge ops show` must refuse a non-operational id.
    const opsShowMissing = run(["knowledge", "ops", "show", "docs/knowledge/x.md"], root);
    expect(opsShowMissing.status).not.toBe(0);
  });

  it("digest aggregates total / active / deprecated / by kind", () => {
    const root = setup();
    run(["knowledge", "ops", "add", "--key", "a", "--title", "A", "--body", "x", "--kind", "ci", "--actor", "op"], root);
    run(["knowledge", "ops", "add", "--key", "b", "--title", "B", "--body", "y", "--kind", "ci", "--actor", "op"], root);
    run(["knowledge", "ops", "deprecate", "ops/b", "--actor", "op"], root);
    const d = run(["knowledge", "ops", "digest", "--json"], root);
    expect(d.status).toBe(0);
    const j = JSON.parse(d.stdout);
    expect(j).toMatchObject({ total: 2, active: 1, deprecated: 1 });
    expect(j.byKind).toEqual({ ci: 1 });
  });

  it("export → import round-trips operational knowledge across HARNESS_ROOTs", () => {
    const src = setup();
    run(["knowledge", "ops", "add", "--key", "ci-note", "--title", "CI", "--body", "fails fast", "--kind", "ci", "--tag", "github", "--actor", "op"], src);
    run(["knowledge", "ops", "add", "--key", "portable", "--title", "P", "--body", "ext4 only", "--actor", "op"], src);

    const ex = run(["knowledge", "ops", "export", "--to-docs", "--json"], src);
    expect(ex.status).toBe(0);
    expect(JSON.parse(ex.stdout).written).toHaveLength(2);

    // requires --to-docs
    expect(run(["knowledge", "ops", "export"], src).status).not.toBe(0);

    // import into a FRESH root from src's docs/ops-knowledge
    const dst = setup();
    const im = run(
      ["knowledge", "ops", "import", "--from-docs", "--dir", join(src, "docs", "ops-knowledge"), "--json"],
      dst,
    );
    expect(im.status).toBe(0);
    expect(JSON.parse(im.stdout).imported).toBe(2);
    const list = run(["knowledge", "ops", "list", "--json"], dst);
    const ids = JSON.parse(list.stdout).entries.map((e: any) => e.entryId).sort();
    expect(ids).toEqual(["ops/ci-note", "ops/portable"]);
  });
});
