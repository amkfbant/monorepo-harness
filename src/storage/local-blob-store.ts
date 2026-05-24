import { mkdir, writeFile, readFile, stat, rm, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type {
  BlobStore,
  ListResult,
  PutInput,
  PutResult,
} from "./blob-store.js";

/**
 * Local filesystem BlobStore (Phase 16-2).
 *
 * Layout:
 *   <root>/sha256/<first2>/<next2>/<full-sha256>
 *
 * The local adapter is also the test backend for migration / verify
 * paths so we do not need S3 fixtures.
 */

export interface LocalBlobStoreConfig {
  root: string;
}

export class LocalBlobStore implements BlobStore {
  constructor(public readonly config: LocalBlobStoreConfig) {}

  private pathFor(sha256: string): string {
    if (sha256.length < 4) {
      throw new Error(`invalid sha256 (too short): ${sha256}`);
    }
    return join(
      this.config.root,
      "sha256",
      sha256.slice(0, 2),
      sha256.slice(2, 4),
      sha256,
    );
  }

  async put(input: PutInput): Promise<PutResult> {
    const p = this.pathFor(input.sha256);
    await mkdir(join(p, ".."), { recursive: true });
    // Atomic write: write to tmp then rename.
    const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, input.body);
    try {
      await rm(p, { force: true }); // idempotent overwrite
    } catch {
      // best-effort
    }
    const { rename } = await import("node:fs/promises");
    await rename(tmp, p);
    return { uri: `file://${p}`, storedBytes: input.body.length };
  }

  async get(input: { sha256: string; uri: string }): Promise<Buffer> {
    return readFile(this.pathFor(input.sha256));
  }

  async head(
    input: { sha256: string; uri: string },
  ): Promise<{ sizeBytes: number } | null> {
    try {
      const s = await stat(this.pathFor(input.sha256));
      return { sizeBytes: s.size };
    } catch {
      return null;
    }
  }

  async delete(input: { sha256: string; uri: string }): Promise<void> {
    await rm(this.pathFor(input.sha256), { force: true });
  }

  async *list(_prefix?: string): AsyncIterable<ListResult> {
    const root = join(this.config.root, "sha256");
    let outer: string[];
    try {
      outer = await readdir(root);
    } catch {
      return;
    }
    for (const a of outer) {
      let middle: string[];
      try {
        middle = await readdir(join(root, a));
      } catch {
        continue;
      }
      for (const b of middle) {
        let files: string[];
        try {
          files = await readdir(join(root, a, b));
        } catch {
          continue;
        }
        for (const f of files) {
          if (f.length !== 64) continue; // sha256 hex
          const p = join(root, a, b, f);
          let s: { size: number };
          try {
            s = await stat(p);
          } catch {
            continue;
          }
          yield {
            sha256: f,
            uri: `file://${relative(this.config.root, p)}`,
            sizeBytes: s.size,
          };
        }
      }
    }
  }
}
