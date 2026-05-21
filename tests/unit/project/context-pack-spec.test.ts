import { describe, it, expect } from "vitest";
import {
  ContextPackPresetSchema,
  normalizeContextPackPreset,
  normalizeInlineContextPack,
  DEFAULT_CONTEXT_PACK_MAX_BYTES,
} from "../../../src/project/context-pack-spec.js";

describe("ContextPackPresetSchema", () => {
  it("E5-2-7: parses a valid context pack preset", () => {
    const r = ContextPackPresetSchema.safeParse({
      version: 1,
      pack_id: "docs-v1",
      globs: ["README.md", "docs/**/*.md"],
      max_bytes: 1024,
      binary: "skip",
      missing: "warn",
    });
    expect(r.success).toBe(true);
  });

  it("rejects an unsafe glob in a context pack preset", () => {
    const r = ContextPackPresetSchema.safeParse({
      version: 1,
      pack_id: "bad-v1",
      globs: ["../escape/**"],
    });
    expect(r.success).toBe(false);
  });

  it("requires at least one glob", () => {
    const r = ContextPackPresetSchema.safeParse({
      version: 1,
      pack_id: "empty-v1",
      globs: [],
    });
    expect(r.success).toBe(false);
  });
});

describe("normalizeContextPackPreset", () => {
  it("applies defaults for omitted fields", () => {
    const preset = ContextPackPresetSchema.parse({
      version: 1,
      pack_id: "docs-v1",
      globs: ["README.md"],
    });
    const n = normalizeContextPackPreset(preset);
    expect(n.id).toBe("docs-v1");
    expect(n.maxBytes).toBe(DEFAULT_CONTEXT_PACK_MAX_BYTES);
    expect(n.denySecretLike).toBe(true);
    expect(n.binary).toBe("skip");
    expect(n.missing).toBe("warn");
  });

  it("keeps explicit values", () => {
    const preset = ContextPackPresetSchema.parse({
      version: 1,
      pack_id: "docs-v1",
      globs: ["README.md"],
      max_bytes: 99,
      deny_secret_like: false,
      binary: "error",
      missing: "ignore",
    });
    const n = normalizeContextPackPreset(preset);
    expect(n.maxBytes).toBe(99);
    expect(n.denySecretLike).toBe(false);
    expect(n.binary).toBe("error");
    expect(n.missing).toBe("ignore");
  });
});

describe("normalizeInlineContextPack", () => {
  it("E5-2-8: normalizes an inline profile context pack", () => {
    const n = normalizeInlineContextPack("default-docs", {
      description: "general docs",
      globs: ["docs/**/*.md"],
      max_bytes: 2048,
    });
    expect(n.id).toBe("default-docs");
    expect(n.maxBytes).toBe(2048);
    expect(n.denySecretLike).toBe(true);
    expect(n.binary).toBe("skip");
    expect(n.missing).toBe("warn");
  });
});
