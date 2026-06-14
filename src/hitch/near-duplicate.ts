export interface NearDuplicateCandidate {
  findingId: string;
  hitchId: string;
  category: string;
  summary: string;
  filePath?: string | null;
  symbol?: string | null;
  scopeStatus: string;
}

export interface FindNearDuplicateInput {
  hitchId: string;
  category: string;
  summary: string;
  filePath?: string | null;
  symbol?: string | null;
  scopeStatus: string;
  candidates: readonly NearDuplicateCandidate[];
}

const DIGIT_PLACEHOLDER = "num";
const MIN_FUZZY_TOKENS = 5;
const TOKEN_JACCARD_THRESHOLD = 0.6;
const BIGRAM_JACCARD_THRESHOLD = 0.5;
const PATHLESS_TOKEN_JACCARD_THRESHOLD = 0.75;
const PATHLESS_BIGRAM_JACCARD_THRESHOLD = 0.6;
const LINE_REFERENCE_PREFIX = "(^|[\\s([`\"'])";
const PATH_LINE_REFERENCE_RE = new RegExp(
  LINE_REFERENCE_PREFIX +
    String.raw`([a-z0-9_.-]+(?:/[a-z0-9_.-]+)*\.(?:[cm]?[jt]sx?|mjs|cjs|py|rb|go|rs|java|kt|kts|c|cc|cpp|h|hpp|cs|php|swift|scala|sh|bash|zsh|fish|sql|mdx?|json|ya?ml|toml|ini|txt|css|s[ac]ss|less|html|vue|svelte)):\d+(?::\d+)?\b`,
  "g",
);
const FILE_LINE_REFERENCE_RE = new RegExp(
  LINE_REFERENCE_PREFIX +
    String.raw`([a-z0-9_.-]+\.(?:[cm]?[jt]sx?|mjs|cjs|py|rb|go|rs|java|kt|kts|c|cc|cpp|h|hpp|cs|php|swift|scala|sh|bash|zsh|fish|sql|mdx?|json|ya?ml|toml|ini|txt|css|s[ac]ss|less|html|vue|svelte)):\d+(?::\d+)?\b`,
  "g",
);

interface SummaryTokens {
  exactKey: string;
  wordTokens: string[];
  tokenSet: Set<string>;
  bigramSet: Set<string>;
  meaningfulNumbers: string[];
  distinctiveTokens: Set<string>;
}

export function findNearDuplicate(
  input: FindNearDuplicateInput,
): NearDuplicateCandidate | null {
  const incomingCategory = normalizeCategory(input.category);
  const incomingFilePath = normalizeFilePath(input.filePath);
  const incomingSymbol = normalizeSymbol(input.symbol);
  const incoming = tokenizeSummary(input.summary);
  let best: { candidate: NearDuplicateCandidate; score: number } | null = null;

  for (const candidate of input.candidates) {
    if (candidate.hitchId !== input.hitchId) continue;
    if (normalizeCategory(candidate.category) !== incomingCategory) continue;
    if (!filePathsCompatible(incomingFilePath, normalizeFilePath(candidate.filePath))) {
      continue;
    }
    if (!symbolsCompatible(incomingSymbol, normalizeSymbol(candidate.symbol))) {
      continue;
    }

    const existing = tokenizeSummary(candidate.summary);
    if (!sameMeaningfulNumbers(incoming.meaningfulNumbers, existing.meaningfulNumbers)) {
      continue;
    }
    const isPathless = pathless(incomingFilePath, incomingSymbol);
    if (
      isPathless &&
      !compatibleDistinctiveTokens(
        incoming.distinctiveTokens,
        existing.distinctiveTokens,
      )
    ) {
      continue;
    }
    if (
      incoming.wordTokens.length < MIN_FUZZY_TOKENS ||
      existing.wordTokens.length < MIN_FUZZY_TOKENS
    ) {
      if (incoming.exactKey !== existing.exactKey) continue;
      return candidate;
    }

    const tokenJaccard = jaccard(incoming.tokenSet, existing.tokenSet);
    const bigramJaccard = jaccard(incoming.bigramSet, existing.bigramSet);
    const thresholds = isPathless
      ? {
          token: PATHLESS_TOKEN_JACCARD_THRESHOLD,
          bigram: PATHLESS_BIGRAM_JACCARD_THRESHOLD,
        }
      : { token: TOKEN_JACCARD_THRESHOLD, bigram: BIGRAM_JACCARD_THRESHOLD };
    // Pathless reviewer findings lack file/symbol anchors, so they need a
    // tighter text match to avoid merging separate close blockers.
    if (tokenJaccard < thresholds.token || bigramJaccard < thresholds.bigram) {
      continue;
    }
    const score = tokenJaccard + bigramJaccard;
    if (best === null || score > best.score) {
      best = { candidate, score };
    }
  }

  return best?.candidate ?? null;
}

