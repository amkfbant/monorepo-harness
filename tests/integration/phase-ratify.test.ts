import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { HitchRepository } from "../../src/hitch/repository.js";
import type { HitchCloseCondition, HitchScope } from "../../src/hitch/types.js";
import { PhaseRepository } from "../../src/roadmap/phase-repository.js";

const CLI = join(process.cwd(), "src/cli/run.ts");

const PHASE_SCOPE = { targetFiles: ["src/**", "tests/**"] } satisfies HitchScope;
const TIGHT_SCOPE = { targetFiles: ["src/**"] } satisfies HitchScope;
const LOOSE_SCOPE = {} satisfies HitchScope;
const CLOSE_CONDITIONS = [
  { id: "manual-pass", kind: "manual", required: true },
] satisfies HitchCloseCondition[];
const TIGHT_CLOSE_CONDITIONS = [
  ...CLOSE_CONDITIONS,
  { id: "extra-manual-pass", kind: "manual", required: true },
] satisfies HitchCloseCondition[];

function runCli(root: string, args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync("node", ["--import", "tsx", CLI, ...args], {
      env: {
        ...process.env,
        HARNESS_ROOT: root,
        HARNESS_SUPPRESS_EXPORT_MODE_WARNING: "1",
      },
    }).toString();
    return { out, code: 0 };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      out: `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`,
      code: err.status ?? 1,
    };
  }
}

function setup(): { root: string; files: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), "harness-phase-ratify-"));
  mkdirSync(root, { recursive: true });
  const files = {
    phaseScope: writeJson(root, "phase-scope.json", PHASE_SCOPE),
    tightScope: writeJson(root, "tight-scope.json", TIGHT_SCOPE),
    looseScope: writeJson(root, "loose-scope.json", LOOSE_SCOPE),
    driftScope: writeJson(root, "drift-scope.json", {
      targetFiles: ["src/**", "tests/**", "docs/**"],
    }),
    close: writeJson(root, "close.json", CLOSE_CONDITIONS),
    tightClose: writeJson(root, "tight-close.json", TIGHT_CLOSE_CONDITIONS),
    looseClose: writeJson(root, "loose-close.json", []),
  };
  return { root, files };
}

function writeJson(root: string, name: string, value: unknown): string {
  const path = join(root, name);
  writeFileSync(path, JSON.stringify(value), "utf8");
  return path;
}

function json<T>(result: { out: string; code: number }): T {
  expect(result.code, `expected exit 0, got:\n${result.out}`).toBe(0);
  return JSON.parse(result.out) as T;
}

function createCourseAndPhase(
  root: string,
  files: Record<string, string>,
): { courseId: string; phaseId: string } {
  const course = json<{ courseId: string }>(
    runCli(root, ["course", "create", "--title", "SP-21", "--json"]),
  );
  const phase = json<{ phaseId: string }>(
    runCli(root, [
      "phase",
      "add",
      "--course",
      course.courseId,
      "--title",
      "Ratified phase",
      "--scope-file",
      files.phaseScope,
      "--close-file",
      files.close,
      "--json",
    ]),
  );
  return { courseId: course.courseId, phaseId: phase.phaseId };
}

function withDb<T>(root: string, fn: (db: ReturnType<typeof openDb>) => T): T {
  const db = openDb(join(root, ".harness", "harness.sqlite"));
  try {
    runMigrations(db);
    return fn(db);
  } finally {
    db.close();
  }
}

function seedHitch(
  root: string,
  hitchId: string,
  input: { scope: HitchScope; closeConditions: HitchCloseCondition[] },
): void {
  withDb(root, (db) => {
    new HitchRepository(db).createSession({
      hitchId,
      title: hitchId,
      scope: input.scope,
      closeConditions: input.closeConditions,
      createdBy: "test",
      createdSource: "cli",
    });
  });
}

