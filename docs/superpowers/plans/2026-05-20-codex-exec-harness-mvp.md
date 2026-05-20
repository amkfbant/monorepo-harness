# Codex Exec Harness MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** TypeScript で Codex exec を駆動するモノレポ向けハーネス基盤 MVP を構築し、ドメイン単位の安全な実行・差分検査・ログ出力までを 1 本の CLI で完結させる。

**Architecture:** Codex exec を「直接編集型 worker」として扱い、run ごとに `git worktree` で分離した作業空間を作成、実行後に `git diff` を取得して domain policy に照らして事後検査する。run 成果物（meta / events / diff / summary / knowledge candidates）は `runs/<run-id>/` に保存。並行実行は domain 単位の lockfile で簡易制御する。

**Tech Stack:**
- TypeScript (strict) + Node.js 20+ / pnpm
- vitest (unit + integration)
- zod (schema), yaml (YAML I/O), commander (CLI), minimatch (glob)
- 子プロセス: `node:child_process` を直接利用（`git`/`codex` を spawn）
- 既存 `codex` CLI（Milestone 3 で実機の引数を確定）

**配置:** リポジトリ直下 (`/Users/kn/dev/monorepo-harness/`) をハーネス本体として扱う。サブディレクトリ `agent-harness/` は作らない。

---

## File Structure

新規作成（最終形）。各ファイルは単一責務で 80〜300 行を目安に分割。

```txt
package.json                              # pnpm script / deps
tsconfig.json                             # strict TS
vitest.config.ts                          # vitest 設定
.gitignore                                # node_modules, runs/, workspaces/, locks/
.npmrc                                    # save-exact, engine-strict

src/
  cli/
    run.ts                                # CLI entry: parse args → workflow runner
    parse-args.ts                         # commander で引数定義
  core/
    workflow-runner.ts                    # domain-coding workflow オーケストレーション
    run-context.ts                        # run 全体で共有する不変コンテキスト
    run-id.ts                             # run-YYYYMMDD-NNN 生成
    errors.ts                             # PolicyViolation / CodexFailure 等の型
  policy/
    schema.ts                             # zod schema (Global/Repo/Domain)
    loader.ts                             # YAML 読込 + zod parse
    resolver.ts                           # global + repo + domain をマージし ResolvedPolicy へ
    path-policy-validator.ts              # 変更パス vs write/deny_write 検査
  workspace/
    branch-name.ts                        # harness/run-XXX/<domain-slug>
    git-worktree.ts                       # add / remove worktree
    domain-lock.ts                        # locks/<domain>.lock の取得/解放
  git/
    git-cli.ts                            # spawn ラッパ (stdout, stderr, exitCode)
    diff.ts                               # name-only / 完全 patch 取得
  codex/
    codex-exec-runner.ts                  # interface CodexExecRunner
    codex-cli-runner.ts                   # 実機 codex CLI を spawn
    fake-codex-runner.ts                  # テスト用 fake
    prompt-builder.ts                     # goal + policy → markdown prompt
  logging/
    run-log.ts                            # runs/<id>/ 作成と meta.json 書き込み
    events.ts                             # events.jsonl append-only writer
    artifacts.ts                          # 任意ファイル保存 helper
  reporter/
    summary.ts                            # summary.md 生成
    knowledge-candidates.ts               # knowledge-candidates.yaml 生成
  config/
    paths.ts                              # harness 内パス定数 (runs/, workspaces/, locks/)

policies/
  global.yaml                             # 設計書 §7.1 相当
  repos/
    sample-monorepo.yaml                  # 設計書 §7.2 相当（参考実装）

workflows/
  domain-coding.yaml                      # MVP は最小フィールドのみ

tests/
  fixtures/
    policies/                             # 正常/異常 YAML
    git-repos/                            # スクリプトで生成（コミットしない）
  unit/
    policy/
    workspace/
    git/
    reporter/
    codex/
    logging/
  integration/
    workflow-fake-codex.test.ts           # fake runner での E2E
```

**境界条件:**
- `runs/`, `workspaces/`, `locks/` は実行時生成物。`.gitignore` で除外。
- `policies/repos/sample-monorepo.yaml` は手動テスト用サンプル。
- 単体テストは fixture YAML / 一時 git repo（`os.tmpdir()` 配下）を使う。
- 実 `codex` CLI を叩く integration は `HARNESS_E2E_CODEX=1` 環境変数で gate（Task 16）。

---

## Phase 0 — Bootstrap

### Task 1: プロジェクト初期化

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `.npmrc`
- Create: `src/index.ts` (placeholder export)
- Create: `tests/unit/sanity.test.ts`

- [ ] **Step 1: `package.json` を作成**

```json
{
  "name": "monorepo-harness",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "bin": {
    "harness": "./dist/cli/run.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "harness": "tsx src/cli/run.ts"
  },
  "dependencies": {
    "commander": "^12.1.0",
    "minimatch": "^10.0.1",
    "yaml": "^2.5.1",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "tsx": "^4.19.0",
    "typescript": "^5.5.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: `tsconfig.json` を作成**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: `vitest.config.ts` を作成**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    pool: "forks",
  },
});
```

- [ ] **Step 4: `.gitignore` を作成**

```gitignore
node_modules/
dist/
*.log

# run-time generated
runs/
workspaces/
locks/

# editor
.DS_Store
```

- [ ] **Step 5: `.npmrc` を作成**

```ini
save-exact=true
engine-strict=true
```

- [ ] **Step 6: 動作確認用 placeholder と sanity テストを作成**

`src/index.ts`:
```ts
export const HARNESS_NAME = "monorepo-harness";
```

`tests/unit/sanity.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { HARNESS_NAME } from "../../src/index.js";

describe("sanity", () => {
  it("exposes harness name", () => {
    expect(HARNESS_NAME).toBe("monorepo-harness");
  });
});
```

- [ ] **Step 7: 依存をインストールしテストを走らせる**

Run:
```bash
pnpm install
pnpm typecheck
pnpm test
```
Expected: `typecheck` がエラーなく終了、`vitest` で 1 test passed。

- [ ] **Step 8: コミット**

```bash
git add package.json pnpm-lock.yaml tsconfig.json vitest.config.ts .gitignore .npmrc src/index.ts tests/unit/sanity.test.ts
git commit -m "chore: bootstrap typescript harness project"
```

---

## Phase 1 — Policy (Milestone 1)

### Task 2: Policy schemas (Zod)

**Files:**
- Create: `src/policy/schema.ts`
- Test: `tests/unit/policy/schema.test.ts`

- [ ] **Step 1: 失敗テストを書く**

`tests/unit/policy/schema.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  GlobalPolicySchema,
  RepoPolicySchema,
} from "../../../src/policy/schema.js";

describe("GlobalPolicySchema", () => {
  it("parses a minimal global policy", () => {
    const parsed = GlobalPolicySchema.parse({
      always_deny_write: [".git/**"],
    });
    expect(parsed.always_deny_write).toContain(".git/**");
  });

  it("rejects unknown top-level keys", () => {
    expect(() =>
      GlobalPolicySchema.parse({ always_deny_write: [], extra: 1 }),
    ).toThrow();
  });
});

describe("RepoPolicySchema", () => {
  it("parses a repo policy with one domain", () => {
    const parsed = RepoPolicySchema.parse({
      repo_id: "sample-monorepo",
      read: ["README.md"],
      domains: {
        "apps/user": {
          read: ["apps/user/**"],
          write: ["apps/user/**"],
          deny_write: ["packages/shared/**"],
        },
      },
    });
    expect(parsed.domains["apps/user"]?.write).toEqual(["apps/user/**"]);
  });

  it("requires repo_id", () => {
    expect(() => RepoPolicySchema.parse({ domains: {} })).toThrow();
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `pnpm test tests/unit/policy/schema.test.ts`
Expected: import 解決失敗で FAIL。

- [ ] **Step 3: 最小実装**

`src/policy/schema.ts`:
```ts
import { z } from "zod";

const Glob = z.string().min(1);

export const GlobalPolicySchema = z
  .object({
    defaults: z
      .object({
        codex: z
          .object({
            sandbox: z.string().optional(),
            approval: z.string().optional(),
          })
          .optional(),
      })
      .optional(),
    always_deny_write: z.array(Glob).default([]),
    commands: z
      .object({
        default_allow: z.array(z.string()).default([]),
      })
      .optional(),
  })
  .strict();
export type GlobalPolicy = z.infer<typeof GlobalPolicySchema>;

export const DomainPolicySchema = z
  .object({
    read: z.array(Glob).default([]),
    write: z.array(Glob).default([]),
    deny_write: z.array(Glob).default([]),
    commands: z
      .object({
        allow: z.array(z.string()).default([]),
      })
      .optional(),
  })
  .strict();
export type DomainPolicy = z.infer<typeof DomainPolicySchema>;

export const RepoPolicySchema = z
  .object({
    repo_id: z.string().min(1),
    read: z.array(Glob).default([]),
    domains: z.record(z.string(), DomainPolicySchema),
  })
  .strict();
export type RepoPolicy = z.infer<typeof RepoPolicySchema>;

