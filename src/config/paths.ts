import { join } from "node:path";

export interface HarnessPaths {
  root: string;
  runsDir: string;
  workspacesDir: string;
  locksDir: string;
  policiesDir: string;
  globalPolicyPath: string;
  repoPolicyPath: (repoId: string) => string;
  /** SQLite run index (Phase 3-5). source of truth stays runs/ files. */
  indexDbPath: string;
  /** personal backlog dir (Phase 4-3): open/ doing/ done/ deferred/. */
  backlogDir: string;
}

// repo identifiers are interpolated directly into a filesystem path, so they
// must NOT contain path separators, `..`, leading/trailing dots, or control
// characters. Without this guard, `--repo-id ../../etc/passwd` would resolve
// outside policies/repos and the harness would silently use the wrong policy.
const REPO_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function assertValidRepoId(id: string): void {
  if (!REPO_ID_RE.test(id) || id.includes("..")) {
    throw new Error(
      `invalid repo id: ${JSON.stringify(id)} (allowed: [A-Za-z0-9][A-Za-z0-9._-]{0,63}, no '..')`,
    );
  }
}

export function harnessPaths(root: string): HarnessPaths {
  const policiesDir = join(root, "policies");
  return {
    root,
    runsDir: join(root, "runs"),
    workspacesDir: join(root, "workspaces"),
    locksDir: join(root, "locks"),
    policiesDir,
    indexDbPath: join(root, ".harness", "index.sqlite"),
    backlogDir: join(root, "backlog"),
    globalPolicyPath: join(policiesDir, "global.yaml"),
    repoPolicyPath: (id) => {
      assertValidRepoId(id);
      return join(policiesDir, "repos", `${id}.yaml`);
    },
  };
}
