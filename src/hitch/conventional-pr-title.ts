/**
 * Build a Conventional-Commit PR title (= squash commit subject) for a hitch's
 * PR so release-please picks hitch-mode changes up in the CHANGELOG / version
 * bump (#103). Previously the title/commit was `harness: run-<id>`, which
 * release-please does not recognise as a `feat:`/`fix:` change.
 *
 * The commit type is derived from the hitch title (no new schema): if the title
 * is already Conventional it is kept verbatim, otherwise it is prefixed with
 * `defaultType` (default `fix`). The run id is appended as `(run-<id>)` for
 * traceability — `(#NN)` is avoided because GitHub would autolink it to an
 * unrelated issue.
 *
 * The hitch title is operator/LLM-supplied (`harness.hitch.start`), so it is
 * sanitized before it reaches the squash commit subject (#103 review): only the
 * first line is used — a multi-line title would otherwise let body/footer
 * content (e.g. a `BREAKING CHANGE:` footer) drive release-please version bumps
 * from non-operator input — control characters are stripped, and the subject is
 * length-capped.
 */
const CONVENTIONAL_RE =
  /^(?:feat|fix|refactor|test|docs|chore|perf|ci|build|style|revert)(?:\([^)]+\))?!?: /;

const MAX_SUBJECT_LEN = 120;

function sanitizeTitle(raw: string): string {
  const firstLine = raw.split(/\r?\n/, 1)[0] ?? "";
  // collapse ASCII control chars (incl. embedded tabs) to a single space so
  // nothing but printable text reaches the commit subject
  // eslint-disable-next-line no-control-regex
  const cleaned = firstLine.replace(/[\u0000-\u001F\u007F]+/g, " ").trim();
  return cleaned.length > MAX_SUBJECT_LEN
    ? cleaned.slice(0, MAX_SUBJECT_LEN).trimEnd()
    : cleaned;
}

export function conventionalPrTitle(opts: {
  hitchTitle: string;
  runId: string;
  defaultType?: string;
}): string {
  const title = sanitizeTitle(opts.hitchTitle);
  const type = opts.defaultType ?? "fix";
  const subject = CONVENTIONAL_RE.test(title)
    ? title
    : `${type}: ${title === "" ? opts.runId : title}`;
  return `${subject} (${opts.runId})`;
}
