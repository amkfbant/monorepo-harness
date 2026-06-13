import { isAbsolute, resolve } from "node:path";

function hasPathSeparator(codexBin: string): boolean {
  return codexBin.includes("/") || codexBin.includes("\\");
}

export function resolveCodexBin(codexBin: string): string {
  if (isAbsolute(codexBin) || !hasPathSeparator(codexBin)) return codexBin;
  return resolve(process.cwd(), codexBin);
}
