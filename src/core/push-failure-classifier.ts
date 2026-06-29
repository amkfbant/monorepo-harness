// (#396 part 2) Deterministic transient-vs-permanent classification of a failed
// `git push` (close PR push). The verdict drives whether a close-ready hitch
// bound-retries (transient) or terminal-escalates (permanent). It is a strict
// allowlist with a FAIL-CLOSED `"permanent"` default: any unknown/ambiguous/empty
// text escalates rather than silently looping a retry.
//
// Two adversarial-hardening rules (see docs/specs/hitch-convergence.md):
//   1. PERMANENT is matched against the FULL body and wins — a server-side
//      refusal (`remote: ...`, `! [remote rejected]`, hook decline, protected
//      branch, cert failure) must escalate even if a transient phrase appears
//      elsewhere.
//   2. TRANSIENT is matched ONLY against git's own CLIENT lines (every
//      `remote:`-prefixed line is stripped first), so a server-controlled hook
//      body or side-band counter (e.g. `remote: Resolving deltas: (503/503)`)
//      cannot fabricate a transient signal. HTTP status matches are anchored to
//      `http`/`returned error:`/named-status phrases, never a bare `503`.

export type PushFailureClass = "transient" | "permanent";

// Matched against the FULL body, checked FIRST (permanent dominates). Cert
// validation is permanent and listed here so a handshake phrase can never read
// as transient.
const PERMANENT_SIGNATURES: readonly string[] = [
  // server refusals / policy
  "! [remote rejected]",
  "pre-receive hook declined",
  "protected branch",
  "gh006",
  "push declined due to repository rule",
  "permission denied",
  "authentication failed",
  "could not read username",
  "403 forbidden",
  "repository not found",
  "does not appear to be a git repository",
  "no such remote",
  // stale local ref — needs rebase/human, not a blind re-push
  "non-fast-forward",
  "fetch first",
  "! [rejected]",
  "stale info",
  // NB: `could not read from remote repository` is deliberately NOT permanent —
  // git appends that generic trailer after BOTH permanent (auth/repo-not-found,
  // matched above) AND transient (ssh connectivity, matched below) failures, so
  // an unconditional permanent here would override a real transient. The specific
  // cause wins; a trailer with no other signal falls through to the permanent
  // default anyway.
  // certificate validation (checked before any handshake-looking transient)
  "ssl certificate problem",
  "certificate verify failed",
  "certificate verification failed",
  "server certificate verification failed",
  "unable to get local issuer certificate",
  "self-signed certificate",
  "self signed certificate",
  "certificate has expired",
];

// Matched against CLIENT lines only (server `remote:` lines stripped). HTTP
// codes are anchored, never bare numbers.
const TRANSIENT_SIGNATURES: readonly string[] = [
  // connectivity
  "could not resolve host",
  "connection timed out",
  "timed out",
  "connection reset",
  "failed to connect",
  "couldn't connect to server",
  "the remote end hung up",
  "rpc failed",
  "early eof",
  "unexpected disconnect",
  // handshake hiccups (NOT cert validation — those are permanent above)
  "gnutls_handshake() failed",
  "kex_exchange_identification",
  "decryption failed or bad record mac",
  // HTTP 5xx / rate-limit, anchored (500 included — a git host 500 is a
  // retryable server-side error, same as 502/503/504)
  "http 500",
  "http 502",
  "http 503",
  "http 504",
  "http/1.1 500",
  "http/1.1 502",
  "http/1.1 503",
  "http/1.1 504",
  "500 internal server error",
  "502 bad gateway",
  "503 service unavailable",
  "504 gateway",
  "429 too many requests",
  "rate limit",
  "returned error: 500",
  "returned error: 502",
  "returned error: 503",
  "returned error: 504",
  "returned error: 429",
  // ref-lock contention (retry-safe)
  "cannot lock ref",
  "unable to update local ref",
  "failed to lock",
  "index.lock",
];

/**
 * Classify a `git push` failure body (`${stderr}\n${stdout}`). Exit code is NOT a
 * discriminator (git uses 1/128 for almost everything). Fail-closed: anything not
 * matched as a known transient on a client line is `"permanent"` (escalate).
 */
export function classifyPushFailure(text: string): PushFailureClass {
  const full = text.toLowerCase();
  // PERMANENT wins, against the full body (server refusals must escalate).
  if (PERMANENT_SIGNATURES.some((s) => full.includes(s))) return "permanent";
  // TRANSIENT only against git's own client lines.
  const clientText = full
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("remote:"))
    .join("\n");
  if (TRANSIENT_SIGNATURES.some((s) => clientText.includes(s))) return "transient";
  return "permanent"; // fail-closed default: unknown / ambiguous / empty → escalate
}
