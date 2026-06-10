import { describe, it, expect } from "vitest";
import {
  isSymlinkCapable,
  assertSymlinkCapable,
  SymlinkUnsupportedError,
  type SymlinkProbeFs,
} from "../../../src/workspace/fs-preflight.js";

function fakeFs(over: Partial<SymlinkProbeFs> = {}): {
  fs: SymlinkProbeFs;
  rmCalls: string[];
} {
  const rmCalls: string[] = [];
  const fs: SymlinkProbeFs = {
    mkdirSync: () => {},
    symlinkSync: () => {},
    rmSync: (p) => {
      rmCalls.push(p);
    },
    ...over,
  };
  return { fs, rmCalls };
}

function eperm(): NodeJS.ErrnoException {
  const e = new Error("operation not permitted") as NodeJS.ErrnoException;
  e.code = "EPERM";
  return e;
}

describe("isSymlinkCapable (#68)", () => {
  it("returns true when the probe symlink succeeds", () => {
    const { fs } = fakeFs();
    expect(isSymlinkCapable("/some/dir", fs)).toBe(true);
  });

  it("returns false when symlink creation fails with EPERM (9p/drvfs)", () => {
    const { fs } = fakeFs({
      symlinkSync: () => {
        throw eperm();
      },
    });
    expect(isSymlinkCapable("/mnt/d/x", fs)).toBe(false);
  });

  it("returns true for a non-EPERM probe failure (not a general gatekeeper)", () => {
    const enoent = new Error("nope") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    const { fs } = fakeFs({
      mkdirSync: () => {
        throw enoent;
      },
    });
    expect(isSymlinkCapable("/some/dir", fs)).toBe(true);
  });

  it("always attempts cleanup of the probe dir", () => {
    const { fs, rmCalls } = fakeFs({
      symlinkSync: () => {
        throw eperm();
      },
    });
    isSymlinkCapable("/mnt/d/x", fs);
    expect(rmCalls).toHaveLength(1);
    expect(rmCalls[0]).toContain(".harness-symlink-probe");
  });
});

describe("assertSymlinkCapable (#68)", () => {
  it("throws SymlinkUnsupportedError naming the dir + remediation on EPERM", () => {
    const { fs } = fakeFs({
      symlinkSync: () => {
        throw eperm();
      },
    });
    expect(() => assertSymlinkCapable("/mnt/d/proj", fs)).toThrow(
      SymlinkUnsupportedError,
    );
    try {
      assertSymlinkCapable("/mnt/d/proj", fs);
    } catch (e) {
      expect((e as Error).message).toContain("/mnt/d/proj");
      expect((e as Error).message).toMatch(/Linux-native|EPERM|9p\/drvfs/);
    }
  });

  it("does not throw when symlinks are supported", () => {
    const { fs } = fakeFs();
    expect(() => assertSymlinkCapable("/home/user/ops", fs)).not.toThrow();
  });
});
