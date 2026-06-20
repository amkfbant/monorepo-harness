import process from "node:process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { harnessPaths } from "../../config/paths.js";
import { exportOperationalKnowledge, importOperationalKnowledge } from "../../core/operational-knowledge-files.js";
import { recordOperationalKnowledge, listOperationalKnowledge, getOperationalKnowledge, deprecateOperationalKnowledge, operationalKnowledgeDigest, OperationalKnowledgeError } from "../../core/operational-knowledge.js";
import { openManagedDb } from "../../db/managed-connection.js";
import { runMigrations } from "../../db/migrations.js";

/**
 * `harness knowledge ops` 操作系コマンド（#125 A15: cli/knowledge.ts から
 * behaviour-zero 分割）。ops(add/list/show/deprecate/digest/export/import)。group 内
 * helper（collectTag / opsKnowledgeDirOf）を同梱。registration 順は golden で凍結。
 */
export function registerKnowledgeOpsCommands(
  knowledgeCmd: Command,
  getHarnessRoot: () => string,
): void {
  function collectTag(value: string, previous: string[]): string[] {
    return [...previous, value];
  }

  // --- operational knowledge (issue #57): author non-codebase learnings ----
  // (toolchain / CI / environment / harness-usage). Authored directly (no
  // candidate stage) and never injected into coder prompts — see operational-
  // knowledge.ts and docs/specs/db.md (schema v19).
  const knowledgeOpsCmd = knowledgeCmd
    .command("ops")
    .description("operational (non-codebase) knowledge: author / list / show / deprecate");

  knowledgeOpsCmd
    .command("add")
    .description("author an operational knowledge entry")
    .requiredOption("--title <title>", "short title")
    .option("--body <text>", "markdown body (or use --body-file / stdin)")
    .option("--body-file <path>", "read the markdown body from a file")
    .option("--key <slug>", "stable slug → ops/<slug> (default: generated id)")
    .option("--kind <kind>", "sub-kind, e.g. toolchain / ci / environment", "operational")
    .option("--tag <tag>", "tag (repeatable)", collectTag, [])
    .option("--project <id>", "scope to a project (default: portable)")
    .option("--repo-id <id>", "scope to a repo (default: portable)")
    .option("--domain <domain>", "scope to a domain (default: portable)")
    .option("--actor <actor>", "actor label", "cli")
    .option("--json", "emit JSON instead of text", false)
    .action((raw: Record<string, unknown>) => {
      let body: string;
      if (typeof raw.body === "string") {
        body = raw.body;
      } else if (typeof raw.bodyFile === "string") {
        body = readFileSync(raw.bodyFile, "utf8");
      } else if (process.stdin.isTTY) {
        // no piped body on an interactive terminal — fail fast instead of
        // blocking on a stdin read the user did not intend.
        process.stderr.write(
          "harness error: body is required; pass --body, --body-file, or pipe stdin\n",
        );
        process.exit(1);
      } else {
        body = readFileSync(0, "utf8"); // stdin
      }
      const handle = openManagedDb({ dbPath: harnessPaths(getHarnessRoot()).dbPath });
      try {
        runMigrations(handle.db);
        const result = recordOperationalKnowledge(handle.db, {
          title: String(raw.title),
          body,
          kind: String(raw.kind),
          tags: raw.tag as string[],
          actor: String(raw.actor),
          ...(typeof raw.key === "string" ? { key: raw.key } : {}),
          ...(typeof raw.project === "string" ? { projectId: raw.project } : {}),
          ...(typeof raw.repoId === "string" ? { repoId: raw.repoId } : {}),
          ...(typeof raw.domain === "string" ? { domain: raw.domain } : {}),
        });
        process.stdout.write(
          raw.json === true
            ? `${JSON.stringify(result, null, 2)}\n`
            : `knowledge ops add: ${result.entryId} version=${result.version}` +
                `${result.reusedExisting ? " (unchanged)" : ""}\n`,
        );
      } catch (e) {
        if (e instanceof OperationalKnowledgeError) {
          process.stderr.write(`harness error: ${e.message}\n`);
          process.exit(1);
        }
        throw e;
      } finally {
        handle.close();
      }
    });

  knowledgeOpsCmd
    .command("list")
    .description("list operational knowledge entries")
    .option("--project <id>", "scope to a project (portable entries still shown)")
    .option("--repo-id <id>", "scope to a repo (portable entries still shown)")
    .option("--domain <domain>", "scope to a domain")
    .option("--include-deprecated", "include deprecated entries", false)
    .option("--json", "emit JSON instead of text", false)
    .action((raw: Record<string, unknown>) => {
      const handle = openManagedDb({
        dbPath: harnessPaths(getHarnessRoot()).dbPath,
        readonly: true,
      });
      try {
        const entries = listOperationalKnowledge(handle.db, {
          includeDeprecated: raw.includeDeprecated === true,
          ...(typeof raw.project === "string" ? { projectId: raw.project } : {}),
          ...(typeof raw.repoId === "string" ? { repoId: raw.repoId } : {}),
          ...(typeof raw.domain === "string" ? { domain: raw.domain } : {}),
        });
        if (raw.json === true) {
          process.stdout.write(`${JSON.stringify({ entries }, null, 2)}\n`);
          return;
        }
        if (entries.length === 0) {
          process.stdout.write("(no operational knowledge)\n");
          return;
        }
        for (const e of entries) {
          const scopeParts = [
            e.projectId !== null ? `project=${e.projectId}` : null,
            e.repoId !== null ? `repo=${e.repoId}` : null,
            e.domain !== null ? `domain=${e.domain}` : null,
          ].filter((p): p is string => p !== null);
          const scope = scopeParts.length > 0 ? scopeParts.join(" ") : "portable";
          const tags = e.tags.length > 0 ? ` [${e.tags.join(", ")}]` : "";
          process.stdout.write(
            `${e.entryId}\t${e.kind}\t${scope}\t${e.title}${tags}\n`,
          );
        }
      } finally {
        handle.close();
      }
    });

  knowledgeOpsCmd
    .command("show")
    .description("show an operational knowledge entry")
    .argument("<entry-id>", "operational entry id (ops/...)")
    .option("--json", "emit JSON instead of markdown", false)
    .action((entryId: string, raw: Record<string, unknown>) => {
      const handle = openManagedDb({
        dbPath: harnessPaths(getHarnessRoot()).dbPath,
        readonly: true,
      });
      try {
        const entry = getOperationalKnowledge(handle.db, entryId);
        if (entry === null) {
          process.stderr.write(
            `harness error: no operational knowledge entry ${entryId}\n`,
          );
          process.exit(1);
        }
        process.stdout.write(
          raw.json === true
            ? `${JSON.stringify(entry, null, 2)}\n`
            : `${entry.body.endsWith("\n") ? entry.body : `${entry.body}\n`}`,
        );
      } finally {
        handle.close();
      }
    });

  knowledgeOpsCmd
    .command("deprecate")
    .description("deprecate an operational knowledge entry (hidden from list)")
    .argument("<entry-id>", "operational entry id (ops/...)")
    .option("--actor <actor>", "actor label", "cli")
    .option("--reason <text>", "deprecation reason")
    .option("--json", "emit JSON instead of text", false)
    .action((entryId: string, raw: Record<string, unknown>) => {
      const handle = openManagedDb({ dbPath: harnessPaths(getHarnessRoot()).dbPath });
      try {
        runMigrations(handle.db);
        const result = deprecateOperationalKnowledge(handle.db, {
          entryId,
          actor: String(raw.actor),
          ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}),
        });
        process.stdout.write(
          raw.json === true
            ? `${JSON.stringify(result, null, 2)}\n`
            : `knowledge ops deprecate: ${result.entryId}` +
                `${result.alreadyDeprecated ? " (already deprecated)" : ""}\n`,
        );
      } catch (e) {
        if (e instanceof OperationalKnowledgeError) {
          process.stderr.write(`harness error: ${e.message}\n`);
          process.exit(1);
        }
        throw e;
      } finally {
        handle.close();
      }
    });

  /** Default compat dir for operational knowledge files (DB-canonical → file). */
  function opsKnowledgeDirOf(root: string, raw: Record<string, unknown>): string {
    if (typeof raw.dir === "string" && raw.dir !== "") return resolve(raw.dir);
    return join(root, "docs", "ops-knowledge");
  }

  knowledgeOpsCmd
    .command("digest")
    .description("aggregate operational knowledge (total / active / deprecated / by kind)")
    .option("--project <id>", "scope to a project (portable entries still counted)")
    .option("--repo-id <id>", "scope to a repo (portable entries still counted)")
    .option("--domain <domain>", "scope to a domain")
    .option("--json", "emit JSON instead of text", false)
    .action((raw: Record<string, unknown>) => {
      const handle = openManagedDb({
        dbPath: harnessPaths(getHarnessRoot()).dbPath,
        readonly: true,
      });
      try {
        const d = operationalKnowledgeDigest(handle.db, {
          ...(typeof raw.project === "string" ? { projectId: raw.project } : {}),
          ...(typeof raw.repoId === "string" ? { repoId: raw.repoId } : {}),
          ...(typeof raw.domain === "string" ? { domain: raw.domain } : {}),
        });
        if (raw.json === true) {
          process.stdout.write(`${JSON.stringify(d, null, 2)}\n`);
          return;
        }
        const kinds = Object.keys(d.byKind)
          .sort()
          .map((k) => `  ${k}: ${d.byKind[k]}`)
          .join("\n");
        process.stdout.write(
          `operational knowledge digest\n` +
            `total: ${d.total}  active: ${d.active}  deprecated: ${d.deprecated}\n` +
            `${kinds}${kinds ? "\n" : ""}`,
        );
      } finally {
        handle.close();
      }
    });

  knowledgeOpsCmd
    .command("export")
    .description("export operational knowledge to docs/ops-knowledge/ (DB → file compat)")
    .option("--to-docs", "export to docs/ops-knowledge", false)
    .option("--dir <dir>", "output dir (default: HARNESS_ROOT/docs/ops-knowledge)")
    .option("--json", "emit JSON instead of text", false)
    .action(async (raw: Record<string, unknown>) => {
      if (raw.toDocs !== true) {
        process.stderr.write(
          "harness error: 'knowledge ops export' requires --to-docs\n",
        );
        process.exit(1);
      }
      const root = getHarnessRoot();
      const outDir = opsKnowledgeDirOf(root, raw);
      const handle = openManagedDb({
        dbPath: harnessPaths(root).dbPath,
        readonly: true,
      });
      try {
        const result = await exportOperationalKnowledge(handle.db, outDir);
        process.stdout.write(
          raw.json === true
            ? `${JSON.stringify(result, null, 2)}\n`
            : `knowledge ops export: wrote ${result.written.length} file(s) to ${outDir}\n`,
        );
      } finally {
        handle.close();
      }
    });

  knowledgeOpsCmd
    .command("import")
    .description("import operational knowledge from docs/ops-knowledge/ (file → DB, idempotent)")
    .option("--from-docs", "import from docs/ops-knowledge", false)
    .option("--dir <dir>", "input dir (default: HARNESS_ROOT/docs/ops-knowledge)")
    .option("--actor <actor>", "actor label", "db-import")
    .option("--json", "emit JSON instead of text", false)
    .action(async (raw: Record<string, unknown>) => {
      if (raw.fromDocs !== true) {
        process.stderr.write(
          "harness error: 'knowledge ops import' requires --from-docs\n",
        );
        process.exit(1);
      }
      const root = getHarnessRoot();
      const inDir = opsKnowledgeDirOf(root, raw);
      const handle = openManagedDb({ dbPath: harnessPaths(root).dbPath });
      try {
        runMigrations(handle.db);
        const result = await importOperationalKnowledge(handle.db, inDir, {
          actor: String(raw.actor),
        });
        process.stdout.write(
          raw.json === true
            ? `${JSON.stringify(result, null, 2)}\n`
            : `knowledge ops import: imported ${result.imported}` +
                `${result.skipped.length > 0 ? `, skipped ${result.skipped.length}` : ""}\n`,
        );
      } finally {
        handle.close();
      }
    });
}
