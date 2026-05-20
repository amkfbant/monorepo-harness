import { readdirSync, existsSync } from "node:fs";

export function nextRunId(runsDir: string, now: Date = new Date()): string {
  const yyyy = now.getUTCFullYear().toString().padStart(4, "0");
  const mm = (now.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = now.getUTCDate().toString().padStart(2, "0");
  const day = `${yyyy}${mm}${dd}`;
  const prefix = `run-${day}-`;
  const existing = existsSync(runsDir)
    ? readdirSync(runsDir).filter((e) => e.startsWith(prefix))
    : [];
  const max = existing
    .map((e) => Number.parseInt(e.slice(prefix.length), 10))
    .filter((n) => Number.isFinite(n))
    .reduce((a, b) => Math.max(a, b), 0);
  const next = (max + 1).toString().padStart(3, "0");
  return `${prefix}${next}`;
}
