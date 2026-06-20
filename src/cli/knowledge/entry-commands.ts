import process from "node:process";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Command } from "commander";
import { harnessPaths } from "../../config/paths.js";
import { buildKnowledgeContext, buildKnowledgeContextFromDb, KnowledgeContextError } from "../../core/knowledge-context.js";
import { deprecateKnowledgeDbFirst, promoteKnowledgeDbFirst, rejectKnowledgeDbFirst, type KnowledgeDbContext } from "../../core/knowledge-db.js";
import { listKnowledge, KnowledgePromoteGateError, splitFrontmatter } from "../../core/knowledge-promoter.js";
import { StateConflictError, SourceModeError } from "../../db/errors.js";
import { emptyCounters } from "../../db/import/common.js";
import { importKnowledgeEntries } from "../../db/import/knowledge.js";
import { openManagedDb } from "../../db/managed-connection.js";
import { runMigrations } from "../../db/migrations.js";
import { getCurrentKnowledgeRevision, listCurrentKnowledgeRevisions, recordKnowledgeEntryRevision } from "../../db/repositories/knowledge-entry-revisions.js";

/**
 * `harness knowledge` entry lifecycle コマンド（#125 A15: cli/knowledge.ts から
 * behaviour-zero 分割）。build-context / list / reject / promote / deprecate /
 * import / export / show / edit。group 内 helper（knowledgeDirOf / knowledgeDbContext
 * / knowledgeExportPath / knowledgeError / isOperationalEntry）を同梱。registration
 * 順は golden で凍結。
 */
