// Claude CLI runner (#191) — a `claude -p` backend that satisfies the same
// CodexExecRunner contract the harness consumes for codex. The harness reads
// four provider-independent things from a run: the real worktree diff (policy
// is verified post-hoc against `git diff`, never against events), the
// exit/timeout/duration triple, the final agent message, and the raw event
// stream. This runner supplies all four from `claude -p --output-format
// stream-json`.
//
// Contract confirmed against claude-cli 2.1.185 (Phase A実機検証, docs report
// F13-F16 + 2026-06-21 verification):
//   claude -p [flags]            non-interactive; prompt via stdin (--input-format
//                                text is the default, so piped stdin = the prompt).
//   --output-format stream-json  JSONL events on stdout (the events artifact).
//   --setting-sources ""         ignore global/project CLAUDE.md, MCP, hooks,
//                                slash, skills while KEEPING subscription auth
//                                (apiKeySource=none — no metered fallback). F13.
//   --tools <names...>           restrict the granted tool surface (coder vs
//                                read-only reviewer).
//   final message                claude has no `-o`; the last `{type:'result'}`
//                                event carries it in `.result`, which this runner
//                                writes to logPaths.stdout (codex's `-o` analogue).
//
// F15 containment (safety, 不可侵): claude has no OS filesystem sandbox like
// codex's `--sandbox workspace-write`. Phase A verified that claude-cli 2.1.185
// natively blocks worktree-EXTERNAL writes in `-p` mode (fail-closed: every
// tested escape vector — redirect / tee / cp / mv / python / heredoc / symlink /
// Write-tool — was denied) because the allowed write boundary IS the cwd. This
// runner therefore launches with cwd=worktreePath and DELIBERATELY never passes
// `--add-dir` (which would widen the boundary past the worktree). The harness's
// canonical safety invariant (post-hoc `git diff` policy check) is unchanged and
// provider-independent regardless.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { finished } from "node:stream/promises";
import type {
  CodexExecRunner,
  CodexRunInputs,
  CodexRunResult,
} from "../codex/codex-exec-runner.js";
import { filterEnv } from "../codex/codex-cli-runner.js";
import { killProcessTree } from "../codex/process-tree.js";
import { redactClaudeEvents } from "./redact-events.js";

// Default env passed to the claude subprocess. ANTHROPIC_API_KEY is
// DELIBERATELY excluded: its presence would flip claude off subscription auth
// onto metered API billing (F13/F16). HOME is required so claude can read its
// subscription credentials.
export const DEFAULT_CLAUDE_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
];

// Coder needs to edit + run commands; a read-only reviewer is restricted by the
// caller to a read-only set. Default to the coder surface.
export const DEFAULT_CLAUDE_TOOLS = ["Bash", "Read", "Edit", "Write"];

export interface ClaudeCliOpts {
  claudeBin?: string;
  /** Permission mode; acceptEdits auto-accepts edits in non-interactive -p. */
  permissionMode?: string;
  /** Granted tool surface (e.g. read-only reviewer = ["Read","Grep","Glob"]). */
  tools?: readonly string[];
  /** Advisory model; injected as --model when present (mirrors codex telemetry model). */
  model?: string;
  /** Setting-source isolation; "" = full isolation while keeping subscription. */
  settingSources?: string;
  envAllowlist?: readonly string[];
  timeoutMs?: number;
  // NOTE: no `extraArgs` escape hatch (unlike codex). A pass-through arg list
  // could smuggle `--add-dir`, which widens claude's write boundary past the
  // worktree and breaks the F15 containment invariant. The flag set is fixed.
}

/**
 * Build the static `claude -p` argv (prompt is supplied separately via stdin).
 * Pure + exported for flag-level unit assertions. `--tools` is placed LAST so
 * its variadic consumes exactly the tool tokens with no trailing positional to
 * absorb. NEVER emits `--add-dir` (F15 boundary hygiene).
 */
export function buildClaudeArgs(opts: ClaudeCliOpts): string[] {
  const tools = opts.tools ?? DEFAULT_CLAUDE_TOOLS;
  const args: string[] = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    opts.permissionMode ?? "acceptEdits",
    "--setting-sources",
    opts.settingSources ?? "",
    "--strict-mcp-config",
    "--disable-slash-commands",
  ];
  if (opts.model) args.push("--model", opts.model);
  if (tools.length > 0) args.push("--tools", ...tools);
  return args;
}

/**
 * Extract the final agent message from captured stream-json events content: the
 * last `{type:'result'}` event's `.result`. Returns "" when absent (early exit /
 * crash) — the artifact path is always written, fail-closed, like codex. Pure on
 * content so it can be re-run over the REDACTED events downstream (S4).
 */
