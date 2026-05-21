import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadPolicyTemplate,
  loadCommandPreset,
  loadContextPackPreset,
} from "../../../src/project/template-loader.js";
import { ProjectTemplateError } from "../../../src/project/errors.js";

const TEMPLATES = join(process.cwd(), "templates");

describe("template-loader", () => {
  it("E5-2-1: loads the strict-monorepo-v1 policy template", async () => {
    const t = await loadPolicyTemplate(TEMPLATES, "strict-monorepo-v1");
    expect(t.template_id).toBe("strict-monorepo-v1");
    expect(t.root_deny).toContain("package.json");
    expect(t.domain_defaults?.app?.write).toEqual(["{root}/**"]);
  });

  it("loads the docs-only-v1 policy template", async () => {
    const t = await loadPolicyTemplate(TEMPLATES, "docs-only-v1");
    expect(t.template_id).toBe("docs-only-v1");
  });

  it("E5-2-2: loads the node-basic-v1 command preset", async () => {
    const p = await loadCommandPreset(TEMPLATES, "node-basic-v1");
    expect(p.preset_id).toBe("node-basic-v1");
    expect(p.commands.length).toBeGreaterThan(0);
  });

  it("loads the python-basic-v1 command preset", async () => {
    const p = await loadCommandPreset(TEMPLATES, "python-basic-v1");
    expect(p.preset_id).toBe("python-basic-v1");
  });

  it("E5-2-3: loads the monorepo-docs-v1 context pack preset", async () => {
    const c = await loadContextPackPreset(TEMPLATES, "monorepo-docs-v1");
    expect(c.pack_id).toBe("monorepo-docs-v1");
    expect(c.globs).toContain("README.md");
  });

  it("rejects an unsafe catalog id", async () => {
    await expect(
      loadPolicyTemplate(TEMPLATES, "../escape"),
    ).rejects.toThrow(ProjectTemplateError);
  });

  it("throws ProjectTemplateError for a missing catalog entry", async () => {
    await expect(
      loadCommandPreset(TEMPLATES, "no-such-preset"),
    ).rejects.toThrow(ProjectTemplateError);
  });

  it("rejects a catalog entry whose declared id mismatches the filename", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-tl-"));
    mkdirSync(join(dir, "policy"), { recursive: true });
    writeFileSync(
      join(dir, "policy", "mismatch.yaml"),
      ["version: 1", "template_id: other-id", ""].join("\n"),
    );
    await expect(loadPolicyTemplate(dir, "mismatch")).rejects.toThrow(
      /mismatched id/,
    );
  });
});
