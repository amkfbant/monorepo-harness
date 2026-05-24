# Phase 10-16 codex review triage

**Date:** 2026-05-24
**Source reviews:** `tmp/phase{13,14,15,16}-codex-review.txt`,
`tmp/phase10-16-sweep-codex-review.txt`
**Model:** gpt-5.5 reasoning effort=xhigh

Phase 10/11/12 は既に post-close codex review + fix を反映済み
(`8873591`, `0b65fdd`, `c3bab3e`)。今回は未レビューだった Phase 13/14/15/16
の per-phase レビュー + Phase 10-16 cross-phase sweep を回した。

---

## Accept — apply as post-close fixes (this commit)

| # | Phase | Finding | Fix |
|---|---|---|---|
| A1 | 13 | Mutation can run on localhost with no Bearer token; non-timing-safe compare | mutationEnabled=true で token 必須化 + `crypto.timingSafeEqual` |
| A2 | 13 | 202 deferred endpoints mark operation as `succeeded` while no execution happened — false audit | runOperation に `pendingExternalExecutor` オプション追加。`pending` で finalize し audit を誠実に |
| A3 | 14 | `computeAssetStatus`: `exportRow != null && currentRevSha == null` returns dirty-db/conflict instead of missing | precedence 修正 + テスト |
| A4 | 15 | `doctor.ts` `runtime.orphan_run`: status='coding' は実在しない (`RUN_STATUSES` には `running`) | `'coding'` → `'running'` |
| A5 | 15 | `doctor.ts` expiry check: SQLite `datetime('now')` (space) と ISO `toISOString()` (T) の lexicographic mismatch | JS から ISO `now` を bind して比較 |
| A6 | 15 | `repair.ts` `lock.release_expired` は finding 古い時点の lock_id だけで UPDATE — 間に renew があると stale release | UPDATE に `expires_at < ?` (bound now) を追加 |
| A7 | 15 | `markBackupVerified` は actual verify せず verified_at だけ立てる — `upgrade-check` が誤検知の上で readiness 判定 | 新 `verifyBackup(db, id)` を追加し sha + size + schema をチェックして成功時のみ verified_at 設定 |
| A8 | 16 | `LocalBlobStore.put` content-addressed idempotency 違反 (sha 未検証 / rename 前に pre-delete / conflict で corrupt) | put 入力 body の sha256 を再ハッシュして名前と一致を強制 + 既存と一致なら no-op + rename without pre-delete |

---

## Defer to Phase 17 — strategic / large refactor

| # | Phase | Finding | 見送り理由 |
|---|---|---|---|
| D1 | 13 | UNIQUE idempotency 制約が failed/cancelled retry を阻害 | schema migration v12 が必要。Phase 17 の "convergence" のスコープ |
| D2 | 14 | DB-canonical strategy が split-brain risk を抱える (runtime は file を読む) | Phase 17 で runtime DB-first loader に切替えるのが本来の道 |
| D3 | 14 | `effective_policy_snapshots` に derive flow / reuse / cache key / read route なし | Phase 14 は infrastructure-only と self-declared。Phase 17 で derive 実装 |
| D4 | 16 | `artifacts.storage='external'` value 書き込み / read path 未統合 | schema v12 (artifacts CHECK 緩和) + 大規模統合。Phase 17 の中心テーマ |
| D5 | Sweep | `state_version` rollout が `forceFailFinalize` / `applyReviewDecision` のみで partial | 全 writer の bump 統一は 10+ ファイルに渡る。Phase 17 で "writer map" として一括 |
| D6 | Sweep | OperationRunner が cross-phase mutation boundary 化されていない (14/15/16 が bypass) | Phase 14/15/16 の write path 統合は大規模リファクタ |
| D7 | Sweep | post-run reservation race (Phase 10 から open のまま) | CAS 設計とテスト + 既存 cleanup/pr-create 改修。Phase 17 で reservation milestone |
| D8 | Sweep | `dashboard/server/server.ts` (1,418L) と `db/schema.ts` (1,137L) が 800L 上限超え | ファイル分割は Phase 17 の "convergence cleanup" で一括 |

---

## Phase 17 着手の前提条件 (sweep review より)

1. state_version writer map (どの writer が何を bump するか)
2. OperationRunner coverage map (どの mutation が wrap される / されない)
3. schema v12 table rebuild plan (artifacts.storage CHECK 緩和 + UNIQUE
   idempotency の partial index 化)
4. dashboard server split plan
5. deferral burn-down checklist (D1〜D8 + Phase 14/15/16 partial closes)

---

## Score サマリ

| Phase | Score | Top reservation |
|---|---:|---|
| 13 | 6.5/10 | Audit ledger が acceptance より lifecycle を保証していない |
| 14 | 6/10 | DB と runtime の split-brain |
| 15 | 6.5/10 | "verified/ready" 判定が unsafe な状態でも pass |
| 16 | 5.5/10 | external blob 経路が schema v12 + 統合層分離れている |
| 10-16 sweep | 7/10 | infrastructure-first 戦略の限界 |
