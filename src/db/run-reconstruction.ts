import type Database from "better-sqlite3";
import { buildReviewDecision } from "../reporter/review-decision.js";

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

/**
 * Rebuild a `meta.json` object from a `runs` row. The inverse of the
 * importer's `runRow`: only fields the v1 `runs` columns hold are
 * reproduced, and a null column is omitted (mirroring how `createRunLog`
 * omits absent optional fields). Fields the columns cannot hold (the full
 * `project` provenance, the `reviewed` fingerprint) are necessarily
 * lossy: round-trip equality is therefore normalized, not byte-exact.
 */
export function reconstructRunMeta(
  db: Database.Database,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  const put = (key: string, value: unknown): void => {
    if (value !== null && value !== undefined) meta[key] = value;
  };

  put("runId", str(row.run_id));
  put("repoId", str(row.repo_id));
  put("repoPath", str(row.repo_path));
  put("domain", str(row.domain));
  put("workflow", str(row.workflow));
  put("baseBranch", str(row.base_branch));
  put("baseSha", str(row.base_sha));
  put("runBranch", str(row.run_branch));
  put("status", str(row.status));
  put("safetyStatus", str(row.safety_status));
  put("ignoredUntrackedCount", num(row.ignored_untracked_count));
  put("secretSuspectCount", num(row.secret_suspect_count));
  put("reviewer", str(row.reviewer));
  put("reviewedAt", str(row.reviewed_at));

  const commands = db
    .prepare(
      `SELECT command, exit_code, duration_ms, timed_out
       FROM command_results WHERE run_id = ? ORDER BY command_index`,
    )
    .all(row.run_id as string) as {
    command: string;
    exit_code: number | null;
    duration_ms: number | null;
    timed_out: number;
  }[];
  if (commands.length > 0) {
    meta.commandResults = commands.map((c) => ({
      command: c.command,
      exitCode: c.exit_code ?? 0,
      durationMs: c.duration_ms ?? 0,
      timedOut: c.timed_out === 1,
    }));
  }

  put("changedFilesCount", num(row.changed_files_count));
  put("parentRunId", str(row.parent_run_id));
  put("rootRunId", str(row.root_run_id));
  put("rerunAttempt", num(row.rerun_attempt));

  const knowledgeContextPath = str(row.knowledge_context_path);
  if (knowledgeContextPath !== null) {
    meta.knowledgeContext = { enabled: true, contextFile: knowledgeContextPath };
  }
  const templateName = str(row.prompt_template_name);
  const templateVersion = num(row.prompt_template_version);
  if (templateName !== null && templateVersion !== null) {
    meta.promptTemplate = { name: templateName, version: templateVersion };
  }
  put("prUrl", str(row.pr_url));
  put("prNumber", num(row.pr_number));

  const projectId = str(row.project_id);
  if (projectId !== null) meta.project = { projectId };

  put("startedAt", str(row.started_at));
  put("finishedAt", str(row.finished_at));
  return meta;
}

export function reconstructRunArtifactBodyFromDb(
  db: Database.Database,
  runId: string,
  relativePath: string | null,
): Buffer | null {
  if (relativePath === null) return null;
  const row = db
    .prepare("SELECT * FROM runs WHERE run_id = ?")
    .get(runId) as Record<string, unknown> | undefined;
  if (row === undefined) return null;

  if (relativePath === "meta.json") {
    const metaJson = row.meta_json;
    const content =
      typeof metaJson === "string"
        ? `${metaJson}\n`
        : `${JSON.stringify(reconstructRunMeta(db, row), null, 2)}\n`;
    return Buffer.from(content);
  }

  if (relativePath === "events.jsonl") {
    const eventLines = (
      db
        .prepare(
          "SELECT payload_json FROM run_events WHERE run_id = ? ORDER BY seq",
        )
        .all(runId) as { payload_json: string }[]
    ).map((e) => e.payload_json);
    return eventLines.length > 0
      ? Buffer.from(`${eventLines.join("\n")}\n`)
      : null;
  }

  if (relativePath === "review-decision.yaml") {
    const rev = db
      .prepare("SELECT source_yaml FROM review_decisions WHERE run_id = ?")
      .get(runId) as { source_yaml: string | null } | undefined;
    let source = rev?.source_yaml ?? null;
    if (source === null && tableExists(db, "review_proposals")) {
      const proposal = db
        .prepare(
          `SELECT source_yaml FROM review_proposals
            WHERE run_id = ?
              AND superseded_at IS NULL
              AND processed_at IS NULL
            ORDER BY reviewed_at DESC, proposal_id DESC LIMIT 1`,
        )
        .get(runId) as { source_yaml: string | null } | undefined;
      source = proposal?.source_yaml ?? null;
    }
    if (source === null && row.status === "needs_review") {
      source = buildReviewDecision({
        runId,
        domain: String(row.domain ?? ""),
      });
    }
    if (source === null) return null;
    return Buffer.from(source.endsWith("\n") ? source : `${source}\n`);
  }

  return null;
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM sqlite_master
        WHERE type = 'table' AND name = ?`,
    )
    .get(tableName);
  return row !== undefined;
}
