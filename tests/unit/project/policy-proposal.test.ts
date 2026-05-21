import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { ProjectProfileSchema } from "../../../src/project/schema.js";
import {
  loadCompileInputs,
  compileProjectPolicy,
} from "../../../src/project/policy-compiler.js";
import {
  buildPolicyProposal,
  provenanceSidecarPath,
} from "../../../src/project/policy-proposal.js";
import { formatProposalMarkdown } from "../../../src/project/format-proposal.js";
import { RepoPolicySchema } from "../../../src/policy/schema.js";
import { parseProvenance } from "../../../src/project/provenance.js";

const TEMPLATES = join(process.cwd(), "templates");

async function compileSample() {
  const profile = ProjectProfileSchema.parse({
    version: 1,
    project_id: "demo",
    repo: { id: "demo", path: "../demo" },
    policy: { template: "strict-monorepo-v1" },
    domains: [{ id: "apps/web", root: "apps/web", kind: "app" }],
  });
  const inputs = await loadCompileInputs(profile, "projects/demo.yaml", {
    templatesDir: TEMPLATES,
    generatedAt: "2026-05-22T00:00:00.000Z",
  });
  return compileProjectPolicy(inputs);
}

describe("buildPolicyProposal", () => {
  it("E5-4-7: serializes a repo policy YAML that parses back valid", async () => {
    const proposal = buildPolicyProposal(await compileSample(), "/harness");
    const reparsed = RepoPolicySchema.safeParse(
      parseYaml(proposal.repoPolicyYaml),
    );
    expect(reparsed.success).toBe(true);
  });

  it("serializes a provenance sidecar JSON that parses back", async () => {
    const proposal = buildPolicyProposal(await compileSample(), "/harness");
    expect(parseProvenance(proposal.provenanceJson)).not.toBeNull();
  });

  it("points the sidecar at <repo-id>.generated.json", async () => {
    const proposal = buildPolicyProposal(await compileSample(), "/harness");
    expect(proposal.repoPolicyPath).toMatch(/policies\/repos\/demo\.yaml$/);
    expect(proposal.provenancePath).toMatch(
      /policies\/repos\/demo\.generated\.json$/,
    );
  });

  it("summarizes each domain", async () => {
    const proposal = buildPolicyProposal(await compileSample(), "/harness");
    expect(proposal.domains).toHaveLength(1);
    expect(proposal.domains[0]?.id).toBe("apps/web");
    expect(proposal.domains[0]?.root).toBe("apps/web");
    expect(proposal.domains[0]?.writeCount).toBeGreaterThan(0);
  });
});

describe("provenanceSidecarPath", () => {
  it("rewrites the .yaml extension", () => {
    expect(provenanceSidecarPath("/p/policies/repos/x.yaml")).toBe(
      "/p/policies/repos/x.generated.json",
    );
  });
});

describe("formatProposalMarkdown", () => {
  it("E5-4-8: renders a readable proposal", async () => {
    const proposal = buildPolicyProposal(await compileSample(), "/harness");
    const md = formatProposalMarkdown(proposal, "/harness");
    expect(md).toMatch(/# Project policy proposal: demo/);
    expect(md).toMatch(/## Domains \(1\)/);
    expect(md).toMatch(/```yaml/);
    expect(md).toMatch(/project check --project demo/);
  });
});
