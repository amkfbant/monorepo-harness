import { describe, it, expect } from "vitest";
import {
  filterEnv,
  DEFAULT_CODEX_ENV_ALLOWLIST,
} from "../../../src/codex/codex-cli-runner.js";

describe("filterEnv", () => {
  it("includes only allowlisted variables", () => {
    const out = filterEnv(
      {
        PATH: "/usr/bin",
        HOME: "/home/x",
        SECRET_KEY: "leak-me",
        OPENAI_API_KEY: "leak-me-too",
      } as NodeJS.ProcessEnv,
      ["PATH", "HOME"],
    );
    expect(out).toEqual({ PATH: "/usr/bin", HOME: "/home/x" });
    expect(out).not.toHaveProperty("SECRET_KEY");
    expect(out).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("default allowlist excludes secrets-like env vars", () => {
    expect(DEFAULT_CODEX_ENV_ALLOWLIST).toContain("PATH");
    expect(DEFAULT_CODEX_ENV_ALLOWLIST).toContain("HOME");
    expect(DEFAULT_CODEX_ENV_ALLOWLIST).not.toContain("OPENAI_API_KEY");
    expect(DEFAULT_CODEX_ENV_ALLOWLIST).not.toContain("AWS_SECRET_ACCESS_KEY");
  });
});
