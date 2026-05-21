import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { sha256 } from "./import/common.js";

/**
 * Run artifact manifest (Phase 7-4).
 *
 * The `artifacts` table is a manifest only — `storage='file'`, the bodies
 * stay file-backed in `runs/<runId>/`. Both the file importer and a
 * DB-first run's finalize step record the manifest by scanning the run
 * directory, so the scan lives here and is shared.
 */

/** Artifact kind keyed by the run-dir filename. */
const ARTIFACT_KINDS: Record<string, string> = {
  "meta.json": "meta",
  "events.jsonl": "events",
  "codex-prompt.md": "codex-prompt",
  "codex-output.log": "codex-output",
  "codex-error.log": "codex-error",
  "final-diff.patch": "diff",
  "summary.md": "summary",
  "review-request.md": "review-request",
  "review-decision.yaml": "review-decision",
  "resolved-policy.yaml": "resolved-policy",
  "knowledge-candidates.yaml": "knowledge-candidates",
  "context-pack-manifest.yaml": "context-pack-manifest",
};

function contentType(name: string): string {
  if (name.endsWith(".md")) return "text/markdown";
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".jsonl")) return "application/x-ndjson";
  if (name.endsWith(".yaml")) return "text/yaml";
  if (name.endsWith(".patch")) return "text/x-patch";
  if (name.endsWith(".log")) return "text/plain";
  return "application/octet-stream";
}

/**
 * Replace the `artifacts` rows for one run with a fresh scan of its
 * directory. Dotfiles (the transient `.exporting` marker, atomic-write
 * temp files) are skipped — they are bookkeeping, not run artifacts.
 */
export function recordRunArtifacts(
  db: Database.Database,
  runDir: string,
  runId: string,
): void {
  const insert = db.prepare(
    `INSERT INTO artifacts (artifact_id, run_id, kind, relative_path,
       content_type, bytes, sha256, storage, created_at, redacted,
       secret_suspect)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'file', ?, 0, 0)`,
  );
  // wrap the replace in a transaction so a mid-scan stat/read failure
  // cannot leave a partially-rebuilt manifest. better-sqlite3 nests this
  // as a SAVEPOINT when the importer already holds a transaction.
  const txn = db.transaction(() => {
    db.prepare("DELETE FROM artifacts WHERE run_id = ?").run(runId);
    for (const file of readdirSync(runDir, { withFileTypes: true })) {
      if (!file.isFile() || file.name.startsWith(".")) continue;
      const name = file.name;
      const abs = join(runDir, name);
      const st = statSync(abs);
      insert.run(
        `${runId}:${name}`,
        runId,
        ARTIFACT_KINDS[name] ?? "other",
        name,
        contentType(name),
        st.size,
        // hash the raw bytes — an artifact may be binary, where a UTF-8
        // decode would corrupt the digest.
        sha256(readFileSync(abs)),
        new Date(st.mtimeMs).toISOString(),
      );
    }
  });
  txn();
}
