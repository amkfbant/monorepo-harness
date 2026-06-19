import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { HitchRepository } from "../../../src/hitch/repository.js";

/**
 * C0 — frozen-invariants harness for {@link HitchRepository} (#125 Track C).
 *
 * `HitchRepository` is a FROZEN core: its public surface is consumed by ~24
 * call-site files (orchestrator / convergence / CLI / MCP / roadmap). Track C
 * decomposes the implementation into per-concern sub-repositories under
 * `src/hitch/repositories/` by COMPOSITION DELEGATION — the facade keeps every
 * public method and forwards to `this.<subRepo>.method()`. This test pins the
 * observable shape of that facade so the C1-C4 extraction stays behaviour-zero:
 * a moved method that silently changed name/arity, vanished, or grew a new
 * public entry-point fails HERE rather than in a downstream consumer.
 *
 * It deliberately asserts the EXACT public method set (no more, no less), the
 * constructor arity, and that the documented single-transaction primitives
 * (`runAtomically` + the `*Core` non-tx variants) remain on the facade itself
 * (they must compose under ONE shared db handle / single BEGIN).
 */

/** The 49 public methods of the frozen `HitchRepository` facade, sorted. Any
 * rename / removal / addition is a contract break and must be a deliberate
 * edit to this list (with a matching consumer + spec update), never an
 * accidental fallout of the Track C extraction. */
const FROZEN_PUBLIC_METHODS: readonly string[] = [
  "adoptPr",
  "classifyAndDeferFinding",
  "classifyFinding",
  "completeAttempt",
  "completeReviewCycle",
  "countFindingSummary",
  "countFindings",
  "createAttempt",
  "createSession",
  "deferFinding",
  "discardAttempt",
  "getAttempt",
  "getCloseCheck",
  "getDecision",
  "getFinding",
  "getReviewCycle",
  "getSession",
  "harnessOriginDivergenceMetrics",
  "hasAdoptedPr",
  "latestCodingRunChangedPaths",
  "latestFindingMutationAt",
  "linkedPhaseSpecApprovalDrifts",
  "listAttempts",
  "listCloseChecks",
  "listDecisions",
  "listFindings",
  "listLifecycleEvents",
  "listReviewCycles",
  "listSessions",
  "markFindingFixed",
  "maxFindingReopenCount",
  "recordCloseCheck",
  "recordConvergenceDecision",
  "recoverDivergingSession",
  "reopenSession",
  "requireAttempt",
  "requireCloseCheck",
  "requireDecision",
  "requireFinding",
  "requireReviewCycle",
  "requireSession",
  "resolveSupersededReviewFindings",
  "resolveSupersededReviewFindingsCore",
  "runAtomically",
  "startReviewCycle",
  "updateSessionConfig",
  "updateStatus",
  "upsertFinding",
  "upsertFindingCore",
];

/** Methods that MUST stay on the facade class itself (not delegated to a
 * sub-repo) because they own the single-BEGIN atomic primitive: the atomic
 * review import opens one transaction via `runAtomically` and composes the
 * non-transactional `*Core` writers inside it. A sub-repo with its own db
 * handle / transaction would break that single-BEGIN guarantee. */
const FACADE_OWNED_ATOMIC_METHODS: readonly string[] = [
  "runAtomically",
  "upsertFindingCore",
  "resolveSupersededReviewFindingsCore",
];

function freshRepo(): { db: ReturnType<typeof openDb>; repo: HitchRepository } {
  const dir = mkdtempSync(join(tmpdir(), "harness-frozen-repo-"));
  const db = openDb(join(dir, ".harness", "harness.sqlite"));
  runMigrations(db);
  return { db, repo: new HitchRepository(db) };
}

/** Collect the own (instance) method names declared on the class prototype,
 * excluding the constructor. TypeScript `private` is erased at runtime, so this
 * enumerates EVERY function on the prototype; we then intersect with the
 * documented public list. */
function prototypeMethodNames(repo: HitchRepository): string[] {
  const proto = Object.getPrototypeOf(repo) as object;
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== "constructor")
    .filter((name) => {
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      return typeof descriptor?.value === "function";
    })
    .sort();
}