function tokenizeSummary(summary: string): SummaryTokens {
  const quotedTokens = quotedSummaryTokens(summary);
  const wordTokens = normalizeWords(summary);
  const tokenSet = new Set([...wordTokens, ...quotedTokens]);
  return {
    exactKey: [...wordTokens, ...quotedTokens.sort()].join(" "),
    wordTokens,
    tokenSet,
    bigramSet: bigrams(wordTokens),
    meaningfulNumbers: meaningfulNumberTokens(summary),
    distinctiveTokens: distinctiveSummaryTokens(summary),
  };
}

function quotedSummaryTokens(
  summary: string,
  options: { replaceDigits?: boolean } = {},
): string[] {
  const tokens: string[] = [];
  const pattern = /`([^`]+)`|"([^"]+)"|'([^']+)'/g;
  for (const match of summary.matchAll(pattern)) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    const normalized = normalizeQuoted(value, options);
    if (normalized !== "") tokens.push(`quoted:${normalized}`);
  }
  return tokens;
}

function normalizeWords(
  value: string,
  options: { replaceDigits?: boolean } = {},
): string[] {
  let normalized = value
    .toLowerCase()
    .replace(/\\/g, "/");
  if (options.replaceDigits !== false) {
    // Only line-reference churn is normalized. Other numbers often identify
    // distinct defects (HTTP 404 vs 500, timeout 30s vs 5s), so preserving them
    // keeps near-duplicate fallback fail-closed.
    normalized = replaceLineReferenceNumbers(normalized, DIGIT_PLACEHOLDER);
  }
  return normalized
    .replace(/[^a-z0-9_]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

function meaningfulNumberTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/\\/g, "/")
    .replace(/\b(lines?|l)\s*:?\s*#?\s*\d+\b/g, "$1")
    .replace(PATH_LINE_REFERENCE_RE, "$1$2")
    .replace(FILE_LINE_REFERENCE_RE, "$1$2")
    .match(/\d+/g) ?? [];
}

function distinctiveSummaryTokens(value: string): Set<string> {
  const tokens = new Set<string>();
  const normalized = replaceLineReferenceNumbers(
    value.toLowerCase().replace(/\\/g, "/"),
    DIGIT_PLACEHOLDER,
  );
  for (const match of normalized.matchAll(
    /\b(?:get|post|put|patch|delete)\s+(\/[a-z0-9_./:-]+)/g,
  )) {
    tokens.add(`path:${match[1]}`);
  }
  for (const match of normalized.matchAll(/\/[a-z0-9_./:-]+/g)) {
    tokens.add(`path:${match[0]}`);
  }
  for (const token of quotedSummaryTokens(value)) {
    tokens.add(token);
  }
  for (const match of normalized.matchAll(/\b[a-z][a-z0-9]*(?:[_-][a-z0-9]+)+\b/g)) {
    tokens.add(`id:${match[0]}`);
  }
  return tokens;
}

function compatibleDistinctiveTokens(
  incoming: Set<string>,
  existing: Set<string>,
): boolean {
  if (incoming.size === 0 || existing.size === 0) return true;
  for (const token of incoming) {
    if (existing.has(token)) return true;
  }
  return false;
}

function normalizeQuoted(
  value: string,
  options: { replaceDigits?: boolean } = {},
): string {
  let normalized = value
    .toLowerCase()
    .replace(/\\/g, "/");
  if (options.replaceDigits !== false) {
    normalized = replaceLineReferenceNumbers(normalized, DIGIT_PLACEHOLDER);
  }
  return normalized
    .trim()
    .replace(/\s+/g, " ");
}

function replaceLineReferenceNumbers(value: string, replacement: string): string {
  return value
    .replace(/\b(lines?|l)\s*:?\s*#?\s*\d+\b/g, `$1 ${replacement}`)
    .replace(PATH_LINE_REFERENCE_RE, `$1$2:${replacement}`)
    .replace(FILE_LINE_REFERENCE_RE, `$1$2:${replacement}`);
}

function normalizeCategory(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeFilePath(value: string | null | undefined): string | null {
  const normalized = (value ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .trim()
    .toLowerCase();
  return normalized === "" ? null : normalized;
}

function normalizeSymbol(value: string | null | undefined): string | null {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  return normalized === "" ? null : normalized;
}

function filePathsCompatible(
  incoming: string | null,
  existing: string | null,
): boolean {
  if (incoming === null || existing === null) return incoming === existing;
  return incoming === existing;
}

function symbolsCompatible(
  incoming: string | null,
  existing: string | null,
): boolean {
  if (incoming === null || existing === null) return incoming === existing;
  return incoming === existing;
}

function pathless(filePath: string | null, symbol: string | null): boolean {
  return filePath === null && symbol === null;
}

function bigrams(tokens: readonly string[]): Set<string> {
  const result = new Set<string>();
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const current = tokens[i];
    const next = tokens[i + 1];
    if (current !== undefined && next !== undefined) {
      result.add(`${current} ${next}`);
    }
  }
  return result;
}

function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const item of left) {
    if (right.has(item)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function sameMeaningfulNumbers(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}
