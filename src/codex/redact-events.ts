import {
  scanForSecrets,
  SCAN_SAMPLE_BYTES,
} from "../reporter/secret-scan.js";

export interface RedactedCodexEvents {
  content: string;
  redactedCount: number;
  droppedCount: number;
}

type JsonObject = { readonly [key: string]: unknown };

const SECRET_SCAN_CHUNK_OVERLAP_BYTES = 1024;
const CODEX_OUTPUT_STRING_FIELDS = [
  "aggregated_output",
  "text",
  "command",
  "command_name",
  "name",
] as const;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scanCodexOutputForSecrets(filename: string, content: string): {
  matched: boolean;
  reasons: readonly string[];
} {
  const step = SCAN_SAMPLE_BYTES - SECRET_SCAN_CHUNK_OVERLAP_BYTES;
  const reasons = new Set<string>();
  for (let start = 0; start < content.length; start += step) {
    const chunk = content.slice(start, start + SCAN_SAMPLE_BYTES);
    const scan = scanForSecrets(filename, chunk);
    for (const reason of scan.reasons) {
      reasons.add(reason);
    }
  }
  return { matched: reasons.size > 0, reasons: [...reasons] };
}

function redactionMarker(reasons: readonly string[]): string {
  return `[redacted: secret-suspect (${reasons.join(", ")})]`;
}

function redactEventLine(line: string): {
  line: string;
  redacted: boolean;
  dropped: boolean;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return {
      line: JSON.stringify({ type: "redaction.dropped_line" }),
      redacted: false,
      dropped: true,
    };
  }

  if (!isJsonObject(parsed) || !isJsonObject(parsed.item)) {
    return { line, redacted: false, dropped: false };
  }

  let redacted = false;
  let redactedItem = parsed.item;
  for (const field of CODEX_OUTPUT_STRING_FIELDS) {
    const value = redactedItem[field];
    if (typeof value !== "string") {
      continue;
    }
    const scan = scanCodexOutputForSecrets(`${field}.txt`, value);
    if (!scan.matched) {
      continue;
    }
    redactedItem = {
      ...redactedItem,
      [field]: redactionMarker(scan.reasons),
    };
    redacted = true;
  }

  if (!redacted) {
    return { line, redacted: false, dropped: false };
  }

  const redactedEvent = { ...parsed, item: redactedItem };
  return {
    line: JSON.stringify(redactedEvent),
    redacted: true,
    dropped: false,
  };
}

export function redactCodexEvents(content: string): RedactedCodexEvents {
  if (content === "") {
    return { content, redactedCount: 0, droppedCount: 0 };
  }

  const hasTrailingNewline = content.endsWith("\n");
  const body = hasTrailingNewline ? content.slice(0, -1) : content;
  const lines = body === "" ? [] : body.split("\n");
  let redactedCount = 0;
  let droppedCount = 0;
  const redactedLines = lines.map((line) => {
    const result = redactEventLine(line);
    if (result.redacted) redactedCount += 1;
    if (result.dropped) droppedCount += 1;
    return result.line;
  });
  return {
    content: redactedLines.join("\n").concat(hasTrailingNewline ? "\n" : ""),
    redactedCount,
    droppedCount,
  };
}
