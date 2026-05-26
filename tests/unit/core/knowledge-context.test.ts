import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildKnowledgeContext,
  buildKnowledgeContextFromDb,
  domainSlug,
} from "../../../src/core/knowledge-context.js";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { recordKnowledgeEntryRevision } from "../../../src/db/repositories/knowledge-entry-revisions.js";

interface KnowledgeMd {
  kind: string;
  domain: string;
  title: string;
  content: string;
  deprecated?: boolean;
}

/** Write a promoted-knowledge md under <knowledgeDir>/<kind>/<name>.md */
function writeKnowledge(
  knowledgeDir: string,
  name: string,
  k: KnowledgeMd,
): void {
  const dir = join(knowledgeDir, k.kind);
  mkdirSync(dir, { recursive: true });
  const fm = [
    "---",
    `kind: ${k.kind}`,
    `domain: ${JSON.stringify(k.domain)}`,
    `title: ${JSON.stringify(k.title)}`,
    `confidence: "high"`,
    `deprecated: ${k.deprecated ? "true" : "false"}`,
    "hash: 0123456789abcdef",
    "---",
    "",
    `# ${k.title}`,
    "",
    k.content,
    "",
  ].join("\n");
  writeFileSync(join(dir, `${name}.md`), fm);
}

function setup(): { knowledgeDir: string; outDir: string } {
  const root = mkdtempSync(join(tmpdir(), "harness-kctx-"));
  return {
    knowledgeDir: join(root, "knowledge"),
    outDir: join(root, "knowledge-context"),
  };
}

describe("domainSlug", () => {
  it("flattens slashes and appends a hash suffix", () => {
    expect(domainSlug("apps/catalog")).toMatch(/^apps-catalog-[0-9a-f]{8}$/);
  });

  it("is injective: ambiguous domains get distinct slugs", () => {
    // both flatten to apps-user-api but must not collide
    expect(domainSlug("apps/user-api")).not.toBe(domainSlug("apps/user/api"));
  });

  it("is deterministic", () => {
    expect(domainSlug("apps/catalog")).toBe(domainSlug("apps/catalog"));
  });
});

