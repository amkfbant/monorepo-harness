/**
 * Build a Conventional-Commit PR title (= squash commit subject) for a goal's
 * PR so release-please picks goal-mode changes up in the CHANGELOG / version
 * bump (#103). Previously the title/commit was `harness: run-<id>`, which
 * release-please does not recognise as a `feat:`/`fix:` change.
 *
 * The commit type is derived from the goal title (no new schema): if the title
 * is already Conventional it is kept verbatim, otherwise it is prefixed with
 * `defaultType` (default `fix`). The run id is appended as `(run-<id>)` for
 * traceability — `(#NN)` is avoided because GitHub would autolink it to an
 * unrelated issue.
 */
const CONVENTIONAL_RE =
  /^(?:feat|fix|refactor|test|docs|chore|perf|ci|build|style|revert)(?:\([^)]+\))?!?: /;

export function conventionalPrTitle(opts: {
  goalTitle: string;
  runId: string;
  defaultType?: string;
}): string {
  const title = opts.goalTitle.trim();
  const type = opts.defaultType ?? "fix";
  const subject = CONVENTIONAL_RE.test(title)
    ? title
    : `${type}: ${title === "" ? opts.runId : title}`;
  return `${subject} (${opts.runId})`;
}
