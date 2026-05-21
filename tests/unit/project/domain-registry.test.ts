import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DomainRegistrySchema,
  loadDomainRegistry,
} from "../../../src/project/domain-registry.js";
import { ProjectTemplateError } from "../../../src/project/errors.js";

const TEMPLATES = join(process.cwd(), "templates");

describe("DomainRegistrySchema", () => {
  it("parses a valid registry", () => {
    const r = DomainRegistrySchema.safeParse({
      version: 1,
      registry_id: "demo-v1",
      patterns: [
        { id_template: "apps/{name}", root_glob: "apps/*", kind: "app" },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("rejects a registry with no patterns", () => {
    const r = DomainRegistrySchema.safeParse({
      version: 1,
      registry_id: "demo-v1",
      patterns: [],
    });
    expect(r.success).toBe(false);
  });

  it("rejects an unknown domain kind", () => {
    const r = DomainRegistrySchema.safeParse({
      version: 1,
      registry_id: "demo-v1",
      patterns: [
        { id_template: "x/{name}", root_glob: "x/*", kind: "frontend" },
      ],
    });
    expect(r.success).toBe(false);
  });
});

describe("loadDomainRegistry", () => {
  it("E5-3-1: loads the node-monorepo-default-v1 registry", async () => {
    const reg = await loadDomainRegistry(TEMPLATES, "node-monorepo-default-v1");
    expect(reg.registry_id).toBe("node-monorepo-default-v1");
    expect(reg.suggested_policy_template).toBe("strict-monorepo-v1");
    expect(reg.patterns.length).toBeGreaterThan(0);
  });

  it("loads the generic-repo-default-v1 registry", async () => {
    const reg = await loadDomainRegistry(TEMPLATES, "generic-repo-default-v1");
    expect(reg.registry_id).toBe("generic-repo-default-v1");
  });

  it("rejects an unsafe registry id", async () => {
    await expect(
      loadDomainRegistry(TEMPLATES, "../escape"),
    ).rejects.toThrow(ProjectTemplateError);
  });

  it("throws for a missing registry", async () => {
    await expect(
      loadDomainRegistry(TEMPLATES, "no-such-registry"),
    ).rejects.toThrow(ProjectTemplateError);
  });

  it("rejects a registry whose declared id mismatches the filename", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-dr-"));
    mkdirSync(join(dir, "domain-registries"), { recursive: true });
    writeFileSync(
      join(dir, "domain-registries", "mismatch.yaml"),
      [
        "version: 1",
        "registry_id: other-id",
        "patterns:",
        "  - id_template: x/{name}",
        "    root_glob: x/*",
        "    kind: app",
        "",
      ].join("\n"),
    );
    await expect(loadDomainRegistry(dir, "mismatch")).rejects.toThrow(
      /mismatched registry_id/,
    );
  });
});
