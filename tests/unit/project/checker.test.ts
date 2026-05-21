import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkProject } from "../../../src/project/checker.js";

const GENERATED_AT = "2026-05-22T00:00:00.000Z";

function harnessRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-chk-"));
  cpSync(join(process.cwd(), "templates"), join(root, "templates"), {
    recursive: true,
  });
  mkdirSync(join(root, "projects"), { recursive: true });
  return root;
}

function repoFixture(): string {
  const repo = mkdtempSync(join(tmpdir(), "harness-chk-repo-"));
  writeFileSync(join(repo, "package-lock.json"), "{}");
  writeFileSync(join(repo, "README.md"), "# demo\n");
  mkdirSync(join(repo, "apps/web"), { recursive: true });
  writeFileSync(
    join(repo, "apps/web/package.json"),
    JSON.stringify({ name: "@demo/web", scripts: { test: "vitest" } }),
  );
  execFileSync("git", ["init", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.email=t@example.com",
    "-c",
    "user.name=test",
    "commit",
    "-m",
    "init",
  ]);
  return repo;
}

function writeProfile(root: string, id: string, body: string): void {
  writeFileSync(join(root, "projects", `${id}.yaml`), body);
}

const OK_PROFILE = [
  "version: 1",
  "project_id: demo",
  "repo:",
  "  id: demo",
  "policy:",
  "  template: strict-monorepo-v1",
  "domains:",
  "  - id: apps/web",
  "    root: apps/web",
  "    kind: app",
  "",
].join("\n");

describe("checkProject", () => {
  it("E5-6-6: a sound profile checks ok", async () => {
    const root = harnessRoot();
    writeProfile(root, "demo", OK_PROFILE);
    const report = await checkProject({
      harnessRoot: root,
      projectId: "demo",
      repoOverride: repoFixture(),
      generatedAt: GENERATED_AT,
    });
    expect(report.status).toBe("ok");
    expect(report.items.some((i) => i.label === "policy compiles")).toBe(true);
    expect(
      report.items.some((i) => i.label === "resolvePolicy for all domains"),
    ).toBe(true);
  });

  it("E5-6-7: errors when the repo path does not exist", async () => {
    const root = harnessRoot();
    writeProfile(root, "demo", OK_PROFILE);
    const report = await checkProject({
      harnessRoot: root,
      projectId: "demo",
      repoOverride: join(tmpdir(), "no-such-repo-zzz"),
      generatedAt: GENERATED_AT,
    });
    expect(report.status).toBe("error");
  });

  it("warns when a domain root is absent from the repo", async () => {
    const root = harnessRoot();
    writeProfile(
      root,
      "demo",
      [
        "version: 1",
        "project_id: demo",
        "repo:",
        "  id: demo",
        "policy:",
        "  template: strict-monorepo-v1",
        "domains:",
        "  - id: apps/ghost",
        "    root: apps/ghost",
        "    kind: app",
        "",
      ].join("\n"),
    );
    const report = await checkProject({
      harnessRoot: root,
      projectId: "demo",
      repoOverride: repoFixture(),
      generatedAt: GENERATED_AT,
    });
    expect(
      report.items.some(
        (i) => i.level === "warn" && /domain root/.test(i.label),
      ),
    ).toBe(true);
  });

  it("E5-6-9: errors when deny_write covers a domain's entire write scope", async () => {
    const root = harnessRoot();
    writeProfile(
      root,
      "demo",
      [
        "version: 1",
        "project_id: demo",
        "repo:",
        "  id: demo",
        "policy:",
        "  template: strict-monorepo-v1",
        "domains:",
        "  - id: apps/web",
        "    root: apps/web",
        "    kind: app",
        "    write: [apps/web/**]",
        "    deny_write: [apps/web/**]",
        "",
      ].join("\n"),
    );
    const report = await checkProject({
      harnessRoot: root,
      projectId: "demo",
      repoOverride: repoFixture(),
      generatedAt: GENERATED_AT,
    });
    expect(report.status).toBe("error");
    expect(
      report.items.some(
        (i) => i.level === "error" && /cannot write/.test(i.detail ?? ""),
      ),
    ).toBe(true);
  });

  it("reports a profile-not-found as an error report (does not throw)", async () => {
    const root = harnessRoot();
    const report = await checkProject({
      harnessRoot: root,
      projectId: "missing",
      generatedAt: GENERATED_AT,
    });
    expect(report.status).toBe("error");
  });
});
