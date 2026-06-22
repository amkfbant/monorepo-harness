import { describe, expect, it } from "vitest";
import {
  redactFreeText,
  renderHitchSummary,
  REDACTED_PLACEHOLDER,
  type RedactedText,
  type SafeCourseSummary,
  type SafeFindingLine,
  type SafeHitchLine,
} from "../../../src/reporter/hitch-summary.js";

// ---------------------------------------------------------------------------
// redactFreeText — the sole constructor of RedactedText. Two responsibilities:
// (1) secret fail-closed: whole-field [redacted] when containsLikelySecret hits
// (2) markdown-line collapse: newlines → space so free text cannot inject a
//     heading/block into the structural Markdown (mirrors #171b).
// ---------------------------------------------------------------------------
describe("redactFreeText", () => {
  it("leaves safe single-line text unchanged", () => {
    expect(redactFreeText("fix null deref in profile loader")).toBe(
      "fix null deref in profile loader",
    );
  });

  it("collapses newlines so free text cannot inject a Markdown heading", () => {
    const out = redactFreeText("done\n\n## Injected Heading\nmore");
    expect(out).toBe("done ## Injected Heading more");
    expect(out).not.toContain("\n");
  });

  // table-driven: every vendor/name-shaped secret must be withheld WHOLE.
  it.each([
    ["github classic token", "leaked ghp_0123456789abcdefghijklmnopqrstuvwx"],
    ["openai key", "key sk-proj-ABCDEFGHIJKLMNOPQRSTUV in env"],
    ["aws access key id", "found AKIAIOSFODNN7EXAMPLE in source"],
    ["aws secret assignment", "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG"],
    ["generic api_key assignment", "api_key: 1234567890abcdef"],
    ["bearer token", "Authorization: bearer abcdef0123456789xyz"],
    ["pem private key header", "-----BEGIN RSA PRIVATE KEY-----\nMIIE..."],
    ["slack bot token", "leaked xoxb-12345678901-abcdefghijkl token"],
    ["slack app token", "xapp-1-A0123456789-abcdefghijklmno here"],
    ["gitlab pat", "glpat-abcdefghijklmnopqrstuvwx in config"],
    ["google api key", `key AIza${"x".repeat(35)} used`],
    ["http basic auth", "Authorization: Basic QWxhZGRpbjpvcGVuc2VzYW1l"],
  ])("withholds the whole field for %s", (_label, raw) => {
    const out = redactFreeText(raw);
    expect(out).toBe(REDACTED_PLACEHOLDER);
    // the secret substring must not survive anywhere in the output
    const secretCore = raw.split(/\s/).find((t) => t.length > 12) ?? raw;
    expect(out).not.toContain(secretCore);
  });
});

// ---------------------------------------------------------------------------
// fixture builders — RedactedText fields MUST go through redactFreeText (the
// only constructor), exactly as the aggregate layer does.
// ---------------------------------------------------------------------------
function finding(over: Partial<SafeFindingLine> = {}): SafeFindingLine {
  return {
    findingId: "f-1",
    source: "review",
    severity: "P1",
    scopeStatus: "in_scope",
    lifecycleStatus: "open",
    category: redactFreeText("correctness"),
    summary: redactFreeText("off-by-one in pagination"),
    firstSeenAt: "2026-06-20T00:00:00.000Z",
    ...over,
  };
}

function hitch(over: Partial<SafeHitchLine> = {}): SafeHitchLine {
  return {
    hitchId: "hitch-1",
    title: redactFreeText("implement pagination"),
    status: "in_progress",
    latestDecision: "needs_fix",
    findingCounts: {
      openInScopeP0: 0,
      openInScopeP1: 1,
      openInScopeP2: 0,
      openUnknownScope: 0,
      openOutOfScope: 0,
    },
    escalated: false,
    interventionCounts: {
      reopened: 0,
      prAdopted: 0,
      divergingRecovered: 0,
      updated: 0,
    },
    pr: null,
    findings: [finding()],
    ...over,
  };
}

function course(over: Partial<SafeCourseSummary> = {}): SafeCourseSummary {
  return {
    courseId: "course-abc",
    title: redactFreeText("Checkout revamp"),
    description: redactFreeText("ship the new checkout"),
    status: "active",
    openInScopeP0: 0,
    openInScopeP1: 1,
    phases: [
      {
        phaseId: "phase-1",
        title: redactFreeText("Backend"),
        status: "in_progress",
        hitches: [hitch()],
      },
    ],
    ...over,
  };
}

