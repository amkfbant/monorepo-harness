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

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

  const aggregatedOutput = parsed.item.aggregated_output;
  if (typeof aggregatedOutput !== "string") {
    return { line, redacted: false, dropped: false };
  }

  const sample = aggregatedOutput.slice(0, SCAN_SAMPLE_BYTES);
  const scan = scanForSecrets("aggregated-output.txt", sample);
  if (!scan.matched) {
    return { line, redacted: false, dropped: false };
  }

  const redactedItem = {
    ...parsed.item,
    aggregated_output: `[redacted: secret-suspect (${scan.reasons.join(", ")})]`,
  };
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
