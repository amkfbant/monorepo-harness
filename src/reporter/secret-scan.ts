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
