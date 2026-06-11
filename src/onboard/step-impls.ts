import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { harnessPaths } from "../config/paths.js";
import { openManagedDb } from "../db/managed-connection.js";
import { runMigrations } from "../db/migrations.js";
import { runProjectInit } from "../project/init.js";
import { checkProject } from "../project/checker.js";
import { importProjects } from "../db/import/projects.js";
import { emptyCounters } from "../db/import/common.js";
import { loadMcpConfig, defaultMcpConfigPath } from "../mcp/security/config.js";
import { isProjectAllowed, modeForClient, decideMcpPermission } from "../mcp/security/permissions.js";
import { mergeMcpConfig, type StarterOptIn } from "./mcp-config.js";
import { writeGlobalPolicyIfMissing, type OnboardStep, type OnboardCtx } from "./steps.js";

export function buildOnboardSteps(): OnboardStep[] {
  return [preflightStep(), profileStep(), checkStep(), dbStep(), mcpStep(), serveSmokeStep()];
}

function preflightStep(): OnboardStep {
  return {
    id: "preflight",
    title: "Preflight",
    probe: (ctx) => (existsSync(ctx.repoPath) ? "pending" : "blocked"),
    describe: (ctx) => `onboard ${ctx.repoPath} as project "${ctx.projectId}"`,
    run: async (ctx) => {
      const repoLine = `repo: ${ctx.repoPath}`;
      const codexLine = probeTool("codex", ["--version"]);
      const ghLine = probeTool("gh", ["auth", "status"]);
      ctx.log.push(repoLine);
      ctx.log.push(codexLine);
      ctx.log.push(ghLine);
      ctx.print(repoLine);
      ctx.print(codexLine);
      ctx.print(ghLine);
      return { ok: true, message: "preflight ok (codex/gh are reported, not required)" };
    },
  };
}

function probeTool(bin: string, args: string[]): string {
  try {
    execFileSync(bin, args, { stdio: "ignore" });
    return `${bin}: present`;
  } catch {
    return `${bin}: NOT found — install/authenticate before using the harness`;
  }
}

function profileStep(): OnboardStep {
  return {
    id: "profile",
    title: "Generate project profile + policy",
    probe: (ctx) => existsSync(harnessPaths(ctx.harnessRoot).projectProfilePath(ctx.projectId)) ? "done" : "pending",
    describe: (ctx) => `inspect ${ctx.repoPath} and write projects/${ctx.projectId}.yaml + policies/repos/<repo>.yaml`,
    run: async (ctx) => {
      const generatedAt = new Date().toISOString();
      const dry = await runProjectInit({
        harnessRoot: ctx.harnessRoot,
        projectId: ctx.projectId,
        repoPath: ctx.repoPath,
        write: false,
        force: false,
        generatedAt,
      });
      ctx.log.push(dry.profileYaml);
      ctx.print("Proposed profile:");
      ctx.print(dry.profileYaml);
      const ok = await ctx.prompts.confirm(`Write profile + policy for "${ctx.projectId}"?`);
      if (!ok) return { ok: false, message: "declined", remediation: "re-run when ready" };
      const res = await runProjectInit({
        harnessRoot: ctx.harnessRoot,
        projectId: ctx.projectId,
        repoPath: ctx.repoPath,
        write: true,
        force: false,
        generatedAt,
      });
      writeGlobalPolicyIfMissing(ctx.harnessRoot, res.proposal.result.globalPolicy);
      return { ok: true, message: `wrote ${res.written.length} file(s)` };
    },
  };
}

