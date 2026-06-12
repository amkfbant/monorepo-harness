import { createHash } from "node:crypto";

// The OperationRunner replay key is (operation_type, target_id, idempotency_key)
// with NO project/client dimension. Hashing the idempotencyKey alone would let two
// clients in different projects (or under different courses) that reuse the same
// idempotencyKey collide on target_id -> the second create is treated as a replay
// of the first and returns the OTHER resource (cross-project leak). We therefore
// fold the resource scope into the hashed material: a course/hitch is scoped by
// its project, a phase by its parent course.
//
// The material is a JSON-encoded [scope, key] tuple, NOT a string-joined pair, so
// the framing is unambiguous regardless of what bytes scope/key contain: JSON
// quoting makes [scope, key] impossible to confuse with any other (scope', key')
// (no separator-injection), and a null scope (cross-project roadmap or
// null-project hitch) is distinct from an empty-string scope ([null,...] vs
// ["",...]).
export function scopedIdForIdempotencyKey(
  prefix: string,
  scope: string | null,
  idempotencyKey: string,
): string {
  const material = JSON.stringify([scope, idempotencyKey]);
  const digest = createHash("sha256").update(material).digest("hex");
  return `${prefix}-${digest.slice(0, 32)}`;
}
