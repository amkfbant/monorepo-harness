import {
  DEFAULT_CHANGE_BUDGET,
  DEFAULT_CODEX_TIMEOUT_MS,
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_GIT_TIMEOUT_MS,
  type ChangeBudget,
  type ChangeBudgetConfig,
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
    // Structured form ALWAYS uses argv (shell:false), even when args is
    // empty. Falling back to shell:true would silently re-enable shell
    // interpretation (`$VAR`, quoting) and break the no-escape contract
    // operators rely on when they opt into the structured shape.
    const resolved: ResolvedCommand = {
      id: e.id,
      cmd: e.cmd,
      args: e.args,
      shell: false,
    };
    if (e.timeout_ms !== undefined) resolved.timeoutMs = e.timeout_ms;
    if (e.env !== undefined) resolved.env = e.env;
    return resolved;
  });
}

function resolveChangeBudget(
  globalBudget: ChangeBudgetConfig | undefined,
  domainBudget: ChangeBudgetConfig | undefined,
): ChangeBudget {
  const merged: ChangeBudgetConfig = {
    ...(globalBudget ?? {}),
    ...(domainBudget ?? {}),
  };
  return {
    maxDeletedLines:
      merged.max_deleted_lines ?? DEFAULT_CHANGE_BUDGET.maxDeletedLines,
    maxTotalChangedLines:
      merged.max_total_changed_lines ??
      DEFAULT_CHANGE_BUDGET.maxTotalChangedLines,
    maxDeletedFiles:
      merged.max_deleted_files ?? DEFAULT_CHANGE_BUDGET.maxDeletedFiles,
    maxChangedFiles:
      merged.max_changed_files ?? DEFAULT_CHANGE_BUDGET.maxChangedFiles,
    enforce: merged.enforce ?? DEFAULT_CHANGE_BUDGET.enforce,
  };
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
  // #206: only set when the operator declares a model, so a no-config policy
  // leaves codex.model undefined → telemetry model NULL → run_usage byte-stable.
  const codexModel = global.defaults?.codex?.model;
  if (codexModel !== undefined) codex.model = codexModel;
  // #191: only set when declared so an unconfigured policy stays byte-stable
  // (backend undefined → resolveAgentBackend falls back to env, then codex).
  const backend = global.defaults?.codex?.backend;
  if (backend !== undefined) codex.backend = backend;
  const claudeModel = global.defaults?.codex?.claude_model;
  if (claudeModel !== undefined) codex.claudeModel = claudeModel;

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
      changeBudget: resolveChangeBudget(
        global.limits?.change_budget,
        d.change_budget,
      ),
    },
  };
}

function uniq<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}