export function registerKnowledgeEntryCommands(
  knowledgeCmd: Command,
  getHarnessRoot: () => string,
): void {
  function knowledgeDirOf(
    harnessRoot: string,
    raw: Record<string, unknown>,
  ): string {
    return raw.out !== undefined
      ? String(raw.out)
      : join(harnessRoot, "docs", "knowledge");
  }

  /** DB-first knowledge context — runs dir, knowledge dir, harness DB path. */
  function knowledgeDbContext(
    harnessRoot: string,
    raw: Record<string, unknown>,
  ): KnowledgeDbContext {
    const paths = harnessPaths(harnessRoot);
    return {
      runsDir: paths.runsDir,
      knowledgeDir: knowledgeDirOf(harnessRoot, raw),
      dbPath: paths.dbPath,
    };
  }

  function knowledgeExportPath(
    knowledgeRoot: string,
    row: { path: string | null; kind: string; entryId: string },
  ): string {
    const prefix = "docs/knowledge/";
    if (row.path !== null && row.path.startsWith(prefix)) {
      return join(knowledgeRoot, row.path.slice(prefix.length));
    }
    const safe = row.entryId.replace(/[^A-Za-z0-9._-]/g, "-");
    return join(knowledgeRoot, row.kind, `${safe}.md`);
  }

  /** Map a knowledge command failure to a user error (exit 1). */
  function knowledgeError(e: unknown): never {
    if (
      e instanceof KnowledgePromoteGateError ||
      e instanceof StateConflictError ||
      e instanceof SourceModeError
    ) {
      process.stderr.write(`harness error: ${(e as Error).message}\n`);
      process.exit(1);
    }
    throw e;
  }

  /** True when `entryId` is an operational entry (so codebase commands refuse it). */
  function isOperationalEntry(
    db: ReturnType<typeof openManagedDb>["db"],
    entryId: string,
  ): boolean {
    const row = db
      .prepare("SELECT category FROM knowledge_entries WHERE entry_id = ?")
      .get(entryId) as { category: string } | undefined;
    return row?.category === "operational";
  }


  knowledgeCmd
    .command("build-context")
    .description(
      "aggregate promoted knowledge for a domain into docs/knowledge-context/<domain>.md",
    )
    .requiredOption("--domain <domain>", "target domain")
    .option("--project <id>", "scope DB-current revisions to a project")
    .option("--repo-id <id>", "scope DB-current revisions to a repo")
    .option("--out <dir>", "knowledge root (default: HARNESS_ROOT/docs/knowledge)")
    .action(async (raw: Record<string, unknown>) => {
      const harnessRoot = getHarnessRoot();
      try {
        let r;
        if (raw.project !== undefined || raw.repoId !== undefined) {
          const paths = harnessPaths(harnessRoot);
          const handle = openManagedDb({ dbPath: paths.dbPath });
          try {
            runMigrations(handle.db);
            r = await buildKnowledgeContextFromDb({
              db: handle.db,
              outDir: join(harnessRoot, "docs", "knowledge-context"),
              domain: String(raw.domain),
              ...(raw.project !== undefined
                ? { projectId: String(raw.project) }
                : {}),
              ...(raw.repoId !== undefined ? { repoId: String(raw.repoId) } : {}),
            });
          } finally {
            handle.close();
          }
        } else {
          r = await buildKnowledgeContext({
            knowledgeDir: knowledgeDirOf(harnessRoot, raw),
            outDir: join(harnessRoot, "docs", "knowledge-context"),
            domain: String(raw.domain),
          });
        }
        process.stdout.write(
          `domain=${r.domain} entries=${r.entries.length} out=${r.outPath}\n`,
        );
      } catch (e) {
        if (e instanceof KnowledgeContextError) {
          process.stderr.write(`harness error: ${(e as Error).message}\n`);
          process.exit(1);
        }
        throw e;
      }
    });
  knowledgeCmd
    .command("list")
    .description("list a run's knowledge candidates with their status")
    .requiredOption("--run-id <id>", "target run identifier")
    .option("--kind <kind>", "only candidates with this kind")
    .option("--domain <domain>", "only candidates with this domain")
    .option("--out <dir>", "knowledge root (default: HARNESS_ROOT/docs/knowledge)")
    .action(async (raw: Record<string, unknown>) => {
      const harnessRoot = getHarnessRoot();
      const paths = harnessPaths(harnessRoot);
      try {
        const entries = await listKnowledge({
          runsDir: paths.runsDir,
          knowledgeDir: knowledgeDirOf(harnessRoot, raw),
          runId: String(raw.runId),
          ...(raw.kind !== undefined ? { kind: String(raw.kind) } : {}),
          ...(raw.domain !== undefined ? { domain: String(raw.domain) } : {}),
        });
        if (entries.length === 0) {
          process.stdout.write("no candidates\n");
          return;
        }
        for (const e of entries) {
          const extra =
            e.status === "rejected" ? ` (by ${e.rejectedBy})` : "";
          process.stdout.write(
            `[${e.index}] ${e.status}${extra}  kind=${e.kind} domain=${e.domain} confidence=${e.confidence}\n` +
              `    ${e.title}\n`,
          );
        }
      } catch (e) {
        if (e instanceof KnowledgePromoteGateError) {
          process.stderr.write(`harness error: ${(e as Error).message}\n`);
          process.exit(1);
        }
        throw e;
      }
    });
  knowledgeCmd
    .command("reject")
    .description("record a reject decision for a candidate (sidecar)")
    .requiredOption("--run-id <id>", "target run identifier")
    .requiredOption("--index <n>", "candidate index to reject")
    .requiredOption("--reviewer <name>", "reviewer handle")
    .requiredOption("--reason <text>", "why the candidate is rejected")
    .action(async (raw: Record<string, unknown>) => {
      const harnessRoot = getHarnessRoot();
      const index = Number(raw.index);
      if (!Number.isInteger(index) || index < 0) {
        process.stderr.write(
          `harness error: --index must be a non-negative integer (got ${JSON.stringify(String(raw.index))})\n`,
        );
        process.exit(1);
      }
      try {
        const r = await rejectKnowledgeDbFirst(
          knowledgeDbContext(harnessRoot, raw),
          {
            runId: String(raw.runId),
            index,
            reviewer: String(raw.reviewer),
            reason: String(raw.reason),
          },
        );
        for (const w of r.exportWarnings ?? []) {
          process.stderr.write(`warning: ${w}\n`);
        }
        process.stdout.write(
          `run=${r.runId} rejected candidate ${r.index} by ${r.reviewer}\n`,
        );
      } catch (e) {
        knowledgeError(e);
      }
    });
  knowledgeCmd
    .command("promote")
    .description(
      "write each candidate as docs/knowledge/<kind>/<runId>-<idx>-<slug>.md",
    )
    .requiredOption("--run-id <id>", "target run identifier")
    .requiredOption("--reviewer <name>", "reviewer handle (stamped into each md)")
    .option("--kind <kind>", "only candidates with this kind are promoted")
    .option(
      "--allow-duplicate",
      "create a md even if an identical content hash already exists",
      false,
    )
    .option("--out <dir>", "knowledge root (default: HARNESS_ROOT/docs/knowledge)")
    .action(async (raw: Record<string, unknown>) => {
      const harnessRoot = getHarnessRoot();
      const ctx = knowledgeDbContext(harnessRoot, raw);
      try {
        const r = await promoteKnowledgeDbFirst(ctx, {
          runId: String(raw.runId),
          reviewer: String(raw.reviewer),
          allowDuplicate: Boolean(raw.allowDuplicate),
          ...(raw.kind !== undefined ? { kind: String(raw.kind) } : {}),
        });
        process.stdout.write(
          `run=${r.runId} promoted=${r.promoted.length} skipped=${r.skipped.length} out=${ctx.knowledgeDir}\n`,
        );
        for (const p of r.promoted) {
          process.stdout.write(`  promoted ${p.kind}: ${p.path}\n`);
        }
        for (const s of r.skipped) {
          process.stdout.write(
            `  skipped [${s.index}] ${s.reason}${s.detail ? ` — ${s.detail}` : ""}\n`,
          );
        }
        for (const w of r.exportWarnings ?? []) {
          process.stderr.write(`warning: ${w}\n`);
        }
      } catch (e) {
        knowledgeError(e);
      }
    });

  knowledgeCmd
    .command("deprecate")
    .description("mark a DB-current knowledge entry deprecated")
    .argument("<entry-id>", "knowledge entry id, e.g. docs/knowledge/<kind>/<file>.md")
    .option("--actor <actor>", "actor label", "cli")
    .option("--reason <text>", "revision reason", "knowledge deprecate")
    .option("--out <dir>", "knowledge root (default: HARNESS_ROOT/docs/knowledge)")
    .action(async (entryId: string, raw: Record<string, unknown>) => {
      const harnessRoot = getHarnessRoot();
      try {
        const r = await deprecateKnowledgeDbFirst(
          knowledgeDbContext(harnessRoot, raw),
          {
            entryId,
            actor: String(raw.actor ?? "cli"),
            reason: String(raw.reason ?? "knowledge deprecate"),
          },
        );
        process.stdout.write(
          `deprecated ${r.entryId} revision=${r.revisionId} version=${r.version} out=${r.path}\n`,
        );
        for (const w of r.exportWarnings ?? []) {
          process.stderr.write(`warning: ${w}\n`);
        }
      } catch (e) {
        knowledgeError(e);
      }
    });

  knowledgeCmd
    .command("import")
    .description("import docs/knowledge markdown into DB-current revisions")
    .option("--from-docs", "import from docs/knowledge", false)
    .option("--json", "emit JSON instead of text", false)
    .action((raw: Record<string, unknown>) => {
      if (raw.fromDocs !== true) {
        process.stderr.write(
          "harness error: 'knowledge import' requires --from-docs\n",
        );
        process.exit(1);
      }
      const root = getHarnessRoot();
      const paths = harnessPaths(root);
      const handle = openManagedDb({ dbPath: paths.dbPath });
      try {
        runMigrations(handle.db);
        const report = emptyCounters();
        importKnowledgeEntries(
          handle.db,
          join(root, "docs", "knowledge"),
          report,
          { currentPointerMode: "set-current" },
        );
        process.stdout.write(
          raw.json === true
            ? `${JSON.stringify(report, null, 2)}\n`
            : `knowledge import: entries=${report.knowledgeEntries} candidates=${report.knowledgeCandidates}\n`,
        );
      } finally {
        handle.close();
      }
    });

  knowledgeCmd
    .command("export")
    .description("export DB-current knowledge revisions back to docs")
    .option("--to-docs", "export to docs/knowledge", false)
    .option("--out <dir>", "knowledge root (default: HARNESS_ROOT/docs/knowledge)")
    .option("--json", "emit JSON instead of text", false)
    .action((raw: Record<string, unknown>) => {
      if (raw.toDocs !== true) {
        process.stderr.write(
          "harness error: 'knowledge export' requires --to-docs\n",
        );
        process.exit(1);
      }
      const root = getHarnessRoot();
      const paths = harnessPaths(root);
      const knowledgeRoot = knowledgeDirOf(root, raw);
      const handle = openManagedDb({ dbPath: paths.dbPath, readonly: true });
      try {
        const rows = listCurrentKnowledgeRevisions(handle.db);
        const written: string[] = [];
        for (const r of rows) {
          const outPath = knowledgeExportPath(knowledgeRoot, r);
          mkdirSync(dirname(outPath), { recursive: true });
          writeFileSync(outPath, r.bodyMarkdown, "utf8");
          written.push(outPath);
        }
        const out = { written };
        process.stdout.write(
          raw.json === true
            ? `${JSON.stringify(out, null, 2)}\n`
            : `knowledge export: wrote ${written.length} file(s)\n`,
        );
      } finally {
        handle.close();
      }
    });

  knowledgeCmd
    .command("show")
    .description("show a DB-current knowledge entry revision")
    .argument("<entry-id>", "knowledge entry id")
    .option("--json", "emit JSON instead of markdown", false)
    .action((entryId: string, raw: Record<string, unknown>) => {
      const handle = openManagedDb({
        dbPath: harnessPaths(getHarnessRoot()).dbPath,
        readonly: true,
      });
      try {
        if (isOperationalEntry(handle.db, entryId)) {
          process.stderr.write(
            `harness error: ${entryId} is operational knowledge; use 'knowledge ops show'\n`,
          );
          process.exit(1);
        }
        const revision = getCurrentKnowledgeRevision(handle.db, entryId);
        if (revision === null) {
          process.stderr.write(`harness error: no knowledge entry ${entryId}\n`);
          process.exit(1);
        }
        process.stdout.write(
          raw.json === true
            ? `${JSON.stringify(revision, null, 2)}\n`
            : revision.bodyMarkdown.endsWith("\n")
              ? revision.bodyMarkdown
              : `${revision.bodyMarkdown}\n`,
        );
      } finally {
        handle.close();
      }
    });

  knowledgeCmd
    .command("edit")
    .description("edit a DB-current knowledge entry using $EDITOR")
    .argument("<entry-id>", "knowledge entry id")
    .option("--actor <actor>", "actor label", "cli")
    .option("--reason <text>", "revision reason", "manual edit")
    .action((entryId: string, raw: Record<string, unknown>) => {
      const editor = process.env.EDITOR;
      if (!editor) {
        process.stderr.write(
          "harness error: $EDITOR is not set; use knowledge show/import/export to edit explicitly\n",
        );
        process.exit(1);
      }
      const handle = openManagedDb({ dbPath: harnessPaths(getHarnessRoot()).dbPath });
      try {
        runMigrations(handle.db);
        if (isOperationalEntry(handle.db, entryId)) {
          process.stderr.write(
            `harness error: ${entryId} is operational knowledge; edit it with 'knowledge ops add --key <key>'\n`,
          );
          process.exit(1);
        }
        const current = getCurrentKnowledgeRevision(handle.db, entryId);
        if (current === null) {
          process.stderr.write(`harness error: no knowledge entry ${entryId}\n`);
          process.exit(1);
        }
        const currentEntry = handle.db
          .prepare(
            `SELECT kind, path
               FROM knowledge_entries
              WHERE entry_id = ?`,
          )
          .get(entryId) as { kind: string; path: string | null } | undefined;
        const dir = mkdtempSync(join(tmpdir(), "harness-knowledge-edit-"));
        const editPath = join(dir, "entry.md");
        writeFileSync(editPath, current.bodyMarkdown, "utf8");
        const child = spawnSync(editor, [editPath], { stdio: "inherit" });
        if (child.status !== 0) {
          process.stderr.write(`harness error: editor exited with status ${child.status}\n`);
          process.exit(1);
        }
        const bodyMarkdown = readFileSync(editPath, "utf8");
        const parsed = splitFrontmatter(bodyMarkdown);
        const frontmatter = parsed.frontmatter ?? {};
        const revision = recordKnowledgeEntryRevision(handle.db, {
          entryId,
          bodyMarkdown,
          frontmatter,
          title:
            typeof frontmatter.title === "string"
              ? frontmatter.title
              : current.title ?? entryId,
          actor: String(raw.actor),
          reason: String(raw.reason),
        }).revision;
        handle.db
          .prepare(
            `UPDATE knowledge_entries
                SET project_id = ?, repo_id = ?, domain = ?, kind = ?,
                    path = ?, body = ?, frontmatter_json = ?, title = ?,
                    source_mode = 'db-first',
                    export_status = 'dirty',
                    last_export_error = NULL
              WHERE entry_id = ?`,
          )
          .run(
            typeof frontmatter.project_id === "string"
              ? frontmatter.project_id
              : null,
            typeof frontmatter.repo_id === "string" ? frontmatter.repo_id : null,
            typeof frontmatter.domain === "string" ? frontmatter.domain : null,
            typeof frontmatter.kind === "string"
              ? frontmatter.kind
              : currentEntry?.kind ?? "imported",
            typeof frontmatter.path === "string"
              ? frontmatter.path
              : currentEntry?.path ?? entryId,
            parsed.body,
            JSON.stringify(frontmatter),
            typeof frontmatter.title === "string"
              ? frontmatter.title
              : current.title,
            entryId,
          );
        process.stdout.write(
          `knowledge edit: ${entryId} revision=${revision.revisionId} version=${revision.version}\n`,
        );
      } finally {
        handle.close();
      }
    });
}
