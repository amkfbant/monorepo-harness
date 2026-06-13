import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename } from "node:path";
import config from "../../../vitest.config.ts";
import {
  flushTmpDirs,
  makeTmpDir,
  pendingTmpDirs,
} from "../../helpers/tmp.js";

type VitestConfigShape = {
  test?: {
    poolOptions?: {
      forks?: {
        maxForks?: number;
        minForks?: number;
      };
    };
    teardownTimeout?: number;
    globalSetup?: string | string[];
    setupFiles?: string | string[];
  };
};

function configList(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  return value === undefined ? [] : [value];
}

afterEach(() => {
  vi.restoreAllMocks();
  flushTmpDirs();
});

describe("test temp-dir cleanup helper", () => {
  it("tracks and flushes temp dirs created through makeTmpDir", () => {
    const dir = makeTmpDir("harness-tmptest-");

    expect(dir.startsWith(tmpdir())).toBe(true);
    expect(basename(dir).startsWith("harness-tmptest-")).toBe(true);
    expect(existsSync(dir)).toBe(true);
    expect(pendingTmpDirs()).toContain(dir);

    flushTmpDirs();

    expect(existsSync(dir)).toBe(false);
    expect(pendingTmpDirs()).toEqual([]);
  });

  it("keeps a failed deletion registered so the next flush retries it", () => {
    const dir = makeTmpDir("harness-tmptest-");
    let calls = 0;
    const remove = vi.fn(
      (path: string, options: Parameters<typeof rmSync>[1]) => {
        calls += 1;
        if (calls === 1 && path === dir) throw new Error("busy");
        return rmSync(path, options);
      },
    );

    flushTmpDirs(remove);

    expect(existsSync(dir)).toBe(true);
    expect(pendingTmpDirs()).toContain(dir);

    flushTmpDirs(remove);

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(existsSync(dir)).toBe(false);
    expect(pendingTmpDirs()).toEqual([]);
  });

  it("bounds the fork pool and installs tmp cleanup hooks", () => {
    const testConfig = (config as VitestConfigShape).test;

    expect(testConfig?.poolOptions?.forks).toMatchObject({
      maxForks: 4,
      minForks: 1,
    });
    expect(testConfig?.teardownTimeout).toBe(20_000);
    expect(configList(testConfig?.globalSetup)).toContain(
      "./tests/global-tmp-sweep.ts",
    );
    expect(configList(testConfig?.setupFiles)).toEqual(
      expect.arrayContaining([
        "./tests/setup-export-mode.ts",
        "./tests/setup-tmp-cleanup.ts",
      ]),
    );
  });
});
