import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export class KnowledgePromoteGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgePromoteGateError";
  }
}

const RUN_ID_RE = /^run-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface KnowledgeCandidate {
  kind: string;
  domain: string;
  title: string;
  content: string;
  evidence: string[];
  confidence: "low" | "medium" | "high";
  status: string;
}

export interface PromoteOpts {
  runsDir: string;
  /** absolute path of the directory to write knowledge files into */
  knowledgeDir: string;
  runId: string;
  /** if set, only candidates whose kind matches are promoted */
  kind?: string;
}

export interface PromotedFile {
  kind: string;
  title: string;
  path: string;
}

export interface PromoteResult {
  runId: string;
  promoted: PromotedFile[];
  /** count of candidates skipped because of the --kind filter */
  skipped: number;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "untitled";
}

function isCandidate(x: unknown): x is KnowledgeCandidate {
  if (!x || typeof x !== "object") return false;
  const c = x as Record<string, unknown>;
  return (
    typeof c.kind === "string" &&
    typeof c.domain === "string" &&
    typeof c.title === "string" &&
    typeof c.content === "string" &&
    Array.isArray(c.evidence) &&
    typeof c.confidence === "string"
  );
}

/**
 * Promote knowledge-candidates.yaml entries into individual markdown
 * files under `<knowledgeDir>/<kind>/<runId>-<idx>-<title-slug>.md`.
 * The original yaml is untouched (audit). Appends a `knowledge_promoted`
 * event to events.jsonl.
 */
export async function promoteKnowledge(
  opts: PromoteOpts,
): Promise<PromoteResult> {
  if (!RUN_ID_RE.test(opts.runId)) {
    throw new KnowledgePromoteGateError(
      `invalid runId: ${JSON.stringify(opts.runId)}`,
    );
  }
  const runDir = join(opts.runsDir, opts.runId);
  const candidatesPath = join(runDir, "knowledge-candidates.yaml");
  if (!existsSync(candidatesPath)) {
    throw new KnowledgePromoteGateError(
      `${candidatesPath} not found`,
    );
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(await readFile(candidatesPath, "utf8"));
  } catch (e) {
    throw new KnowledgePromoteGateError(
      `failed to parse ${candidatesPath}: ${(e as Error).message}`,
    );
  }
  const candidates =
    parsed && typeof parsed === "object" && Array.isArray((parsed as { candidates?: unknown }).candidates)
      ? (parsed as { candidates: unknown[] }).candidates
      : [];

  const promoted: PromotedFile[] = [];
  let skipped = 0;

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!isCandidate(c)) {
      skipped++;
      continue;
    }
    if (opts.kind !== undefined && c.kind !== opts.kind) {
      skipped++;
      continue;
    }
    const slug = slugify(c.title);
    const filename = `${opts.runId}-${String(i).padStart(2, "0")}-${slug}.md`;
    const kindDir = join(opts.knowledgeDir, c.kind);
    await mkdir(kindDir, { recursive: true });
    const outPath = join(kindDir, filename);
    const body = [
      `# ${c.title}`,
      "",
      `- **kind**: ${c.kind}`,
      `- **domain**: ${c.domain}`,
      `- **confidence**: ${c.confidence}`,
      `- **status**: promoted (from candidate ${c.status})`,
      `- **evidence**: ${c.evidence.join(", ") || "(none)"}`,
      `- **source run**: ${opts.runId}`,
      `- **source index**: ${i}`,
      "",
      "## Content",
      "",
      c.content,
      "",
    ].join("\n");
    await writeFile(outPath, body, "utf8");
    promoted.push({ kind: c.kind, title: c.title, path: outPath });
  }

  await appendFile(
    join(runDir, "events.jsonl"),
    `${JSON.stringify({
      type: "knowledge_promoted",
      runId: opts.runId,
      ...(opts.kind !== undefined ? { kindFilter: opts.kind } : {}),
      promotedCount: promoted.length,
      skipped,
      files: promoted.map((p) => p.path),
    })}\n`,
    "utf8",
  );

  return { runId: opts.runId, promoted, skipped };
}
