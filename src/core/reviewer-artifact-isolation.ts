import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { existsSync, lstatSync } from "node:fs";
import { join, relative } from "node:path";
import { ReviewerAgentGateError } from "./reviewer-agent-errors.js";

/**
 * Files the reviewer agent may write during its codex window. Everything else
 * under runDir is protected by the tamper snapshot.
 */
export const REVIEWER_WRITE_ALLOWLIST = new Set([
  "reviewer-agent.out.log",
  "reviewer-agent.err.log",
  ".reviewer-agent.events.raw.jsonl",
]);

export const REVIEWER_INPUT_FILES = [
  "review-request.md",
  "summary.md",
  "final-diff.patch",
  "untracked-files.patch",
  "untracked-files.txt",
  "untracked-secrets.txt",
  "untracked-denied.txt",
] as const;

export const REVIEWER_INPUT_DIRS = ["commands"] as const;

/**
 * Verdict basenames that must NEVER be present inside the materialized reviewer
 * input dir. A reviewer's read-only codex sandbox does NOT jail reads (verified
 * codex-cli 0.139 — no readable-root config), so any verdict reachable on disk
 * could be absolute-read by a prompt-injected reviewer and collapse the
 * independence the consensus rule assumes (#272 / P1-ISO). Matched by EXACT
 * basename only — a command log such as `review-decision.yaml.out.log` is not a
 * verdict and must not trip the guard.
 */
const FORBIDDEN_INPUT_VERDICT_BASENAMES: ReadonlySet<string> = new Set([
  "review-decision.yaml",
  "review-auto-error.json",
]);

export interface ReviewerInputDirSpec {
  dir: string;
  include?: (artifactRef: string) => boolean;
}

interface FileSnapshot {
  size: number;
  mtimeMs: number;
}

export function reviewerArtifactRelDir(reviewerId: string): string {
  return `reviewers/${reviewerId}`;
}

/**
 * OS-created metadata files that are not reviewer-agent output and must be
 * ignored by the tamper snapshot: macOS Finder/Spotlight `.DS_Store` and
 * AppleDouble `._*` resource forks. The OS can create these in the run dir at
 * any time (independent of the read-only codex sandbox), so counting them as
 * tampering would false-positive the review (#269).
 */
function isOsMetadataNoise(name: string): boolean {
  return name === ".DS_Store" || name.startsWith("._");
}

/**
 * Snapshot every file under runDir (recursively — `commands/` etc. included),
 * keyed by path relative to runDir. The configured codex log files are excluded
 * since the runner legitimately writes them during the agent window.
 */
