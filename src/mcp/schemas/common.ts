import { z } from "zod";

export type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: unknown[];
  description?: string;
  additionalProperties?: boolean | JsonSchema;
  oneOf?: JsonSchema[];
};

export const emptyInputSchema: JsonSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

export const stringArraySchema: JsonSchema = {
  type: "array",
  items: { type: "string" },
};

export function objectSchema(
  properties: Record<string, JsonSchema>,
  required: string[] = [],
): JsonSchema {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

export function enumSchema(values: readonly string[]): JsonSchema {
  return { type: "string", enum: [...values] };
}

export const CursorSchema = z.string().min(1).nullable().optional();
export const LimitSchema = z.number().int().min(1).max(100).optional();

export const MutationArgsBaseSchema = z.object({
  idempotencyKey: z.string().min(1),
  actorNote: z.string().optional(),
});

export function parseToolArgs<T>(
  schema: z.ZodType<T>,
  raw: unknown,
): { ok: true; data: T } | { ok: false; message: string } {
  const parsed = schema.safeParse(raw ?? {});
  if (parsed.success) return { ok: true, data: parsed.data };
  return {
    ok: false,
    message: parsed.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; "),
  };
}
