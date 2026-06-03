import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGlobalPolicy, loadRepoPolicy } from "../../src/policy/loader.js";
import { resolvePolicy } from "../../src/policy/resolver.js";
import { loadProjectProfile } from "../../src/project/profile-loader.js";
import {
  loadCompileInputs,
  compileProjectPolicy,
} from "../../src/project/policy-compiler.js";
import { serializeRepoPolicyYaml } from "../../src/project/policy-proposal.js";
import { parseProvenance } from "../../src/project/provenance.js";

const ROOT = process.cwd();
const CLI = join(ROOT, "src/cli/run.ts");

/** compare the policy-scope fields that resolvePolicy is authoritative for */
function scope(p: ReturnType<typeof resolvePolicy>) {
  return JSON.stringify({
    read: [...p.read].sort(),
    write: [...p.write].sort(),
    denyWrite: [...p.denyWrite].sort(),
    commands: p.allowedCommands,
    commandDefaults: p.commandDefaults,
  });
}

async function compileCommittedProfile() {
  const profile = await loadProjectProfile(
    join(ROOT, "projects/mini-commerce.yaml"),
  );
  const inputs = await loadCompileInputs(
    profile,
    "projects/mini-commerce.yaml",
    {
      templatesDir: join(ROOT, "templates"),
      generatedAt: "2026-05-22T00:00:00.000Z",
    },
  );
  return compileProjectPolicy(inputs);
}

describe("mini-commerce project profile (Phase 5-8)", () => {
  it("E5-8-1: the profile compiles to a policy equivalent to the committed one", async () => {
    const compiled = await compileCommittedProfile();
    const global = await loadGlobalPolicy(join(ROOT, "policies/global.yaml"));
    const repo = await loadRepoPolicy(
      join(ROOT, "policies/repos/mini-commerce.yaml"),
    );
    for (const domain of Object.keys(repo.domains)) {
      const fromFiles = resolvePolicy(global, repo, domain);
      const fromProfile = resolvePolicy(
        compiled.globalPolicy,
        compiled.repoPolicy,
        domain,
      );
      expect(scope(fromProfile)).toBe(scope(fromFiles));
    }
  });

  it("E5-8-1b: the committed generated policy + sidecar are NOT drifted from the profile", async () => {
    const compiled = await compileCommittedProfile();
    // exact-byte comparison — catches any divergence the resolved-scope
    // check above would miss (extra domain, YAML reordering, etc.).
    expect(serializeRepoPolicyYaml(compiled.repoPolicy)).toBe(
      readFileSync(join(ROOT, "policies/repos/mini-commerce.yaml"), "utf8"),
    );
    const sidecar = parseProvenance(
      readFileSync(
        join(ROOT, "policies/repos/mini-commerce.generated.json"),
        "utf8",
      ),
    );
    expect(sidecar).not.toBeNull();
    expect({ ...sidecar, generatedAt: "" }).toEqual({
      ...compiled.provenance,
      generatedAt: "",
    });
  });

  it("E5-8-2: run --project mini-commerce --dry-run resolves the policy", () => {
    // The committed profile's repo.path points outside the repo (../../mini-
    // commerce) and is absent on CI / fresh checkouts. Override it with a
    // self-contained fixture repo so the test does not depend on the local
    // working-tree layout; --dry-run only resolves policy (no codex, no commit).
    const repo = mkdtempSync(join(tmpdir(), "harness-mc-dry-"));
    mkdirSync(join(repo, "apps/catalog"), { recursive: true });
    const out = execFileSync(
      "node",
      [
        "--import",
        "tsx",
        CLI,
        "run",
        "--project",
        "mini-commerce",
        "--repo",
        repo,
        "--domain",
        "apps/catalog",
        "--goal",
        "noop",
        "--dry-run",
      ],
      { env: { ...process.env, HARNESS_ROOT: ROOT } },
    ).toString();
    expect(out).toMatch(/resolved policy for apps\/catalog/);
  });

  it("E5-8-3: project check --project mini-commerce passes (status ok)", () => {
    // a fixture repo whose layout satisfies every check (domain roots +
    // the default-docs context pack globs).
    const repo = mkdtempSync(join(tmpdir(), "harness-mc-"));
    for (const d of [
      "apps/catalog",
      "apps/orders",
      "docs",
      "packages/contracts",
      "packages/shared",
    ]) {
      mkdirSync(join(repo, d), { recursive: true });
    }
    writeFileSync(join(repo, "README.md"), "# mini-commerce\n");
    writeFileSync(join(repo, "docs/guide.md"), "guide\n");
    writeFileSync(join(repo, "packages/contracts/api.ts"), "export {};\n");
    writeFileSync(join(repo, "packages/shared/util.ts"), "export {};\n");
    execFileSync("git", ["init", "-b", "main", repo]);
    execFileSync("git", ["-C", repo, "add", "-A"]);
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.email=t@e.com",
      "-c",
      "user.name=t",
      "commit",
      "-m",
      "init",
    ]);
    const out = execFileSync(
      "node",
      [
        "--import",
        "tsx",
        CLI,
        "project",
        "check",
        "--project",
        "mini-commerce",
        "--repo",
        repo,
      ],
      { env: { ...process.env, HARNESS_ROOT: ROOT } },
    ).toString();
    expect(out).toMatch(/status: ok/);
    expect(out).toMatch(/generated policy in sync/);
  });
});