function checkStep(): OnboardStep {
  return {
    id: "check",
    title: "Validate the profile",
    probe: (ctx) => existsSync(harnessPaths(ctx.harnessRoot).projectProfilePath(ctx.projectId)) ? "pending" : "blocked",
    describe: () => "run project check (ok/warn/error)",
    run: async (ctx) => {
      const report = await checkProject({
        harnessRoot: ctx.harnessRoot,
        projectId: ctx.projectId,
        repoOverride: ctx.repoPath,
        generatedAt: new Date().toISOString(),
      });
      ctx.log.push(`check: ${report.status}`);
      if (report.status === "error") {
        return {
          ok: false,
          message: "check failed",
          remediation: "fix the profile (see project check output) and re-run",
        };
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
      } catch {
        return "pending";
      } finally {
        h.close();
      }
    },
    describe: () => "register the project DB-canonically (db import; runs migrations)",
    run: async (ctx) => {
      const paths = harnessPaths(ctx.harnessRoot);
      const h = openManagedDb({ dbPath: paths.dbPath });
      const counters = emptyCounters();
      try {
        runMigrations(h.db);
        importProjects(h.db, paths.projectsDir, counters);
      } finally {
        h.close();
      }
      if (counters.errors > 0) {
        return {
          ok: false,
          message: "db import had errors",
          remediation: "see project profile; fix and re-run",
        };
      }
      return { ok: true, message: "project imported" };
    },
  };
}

function mcpStep(): OnboardStep {
  return {
    id: "mcp",
    title: "Configure MCP access",
    probe: (ctx) =>
      isProjectAllowed(loadMcpConfig({ harnessRoot: ctx.harnessRoot }), ctx.projectId) &&
      existsSync(defaultMcpConfigPath(ctx.harnessRoot))
        ? "done"
        : "pending",
    describe: (ctx) => `add "${ctx.projectId}" to .harness/mcp.yaml (mutations stay deny-all unless you opt in)`,
    run: async (ctx) => {
      const path = defaultMcpConfigPath(ctx.harnessRoot);
      const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
      // warn if a profile-embedded mcp config will be shadowed by the new file.
      if (existing === null) {
        const eff = loadMcpConfig({ harnessRoot: ctx.harnessRoot });
        if (eff.clients.length > 0 || eff.allowedOperations.length > 0) {
          const warning = "note: a profiles/*.yaml mcp section exists; .harness/mcp.yaml will take precedence";
          ctx.log.push(warning);
          ctx.print(warning);
        }
      }
      const existingProjectIds = listProjectIds(ctx);
      let starter: StarterOptIn | null = null;
      if (await ctx.prompts.confirm("Enable MCP mutations for a client? (otherwise read-only/dry-run)")) {
        const clientName = await ctx.prompts.input("client name", "codex");
        const operations: string[] = [];
        if (await ctx.prompts.confirm("Allow goal.start (start a goal session)?")) operations.push("goal.start");
        if (await ctx.prompts.confirm("Allow run.start (starts a codex run — incurs cost)?")) operations.push("run.start");
        if (operations.length > 0) starter = { clientName, operations };
      }
      let allowAll: "keep" | "enumerate" = "keep";
      const cfgNow = loadMcpConfig({ harnessRoot: ctx.harnessRoot });
      if (existing !== null && cfgNow.allowedProjects.length === 0) {
        allowAll = (await ctx.prompts.confirm("Existing config allows ALL projects. Switch to an explicit list?"))
          ? "enumerate"
          : "keep";
      }
      const { yaml, report } = mergeMcpConfig(existing, {
        projectId: ctx.projectId,
        existingProjectIds,
        starter,
        allowAll,
      });
      ctx.print("Proposed .harness/mcp.yaml:");
      ctx.print(yaml);
      const confirmWrite = await ctx.prompts.confirm("Write this .harness/mcp.yaml?");
      if (!confirmWrite) {
        return { ok: false, message: "declined", remediation: "re-run when ready" };
      }
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
    probe: () => "pending",
    describe: () => "evaluate effective MCP config (no daemon)",
    run: async (ctx) => {
      const cfg = loadMcpConfig({ harnessRoot: ctx.harnessRoot });
      const visible = isProjectAllowed(cfg, ctx.projectId);
      const lines = [`project visible: ${visible}`];
      const firstClient = cfg.clients[0]?.names[0];
      if (firstClient !== undefined) {
        const mode = modeForClient(cfg, firstClient);
        const d = decideMcpPermission(cfg, {
          toolName: "harness.goal.start",
          kind: "mutation",
          projectId: ctx.projectId,
          clientMode: mode,
        });
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
  } catch {
    return [ctx.projectId];
  } finally {
    h.close();
  }
}
