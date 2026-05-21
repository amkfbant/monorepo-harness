import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RunMeta } from "../logging/run-log.js";
import { loadReviewDecision } from "./review-decision-loader.js";

/**
 * Thrown when a rerun is refused for a user-fixable reason (parent missing,
 * parent in wrong status, malformed review-decision, attempt cap reached).
 * CLI maps to exit 1.
 */
export class RerunGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RerunGateError";
  }
}

const RUN_ID_RE = /^run-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/**
 * Soft cap on the rerun prompt body. 64 KiB is well above any realistic
 * task description but well below typical model context limits; the
 * intent is to fail with a clear error instead of silently sending an
 * oversized prompt.
 */
const MAX_RERUN_PROMPT_BYTES = 64 * 1024;

/** Default bound on retry attempts measured from the chain root. */
export const DEFAULT_MAX_ATTEMPTS = 2;

/**
 * The rerun goal template (Phase 3-3). prepareRerunFromReview wraps the
 * parent goal with the previous review's required_changes; the result is
 * fed to the coder template (coder-domain-task) as the new goal.
 */
export const RERUN_PROMPT_TEMPLATE = {
  name: "rerun-from-review",
  version: 1,
} as const;

export interface RerunPrepResult {
  parentRunId: string;
  repoId: string;
  /**
   * the parent's project id, when the parent was a `--project` run. The
   * rerun must re-resolve the profile (not read `policies/repos/<id>.yaml`)
   * so the child keeps the same compiled policy / context packs / project
   * provenance — see Phase 6-1.
   */
  projectId?: string;
  domain: string;
  baseBranch: string;
  /** chain root (the original `harness run`) */
  rootRunId: string;
  /** retry count this child will carry (parent.rerunAttempt + 1) */
  rerunAttempt: number;
  /** the prompt for the next codex run: original goal + required_changes block */
  goal: string;
  /** non-fatal advisories (e.g. the same required_changes repeated) */
  warnings: string[];
}

interface ParentMeta {
  meta: RunMeta;
  raw: Record<string, unknown>;
}

async function readMetaObject(
  runsDir: string,
  runId: string,
): Promise<ParentMeta> {
  const metaPath = join(runsDir, runId, "meta.json");
  let metaRaw: unknown;
  try {
    metaRaw = JSON.parse(await readFile(metaPath, "utf8"));
  } catch (e) {
    throw new RerunGateError(
      `failed to read meta.json for ${runId}: ${(e as Error).message}`,
    );
  }
  if (!metaRaw || typeof metaRaw !== "object" || Array.isArray(metaRaw)) {
    throw new RerunGateError(`meta.json for ${runId} is not an object`);
  }
  return { meta: metaRaw as RunMeta, raw: metaRaw as Record<string, unknown> };
}

/**
 * Determine the parent run's position in its rerun chain:
 *   - rootRunId: the original `harness run`
 *   - parentAttempt: how many reruns deep the parent itself is
 *
 * Fast path: the parent records rootRunId + rerunAttempt (runs created by
 * Phase 2-7+). Otherwise the parent is either an original run, or a
 * LEGACY rerun (has parentRunId but no chain fields) — in the latter case
 * we walk parentRunId links to reconstruct the depth, so --max-attempts
 * cannot be bypassed by reruns of a pre-2-7 chain.
 */
async function resolveParentChainPosition(
  runsDir: string,
  parentRunId: string,
  parentMeta: RunMeta,
): Promise<{ rootRunId: string; parentAttempt: number }> {
  if (
    typeof parentMeta.rootRunId === "string" &&
    typeof parentMeta.rerunAttempt === "number"
  ) {
    return {
      rootRunId: parentMeta.rootRunId,
      parentAttempt: parentMeta.rerunAttempt,
    };
  }
  // No chain fields. If the parent has no parentRunId it is an original run.
  if (typeof parentMeta.parentRunId !== "string") {
    return { rootRunId: parentRunId, parentAttempt: 0 };
  }
  // Legacy rerun: walk parentRunId links up to the root, counting hops.
  let currentId = parentRunId;
  let currentMeta = parentMeta;
  let depth = 0;
  const seen = new Set<string>([currentId]);
  for (;;) {
    const p = currentMeta.parentRunId;
    if (typeof p !== "string") break; // reached the original run
    if (seen.has(p)) {
      throw new RerunGateError(
        `rerun chain has a cycle at ${p}; cannot reconstruct chain depth`,
      );
    }
    seen.add(p);
    const { meta } = await readMetaObject(runsDir, p);
    depth += 1;
    currentId = p;
    currentMeta = meta;
  }
  return { rootRunId: currentId, parentAttempt: depth };
}

/**
 * Read a parent run's meta + review-decision and prepare the inputs for a
 * follow-up `harness run`. Does NOT itself invoke the workflow — that
 * happens in CLI so it stays composable with the existing entry point.
 */
