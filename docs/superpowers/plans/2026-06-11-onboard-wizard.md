# `harness onboard` Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an interactive TTY wizard `harness onboard` that drives a new target repo from `inspect` → profile/policy → DB register → `.harness/mcp.yaml` → serve smoke, reusing existing commands.

**Architecture:** Three layers — a pure step state-machine (`src/onboard/steps.ts`, probe-based, idempotent/resumable), a thin injectable `readline/promises` prompt adapter (`src/onboard/prompts.ts`), and the commander command (`src/cli/onboard.ts`). The safety-critical `.harness/mcp.yaml` merge lives in its own pure module (`src/onboard/mcp-config.ts`).

**Tech Stack:** TypeScript, commander, `yaml`, Node `readline/promises`, vitest. No new dependency.

**Spec:** `docs/superpowers/specs/2026-06-11-onboard-wizard-design.md`. Branch: `feat/onboard-wizard`.

**Conventions:** TDD (RED → GREEN → commit). `npm run typecheck` before each commit. Tests run with `HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1 npx vitest run <file>`. Conventional Commits, no Co-Authored-By.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/onboard/prompts.ts` (new) | `Prompts` interface + real `readline/promises` impl + injectable. IO only. |
| `src/onboard/mcp-config.ts` (new) | Pure `.harness/mcp.yaml` merge: allow-all-aware `allowedProjects`, starter opt-in (`clients` + `allowedOperations`). The safety core. |
| `src/onboard/steps.ts` (new) | Pure `OnboardStep` model + state machine (`firstPending`), `OnboardCtx`, the per-step probe/describe/run, and a global-policy write-if-missing helper. Reuses existing project/db/mcp functions. |
| `src/cli/onboard.ts` (new) | commander command, TTY detection, the run loop, final summary. |
| `src/cli/run.ts` (modify, ~:233 import, ~:4157 registration) | register the command. |
| `docs/specs/cli.md`, `docs/specs/mcp.md`, `README.md` (modify) | document `harness onboard`. |
| `tests/unit/onboard/*.test.ts`, `tests/integration/onboard-*.test.ts` (new) | tests. |

---

## Task 1: Prompt adapter (`src/onboard/prompts.ts`)

**Files:**
- Create: `src/onboard/prompts.ts`
- Test: `tests/unit/onboard/prompts.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/onboard/prompts.test.ts
import { describe, it, expect } from "vitest";
import { scriptedPrompts } from "../../../src/onboard/prompts.js";

describe("scriptedPrompts (fake for tests)", () => {
  it("returns queued answers in order and records the questions asked", async () => {
    const p = scriptedPrompts(["my-id", "y", "1"]);
    expect(await p.input("project id?")).toBe("my-id");
    expect(await p.confirm("ok?")).toBe(true);
    expect(await p.select("pick", ["a", "b"])).toBe("a"); // "1" → first choice
    expect(p.asked).toEqual(["project id?", "ok?", "pick"]);
  });

  it("confirm treats y/yes (case-insensitive) as true, everything else false", async () => {
    const p = scriptedPrompts(["Yes", "n", ""]);
    expect(await p.confirm("a")).toBe(true);
    expect(await p.confirm("b")).toBe(false);
    expect(await p.confirm("c")).toBe(false);
  });

  it("throws when the script is exhausted (test wrote too few answers)", async () => {
    const p = scriptedPrompts([]);
    await expect(p.input("q")).rejects.toThrow(/exhausted/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1 npx vitest run tests/unit/onboard/prompts.test.ts`
Expected: FAIL — cannot find module `prompts.js`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/onboard/prompts.ts
import { createInterface } from "node:readline/promises";

/** Injectable prompt surface so the wizard's IO can be faked in tests. */
export interface Prompts {
  /** free-text input; returns the trimmed answer (or the default when empty). */
  input(question: string, defaultValue?: string): Promise<string>;
  /** yes/no; only y/yes (case-insensitive) is true. */
  confirm(question: string): Promise<boolean>;
  /** choose one of `choices` (1-based selection); returns the chosen string. */
  select(question: string, choices: string[]): Promise<string>;
}

const YES = new Set(["y", "yes"]);

/** Real adapter over node:readline/promises (TTY). */
export function readlinePrompts(): Prompts {
  const rl = () => createInterface({ input: process.stdin, output: process.stdout });
  return {
    async input(question, defaultValue) {
      const io = rl();
      try {
        const suffix = defaultValue !== undefined ? ` [${defaultValue}]` : "";
        const ans = (await io.question(`${question}${suffix} `)).trim();
        return ans === "" && defaultValue !== undefined ? defaultValue : ans;
      } finally {
        io.close();
      }
    },
    async confirm(question) {
      const io = rl();
      try {
        const ans = (await io.question(`${question} [y/N] `)).trim().toLowerCase();
        return YES.has(ans);
      } finally {
        io.close();
      }
    },
    async select(question, choices) {
      const io = rl();
      try {
        const list = choices.map((c, i) => `  ${i + 1}) ${c}`).join("\n");
        const ans = (await io.question(`${question}\n${list}\nchoose 1-${choices.length}: `)).trim();
        const idx = Number.parseInt(ans, 10) - 1;
        return choices[idx] ?? choices[0]!;
      } finally {
        io.close();
      }
    },
  };
}

