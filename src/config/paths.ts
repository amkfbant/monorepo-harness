import { join } from "node:path";

export interface HarnessPaths {
  root: string;
  runsDir: string;
  workspacesDir: string;
  locksDir: string;
  policiesDir: string;
  globalPolicyPath: string;
  repoPolicyPath: (repoId: string) => string;
}

export function harnessPaths(root: string): HarnessPaths {
  const policiesDir = join(root, "policies");
  return {
    root,
    runsDir: join(root, "runs"),
    workspacesDir: join(root, "workspaces"),
    locksDir: join(root, "locks"),
    policiesDir,
    globalPolicyPath: join(policiesDir, "global.yaml"),
    repoPolicyPath: (id) => join(policiesDir, "repos", `${id}.yaml`),
  };
}
