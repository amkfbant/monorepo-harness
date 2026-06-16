import { createHash } from "node:crypto";

/**
 * #230 Task C4 / PR3 — deterministic deliberation id (Layer 2, pure).
 *
 * `computeDeliberationId` binds a single deliberation run to the (hitch,
 * finding, gate-input) triple it produced. The id is the source of truth that
 * links the persisted proposal / refutation / severity-audit rows to the
 * decision packet (design §0.1 R4): the doctor (A3) joins those tables on it.
 *
 * It is a PURE function: same triple -> byte-identical id, no IO, no state.
 * `gateInputSha256` is the sha256 of the canonical JSON of the FINAL-ROUND
 * proposals + the refuter verdict (stable key ordering — see
 * `gateInputSha256()`), so a retry that changes the gate input (e.g. a flipped
 * refuter verdict) yields a DIFFERENT id and is persisted as a distinct
 * deliberation row (R15 business-key dedup includes `deliberation_id`).
 */

/** A single, deterministic field separator that never appears in a sha256 hex. */
const SEP = "|";

/**
 * Compute the deterministic deliberation id for one deliberation run.
 *
 * id = sha256(`${hitchId}|${findingId}|${gateInputSha256}`) as lowercase hex.
 * The pipe separator is unambiguous because `gateInputSha256` is itself a hex
 * digest (no pipes), and `hitchId`/`findingId` are harness-issued ids; the
 * concatenation is therefore injective for the inputs this function receives.
 */
export function computeDeliberationId(
  hitchId: string,
  findingId: string,
  gateInputSha256: string,
): string {
  return createHash("sha256")
    .update([hitchId, findingId, gateInputSha256].join(SEP), "utf8")
    .digest("hex");
}

/**
 * Recursively serialize a value to canonical JSON with stable (sorted) object
 * key ordering, so two structurally-equal gate inputs always hash identically
 * regardless of property insertion order. Arrays preserve order (order is
 * semantically meaningful for the final-round proposals).
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => canonicalize(v));
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      // Drop `undefined` so an omitted optional and an explicit `undefined`
      // hash identically (JSON.stringify already drops undefined, but doing it
      // here keeps the canonical form independent of stringify quirks).
      if (obj[key] !== undefined) out[key] = canonicalize(obj[key]);
    }
    return out;
  }
  return value;
}

/**
 * Deterministic sha256 (lowercase hex) of the canonical JSON of an arbitrary
 * gate-input payload. The caller passes the final-round proposals + refuter
 * verdict; canonical key ordering makes the digest independent of property
 * insertion order.
 */
export function gateInputSha256(payload: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(payload)), "utf8")
    .digest("hex");
}
