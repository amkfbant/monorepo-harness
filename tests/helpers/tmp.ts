import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDirs: readonly string[] = [];

export function makeTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(join(tmpdir(), prefix));
  tmpDirs = [...tmpDirs, dir];
  return dir;
}

export function flushTmpDirs(removeTmpDir = fs.rmSync): void {
  const remaining: string[] = [];
  for (const dir of tmpDirs) {
    try {
      removeTmpDir(dir, { recursive: true, force: true });
    } catch {
      remaining.push(dir);
    }
  }
  tmpDirs = remaining;
}

export function pendingTmpDirs(): readonly string[] {
  return Object.freeze([...tmpDirs]);
}