export interface ResolvedPolicy {
  repoId: string;
  domain: string;
  read: string[];
  write: string[];
  denyWrite: string[];
  allowedCommands: string[];
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm test tests/unit/policy/schema.test.ts`
Expected: 4 tests passed。

- [ ] **Step 5: コミット**

```bash
git add src/policy/schema.ts tests/unit/policy/schema.test.ts
git commit -m "feat(policy): add zod schemas for global/repo/domain policies"
```

---

### Task 3: Policy loader (YAML)

**Files:**
- Create: `src/policy/loader.ts`
- Create: `tests/fixtures/policies/global.ok.yaml`
- Create: `tests/fixtures/policies/repo.ok.yaml`
- Create: `tests/fixtures/policies/repo.bad.yaml`
- Test: `tests/unit/policy/loader.test.ts`

- [ ] **Step 1: fixture を作成**

`tests/fixtures/policies/global.ok.yaml`:
```yaml
always_deny_write:
  - .git/**
  - package.json
```

`tests/fixtures/policies/repo.ok.yaml`:
```yaml
repo_id: sample-monorepo
read:
  - README.md
domains:
  apps/user:
    read: [apps/user/**]
    write: [apps/user/**]
    deny_write: [packages/shared/**]
```

`tests/fixtures/policies/repo.bad.yaml`:
```yaml
domains: {}
```

- [ ] **Step 2: 失敗テストを書く**

`tests/unit/policy/loader.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  loadGlobalPolicy,
  loadRepoPolicy,
} from "../../../src/policy/loader.js";

const FIX = (n: string) => join(__dirname, "../../fixtures/policies", n);

describe("loadGlobalPolicy", () => {
  it("loads a valid YAML", async () => {
    const p = await loadGlobalPolicy(FIX("global.ok.yaml"));
    expect(p.always_deny_write).toContain(".git/**");
  });
});

describe("loadRepoPolicy", () => {
  it("loads a valid repo policy", async () => {
    const p = await loadRepoPolicy(FIX("repo.ok.yaml"));
    expect(p.repo_id).toBe("sample-monorepo");
  });

  it("throws on invalid YAML (missing repo_id)", async () => {
    await expect(loadRepoPolicy(FIX("repo.bad.yaml"))).rejects.toThrow(
      /repo_id/,
    );
  });
});
```

- [ ] **Step 3: 失敗を確認**

Run: `pnpm test tests/unit/policy/loader.test.ts`
Expected: import 失敗で FAIL。

- [ ] **Step 4: 実装**

`src/policy/loader.ts`:
```ts
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import {
  GlobalPolicySchema,
  RepoPolicySchema,
  type GlobalPolicy,
  type RepoPolicy,
} from "./schema.js";

export async function loadGlobalPolicy(path: string): Promise<GlobalPolicy> {
  const raw = await readFile(path, "utf8");
  const parsed = parseYaml(raw);
  return GlobalPolicySchema.parse(parsed ?? {});
}

export async function loadRepoPolicy(path: string): Promise<RepoPolicy> {
  const raw = await readFile(path, "utf8");
  const parsed = parseYaml(raw);
  return RepoPolicySchema.parse(parsed);
}
```

- [ ] **Step 5: テスト合格を確認**

Run: `pnpm test tests/unit/policy/loader.test.ts`
Expected: 3 tests passed。

- [ ] **Step 6: コミット**

```bash
git add src/policy/loader.ts tests/fixtures/policies/ tests/unit/policy/loader.test.ts
git commit -m "feat(policy): load global/repo policies from YAML with zod validation"
```

---

### Task 4: Policy resolver

**Files:**
- Create: `src/policy/resolver.ts`
- Test: `tests/unit/policy/resolver.test.ts`

- [ ] **Step 1: 失敗テストを書く**

`tests/unit/policy/resolver.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { resolvePolicy } from "../../../src/policy/resolver.js";

const GLOBAL = {
  always_deny_write: [".git/**", "package.json"],
};

const REPO = {
  repo_id: "sample-monorepo",
  read: ["README.md"],
  domains: {
    "apps/user": {
      read: ["apps/user/**", "docs/**"],
      write: ["apps/user/**"],
      deny_write: ["apps/admin/**"],
      commands: { allow: ["pnpm test"] },
    },
  },
} as const;

describe("resolvePolicy", () => {
  it("merges global deny_write with domain deny_write", () => {
    const r = resolvePolicy(GLOBAL, REPO as never, "apps/user");
    expect(r.denyWrite).toEqual(
      expect.arrayContaining([".git/**", "package.json", "apps/admin/**"]),
    );
  });

  it("returns read = repo.read ∪ domain.read", () => {
    const r = resolvePolicy(GLOBAL, REPO as never, "apps/user");
    expect(r.read).toEqual(
      expect.arrayContaining(["README.md", "apps/user/**", "docs/**"]),
    );
  });

  it("throws when domain is missing", () => {
    expect(() =>
      resolvePolicy(GLOBAL, REPO as never, "apps/missing"),
    ).toThrow(/domain.*apps\/missing/);
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `pnpm test tests/unit/policy/resolver.test.ts`
Expected: FAIL（resolver 未実装）。

- [ ] **Step 3: 実装**

`src/policy/resolver.ts`:
```ts
import type {
  GlobalPolicy,
  RepoPolicy,
  ResolvedPolicy,
} from "./schema.js";

export function resolvePolicy(
  global: GlobalPolicy,
  repo: RepoPolicy,
  domain: string,
): ResolvedPolicy {
  const d = repo.domains[domain];
  if (!d) {
    throw new Error(`policy: domain "${domain}" not found in repo "${repo.repo_id}"`);
  }
  return {
    repoId: repo.repo_id,
    domain,
    read: uniq([...repo.read, ...d.read]),
    write: uniq(d.write),
    denyWrite: uniq([...(global.always_deny_write ?? []), ...d.deny_write]),
    allowedCommands: uniq(d.commands?.allow ?? []),
  };
}

function uniq<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}
```

- [ ] **Step 4: テスト合格を確認**

Run: `pnpm test tests/unit/policy/resolver.test.ts`
Expected: 3 tests passed。

- [ ] **Step 5: コミット**

```bash
git add src/policy/resolver.ts tests/unit/policy/resolver.test.ts
git commit -m "feat(policy): resolve global+repo+domain into a single ResolvedPolicy"
```

---

### Task 5: Path policy validator

**Files:**
- Create: `src/policy/path-policy-validator.ts`
- Test: `tests/unit/policy/path-policy-validator.test.ts`

- [ ] **Step 1: 失敗テストを書く**

`tests/unit/policy/path-policy-validator.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  validateChangedPaths,
  type ValidationResult,
} from "../../../src/policy/path-policy-validator.js";
import type { ResolvedPolicy } from "../../../src/policy/schema.js";

const POLICY: ResolvedPolicy = {
  repoId: "sample",
  domain: "apps/user",
  read: [],
  write: ["apps/user/**"],
  denyWrite: ["packages/shared/**", "package.json"],
  allowedCommands: [],
};

describe("validateChangedPaths", () => {
  it("accepts changes only inside write scope", () => {
    const r = validateChangedPaths(POLICY, [
      "apps/user/src/profile.ts",
      "apps/user/test/profile.test.ts",
    ]);
    expect(r.status).toBe("allowed");
  });

  it("rejects changes that hit deny_write", () => {
    const r = validateChangedPaths(POLICY, [
      "apps/user/src/profile.ts",
      "package.json",
    ]);
    expect(r.status).toBe("denied");
    expect(r.violations).toEqual([
      { path: "package.json", reason: "deny_write" },
    ]);
  });

  it("rejects changes outside write scope", () => {
    const r = validateChangedPaths(POLICY, ["apps/admin/foo.ts"]);
    expect(r.status).toBe("denied");
    expect(r.violations[0]?.reason).toBe("not_in_write_scope");
  });

  it("treats deny_write as higher priority than write", () => {
    const policy: ResolvedPolicy = {
      ...POLICY,
      write: ["**"],
      denyWrite: ["package.json"],
    };
    const r = validateChangedPaths(policy, ["package.json"]);
    expect(r.status).toBe("denied");
    expect(r.violations[0]?.reason).toBe("deny_write");
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `pnpm test tests/unit/policy/path-policy-validator.test.ts`
Expected: FAIL。

- [ ] **Step 3: 実装**

`src/policy/path-policy-validator.ts`:
```ts
import { minimatch } from "minimatch";
import type { ResolvedPolicy } from "./schema.js";

export interface Violation {
  path: string;
  reason: "deny_write" | "not_in_write_scope";
}

export interface ValidationResult {
  status: "allowed" | "denied";
  violations: Violation[];
}

const MATCH_OPTS = { dot: true, nocomment: true } as const;

export function validateChangedPaths(
  policy: ResolvedPolicy,
  changedPaths: readonly string[],
): ValidationResult {
  const violations: Violation[] = [];
  for (const p of changedPaths) {
    if (policy.denyWrite.some((g) => minimatch(p, g, MATCH_OPTS))) {
      violations.push({ path: p, reason: "deny_write" });
      continue;
    }
    if (!policy.write.some((g) => minimatch(p, g, MATCH_OPTS))) {
      violations.push({ path: p, reason: "not_in_write_scope" });
    }
  }
  return { status: violations.length === 0 ? "allowed" : "denied", violations };
}
```

- [ ] **Step 4: テスト合格を確認**

Run: `pnpm test tests/unit/policy/path-policy-validator.test.ts`
Expected: 4 tests passed。

- [ ] **Step 5: コミット**

```bash
git add src/policy/path-policy-validator.ts tests/unit/policy/path-policy-validator.test.ts
git commit -m "feat(policy): validate changed paths against write/deny_write rules"
```

---

## Phase 2 — CLI 雛形 (Milestone 1 続き)

### Task 6: CLI 引数パース

**Files:**
- Create: `src/cli/parse-args.ts`
- Test: `tests/unit/cli/parse-args.test.ts`

- [ ] **Step 1: 失敗テストを書く**

`tests/unit/cli/parse-args.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseArgs } from "../../../src/cli/parse-args.js";

const BASE = [
  "--repo",
  "../target",
  "--repo-id",
  "sample-monorepo",
  "--domain",
  "apps/user",
  "--goal",
  "add validation",
];

describe("parseArgs", () => {
  it("parses required flags", () => {
    const o = parseArgs(BASE);
    expect(o).toMatchObject({
      repo: "../target",
      repoId: "sample-monorepo",
      domain: "apps/user",
      goal: "add validation",
      baseBranch: "main",
      keepWorktree: false,
      dryRun: false,
    });
  });

  it("supports --base-branch / --keep-worktree / --dry-run", () => {
    const o = parseArgs([
      ...BASE,
      "--base-branch",
      "develop",
      "--keep-worktree",
      "--dry-run",
    ]);
    expect(o.baseBranch).toBe("develop");
    expect(o.keepWorktree).toBe(true);
    expect(o.dryRun).toBe(true);
  });

  it("throws when --domain is missing", () => {
    expect(() =>
      parseArgs(["--repo", "x", "--repo-id", "y", "--goal", "z"]),
    ).toThrow();
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `pnpm test tests/unit/cli/parse-args.test.ts`
Expected: FAIL。

- [ ] **Step 3: 実装**

`src/cli/parse-args.ts`:
```ts
import { Command } from "commander";

export interface ParsedArgs {
  repo: string;
  repoId: string;
  domain: string;
  goal: string;
  baseBranch: string;
  keepWorktree: boolean;
  dryRun: boolean;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const cmd = new Command()
    .name("harness")
    .exitOverride()
    .requiredOption("--repo <path>", "target repo path")
    .requiredOption("--repo-id <id>", "repo identifier for policy resolution")
    .requiredOption("--domain <domain>", "target domain (e.g. apps/user)")
    .requiredOption("--goal <text>", "task goal passed to Codex")
    .option("--base-branch <name>", "base branch", "main")
    .option("--keep-worktree", "keep worktree after run", false)
    .option("--dry-run", "resolve policy and exit", false);

  cmd.parse(argv, { from: "user" });
  const o = cmd.opts<{
    repo: string;
    repoId: string;
    domain: string;
    goal: string;
    baseBranch: string;
    keepWorktree: boolean;
    dryRun: boolean;
  }>();
  return {
    repo: o.repo,
    repoId: o.repoId,
    domain: o.domain,
    goal: o.goal,
    baseBranch: o.baseBranch,
    keepWorktree: Boolean(o.keepWorktree),
    dryRun: Boolean(o.dryRun),
  };
}
```

- [ ] **Step 4: テスト合格を確認**

Run: `pnpm test tests/unit/cli/parse-args.test.ts`
Expected: 3 tests passed。

- [ ] **Step 5: コミット**

```bash
git add src/cli/parse-args.ts tests/unit/cli/parse-args.test.ts
git commit -m "feat(cli): parse harness run arguments via commander"
```

---

### Task 7: Harness paths と config

**Files:**
- Create: `src/config/paths.ts`
- Test: `tests/unit/config/paths.test.ts`

- [ ] **Step 1: 失敗テストを書く**

`tests/unit/config/paths.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { harnessPaths } from "../../../src/config/paths.js";

describe("harnessPaths", () => {
  it("returns absolute paths under a given root", () => {
    const p = harnessPaths("/tmp/h");
    expect(p.runsDir).toBe("/tmp/h/runs");
    expect(p.workspacesDir).toBe("/tmp/h/workspaces");
    expect(p.locksDir).toBe("/tmp/h/locks");
    expect(p.policiesDir).toBe("/tmp/h/policies");
  });

  it("resolves repo policy path by id", () => {
    const p = harnessPaths("/tmp/h");
    expect(p.repoPolicyPath("sample-monorepo")).toBe(
      "/tmp/h/policies/repos/sample-monorepo.yaml",
    );
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `pnpm test tests/unit/config/paths.test.ts`
Expected: FAIL。

- [ ] **Step 3: 実装**

`src/config/paths.ts`:
```ts
import { join } from "node:path";

export interface HarnessPaths {
  root: string;
  runsDir: string;
  workspacesDir: string;
  locksDir: string;
  policiesDir: string;
  globalPolicyPath: string;
  repoPolicyPath: (repoId: string) => string;
}

export function harnessPaths(root: string): HarnessPaths {
  const policiesDir = join(root, "policies");
  return {
    root,
    runsDir: join(root, "runs"),
    workspacesDir: join(root, "workspaces"),
    locksDir: join(root, "locks"),
    policiesDir,
    globalPolicyPath: join(policiesDir, "global.yaml"),
    repoPolicyPath: (id) => join(policiesDir, "repos", `${id}.yaml`),
  };
}
```

- [ ] **Step 4: テスト合格を確認**

Run: `pnpm test tests/unit/config/paths.test.ts`
Expected: 2 tests passed。

- [ ] **Step 5: コミット**

```bash
git add src/config/paths.ts tests/unit/config/paths.test.ts
git commit -m "feat(config): centralize harness directory paths"
```

---

### Task 8: 初期 policy ファイル（global.yaml + sample repo）

**Files:**
- Create: `policies/global.yaml`
- Create: `policies/repos/sample-monorepo.yaml`
- Create: `workflows/domain-coding.yaml`

- [ ] **Step 1: `policies/global.yaml`**

設計書 §7.1 をそのまま使う：
```yaml
defaults:
  codex:
    sandbox: workspace-write
    approval: on-request

always_deny_write:
  - .git/**
  - .github/**
  - package.json
  - pnpm-lock.yaml
  - yarn.lock
  - package-lock.json
  - turbo.json
  - nx.json
  - tsconfig.base.json
  - packages/shared/**
  - .harness/**
  - .policies/**

commands:
  default_allow: []
```

- [ ] **Step 2: `policies/repos/sample-monorepo.yaml`**

設計書 §7.2 をそのまま使う：
```yaml
repo_id: sample-monorepo
read:
  - README.md
  - docs/**
  - package.json
  - tsconfig.base.json
  - packages/contracts/**
  - packages/shared/**

domains:
  apps/user:
    read:
      - apps/user/**
      - docs/**
      - packages/contracts/**
      - package.json
      - tsconfig.base.json
    write:
      - apps/user/**
    deny_write:
      - apps/admin/**
      - apps/foo/**
      - packages/shared/**
      - packages/contracts/**
      - package.json
      - pnpm-lock.yaml
    commands:
      allow: []
```

- [ ] **Step 3: `workflows/domain-coding.yaml` (MVP の placeholder)**

```yaml
name: domain-coding
description: |
  MVP domain-coding workflow. Steps are hardcoded in workflow-runner.ts;
  this file exists for forward-compatibility.
```

- [ ] **Step 4: 既存 schema で読めることを確認**

Run:
```bash
node --input-type=module -e "
import('./node_modules/yaml/dist/index.js').then(async ({ parse }) => {
  const { readFile } = await import('node:fs/promises');
  const g = parse(await readFile('policies/global.yaml', 'utf8'));
  const r = parse(await readFile('policies/repos/sample-monorepo.yaml', 'utf8'));
  console.log(JSON.stringify({ g, r }, null, 2));
});
"
```
Expected: それぞれ JSON で出力され、`repo_id: 'sample-monorepo'` を含む。

- [ ] **Step 5: コミット**

```bash
git add policies/ workflows/
git commit -m "feat(policy): add initial global policy and sample repo policy"
```

---

## Phase 3 — Run スキャフォールド (Milestone 2 前半)

### Task 9: run_id 生成

**Files:**
- Create: `src/core/run-id.ts`
- Test: `tests/unit/core/run-id.test.ts`

- [ ] **Step 1: 失敗テストを書く**

`tests/unit/core/run-id.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextRunId } from "../../../src/core/run-id.js";

describe("nextRunId", () => {
  it("returns 001 when runs dir is empty", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-"));
    const id = nextRunId(root, new Date("2026-05-20T00:00:00Z"));
    expect(id).toBe("run-20260520-001");
  });

  it("increments past existing entries for the same day", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-"));
    mkdirSync(join(root, "run-20260520-001"));
    mkdirSync(join(root, "run-20260520-002"));
    mkdirSync(join(root, "run-20260519-099"));
    const id = nextRunId(root, new Date("2026-05-20T12:00:00Z"));
    expect(id).toBe("run-20260520-003");
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `pnpm test tests/unit/core/run-id.test.ts`
Expected: FAIL。

- [ ] **Step 3: 実装**

`src/core/run-id.ts`:
```ts
import { readdirSync, existsSync } from "node:fs";

export function nextRunId(runsDir: string, now: Date = new Date()): string {
  const yyyy = now.getUTCFullYear().toString().padStart(4, "0");
  const mm = (now.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = now.getUTCDate().toString().padStart(2, "0");
  const day = `${yyyy}${mm}${dd}`;
  const prefix = `run-${day}-`;
  const existing = existsSync(runsDir)
    ? readdirSync(runsDir).filter((e) => e.startsWith(prefix))
    : [];
  const max = existing
    .map((e) => Number.parseInt(e.slice(prefix.length), 10))
    .filter((n) => Number.isFinite(n))
    .reduce((a, b) => Math.max(a, b), 0);
  const next = (max + 1).toString().padStart(3, "0");
  return `${prefix}${next}`;
}
```

- [ ] **Step 4: テスト合格を確認**

Run: `pnpm test tests/unit/core/run-id.test.ts`
Expected: 2 tests passed。

- [ ] **Step 5: コミット**

```bash
git add src/core/run-id.ts tests/unit/core/run-id.test.ts
git commit -m "feat(core): generate sequential run-YYYYMMDD-NNN ids"
```

---

### Task 10: run log (meta.json + events.jsonl)

**Files:**
- Create: `src/logging/events.ts`
- Create: `src/logging/run-log.ts`
- Create: `src/logging/artifacts.ts`
- Test: `tests/unit/logging/run-log.test.ts`

- [ ] **Step 1: 失敗テストを書く**

`tests/unit/logging/run-log.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunLog } from "../../../src/logging/run-log.js";

describe("createRunLog", () => {
  it("creates run dir and writes meta.json + first event", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-"));
    const log = await createRunLog({
      runsDir: root,
      runId: "run-20260520-001",
      meta: {
        runId: "run-20260520-001",
        repoId: "sample-monorepo",
        repoPath: "/tmp/repo",
        domain: "apps/user",
        workflow: "domain-coding",
        baseBranch: "main",
        runBranch: "harness/run-20260520-001/apps-user",
        status: "running",
        startedAt: "2026-05-20T00:00:00.000Z",
      },
    });
    expect(existsSync(log.runDir)).toBe(true);
    const meta = JSON.parse(readFileSync(join(log.runDir, "meta.json"), "utf8"));
    expect(meta.runId).toBe("run-20260520-001");

    await log.emit({ type: "run_started", runId: "run-20260520-001" });
    const events = readFileSync(join(log.runDir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(events[0]).toEqual({
      type: "run_started",
      runId: "run-20260520-001",
    });
  });

  it("updates meta.status on finalize", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-"));
    const log = await createRunLog({
      runsDir: root,
      runId: "run-20260520-002",
      meta: {
        runId: "run-20260520-002",
        repoId: "x",
        repoPath: "/tmp",
        domain: "d",
        workflow: "domain-coding",
        baseBranch: "main",
        runBranch: "b",
        status: "running",
        startedAt: "2026-05-20T00:00:00.000Z",
      },
    });
    await log.finalize({ status: "success", finishedAt: "2026-05-20T01:00:00.000Z" });
    const meta = JSON.parse(readFileSync(join(log.runDir, "meta.json"), "utf8"));
    expect(meta.status).toBe("success");
    expect(meta.finishedAt).toBe("2026-05-20T01:00:00.000Z");
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `pnpm test tests/unit/logging/run-log.test.ts`
Expected: FAIL。

- [ ] **Step 3: events writer 実装**

`src/logging/events.ts`:
```ts
import { appendFile } from "node:fs/promises";

export type RunEvent = { type: string } & Record<string, unknown>;

export function makeEventWriter(eventsPath: string) {
  return async (event: RunEvent): Promise<void> => {
    await appendFile(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
  };
}
```

- [ ] **Step 4: artifacts helper**

`src/logging/artifacts.ts`:
```ts
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export async function writeArtifact(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, "utf8");
}
```

- [ ] **Step 5: run-log 実装**

`src/logging/run-log.ts`:
```ts
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeEventWriter, type RunEvent } from "./events.js";

export interface RunMeta {
  runId: string;
  repoId: string;
  repoPath: string;
  domain: string;
  workflow: string;
  baseBranch: string;
  runBranch: string;
  status: "running" | "success" | "failed-policy-violation" | "failed-codex" | "failed-command" | "failed-internal-error";
  startedAt: string;
  finishedAt?: string;
}

export interface RunLog {
  runDir: string;
  emit(event: RunEvent): Promise<void>;
  finalize(p: { status: RunMeta["status"]; finishedAt: string }): Promise<void>;
}

export async function createRunLog(opts: {
  runsDir: string;
  runId: string;
  meta: RunMeta;
}): Promise<RunLog> {
  const runDir = join(opts.runsDir, opts.runId);
  await mkdir(runDir, { recursive: true });
  const metaPath = join(runDir, "meta.json");
  await writeFile(metaPath, `${JSON.stringify(opts.meta, null, 2)}\n`, "utf8");
  const emit = makeEventWriter(join(runDir, "events.jsonl"));
  return {
    runDir,
    emit,
    async finalize({ status, finishedAt }) {
      const current = JSON.parse(await readFile(metaPath, "utf8")) as RunMeta;
      const next: RunMeta = { ...current, status, finishedAt };
      await writeFile(metaPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    },
  };
}
```

- [ ] **Step 6: テスト合格を確認**

Run: `pnpm test tests/unit/logging/run-log.test.ts`
Expected: 2 tests passed。

- [ ] **Step 7: コミット**

```bash
git add src/logging/ tests/unit/logging/
git commit -m "feat(logging): create run directory with meta.json and events.jsonl"
```

---

## Phase 4 — Git / Worktree (Milestone 2 後半)

### Task 11: Git CLI ラッパ

**Files:**
- Create: `src/git/git-cli.ts`
- Test: `tests/unit/git/git-cli.test.ts`

- [ ] **Step 1: 失敗テストを書く**

`tests/unit/git/git-cli.test.ts`:
```ts
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { gitCli } from "../../../src/git/git-cli.js";

let repoRoot: string;

beforeAll(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "harness-git-"));
  const r = (args: string[]) =>
    execFileSync("git", args, { cwd: repoRoot, stdio: "ignore" });
  r(["init", "-q", "-b", "main"]);
  r(["config", "user.email", "test@example.com"]);
  r(["config", "user.name", "Test"]);
  writeFileSync(join(repoRoot, "README.md"), "hi\n");
  r(["add", "."]);
  r(["commit", "-qm", "init"]);
});

describe("gitCli", () => {
  it("runs `git rev-parse --abbrev-ref HEAD`", async () => {
    const { stdout, exitCode } = await gitCli(["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoRoot,
    });
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("main");
  });

  it("captures stderr and non-zero exit on failure", async () => {
    const r = await gitCli(["rev-parse", "--abbrev-ref", "no-such-ref"], {
      cwd: repoRoot,
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/unknown|fatal|ambiguous/i);
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `pnpm test tests/unit/git/git-cli.test.ts`
Expected: FAIL。

- [ ] **Step 3: 実装**

`src/git/git-cli.ts`:
```ts
import { spawn } from "node:child_process";

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GitOpts {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export function gitCli(args: readonly string[], opts: GitOpts): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args as string[], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
  });
}

export async function gitCliOrThrow(args: readonly string[], opts: GitOpts): Promise<string> {
  const r = await gitCli(args, opts);
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${r.exitCode}): ${r.stderr.trim()}`);
  }
  return r.stdout;
}
```

- [ ] **Step 4: テスト合格を確認**

Run: `pnpm test tests/unit/git/git-cli.test.ts`
Expected: 2 tests passed。

- [ ] **Step 5: コミット**

```bash
git add src/git/git-cli.ts tests/unit/git/git-cli.test.ts
git commit -m "feat(git): wrap `git` invocation as an async helper"
```

---

### Task 12: Branch name 生成

**Files:**
- Create: `src/workspace/branch-name.ts`
- Test: `tests/unit/workspace/branch-name.test.ts`

- [ ] **Step 1: 失敗テストを書く**

`tests/unit/workspace/branch-name.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { runBranchName } from "../../../src/workspace/branch-name.js";

describe("runBranchName", () => {
  it("uses harness/run-<id>/<domain-slug> format", () => {
    expect(runBranchName("run-20260520-001", "apps/user")).toBe(
      "harness/run-20260520-001/apps-user",
    );
  });

  it("slugifies disallowed characters", () => {
    expect(runBranchName("run-20260520-002", "Apps/User Profile")).toBe(
      "harness/run-20260520-002/apps-user-profile",
    );
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `pnpm test tests/unit/workspace/branch-name.test.ts`
Expected: FAIL。

- [ ] **Step 3: 実装**

`src/workspace/branch-name.ts`:
```ts
export function runBranchName(runId: string, domain: string): string {
  const slug = domain
    .toLowerCase()
    .replace(/[^a-z0-9/]+/g, "-")
    .replace(/\//g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `harness/${runId}/${slug}`;
}
```

- [ ] **Step 4: テスト合格を確認**

Run: `pnpm test tests/unit/workspace/branch-name.test.ts`
Expected: 2 tests passed。

- [ ] **Step 5: コミット**

```bash
git add src/workspace/branch-name.ts tests/unit/workspace/branch-name.test.ts
git commit -m "feat(workspace): derive run branch name from run id and domain"
```

---

### Task 13: Git worktree マネージャ

**Files:**
- Create: `src/workspace/git-worktree.ts`
- Test: `tests/integration/git-worktree.test.ts`

- [ ] **Step 1: 失敗テストを書く**

`tests/integration/git-worktree.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorktree,
  removeWorktree,
} from "../../src/workspace/git-worktree.js";

let repoRoot: string;
let worktreesDir: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "harness-src-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "harness-wt-"));
  const r = (args: string[]) =>
    execFileSync("git", args, { cwd: repoRoot, stdio: "ignore" });
  r(["init", "-q", "-b", "main"]);
  r(["config", "user.email", "t@e.com"]);
  r(["config", "user.name", "T"]);
  writeFileSync(join(repoRoot, "f.txt"), "x");
  r(["add", "."]);
  r(["commit", "-qm", "init"]);
});

describe("createWorktree / removeWorktree", () => {
  it("creates a worktree on a new branch from baseBranch", async () => {
    const wt = await createWorktree({
      repoPath: repoRoot,
      worktreesDir,
      runId: "run-1",
      branch: "harness/run-1/x",
      baseBranch: "main",
    });
    expect(existsSync(wt.path)).toBe(true);
    expect(existsSync(join(wt.path, "f.txt"))).toBe(true);
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: wt.path,
    })
      .toString()
      .trim();
    expect(branch).toBe("harness/run-1/x");
  });

  it("removes worktree and prunes the branch on cleanup", async () => {
    const wt = await createWorktree({
      repoPath: repoRoot,
      worktreesDir,
      runId: "run-2",
      branch: "harness/run-2/x",
      baseBranch: "main",
    });
    await removeWorktree({ repoPath: repoRoot, worktreePath: wt.path, branch: wt.branch });
    expect(existsSync(wt.path)).toBe(false);
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `pnpm test tests/integration/git-worktree.test.ts`
Expected: FAIL。

- [ ] **Step 3: 実装**

`src/workspace/git-worktree.ts`:
```ts
import { join } from "node:path";
import { gitCliOrThrow, gitCli } from "../git/git-cli.js";

export interface WorktreeCreateOpts {
  repoPath: string;
  worktreesDir: string;
  runId: string;
  branch: string;
  baseBranch: string;
}

export interface Worktree {
  path: string;
  branch: string;
}

export async function createWorktree(opts: WorktreeCreateOpts): Promise<Worktree> {
  const wtPath = join(opts.worktreesDir, opts.runId, "repo");
  await gitCliOrThrow(
    ["worktree", "add", "-b", opts.branch, wtPath, opts.baseBranch],
    { cwd: opts.repoPath },
  );
  return { path: wtPath, branch: opts.branch };
}

export interface WorktreeRemoveOpts {
  repoPath: string;
  worktreePath: string;
  branch: string;
}

export async function removeWorktree(opts: WorktreeRemoveOpts): Promise<void> {
  // best-effort: remove worktree, then delete the branch.
  const removed = await gitCli(["worktree", "remove", "--force", opts.worktreePath], {
    cwd: opts.repoPath,
  });
  if (removed.exitCode !== 0) {
    throw new Error(`worktree remove failed: ${removed.stderr.trim()}`);
  }
  await gitCli(["branch", "-D", opts.branch], { cwd: opts.repoPath });
}
```

- [ ] **Step 4: テスト合格を確認**

Run: `pnpm test tests/integration/git-worktree.test.ts`
Expected: 2 tests passed。

- [ ] **Step 5: コミット**

```bash
git add src/workspace/git-worktree.ts tests/integration/git-worktree.test.ts
git commit -m "feat(workspace): create/remove git worktrees for run isolation"
```

---

### Task 14: Domain lock

**Files:**
- Create: `src/workspace/domain-lock.ts`
- Test: `tests/unit/workspace/domain-lock.test.ts`

- [ ] **Step 1: 失敗テストを書く**

`tests/unit/workspace/domain-lock.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireDomainLock } from "../../../src/workspace/domain-lock.js";

describe("acquireDomainLock", () => {
  it("creates a lockfile and returns a release()", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-lock-"));
    const lock = await acquireDomainLock({
      locksDir: dir,
      domain: "apps/user",
      runId: "run-1",
    });
    expect(lock.path).toMatch(/apps-user\.lock$/);
    await lock.release();
  });

  it("rejects when the same domain is already locked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-lock-"));
    const first = await acquireDomainLock({
      locksDir: dir,
      domain: "apps/user",
      runId: "run-a",
    });
    await expect(
      acquireDomainLock({ locksDir: dir, domain: "apps/user", runId: "run-b" }),
    ).rejects.toThrow(/locked/);
    await first.release();
  });

  it("allows different domains concurrently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-lock-"));
    const a = await acquireDomainLock({
      locksDir: dir,
      domain: "apps/user",
      runId: "run-a",
    });
    const b = await acquireDomainLock({
      locksDir: dir,
      domain: "apps/admin",
      runId: "run-b",
    });
    await a.release();
    await b.release();
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `pnpm test tests/unit/workspace/domain-lock.test.ts`
Expected: FAIL。

- [ ] **Step 3: 実装**

`src/workspace/domain-lock.ts`:
```ts
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

export interface DomainLock {
  path: string;
  release: () => Promise<void>;
}

export interface AcquireOpts {
  locksDir: string;
  domain: string;
  runId: string;
}

function domainLockName(domain: string): string {
  return `${domain.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase()}.lock`;
}

export async function acquireDomainLock(opts: AcquireOpts): Promise<DomainLock> {
  await mkdir(opts.locksDir, { recursive: true });
  const path = join(opts.locksDir, domainLockName(opts.domain));
  try {
    // wx fails if exists -> proper exclusive lock
    await writeFile(
      path,
      JSON.stringify({ runId: opts.runId, acquiredAt: new Date().toISOString() }),
      { flag: "wx" },
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`domain "${opts.domain}" is already locked (${path})`);
    }
    throw e;
  }
  return {
    path,
    release: async () => {
      await rm(path, { force: true });
    },
  };
}
```

- [ ] **Step 4: テスト合格を確認**

Run: `pnpm test tests/unit/workspace/domain-lock.test.ts`
Expected: 3 tests passed。

- [ ] **Step 5: コミット**

```bash
git add src/workspace/domain-lock.ts tests/unit/workspace/domain-lock.test.ts
git commit -m "feat(workspace): exclusive per-domain lockfile"
```

---

## Phase 5 — Git diff (Milestone 4 の準備)

### Task 15: Diff collector

**Files:**
- Create: `src/git/diff.ts`
- Test: `tests/integration/git-diff.test.ts`

- [ ] **Step 1: 失敗テストを書く**

`tests/integration/git-diff.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectDiff } from "../../src/git/diff.js";

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "harness-diff-"));
  const r = (a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
  r(["init", "-q", "-b", "main"]);
  r(["config", "user.email", "t@e.com"]);
  r(["config", "user.name", "T"]);
  mkdirSync(join(repo, "apps/user"), { recursive: true });
  writeFileSync(join(repo, "apps/user/a.ts"), "export const a = 1;\n");
  r(["add", "."]);
  r(["commit", "-qm", "init"]);
});

describe("collectDiff", () => {
  it("returns changed file list and full patch for working tree changes", async () => {
    writeFileSync(join(repo, "apps/user/a.ts"), "export const a = 2;\n");
    writeFileSync(join(repo, "apps/user/b.ts"), "export const b = 1;\n");
    const d = await collectDiff({ repoPath: repo, baseBranch: "main" });
    expect(d.changedPaths.sort()).toEqual([
      "apps/user/a.ts",
      "apps/user/b.ts",
    ]);
    expect(d.patch).toMatch(/\+export const a = 2;/);
    expect(d.patch).toMatch(/apps\/user\/b\.ts/);
  });

  it("returns empty patch when there are no changes", async () => {
    const d = await collectDiff({ repoPath: repo, baseBranch: "main" });
    expect(d.changedPaths).toEqual([]);
    expect(d.patch).toBe("");
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `pnpm test tests/integration/git-diff.test.ts`
Expected: FAIL。

- [ ] **Step 3: 実装**

`src/git/diff.ts`:
```ts
import { gitCliOrThrow } from "./git-cli.js";

export interface DiffResult {
  changedPaths: string[];
  patch: string;
}

export interface DiffOpts {
  repoPath: string;
  baseBranch: string;
}

export async function collectDiff(opts: DiffOpts): Promise<DiffResult> {
  // include staged + unstaged + untracked, vs baseBranch HEAD.
  // We first add -N so untracked files appear in diff.
  await gitCliOrThrow(["add", "-N", "."], { cwd: opts.repoPath });
  const names = await gitCliOrThrow(
    ["diff", "--name-only", opts.baseBranch],
    { cwd: opts.repoPath },
  );
  const patch = await gitCliOrThrow(["diff", opts.baseBranch], {
    cwd: opts.repoPath,
  });
  const changedPaths = names
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return { changedPaths, patch };
}
```

- [ ] **Step 4: テスト合格を確認**

Run: `pnpm test tests/integration/git-diff.test.ts`
Expected: 2 tests passed。

- [ ] **Step 5: コミット**

```bash
git add src/git/diff.ts tests/integration/git-diff.test.ts
git commit -m "feat(git): collect changed paths and full diff against base branch"
```

---

## Phase 6 — Codex Exec (Milestone 3)

### Task 16: Prompt builder

**Files:**
- Create: `src/codex/prompt-builder.ts`
- Test: `tests/unit/codex/prompt-builder.test.ts`

- [ ] **Step 1: 失敗テストを書く**

`tests/unit/codex/prompt-builder.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildCodexPrompt } from "../../../src/codex/prompt-builder.js";
import type { ResolvedPolicy } from "../../../src/policy/schema.js";

const POLICY: ResolvedPolicy = {
  repoId: "sample",
  domain: "apps/user",
  read: ["apps/user/**", "docs/**"],
  write: ["apps/user/**"],
  denyWrite: ["package.json", "packages/shared/**"],
  allowedCommands: [],
};

describe("buildCodexPrompt", () => {
  it("includes goal, domain, write and deny lists", () => {
    const p = buildCodexPrompt({
      goal: "プロフィール更新APIに入力バリデーションを追加する",
      policy: POLICY,
    });
    expect(p).toMatch(/Goal:/);
    expect(p).toMatch(/プロフィール更新API/);
    expect(p).toMatch(/Target domain:\s*\n\s*apps\/user/);
    expect(p).toMatch(/apps\/user\/\*\*/);
    expect(p).toMatch(/package\.json/);
    expect(p).toMatch(/packages\/shared\/\*\*/);
  });

  it("includes a 'do not edit' section even when deny list is empty", () => {
    const p = buildCodexPrompt({
      goal: "x",
      policy: { ...POLICY, denyWrite: [] },
    });
    expect(p).toMatch(/Do not edit:/);
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `pnpm test tests/unit/codex/prompt-builder.test.ts`
Expected: FAIL。

- [ ] **Step 3: 実装**

`src/codex/prompt-builder.ts`:
```ts
import type { ResolvedPolicy } from "../policy/schema.js";

export interface PromptInputs {
  goal: string;
  policy: ResolvedPolicy;
}

export function buildCodexPrompt({ goal, policy }: PromptInputs): string {
  const writeList = policy.write.map((p) => `- ${p}`).join("\n") || "- (none)";
  const denyList = policy.denyWrite.map((p) => `- ${p}`).join("\n") || "- (none)";
  return [
    "You are working on a monorepo domain task.",
    "",
    "Goal:",
    goal,
    "",
    "Target domain:",
    policy.domain,
    "",
    "You may edit only:",
    writeList,
    "",
    "Do not edit:",
    denyList,
    "",
    "You may read surrounding files to understand conventions, but keep changes scoped to the writable domain.",
    "After completing the task, provide a short summary of changed files and rationale.",
    "",
  ].join("\n");
}
```

- [ ] **Step 4: テスト合格を確認**

Run: `pnpm test tests/unit/codex/prompt-builder.test.ts`
Expected: 2 tests passed。

- [ ] **Step 5: コミット**

```bash
git add src/codex/prompt-builder.ts tests/unit/codex/prompt-builder.test.ts
git commit -m "feat(codex): build prompt with goal, write scope, and deny list"
```

---

### Task 17: Codex exec runner interface + fake

**Files:**
- Create: `src/codex/codex-exec-runner.ts`
- Create: `src/codex/fake-codex-runner.ts`
- Test: `tests/unit/codex/fake-codex-runner.test.ts`

- [ ] **Step 1: 失敗テストを書く**

`tests/unit/codex/fake-codex-runner.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeCodexRunner } from "../../../src/codex/fake-codex-runner.js";

describe("fakeCodexRunner", () => {
  it("invokes the configured editor on the worktree and returns success", async () => {
    const wt = mkdtempSync(join(tmpdir(), "harness-fake-"));
    const runner = createFakeCodexRunner({
      edit: async (cwd) => {
        writeFileSync(join(cwd, "apps/user/profile.ts"), "ok", { flag: "w" });
      },
      stdout: "fake done\n",
    });
    // pre-create directory so the test edit can succeed
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(wt, "apps/user"), { recursive: true });

    const r = await runner.run({
      worktreePath: wt,
      prompt: "ignored",
      logPaths: {
        stdout: join(wt, "out.log"),
        stderr: join(wt, "err.log"),
      },
    });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(wt, "apps/user/profile.ts"))).toBe(true);
    expect(readFileSync(join(wt, "out.log"), "utf8")).toContain("fake done");
  });

  it("forwards an exit code when the fake fails", async () => {
    const wt = mkdtempSync(join(tmpdir(), "harness-fake-"));
    const runner = createFakeCodexRunner({
      edit: async () => {
        throw new Error("boom");
      },
      stderr: "boom\n",
      exitCode: 17,
    });
    const r = await runner.run({
      worktreePath: wt,
      prompt: "",
      logPaths: {
        stdout: join(wt, "out.log"),
        stderr: join(wt, "err.log"),
      },
    });
    expect(r.exitCode).toBe(17);
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `pnpm test tests/unit/codex/fake-codex-runner.test.ts`
Expected: FAIL。

- [ ] **Step 3: Interface 実装**

`src/codex/codex-exec-runner.ts`:
```ts
export interface CodexRunInputs {
  worktreePath: string;
  prompt: string;
  logPaths: {
    stdout: string;
    stderr: string;
  };
}

export interface CodexRunResult {
  exitCode: number;
}

export interface CodexExecRunner {
  run(inputs: CodexRunInputs): Promise<CodexRunResult>;
}
```

- [ ] **Step 4: Fake 実装**

`src/codex/fake-codex-runner.ts`:
```ts
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  CodexExecRunner,
  CodexRunInputs,
  CodexRunResult,
} from "./codex-exec-runner.js";

export interface FakeOpts {
  edit?: (cwd: string, prompt: string) => Promise<void>;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

export function createFakeCodexRunner(opts: FakeOpts = {}): CodexExecRunner {
  return {
    async run(input: CodexRunInputs): Promise<CodexRunResult> {
      let exitCode = opts.exitCode ?? 0;
      let stderr = opts.stderr ?? "";
      try {
        if (opts.edit) await opts.edit(input.worktreePath, input.prompt);
      } catch (e) {
        exitCode = opts.exitCode ?? 1;
        stderr += `${(e as Error).message}\n`;
      }
      await mkdir(dirname(input.logPaths.stdout), { recursive: true });
      await writeFile(input.logPaths.stdout, opts.stdout ?? "", "utf8");
      await writeFile(input.logPaths.stderr, stderr, "utf8");
      return { exitCode };
    },
  };
}
```

- [ ] **Step 5: テスト合格を確認**

Run: `pnpm test tests/unit/codex/fake-codex-runner.test.ts`
Expected: 2 tests passed。

- [ ] **Step 6: コミット**

```bash
git add src/codex/codex-exec-runner.ts src/codex/fake-codex-runner.ts tests/unit/codex/fake-codex-runner.test.ts
git commit -m "feat(codex): define CodexExecRunner interface and fake implementation"
```

---

### Task 18: 実 codex CLI ランナー（実機確認）

**Files:**
- Create: `src/codex/codex-cli-runner.ts`
- Test: `tests/integration/codex-cli-runner.test.ts`

> ⚠️ ここで Codex exec の正確な CLI 引数を確定する。事前確認の手順を Step 1 で実施する。

- [ ] **Step 1: 実機で `codex --help` を確認しメモを残す**

Run: `codex --help` （ローカルで実行）。
Expected: `codex exec` サブコマンドの引数、prompt の渡し方（stdin or `--prompt` か `--file` か）、終了コード規約を把握する。

メモ場所: 本タスクの実装コメントとして、確定した CLI 形式を `codex-cli-runner.ts` の冒頭にコメント 1〜2 行で残す（「WHY 非自明」基準を満たす情報のみ）。

- [ ] **Step 2: 失敗テストを書く（環境依存テスト）**

`tests/integration/codex-cli-runner.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexCliRunner } from "../../src/codex/codex-cli-runner.js";

const HAS_CODEX = process.env.HARNESS_E2E_CODEX === "1";

describe.skipIf(!HAS_CODEX)("codex-cli-runner (real codex)", () => {
  it("invokes codex exec and writes stdout/stderr logs", async () => {
    const wt = mkdtempSync(join(tmpdir(), "harness-codex-"));
    const runner = createCodexCliRunner({ codexBin: "codex" });
    const r = await runner.run({
      worktreePath: wt,
      prompt: "print 'hello'",
      logPaths: {
        stdout: join(wt, "out.log"),
        stderr: join(wt, "err.log"),
      },
    });
    expect(typeof r.exitCode).toBe("number");
  });
});
```

- [ ] **Step 3: 失敗を確認**

Run: `pnpm test tests/integration/codex-cli-runner.test.ts`
Expected: 環境変数未設定なので skip。`HARNESS_E2E_CODEX=1 pnpm test` で FAIL（モジュール未実装）。

- [ ] **Step 4: 実装**

`src/codex/codex-cli-runner.ts`:
```ts
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  CodexExecRunner,
  CodexRunInputs,
  CodexRunResult,
} from "./codex-exec-runner.js";

