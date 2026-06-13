// Lightweight secret-shape heuristic for untracked-file artifacts.
//
// Goal: when codex drops a new file inside an allowed scope (e.g.
// `apps/user/.env.local`), refuse to inline its content into review
// artifacts — even though path policy says the file is fine. Reviewers
// still see path + size + sha256, just not the bytes.
//
// Intentionally narrow patterns: high-signal, low-false-positive. We
// accept that we will not catch every secret in the world — the bar is
// "would a casual leak survive review", not "tamper-proof DLP".

interface NamedPattern {
  re: RegExp;
  name: string;
}

const FILENAME_PATTERNS: NamedPattern[] = [
  // .env, .env.local, .env.production
  { re: /^\.env(\.|$)/i, name: ".env" },
  // foo.env
  { re: /\.env$/i, name: "*.env" },
  // foo.env.local
  { re: /\.env\./i, name: "*.env.*" },
  { re: /secret/i, name: "secret" },
  { re: /token/i, name: "token" },
  { re: /credentials?/i, name: "credential" },
  { re: /password/i, name: "password" },
  // common SSH private key filenames
  { re: /^id_(?:rsa|dsa|ecdsa|ed25519)$/i, name: "ssh-private-key" },
  // cert/key extensions
  { re: /\.(?:pem|key|pfx|p12)$/i, name: "key-extension" },
];

const CONTENT_PATTERNS: NamedPattern[] = [
  // PEM private key headers (RSA, EC, OPENSSH, ENCRYPTED, generic)
  { re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/, name: "pem-private-key" },
  // AWS access key id
  { re: /\bAKIA[0-9A-Z]{16}\b/, name: "aws-access-key-id" },
  // GitHub tokens (classic + fine-grained PAT)
  {
    re: /\b(?:gh[psour]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})\b/,
    name: "github-token",
  },
  // OpenAI (classic and project keys)
  { re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/, name: "openai-key" },
  // Stripe live/test secret keys
  { re: /\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/, name: "stripe-key" },
];

export interface SecretScanResult {
  matched: boolean;
  reasons: string[];
}

/**
 * Scan a single file for secret-shaped content.
 *
 * @param basename  the basename (NOT the full path) — filename heuristics
 *                  only look at this
 * @param sample    a UTF-8 sample of the file head (e.g. first 32KB) for
 *                  content heuristics, or null when content scanning is
 *                  not possible (binary, oversized, symlink, etc.)
 */
export function scanForSecrets(
  basename: string,
  sample: string | null,
): SecretScanResult {
  const reasons: string[] = [];
  for (const { re, name } of FILENAME_PATTERNS) {
    if (re.test(basename)) reasons.push(`filename:${name}`);
  }
  if (sample !== null) {
    for (const { re, name } of CONTENT_PATTERNS) {
      if (re.test(sample)) reasons.push(`content:${name}`);
    }
  }
  return { matched: reasons.length > 0, reasons };
}

export const SCAN_SAMPLE_BYTES = 32 * 1024;
export const COMMAND_LOG_LINE_WITHHELD =
  "[redacted: secret-shaped line withheld]";

// A conservative assignment / key-name heuristic for free text that will be
// injected into an LLM prompt (close-check command output, command strings,
// messages). Unlike the fixed-prefix CONTENT_PATTERNS above — which only catch
// vendor-shaped tokens (AKIA…, ghp_…, sk-…) — this also catches NAME-BASED
// assignments (`AWS_SECRET_ACCESS_KEY=…`, `api_key: …`, `password=…`,
// `Authorization: Bearer …`). Mirrors `SECRET_ASSIGNMENT_RE` in
// `src/mcp/audit/redaction.ts`, broadened for prompt-injection use:
//   - `aws_secret…` / generic `*_secret` style names,
//   - any `*_key` / `*-key` name (api_key, secret_key, access_key, …),
//   - bearer tokens (`bearer <token>`).
// For prompt injection, leak-prevention beats false-positives: a withheld
// non-secret line costs the coder some context; a leaked key is unrecoverable.
// A secret-ish NAME (optionally prefixed/suffixed by underscore-joined words,
// e.g. AWS_SECRET_ACCESS_KEY, app.api_key) immediately followed by `:` or `=`.
// `[a-z0-9_-]*` lets prefixes/suffixes joined by `_`/`-` ride along without a
// word boundary (so `AWS_SECRET` and `ACCESS_KEY` both register).
const SECRET_ASSIGNMENT_RE =
  /(?:^|[^a-z0-9_-])[a-z0-9_-]*(?:secret|token|password|passwd|credential|api[_-]?key|access[_-]?key|private[_-]?key|idempotency)[a-z0-9_-]*\s*[:=]/i;
const GENERIC_KEY_ASSIGNMENT_RE =
  /(?:^|[^a-z0-9_-])[a-z0-9]+[_-]key\s*[:=]/i;
const BEARER_TOKEN_RE = /\bbearer\s+[A-Za-z0-9._~+/=-]{12,}/i;

/**
 * Whole-text fail-closed gate for free text bound for an LLM prompt.
 *
 * Returns true when the text includes a prior command-log redaction marker,
 * matches a vendor-shaped token (`scanForSecrets`), OR matches a conservative
 * name-based assignment / bearer-token heuristic. Callers MUST withhold the
 * entire field/stream on a true result — never partial — so a tail-clip window
 * cannot sever a token and let the remainder evade detection.
 */
export function containsLikelySecret(text: string): boolean {
  if (text.includes(COMMAND_LOG_LINE_WITHHELD)) return true;
  if (scanForSecrets("", text).matched) return true;
  return (
    SECRET_ASSIGNMENT_RE.test(text) ||
    GENERIC_KEY_ASSIGNMENT_RE.test(text) ||
    BEARER_TOKEN_RE.test(text)
  );
}

export function redactSecretLines(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      containsLikelySecret(line) ? COMMAND_LOG_LINE_WITHHELD : line,
    )
    .join("\n");
}
