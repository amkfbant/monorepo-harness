import { spawnSync } from "node:child_process";
import {
  DEFAULT_CODEX_ENV_ALLOWLIST,
  filterEnv,
} from "./codex-cli-runner.js";
import { resolveCodexBin } from "./resolve-codex-bin.js";

const codexVersionCache = new Map<string, string | null>();

export function codexBinaryVersion(codexBin: string): string | null {
  const resolvedCodexBin = resolveCodexBin(codexBin);
  const cached = codexVersionCache.get(resolvedCodexBin);
  if (cached !== undefined || codexVersionCache.has(resolvedCodexBin)) {
    return cached ?? null;
  }

  const result = spawnSync(resolvedCodexBin, ["--version"], {
    encoding: "utf8",
    env: filterEnv(process.env, DEFAULT_CODEX_ENV_ALLOWLIST),
    timeout: 5_000,
  });
  let version: string | null = null;
  if (result.error === undefined && result.status === 0) {
    const firstLine = result.stdout.split(/\r?\n/, 1)[0]?.trim() ?? "";
    version = firstLine === "" ? null : firstLine;
  }
  codexVersionCache.set(resolvedCodexBin, version);
  return version;
}