describe("phase ratify and ratified hitch integration (SP-21)", () => {
  it("phase ratify records namespaced approval and preserves existing review state", () => {
    const { root, files } = setup();
    const { phaseId } = createCourseAndPhase(root, files);

    expect(
      runCli(root, ["phase", "update", phaseId, "--note", "reviewed by operator"])
        .code,
    ).toBe(0);
    const ratified = runCli(root, [
      "phase",
      "ratify",
      phaseId,
      "--approved-by",
      "operator",
      "--reason",
      "accepted after review",
    ]);

    expect(ratified.code).toBe(0);
    expect(ratified.out).toContain("approvedBy=operator");
    withDb(root, (db) => {
      const phase = new PhaseRepository(db).require(phaseId);
      expect(phase.reviewState).toMatchObject({
        note: "reviewed by operator",
        specApproval: {
          approvedBy: "operator",
          reason: "accepted after review",
        },
      });
    });

    const missingApproval = runCli(root, ["phase", "ratify", phaseId]);
    expect(missingApproval.code).not.toBe(0);
    expect(missingApproval.out).toContain("approved-by");
  });

  it("link-hitch enforces ratified specs, allows tightening, and warns on spec drift", () => {
    const { root, files } = setup();
    const { phaseId } = createCourseAndPhase(root, files);

    const unratified = json<{ phaseId: string }>(
      runCli(root, [
        "phase",
        "add",
        "--course",
        json<{ courseId: string }>(
          runCli(root, ["course", "create", "--title", "Unratified", "--json"]),
        ).courseId,
        "--title",
        "Unratified phase",
        "--scope-file",
        files.phaseScope,
        "--close-file",
        files.close,
        "--json",
      ]),
    );
    seedHitch(root, "h-unratified-loose", {
      scope: LOOSE_SCOPE,
      closeConditions: [],
    });
    expect(
      runCli(root, [
        "phase",
        "link-hitch",
        unratified.phaseId,
        "h-unratified-loose",
      ]).code,
    ).toBe(0);

    expect(
      runCli(root, [
        "phase",
        "ratify",
        phaseId,
        "--approved-by",
        "operator",
      ]).code,
    ).toBe(0);

    seedHitch(root, "h-loose", { scope: LOOSE_SCOPE, closeConditions: [] });
    const loose = runCli(root, ["phase", "link-hitch", phaseId, "h-loose"]);
    expect(loose.code).toBe(1);
    expect(loose.out).toContain("--allow-scope-widen");

    seedHitch(root, "h-tight", {
      scope: TIGHT_SCOPE,
      closeConditions: TIGHT_CLOSE_CONDITIONS,
    });
    expect(runCli(root, ["phase", "link-hitch", phaseId, "h-tight"]).code).toBe(
      0,
    );

    const { phaseId: driftPhaseId } = createCourseAndPhase(root, files);
    expect(
      runCli(root, [
        "phase",
        "ratify",
        driftPhaseId,
        "--approved-by",
        "operator",
      ]).code,
    ).toBe(0);
    expect(
      runCli(root, [
        "phase",
        "update",
        driftPhaseId,
        "--scope-file",
        files.driftScope,
        "--allow-scope-widen",
      ]).code,
    ).toBe(0);
    seedHitch(root, "h-drift-current", {
      scope: { targetFiles: ["src/**", "tests/**", "docs/**"] },
      closeConditions: CLOSE_CONDITIONS,
    });
    const drift = runCli(root, [
      "phase",
      "link-hitch",
      driftPhaseId,
      "h-drift-current",
    ]);
    expect(drift.code).toBe(0);
    expect(drift.out).toContain("warning: phase");
    expect(drift.out).toContain("spec approval hash drift");
  });

  it("start-hitch creates and links atomically with the same ratified spec gate", () => {
    const { root, files } = setup();
    const { phaseId } = createCourseAndPhase(root, files);
    expect(
      runCli(root, [
        "phase",
        "ratify",
        phaseId,
        "--approved-by",
        "operator",
      ]).code,
    ).toBe(0);

    const started = runCli(root, [
      "phase",
      "start-hitch",
      phaseId,
      "--hitch-id",
      "h-start-default",
      "--title",
      "Default from phase",
    ]);
    expect(started.code).toBe(0);
    expect(started.out).toContain("hitch=h-start-default");
    withDb(root, (db) => {
      const hitch = new HitchRepository(db).requireSession("h-start-default");
      expect(hitch.scope).toEqual(PHASE_SCOPE);
      expect(hitch.closeConditions).toEqual(CLOSE_CONDITIONS);
      expect(new PhaseRepository(db).hitchIdsFor(phaseId)).toContain(
        "h-start-default",
      );
    });

    const loose = runCli(root, [
      "phase",
      "start-hitch",
      phaseId,
      "--hitch-id",
      "h-start-loose",
      "--title",
      "Loose from phase",
      "--scope-file",
      files.looseScope,
    ]);
    expect(loose.code).toBe(1);
    expect(loose.out).toContain("--allow-scope-widen");
    withDb(root, (db) => {
      expect(new HitchRepository(db).getSession("h-start-loose")).toBeNull();
    });

    const allowed = runCli(root, [
      "phase",
      "start-hitch",
      phaseId,
      "--hitch-id",
      "h-start-allowed",
      "--title",
      "Allowed loose from phase",
      "--scope-file",
      files.looseScope,
      "--allow-scope-widen",
    ]);
    expect(allowed.code).toBe(0);
    withDb(root, (db) => {
      expect(new PhaseRepository(db).hitchIdsFor(phaseId)).toContain(
        "h-start-allowed",
      );
    });
  });
});
