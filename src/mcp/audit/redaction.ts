import { scanForSecrets } from "../../reporter/secret-scan.js";

const SECRET_KEY_RE =
  /secret|token|password|credential|api[_-]?key|idempotency/i;
const SECRET_ASSIGNMENT_RE =
  /\b(secret|token|password|credential|api[_-]?key|idempotency)\s*[:=]/i;

// actorNote is an intentional operator audit annotation. Keep it readable and
// apply only the key/shape-based secret scrub below; full-note redaction would
// destroy its audit value.
export function redactMcpAuditValue(value: unknown, key?: string): unknown {
  if (key !== undefined && SECRET_KEY_RE.test(key)) return "[redacted]";
  if (typeof value === "string") {
    return SECRET_ASSIGNMENT_RE.test(value) || scanForSecrets("", value).matched
      ? "[redacted]"
      : value;
  }
  if (Array.isArray(value)) return value.map((item) => redactMcpAuditValue(item));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      redactMcpAuditValue(v, k),
    ]),
  );
}

export function redactMcpJsonText(text: string): string {
  try {
    return JSON.stringify(redactMcpAuditValue(JSON.parse(text) as unknown));
  } catch {
    return JSON.stringify(redactMcpAuditValue(text));
  }
}

export function redactMcpText(text: string): string {
  const redacted = redactMcpAuditValue(text);
  return typeof redacted === "string" ? redacted : JSON.stringify(redacted);
}