export function extractClaudeFinalMessage(content: string): string {
  const lines = content.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      const event = JSON.parse(line) as { type?: string; result?: unknown };
      if (event.type === "result") {
        return typeof event.result === "string" ? event.result : "";
      }
    } catch {
      // non-JSON / partial line — keep scanning earlier lines.
    }
  }
  return "";
}

export function createClaudeCliRunner(opts: ClaudeCliOpts): CodexExecRunner {
  const claudeBin = opts.claudeBin ?? "claude";
  const envAllowlist = opts.envAllowlist ?? DEFAULT_CLAUDE_ENV_ALLOWLIST;
  return {
    async run(input: CodexRunInputs): Promise<CodexRunResult> {
      // Fail-closed (#132): once the course lease is gone, do not launch claude.
      if (input.signal?.aborted === true) {
        return { exitCode: -1, timedOut: false, aborted: true, durationMs: 0 };
      }
      await mkdir(dirname(input.logPaths.stdout), { recursive: true });
      await mkdir(dirname(input.logPaths.stderr), { recursive: true });
      await mkdir(dirname(input.logPaths.events), { recursive: true });
      const eventsStream = createWriteStream(input.logPaths.events);
      const errStream = createWriteStream(input.logPaths.stderr);

      const args = buildClaudeArgs(opts);
      const env = filterEnv(process.env, envAllowlist);
      return await new Promise<CodexRunResult>((resolve, reject) => {
        // detached: claude becomes a process-group leader so timeout/abort can
        // SIGKILL the entire tree (test runners, dev servers) via killProcessTree.
        const startedAt = performance.now();
        const child = spawn(claudeBin, args, {
          // cwd=worktree is the F15 write boundary (see file header).
          cwd: input.worktreePath,
          stdio: ["pipe", "pipe", "pipe"],
          env,
          detached: true,
        });
        let timedOut = false;
        let aborted = false;
        let timer: NodeJS.Timeout | undefined;
        if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
          timer = setTimeout(() => {
            timedOut = true;
            killProcessTree(child);
          }, opts.timeoutMs);
        }
        // #132 — SIGKILL the tree if the course orchestrator aborts mid-drive on
        // lease loss. The killed child exits non-zero → finalized failed (fail-closed).
        const onAbort = (): void => {
          aborted = true;
          killProcessTree(child);
        };
        input.signal?.addEventListener("abort", onAbort, { once: true });
        // Close the spawn-window race: a signal that fired during mkdir/spawn
        // setup does not replay to a freshly-added listener, so re-check & kill.
        if (input.signal?.aborted === true) onAbort();
        child.stdout.pipe(eventsStream);
        child.stderr.pipe(errStream);
        // claude may exit before draining stdin; EPIPE on the prompt write is
        // not fatal — the child's exit code is the source of truth.
        child.stdin.on("error", () => {});
        child.stdin.write(input.prompt);
        child.stdin.end();
        child.on("error", (e) => {
          if (timer) clearTimeout(timer);
          input.signal?.removeEventListener("abort", onAbort);
          reject(e);
        });
        child.on("close", (code) => {
          if (timer) clearTimeout(timer);
          input.signal?.removeEventListener("abort", onAbort);
          const durationMs = Math.round(performance.now() - startedAt);
          Promise.all([finished(eventsStream), finished(errStream)])
            .catch(() => {
              // shutdown noise — exit code is the source of truth
            })
            .then(async () => {
              // claude has no `-o`; synthesize the final-message artifact from
              // the result event. Always write the path (fail-closed) even on
              // early exit, mirroring codex's empty-`-o` preservation. (The
              // coder dispatch re-derives this from the REDACTED events so a
              // secret in the final message is not leaked — see workflow-runner.)
              let eventsContent = "";
              try {
                eventsContent = await readFile(input.logPaths.events, "utf8");
              } catch {
                eventsContent = "";
              }
              // Redact BEFORE extracting so the official codex-output.log never
              // holds a raw secret from the final message — fail-closed at the
              // source, independent of any downstream publish (S4). Both
              // functions are total (never throw).
              const redactedEvents = redactClaudeEvents(eventsContent).content;
              await writeFile(
                input.logPaths.stdout,
                extractClaudeFinalMessage(redactedEvents),
              );
            })
            .catch(() => {
              // best-effort artifact write — never mask the run's exit code
            })
            .finally(() => {
              // Fail-closed (#132): aborted runs force a non-zero exit even if
              // the child exited 0 before SIGKILL landed (status selection keys
              // on exitCode, never needs_review once the lease is lost).
              resolve({
                exitCode: aborted ? -1 : code ?? -1,
                timedOut,
                aborted,
                durationMs,
              });
            });
        });
      });
    },
  };
}
