import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    pool: "forks",
    poolOptions: { forks: { maxForks: 4, minForks: 1 } },
    teardownTimeout: 20_000,
    globalSetup: ["./tests/global-tmp-sweep.ts"],
    setupFiles: ["./tests/setup-export-mode.ts", "./tests/setup-tmp-cleanup.ts"],
  },
});