describe("renderHitchSummary", () => {
  it("renders course headline, rolled-up counts, phase + hitch structure", () => {
    const md = renderHitchSummary(course());
    expect(md).toMatch(/# Hitch Summary: Checkout revamp/);
    expect(md).toMatch(/course-abc/);
    expect(md).toMatch(/Status.*active/);
    expect(md).toMatch(/Open P0.*0/);
    expect(md).toMatch(/Open P1.*1/);
    expect(md).toMatch(/## Phase: Backend/);
    expect(md).toMatch(/phase-1/);
    expect(md).toMatch(/hitch-1/);
    expect(md).toMatch(/Convergence.*needs_fix/);
    expect(md).toMatch(/P0=0 P1=1 P2=0 unknown=0 outOfScope=0/);
    // finding line: enums + redacted summary
    expect(md).toMatch(/off-by-one in pagination/);
  });

  it("renders escalation, interventions and PR only when present", () => {
    const withoutExtras = renderHitchSummary(course());
    expect(withoutExtras).not.toMatch(/Escalated/);
    expect(withoutExtras).not.toMatch(/Interventions/);
    expect(withoutExtras).not.toMatch(/\bPR\b/);

    const withExtras = renderHitchSummary(
      course({
        phases: [
          {
            phaseId: "phase-1",
            title: redactFreeText("Backend"),
            status: "in_progress",
            hitches: [
              hitch({
                status: "escalated",
                escalated: true,
                interventionCounts: {
                  reopened: 2,
                  prAdopted: 1,
                  divergingRecovered: 0,
                  updated: 3,
                },
                pr: { number: 999, url: "https://github.com/x/y/pull/999" },
              }),
            ],
          },
        ],
      }),
    );
    expect(withExtras).toMatch(/Escalated.*yes/);
    expect(withExtras).toMatch(/reopened=2/);
    expect(withExtras).toMatch(/pr_adopted=1/);
    expect(withExtras).toMatch(/updated=3/);
    expect(withExtras).toMatch(/#999/);
    expect(withExtras).toMatch(/pull\/999/);
  });

  it("redacts a secret-shaped finding summary in the rendered output", () => {
    const secret = "ghp_0123456789abcdefghijklmnopqrstuvwx";
    const md = renderHitchSummary(
      course({
        phases: [
          {
            phaseId: "phase-1",
            title: redactFreeText("Backend"),
            status: "in_progress",
            hitches: [
              hitch({
                findings: [
                  finding({
                    summary: redactFreeText(`token leaked ${secret} here`),
                    category: redactFreeText("security"),
                  }),
                ],
              }),
            ],
          },
        ],
      }),
    );
    expect(md).not.toContain(secret);
    expect(md).toContain(REDACTED_PLACEHOLDER);
  });

  it("a newline-bearing identifier or PR url cannot inject a structural heading", () => {
    // hitch/course/phase ids are operator-supplied and NOT charset-validated at
    // write time, so the renderer must collapse them defensively.
    const md = renderHitchSummary(
      course({
        courseId: "c\n# Fake Course Heading",
        phases: [
          {
            phaseId: "p\n# Fake Phase Heading",
            title: redactFreeText("P"),
            status: "in_progress",
            hitches: [
              hitch({
                hitchId: "h\n# Fake Hitch Heading",
                findings: [finding({ findingId: "f\n# Fake Finding Heading" })],
                pr: { number: 1, url: "https://x/y\n# Fake PR Heading" },
              }),
            ],
          },
        ],
      }),
    );
    const lines = md.split("\n");
    for (const fake of [
      "# Fake Course Heading",
      "# Fake Phase Heading",
      "# Fake Hitch Heading",
      "# Fake Finding Heading",
      "# Fake PR Heading",
    ]) {
      expect(lines.some((l) => l.startsWith(fake))).toBe(false);
    }
  });

  it("a free-text heading injection in a title cannot create a structural heading", () => {
    const md = renderHitchSummary(
      course({ title: redactFreeText("Real\n# Fake Top Heading") }),
    );
    // collapsed to a single inline line — no line in the body begins with "# Fake"
    expect(
      md.split("\n").some((line) => line.startsWith("# Fake")),
    ).toBe(false);
  });

  it("renders degenerate shapes: empty course, empty phase, hitch with no findings", () => {
    const emptyCourse = renderHitchSummary(course({ phases: [] }));
    expect(emptyCourse).toMatch(/# Hitch Summary: Checkout revamp/);

    const emptyPhase = renderHitchSummary(
      course({
        phases: [
          {
            phaseId: "p0",
            title: redactFreeText("Empty"),
            status: "pending",
            hitches: [],
          },
        ],
      }),
    );
    expect(emptyPhase).toMatch(/## Phase: Empty/);

    const noFindings = renderHitchSummary(
      course({
        phases: [
          {
            phaseId: "phase-1",
            title: redactFreeText("Backend"),
            status: "in_progress",
            hitches: [hitch({ findings: [], latestDecision: null })],
          },
        ],
      }),
    );
    expect(noFindings).toMatch(/hitch-1/);
    expect(noFindings).toMatch(/Convergence.*\(none\)/);
  });

  it("omits the Description line when the course description is null", () => {
    const md = renderHitchSummary(course({ description: null }));
    expect(md).not.toMatch(/Description/);
  });
});

// brand: a plain string is NOT assignable where RedactedText is required.
// This is a compile-time guarantee; the runtime check below documents intent.
describe("RedactedText brand", () => {
  it("redactFreeText is the constructor; placeholder is branded", () => {
    const t: RedactedText = redactFreeText("ok");
    expect(typeof t).toBe("string");
    expect(typeof REDACTED_PLACEHOLDER).toBe("string");
  });
});