export async function prepareRerunFromReview(opts: {
  runsDir: string;
  parentRunId: string;
  /** retry cap measured from the chain root; default DEFAULT_MAX_ATTEMPTS */
  maxAttempts?: number;
}): Promise<RerunPrepResult> {
  if (!RUN_ID_RE.test(opts.parentRunId)) {
    throw new RerunGateError(
      `invalid parentRunId: ${JSON.stringify(opts.parentRunId)}`,
    );
  }
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RerunGateError(
      `maxAttempts must be a positive integer (got ${String(maxAttempts)})`,
    );
  }
  const runDir = join(opts.runsDir, opts.parentRunId);

  const { meta } = await readMetaObject(opts.runsDir, opts.parentRunId);

  // parent must be in changes_requested (covers cleaned / failed / etc.)
  if (meta.status !== "changes_requested") {
    throw new RerunGateError(
      `parent run ${opts.parentRunId} status is "${meta.status}", only changes_requested can be reused as a rerun base`,
    );
  }
  if (
    typeof meta.repoId !== "string" ||
    typeof meta.domain !== "string" ||
    typeof meta.baseBranch !== "string"
  ) {
    throw new RerunGateError(
      `meta.json for ${opts.parentRunId} is missing repoId / domain / baseBranch`,
    );
  }

  // chain bookkeeping: the child's attempt count is one more than the
  // parent's. The parent's own position is read from its meta when
  // recorded (rootRunId + rerunAttempt), and otherwise RECONSTRUCTED by
  // walking parentRunId links — a legacy rerun (Phase 2-4, no chain
  // fields) must not be mistaken for an original run, or --max-attempts
  // would undercount the real chain depth.
  const { rootRunId, parentAttempt } = await resolveParentChainPosition(
    opts.runsDir,
    opts.parentRunId,
    meta,
  );
  const rerunAttempt = parentAttempt + 1;

  if (rerunAttempt > maxAttempts) {
    throw new RerunGateError(
      `rerun would be attempt ${rerunAttempt} from root ${rootRunId}, exceeding --max-attempts ${maxAttempts}. ` +
        `The chain is not converging — review manually instead of another rerun.`,
    );
  }

  let decision: Awaited<ReturnType<typeof loadReviewDecision>>;
  try {
    decision = await loadReviewDecision(
      join(runDir, "review-decision.yaml"),
    );
  } catch (e) {
    throw new RerunGateError(
      `failed to read review-decision.yaml for ${opts.parentRunId}: ${(e as Error).message}`,
    );
  }

  if (
    decision.decision !== "changes_requested" ||
    decision.required_changes.length === 0
  ) {
    throw new RerunGateError(
      `${opts.parentRunId} review-decision.yaml must have decision=changes_requested and at least one required_changes entry`,
    );
  }

  const warnings: string[] = [];
  // Convergence advisory: if the grandparent asked for the SAME changes,
  // the previous rerun didn't address the feedback.
  if (typeof meta.parentRunId === "string") {
    try {
      const grandDecision = await loadReviewDecision(
        join(opts.runsDir, meta.parentRunId, "review-decision.yaml"),
      );
      if (
        sameChanges(
          grandDecision.required_changes,
          decision.required_changes,
        )
      ) {
        warnings.push(
          `required_changes are identical to the previous attempt (${meta.parentRunId}); the rerun is not converging`,
        );
      }
    } catch {
      // grandparent decision unreadable — skip the advisory
    }
  }

  // Recover the original goal from the parent's codex-prompt.md.
  let parentGoal = "(parent goal could not be recovered)";
  try {
    const prompt = await readFile(join(runDir, "codex-prompt.md"), "utf8");
    const m = prompt.match(/^Goal:\s*\n([\s\S]*?)\n\nTarget domain:/m);
    if (m && m[1]) parentGoal = m[1].trim();
  } catch {
    // best effort; we already have a fallback
  }

  const changesBullets = decision.required_changes
    .map((c) => `- ${c}`)
    .join("\n");
  const goal = [
    parentGoal,
    "",
    `## Required changes from the previous review (${RERUN_PROMPT_TEMPLATE.name} v${RERUN_PROMPT_TEMPLATE.version})`,
    "",
    `Previous run: ${opts.parentRunId} (status: changes_requested)`,
    `Rerun attempt: ${rerunAttempt} (root: ${rootRunId})`,
    `Reviewer: ${decision.reviewer ?? "(unknown)"}`,
    "",
    "Apply these specific changes on top of the previous attempt:",
    changesBullets,
  ].join("\n");

  const goalBytes = Buffer.byteLength(goal, "utf8");
  if (goalBytes > MAX_RERUN_PROMPT_BYTES) {
    throw new RerunGateError(
      `rerun goal would be ${goalBytes} bytes (parent goal plus required_changes); cap is ${MAX_RERUN_PROMPT_BYTES}. Shorten the goal or split into smaller required_changes.`,
    );
  }

  return {
    parentRunId: opts.parentRunId,
    repoId: meta.repoId,
    ...(typeof meta.project?.projectId === "string"
      ? { projectId: meta.project.projectId }
      : {}),
    domain: meta.domain,
    baseBranch: meta.baseBranch,
    rootRunId,
    rerunAttempt,
    goal,
    warnings,
  };
}