export interface CodexCliOpts {
  codexBin: string;
  // Step 1 で確定する形式に合わせて、ここでオプションを増減する。
  // MVP では prompt を stdin で渡すことを既定とする（多くの CLI が対応）。
  extraArgs?: readonly string[];
}

export function createCodexCliRunner(opts: CodexCliOpts): CodexExecRunner {
  return {
    async run(input: CodexRunInputs): Promise<CodexRunResult> {
      await mkdir(dirname(input.logPaths.stdout), { recursive: true });
      await mkdir(dirname(input.logPaths.stderr), { recursive: true });
      const outStream = createWriteStream(input.logPaths.stdout);
      const errStream = createWriteStream(input.logPaths.stderr);

      const args = ["exec", ...(opts.extraArgs ?? [])];
      return await new Promise<CodexRunResult>((resolve, reject) => {
        const child = spawn(opts.codexBin, args, {
          cwd: input.worktreePath,
          stdio: ["pipe", "pipe", "pipe"],
          env: process.env,
        });
        child.stdout.pipe(outStream);
        child.stderr.pipe(errStream);
        child.stdin.write(input.prompt);
        child.stdin.end();
        child.on("error", reject);
        child.on("close", (code) => resolve({ exitCode: code ?? -1 }));
      });
    },
  };
}
```

- [ ] **Step 5: テスト確認（局所 + opt-in）**

Run:
```bash
pnpm test tests/integration/codex-cli-runner.test.ts          # skip 動作
HARNESS_E2E_CODEX=1 pnpm test tests/integration/codex-cli-runner.test.ts
```
Expected: skip → 環境変数つきで PASS（exitCode が数値で返る）。

> Step 1 のメモで「stdin ではなく `--prompt` を使う」など仕様が判明したらここで反映する。CLI 形式が変わったらこのタスクをやり直してから次へ進む。

- [ ] **Step 6: コミット**

```bash
git add src/codex/codex-cli-runner.ts tests/integration/codex-cli-runner.test.ts
git commit -m "feat(codex): spawn real codex exec inside the run worktree"
```

---

## Phase 7 — Reporter (Milestone 5 / 6)

### Task 19: Summary 生成

**Files:**
- Create: `src/reporter/summary.ts`
- Test: `tests/unit/reporter/summary.test.ts`

- [ ] **Step 1: 失敗テストを書く**

`tests/unit/reporter/summary.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildSummary } from "../../../src/reporter/summary.js";