describe("buildKnowledgeContext", () => {
  it("aggregates promoted knowledge for the matching domain", async () => {
    const { knowledgeDir, outDir } = setup();
    writeKnowledge(knowledgeDir, "k1", {
      kind: "policy_violation",
      domain: "apps/catalog",
      title: "Lesson A",
      content: "scope your writes",
    });
    writeKnowledge(knowledgeDir, "k2", {
      kind: "domain_rule",
      domain: "apps/catalog",
      title: "Lesson B",
      content: "use err() consistently",
    });
    const r = await buildKnowledgeContext({
      knowledgeDir,
      outDir,
      domain: "apps/catalog",
    });
    expect(r.entries).toHaveLength(2);
    const md = readFileSync(r.outPath, "utf8");
    expect(r.outPath).toMatch(/apps-catalog-[0-9a-f]{8}\.md$/);
    expect(md).toMatch(/Lesson A/);
    expect(md).toMatch(/use err\(\) consistently/);
    expect(md).toMatch(/entry_count: 2/);
  });

  it("excludes knowledge of other domains", async () => {
    const { knowledgeDir, outDir } = setup();
    writeKnowledge(knowledgeDir, "k1", {
      kind: "policy_violation",
      domain: "apps/catalog",
      title: "Catalog lesson",
      content: "x",
    });
    writeKnowledge(knowledgeDir, "k2", {
      kind: "policy_violation",
      domain: "apps/orders",
      title: "Orders lesson",
      content: "y",
    });
    const r = await buildKnowledgeContext({
      knowledgeDir,
      outDir,
      domain: "apps/catalog",
    });
    expect(r.entries.map((e) => e.title)).toEqual(["Catalog lesson"]);
  });

  it("excludes deprecated knowledge", async () => {
    const { knowledgeDir, outDir } = setup();
    writeKnowledge(knowledgeDir, "live", {
      kind: "domain_rule",
      domain: "apps/catalog",
      title: "Live lesson",
      content: "current",
    });
    writeKnowledge(knowledgeDir, "old", {
      kind: "domain_rule",
      domain: "apps/catalog",
      title: "Retired lesson",
      content: "outdated",
      deprecated: true,
    });
    const r = await buildKnowledgeContext({
      knowledgeDir,
      outDir,
      domain: "apps/catalog",
    });
    expect(r.entries.map((e) => e.title)).toEqual(["Live lesson"]);
    const md = readFileSync(r.outPath, "utf8");
    expect(md).not.toMatch(/Retired lesson/);
  });

  it("excludes deprecated even when the frontmatter value is a quoted string", async () => {
    const { knowledgeDir, outDir } = setup();
    writeKnowledge(knowledgeDir, "live", {
      kind: "domain_rule",
      domain: "apps/catalog",
      title: "Live lesson",
      content: "current",
    });
    // hand-edited frontmatter: deprecated as the string "true"
    const dir = join(knowledgeDir, "domain_rule");
    writeFileSync(
      join(dir, "stringdep.md"),
      [
        "---",
        "kind: domain_rule",
        'domain: "apps/catalog"',
        'title: "String-deprecated"',
        'confidence: "high"',
        'deprecated: "true"',
        "hash: 0123456789abcdef",
        "---",
        "",
        "# String-deprecated",
        "",
        "outdated",
        "",
      ].join("\n"),
    );
    const r = await buildKnowledgeContext({
      knowledgeDir,
      outDir,
      domain: "apps/catalog",
    });
    expect(r.entries.map((e) => e.title)).toEqual(["Live lesson"]);
  });

  it("does not reach candidate / rejected entries (only docs/knowledge is scanned)", async () => {
    const { knowledgeDir, outDir } = setup();
    // a candidate yaml placed alongside — must be ignored
    mkdirSync(knowledgeDir, { recursive: true });
    writeFileSync(
      join(knowledgeDir, "knowledge-candidates.yaml"),
      "candidates:\n  - kind: x\n",
    );
    writeKnowledge(knowledgeDir, "promoted", {
      kind: "policy_violation",
      domain: "apps/catalog",
      title: "Only promoted",
      content: "z",
    });
    const r = await buildKnowledgeContext({
      knowledgeDir,
      outDir,
      domain: "apps/catalog",
    });
    expect(r.entries.map((e) => e.title)).toEqual(["Only promoted"]);
  });

  it("writes an empty-but-valid context when no knowledge matches", async () => {
    const { knowledgeDir, outDir } = setup();
    const r = await buildKnowledgeContext({
      knowledgeDir,
      outDir,
      domain: "apps/catalog",
    });
    expect(r.entries).toHaveLength(0);
    const md = readFileSync(r.outPath, "utf8");
    expect(md).toMatch(/no promoted knowledge/);
  });

  it("rejects an unsafe domain", async () => {
    const { knowledgeDir, outDir } = setup();
    await expect(
      buildKnowledgeContext({
        knowledgeDir,
        outDir,
        domain: "../escape",
      }),
    ).rejects.toThrow(/invalid domain/);
  });

  it("DB context treats null project/repo knowledge as global for scoped project runs", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-kctx-db-"));
    const db = openDb(join(root, ".harness", "harness.sqlite"));
    try {
      runMigrations(db);
      const bodyMarkdown = [
        "---",
        "kind: domain_rule",
        'domain: "apps/catalog"',
        'title: "Global Lesson"',
        'confidence: "high"',
        "deprecated: false",
        "---",
        "",
        "global context body",
        "",
      ].join("\n");
      recordKnowledgeEntryRevision(db, {
        entryId: "docs/knowledge/domain_rule/global.md",
        bodyMarkdown,
        frontmatter: {
          kind: "domain_rule",
          domain: "apps/catalog",
          title: "Global Lesson",
          confidence: "high",
          deprecated: false,
        },
        title: "Global Lesson",
        actor: "test",
      });
      db.prepare(
        `UPDATE knowledge_entries
            SET domain = 'apps/catalog',
                kind = 'domain_rule',
                path = 'docs/knowledge/domain_rule/global.md'
          WHERE entry_id = 'docs/knowledge/domain_rule/global.md'`,
      ).run();

      const r = await buildKnowledgeContextFromDb({
        db,
        outDir: join(root, "knowledge-context"),
        domain: "apps/catalog",
        projectId: "demo",
        repoId: "demo",
      });

      expect(r.entries.map((e) => e.title)).toEqual(["Global Lesson"]);
      expect(readFileSync(r.outPath, "utf8")).toMatch(/global context body/);
    } finally {
      db.close();
    }
  });
});
