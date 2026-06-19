import process from "node:process";
import { existsSync } from "node:fs";
import type { Command } from "commander";
import { harnessPaths } from "../config/paths.js";
import { openManagedDb } from "../db/managed-connection.js";
import {
  listActiveDomainLocks,
  releaseDomainLockByDomain,
} from "../workspace/db-domain-lock.js";
import { warnLegacyFileLocks } from "../workspace/legacy-file-lock-warning.js";

/**
 * `harness lock` — domain lock の観測/解放（run.ts から behavior-zero で抽出）。
 *
 * getHarnessRoot は呼出時に env/cwd を読む遅延解決ゆえ、action 実行時に opts 経由で
 * 渡される値を使う（モジュール内で再定義しない＝定義 drift を避ける）。
 */

async function cmdLockList(getHarnessRoot: () => string): Promise<void> {
  const paths = harnessPaths(getHarnessRoot());

  // Phase 10-1: file domain locks are retired. Warn (once) if any
  // .harness/locks/*.lock sentinels are still lying around.
  warnLegacyFileLocks(paths.locksDir);

  // DB-backed locks (Phase 9 lease + heartbeat + fencing token).
  // Phase 9 post-close (second review) P2-3 fix — lock list is purely
  // observational. A missing DB, an old schema (pre-v5), or a missing
  // `domain_locks` table must NOT crash the command; surface them as
  // structured "unavailable" messages.
  process.stdout.write("db locks:\n");
  if (!existsSync(paths.dbPath)) {
    process.stdout.write("  (db not initialised — run 'harness db init')\n");
    return;
  }
  const dbHandle = openManagedDb({ dbPath: paths.dbPath, readonly: true });
  const db = dbHandle.db;
  try {
    const hasTable = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'domain_locks'",
      )
      .get();
    if (hasTable === undefined) {
      process.stdout.write(
        "  (unavailable — schema < v5; run 'harness db migrate')\n",
      );
      return;
    }
    const rows = listActiveDomainLocks(db);
    if (rows.length === 0) {
      process.stdout.write("  (none)\n");
      return;
    }
    for (const r of rows) {
      process.stdout.write(
        `  ${r.domainKey}\tlock_id=${r.lockId}\trunId=${r.holderRunId}\tpid=${r.holderPid}\thost=${r.holderHostname}\texpires=${r.expiresAt}\theartbeat=${r.heartbeatAt}\n`,
      );
    }
  } finally {
    dbHandle.close();
  }
}

interface LockReleaseOpts {
  domain: string;
  repoId?: string;
  runId?: string;
  force?: boolean;
  /**
   * Phase 10-1: source selector is retained as a deprecated CLI flag for
   * a short transition. `file` and `both` emit a stderr warning; only the
   * DB-backed lock is actually released. Default = DB-only.
   */
  source?: "file" | "db" | "both";
}

async function cmdLockRelease(
  getHarnessRoot: () => string,
  o: LockReleaseOpts,
): Promise<void> {
  const paths = harnessPaths(getHarnessRoot());
  let releasedAny = false;

  // Phase 10-1 post-review P2: `--source file` and `--source both` are
  // both deprecated; warn but still perform the DB release so stale
  // operator scripts that still pass `--source file` actually clear the
  // current (DB) lock.
  if (o.source === "file") {
    process.stderr.write(
      "warning: `--source file` is deprecated in Phase 10 — file domain " +
        "locks are no longer used. Continuing with a DB lock release.\n",
    );
  } else if (o.source === "both") {
    process.stderr.write(
      "warning: `--source both` is deprecated in Phase 10 — only the DB " +
        "domain lock is released.\n",
    );
  }

  // Surface any legacy file lock sentinels so operators know to clean them up.
  warnLegacyFileLocks(paths.locksDir);

  if (existsSync(paths.dbPath)) {
    const dbHandle = openManagedDb({ dbPath: paths.dbPath });
    const db = dbHandle.db;
    try {
      // `domain_key` mirrors workflow-runner's `${repoId}::${domain}`.
      const domainKey =
        o.repoId !== undefined ? `${o.repoId}::${o.domain}` : o.domain;
      // forcing through a runId mismatch is destructive: the heartbeat side
      // will fail with LeaseStolenError. Surface a strong warning.
      if (o.force === true) {
        process.stderr.write(
          "warning: --force on an active DB lease may cause the running " +
            "harness process to fail with LeaseStolenError.\n",
        );
      }
      const r = releaseDomainLockByDomain(db, {
        domainKey,
        ...(o.runId !== undefined ? { runId: o.runId } : {}),
        ...(o.force === true ? { force: true } : {}),
        releasedBy: "cli",
      });
      if (r !== null) {
        process.stdout.write(
          `released db lock ${r.domainKey} (lock_id=${r.lockId}, holder=${r.holderRunId})\n`,
        );
        releasedAny = true;
      }
    } finally {
      dbHandle.close();
    }
  }

  if (!releasedAny) {
    process.stdout.write(
      `no lock for domain ${o.domain}${o.repoId ? ` (repo ${o.repoId})` : ""}\n`,
    );
  }
}

export function registerLockCommands(
  program: Command,
  opts: { getHarnessRoot: () => string },
): void {
  const lockCmd = program.command("lock").description("manage domain locks");
  lockCmd
    .command("list")
    .description("list active domain locks")
    .action(async () => {
      await cmdLockList(opts.getHarnessRoot);
    });
  lockCmd
    .command("release")
    .description("force-release a domain lock (e.g. after crashed run)")
    .requiredOption("--domain <name>", "domain whose lock to release")
    .option("--repo-id <id>", "repo id (namespaced locks created by `harness run`)")
    .option("--run-id <id>", "only release if the lock belongs to this runId")
    .option("--force", "release even on runId mismatch / unreadable lock", false)
    .option(
      "--source <which>",
      "(deprecated, Phase 10) file | db | both — `file`/`both` warn and only" +
        " the DB lock is released; default is `db`",
      "db",
    )
    .action(async (raw: Record<string, unknown>) => {
      const source = String(raw.source);
      if (source !== "file" && source !== "db" && source !== "both") {
        process.stderr.write(
          `harness error: --source must be one of file | db | both (got ${JSON.stringify(source)})\n`,
        );
        process.exit(1);
      }
      await cmdLockRelease(opts.getHarnessRoot, {
        domain: String(raw.domain),
        ...(raw.repoId !== undefined ? { repoId: String(raw.repoId) } : {}),
        ...(raw.runId !== undefined ? { runId: String(raw.runId) } : {}),
        force: Boolean(raw.force),
        source: source as "file" | "db" | "both",
      });
    });
}
