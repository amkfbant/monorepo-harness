import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { LocalBlobStore } from "../../../src/storage/local-blob-store.js";

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
