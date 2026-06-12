import { spawnSync } from "node:child_process";

const codexVersionCache = new Map<string, string | null>();

export function codexBinaryVersion(codexBin: string): string | null {
  const cached = codexVersionCache.get(codexBin);
  if (cached !== undefined || codexVersionCache.has(codexBin)) return cached ?? null;

  const result = spawnSync(codexBin, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  let version: string | null = null;
  if (result.error === undefined && result.status === 0) {
    const firstLine = result.stdout.split(/\r?\n/, 1)[0]?.trim() ?? "";
    version = firstLine === "" ? null : firstLine;
  }
  codexVersionCache.set(codexBin, version);
  return version;
}
