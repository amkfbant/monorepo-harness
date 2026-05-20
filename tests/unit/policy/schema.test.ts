import { describe, it, expect } from "vitest";
import {
  GlobalPolicySchema,
  RepoPolicySchema,
} from "../../../src/policy/schema.js";

describe("GlobalPolicySchema", () => {
  it("parses a minimal global policy", () => {
    const parsed = GlobalPolicySchema.parse({
      always_deny_write: [".git/**"],
    });
    expect(parsed.always_deny_write).toContain(".git/**");
  });

  it("rejects unknown top-level keys", () => {
    expect(() =>
      GlobalPolicySchema.parse({ always_deny_write: [], extra: 1 }),
    ).toThrow();
  });
});

describe("RepoPolicySchema", () => {
  it("parses a repo policy with one domain", () => {
    const parsed = RepoPolicySchema.parse({
      repo_id: "sample-monorepo",
      read: ["README.md"],
      domains: {
        "apps/user": {
          read: ["apps/user/**"],
          write: ["apps/user/**"],
          deny_write: ["packages/shared/**"],
        },
      },
    });
    expect(parsed.domains["apps/user"]?.write).toEqual(["apps/user/**"]);
  });

  it("requires repo_id", () => {
    expect(() => RepoPolicySchema.parse({ domains: {} })).toThrow();
  });
});