function sameChanges(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const norm = (xs: string[]) => [...xs].map((x) => x.trim()).sort();
  const na = norm(a);
  const nb = norm(b);
  return na.every((x, i) => x === nb[i]);
}

// --- rerun chain ----------------------------------------------------------

export interface ChainNode {
  runId: string;
  status: RunMeta["status"] | "?";
  parentRunId: string | null;
  rerunAttempt: number | null;
  children: ChainNode[];
}

const RUN_DIR_RE = /^run-[A-Za-z0-9][A-Za-z0-9._-]+$/;

/**
 * Build the rerun chain that `runId` belongs to. Walks parentRunId links
 * (robust even for pre-2-7 reruns that lack rootRunId) up to the root,
 * then assembles the descendant tree by scanning runs/.
 */
export async function buildRerunChain(opts: {
  runsDir: string;
  runId: string;
}): Promise<ChainNode> {
  if (!RUN_ID_RE.test(opts.runId)) {
    throw new RerunGateError(
      `invalid runId: ${JSON.stringify(opts.runId)}`,
    );
  }
  if (!existsSync(join(opts.runsDir, opts.runId, "meta.json"))) {
    throw new RerunGateError(`run ${opts.runId} not found`);
  }

  // index every run dir's parentRunId / status
  interface Info {
    parentRunId: string | null;
    status: RunMeta["status"] | "?";
    rerunAttempt: number | null;
  }
  const index = new Map<string, Info>();
  let entries: string[] = [];
  try {
    entries = (await readdir(opts.runsDir)).filter((e) =>
      RUN_DIR_RE.test(e),
    );
  } catch {
    entries = [];
  }
  for (const id of entries) {
    try {
      const raw = JSON.parse(
        await readFile(join(opts.runsDir, id, "meta.json"), "utf8"),
      ) as RunMeta;
      index.set(id, {
        parentRunId:
          typeof raw.parentRunId === "string" ? raw.parentRunId : null,
        status: typeof raw.status === "string" ? raw.status : "?",
        rerunAttempt:
          typeof raw.rerunAttempt === "number" ? raw.rerunAttempt : null,
      });
    } catch {
      index.set(id, {
        parentRunId: null,
        status: "?",
        rerunAttempt: null,
      });
    }
  }

  // walk up to the root
  let rootId = opts.runId;
  const seen = new Set<string>([rootId]);
  for (;;) {
    const info = index.get(rootId);
    const parent = info?.parentRunId;
    if (!parent || !index.has(parent) || seen.has(parent)) break;
    rootId = parent;
    seen.add(rootId);
  }

  // assemble descendant tree
  const build = (id: string, guard: Set<string>): ChainNode => {
    const info = index.get(id);
    const children: ChainNode[] = [];
    for (const [childId, childInfo] of index) {
      if (childInfo.parentRunId === id && !guard.has(childId)) {
        guard.add(childId);
        children.push(build(childId, guard));
      }
    }
    children.sort((a, b) => a.runId.localeCompare(b.runId));
    return {
      runId: id,
      status: info?.status ?? "?",
      parentRunId: info?.parentRunId ?? null,
      rerunAttempt: info?.rerunAttempt ?? null,
      children,
    };
  };
  return build(rootId, new Set([rootId]));
}

/** Render a ChainNode tree as an indented text block with proper branches. */
export function formatChain(root: ChainNode): string {
  const label = (n: ChainNode): string => {
    const attempt =
      n.rerunAttempt !== null ? ` (attempt ${n.rerunAttempt})` : "";
    return `${n.runId}  ${n.status}${attempt}`;
  };
  const lines: string[] = [label(root)];
  // `prefix` is the accumulated indentation for the current subtree;
  // siblings get ├─, the last child gets └─, descendants of a non-last
  // sibling keep a │ guide.
  const walk = (children: ChainNode[], prefix: string): void => {
    children.forEach((child, i) => {
      const isLast = i === children.length - 1;
      lines.push(`${prefix}${isLast ? "└─ " : "├─ "}${label(child)}`);
      walk(child.children, prefix + (isLast ? "   " : "│  "));
    });
  };
  walk(root.children, "");
  return lines.join("\n") + "\n";
}
