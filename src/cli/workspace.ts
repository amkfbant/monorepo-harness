import process from "node:process";
import { basename, dirname, join, resolve } from "node:path";
import type { Command } from "commander";
import { harnessPaths } from "../config/paths.js";
import { openManagedDb } from "../db/managed-connection.js";
import { runMigrations } from "../db/migrations.js";
import { WorkspaceRepository } from "../db/repositories/workspaces.js";
import { gitCli } from "../git/git-cli.js";
import { ConvergenceService } from "../hitch/convergence.js";
import { HitchRepository } from "../hitch/repository.js";
import { adoptAgentWorkspace, AgentWorkspaceError, canonicalRepoKey, changedFilesForWorkspace, createAgentWorkspace, inspectAgentWorkspace, normalizeWorktreePath, removeAgentWorkspace, resolveMainWorktree, type AgentWorkspace } from "../workspace/agent-workspace.js";
import { createDetachedWorktree, removeDetachedWorktree } from "../workspace/git-worktree.js";
import { findWorkspaceConflicts, type WorkspaceChangedFiles } from "../workspace/workspace-conflicts.js";
import { reconcileWorkspaces } from "../workspace/workspace-reconcile.js";
import { buildRecoveryBriefing, type RecoveryHitch } from "../workspace/workspace-recover.js";
import { assembleWorkspaceStatuses, readWorkspaceStatusData } from "../workspace/workspace-status-builder.js";

/**
 * `harness workspace`（per-agent isolated git worktree の管理・並行安全）を run.ts から
 * behavior-zero で抽出。group 内 helper（workspaceRepoPath/workspacesDirFor/
 * resolveWorkspaceCtx/withWorkspaceErrorExit/resolveLiveWorkspace/withWorkspaceRepo）を同梱。
 * domain-lock / worktree の並行安全ロジックを byte-fidelity 保持。getHarnessRoot は opts 経由。
 */
