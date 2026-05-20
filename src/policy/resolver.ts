import type {
  GlobalPolicy,
  RepoPolicy,
  ResolvedPolicy,
} from "./schema.js";

export function resolvePolicy(
  global: GlobalPolicy,
  repo: RepoPolicy,
  domain: string,
): ResolvedPolicy {
  const d = repo.domains[domain];
  if (!d) {
    throw new Error(
      `policy: domain "${domain}" not found in repo "${repo.repo_id}"`,
    );
  }
  const codex: ResolvedPolicy["codex"] = {
    sandbox: global.defaults?.codex?.sandbox ?? "workspace-write",
  };
  const approval = global.defaults?.codex?.approval;
  if (approval !== undefined) codex.approval = approval;
  return {
    repoId: repo.repo_id,
    domain,
    read: uniq([...repo.read, ...d.read]),
    write: uniq(d.write),
    denyWrite: uniq([...(global.always_deny_write ?? []), ...d.deny_write]),
    allowedCommands: uniq(d.commands?.allow ?? []),
    codex,
  };
}

function uniq<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}
