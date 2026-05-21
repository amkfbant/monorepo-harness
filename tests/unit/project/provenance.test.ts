import { describe, it, expect } from "vitest";
import {
  serializeProvenance,
  parseProvenance,
  type PolicyProvenance,
} from "../../../src/project/provenance.js";

function sample(): PolicyProvenance {
  return {
    schemaVersion: 1,
    projectId: "demo",
    repoId: "demo",
    profilePath: "projects/demo.yaml",
    profileVersion: 1,
    policyTemplate: { id: "strict-monorepo-v1", version: 1 },
    commandPresets: [{ id: "node-basic-v1", version: 1 }],
    contextPackPresets: [],
    domainRegistry: null,
    generatedAt: "2026-05-22T00:00:00.000Z",
  };
}

describe("provenance", () => {
  it("E5-4-1: round-trips through serialize/parse", () => {
    const p = sample();
    const parsed = parseProvenance(serializeProvenance(p));
    expect(parsed).toEqual(p);
  });

  it("parseProvenance returns null for malformed JSON", () => {
    expect(parseProvenance("{not json")).toBeNull();
  });

  it("parseProvenance returns null for a wrong schema version", () => {
    expect(
      parseProvenance(JSON.stringify({ ...sample(), schemaVersion: 2 })),
    ).toBeNull();
  });

  it("parseProvenance returns null when required fields are missing", () => {
    expect(parseProvenance(JSON.stringify({ schemaVersion: 1 }))).toBeNull();
  });

  it("parseProvenance returns null for a malformed nested catalog ref", () => {
    const bad = { ...sample(), policyTemplate: { id: 123 } };
    expect(parseProvenance(JSON.stringify(bad))).toBeNull();
  });
});