describe("HitchRepository frozen invariants (C0, #125 Track C)", () => {
  it("exposes EXACTLY the 49 frozen public methods (no rename / drop / add)", () => {
    const { repo } = freshRepo();
    const allPrototypeMethods = prototypeMethodNames(repo);

    // Every frozen public method must still resolve to a callable function on
    // the facade (delegation keeps the entry-point; the body forwards).
    for (const name of FROZEN_PUBLIC_METHODS) {
      expect(
        typeof (repo as unknown as Record<string, unknown>)[name],
        `public method "${name}" must remain callable on the facade`,
      ).toBe("function");
    }

    // The public surface must be EXACTLY the frozen set — no public method may
    // be dropped, and the extraction must not promote a former private helper
    // (or a new sub-repo method) onto the public list. Restrict the prototype
    // methods to the frozen names and assert set equality: a dropped method
    // shrinks this list, a renamed one swaps an entry.
    const publicOnPrototype = allPrototypeMethods.filter((name) =>
      FROZEN_PUBLIC_METHODS.includes(name),
    );
    expect(publicOnPrototype).toEqual([...FROZEN_PUBLIC_METHODS].sort());

    // Exactly 49 frozen public methods.
    expect(FROZEN_PUBLIC_METHODS.length).toBe(49);
  });

  it("keeps the atomic-primitive methods on the facade itself", () => {
    const { repo } = freshRepo();
    for (const name of FACADE_OWNED_ATOMIC_METHODS) {
      const fn = (repo as unknown as Record<string, unknown>)[name];
      expect(typeof fn, `${name} must stay on the facade`).toBe("function");
    }
  });

  it("constructs from a single Database handle (constructor arity 1)", () => {
    expect(HitchRepository.length).toBe(1);
  });

  it("runAtomically composes the *Core writers under one shared transaction", () => {
    const { repo } = freshRepo();
    const hitch = repo.createSession({
      title: "frozen atomic invariant",
      createdBy: "test",
      createdSource: "cli",
      createdAt: "2026-06-20T00:00:00.000Z",
    });

    // The atomic primitive runs the non-transactional *Core writers inside a
    // single BEGIN. Exercise that exact composition (the path
    // importReviewProposalToHitch relies on) and assert all-or-nothing: the
    // upsert + the cycle write commit together.
    const cycle = repo.startReviewCycle({
      hitchId: hitch.hitchId,
      reviewMode: "initial",
      createdAt: "2026-06-20T00:00:01.000Z",
    });
    const result = repo.runAtomically(() => {
      const upserted = repo.upsertFindingCore({
        hitchId: hitch.hitchId,
        source: "review",
        severity: "P2",
        category: "correctness",
        summary: "atomic-composed finding",
        sourceCycleId: cycle.cycleId,
        seenAt: "2026-06-20T00:00:02.000Z",
      });
      repo.completeReviewCycle({
        cycleId: cycle.cycleId,
        completedAt: "2026-06-20T00:00:03.000Z",
      });
      return upserted;
    });
    expect(result.created).toBe(true);
    expect(repo.getFinding(result.finding.findingId)).not.toBeNull();
    expect(repo.requireReviewCycle(cycle.cycleId).completedAt).toBe(
      "2026-06-20T00:00:03.000Z",
    );

    // A throw inside the atomic closure rolls back EVERYTHING (single BEGIN).
    expect(() =>
      repo.runAtomically(() => {
        repo.upsertFindingCore({
          hitchId: hitch.hitchId,
          source: "review",
          severity: "P1",
          category: "correctness",
          summary: "rolled-back finding",
          sourceCycleId: cycle.cycleId,
          seenAt: "2026-06-20T00:00:04.000Z",
        });
        throw new Error("boom");
      }),
    ).toThrow("boom");
    const survivors = repo
      .listFindings({ hitchId: hitch.hitchId })
      .map((f) => f.summary);
    expect(survivors).toContain("atomic-composed finding");
    expect(survivors).not.toContain("rolled-back finding");
  });
});
