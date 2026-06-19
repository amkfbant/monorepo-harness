import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLI_PATHS } from "../../../src/release/release-git.js";

/**
 * CLI_PATHS の網羅性 gate（release の breaking-change 検知の死角を塞ぐ）。
 *
 * release-git は CLI_PATHS のファイルだけを `since`/`to` で scan し `.command("..")`
 * の削除を breaking として検知する。command surface を持つファイルが CLI_PATHS から
 * 漏れると、その command の削除が **silently 見逃される**。実際 course.ts / onboard.ts
 * は register*Commands を持ちながら長く漏れていた。本テストは
 * 「command surface を持つ src/cli・src/mcp/cli.ts は全て CLI_PATHS に含まれる」
 * を機械的に強制し、#125 の run.ts 分割で新規 cli モジュールを足す際の登録漏れも捕捉する。
 *
 * 判定方向は coverage（surface ⊆ CLI_PATHS）。run.ts のような非 exporter の inline
 * surface も surface を持つ以上 CLI_PATHS 必須なので、exporter 限定にはしない。
 */

// release-git の CLI_COMMAND_RE と同義（/g なし・boolean 判定用）。
const COMMAND_SURFACE_RE = /\.command\(\s*"[a-z][a-z0-9_-]*"/;

function repoRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}

/** 追跡された src/cli・src/mcp/cli.ts のうち CLI command surface を持つファイル。 */
function filesWithCommandSurface(root: string): string[] {
  const tracked = execFileSync(
    "git",
    ["ls-files", "--", "src/cli", "src/mcp/cli.ts"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\n")
    .map((l) => l.trim())
    .filter((p) => p.endsWith(".ts") && !p.endsWith(".test.ts"));
  return tracked.filter((p) =>
    COMMAND_SURFACE_RE.test(readFileSync(join(root, p), "utf8")),
  );
}

describe("CLI_PATHS coverage（release breaking-change 検知の網羅性）", () => {
  it("CLI command surface を持つ全ファイルが CLI_PATHS に含まれる", () => {
    const root = repoRoot();
    const withSurface = filesWithCommandSurface(root);
    expect(withSurface.length).toBeGreaterThan(0); // 列挙失敗を loud fail
    const missing = withSurface.filter((p) => !CLI_PATHS.includes(p));
    expect(missing).toEqual([]);
  });

  it("surface を持たないファイルは CLI_PATHS に含めない（過剰登録の回帰防止）", () => {
    expect(CLI_PATHS).not.toContain("src/cli/db-scope.ts");
    expect(CLI_PATHS).not.toContain("src/cli/policy-compile.ts");
  });

  it("course.ts / onboard.ts が網羅されている（旧 coverage gap の pin）", () => {
    expect(CLI_PATHS).toContain("src/cli/course.ts");
    expect(CLI_PATHS).toContain("src/cli/onboard.ts");
  });
});
