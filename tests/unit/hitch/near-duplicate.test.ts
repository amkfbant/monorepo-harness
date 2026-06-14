import { describe, expect, it } from "vitest";
import {
  findNearDuplicate,
  type NearDuplicateCandidate,
} from "../../../src/hitch/near-duplicate.js";

function candidate(
  summary: string,
  overrides: Partial<NearDuplicateCandidate> = {},
): NearDuplicateCandidate {
  return {
    findingId: overrides.findingId ?? "finding-canonical",
    hitchId: overrides.hitchId ?? "hitch-1",
    category: overrides.category ?? "review-required-change",
    filePath: overrides.filePath,
    symbol: overrides.symbol,
    scopeStatus: overrides.scopeStatus ?? "in_scope",
    summary,
  };
}

function find(
  summary: string,
  candidates: NearDuplicateCandidate[],
  overrides: Partial<Parameters<typeof findNearDuplicate>[0]> = {},
) {
  return findNearDuplicate({
    hitchId: "hitch-1",
    category: "review-required-change",
    scopeStatus: "in_scope",
    summary,
    candidates,
    ...overrides,
  });
}

describe("findNearDuplicate", () => {
  it("matches paraphrases of the same defect with null file paths", () => {
    const first =
      "Review import uses only summary text for finding identity, so paraphrased reviewer findings create new findings every cycle";
    const second =
      "Review import uses only summary text for finding identity; paraphrased reviewer findings create new findings each cycle";

    expect(find(second, [candidate(first)])?.findingId).toBe(
      "finding-canonical",
    );
    expect(find(first, [candidate(second)])?.findingId).toBe(
      "finding-canonical",
    );
  });

  it("does not match distinct findings in the same category", () => {
    const first =
      "Review import uses only summary text for finding identity, so paraphrased reviewer findings create new findings every cycle";
    const second =
      "Reviewer prompt should explain command logs live under runs runid commands and must not be created in the workspace";

    expect(find(second, [candidate(first)])).toBeNull();
    expect(find(first, [candidate(second)])).toBeNull();
  });

  it("normalizes digit runs so line-number churn does not block a match", () => {
    const first =
      "Finding at src/hitch/review-integration.ts line 107 increments findingsNew for duplicate advisory rows";
    const second =
      "Finding at src/hitch/review-integration.ts line 223 increments findingsNew for duplicate advisory rows";

    expect(find(second, [candidate(first)])?.findingId).toBe(
      "finding-canonical",
    );
  });

  it.each([
    [
      "Finding at src/hitch/review-integration.ts:107 increments findingsNew for duplicate advisory rows",
      "Finding at src/hitch/review-integration.ts:223 increments findingsNew for duplicate advisory rows",
    ],
    [
      "Finding at src/hitch/review-integration.ts line:107 increments findingsNew for duplicate advisory rows",
      "Finding at src/hitch/review-integration.ts line:223 increments findingsNew for duplicate advisory rows",
    ],
    [
      "Finding at src/hitch/review-integration.ts l107 increments findingsNew for duplicate advisory rows",
      "Finding at src/hitch/review-integration.ts l223 increments findingsNew for duplicate advisory rows",
    ],
    ["see file.ts:123", "see file.ts:456"],
  ])("normalizes colon line references: %s", (first, second) => {
    expect(find(second, [candidate(first)])?.findingId).toBe(
      "finding-canonical",
    );
  });

  it("does not normalize meaningful numbers into the same defect", () => {
    expect(
      find(
        "Close check should fail when the HTTP status is 500 in the merge probe",
        [
          candidate(
            "Close check should fail when the HTTP status is 404 in the merge probe",
          ),
        ],
      ),
    ).toBeNull();
    expect(
      find(
        "Review wait timeout should remain 5s for the short probe path",
        [
          candidate(
            "Review wait timeout should remain 30s for the short probe path",
          ),
        ],
      ),
    ).toBeNull();
  });

  it.each([
    [
      "connect to 127.0.0.1:3000 during the local validation probe",
      "connect to 127.0.0.1:4000 during the local validation probe",
    ],
    [
      "connect to example.com:443 during the remote validation probe",
      "connect to example.com:8443 during the remote validation probe",
    ],
  ])("does not normalize host or IP ports: %s", (first, second) => {
    expect(find(second, [candidate(first)])).toBeNull();
  });

  it("keeps pathless required changes for different endpoints separate", () => {
    expect(
      find(
        "API endpoint GET /orders/profile returns 500 when auth token is missing in required change handling",
        [
          candidate(
            "API endpoint GET /users/profile returns 500 when auth token is missing in required change handling",
          ),
        ],
      ),
    ).toBeNull();
  });

  it("deduplicates pathless paraphrases with the same distinctive endpoint", () => {
    expect(
      find(
        "API endpoint GET /users/profile returns 500 when missing auth token in required change handling",
        [
          candidate(
            "API endpoint GET /users/profile returns 500 when auth token is missing in required change handling",
          ),
        ],
      )?.findingId,
    ).toBe("finding-canonical");
  });

  it("preserves quoted identifiers as tokens", () => {
    const first =
      "Review import keeps audit rows but drops the `duplicate_of` canonical field for paraphrased findings";
    const second =
      "Review import keeps audit rows but drops the `duplicate_of` canonical field for paraphrase findings";

    expect(find(second, [candidate(first)])?.findingId).toBe(
      "finding-canonical",
    );
  });

  it("uses exact-only matching when either summary is shorter than five tokens", () => {
    expect(find("missing null check!", [candidate("missing null check")]))
      .not.toBeNull();
    expect(find("null check missing", [candidate("missing null check")]))
      .toBeNull();
  });

  it("requires compatible file paths", () => {
    const summary =
      "Review import uses only summary text for finding identity, so paraphrased reviewer findings create new findings every cycle";

    expect(
      find(summary, [candidate(summary, { filePath: "src/hitch/repository.ts" })]),
    ).toBeNull();
    expect(
      find(summary, [candidate(summary, { filePath: "src/hitch/repository.ts" })], {
        filePath: "./src\\hitch\\repository.ts",
      })?.findingId,
    ).toBe("finding-canonical");
  });

  it("matches across scope status so repository promotion can stay fail-closed", () => {
    const summary =
      "Review import uses only summary text for finding identity, so paraphrased reviewer findings create new findings every cycle";

    expect(
      find(summary, [
        candidate(summary, {
          scopeStatus: "out_of_scope",
        }),
      ])?.findingId,
    ).toBe("finding-canonical");
    expect(
      find(summary, [
        candidate(summary, {
          scopeStatus: "in_scope",
        }),
      ]),
    ).not.toBeNull();
  });

  it("requires compatible symbols", () => {
    const summary =
      "Review import uses only summary text for finding identity, so paraphrased reviewer findings create new findings every cycle";

    expect(
      find(summary, [
        candidate(summary, {
          symbol: "recordCloseCheck",
        }),
      ]),
    ).toBeNull();
    expect(
      find(summary, [
        candidate(summary, {
          symbol: "recordCloseCheck",
        }),
      ], {
        symbol: "recordCloseCheck",
      })?.findingId,
    ).toBe("finding-canonical");
    expect(
      find(summary, [candidate(summary)], {
        symbol: "recordCloseCheck",
      }),
    ).toBeNull();
    expect(find(summary, [candidate(summary)])?.findingId).toBe(
      "finding-canonical",
    );
  });

  it("enforces both token and bigram similarity thresholds", () => {
    const canonical =
      "alpha beta gamma delta epsilon zeta eta theta iota kappa";
    const aboveBoth =
      "alpha beta gamma delta epsilon zeta eta theta lambda mu";
    const belowToken =
      "alpha beta gamma delta epsilon zeta eta lambda mu nu";
    const belowBigram =
      "theta eta zeta epsilon delta gamma beta alpha iota kappa";

    expect(
      find(aboveBoth, [candidate(canonical, { filePath: "src/hitch/repository.ts" })], {
        filePath: "src/hitch/repository.ts",
      })?.findingId,
    ).toBe("finding-canonical");
    expect(
      find(belowToken, [candidate(canonical, { filePath: "src/hitch/repository.ts" })], {
        filePath: "src/hitch/repository.ts",
      }),
    ).toBeNull();
    expect(
      find(belowBigram, [candidate(canonical, { filePath: "src/hitch/repository.ts" })], {
        filePath: "src/hitch/repository.ts",
      }),
    ).toBeNull();
  });

  it("keeps anchored near-duplicate threshold behavior unchanged", () => {
    const canonical =
      "alpha beta gamma delta epsilon zeta eta theta iota kappa";
    const anchoredParaphrase =
      "alpha beta gamma delta epsilon zeta eta theta lambda mu";

    expect(
      find(
        anchoredParaphrase,
        [
          candidate(canonical, {
            filePath: "src/hitch/repository.ts",
            symbol: "recordFinding",
          }),
        ],
        {
          filePath: "src/hitch/repository.ts",
          symbol: "recordFinding",
        },
      )?.findingId,
    ).toBe("finding-canonical");
    expect(
      find(anchoredParaphrase, [candidate(canonical)]),
    ).toBeNull();
  });
});