describe("buildSummary", () => {
  it("renders success summary with changed files", () => {
    const md = buildSummary({
      runId: "run-1",
      domain: "apps/user",
      goal: "add validation",
      status: "success",
      changedPaths: ["apps/user/profile.ts"],
      violations: [],
      codexExitCode: 0,
    });
    expect(md).toMatch(/# Run run-1/);
    expect(md).toMatch(/Status:\s*success/);
    expect(md).toMatch(/apps\/user\/profile\.ts/);
  });

  it("renders failed-policy-violation with details", () => {
    const md = buildSummary({
      runId: "run-2",
      domain: "apps/user",
      goal: "x",
      status: "failed-policy-violation",
      changedPaths: ["package.json"],
      violations: [{ path: "package.json", reason: "deny_write" }],
      codexExitCode: 0,
    });
    expect(md).toMatch(/failed-policy-violation/);
    expect(md).toMatch(/package\.json.*deny_write/);
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `pnpm test tests/unit/reporter/summary.test.ts`
Expected: FAIL。

- [ ] **Step 3: 実装**

`src/reporter/summary.ts`:
```ts
import type { Violation } from "../policy/path-policy-validator.js";
import type { RunMeta } from "../logging/run-log.js";

export interface SummaryInputs {
  runId: string;
  domain: string;
  goal: string;
  status: RunMeta["status"];
  changedPaths: readonly string[];
  violations: readonly Violation[];
  codexExitCode: number;
}

export function buildSummary(i: SummaryInputs): string {
  const lines: string[] = [];
  lines.push(`# Run ${i.runId}`);
  lines.push("");
  lines.push(`- Domain: ${i.domain}`);
  lines.push(`- Goal: ${i.goal}`);
  lines.push(`- Status: ${i.status}`);
  lines.push(`- Codex exit code: ${i.codexExitCode}`);
  lines.push("");
  lines.push("## Changed files");
  if (i.changedPaths.length === 0) {
    lines.push("- (none)");
  } else {
    for (const p of i.changedPaths) lines.push(`- ${p}`);
  }
  lines.push("");
  lines.push("## Policy violations");
  if (i.violations.length === 0) {
    lines.push("- (none)");
  } else {
    for (const v of i.violations) lines.push(`- ${v.path} (${v.reason})`);
  }
  lines.push("");
  return lines.join("\n");
}
```

- [ ] **Step 4: テスト合格を確認**

Run: `pnpm test tests/unit/reporter/summary.test.ts`
Expected: 2 tests passed。

- [ ] **Step 5: コミット**

```bash
git add src/reporter/summary.ts tests/unit/reporter/summary.test.ts
git commit -m "feat(reporter): render run summary.md"
```

---

### Task 20: Knowledge candidates 生成

**Files:**
- Create: `src/reporter/knowledge-candidates.ts`
- Test: `tests/unit/reporter/knowledge-candidates.test.ts`

- [ ] **Step 1: 失敗テストを書く**

`tests/unit/reporter/knowledge-candidates.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import { buildKnowledgeCandidates } from "../../../src/reporter/knowledge-candidates.js";

describe("buildKnowledgeCandidates", () => {
  it("emits an empty 'candidates' list on a clean success run", () => {
    const yaml = buildKnowledgeCandidates({
      runId: "run-1",
      domain: "apps/user",
      status: "success",
      violations: [],
    });
    expect(parseYaml(yaml)).toEqual({ candidates: [] });
  });

  it("includes a policy_improvement candidate when violations exist", () => {
    const yaml = buildKnowledgeCandidates({
      runId: "run-2",
      domain: "apps/user",
      status: "failed-policy-violation",
      violations: [{ path: "packages/shared/foo.ts", reason: "deny_write" }],
    });
    const parsed = parseYaml(yaml) as { candidates: Array<{ kind: string }> };
    expect(parsed.candidates.length).toBeGreaterThan(0);
    expect(parsed.candidates[0]?.kind).toBe("policy_improvement");
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `pnpm test tests/unit/reporter/knowledge-candidates.test.ts`
Expected: FAIL。

- [ ] **Step 3: 実装**

`src/reporter/knowledge-candidates.ts`:
```ts
import { stringify } from "yaml";
import type { Violation } from "../policy/path-policy-validator.js";
import type { RunMeta } from "../logging/run-log.js";

export interface KnowledgeInputs {
  runId: string;
  domain: string;
  status: RunMeta["status"];
  violations: readonly Violation[];
}

interface Candidate {
  kind: "policy_improvement" | "domain_rule";
  domain: string;
  title: string;
  content: string;
  evidence: string[];
  confidence: "low" | "medium" | "high";
  status: "candidate";
}

export function buildKnowledgeCandidates(i: KnowledgeInputs): string {
  const candidates: Candidate[] = [];
  if (i.violations.length > 0) {
    candidates.push({
      kind: "policy_improvement",
      domain: i.domain,
      title: "Domain wrote outside its scope",
      content:
        "Codex attempted to modify files outside the domain write scope. " +
        "Review whether the workflow needs an additional cross-domain step, or whether the prompt failed to convey scope.",
      evidence: [i.runId],
      confidence: "medium",
      status: "candidate",
    });
  }
  return stringify({ candidates });
}
```

- [ ] **Step 4: テスト合格を確認**

Run: `pnpm test tests/unit/reporter/knowledge-candidates.test.ts`
Expected: 2 tests passed。

- [ ] **Step 5: コミット**

```bash
git add src/reporter/knowledge-candidates.ts tests/unit/reporter/knowledge-candidates.test.ts
git commit -m "feat(reporter): emit knowledge-candidates.yaml seed entries"
```

---

## Phase 8 — Workflow オーケストレーション (全マイルストーン統合)

### Task 21: Workflow runner

**Files:**
- Create: `src/core/errors.ts`
- Create: `src/core/run-context.ts`
- Create: `src/core/workflow-runner.ts`
- Test: `tests/integration/workflow-fake-codex.test.ts`

- [ ] **Step 1: 失敗テスト（fake codex を使った E2E）を書く**

`tests/integration/workflow-fake-codex.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDomainCoding } from "../../src/core/workflow-runner.js";
import { createFakeCodexRunner } from "../../src/codex/fake-codex-runner.js";

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "harness-target-"));
  const g = (a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@e.com"]);
  g(["config", "user.name", "T"]);
  mkdirSync(join(repo, "apps/user/src"), { recursive: true });
  writeFileSync(join(repo, "apps/user/src/profile.ts"), "export const x = 0;\n");
  g(["add", "."]);
  g(["commit", "-qm", "init"]);
  return repo;
}

function setupHarness(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-root-"));
  mkdirSync(join(root, "policies/repos"), { recursive: true });
  writeFileSync(
    join(root, "policies/global.yaml"),
    "always_deny_write:\n  - .git/**\n  - package.json\n",
  );
  writeFileSync(
    join(root, "policies/repos/t.yaml"),
    [
      "repo_id: t",
      "read: []",
      "domains:",
      "  apps/user:",
      "    read: [apps/user/**]",
      "    write: [apps/user/**]",
      "    deny_write: []",
      "",
    ].join("\n"),
  );
  return root;
}

describe("runDomainCoding (fake codex)", () => {
  let repoPath: string;
  let harness: string;
  beforeEach(() => {
    repoPath = setupRepo();
    harness = setupHarness();
  });

  it("creates a run, edits inside scope, validates, and writes artifacts", async () => {
    const runner = createFakeCodexRunner({
      edit: async (cwd) => {
        writeFileSync(
          join(cwd, "apps/user/src/profile.ts"),
          "export const x = 1; // edited\n",
        );
      },
      stdout: "ok\n",
    });
    const r = await runDomainCoding({
      harnessRoot: harness,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "bump x",
      baseBranch: "main",
      keepWorktree: true,
      codexRunner: runner,
      now: new Date("2026-05-20T00:00:00Z"),
    });
    expect(r.status).toBe("success");
    const runDir = join(harness, "runs", r.runId);
    expect(existsSync(join(runDir, "summary.md"))).toBe(true);
    expect(existsSync(join(runDir, "final-diff.patch"))).toBe(true);
    expect(existsSync(join(runDir, "knowledge-candidates.yaml"))).toBe(true);
    expect(readFileSync(join(runDir, "final-diff.patch"), "utf8")).toMatch(
      /\+export const x = 1;/,
    );
  });

  it("rejects when codex edits outside the write scope", async () => {
    const runner = createFakeCodexRunner({
      edit: async (cwd) => {
        writeFileSync(join(cwd, "package.json"), "{}\n");
      },
    });
    const r = await runDomainCoding({
      harnessRoot: harness,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "x",
      baseBranch: "main",
      keepWorktree: true,
      codexRunner: runner,
      now: new Date("2026-05-20T00:00:00Z"),
    });
    expect(r.status).toBe("failed-policy-violation");
    const runDir = join(harness, "runs", r.runId);
    expect(readFileSync(join(runDir, "summary.md"), "utf8")).toMatch(
      /package\.json.*deny_write/,
    );
  });

  it("rejects concurrent runs on the same domain", async () => {
    const slow = createFakeCodexRunner({
      edit: async () => {
        await new Promise((res) => setTimeout(res, 200));
      },
    });
    const fast = createFakeCodexRunner({ edit: async () => {} });

    const p1 = runDomainCoding({
      harnessRoot: harness,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "a",
      baseBranch: "main",
      keepWorktree: false,
      codexRunner: slow,
      now: new Date("2026-05-20T00:00:00Z"),
    });
    // give p1 a head start so the lock is acquired
    await new Promise((res) => setTimeout(res, 50));
    await expect(
      runDomainCoding({
        harnessRoot: harness,
        repoPath,
        repoId: "t",
        domain: "apps/user",
        goal: "b",
        baseBranch: "main",
        keepWorktree: false,
        codexRunner: fast,
        now: new Date("2026-05-20T00:00:01Z"),
      }),
    ).rejects.toThrow(/locked/);
    await p1;
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `pnpm test tests/integration/workflow-fake-codex.test.ts`
Expected: FAIL（runner 未実装）。

- [ ] **Step 3: errors / run-context を作る**

`src/core/errors.ts`:
```ts
export class PolicyViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyViolationError";
  }
}

export class CodexExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexExecutionError";
  }
}
```

`src/core/run-context.ts`:
```ts
import type { ResolvedPolicy } from "../policy/schema.js";
import type { HarnessPaths } from "../config/paths.js";
import type { RunLog } from "../logging/run-log.js";

export interface RunContext {
  runId: string;
  paths: HarnessPaths;
  policy: ResolvedPolicy;
  repoPath: string;
  baseBranch: string;
  goal: string;
  log: RunLog;
}
```

- [ ] **Step 4: workflow-runner 実装**

`src/core/workflow-runner.ts`:
```ts
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { harnessPaths } from "../config/paths.js";
import { loadGlobalPolicy, loadRepoPolicy } from "../policy/loader.js";
import { resolvePolicy } from "../policy/resolver.js";
import { validateChangedPaths } from "../policy/path-policy-validator.js";
import { createRunLog, type RunMeta } from "../logging/run-log.js";
import { writeArtifact } from "../logging/artifacts.js";
import { nextRunId } from "./run-id.js";
import { acquireDomainLock } from "../workspace/domain-lock.js";
import { runBranchName } from "../workspace/branch-name.js";
import { createWorktree, removeWorktree } from "../workspace/git-worktree.js";
import { collectDiff } from "../git/diff.js";
import { buildCodexPrompt } from "../codex/prompt-builder.js";
import type { CodexExecRunner } from "../codex/codex-exec-runner.js";
import { buildSummary } from "../reporter/summary.js";
import { buildKnowledgeCandidates } from "../reporter/knowledge-candidates.js";

export interface RunDomainCodingOpts {
  harnessRoot: string;
  repoPath: string;
  repoId: string;
  domain: string;
  goal: string;
  baseBranch: string;
  keepWorktree: boolean;
  codexRunner: CodexExecRunner;
  now?: Date;
}

export interface RunDomainCodingResult {
  runId: string;
  status: RunMeta["status"];
}

export async function runDomainCoding(
  opts: RunDomainCodingOpts,
): Promise<RunDomainCodingResult> {
  const paths = harnessPaths(opts.harnessRoot);
  const global = await loadGlobalPolicy(paths.globalPolicyPath);
  const repo = await loadRepoPolicy(paths.repoPolicyPath(opts.repoId));
  const policy = resolvePolicy(global, repo, opts.domain);

  const lock = await acquireDomainLock({
    locksDir: paths.locksDir,
    domain: opts.domain,
    runId: "pending",
  });

  try {
    const runId = nextRunId(paths.runsDir, opts.now ?? new Date());
    const branch = runBranchName(runId, opts.domain);
    const startedAt = (opts.now ?? new Date()).toISOString();

    const log = await createRunLog({
      runsDir: paths.runsDir,
      runId,
      meta: {
        runId,
        repoId: opts.repoId,
        repoPath: opts.repoPath,
        domain: opts.domain,
        workflow: "domain-coding",
        baseBranch: opts.baseBranch,
        runBranch: branch,
        status: "running",
        startedAt,
      },
    });
    await log.emit({ type: "run_started", runId });
    await writeArtifact(
      join(log.runDir, "resolved-policy.yaml"),
      JSON.stringify(policy, null, 2),
    );

    const wt = await createWorktree({
      repoPath: opts.repoPath,
      worktreesDir: paths.workspacesDir,
      runId,
      branch,
      baseBranch: opts.baseBranch,
    });
    await log.emit({ type: "worktree_created", path: wt.path });

    const prompt = buildCodexPrompt({ goal: opts.goal, policy });
    await writeArtifact(join(log.runDir, "codex-prompt.md"), prompt);

    await log.emit({ type: "codex_exec_started" });
    const codex = await opts.codexRunner.run({
      worktreePath: wt.path,
      prompt,
      logPaths: {
        stdout: join(log.runDir, "codex-output.log"),
        stderr: join(log.runDir, "codex-error.log"),
      },
    });
    await log.emit({ type: "codex_exec_completed", exitCode: codex.exitCode });

    let status: RunMeta["status"] = "success";
    let violations: ReturnType<typeof validateChangedPaths>["violations"] = [];
    let changedPaths: string[] = [];

    if (codex.exitCode !== 0) {
      status = "failed-codex";
    } else {
      const diff = await collectDiff({
        repoPath: wt.path,
        baseBranch: opts.baseBranch,
      });
      changedPaths = diff.changedPaths;
      await writeArtifact(join(log.runDir, "final-diff.patch"), diff.patch);
      await log.emit({ type: "diff_collected", files: changedPaths });

      const v = validateChangedPaths(policy, changedPaths);
      violations = v.violations;
      status = v.status === "allowed" ? "success" : "failed-policy-violation";
      await log.emit({ type: "policy_validation_completed", status: v.status });
    }

    const summary = buildSummary({
      runId,
      domain: opts.domain,
      goal: opts.goal,
      status,
      changedPaths,
      violations,
      codexExitCode: codex.exitCode,
    });
    await writeArtifact(join(log.runDir, "summary.md"), summary);

    const knowledge = buildKnowledgeCandidates({
      runId,
      domain: opts.domain,
      status,
      violations,
    });
    await writeArtifact(join(log.runDir, "knowledge-candidates.yaml"), knowledge);

    if (!opts.keepWorktree && status === "success") {
      await removeWorktree({
        repoPath: opts.repoPath,
        worktreePath: wt.path,
        branch,
      });
    }

    await log.finalize({ status, finishedAt: new Date().toISOString() });
    await log.emit({ type: "run_completed", status });
    return { runId, status };
  } finally {
    await lock.release();
  }
}
```

- [ ] **Step 5: テスト合格を確認**

Run: `pnpm test tests/integration/workflow-fake-codex.test.ts`
Expected: 3 tests passed。

- [ ] **Step 6: 全テストが通るか再確認**

Run: `pnpm test`
Expected: 全 suite が PASS。

- [ ] **Step 7: コミット**

```bash
git add src/core/ tests/integration/workflow-fake-codex.test.ts
git commit -m "feat(core): orchestrate domain-coding workflow end-to-end"
```

---

## Phase 9 — CLI 結合と最終仕上げ

### Task 22: CLI を workflow に接続する

**Files:**
- Create: `src/cli/run.ts`
- Test: `tests/integration/cli-dry-run.test.ts`

- [ ] **Step 1: 失敗テスト（dry-run）**

`tests/integration/cli-dry-run.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function setupHarness(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-cli-"));
  mkdirSync(join(root, "policies/repos"), { recursive: true });
  writeFileSync(join(root, "policies/global.yaml"), "always_deny_write: []\n");
  writeFileSync(
    join(root, "policies/repos/t.yaml"),
    [
      "repo_id: t",
      "read: []",
      "domains:",
      "  apps/user:",
      "    read: []",
      "    write: [apps/user/**]",
      "    deny_write: []",
      "",
    ].join("\n"),
  );
  return root;
}

describe("CLI --dry-run", () => {
  it("resolves policy and exits 0 without creating runs", () => {
    const harness = setupHarness();
    const out = execFileSync(
      "node",
      [
        "--import",
        "tsx",
        join(process.cwd(), "src/cli/run.ts"),
        "--repo",
        "/tmp/no-repo",
        "--repo-id",
        "t",
        "--domain",
        "apps/user",
        "--goal",
        "noop",
        "--dry-run",
      ],
      { env: { ...process.env, HARNESS_ROOT: harness } },
    ).toString();
    expect(out).toMatch(/resolved/i);
    expect(out).toMatch(/apps\/user/);
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `pnpm test tests/integration/cli-dry-run.test.ts`
Expected: FAIL。

- [ ] **Step 3: 実装**

`src/cli/run.ts`:
```ts
#!/usr/bin/env node
import process from "node:process";
import { parseArgs } from "./parse-args.js";
import { harnessPaths } from "../config/paths.js";
import { loadGlobalPolicy, loadRepoPolicy } from "../policy/loader.js";
import { resolvePolicy } from "../policy/resolver.js";
import { runDomainCoding } from "../core/workflow-runner.js";
import { createCodexCliRunner } from "../codex/codex-cli-runner.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const harnessRoot = process.env.HARNESS_ROOT ?? process.cwd();
  const paths = harnessPaths(harnessRoot);

  if (args.dryRun) {
    const global = await loadGlobalPolicy(paths.globalPolicyPath);
    const repo = await loadRepoPolicy(paths.repoPolicyPath(args.repoId));
    const resolved = resolvePolicy(global, repo, args.domain);
    process.stdout.write(
      `resolved policy for ${resolved.domain}:\n${JSON.stringify(resolved, null, 2)}\n`,
    );
    return;
  }

  const codexBin = process.env.HARNESS_CODEX_BIN ?? "codex";
  const result = await runDomainCoding({
    harnessRoot,
    repoPath: args.repo,
    repoId: args.repoId,
    domain: args.domain,
    goal: args.goal,
    baseBranch: args.baseBranch,
    keepWorktree: args.keepWorktree,
    codexRunner: createCodexCliRunner({ codexBin }),
  });
  process.stdout.write(`run=${result.runId} status=${result.status}\n`);
  if (result.status !== "success") process.exit(1);
}

main().catch((e: unknown) => {
  process.stderr.write(`harness error: ${(e as Error).message}\n`);
  process.exit(2);
});
```

- [ ] **Step 4: テスト合格を確認**

Run: `pnpm test tests/integration/cli-dry-run.test.ts`
Expected: 1 test passed。

- [ ] **Step 5: コミット**

```bash
git add src/cli/run.ts tests/integration/cli-dry-run.test.ts
git commit -m "feat(cli): wire CLI to workflow runner with dry-run support"
```

---

### Task 23: 全体スモーク（fake codex）と README ステップ

**Files:**
- Modify: `package.json` (もし scripts に smoke を追加するなら)
- Test: 既存の `tests/integration/workflow-fake-codex.test.ts` を再利用

- [ ] **Step 1: 全テストを実行**

Run: `pnpm test`
Expected: 全 suite が PASS。

- [ ] **Step 2: typecheck**

Run: `pnpm typecheck`
Expected: エラーなし。

- [ ] **Step 3: dry-run を手で叩いて結果を確認**

Run:
```bash
HARNESS_ROOT="$PWD" pnpm harness \
  --repo /tmp/dummy-repo \
  --repo-id sample-monorepo \
  --domain apps/user \
  --goal "noop" \
  --dry-run
```
Expected: `resolved policy for apps/user` と JSON が標準出力に出る。終了コード 0。

- [ ] **Step 4: 設計書 §14 成功基準と突き合わせる**

設計書 14 章のチェックを実施：
1. CLI から Codex 起動できる → Task 18 + Task 22
2. run ごとに branch/worktree 分離 → Task 13 + Task 21
3. domain ごとの write scope 検査 → Task 5 + Task 21
4. 許可外変更が reject される → workflow-fake-codex.test.ts ケース 2
5. 実行ログがファイル → Task 10
6. final-diff.patch 保存 → Task 21
7. summary.md → Task 19 + Task 21
8. knowledge-candidates.yaml → Task 20 + Task 21
9. 同一 domain 同時実行防止 → Task 14 + workflow-fake-codex.test.ts ケース 3

すべて ✓ で MVP 完了。

- [ ] **Step 5: コミット（ドキュメント上の節目）**

```bash
git commit --allow-empty -m "chore: codex exec harness MVP milestone complete"
```

---

## Self-Review

**Spec coverage:**
- §3.1 実現すること 12 項目 → Task 6/8/10/13/15/17/18/14/19/20/21/22 で網羅
- §3.2 やらないこと → 計画には含まれていない（OK）
- §4 アーキテクチャ層 → CLI(22) / WorkflowRunner(21) / PolicyResolver(4) / WorkspaceManager(13) / CodexExecRunner(17,18) / Validator(5) / Reporter(19,20)
- §5 ディレクトリ構成 → File Structure 節と一致
- §6 CLI 仕様 → Task 6/22
- §7 Policy 設計 → Task 2/3/4/5/8
- §8 ワークフロー 19 ステップ → Task 21 の workflow-runner に集約
- §9 Run 保存形式 → Task 10/21
- §10 Codex prompt 方針 → Task 16
- §11 並列実行 / domain lock → Task 14 + 21
- §12 Knowledge candidates → Task 20
- §13 マイルストーン → Phase 1〜9 と対応

**Placeholder scan:**
- "TBD" / "後で" / "TODO" などの placeholder 文字列: なし
- すべての test step に actual code を記載
- すべての run コマンドに期待値を明記

**Type consistency:**
- `ResolvedPolicy` は Task 2 で定義、Task 4/5/16/17/19/20/21 で使用 → 一致
- `RunMeta` は Task 10 で定義、Task 19/20/21 で参照 → 一致
- `CodexExecRunner` interface は Task 17 で定義、Task 18 と Task 21 で利用 → 一致
- `Violation` は Task 5 で定義、Task 19/20 で参照 → 一致
- `HarnessPaths` は Task 7 で定義、Task 21 で利用 → 一致

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-20-codex-exec-harness-mvp.md`. Two execution options:

**1. Subagent-Driven (recommended)** — タスクごとに新しい subagent を起動し、タスク間で結果をレビューする。並列性が高く反復が速い。

**2. Inline Execution** — 同じセッション内で `superpowers:executing-plans` を使い、チェックポイントを置きながら進める。

どちらで進めますか？
