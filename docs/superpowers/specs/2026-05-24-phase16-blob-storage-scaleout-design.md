# Phase 16 — Blob storage scale-out 設計書

**作成日:** 2026-05-24
**対象:** `phase15-close` (commit `fd9a45f`) 後の `monorepo-harness`
**実装計画:** `tmp/phase10-16-design-plans/phase16-blob-storage-scaleout-plan.md`
**ステータス:** 設計確定 (Phase 16-0)。

---

## 1. 位置づけ

Phase 8 以降、artifact body は DB blob (`artifact_blobs`) に保存。長期
運用で SQLite が肥大化する → backup time / archive cost / vacuum
overhead が増す。Phase 16 は **storage='external'** を導入して blob
body を別 object store (local filesystem first, S3 stretch) に置く
mechanism を land する。

DB には manifest / content address (sha256) を残し、`storage='external'`
で external_artifact_blobs row が `uri` を持つ。content address は
"stored body after truncation, before transport encoding" の sha256 で
Phase 8/9 invariant を維持する。

Phase 16 のスコープ:
- artifacts.storage='external' を受け付ける
- local blob store adapter (filesystem)
- DB ↔ external migration
- verify + GC (unreferenced)
- backup / archive integration (store config + restore warning)

deferred (post-Phase-16):
- S3 adapter
- credentials KMS
- CDN
- public artifact sharing

---

## 2. canonical 境界 (Phase 16 確定値)

```
artifacts.storage = 'db':
  artifacts.blob_sha256 → artifact_blobs.sha256
  artifact_blob_chunks に bytes

artifacts.storage = 'external':
  artifacts.blob_sha256 → external_artifact_blobs.sha256
  external_artifact_blobs.uri → object location
  external_artifact_blobs.store_id → blob_stores 行

artifacts.storage = 'file' (legacy):
  Phase 8 以前の互換 / disaster recovery
```

content address (sha256) は "stored body after truncation, before
transport encoding"。Phase 8 invariant 不変。

---

## 3. 確定した設計判断

### A. BlobStore interface

```ts
interface BlobStore {
  put(input: {
    sha256: string;
    body: Buffer;
    contentEncoding: 'identity' | 'gzip';
    metadata: Record<string, string>;
  }): Promise<{ uri: string }>;
  get(input: { sha256: string; uri: string }): Promise<Buffer>;
  head(input: { sha256: string; uri: string }): Promise<{ sizeBytes: number }>;
  delete(input: { sha256: string; uri: string }): Promise<void>;
}
```

local adapter のみ Phase 16 で実装:

```
path layout: <root>/sha256/<first2>/<next2>/<sha256>
```

### B. Migration safety

DB → external:

1. read DB blob (existing `readArtifactBlob`)
2. put to external (write atomic — local: tempfile + rename)
3. head verify (size match)
4. INSERT external_artifact_blobs row
5. UPDATE artifacts.storage='external' + blob_sha256 (unchanged)
6. (option) DELETE artifact_blobs row if no other artifact references

partial failure:
- step 2-3 failed → DB unchanged, external blob deletable by GC
- step 4-5 failed → external blob persists, DB row INSERT fails
  cleanly (UNIQUE on sha)
- step 5 failed → external blob exists, DB row exists but artifacts
  still points to DB; verify check catches it later

### C. Verify

```ts
verifyBlobs(db, { storage?: 'db'|'external', sample?: number })
```

- DB: read + sha check
- External: head exists + size match (optional get + sha sample)
- external_artifact_blobs.status: 'available' | 'missing' | 'corrupt'

### D. GC

Unreferenced:
- artifact_blobs: artifacts に reference されない sha
- external_artifact_blobs: 同上
- object store: list で見つかった but DB に reference 無いオブジェクト
  (local adapter は list 実装)

dry-run default、`--apply` で実行。

### E. Backup / archive

backup manifest extension:

```json
{
  ...,
  "external": {
    "storeIds": ["local-default"],
    "blobCount": 1234,
    "totalBytes": 567890
  }
}
```

restore 時に external store が available か `db verify-blobs --storage
external` で確認するよう warning を出す。実 external object のコピー
は `--include-external-copy` (post-Phase-16)。

### F. Security

- blob_stores.config_json は env var **名** のみ (e.g.,
  `credentialsEnv: { accessKeyId: 'AWS_ACCESS_KEY_ID' }`)
- secret values は **DB に書かない**
- artifact secret scan (Phase 8) は external put 前に走る
- external URI に credential を含めない (presigned URL は dashboard
  endpoint で proxy。Phase 16 では未実装)

---

## 4. Schema v11

