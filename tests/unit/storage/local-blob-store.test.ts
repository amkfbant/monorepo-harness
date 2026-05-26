import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  LocalBlobStore,
  LocalBlobStoreContentMismatchError,
} from "../../../src/storage/local-blob-store.js";

function sha(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

describe("LocalBlobStore (Phase 16-2)", () => {
  it("put → get round-trip", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-blob-"));
    const store = new LocalBlobStore({ root });
    const body = Buffer.from("hello world");
    const s = sha(body);
    const p = await store.put({
      sha256: s,
      body,
      contentEncoding: "identity",
    });
    expect(p.storedBytes).toBe(11);
    const back = await store.get({ sha256: s, uri: p.uri });
    expect(back.equals(body)).toBe(true);
  });

  it("head returns size; null when not present", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-blob-"));
    const store = new LocalBlobStore({ root });
    const body = Buffer.from("x".repeat(100));
    const s = sha(body);
    expect(await store.head({ sha256: s, uri: "" })).toBeNull();
    await store.put({
      sha256: s,
      body,
      contentEncoding: "identity",
    });
    const h = await store.head({ sha256: s, uri: "" });
    expect(h?.sizeBytes).toBe(100);
  });

  it("put is idempotent (same sha overwrites; size unchanged)", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-blob-"));
    const store = new LocalBlobStore({ root });
    const body = Buffer.from("abc");
    const s = sha(body);
    await store.put({
      sha256: s,
      body,
      contentEncoding: "identity",
    });
    await store.put({
      sha256: s,
      body,
      contentEncoding: "identity",
    });
    const h = await store.head({ sha256: s, uri: "" });
    expect(h?.sizeBytes).toBe(3);
  });

  it("delete removes the object (idempotent)", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-blob-"));
    const store = new LocalBlobStore({ root });
    const body = Buffer.from("y");
    const s = sha(body);
    await store.put({
      sha256: s,
      body,
      contentEncoding: "identity",
    });
    await store.delete({ sha256: s, uri: "" });
    await store.delete({ sha256: s, uri: "" }); // no throw
    expect(await store.head({ sha256: s, uri: "" })).toBeNull();
  });

  // Phase 16 post-close fix (external review P2-4): pathFor must reject
  // any sha256 that is not 64 hex chars so a TEXT-typed DB value cannot
  // become a path-traversal attempt via get / head / delete (the put()
  // path's hash recompute already guarded the write side).
  it("get/head/delete reject non-hex64 sha (DB-corruption defense)", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-blob-"));
    const store = new LocalBlobStore({ root });
    const bad = "../../../etc/passwd";
    await expect(
      store.get({ sha256: bad, uri: "" }),
    ).rejects.toThrow(/invalid sha256/i);
    await expect(
      store.head({ sha256: bad, uri: "" }),
    ).rejects.toThrow(/invalid sha256/i);
    await expect(
      store.delete({ sha256: bad, uri: "" }),
    ).rejects.toThrow(/invalid sha256/i);
  });

  // Phase 16 post-close fix (codex P1.2): the local store is
  // content-addressed; the object name MUST equal sha256(body).
  // The earlier put() accepted any (sha, body) pair and would silently
  // overwrite. These tests pin down the new contract.
  it("put refuses when declared sha != sha(body)", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-blob-"));
    const store = new LocalBlobStore({ root });
    const body = Buffer.from("real body");
    const wrongSha = "0".repeat(64);
    await expect(
      store.put({ sha256: wrongSha, body, contentEncoding: "identity" }),
    ).rejects.toBeInstanceOf(LocalBlobStoreContentMismatchError);
    // Store stays empty — no garbage tmp left behind either.
    const sha256Root = join(root, "sha256");
    let dirs: string[] = [];
    try {
      dirs = readdirSync(sha256Root);
    } catch {
      // not created yet → fine
    }
    expect(dirs).toEqual([]);
  });

  it("put no-ops when same sha is already stored (no tmp file leaked)", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-blob-"));
    const store = new LocalBlobStore({ root });
    const body = Buffer.from("repeat-me");
    const s = sha(body);
    await store.put({ sha256: s, body, contentEncoding: "identity" });
    await store.put({ sha256: s, body, contentEncoding: "identity" });
    // The shard dir should contain exactly the canonical file, no tmps.
    const shard = join(root, "sha256", s.slice(0, 2), s.slice(2, 4));
    const files = readdirSync(shard);
    expect(files).toEqual([s]);
  });

  it("list iterates stored objects", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-blob-"));
    const store = new LocalBlobStore({ root });
    const shas: string[] = [];
    for (const x of ["a", "bb", "ccc"]) {
      const b = Buffer.from(x);
      const s = sha(b);
      shas.push(s);
      await store.put({
        sha256: s,
        body: b,
        contentEncoding: "identity",
      });
    }
    const found: string[] = [];
    for await (const r of store.list!()) {
      found.push(r.sha256);
    }
    expect(found.sort()).toEqual(shas.sort());
  });
});
