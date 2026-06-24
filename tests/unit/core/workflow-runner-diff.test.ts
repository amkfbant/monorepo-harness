import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readRedactedStderrTail,
  readRedactedTail,
} from "../../../src/core/workflow-runner-diff.js";
import { COMMAND_LOG_LINE_WITHHELD } from "../../../src/reporter/secret-scan.js";
import { makeTmpDir } from "../../helpers/tmp.js";

describe("Codex stdout/stderr redacted tails", () => {
  it("redacts the full stdout log before taking the tail", async () => {
    const dir = makeTmpDir("harness-codex-tail-");
    const path = join(dir, "codex-output.log");
    const pemBody = "bodyLineWithoutStandaloneTokenShape";
    writeFileSync(
      path,
      [
        "safe before",
        "-----BEGIN RSA PRIVATE KEY-----",
        pemBody,
        "-----END RSA PRIVATE KEY-----",
        "safe after",
      ].join("\n"),
      "utf8",
    );

    const tail = await readRedactedTail(path, 80);

    expect(tail).toContain(COMMAND_LOG_LINE_WITHHELD);
    expect(tail).toContain("safe after");
    expect(tail).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(tail).not.toContain(pemBody);
    expect(tail).not.toContain("END RSA PRIVATE KEY");
  });

  it("keeps stderr patch-echo suppression while redacting leading secrets", async () => {
    const dir = makeTmpDir("harness-codex-stderr-tail-");
    const path = join(dir, "codex-error.log");
    const token = `sk-${"c".repeat(40)}`;
    writeFileSync(
      path,
      [
        "warning before",
        `OPENAI_API_KEY=${token}`,
        "diff --git a/foo.ts b/foo.ts",
        "@@ -1 +1 @@",
        `+OPENAI_API_KEY=${token}`,
      ].join("\n"),
      "utf8",
    );

    const tail = await readRedactedStderrTail(path);

    expect(tail).toContain("warning before");
    expect(tail).toContain(COMMAND_LOG_LINE_WITHHELD);
    expect(tail).toContain("[stderr omitted: patch-like output detected");
    expect(tail).not.toContain(token);
    expect(tail).not.toContain("diff --git");
  });
});