export function registerWorkspaceCommands(
  program: Command,
  opts: { getHarnessRoot: () => string },
): void {
  const getHarnessRoot = opts.getHarnessRoot;
  function workspaceRepoPath(raw: Record<string, unknown>): string {
    return resolve(typeof raw.repo === "string" && raw.repo !== "" ? raw.repo : process.cwd());
  }

  /** Default location for per-agent worktrees: a sibling `<repo>.agents/` dir. */
  function workspacesDirFor(repoPath: string, raw: Record<string, unknown>): string {
    if (typeof raw.dir === "string" && raw.dir !== "") return resolve(raw.dir);
    return join(dirname(repoPath), `${basename(repoPath)}.agents`);
  }

  /**
   * Resolve the stable git context for a workspace command: the MAIN worktree
   * (so a subdir / symlink / worktree invocation all normalize to one location
   * that survives removing an agent worktree) plus the worktrees dir.
   */
  async function resolveWorkspaceCtx(
    raw: Record<string, unknown>,
  ): Promise<{ repoPath: string; workspacesDir: string }> {
    const repoPath = await resolveMainWorktree({
      repoPath: workspaceRepoPath(raw),
    });
    return { repoPath, workspacesDir: workspacesDirFor(repoPath, raw) };
  }

  function withWorkspaceErrorExit(e: unknown): never {
    if (e instanceof AgentWorkspaceError) {
      process.stderr.write(`harness error: ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }

  /**
   * Resolve a single agent's LIVE workspace path-first (reconciled), so the agent
   * commands (inspect / checkpoint / recover / remove) work for adopted
   * non-`agent/*` worktrees too — not just the `agent/*` convention. Returns null
   * when the agent has no live worktree.
   */
  async function resolveLiveWorkspace(
    repoPath: string,
    workspacesDir: string,
    repoKey: string,
    agent: string,
  ): Promise<AgentWorkspace | null> {
    const rows = withWorkspaceRepo((repo) => repo.listByRepo(repoKey));
    const { live } = await reconcileWorkspaces({ repoPath, workspacesDir }, rows);
    return live.find((w) => w.agent === agent) ?? null;
  }

  /**
   * Run a function against the shared workspace DB index (HARNESS_ROOT/.harness).
   * git stays the source of truth for a worktree's existence; this row carries
   * the harness-side metadata (objective / advisory hitch link / heartbeat).
   */
  function withWorkspaceRepo<T>(
    fn: (repo: WorkspaceRepository, db: ReturnType<typeof openManagedDb>["db"]) => T,
  ): T {
    const handle = openManagedDb({
      dbPath: harnessPaths(getHarnessRoot()).dbPath,
    });
    try {
      runMigrations(handle.db);
      return fn(new WorkspaceRepository(handle.db), handle.db);
    } finally {
      handle.close();
    }
  }

  const workspaceCmd = program
    .command("workspace")
    .description(
      "manage per-agent isolated git worktrees for concurrent multi-agent work",
    );

  workspaceCmd
    .command("create")
    .description(
      "create (or return) an isolated worktree on the agent/<name> branch",
    )
    .argument("<agent>", "agent name (used as the branch suffix and directory)")
    .option("--repo <path>", "the project repo (default: current directory)")
    .option("--base <commit-ish>", "branch base for a new agent branch", "HEAD")
    .option("--dir <dir>", "where to place agent worktrees (default: <repo>.agents)")
    .option("--json", "emit JSON instead of text", false)
    .action(async (agent: string, raw: Record<string, unknown>) => {
      try {
        const { repoPath, workspacesDir } = await resolveWorkspaceCtx(raw);
        const ws = await createAgentWorkspace(
          { repoPath, workspacesDir },
          { agent, base: String(raw.base ?? "HEAD") },
        );
        // Track the worktree in the shared DB index (git remains the source of
        // truth for its existence; this row carries harness-side metadata). Key
        // by the canonical git identity so the same repo is one row regardless of
        // how it is reached (subdir / symlink / worktree).
        const repoKey = await canonicalRepoKey({ repoPath });
        withWorkspaceRepo((repo) =>
          repo.upsert({
            agent,
            repoPath: repoKey,
            branch: ws.branch,
            worktreePath: ws.path,
          }),
        );
        if (raw.json === true) {
          process.stdout.write(`${JSON.stringify(ws, null, 2)}\n`);
          return;
        }
        const sharedRoot = getHarnessRoot();
        process.stdout.write(
          `${ws.created ? "created" : "exists"} workspace for agent "${agent}"\n` +
            `  path:   ${ws.path}\n` +
            `  branch: ${ws.branch}\n\n` +
            `Start the agent here, sharing the harness state DB:\n` +
            `  cd ${ws.path}\n` +
            `  export HARNESS_ROOT=${sharedRoot}\n`,
        );
      } catch (e) {
        withWorkspaceErrorExit(e);
      }
    });

  workspaceCmd
    .command("verify-pr")
    .description(
      "check out a PR head in a DETACHED (branch-free) worktree for verification, " +
        "avoiding the 'branch already used by worktree' conflict a run worktree causes (#82)",
    )
    .argument("<number>", "PR number")
    .option("--repo <path>", "the project repo (default: current directory)")
    .option("--remote <name>", "remote to fetch the PR head from", "origin")
    .option("--rm", "remove the verify worktree for this PR instead of creating it", false)
    .option("--json", "emit JSON instead of text", false)
    .action(async (number: string, raw: Record<string, unknown>) => {
      try {
        if (!/^\d+$/.test(number)) {
          throw new AgentWorkspaceError(`PR number must be a positive integer: ${number}`);
        }
        const { repoPath, workspacesDir } = await resolveWorkspaceCtx(raw);
        const worktreePath = join(workspacesDir, `verify-pr-${number}`, "repo");
        if (raw.rm === true) {
          await removeDetachedWorktree({ repoPath, worktreePath });
          process.stdout.write(
            raw.json === true
              ? `${JSON.stringify({ removed: worktreePath }, null, 2)}\n`
              : `removed verify worktree: ${worktreePath}\n`,
          );
          return;
        }
        // GitHub exposes a PR head at refs/pull/<n>/head on the origin remote.
        const remote = String(raw.remote ?? "origin");
        // Fetch into a PR-specific local ref (not the shared FETCH_HEAD), so two
        // concurrent verify-pr runs in the same repo cannot race — a plain
        // `rev-parse FETCH_HEAD` could read another PR's just-fetched head. `--`
        // stops git option parsing so a `--remote=--upload-pack=…` value is treated
        // as a remote name, not a git flag (argument-injection surface).
        const localRef = `refs/harness/verify-pr/${number}`;
        const fetched = await gitCli(
          ["fetch", "--", remote, `+pull/${number}/head:${localRef}`],
          { cwd: repoPath },
        );
        if (fetched.exitCode !== 0) {
          throw new AgentWorkspaceError(
            `failed to fetch pull/${number}/head from "${remote}": ${fetched.stderr.trim()}`,
          );
        }
        const rev = await gitCli(["rev-parse", localRef], { cwd: repoPath });
        if (rev.exitCode !== 0) {
          throw new AgentWorkspaceError(
            `failed to resolve fetched PR head: ${rev.stderr.trim()}`,
          );
        }
        const sha = rev.stdout.trim();
        const { path } = await createDetachedWorktree({
          repoPath,
          worktreePath,
          commitish: sha,
        });
        process.stdout.write(
          raw.json === true
            ? `${JSON.stringify({ pr: Number(number), sha, path }, null, 2)}\n`
            : `verify worktree for PR #${number} (detached at ${sha.slice(0, 12)}):\n` +
                `  path: ${path}\n\n` +
                `Inspect read-only, then remove it with:\n` +
                `  harness workspace verify-pr ${number} --rm${raw.repo !== undefined ? ` --repo ${String(raw.repo)}` : ""}\n`,
        );
      } catch (e) {
        withWorkspaceErrorExit(e);
      }
    });

  workspaceCmd
    .command("adopt")
    .description(
      "register an EXISTING git worktree as an agent (any branch; never creates)",
    )
    .argument("<agent>", "agent name")
    .requiredOption("--worktree <path>", "path to an existing worktree of the repo")
    .option("--repo <path>", "the project repo (default: current directory)")
    .option("--json", "emit JSON instead of text", false)
    .action(async (agent: string, raw: Record<string, unknown>) => {
      try {
        const repoPath = await resolveMainWorktree({
          repoPath: workspaceRepoPath(raw),
        });
        const repoKey = await canonicalRepoKey({ repoPath });
        const ws = await adoptAgentWorkspace(
          { repoPath, workspacesDir: workspacesDirFor(repoPath, raw) },
          { agent, worktreePath: String(raw.worktree) },
        );
        withWorkspaceRepo((repo) => {
          // one-agent-per-path and one-worktree-per-agent: a collision would let
          // reconcile emit the same worktree twice or orphan an existing tree.
          const rows = repo.listByRepo(repoKey);
          const byOtherAgent = rows.find(
            (r) => r.worktreePath === ws.path && r.agent !== agent,
          );
          if (byOtherAgent !== undefined) {
            throw new AgentWorkspaceError(
              `worktree ${ws.path} is already adopted by agent "${byOtherAgent.agent}"`,
            );
          }
          const existing = rows.find((r) => r.agent === agent);
          if (existing !== undefined && existing.worktreePath !== ws.path) {
            throw new AgentWorkspaceError(
              `agent "${agent}" already has a workspace at ${existing.worktreePath}; ` +
                `remove it first or use a different agent name`,
            );
          }
          repo.upsert({
            agent,
            repoPath: repoKey,
            branch: ws.branch,
            worktreePath: ws.path,
          });
        });
        if (raw.json === true) {
          process.stdout.write(`${JSON.stringify(ws, null, 2)}\n`);
          return;
        }
        process.stdout.write(
          `adopted worktree as agent "${agent}"\n` +
            `  path:   ${ws.path}\n` +
            `  branch: ${ws.branch}\n`,
        );
      } catch (e) {
        withWorkspaceErrorExit(e);
      }
    });

  workspaceCmd
    .command("list")
    .description("list workspaces: agent/* worktrees + adopted (any-branch)")
    .option("--repo <path>", "the project repo (default: current directory)")
    .option("--json", "emit JSON instead of text", false)
    .action(async (raw: Record<string, unknown>) => {
      try {
        const { repoPath, workspacesDir } = await resolveWorkspaceCtx(raw);
        const repoKey = await canonicalRepoKey({ repoPath });
        const rows = withWorkspaceRepo((repo) => repo.listByRepo(repoKey));
        // reconcile by worktree path: agent/* worktrees + adopted (any-branch) rows.
        const { live, recordByPath, stale } = await reconcileWorkspaces(
          { repoPath, workspacesDir },
          rows,
        );
        const enriched = live.map((w) => {
          // attribute by exact live path, not agent name (see reconcile docs).
          const r = recordByPath.get(normalizeWorktreePath(w.path)) ?? null;
          return {
            ...w,
            hitchId: r?.hitchId ?? null,
            objective: r?.objective ?? null,
            lastActiveAt: r?.lastActiveAt ?? null,
          };
        });
        if (raw.json === true) {
          process.stdout.write(
            `${JSON.stringify({ workspaces: enriched, stale }, null, 2)}\n`,
          );
          return;
        }
        if (enriched.length === 0 && stale.length === 0) {
          process.stdout.write("no agent workspaces\n");
          return;
        }
        for (const w of enriched) {
          const hitchTag = w.hitchId ? ` hitch=${w.hitchId}` : "";
          const obj = w.objective ? ` — ${w.objective}` : "";
          process.stdout.write(`${w.agent}\t${w.branch}\t${w.path}${hitchTag}${obj}\n`);
        }
        for (const r of stale) {
          process.stdout.write(
            `${r.agent}\t${r.branch}\t(stale: worktree missing; run 'harness workspace remove ${r.agent}' to clear)\n`,
          );
        }
      } catch (e) {
        withWorkspaceErrorExit(e);
      }
    });

  workspaceCmd
    .command("inspect")
    .description(
      "deterministic git briefing of an agent's workspace (branch / dirty / ahead-behind)",
    )
    .argument("<agent>", "agent name")
    .option("--repo <path>", "the project repo (default: current directory)")
    .option("--dir <dir>", "where agent worktrees live (default: <repo>.agents)")
    .option("--base <commit-ish>", "compare ahead/behind against this ref", "main")
    .option("--json", "emit JSON instead of text", false)
    .action(async (agent: string, raw: Record<string, unknown>) => {
      try {
        const { repoPath, workspacesDir } = await resolveWorkspaceCtx(raw);
        const repoKey = await canonicalRepoKey({ repoPath });
        const ws = await resolveLiveWorkspace(repoPath, workspacesDir, repoKey, agent);
        if (ws === null) {
          throw new AgentWorkspaceError(`no workspace for agent "${agent}"`);
        }
        const insp = await inspectAgentWorkspace(
          { repoPath, workspacesDir },
          { agent, base: String(raw.base ?? "main"), workspace: ws },
        );
        if (raw.json === true) {
          process.stdout.write(`${JSON.stringify(insp, null, 2)}\n`);
          return;
        }
        const aheadBehind = insp.baseResolved
          ? `${insp.ahead} ahead / ${insp.behind} behind (vs ${insp.base})`
          : `base "${insp.base}" not found`;
        const last = insp.lastCommit
          ? `${insp.lastCommit.sha.slice(0, 8)} ${insp.lastCommit.subject}`
          : "(none)";
        const dirty =
          insp.dirtyFiles.length === 0
            ? "clean"
            : `${insp.dirtyFiles.length} uncommitted: ` +
              insp.dirtyFiles.slice(0, 10).join(", ") +
              (insp.dirtyFiles.length > 10 ? ", …" : "");
        process.stdout.write(
          `workspace "${insp.agent}" (${insp.branch})\n` +
            `  path:         ${insp.path}\n` +
            `  last commit:  ${last}\n` +
            `  vs base:      ${aheadBehind}\n` +
            `  working tree: ${dirty}\n`,
        );
      } catch (e) {
        withWorkspaceErrorExit(e);
      }
    });

  workspaceCmd
    .command("conflicts")
    .description(
      "find agent workspaces that have changed the same files (overlap pre-check)",
    )
    .option("--repo <path>", "the project repo (default: current directory)")
    .option("--dir <dir>", "where agent worktrees live (default: <repo>.agents)")
    .option("--base <commit-ish>", "base ref for committed-ahead changes", "main")
    .option("--json", "emit JSON instead of text", false)
    .action(async (raw: Record<string, unknown>) => {
      try {
        const { repoPath, workspacesDir } = await resolveWorkspaceCtx(raw);
        const repoKey = await canonicalRepoKey({ repoPath });
        const rows = withWorkspaceRepo((repo) => repo.listByRepo(repoKey));
        const { live } = await reconcileWorkspaces(
          { repoPath, workspacesDir },
          rows,
        );
        const entries: WorkspaceChangedFiles[] = [];
        for (const w of live) {
          entries.push({
            agent: w.agent,
            files: await changedFilesForWorkspace(
              { repoPath, workspacesDir },
              { agent: w.agent, base: String(raw.base ?? "main"), workspace: w },
            ),
          });
        }
        const conflicts = findWorkspaceConflicts(entries);
        if (raw.json === true) {
          process.stdout.write(`${JSON.stringify({ conflicts }, null, 2)}\n`);
          return;
        }
        if (conflicts.length === 0) {
          process.stdout.write(
            `no overlapping changes across ${entries.length} workspace(s)\n`,
          );
          return;
        }
        for (const c of conflicts) {
          process.stdout.write(
            `${c.a} ⨯ ${c.b}: ${c.files.length} shared file(s)\n` +
              c.files.map((f) => `    ${f}`).join("\n") +
              "\n",
          );
        }
      } catch (e) {
        withWorkspaceErrorExit(e);
      }
    });

  workspaceCmd
    .command("status")
    .description(
      "at-a-glance progress of every agent workspace (deterministic projection)",
    )
    .option("--repo <path>", "the project repo (default: current directory)")
    .option("--dir <dir>", "where agent worktrees live (default: <repo>.agents)")
    .option("--base <commit-ish>", "base ref for ahead/behind", "main")
    .option(
      "--stale-after <hours>",
      "flag a workspace whose heartbeat is older than this many hours",
      "24",
    )
    .option("--json", "emit JSON instead of text", false)
    .action(async (raw: Record<string, unknown>) => {
      try {
        const { repoPath, workspacesDir } = await resolveWorkspaceCtx(raw);
        const repoKey = await canonicalRepoKey({ repoPath });
        const nowMs = Date.now();
        const rawStaleAfter = raw.staleAfter ?? "24";
        // reject a blank string explicitly: Number("") / Number("  ") === 0 would
        // otherwise silently flag every workspace as idle.
        const staleHours =
          typeof rawStaleAfter === "string" && rawStaleAfter.trim() === ""
            ? NaN
            : Number(rawStaleAfter);
        if (!Number.isFinite(staleHours) || staleHours < 0) {
          throw new AgentWorkspaceError(
            `--stale-after must be a non-negative number of hours (got ${JSON.stringify(raw.staleAfter)})`,
          );
        }
        // read DB facts in one short window, then CLOSE the handle before the
        // (slow) git inspections — no DB lock is held during git work.
        const handle = openManagedDb({
          dbPath: harnessPaths(getHarnessRoot()).dbPath,
        });
        let data;
        try {
          runMigrations(handle.db);
          data = readWorkspaceStatusData(handle.db, repoKey);
        } finally {
          handle.close();
        }
        const statuses = await assembleWorkspaceStatuses(
          { repoPath, workspacesDir },
          data,
          {
            base: String(raw.base ?? "main"),
            nowMs,
            staleThresholdMs: staleHours * 3_600_000,
            repoKey, // verify each worktree still belongs to this repo
          },
        );
        if (raw.json === true) {
          process.stdout.write(`${JSON.stringify(statuses, null, 2)}\n`);
          return;
        }
        if (statuses.length === 0) {
          process.stdout.write("no agent workspaces\n");
          return;
        }
        for (const s of statuses) {
          const git =
            s.git === null
              ? "worktree-missing"
              : s.git.baseResolved
                ? `+${s.git.ahead}/-${s.git.behind} ${s.git.dirtyCount}dirty`
                : `base? ${s.git.dirtyCount}dirty`;
          const hitchCol = s.hitchId ? `${s.hitchId}${s.hitchDecision ? `:${s.hitchDecision}` : ":missing"}` : "-";
          const obj = s.objective ? ` — ${s.objective}` : "";
          const active = `${s.lastActiveAt ?? "-"}${s.staleHeartbeat ? " ⚠idle" : ""}`;
          process.stdout.write(
            `${s.agent}\t${s.label}\t${git}\t${hitchCol}\t${active}${obj}\n`,
          );
        }
      } catch (e) {
        withWorkspaceErrorExit(e);
      }
    });

  workspaceCmd
    .command("checkpoint")
    .description(
      "save an advisory checkpoint (LLM note + a deterministic state snapshot)",
    )
    .argument("<agent>", "agent name")
    .option("--repo <path>", "the project repo (default: current directory)")
    .option("--dir <dir>", "where agent worktrees live (default: <repo>.agents)")
    .option("--base <commit-ish>", "base ref for the state snapshot", "main")
    .option("--note <text>", "advisory narrative (what / why / next steps)")
    .option("--hitch <hitch-id>", "link an advisory hitch to the workspace")
    .option("--objective <text>", "set the workspace's objective")
    .option("--by <actor>", "actor recorded on the checkpoint", "cli")
    .option("--json", "emit JSON instead of text", false)
    .action(async (agent: string, raw: Record<string, unknown>) => {
      try {
        const { repoPath, workspacesDir } = await resolveWorkspaceCtx(raw);
        const repoKey = await canonicalRepoKey({ repoPath });
        const ws = await resolveLiveWorkspace(repoPath, workspacesDir, repoKey, agent);
        if (ws === null) {
          throw new AgentWorkspaceError(
            `no workspace for agent "${agent}"; run 'harness workspace create ${agent}' first`,
          );
        }
        const insp = await inspectAgentWorkspace(
          { repoPath, workspacesDir },
          { agent, base: String(raw.base ?? "main"), workspace: ws },
        );
        const hitchId = typeof raw.hitch === "string" ? raw.hitch : null;
        const checkpoint = withWorkspaceRepo((repo) => {
          // ensure the workspace is tracked, then record the advisory checkpoint.
          const record = repo.upsert({
            agent,
            repoPath: repoKey,
            branch: ws.branch,
            worktreePath: ws.path,
          });
          if (hitchId !== null) repo.linkHitch(repoKey, agent, hitchId);
          if (typeof raw.objective === "string") {
            repo.setObjective(repoKey, agent, raw.objective);
          }
          return repo.recordCheckpoint({
            workspaceId: record.workspaceId,
            note: typeof raw.note === "string" ? raw.note : null,
            headSha: insp.head,
            dirtyCount: insp.dirtyFiles.length,
            hitchId: hitchId ?? record.hitchId,
            createdBy: String(raw.by ?? "cli"),
          });
        });
        if (raw.json === true) {
          process.stdout.write(`${JSON.stringify(checkpoint, null, 2)}\n`);
          return;
        }
        process.stdout.write(
          `checkpoint saved for agent "${agent}"\n` +
            `  head:  ${checkpoint.headSha ? checkpoint.headSha.slice(0, 8) : "(none)"}\n` +
            `  dirty: ${checkpoint.dirtyCount} file(s)\n` +
            (checkpoint.hitchId ? `  hitch: ${checkpoint.hitchId}\n` : "") +
            (checkpoint.note ? `  note:  ${checkpoint.note}\n` : ""),
        );
      } catch (e) {
        withWorkspaceErrorExit(e);
      }
    });

  workspaceCmd
    .command("recover")
    .description(
      "reconstruct a workspace's state (git + linked hitch) and recommend next steps",
    )
    .argument("<agent>", "agent name")
    .option("--repo <path>", "the project repo (default: current directory)")
    .option("--dir <dir>", "where agent worktrees live (default: <repo>.agents)")
    .option("--base <commit-ish>", "base ref for ahead/behind", "main")
    .option("--json", "emit JSON instead of text", false)
    .action(async (agent: string, raw: Record<string, unknown>) => {
      try {
        const { repoPath, workspacesDir } = await resolveWorkspaceCtx(raw);
        const repoKey = await canonicalRepoKey({ repoPath });
        const ws = await resolveLiveWorkspace(repoPath, workspacesDir, repoKey, agent);
        if (ws === null) {
          throw new AgentWorkspaceError(
            `no workspace for agent "${agent}"; run 'harness workspace create ${agent}' first`,
          );
        }
        const inspection = await inspectAgentWorkspace(
          { repoPath, workspacesDir },
          { agent, base: String(raw.base ?? "main"), workspace: ws },
        );
        const { objective, hitch, latestCheckpoint } = withWorkspaceRepo(
          (wsRepo, db) => {
            const record = wsRepo.get(repoKey, agent);
            const latest =
              record === null
                ? null
                : wsRepo.latestCheckpoint(record.workspaceId);
            let hitchSummary: RecoveryHitch | null = null;
            if (record?.hitchId != null) {
              const hitchRepo = new HitchRepository(db);
              // a dangling advisory link (hitch deleted) → convergence stays null.
              const exists = hitchRepo.getSession(record.hitchId) !== null;
              hitchSummary = {
                hitchId: record.hitchId,
                convergence: exists
                  ? (() => {
                      const c = new ConvergenceService(hitchRepo).evaluate(
                        record.hitchId as string,
                      );
                      return {
                        decision: c.decision,
                        reason: c.reason,
                        nextActionKind: c.recommendedNextAction.kind,
                      };
                    })()
                  : null,
              };
            }
            return {
              objective: record?.objective ?? null,
              hitch: hitchSummary,
              latestCheckpoint:
                latest === null
                  ? null
                  : {
                      note: latest.note,
                      createdAt: latest.createdAt,
                      createdBy: latest.createdBy,
                    },
            };
          },
        );
        const briefing = buildRecoveryBriefing({
          inspection,
          objective,
          hitch,
          latestCheckpoint,
        });
        if (raw.json === true) {
          process.stdout.write(`${JSON.stringify(briefing, null, 2)}\n`);
          return;
        }
        const insp = briefing.inspection;
        const gitLine = insp.baseResolved
          ? `${insp.ahead} ahead / ${insp.behind} behind ${insp.base}, ${insp.dirtyFiles.length} uncommitted`
          : `base "${insp.base}" not found, ${insp.dirtyFiles.length} uncommitted`;
        const hitchLine =
          briefing.hitch === null
            ? "(none)"
            : briefing.hitch.convergence === null
              ? `${briefing.hitch.hitchId} (no longer exists)`
              : `${briefing.hitch.hitchId} — ${briefing.hitch.convergence.decision} (${briefing.hitch.convergence.reason})`;
        const cp = briefing.latestCheckpoint;
        process.stdout.write(
          `recover "${agent}" (${insp.branch})\n` +
            `  git:        ${gitLine}\n` +
            `  objective:  ${briefing.objective ?? "(none)"}\n` +
            `  hitch:      ${hitchLine}\n` +
            `  checkpoint: ${cp ? `${cp.createdAt} by ${cp.createdBy}${cp.note ? ` — ${cp.note}` : ""}` : "(none)"}\n` +
            `  next steps:\n` +
            briefing.nextSteps.map((s) => `    - ${s}`).join("\n") +
            "\n",
        );
      } catch (e) {
        withWorkspaceErrorExit(e);
      }
    });

  workspaceCmd
    .command("remove")
    .description("remove an agent's worktree (and its branch)")
    .argument("<agent>", "agent name")
    .option("--repo <path>", "the project repo (default: current directory)")
    .option("--dir <dir>", "where agent worktrees live (default: <repo>.agents)")
    .option("--force", "discard uncommitted changes in the worktree", false)
    .option("--keep-branch", "remove the worktree but keep the agent/<name> branch", false)
    .action(async (agent: string, raw: Record<string, unknown>) => {
      try {
        // resolveWorkspaceCtx pins git ops to the MAIN worktree, so removing an
        // agent worktree (even when --repo points at it) does not pull the cwd out
        // from under the later git steps. The canonical key is also computed up
        // front so the DB cleanup runs regardless.
        const { repoPath, workspacesDir } = await resolveWorkspaceCtx(raw);
        const repoKey = await canonicalRepoKey({ repoPath });
        // path-first: resolve the live workspace so an adopted (non-agent/*)
        // worktree is actually removed, not just its DB row.
        const ws = await resolveLiveWorkspace(repoPath, workspacesDir, repoKey, agent);
        const res = await removeAgentWorkspace(
          { repoPath, workspacesDir },
          {
            agent,
            force: raw.force === true,
            keepBranch: raw.keepBranch === true,
            ...(ws !== null ? { workspace: ws } : {}),
          },
        );
        // Clear the DB index row too (also clears a stale row whose worktree was
        // already gone). git remains the source of truth for the worktree itself.
        const rowCleared = withWorkspaceRepo((repo) =>
          repo.remove(repoKey, agent),
        );
        process.stdout.write(
          res.removed || rowCleared
            ? `removed workspace for agent "${agent}"\n`
            : `no workspace for agent "${agent}"\n`,
        );
      } catch (e) {
        withWorkspaceErrorExit(e);
      }
    });
}
