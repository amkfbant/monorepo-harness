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
  // Slack tokens (bot/user/legacy: xoxb-/xoxa-/xoxp-/xoxr-/xoxs-)
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, name: "slack-token" },
  // Slack app-level token
  { re: /\bxapp-[A-Za-z0-9-]{10,}/, name: "slack-app-token" },
  // GitLab personal access token
  { re: /\bglpat-[A-Za-z0-9_-]{20,}\b/, name: "gitlab-pat" },
  // Google API key (AIza + 35 chars)
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/, name: "google-api-key" },
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
// HTTP Basic auth. Anchored on the `authorization:` header so common prose
// ("basic understanding…") never trips it — only an actual credential header.
const BASIC_AUTH_RE = /\bauthorization\s*:\s*basic\s+[A-Za-z0-9+/]{8,}={0,2}/i;

/**
 * Whole-text fail-closed gate for free text bound for an LLM prompt.
 *
 * Returns true when the text either matches a vendor-shaped token
 * (`scanForSecrets`) OR a conservative name-based assignment / bearer-token
 * heuristic. Callers MUST withhold the entire field/stream on a true result —
 * never partial — so a tail-clip window cannot sever a token and let the
 * remainder evade detection.
 */
export function containsLikelySecret(text: string): boolean {
  // A line that already carries a redaction marker stays withheld when a
  // redacted log is later re-scanned (e.g. close-check log excerpts).
  if (text.includes(COMMAND_LOG_LINE_WITHHELD)) return true;
  if (scanForSecrets("", text).matched) return true;
  return (
    SECRET_ASSIGNMENT_RE.test(text) ||
    GENERIC_KEY_ASSIGNMENT_RE.test(text) ||
    BEARER_TOKEN_RE.test(text) ||
    BASIC_AUTH_RE.test(text)
  );
}

// ---------------------------------------------------------------------------
// On-disk command-log redaction (#186)
//
// `runAllowedCommands` writes command stdout/stderr to `runs/<id>/.../*.log`.
// Raw bytes can carry secrets, so the write layer redacts secret-shaped LINES
// to this marker. A redacted line withholds the WHOLE line (never partial), so a
// chunk/line boundary cannot sever a token and leak the remainder.
// ---------------------------------------------------------------------------

export const COMMAND_LOG_LINE_WITHHELD =
  "[redacted: secret-shaped line withheld]";

// Per-line memory bound for the streaming redactor: a line longer than this
// (e.g. a newline-less multi-MB blob) is withheld wholesale rather than buffered,
// so a misbehaving command cannot OOM the harness or sever a token at a flush
// boundary. Compared against UTF-16 length (≈ bytes for log text).
export const COMMAND_LOG_MAX_LINE_CHARS = 1 << 20; // 1 MiB

// PEM private-key blocks span many lines; only the BEGIN line matches a token
// pattern, so a line-at-a-time scan would leak the base64 body. Track the block
// (BEGIN..END) and withhold every line inside it.
const PEM_MARKER_RE = /-----(?:BEGIN|END) (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/;

// The net open/closed state after applying every PEM marker in `text` in order
// (last marker wins): a trailing BEGIN opens the block, a trailing END closes it,
// no marker leaves `prev` unchanged. A fresh regex per call avoids shared
// lastIndex state.
function pemNetState(prev: boolean, text: string): boolean {
  const re = /-----(BEGIN|END) (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g;
  let state = prev;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) state = m[1] === "BEGIN";
  return state;
}

/**
 * A stateful, single-stream line redactor. Call `redactLine` on each line (no
 * trailing newline) IN ORDER: it withholds secret-shaped lines and, statefully,
 * every line of an open PEM private-key block until its END marker. For an
 * over-long line whose bytes are discarded rather than buffered, call
 * `observeDiscardedFragment` on each discarded fragment so the PEM block state
 * still advances (a BEGIN hidden in a multi-MB line must still open the block,
 * else the following body lines would leak).
 */
export function createSecretLineRedactor(): {
  redactLine(line: string): string;
  observeDiscardedFragment(fragment: string): void;
} {
  let inPemBlock = false;
  return {
    redactLine(line: string): string {
      const wasInBlock = inPemBlock;
      const hasMarker = PEM_MARKER_RE.test(line);
      if (hasMarker) inPemBlock = pemNetState(inPemBlock, line);
      if (wasInBlock || hasMarker || containsLikelySecret(line)) {
        return COMMAND_LOG_LINE_WITHHELD;
      }
      return line;
    },
    observeDiscardedFragment(fragment: string): void {
      inPemBlock = pemNetState(inPemBlock, fragment);
    },
  };
}

/**
 * Single-shot redaction of a complete text blob (handles multi-line PEM blocks
 * within it). A trailing newline is preserved (its final empty segment is left
 * as-is). For streaming use `createSecretLineRedactor` via the command-runner
 * transform, which also bounds per-line memory.
 */
export function redactSecretLines(text: string): string {
  const r = createSecretLineRedactor();
  const lines = text.split("\n");
  const lastIdx = lines.length - 1;
  return lines
    .map((line, i) =>
      i === lastIdx && line === "" ? line : r.redactLine(line),
    )
    .join("\n");
}
