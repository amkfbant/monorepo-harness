import {
  DEFAULT_CODEX_TIMEOUT_MS,
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_GIT_TIMEOUT_MS,
  type CommandEntry,
  type GlobalPolicy,
  type RepoPolicy,
  type ResolvedCommand,
  type ResolvedPolicy,
} from "./schema.js";

function resolveCommands(
  entries: readonly CommandEntry[] | undefined,
): ResolvedCommand[] {
  if (!entries || entries.length === 0) return [];
  return entries.map((e, i): ResolvedCommand => {
    if (typeof e === "string") {
      return {
        id: `cmd-${i}`,
        cmd: e,
        args: [],
        shell: true,
      };
    }
    const resolved: ResolvedCommand = {
      id: e.id,
      cmd: e.cmd,
      args: e.args,
      shell: e.args.length === 0,
    };
    if (e.timeout_ms !== undefined) resolved.timeoutMs = e.timeout_ms;
    if (e.env !== undefined) resolved.env = e.env;
    return resolved;
  });
}

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

  const resolvedCommands = resolveCommands(d.commands?.allow);
  // Reject duplicate ids (operators sometimes copy-paste entries).
  const seen = new Set<string>();
  for (const c of resolvedCommands) {
    if (seen.has(c.id)) {
      throw new Error(
        `policy: duplicate command id "${c.id}" in domain "${domain}"`,
      );
    }
    seen.add(c.id);
  }

  return {
    repoId: repo.repo_id,
    domain,
    read: uniq([...repo.read, ...d.read]),
    write: uniq(d.write),
    denyWrite: uniq([...(global.always_deny_write ?? []), ...d.deny_write]),
    allowedCommands: resolvedCommands,
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
