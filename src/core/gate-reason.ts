import { createHash } from "node:crypto";

export interface SanitizedGateReason {
  reasonCode: string;
  field?: string;
  valueType?: string;
  valueLength?: number;
  valueSha256?: string;
}

export function sanitizeGateReason(input: {
  code: string;
  field?: string;
  value?: unknown;
}): SanitizedGateReason {
  const hasValue = Object.hasOwn(input, "value");
  if (!hasValue) {
    return {
      reasonCode: input.code,
      ...(input.field !== undefined ? { field: input.field } : {}),
    };
  }

  const valueType = describeValueType(input.value);
  const valueFingerprint = fingerprintValue(input.value, valueType);
  return {
    reasonCode: input.code,
    ...(input.field !== undefined ? { field: input.field } : {}),
    valueType,
    ...valueFingerprint,
  };
}

function describeValueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function fingerprintValue(
  value: unknown,
  valueType: string,
): { valueLength?: number; valueSha256?: string } {
  const text = fingerprintText(value, valueType);
  return {
    valueLength: valueLength(value, text),
    valueSha256: createHash("sha256").update(text).digest("hex"),
  };
}

function fingerprintText(value: unknown, valueType: string): string {
  if (typeof value === "string") return value;
  if (
    value === null ||
    typeof value === "undefined" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "symbol" ||
    typeof value === "function"
  ) {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? valueType;
  } catch {
    return valueType;
  }
}

function valueLength(value: unknown, text: string): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.length;
  if (value !== null && typeof value === "object") {
    return Object.keys(value).length;
  }
  return text.length;
}