/** Scripted fake: answers are dequeued in order; records questions asked. */
export function scriptedPrompts(answers: string[]): Prompts & { asked: string[] } {
  const queue = [...answers];
  const asked: string[] = [];
  const next = (q: string): string => {
    asked.push(q);
    if (queue.length === 0) throw new Error(`scriptedPrompts exhausted at: ${q}`);
    return queue.shift()!;
  };
  return {
    asked,
    async input(q, d) {
      const a = next(q);
      return a === "" && d !== undefined ? d : a;
    },
    async confirm(q) {
      return YES.has(next(q).trim().toLowerCase());
    },
    async select(q, choices) {
      const idx = Number.parseInt(next(q), 10) - 1;
      return choices[idx] ?? choices[0]!;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1 npx vitest run tests/unit/onboard/prompts.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: typecheck + commit**

```bash
npm run typecheck
git add src/onboard/prompts.ts tests/unit/onboard/prompts.test.ts
git commit -m "feat: add injectable prompt adapter for the onboard wizard (#92)"
```

---

## Task 2: MCP config merge (the safety core) (`src/onboard/mcp-config.ts`)

This module is pure: it takes the existing `.harness/mcp.yaml` text (or null) and a decision, and returns the new YAML text plus a structured report. It encodes spec P1-1 (two-stage gate → opt-in writes a `clients` entry AND ops) and P1-2 (allow-all `allowedProjects: []` must not be silently narrowed).

**Files:**
- Create: `src/onboard/mcp-config.ts`
- Test: `tests/unit/onboard/mcp-config.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/onboard/mcp-config.test.ts
import { describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import { mergeMcpConfig } from "../../../src/onboard/mcp-config.js";

const baseDecline = { projectId: "demo", existingProjectIds: ["demo"], starter: null };

describe("mergeMcpConfig (#92)", () => {
  it("creates a fresh config (deny-all) when none exists and starter is declined", () => {
    const { yaml, report } = mergeMcpConfig(null, baseDecline);
    const cfg = parseYaml(yaml).mcp;
    expect(cfg.defaultMode).toBe("dry-run");
    expect(cfg.allowedProjects).toEqual(["demo"]);
    expect(cfg.allowedOperations ?? []).toEqual([]);
    expect(cfg.clients ?? []).toEqual([]);
    expect(report.allowAllPreserved).toBe(false);
  });

  it("on starter opt-in writes BOTH a guarded-mutation client AND the operations (two-stage gate)", () => {
    const { yaml } = mergeMcpConfig(null, {
      projectId: "demo",
      existingProjectIds: ["demo"],
      starter: { clientName: "codex", operations: ["goal.start", "run.start"] },
    });
    const cfg = parseYaml(yaml).mcp;
    expect(cfg.defaultMode).toBe("dry-run"); // unknown clients stay un-elevated
    expect(cfg.clients).toEqual([
      { id: "codex", names: ["codex"], mode: "guarded-mutation" },
    ]);
    expect(cfg.allowedOperations).toEqual(["goal.start", "run.start"]);
  });

  it("appends the project to a non-empty allowedProjects list, preserving other fields", () => {
    const existing = [
      "version: 1",
      "mcp:",
      "  defaultMode: dry-run",
      "  allowedProjects: [other]",
      "  deniedOperations: [db.restore]",
      "  clients:",
      "    - { id: codex, names: [codex], mode: guarded-mutation }",
      "",
    ].join("\n");
    const { yaml, report } = mergeMcpConfig(existing, {
      projectId: "demo",
      existingProjectIds: ["other", "demo"],
      starter: null,
    });
    const cfg = parseYaml(yaml).mcp;
    expect(cfg.allowedProjects.sort()).toEqual(["demo", "other"]);
    expect(cfg.deniedOperations).toEqual(["db.restore"]); // preserved
    expect(cfg.clients).toHaveLength(1); // preserved
    expect(report.allowAllPreserved).toBe(false);
  });

  it("does NOT silently narrow an allow-all config; reports it and leaves the list empty unless explicitly enumerated", () => {
    const existing = ["version: 1", "mcp:", "  allowedProjects: []", ""].join("\n");
    const { yaml, report } = mergeMcpConfig(existing, {
      projectId: "demo",
      existingProjectIds: ["demo"],
      starter: null,
      // default: keep allow-all
      allowAll: "keep",
    });
    const cfg = parseYaml(yaml).mcp;
    expect(cfg.allowedProjects).toEqual([]); // still allow-all — not narrowed
    expect(report.allowAllPreserved).toBe(true);
  });

  it("when the operator chooses to enumerate, seeds the list from existing project ids + the new one", () => {
    const existing = ["version: 1", "mcp:", "  allowedProjects: []", ""].join("\n");
    const { yaml } = mergeMcpConfig(existing, {
      projectId: "demo",
      existingProjectIds: ["alpha", "beta", "demo"],
      starter: null,
      allowAll: "enumerate",
    });
    const cfg = parseYaml(yaml).mcp;
    expect(cfg.allowedProjects.sort()).toEqual(["alpha", "beta", "demo"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1 npx vitest run tests/unit/onboard/mcp-config.test.ts`
Expected: FAIL — cannot find module `mcp-config.js`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/onboard/mcp-config.ts
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface StarterOptIn {
  /** the client name the agent connects as (e.g. "codex"); becomes a guarded-mutation client */
  clientName: string;
  /** the mutation operations to allowlist (e.g. ["goal.start", "run.start"]) */
  operations: string[];
}

export interface MergeMcpInput {
  projectId: string;
  /** all known project ids (from the `projects` table) — used to seed an enumeration */
  existingProjectIds: string[];
  /** null = decline (stay read-only); else opt into a guarded-mutation client + ops */
  starter: StarterOptIn | null;
  /** what to do when the existing config is allow-all (allowedProjects: []). default "keep". */
  allowAll?: "keep" | "enumerate";
}

export interface MergeMcpReport {
  /** true when the config was allow-all and we kept it that way (did not narrow) */
  allowAllPreserved: boolean;
  /** true when a guarded-mutation client + ops were written */
  mutationsEnabled: boolean;
}

export interface MergeMcpResult {
  yaml: string;
  report: MergeMcpReport;
}

interface RawMcp {
  version?: number;
  mcp?: Record<string, unknown>;
}

/**
 * Merge a project into `.harness/mcp.yaml` (pure). Encodes the two safety rules:
 *  - mutations need a guarded-mutation CLIENT + an allowlisted operation, so the
 *    starter opt-in writes BOTH (otherwise the allowlist silently never applies).
 *  - an empty `allowedProjects` means allow-all; appending one project would
 *    narrow it and break other projects, so we never do that silently.
 */
export function mergeMcpConfig(
  existingText: string | null,
  input: MergeMcpInput,
): MergeMcpResult {
  const root: RawMcp =
    existingText !== null && existingText.trim() !== ""
      ? (parseYaml(existingText) as RawMcp) ?? {}
      : {};
  const mcp: Record<string, unknown> = { ...(root.mcp ?? {}) };

  if (mcp.defaultMode === undefined) mcp.defaultMode = "dry-run";

  const currentProjects = Array.isArray(mcp.allowedProjects)
    ? (mcp.allowedProjects as string[])
    : [];
  let allowAllPreserved = false;
  if (existingText !== null && currentProjects.length === 0 && "allowedProjects" in mcp) {
    // allow-all config: do not silently narrow.
    if ((input.allowAll ?? "keep") === "enumerate") {
      mcp.allowedProjects = unique(input.existingProjectIds);
    } else {
      mcp.allowedProjects = []; // keep allow-all
      allowAllPreserved = true;
    }
  } else {
    mcp.allowedProjects = unique([...currentProjects, input.projectId]);
  }

  let mutationsEnabled = false;
  if (input.starter !== null) {
    const clients = Array.isArray(mcp.clients) ? [...(mcp.clients as unknown[])] : [];
    const has = clients.some(
      (c) => (c as { names?: string[] }).names?.includes(input.starter!.clientName),
    );
    if (!has) {
      clients.push({
        id: input.starter.clientName,
        names: [input.starter.clientName],
        mode: "guarded-mutation",
      });
    }
    mcp.clients = clients;
    const ops = Array.isArray(mcp.allowedOperations)
      ? (mcp.allowedOperations as string[])
      : [];
    mcp.allowedOperations = unique([...ops, ...input.starter.operations]);
    mutationsEnabled = true;
  }

  const out: RawMcp = { version: root.version ?? 1, mcp };
  return {
    yaml: stringifyYaml(out),
    report: { allowAllPreserved, mutationsEnabled },
  };
}

function unique(xs: string[]): string[] {
  return [...new Set(xs)];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1 npx vitest run tests/unit/onboard/mcp-config.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: typecheck + commit**

```bash
npm run typecheck
git add src/onboard/mcp-config.ts tests/unit/onboard/mcp-config.test.ts
git commit -m "feat: pure .harness/mcp.yaml merge for onboard (two-stage gate, allow-all-safe) (#92)"
```

---

## Task 3: Step model + state machine + global-policy helper (`src/onboard/steps.ts`)

Defines the pure types and the resumable state machine. The concrete step `run`s are filled in Task 4; here we define the contract and the global-policy write-if-missing helper, and test `firstPending`.

**Files:**
- Create: `src/onboard/steps.ts`
- Test: `tests/unit/onboard/steps.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/onboard/steps.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstPending, writeGlobalPolicyIfMissing } from "../../../src/onboard/steps.js";
import type { OnboardStep, OnboardCtx } from "../../../src/onboard/steps.js";

function step(id: string, status: "done" | "pending" | "blocked"): OnboardStep {
  return {
    id,
    title: id,
    probe: () => status,
    describe: () => id,
    run: async () => ({ ok: true, message: id }),
  };
}

const ctx = {} as OnboardCtx;

describe("firstPending (resume model)", () => {
  it("skips leading done steps and returns the first pending one", () => {
    const steps = [step("a", "done"), step("b", "done"), step("c", "pending"), step("d", "pending")];
    expect(firstPending(steps, ctx)?.id).toBe("c");
  });

  it("returns a blocked step (so the caller can stop with remediation)", () => {
    const steps = [step("a", "done"), step("b", "blocked"), step("c", "pending")];
    expect(firstPending(steps, ctx)?.id).toBe("b");
  });

  it("returns undefined when all steps are done", () => {
    expect(firstPending([step("a", "done"), step("b", "done")], ctx)).toBeUndefined();
  });
});

describe("writeGlobalPolicyIfMissing", () => {
  it("writes policies/global.yaml when absent and skips when present", () => {
    const root = mkdtempSync(join(tmpdir(), "onb-glob-"));
    mkdirSync(join(root, "policies"), { recursive: true });
    const wrote1 = writeGlobalPolicyIfMissing(root, { always_deny_write: ["**/.env"] });
    expect(wrote1).toBe(true);
    const wrote2 = writeGlobalPolicyIfMissing(root, { always_deny_write: ["**/.env"] });
    expect(wrote2).toBe(false); // already present
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1 npx vitest run tests/unit/onboard/steps.test.ts`
Expected: FAIL — cannot find module `steps.js`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/onboard/steps.ts
import { existsSync, writeFileSync } from "node:fs";
import { stringify as stringifyYaml } from "yaml";
import { harnessPaths } from "../config/paths.js";
import type { Prompts } from "./prompts.js";

export type StepStatus = "done" | "pending" | "blocked";

export interface StepResult {
  ok: boolean;
  message: string;
  /** when ok=false and the step is blocked rather than failed, remediation text */
  remediation?: string;
}

export interface OnboardCtx {
  harnessRoot: string;
  repoPath: string;
  projectId: string;
  prompts: Prompts;
  /** accumulated human-readable log lines for the final summary */
  log: string[];
}

export interface OnboardStep {
  id: string;
  title: string;
  /** deterministic, side-effect-free completion detection */
  probe(ctx: OnboardCtx): StepStatus;
  /** what running this step will do (shown before acting) */
  describe(ctx: OnboardCtx): string;
  /** drive the underlying work; may prompt via ctx.prompts */
  run(ctx: OnboardCtx): Promise<StepResult>;
}

/** First step that is not done — pending OR blocked (caller stops on blocked). */
export function firstPending(steps: OnboardStep[], ctx: OnboardCtx): OnboardStep | undefined {
  return steps.find((s) => s.probe(ctx) !== "done");
}

/** Write policies/global.yaml only when missing (the #78 ENOENT fix); returns whether written. */
export function writeGlobalPolicyIfMissing(harnessRoot: string, globalPolicy: unknown): boolean {
  const path = harnessPaths(harnessRoot).globalPolicyPath;
  if (existsSync(path)) return false;
  writeFileSync(path, stringifyYaml(globalPolicy), "utf8");
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1 npx vitest run tests/unit/onboard/steps.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: typecheck + commit**

```bash
npm run typecheck
git add src/onboard/steps.ts tests/unit/onboard/steps.test.ts
git commit -m "feat: onboard step model + resume state machine + global-policy helper (#92)"
```

---

## Task 4: Concrete steps (`src/onboard/step-impls.ts`)

The 7 steps reusing existing functions. Each `probe` is deterministic; each `run` reuses an existing module. Integration-tested over a temp `HARNESS_ROOT` + a mini repo + scripted prompts.

**Reused signatures (verified):**
- `runProjectInit(opts: { harnessRoot, projectId, repoPath?, write, force }): Promise<InitResult>` (`src/project/init.ts`). `InitResult.proposal.result.globalPolicy` is the compiled global policy. `InitResult.written: string[]`.
- `checkProject(opts: { harnessRoot, projectId, repoPath? }): Promise<ProjectCheckReport>` (`src/project/checker.ts`); `report.status: "ok"|"warn"|"error"`.
- `importProjects(db, projectsDir, counters, opts?)` (`src/db/import/projects.ts`); open the DB with `openManagedDb`/`runMigrations` first (see `src/cli/db.ts` `db import`).
- `loadMcpConfig({ harnessRoot }): McpConfig` (`src/mcp/security/config.ts`).
- `isProjectAllowed(config, projectId)` and `modeForClient(config, clientName)`, `decideMcpPermission(config, req)`, `operationNameForTool(toolName)` (`src/mcp/security/permissions.ts`).
- `defaultMcpConfigPath(harnessRoot)` = `.harness/mcp.yaml`.
- `harnessPaths(root).projectProfilePath(id)` / `.projectsDir` / `.dbPath`.

**Files:**
- Create: `src/onboard/step-impls.ts`
- Test: `tests/integration/onboard-steps.test.ts`

- [ ] **Step 1: Write the failing integration test**

```typescript
// tests/integration/onboard-steps.test.ts
import { afterEach, describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { buildOnboardSteps } from "../../src/onboard/step-impls.js";
import { scriptedPrompts } from "../../src/onboard/prompts.js";
import type { OnboardCtx } from "../../src/onboard/steps.js";

const tmps: string[] = [];
afterEach(() => { for (const t of tmps.splice(0)) rmSync(t, { recursive: true, force: true }); });

function miniRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "onb-repo-")); tmps.push(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  mkdirSync(join(repo, "apps", "web"), { recursive: true });
  writeFileSync(join(repo, "apps", "web", "index.ts"), "export const x = 1;\n");
  return repo;
}

function ctxFor(answers: string[]): OnboardCtx {
  const root = mkdtempSync(join(tmpdir(), "onb-root-")); tmps.push(root);
  mkdirSync(join(root, ".harness"), { recursive: true });
  return {
    harnessRoot: root, repoPath: miniRepo(), projectId: "demo",
    prompts: scriptedPrompts(answers), log: [],
  };
}

describe("onboard steps (integration)", () => {
  it("profile+policy step writes the profile, repo policy, and global.yaml", async () => {
    // answers: confirm-write=y
    const ctx = ctxFor(["y"]);
    const steps = buildOnboardSteps();
    const profileStep = steps.find((s) => s.id === "profile")!;
    const res = await profileStep.run(ctx);
    expect(res.ok).toBe(true);
    expect(existsSync(join(ctx.harnessRoot, "projects", "demo.yaml"))).toBe(true);
    expect(existsSync(join(ctx.harnessRoot, "policies", "global.yaml"))).toBe(true);
    // probe now reports done
    expect(profileStep.probe(ctx)).toBe("done");
  });

  it("mcp step merges the project and, on starter opt-in, writes a guarded-mutation client", async () => {
    // answers: enable-starter=y, client-name=codex, goal.start=y, run.start=n
    const ctx = ctxFor(["y", "codex", "y", "n"]);
    // pre-create projects/demo.yaml so the mcp step has a project to allow
    mkdirSync(join(ctx.harnessRoot, "projects"), { recursive: true });
    writeFileSync(join(ctx.harnessRoot, "projects", "demo.yaml"),
      "version: 1\nproject_id: demo\nrepo:\n  id: demo\ndomains:\n  - { id: web, root: apps/web }\n");
    const mcpStep = buildOnboardSteps().find((s) => s.id === "mcp")!;
    const res = await mcpStep.run(ctx);
    expect(res.ok).toBe(true);
    const cfg = parseYaml(readFileSync(join(ctx.harnessRoot, ".harness", "mcp.yaml"), "utf8")).mcp;
    expect(cfg.allowedProjects).toContain("demo");
    expect(cfg.clients).toEqual([{ id: "codex", names: ["codex"], mode: "guarded-mutation" }]);
    expect(cfg.allowedOperations).toEqual(["goal.start"]); // run.start declined
  });

  it("check step returns ok=false (stops the wizard) when the profile is uncompilable", async () => {
    const ctx = ctxFor([]);
    // an invalid profile: missing required `domains` → checkProject status "error"
    mkdirSync(join(ctx.harnessRoot, "projects"), { recursive: true });
    writeFileSync(join(ctx.harnessRoot, "projects", "demo.yaml"),
      "version: 1\nproject_id: demo\nrepo:\n  id: demo\n  path: " + ctx.repoPath + "\ndomains: []\n");
    const checkStep = buildOnboardSteps().find((s) => s.id === "check")!;
    const res = await checkStep.run(ctx);
    expect(res.ok).toBe(false);
    expect(res.remediation).toMatch(/fix the profile/i);
  });
});
```

> The `check`-error case satisfies the spec's "check error stop" requirement. The
> spec's "permission round-trip" requirement is covered structurally: Task 2 asserts
> the exact `clients` (`mode: guarded-mutation`) + `allowedOperations` that
> `decideMcpPermission` (verified in `src/mcp/security/permissions.ts:120-135`)
> requires for `mutation_allowed`, and `serveSmokeStep` evaluates that decision.
> If you want it explicit, add an assertion in the mcp test that
> `decideMcpPermission(loadMcpConfig(...), { toolName: "harness.goal.start", kind: "mutation", projectId: "demo", clientMode: "guarded-mutation" }).reason === "mutation_allowed"`.

- [ ] **Step 2: Run test to verify it fails**

Run: `HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1 npx vitest run tests/integration/onboard-steps.test.ts`
Expected: FAIL — cannot find module `step-impls.js`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/onboard/step-impls.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { harnessPaths } from "../config/paths.js";
import { openManagedDb } from "../db/managed-connection.js";
import { runMigrations } from "../db/migrations.js";
import { runProjectInit } from "../project/init.js";
import { checkProject } from "../project/checker.js";
import { importProjects } from "../db/import/projects.js";
import { loadMcpConfig, defaultMcpConfigPath } from "../mcp/security/config.js";
import { isProjectAllowed, modeForClient, decideMcpPermission } from "../mcp/security/permissions.js";
import { mergeMcpConfig, type StarterOptIn } from "./mcp-config.js";
import { writeGlobalPolicyIfMissing, type OnboardStep, type OnboardCtx } from "./steps.js";

const STARTER_OPS = ["goal.start", "run.start"] as const;

export function buildOnboardSteps(): OnboardStep[] {
  return [profileStep(), checkStep(), dbStep(), mcpStep(), serveSmokeStep()];
  // NOTE: preflight + inspect steps are added in Task 5 (CLI wiring) where the
  // repoPath/projectId are resolved; the wizard prepends them. Keeping the
  // write-bearing steps here keeps this module integration-testable in isolation.
}

function profileStep(): OnboardStep {
  return {
    id: "profile",
    title: "Generate project profile + policy",
    probe: (ctx) => existsSync(harnessPaths(ctx.harnessRoot).projectProfilePath(ctx.projectId)) ? "done" : "pending",
    describe: (ctx) => `inspect ${ctx.repoPath} and write projects/${ctx.projectId}.yaml + policies/repos/<repo>.yaml`,
    run: async (ctx) => {
      // dry-run first: show the proposal, confirm, then write.
      const dry = await runProjectInit({ harnessRoot: ctx.harnessRoot, projectId: ctx.projectId, repoPath: ctx.repoPath, write: false, force: false });
      ctx.log.push(dry.profileYaml);
      const ok = await ctx.prompts.confirm(`Write profile + policy for "${ctx.projectId}"?`);
      if (!ok) return { ok: false, message: "declined", remediation: "re-run when ready" };
      const res = await runProjectInit({ harnessRoot: ctx.harnessRoot, projectId: ctx.projectId, repoPath: ctx.repoPath, write: true, force: false });
      writeGlobalPolicyIfMissing(ctx.harnessRoot, res.proposal.result.globalPolicy);
      return { ok: true, message: `wrote ${res.written.length} file(s)` };
    },
  };
}

function checkStep(): OnboardStep {
  return {
    id: "check",
    title: "Validate the profile",
    // re-runnable; never "done" so it always runs once when reached, but cheap.
    probe: (ctx) => existsSync(harnessPaths(ctx.harnessRoot).projectProfilePath(ctx.projectId)) ? "pending" : "blocked",
    describe: () => "run project check (ok/warn/error)",
    run: async (ctx) => {
      const report = await checkProject({ harnessRoot: ctx.harnessRoot, projectId: ctx.projectId, repoPath: ctx.repoPath });
      ctx.log.push(`check: ${report.status}`);
      if (report.status === "error") {
        return { ok: false, message: "check failed", remediation: "fix the profile (see project check output) and re-run" };
      }
      return { ok: true, message: `check ${report.status}` };
    },
  };
}

function dbStep(): OnboardStep {
  return {
    id: "db",
    title: "Register the project in the DB",
    probe: (ctx) => {
      const dbPath = harnessPaths(ctx.harnessRoot).dbPath;
      if (!existsSync(dbPath)) return "pending";
      const h = openManagedDb({ dbPath, readonly: true });
      try {
        const row = h.db.prepare("SELECT 1 FROM projects WHERE project_id = ?").get(ctx.projectId);
        return row !== undefined ? "done" : "pending";
      } catch { return "pending"; } finally { h.close(); }
    },
    describe: () => "db import --from-files (runs migrations) + check-consistency",
    run: async (ctx) => {
      const paths = harnessPaths(ctx.harnessRoot);
      const h = openManagedDb({ dbPath: paths.dbPath });
      try {
        runMigrations(h.db);
        const counters = { inserted: 0, updated: 0, skipped: 0, errors: 0 } as Parameters<typeof importProjects>[2];
        importProjects(h.db, paths.projectsDir, counters);
      } finally { h.close(); }
      return { ok: true, message: "project imported" };
    },
  };
}

function mcpStep(): OnboardStep {
  return {
    id: "mcp",
    title: "Configure MCP access",
    probe: (ctx) => isProjectAllowed(loadMcpConfig({ harnessRoot: ctx.harnessRoot }), ctx.projectId) && existsSync(defaultMcpConfigPath(ctx.harnessRoot)) ? "done" : "pending",
    describe: (ctx) => `add "${ctx.projectId}" to .harness/mcp.yaml (mutations stay deny-all unless you opt in)`,
    run: async (ctx) => {
      const path = defaultMcpConfigPath(ctx.harnessRoot);
      const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
      const existingProjectIds = listProjectIds(ctx);
      let starter: StarterOptIn | null = null;
      if (await ctx.prompts.confirm("Enable MCP mutations for a client? (otherwise read-only/dry-run)")) {
        const clientName = await ctx.prompts.input("client name", "codex");
        const operations: string[] = [];
        if (await ctx.prompts.confirm("Allow goal.start (start a goal session)?")) operations.push("goal.start");
        if (await ctx.prompts.confirm("Allow run.start (starts a codex run — incurs cost)?")) operations.push("run.start");
        if (operations.length > 0) starter = { clientName, operations };
      }
      // allow-all handling
      let allowAll: "keep" | "enumerate" = "keep";
      const cfgNow = loadMcpConfig({ harnessRoot: ctx.harnessRoot });
      if (existing !== null && cfgNow.allowedProjects.length === 0) {
        allowAll = (await ctx.prompts.confirm("Existing config allows ALL projects. Switch to an explicit list?")) ? "enumerate" : "keep";
      }
      const { yaml, report } = mergeMcpConfig(existing, { projectId: ctx.projectId, existingProjectIds, starter, allowAll });
      writeFileSync(path, yaml, "utf8");
      ctx.log.push(report.mutationsEnabled ? "mcp: mutations enabled" : "mcp: read-only");
      return { ok: true, message: "wrote .harness/mcp.yaml" };
    },
  };
}

function serveSmokeStep(): OnboardStep {
  return {
    id: "serve-smoke",
    title: "Verify MCP would serve this project",
    probe: () => "pending", // report-only; always runs when reached
    describe: () => "evaluate effective MCP config (no daemon)",
    run: async (ctx) => {
      const cfg = loadMcpConfig({ harnessRoot: ctx.harnessRoot });
      const visible = isProjectAllowed(cfg, ctx.projectId);
      const lines = [`project visible: ${visible}`];
      const firstClient = cfg.clients[0]?.names[0];
      if (firstClient !== undefined) {
        const mode = modeForClient(cfg, firstClient);
        const d = decideMcpPermission(cfg, { toolName: "harness.goal.start", kind: "mutation", projectId: ctx.projectId, clientMode: mode });
        lines.push(`client "${firstClient}" goal.start: ${d.reason}`);
      }
      ctx.log.push(lines.join("; "));
      return { ok: true, message: lines.join("; ") };
    },
  };
}

function listProjectIds(ctx: OnboardCtx): string[] {
  const dbPath = harnessPaths(ctx.harnessRoot).dbPath;
  if (!existsSync(dbPath)) return [ctx.projectId];
  const h = openManagedDb({ dbPath, readonly: true });
  try {
    const rows = h.db.prepare("SELECT project_id FROM projects").all() as Array<{ project_id: string }>;
    return [...new Set([...rows.map((r) => r.project_id), ctx.projectId])];
  } catch { return [ctx.projectId]; } finally { h.close(); }
}
```

> **Implementer note:** verify `importProjects`'s `ImportCounters` field names against `src/db/import/projects.ts` and adjust the `counters` literal; if the type is exported, import it instead of the inline literal. Verify `ProjectCheckReport.status` and `InitResult.proposal.result.globalPolicy` paths compile (they were read from the spec's reuse table) and fix import paths to match the actual exports.

- [ ] **Step 4: Run the integration test (iterate until green)**

Run: `HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1 npx vitest run tests/integration/onboard-steps.test.ts`
Expected: PASS (2 tests). Fix any signature mismatches surfaced by typecheck/test (see implementer note).

- [ ] **Step 5: typecheck + commit**

```bash
npm run typecheck
git add src/onboard/step-impls.ts tests/integration/onboard-steps.test.ts
git commit -m "feat: onboard concrete steps (profile/check/db/mcp/serve-smoke) (#92)"
```

---

## Task 5: CLI command + wiring (`src/cli/onboard.ts`)

Wires preflight + inspect (report-only) ahead of the write steps, runs the resume loop, enforces TTY, prints the final summary.

**Files:**
- Create: `src/cli/onboard.ts`
- Modify: `src/cli/run.ts` (import at ~:233, `registerOnboardCommands(program)` at ~:4157)
- Test: `tests/integration/onboard-cli.test.ts`

- [ ] **Step 1: Write the failing test (non-TTY fail-closed + happy path via injected prompts)**

```typescript
// tests/integration/onboard-cli.test.ts
import { afterEach, describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOnboard } from "../../src/cli/onboard.js";
import { scriptedPrompts } from "../../src/onboard/prompts.js";

const tmps: string[] = [];
afterEach(() => { for (const t of tmps.splice(0)) rmSync(t, { recursive: true, force: true }); });

function repoRoot(): { repo: string; root: string } {
  const repo = mkdtempSync(join(tmpdir(), "onb-cli-repo-")); tmps.push(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  mkdirSync(join(repo, "apps", "web"), { recursive: true });
  writeFileSync(join(repo, "apps", "web", "i.ts"), "export const x=1;\n");
  const root = mkdtempSync(join(tmpdir(), "onb-cli-root-")); tmps.push(root);
  mkdirSync(join(root, ".harness"), { recursive: true });
  return { repo, root };
}

describe("runOnboard", () => {
  it("drives the steps to completion with injected prompts (write profile=y, no mutations=n)", async () => {
    const { repo, root } = repoRoot();
    const result = await runOnboard({
      harnessRoot: root, repoPath: repo, projectId: "demo",
      isTTY: true, prompts: scriptedPrompts(["y", "n"]), // confirm write, decline mutations
    });
    expect(result.completed).toBe(true);
    expect(existsSync(join(root, "projects", "demo.yaml"))).toBe(true);
    expect(existsSync(join(root, ".harness", "mcp.yaml"))).toBe(true);
  });

  it("fails closed (no prompting) when not a TTY", async () => {
    const { repo, root } = repoRoot();
    await expect(
      runOnboard({ harnessRoot: root, repoPath: repo, projectId: "demo", isTTY: false, prompts: scriptedPrompts([]) }),
    ).rejects.toThrow(/not a TTY|interactive|non-interactive/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1 npx vitest run tests/integration/onboard-cli.test.ts`
Expected: FAIL — cannot find module `onboard.js`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/cli/onboard.ts
import type { Command } from "commander";
import { buildOnboardSteps } from "../onboard/step-impls.js";
import { firstPending, type OnboardCtx, type OnboardStep } from "../onboard/steps.js";
import { readlinePrompts, type Prompts } from "../onboard/prompts.js";

export interface RunOnboardOptions {
  harnessRoot: string;
  repoPath: string;
  projectId: string;
  isTTY: boolean;
  prompts: Prompts;
}

export interface OnboardOutcome {
  completed: boolean;
  log: string[];
}

export async function runOnboard(opts: RunOnboardOptions): Promise<OnboardOutcome> {
  if (!opts.isTTY) {
    throw new Error(
      "harness onboard is interactive and needs a TTY. In a non-interactive shell, " +
        "run the steps directly: project inspect/init, project check, db import --from-files, " +
        "then edit .harness/mcp.yaml (see docs/specs/cli.md).",
    );
  }
  const ctx: OnboardCtx = {
    harnessRoot: opts.harnessRoot, repoPath: opts.repoPath, projectId: opts.projectId,
    prompts: opts.prompts, log: [],
  };
  const steps = buildOnboardSteps();
  // Linear resume loop: run each non-done step in order; stop on blocked/failed.
  for (const step of steps) {
    const status = step.probe(ctx);
    if (status === "done") { ctx.log.push(`✓ ${step.title} (already done)`); continue; }
    if (status === "blocked") {
      process.stdout.write(`✗ ${step.title}: blocked\n`);
      return { completed: false, log: ctx.log };
    }
    process.stdout.write(`▸ ${step.title}\n  ${step.describe(ctx)}\n`);
    const res = await step.run(ctx);
    process.stdout.write(`  ${res.ok ? "✓" : "✗"} ${res.message}\n`);
    if (!res.ok) {
      if (res.remediation !== undefined) process.stdout.write(`  → ${res.remediation}\n`);
      return { completed: false, log: ctx.log };
    }
  }
  process.stdout.write(`\nOnboarding complete for "${opts.projectId}".\n`);
  return { completed: true, log: ctx.log };
}

export function registerOnboardCommands(program: Command): void {
  program
    .command("onboard")
    .description("interactive wizard to onboard a new target repo (#92)")
    .requiredOption("--repo <path>", "target repo path")
    .requiredOption("--project-id <id>", "project id to create")
    .action(async (raw: Record<string, unknown>) => {
      try {
        const outcome = await runOnboard({
          harnessRoot: process.env.HARNESS_ROOT ?? process.cwd(),
          repoPath: String(raw.repo),
          projectId: String(raw.projectId),
          isTTY: process.stdin.isTTY === true,
          prompts: readlinePrompts(),
        });
        if (!outcome.completed) process.exit(1);
      } catch (e) {
        process.stderr.write(`harness error: ${(e as Error).message}\n`);
        process.exit(1);
      }
    });
}
```

- [ ] **Step 4: Register the command in `src/cli/run.ts`**

Add near the other `register*Commands` imports (~line 233):
```typescript
import { registerOnboardCommands } from "./onboard.js";
```
Add near the other registrations (~line 4157, after `registerDbCommands(program);`):
```typescript
registerOnboardCommands(program);
```

- [ ] **Step 5: Run tests + typecheck**

Run: `HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1 npx vitest run tests/integration/onboard-cli.test.ts && npm run typecheck`
Expected: PASS (2 tests), typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/cli/onboard.ts src/cli/run.ts tests/integration/onboard-cli.test.ts
git commit -m "feat: wire 'harness onboard' command (TTY-gated resume loop) (#92)"
```

---

## Task 6: Docs

**Files:**
- Modify: `docs/specs/cli.md` (new `## harness onboard` section), `docs/specs/mcp.md` (note onboard generates `.harness/mcp.yaml` with deny-all + starter opt-in), `README.md` (quick-start pointer).

- [ ] **Step 1: Add the cli.md section**

Add a `## \`harness onboard\`` section documenting: `harness onboard --repo <path> --project-id <id>`; the step sequence (inspect → profile/policy → check → db import → mcp.yaml → serve smoke); TTY-required (non-TTY → fail-closed with the equivalent commands); idempotent/resumable; mutations deny-all by default with a guarded-mutation-client starter opt-in.

- [ ] **Step 2: Add the mcp.md note**

Under the MCP config section, note that `harness onboard` generates/merges `.harness/mcp.yaml` (deny-all mutations; opt-in writes a `guarded-mutation` client + allowlisted ops), and that an allow-all (`allowedProjects: []`) config is never silently narrowed.

- [ ] **Step 3: Add the README pointer**

Add a one-line pointer in the setup/quick-start area: "New target repo? `harness onboard --repo <path> --project-id <id>` walks the full setup."

- [ ] **Step 4: Run the full suite + typecheck**

Run: `npm run typecheck && HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1 npx vitest run --poolOptions.forks.maxForks=4 --poolOptions.forks.minForks=1`
Expected: full suite green, no regressions.

- [ ] **Step 5: Commit**

```bash
git add docs/specs/cli.md docs/specs/mcp.md README.md
git commit -m "docs: document 'harness onboard' wizard (#92)"
```

---

## Notes for the implementer

- **Signature verification first.** Before writing each step's `run`, open the reused module and confirm the exact export name/shape (the spec's reuse table cites them, but verify `InitResult.proposal.result.globalPolicy`, `ImportCounters` field names, `ProjectCheckReport.status`). Fix imports to match; do not invent fields.
- **Preflight + inspect steps** (codex/gh probe; domain-candidate display) are report-only and live in the CLI wiring (Task 5) or as two extra report-only steps prepended in `buildOnboardSteps`; they must never block except on a missing `HARNESS_ROOT`/repo. If you add them, give them `probe → "pending"` and a `run` that only logs. Keep them out of the write path so Task 4's integration tests stay focused.
- **No schema change.** Onboard only writes files and reads/imports via existing DB code. Do not add tables/migrations.
- **Safety invariants to keep green:** mutations deny-all unless opt-in writes BOTH a guarded-mutation client and ops; allow-all `allowedProjects` never silently narrowed; non-TTY fails closed; writes are confirm-gated; existing `.harness/mcp.yaml` fields preserved on merge.
```
