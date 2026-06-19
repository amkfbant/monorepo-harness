import process from "node:process";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Command } from "commander";
import { harnessPaths } from "../config/paths.js";
import { buildKnowledgeContext, buildKnowledgeContextFromDb, KnowledgeContextError } from "../core/knowledge-context.js";
import { deprecateKnowledgeDbFirst, promoteKnowledgeDbFirst, rejectKnowledgeDbFirst, type KnowledgeDbContext } from "../core/knowledge-db.js";
import { buildKnowledgeDigest, formatDigest } from "../core/knowledge-digest.js";
import { listKnowledge, KnowledgePromoteGateError, splitFrontmatter } from "../core/knowledge-promoter.js";
import { parseDuration } from "../core/maintenance.js";
import { exportOperationalKnowledge, importOperationalKnowledge } from "../core/operational-knowledge-files.js";
import { recordOperationalKnowledge, listOperationalKnowledge, getOperationalKnowledge, deprecateOperationalKnowledge, operationalKnowledgeDigest, OperationalKnowledgeError } from "../core/operational-knowledge.js";
import { StateConflictError, SourceModeError } from "../db/errors.js";
import { emptyCounters } from "../db/import/common.js";
import { importKnowledgeEntries } from "../db/import/knowledge.js";
import { openManagedDb } from "../db/managed-connection.js";
import { runMigrations } from "../db/migrations.js";
import { getCurrentKnowledgeRevision, listCurrentKnowledgeRevisions, recordKnowledgeEntryRevision } from "../db/repositories/knowledge-entry-revisions.js";
import { hasScopeFilter, runScopedKnowledgeDigest } from "./db-scope.js";

/**
 * `harness knowledge`（build-context/list/reject/promote/deprecate/import/export/show/edit
 * + nested ops + digest）を run.ts から behavior-zero で抽出。group 内 helper
 * （knowledgeDirOf/knowledgeDbContext/knowledgeExportPath/knowledgeError/isOperationalEntry/
 * collectTag/opsKnowledgeDirOf）を同梱。getHarnessRoot は opts 経由で遅延解決。
 */
export function registerKnowledgeCommands(
  program: Command,
  opts: { getHarnessRoot: () => string },
): void {
  const getHarnessRoot = opts.getHarnessRoot;
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

  const knowledgeCmd = program
    .command("knowledge")
    .description("review and promote knowledge-candidates");
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

  /** Append a repeated `--tag` value into an accumulator (commander collect). */
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

  knowledgeCmd
    .command("digest")
    .description("aggregate knowledge candidates / promotions / rejections")
    .option("--since <dur>", "only items within this window, e.g. 7d / 12h")
    .option("--domain <domain>", "restrict to one domain")
    .option("--project <id>", "scope to a project (DB-backed, Phase 6)")
    .option("--repo-id <id>", "scope to a repo (DB-backed, Phase 6)")
    .option("--json", "emit JSON instead of text")
    .action(async (raw: Record<string, unknown>) => {
      if (hasScopeFilter(raw)) {
        runScopedKnowledgeDigest(getHarnessRoot(), raw);
        return;
      }
      const harnessRoot = getHarnessRoot();
      const paths = harnessPaths(harnessRoot);
      let since: Date | undefined;
      if (raw.since !== undefined) {
        try {
          since = new Date(Date.now() - parseDuration(String(raw.since)));
        } catch (e) {
          process.stderr.write(`harness error: ${(e as Error).message}\n`);
          process.exit(1);
        }
      }
      const digest = await buildKnowledgeDigest({
        runsDir: paths.runsDir,
        knowledgeDir: join(harnessRoot, "docs", "knowledge"),
        ...(since ? { since } : {}),
        ...(raw.domain !== undefined ? { domain: String(raw.domain) } : {}),
      });
      process.stdout.write(formatDigest(digest));
    });

  // --- agent workspaces ----------------------------------------------------
  // Isolated git worktrees so multiple LLM agents / terminals can work the same
  // project concurrently without colliding on a shared checkout, while sharing
  // the harness state (HARNESS_ROOT / `.harness` DB). git is the source of truth.

  /** The repo a workspace command operates on (default: current directory). */
}
