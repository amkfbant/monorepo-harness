import process from "node:process";
import { openDb } from "../../src/db/connection.js";
import { storeArtifactBlob } from "../../src/db/artifact-blobs.js";

/**
 * Phase 8-9 concurrency fixture worker.
 *
 * Spawned as a separate process by `phase8-fixture-matrix.test.ts` so that
 * multiple OS processes genuinely contend on one `harness.sqlite`. Each
 * worker stores `count` unique blobs plus one blob whose content is shared
 * across every worker — so the parent can assert both per-worker writes
 * and cross-process dedup (INSERT OR IGNORE) survive the contention.
 *
 * argv: <dbPath> <seed> <count>
 */
const [dbPath, seed, countRaw] = process.argv.slice(2);
if (dbPath === undefined || seed === undefined || countRaw === undefined) {
  process.stderr.write("usage: blob-write-worker <dbPath> <seed> <count>\n");
  process.exit(2);
}

const count = Number(countRaw);
const db = openDb(dbPath);
try {
  for (let i = 0; i < count; i++) {
    storeArtifactBlob(db, Buffer.from(`blob-${seed}-${i}`));
    storeArtifactBlob(db, Buffer.from("shared-across-workers"));
  }
} finally {
  db.close();
}
