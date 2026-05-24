import {
  mkdir,
  writeFile,
  readFile,
  stat,
  rm,
  readdir,
  rename,
} from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
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

/**
 * Phase 16 post-close fix (codex P1.2): the local store is
 * content-addressed; the object name MUST equal sha256(body). The prior
 * `put()` accepted any (sha, body) pair and would overwrite an existing
 * good object with a different body. After the fix:
 *
 *   1. body sha is re-computed and must equal `input.sha256`.
 *   2. if an object already exists with the same sha, the call is a
 *      no-op (idempotent re-put with identical content is allowed).
 *   3. otherwise atomic rename without a pre-rm (so a concurrent reader
 *      never sees an empty path).
 */
export class LocalBlobStoreContentMismatchError extends Error {
  constructor(declaredSha: string, computedSha: string) {
    super(
      `LocalBlobStore.put: body sha (${computedSha}) does not match declared sha (${declaredSha}); refusing to corrupt content-addressed store`,
    );
    this.name = "LocalBlobStoreContentMismatchError";
  }
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
    // (1) refuse to corrupt the store with a mismatching sha.
    const computed = createHash("sha256").update(input.body).digest("hex");
    if (computed !== input.sha256) {
      throw new LocalBlobStoreContentMismatchError(input.sha256, computed);
    }

    const p = this.pathFor(input.sha256);

    // (2) idempotent re-put: if the same sha already exists, no-op.
    try {
      const existing = await stat(p);
      if (existing.size === input.body.length) {
        return { uri: `file://${p}`, storedBytes: existing.size };
      }
      // Same name with a different size is impossible under a correct
      // content-addressed store, so surface it loudly rather than
      // overwriting silently.
      throw new Error(
        `LocalBlobStore.put: existing object at ${p} has size ${existing.size} but new body is ${input.body.length}; refusing to overwrite`,
      );
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw e;
    }

    await mkdir(join(p, ".."), { recursive: true });

    // (3) atomic write: write to a unique tmp, fsync via rename. We do
    // NOT rm the target first — POSIX rename() is atomic and a reader
    // of the existing object never sees an empty path window.
    const tmp = `${p}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    try {
      await writeFile(tmp, input.body);
      await rename(tmp, p);
    } catch (e) {
      // best-effort cleanup if the rename failed before the tmp was
      // promoted; leaving the tmp around would accumulate garbage.
      await rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
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
