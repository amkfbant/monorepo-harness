import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTO_MERGE_TIERS_CONFIG_PATH,
  loadAutoMergeSensitivityMap,
} from "../../../src/core/automerge-tiers-config.js";
import {
  DEFAULT_AUTO_MERGE_SENSITIVITY_MAP,
  computeAutoMergeTier,
} from "../../../src/core/automerge-tiers.js";

function harnessRootWith(config: string | null): string {
  const root = mkdtempSync(join(tmpdir(), "harness-amt-config-"));
  if (config !== null) {
    mkdirSync(join(root, "policies"), { recursive: true });
    writeFileSync(join(root, AUTO_MERGE_TIERS_CONFIG_PATH), config);
  }
  return root;
}

describe("loadAutoMergeSensitivityMap", () => {
  it("returns the built-in defaults when no config file exists", () => {
    const map = loadAutoMergeSensitivityMap(harnessRootWith(null));
    expect(map).toBe(DEFAULT_AUTO_MERGE_SENSITIVITY_MAP);
  });

  it("appends operator rules so a path can be TIGHTENED (raised tier)", () => {
    const root = harnessRootWith(
      ["version: 1", "rules:", "  - glob: docs/secret/**", "    tier: 2", ""].join(
        "\n",
      ),
    );
    const map = loadAutoMergeSensitivityMap(root);
    // a normal docs path stays Tier-0 (auto-eligible)…
    expect(computeAutoMergeTier(["docs/readme.md"], map)).toBe(0);
    // …but the operator-marked subpath is now Tier-2 (never auto).
    expect(computeAutoMergeTier(["docs/secret/keys.md"], map)).toBe(2);
  });

  it("cannot LOOSEN a default Tier-2 path (max tier wins, fail-closed)", () => {
    const root = harnessRootWith(
      ["version: 1", "rules:", "  - glob: src/policy/**", "    tier: 0", ""].join(
        "\n",
      ),
    );
    const map = loadAutoMergeSensitivityMap(root);
    // operator tried to drop src/policy to Tier-0; the default Tier-2 still wins.
    expect(computeAutoMergeTier(["src/policy/resolver.ts"], map)).toBe(2);
  });

  it("THROWS on a malformed config (fail-closed, no silent default)", () => {
    const root = harnessRootWith(
      ["version: 1", "rules:", "  - glob: docs/**", "    tier: 9", ""].join("\n"),
    );
    expect(() => loadAutoMergeSensitivityMap(root)).toThrow(
      /invalid policies\/automerge-tiers\.yaml/,
    );
  });

  it("THROWS when version is missing/unsupported (strict schema)", () => {
    const root = harnessRootWith(
      ["rules:", "  - glob: docs/**", "    tier: 2", ""].join("\n"),
    );
    expect(() => loadAutoMergeSensitivityMap(root)).toThrow(
      /invalid policies\/automerge-tiers\.yaml/,
    );
  });
});
