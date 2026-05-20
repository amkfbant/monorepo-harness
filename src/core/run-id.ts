import { randomUUID } from "node:crypto";

export interface GenerateRunIdOpts {
  domain: string;
  now?: Date;
}

function dateSlug(now: Date): string {
  const y = now.getUTCFullYear().toString().padStart(4, "0");
  const m = (now.getUTCMonth() + 1).toString().padStart(2, "0");
  const d = now.getUTCDate().toString().padStart(2, "0");
  return `${y}${m}${d}`;
}

function domainSlug(domain: string): string {
  return domain
    .toLowerCase()
    .replace(/[^a-z0-9/]+/g, "-")
    .replace(/\//g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function randomSuffix(now: Date): string {
  // time-monotonic prefix + 8 hex chars of entropy (~32 bits).
  // collisions across runs are extremely improbable.
  const t = now.getTime().toString(36);
  const r = randomUUID().replace(/-/g, "").slice(0, 8);
  return `${t}${r}`;
}

export function generateRunId(opts: GenerateRunIdOpts): string {
  const now = opts.now ?? new Date();
  return `run-${dateSlug(now)}-${domainSlug(opts.domain)}-${randomSuffix(now)}`;
}
