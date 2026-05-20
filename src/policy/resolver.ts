import {
  DEFAULT_CODEX_TIMEOUT_MS,
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_GIT_TIMEOUT_MS,
  type GlobalPolicy,
  type RepoPolicy,
  type ResolvedPolicy,
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
    timeoutMs: global.defaults?.codex?.timeout_ms ?? DEFAULT_CODEX_TIMEOUT_MS,
  };
  const approval = global.defaults?.codex?.approval;
  if (approval !== undefined) codex.approval = approval;

  const cmdDefaultsRaw = d.commands?.defaults;
  const commandDefaults: ResolvedPolicy["commandDefaults"] = {
    timeoutMs: cmdDefaultsRaw?.timeout_ms ?? DEFAULT_COMMAND_TIMEOUT_MS,
  };
  if (cmdDefaultsRaw?.env_allowlist !== undefined) {
    commandDefaults.envAllowlist = uniq(cmdDefaultsRaw.env_allowlist);
  }

  return {
    repoId: repo.repo_id,
    domain,
    read: uniq([...repo.read, ...d.read]),
    write: uniq(d.write),
    denyWrite: uniq([...(global.always_deny_write ?? []), ...d.deny_write]),
    allowedCommands: uniq(d.commands?.allow ?? []),
    commandDefaults,
    ignoreUntracked: uniq(global.ignore_untracked ?? []),
    codex,
    limits: {
      gitTimeoutMs: global.limits?.git_timeout_ms ?? DEFAULT_GIT_TIMEOUT_MS,
    },
  };
}

function uniq<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}