export async function snapshotRunDir(
  runDir: string,
  writablePrefix: string,
  writableAllowlist: ReadonlySet<string>,
): Promise<Map<string, FileSnapshot>> {
  const out = new Map<string, FileSnapshot>();
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        // NB: only FILES are exempted as OS noise below — never skip a
        // directory by name, or a `._foo/`-named dir could hide tamper files.
        await walk(join(dir, e.name), rel);
      } else if (e.isFile()) {
        if (isOsMetadataNoise(e.name)) continue;
        if (isAgentWritable(rel, writablePrefix, writableAllowlist)) continue;
        const st = await stat(join(dir, e.name));
        out.set(rel, { size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  }
  await walk(runDir, "");
  return out;
}

export async function verifyArtifactsUnchanged(
  runDir: string,
  before: Map<string, FileSnapshot>,
  writablePrefix: string,
  writableAllowlist: ReadonlySet<string>,
): Promise<void> {
  const after = await snapshotRunDir(runDir, writablePrefix, writableAllowlist);
  for (const [name, snap] of after) {
    const prev = before.get(name);
    if (!prev) {
      throw new ReviewerAgentGateError(
        `reviewer agent created unexpected file: ${name}`,
      );
    }
    if (prev.size !== snap.size || prev.mtimeMs !== snap.mtimeMs) {
      throw new ReviewerAgentGateError(
        `reviewer agent modified run artifact: ${name}`,
      );
    }
  }
  for (const [name] of before) {
    if (!after.has(name)) {
      throw new ReviewerAgentGateError(
        `reviewer agent deleted run artifact: ${name}`,
      );
    }
  }
}

function isAgentWritable(
  rel: string,
  writablePrefix: string,
  writableAllowlist: ReadonlySet<string>,
): boolean {
  if (writablePrefix === "" && writableAllowlist.has(rel)) return true;
  for (const name of writableAllowlist) {
    if (rel === `${writablePrefix}/${name}`) return true;
  }
  return false;
}

export async function materializeReviewerInput(
  runDir: string,
  inputDir: string,
  inputFiles: readonly string[] = REVIEWER_INPUT_FILES,
  inputDirs: readonly (string | ReviewerInputDirSpec)[] = REVIEWER_INPUT_DIRS,
): Promise<void> {
  await rm(inputDir, { recursive: true, force: true });
  await mkdir(inputDir, { recursive: true });
  for (const rel of inputFiles) {
    const src = join(runDir, rel);
    if (!existsSync(src)) continue;
    // Fail-closed: never materialize a symlink — it could resolve to a verdict
    // or sibling reviewer artifact and re-introduce the cross-reviewer leak.
    if (lstatSync(src).isSymbolicLink()) continue;
    await cp(src, join(inputDir, rel), { force: true });
  }
  for (const spec of inputDirs) {
    const rel = typeof spec === "string" ? spec : spec.dir;
    const include = typeof spec === "string" ? undefined : spec.include;
    const src = join(runDir, rel);
    if (!existsSync(src)) continue;
    if (lstatSync(src).isSymbolicLink()) continue;
    await cp(src, join(inputDir, rel), {
      recursive: true,
      force: true,
      filter: (s) => {
        const st = lstatSync(s);
        const artifactRef = artifactRefForSource(src, rel, s);
        if (st.isSymbolicLink()) return false;
        if (st.isDirectory()) return true;
        return include === undefined || include(artifactRef);
      },
    });
  }
  // Fail-closed backstop (#272 / P1-ISO): the input allowlist already excludes
  // verdicts, but assert deterministically that NO verdict was copied in before
  // codex sees the dir. If a future change ever reintroduces a verdict into the
  // reviewer cwd the review fails closed rather than leaking it cross-reviewer.
  await assertReviewerInputDirHasNoVerdict(inputDir);
}

/**
 * Deterministic, fail-closed guard (#272 / P1-ISO): scan the materialized
 * reviewer input dir recursively and throw if ANY verdict file
 * (`review-decision.yaml` / `review-auto-error.json`, exact basename) is
 * present at any depth — there must be nothing on disk for an adversarial
 * read-only reviewer to read. The verdict is DB-canonical (`review_proposals`),
 * so a sibling verdict must never reach a predictable readable path during a
 * fan-out round.
 */
export async function assertReviewerInputDirHasNoVerdict(
  inputDir: string,
): Promise<void> {
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(join(dir, e.name), rel);
      } else if (e.isFile() && FORBIDDEN_INPUT_VERDICT_BASENAMES.has(e.name)) {
        throw new ReviewerAgentGateError(
          `reviewer input dir leaked a verdict file: ${rel}`,
        );
      }
    }
  }
  await walk(inputDir, "");
}

/**
 * Remove every verdict sidecar from the run dir so NOTHING verdict-shaped is on
 * disk while a reviewer codex executes (#272). codex `--sandbox read-only` can
 * absolute-read ANY path (cwd isolation only defeats `..`-relative reads), so a
 * prior reviewer's verdict at the predictable ROOT `runs/<id>/review-decision.yaml`
 * — or a stale scoped `reviewers/<id>/review-decision.yaml` left by an earlier
 * export-ON run / rerun — is otherwise absolute-readable by the next reviewer.
 *
 * The verdict is DB-canonical (`review_proposals`), so removing the on-disk copy
 * during the round loses nothing: `exportRun` reconstructs the root verdict from
 * the DB when file export is requested (after the round / end state). Caller must
 * gate this to DB-backed, file-export-OFF review only — the no-DB legacy path
 * keeps the root verdict (it is canonical there) and export-ON keeps the sidecars
 * for back-compat. Returns the run-relative paths that were removed (audit/test).
 */
export async function suppressRunDirVerdictFiles(
  runDir: string,
): Promise<string[]> {
  const removed: string[] = [];
  const rootVerdict = join(runDir, "review-decision.yaml");
  if (existsSync(rootVerdict)) {
    await rm(rootVerdict, { force: true });
    removed.push("review-decision.yaml");
  }
  const reviewersDir = join(runDir, "reviewers");
  if (!existsSync(reviewersDir)) return removed;
  const entries = await readdir(reviewersDir, { withFileTypes: true }).catch(
    () => [],
  );
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const scoped = join(reviewersDir, entry.name, "review-decision.yaml");
    if (!existsSync(scoped)) continue;
    await rm(scoped, { force: true });
    removed.push(`reviewers/${entry.name}/review-decision.yaml`);
  }
  return removed;
}

function artifactRefForSource(
  srcRoot: string,
  relRoot: string,
  source: string,
): string {
  const local = relative(srcRoot, source).split("\\").join("/");
  return local === "" ? relRoot : `${relRoot}/${local}`;
}
