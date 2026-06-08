import { describe, it, expect } from "vitest";
import {
  gatherReleasePlanInput,
  isAdditiveMigration,
  ReleaseGatherError,
  type GitReader,
  type MigrationDef,
} from "../../../src/release/release-git.js";

/** A fake GitReader over an in-memory { ref: { path: content } } + commits. */
function fakeReader(opts: {
  lastTag?: string | null;
  refs: Record<string, Record<string, string>>;
  commits?: { sha: string; subject: string; body: string }[];
}): GitReader {
  return {
    async lastTag() {
      return opts.lastTag ?? null;
    },
    async resolveRef(ref) {
      return opts.refs[ref] !== undefined ? `sha-${ref}` : null;
    },
    async fileAtRef(ref, path) {
      return opts.refs[ref]?.[path] ?? null;
    },
    async logCommits() {
      return opts.commits ?? [];
    },
  };
}

const MIGRATIONS: MigrationDef[] = [
  { version: 18, name: "v18", statements: ["CREATE TABLE a (x TEXT)"] },
  { version: 19, name: "operational-knowledge-category-v19", statements: ["ALTER TABLE k ADD COLUMN category TEXT"] },
  { version: 20, name: "rebuild-x", statements: ["CREATE TABLE x2 (...)", "DROP TABLE x", "ALTER TABLE x2 RENAME TO x"] },
];

function schemaSrc(v: number): string {
  return `export const SCHEMA_VERSION = ${v};\n`;
}

describe("isAdditiveMigration", () => {
  it("additive for ALTER ADD / CREATE only", () => {
    expect(isAdditiveMigration(["ALTER TABLE k ADD COLUMN c TEXT", "CREATE INDEX i ON k(c)"])).toBe(true);
  });
  it("non-additive for DROP / rebuild / column rename", () => {
    expect(isAdditiveMigration(["DROP TABLE x"])).toBe(false);
    expect(isAdditiveMigration(["ALTER TABLE x2 RENAME TO x"])).toBe(false);
    expect(isAdditiveMigration(["ALTER TABLE k RENAME COLUMN a TO b"])).toBe(false);
    expect(isAdditiveMigration(["DELETE FROM k WHERE x"])).toBe(false);
  });
});

