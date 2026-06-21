// Claude stream-json redaction (#191 Phase-C / F15 finding S4).
//
// WHY a separate redactor: redactCodexEvents (src/codex/redact-events.ts) gates
// on `parsed.item` and scans codex field names (aggregated_output / command /
// text), so it passes EVERY claude event through un-redacted — a claude Bash
// tool_result that echoes a secret would otherwise land verbatim in the events
// artifact (DB / review surface). claude carries secrets in a different shape:
//   assistant → message.content[] : {type:'tool_use', input:{command,...}} / {type:'text', text}
//   user      → message.content[] : {type:'tool_result', content: string | [{type:'text',text}]}
//   result    → .result (final agent message)
//
// The secret DETECTION (scanForSecrets) is the SAME engine the codex redactor
// uses, so detection cannot drift between providers; only the shape walk differs.
// This is an artifact-hygiene layer, NOT a state gate — but it MUST ship with
// any path that persists claude events.
import { scanForSecrets, SCAN_SAMPLE_BYTES } from "../reporter/secret-scan.js";

export interface RedactedClaudeEvents {
  content: string;
  redactedCount: number;
  droppedCount: number;
}

type JsonObject = { readonly [key: string]: unknown };

const SECRET_SCAN_CHUNK_OVERLAP_BYTES = 1024;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scanChunked(
  filename: string,
  content: string,
): { matched: boolean; reasons: readonly string[] } {
  const step = SCAN_SAMPLE_BYTES - SECRET_SCAN_CHUNK_OVERLAP_BYTES;
  const reasons = new Set<string>();
  for (let start = 0; start < content.length; start += step) {
    const chunk = content.slice(start, start + SCAN_SAMPLE_BYTES);
    for (const reason of scanForSecrets(filename, chunk).reasons) {
      reasons.add(reason);
    }
  }
  return { matched: reasons.size > 0, reasons: [...reasons] };
}

function redactString(
  filename: string,
  value: string,
): { value: string; redacted: boolean } {
  const scan = scanChunked(filename, value);
  if (!scan.matched) return { value, redacted: false };
  return {
    value: `[redacted: secret-suspect (${scan.reasons.join(", ")})]`,
    redacted: true,
  };
}

/** Redact a tool_result `content`: a plain string or an array of {type:'text',text}. */
function redactToolResultContent(content: unknown): {
  value: unknown;
  redacted: boolean;
} {
  if (typeof content === "string") {
    const r = redactString("tool_result.txt", content);
    return { value: r.value, redacted: r.redacted };
  }
  if (Array.isArray(content)) {
    let redacted = false;
    const value = content.map((part) => {
      if (isJsonObject(part) && typeof part.text === "string") {
        const r = redactString("tool_result.txt", part.text);
        if (r.redacted) {
          redacted = true;
          return { ...part, text: r.value };
        }
      }
      return part;
    });
    return { value, redacted };
  }
  return { value: content, redacted: false };
}

/** Redact every top-level string value of a tool_use `input` (command, etc.). */
function redactToolUseInput(input: unknown): {
  value: unknown;
  redacted: boolean;
} {
  if (!isJsonObject(input)) return { value: input, redacted: false };
  let redacted = false;
  const out: Record<string, unknown> = { ...input };
  for (const [key, val] of Object.entries(input)) {
    if (typeof val !== "string") continue;
    const r = redactString(`input.${key}.txt`, val);
    if (r.redacted) {
      out[key] = r.value;
      redacted = true;
    }
  }
  return { value: out, redacted };
}

/** Redact an assistant/user `message.content[]` array in place (immutably). */
function redactContentArray(content: unknown): {
  value: unknown;
  redacted: boolean;
} {
  if (!Array.isArray(content)) return { value: content, redacted: false };
  let redacted = false;
  const value = content.map((item) => {
    if (!isJsonObject(item)) return item;
    if (item.type === "text" && typeof item.text === "string") {
      const r = redactString("text.txt", item.text);
      if (r.redacted) {
        redacted = true;
        return { ...item, text: r.value };
      }
    }
    if (item.type === "tool_use") {
      const r = redactToolUseInput(item.input);
      if (r.redacted) {
        redacted = true;
        return { ...item, input: r.value };
      }
    }
    if (item.type === "tool_result") {
      const r = redactToolResultContent(item.content);
      if (r.redacted) {
        redacted = true;
        return { ...item, content: r.value };
      }
    }
    return item;
  });
  return { value, redacted };
}

function redactClaudeEventLine(line: string): {
  line: string;
  redacted: boolean;
  dropped: boolean;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    // Fail-closed: an unparseable line is replaced, never emitted raw.
    return {
      line: JSON.stringify({ type: "redaction.dropped_line" }),
      redacted: false,
      dropped: true,
    };
  }
  if (!isJsonObject(parsed)) return { line, redacted: false, dropped: false };

  // Final agent message.
  if (parsed.type === "result" && typeof parsed.result === "string") {
    const r = redactString("result.txt", parsed.result);
    if (r.redacted) {
      return {
        line: JSON.stringify({ ...parsed, result: r.value }),
        redacted: true,
        dropped: false,
      };
    }
    return { line, redacted: false, dropped: false };
  }

  // assistant tool_use / text + user tool_result live under message.content[].
  if (parsed.type === "assistant" || parsed.type === "user") {
    const msg = parsed.message;
    if (isJsonObject(msg) && Array.isArray(msg.content)) {
      const r = redactContentArray(msg.content);
      if (r.redacted) {
        const redactedEvent = {
          ...parsed,
          message: { ...msg, content: r.value },
        };
        return {
          line: JSON.stringify(redactedEvent),
          redacted: true,
          dropped: false,
        };
      }
    }
  }

  return { line, redacted: false, dropped: false };
}

/**
 * Redact secrets from a `claude -p --output-format stream-json` events stream.
 * Mirror of redactCodexEvents: preserves the trailing newline, drops
 * unparseable lines fail-closed, total function on "".
 */
export function redactClaudeEvents(content: string): RedactedClaudeEvents {
  if (content === "") return { content, redactedCount: 0, droppedCount: 0 };
  const hasTrailingNewline = content.endsWith("\n");
  const body = hasTrailingNewline ? content.slice(0, -1) : content;
  const lines = body === "" ? [] : body.split("\n");
  let redactedCount = 0;
  let droppedCount = 0;
  const redactedLines = lines.map((line) => {
    const result = redactClaudeEventLine(line);
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
