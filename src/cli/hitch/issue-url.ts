// Strict, fail-closed validator for `hitch finding defer --to-issue <url>` (#90
// Stage B). We accept ONLY a canonical GitHub issue URL —
// https://github.com/<owner>/<repo>/issues/<N> — and reject everything else
// (http, enterprise hosts, pull/<N>, query strings, fragments, control chars,
// other trackers). No network fetch: validation is purely lexical. The strict
// shape also makes the STORED value safe to display verbatim (no token-bearing
// query string, no newline) — see the renderer.
const GITHUB_ISSUE_URL =
  /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+\/issues\/[1-9][0-9]*$/;
const MAX_URL_LEN = 2048;

/**
 * Return the URL unchanged if it is a canonical GitHub issue URL, else `null`
 * (fail-closed — the caller maps null to a CLI error). Anchored + length-bounded
 * so it cannot accept control chars, query strings, or fragments.
 */
export function parseIssueUrl(value: string): string | null {
  if (value.length > MAX_URL_LEN) return null;
  return GITHUB_ISSUE_URL.test(value) ? value : null;
}