describe("gatherReleasePlanInput", () => {
  it("computes schema delta, no-downgrade, and surface diffs", async () => {
    const reader = fakeReader({
      refs: {
        "v0.5.0": {
          "src/db/schema.ts": schemaSrc(18),
          "src/mcp/registry/tool-registry.ts": `name: "harness.run.list"\nname: "harness.knowledge.get"`,
          "src/cli/run.ts": `.command("run")\n.command("knowledge")`,
        },
        HEAD: {
          "src/db/schema.ts": schemaSrc(19),
          "src/mcp/registry/tool-registry.ts": `name: "harness.run.list"\nname: "harness.ops_knowledge.record"`,
          "src/cli/run.ts": `.command("run")\n.command("knowledge")\n.command("release")`,
        },
      },
      commits: [{ sha: "a1", subject: "feat: x", body: "" }],
    });
    const input = await gatherReleasePlanInput(reader, {
      migrations: MIGRATIONS,
      currentVersion: "0.5.0",
      since: "v0.5.0",
    });
    expect(input.schema).toMatchObject({
      fromVersion: 18,
      toVersion: 19,
      changed: true,
      destructive: false,
      noDowngrade: true,
    });
    expect(input.schema.newMigrations.map((m) => m.version)).toEqual([19]);
    expect(input.mcpTools.added).toEqual(["harness.ops_knowledge.record"]);
    expect(input.mcpTools.removed).toEqual(["harness.knowledge.get"]);
    expect(input.cliCommands.added).toEqual(["release"]);
    expect(input.cliCommands.removed).toEqual([]);
    expect(input.commits[0]?.type).toBe("feat");
  });

  it("flags a destructive migration in the schema range", async () => {
    const reader = fakeReader({
      refs: {
        "v0.5.0": { "src/db/schema.ts": schemaSrc(19) },
        HEAD: { "src/db/schema.ts": schemaSrc(20) },
      },
    });
    const input = await gatherReleasePlanInput(reader, {
      migrations: MIGRATIONS, currentVersion: "0.5.0", since: "v0.5.0",
    });
    expect(input.schema.newMigrations.map((m) => m.version)).toEqual([20]);
    expect(input.schema.destructive).toBe(true);
  });

  it("defaults `since` to the last tag", async () => {
    const reader = fakeReader({
      lastTag: "v0.4.2",
      refs: { "v0.4.2": { "src/db/schema.ts": schemaSrc(18) }, HEAD: { "src/db/schema.ts": schemaSrc(18) } },
    });
    const input = await gatherReleasePlanInput(reader, { migrations: MIGRATIONS, currentVersion: "0.4.2" });
    expect(input.since).toBe("v0.4.2");
    expect(input.schema.changed).toBe(false);
  });

  it("throws when there is no tag and no --since", async () => {
    const reader = fakeReader({ lastTag: null, refs: { HEAD: {} } });
    await expect(
      gatherReleasePlanInput(reader, { migrations: MIGRATIONS, currentVersion: "0.1.0" }),
    ).rejects.toBeInstanceOf(ReleaseGatherError);
  });

  it("throws when --since cannot be resolved", async () => {
    const reader = fakeReader({ refs: { HEAD: {} } });
    await expect(
      gatherReleasePlanInput(reader, { migrations: MIGRATIONS, currentVersion: "0.1.0", since: "v9.9.9" }),
    ).rejects.toBeInstanceOf(ReleaseGatherError);
  });

  it("FAILS CLOSED when schema.ts is unreadable at `to` (no silent unchanged)", async () => {
    const reader = fakeReader({
      // `to` has no schema.ts (moved/renamed) — must throw, not report v0.
      refs: { "v0.5.0": { "src/db/schema.ts": schemaSrc(18) }, HEAD: {} },
    });
    await expect(
      gatherReleasePlanInput(reader, { migrations: MIGRATIONS, currentVersion: "0.5.0", since: "v0.5.0" }),
    ).rejects.toThrow(/schema\.ts at HEAD/);
  });

  it("diffs CLI commands across per-domain modules (db.ts/goal.ts/...) with cross-file net-out", async () => {
    const reader = fakeReader({
      refs: {
        "v0.5.0": {
          "src/db/schema.ts": schemaSrc(19),
          "src/cli/run.ts": `.command("run")\n.command("list")`,
          "src/cli/db.ts": `.command("migrate-blobs")\n.command("list")`,
        },
        HEAD: {
          "src/db/schema.ts": schemaSrc(19),
          "src/cli/run.ts": `.command("run")\n.command("list")`,
          // db.ts dropped `migrate-blobs` and its own `list`
          "src/cli/db.ts": `.command("status")`,
        },
      },
    });
    const input = await gatherReleasePlanInput(reader, {
      migrations: MIGRATIONS, currentVersion: "0.5.0", since: "v0.5.0",
    });
    // a unique token removed from a module IS detected:
    expect(input.cliCommands.removed).toContain("migrate-blobs");
    // but `list` is still in run.ts → NOT a false removal (cross-file net-out):
    expect(input.cliCommands.removed).not.toContain("list");
    expect(input.cliCommands.added).toContain("status");
  });

  it("skips a surface diff (not 'all removed') + warns when the `to` file is unreadable", async () => {
    const reader = fakeReader({
      refs: {
        "v0.5.0": {
          "src/db/schema.ts": schemaSrc(19),
          "src/mcp/registry/tool-registry.ts": `name: "harness.run.list"`,
        },
        // `to` has schema (so gather proceeds) but the registry file moved away.
        HEAD: { "src/db/schema.ts": schemaSrc(19) },
      },
    });
    const input = await gatherReleasePlanInput(reader, {
      migrations: MIGRATIONS, currentVersion: "0.5.0", since: "v0.5.0",
    });
    expect(input.mcpTools).toEqual({ added: [], removed: [] }); // NOT [harness.run.list] removed
    expect((input.warnings ?? []).join(" ")).toMatch(/tool-registry\.ts present at v0\.5\.0 but unreadable at HEAD/);
  });
});