```sql
CREATE TABLE blob_stores (
  store_id      TEXT PRIMARY KEY,
  store_type    TEXT NOT NULL CHECK (store_type IN ('local', 's3')),
  config_json   TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE external_artifact_blobs (
  sha256           TEXT PRIMARY KEY,
  store_id         TEXT NOT NULL REFERENCES blob_stores(store_id),
  uri              TEXT NOT NULL,
  bytes            INTEGER NOT NULL,
  stored_bytes     INTEGER NOT NULL,
  content_encoding TEXT NOT NULL CHECK (content_encoding IN ('identity', 'gzip')),
  chunking         TEXT NOT NULL DEFAULT 'none',
  uploaded_at      TEXT NOT NULL,
  verified_at      TEXT,
  status           TEXT NOT NULL CHECK (status IN ('available', 'missing', 'corrupt')),
  metadata_json    TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX external_artifact_blobs_store_idx
  ON external_artifact_blobs(store_id, uploaded_at);

CREATE TABLE blob_migration_jobs (
  job_id        TEXT PRIMARY KEY,
  direction     TEXT NOT NULL CHECK (direction IN ('db-to-external', 'external-to-db')),
  store_id      TEXT,
  status        TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  completed_at  TEXT,
  input_json    TEXT NOT NULL,
  result_json   TEXT NOT NULL DEFAULT '{}',
  error_message TEXT
);
```

artifacts.storage CHECK 更新は schema v11 で:

```sql
-- 既存 artifacts table の storage CHECK は 'file' | 'db' のみ。
-- SQLite では ALTER TABLE で CHECK constraint を緩めるのは難しい
-- (drop+recreate が必要)。Phase 16 では明示 ALTER は **しない** —
-- artifacts.storage に 'external' value が入っても CHECK が無ければ
-- SQLite は accept する (Phase 8 以降の CHECK は実は `CHECK (storage
-- IN ('file', 'db'))` で hard 制約あり)。
-- 確認: 実装時に CHECK を緩める ALTER (drop + add) が必要なら
-- Phase 16-1 で対応。
```

(実装時に確認: 既存 artifacts.storage CHECK が 'external' を reject
するなら、ALTER TABLE … で CHECK を緩める necessary。)

---

## 5. CLI

```
harness db blob-stores add-local <store_id> --root <path>
harness db blob-stores list
harness db blob-stores test <store_id>

harness db migrate-blobs --to external --store <store_id>
   [--older-than 30d] [--min-bytes 1048576] [--dry-run]
harness db migrate-blobs --to db --store <store_id> [--dry-run]

harness db verify-blobs [--storage external] [--store <id>] [--sample 10%]
harness db gc-blobs [--storage external] [--dry-run | --apply]
```

Phase 16 minimum では `migrate-blobs --to external` + `verify-blobs` の
基本実装。S3 adapter + advanced GC は post-Phase-16。

---

## 6. Sub-phase

```
16-0  Design                                          ← 本書
16-1  Schema v11 (3 new tables + artifacts.storage CHECK 緩和)
16-2  Local blob store adapter
16-3  Artifact read/write integration (storage='external')
16-4  Migration DB ↔ external
16-5  Verify and GC
16-6  S3 adapter — deferred (post-Phase-16)
16-7  Backup / archive integration
16-8  Docs / close
```

---

## 7. Close conditions (plan §16 から)

```
[ ] artifacts.storage='external' が使える
[ ] local blob store adapter がある
[ ] S3-compatible adapter — Phase 16 では deferred (stretch)
[ ] artifact read/write が db/external 両方に対応
[ ] db migrate-blobs --to external / --to db がある
[ ] db verify-blobs が external を検証できる
[ ] db gc-blobs が dry-run/apply で動く
[ ] backup/restore/archive の external story が docs 化
[ ] credentials are not stored in plaintext
[ ] existing tests green
[ ] npm run typecheck green
[ ] docs / close report / phase16-close tag
```

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| S3 dependency complexity | Phase 16 では local adapter のみ、S3 を deferred |
| backup incomplete with external | manifest summary + `verify-blobs` after restore + `--include-external-copy` (post-Phase-16) |
| GC データ損失 | dry-run default + status marking + verify-before-delete + backup recommendation |
| credentials leak | env var 名のみ DB / signed URL 出さない / dashboard で redact |
| Phase 8 invariant 違反 | content address = stored body sha256 を維持。truncated artifact も original_* を保つ |

---

## 9. Phase 10-16 完走

Phase 16 close で Phase 10-16 全完了。以下が land 済み:

- Phase 10: DB-only runtime (file lock 撤去 / materialize 分離 /
  viewer DB-first / review idempotency)
- Phase 11: Review governance / consensus
- Phase 12: Dashboard serve + read-only API
- Phase 13: Mutation API + operation audit
- Phase 14: Human-authored assets DB canonical (infrastructure)
- Phase 15: DB doctor / repair / backup / archive / stats /
  upgrade-check (infrastructure)
- Phase 16: Blob storage scale-out (local adapter + migration +
  verify + GC; S3 deferred)

すべて infrastructure-only scope で land 済み。post-Phase-16 work と
して CLI 統合 + advanced features が残る。
