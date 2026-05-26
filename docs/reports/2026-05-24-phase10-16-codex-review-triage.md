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

---

## 追加レビュー (2026-05-24 外部レビュー第 2 弾)

post-close fix 4 commit を含む状態で受領した外部レビューの triage を追記する。

### Accept — apply as post-close fixes (this commit)

| # | Phase | Finding | Fix |
|---|---|---|---|
| B1 | 13 (P1-1) | Dashboard artifact API は `artifactId` を positive integer validation し、`byte_size` 存在しない column を SELECT — 両 endpoint 完全に壊れている | path を `:artifactIdB64` に変え `<runId>:<relativePath>` を base64url で受領。SQL は `bytes` を使用。`decodeBase64UrlArtifactId` helper 追加。 |
| B2 | 13 (P1-3) | OperationRunner の "failed → new attempt" は schema の UNIQUE 制約と矛盾し UNIQUE violation で crash。Option A 採用 | 同 idempotency key は permanent identity。failed/cancelled は `OperationReplayedFailureError` を throw（caller は新 key を mint する必要）。pending/succeeded は replay。dashboard は 409 idempotency_replayed_failure で返却。 |
| B3 | 12 (P2-3) | mutation POST に JSON body size cap なし | `MAX_JSON_BODY_BYTES = 1 MiB`。超過は `"oversize"` sentinel を返し 413。EPIPE を避けるため drain は継続。 |
| B4 | 16 (P2-4) | `LocalBlobStore.pathFor` は sha256 hex64 形を検証していない / root prefix check なし → DB-corrupted TEXT で path traversal リスク | `/^[a-f0-9]{64}$/i` 強制 + `resolve(root, ...)` の root prefix verification。`head()` も ENOENT のみ null、それ以外は throw（pathFor の例外も含む）。 |
| B5 | 16 (P2-5) | `verifyExternalBlobs(db, store)` の default `{ storeId: "" }` で `store_id = ''` 検索 → 0 件 verify を silent return | storeId 未指定/空文字なら filter 適用しないよう変更。返り値の `storeId` は `?? ""`。 |
| B6 | 14/15/16 (P1-4) | "DB canonical complete" と書いてあるが実態は infrastructure-only — scope labeling 矛盾 | 各 close report 冒頭に "Scope label" 引用 box を追加し、何が landed / 何が Phase 17 送りかを明示。 |

**コミット:** B1〜B6 は per-phase ではなく "external review 反映" として 1 commit にまとめる（4 phase 横断のため）。

### Defer — Phase 17 集中処理

| # | Phase | Finding | 見送り理由 |
|---|---|---|---|
| C1 | 11 (P1-2 + P1-6) | review consensus が state transition の gate になっていない／consensus + decision + run status が atomic でない — required reviewers 不足でも approve できる | Phase 11 workflow の本質的再設計。`processReviewDecisionInDb` を「全 active proposal を rule で評価 → consensus result が gate → atomic transaction」に書き直す必要。既存テストへの cascade が大きく、別セッション推奨。Phase 17 の最優先項目に追加。 |
| C2 | sweep (P1-5) | `state_version` rollout 全 writer 未統合 | 既に [[triage Sweep D5]] で defer 済み。Phase 17 で writer map を作って一括 bump。 |
| C3 | sweep (P2-2) | dashboard server.ts (1,400+L) monolith 分割 | 既に [[triage Sweep D8]] で defer 済み。Phase 17 cleanup。 |
| C4 | sweep (P2-6) | maintenance-lock の同期 flock wait が event loop を止め得る | dashboard server の lock acquisition 戦略再設計。Phase 17 で `lock busy → 503` または起動時 shared lock 保持を検討。 |
| C5 | sweep (P2-7) | doctor / repair / backup / upgrade-check の CLI 統合 | Phase 15 close 時から explicit deferral。Phase 17 で `harness db doctor --json` 等を land。 |
| C6 | sweep (P2-8) | archive 本体 (build + read-time fallback) | Phase 15 / 16 close 時から explicit deferral。 |
| C7 | sweep (P2-1) | review_proposals row が v7 新 fields (reviewer_id / reviewer_type / lifecycle_status / model / prompt_sha256 / context_pack_id / policy_generation_id) を mapper / API で expose していない | Phase 11 governance を実用するため Phase 17 で完成させる。C1 と同時実施が効率的。 |
| C8 | sweep (P3-3) | Phase 14 の `recordProjectProfileRevision` placeholder project row 作成は明示 flag 化推奨 | 小さな改善。Phase 17 の Phase 14 convergence で対応。 |

### Phase 17 追加前提条件 (外部レビュー追加分)

triage 既存リスト (state_version writer map, OperationRunner coverage map,
schema v12, dashboard split, deferral burn-down) に加えて:

6. **Phase 11 consensus governance の completion**: 全 active proposal を
   rule で評価し、consensus result が state transition を gate する。
   consensus + review_decision + run status + proposal processed marks
   を atomic transaction にする。required reviewer 不足 / blocking
   decision の各ケースのテスト網羅。(外部 P1-2 + P1-6)
7. **review_proposals mapper / API の v7 fields completion**: reviewer_id /
   reviewer_type / lifecycle_status / model / prompt_sha256 / context_pack_id /
   policy_generation_id を含める。(外部 P2-1)
8. **dashboard request flow と DB maintenance lock の非ブロッキング化**:
   request handler が flock を同期待ちしないアーキテクチャ。(外部 P2-6)

### Test 追加（外部レビュー反映で land したもの）

post-close fix 第 2 弾で追加したテスト:

- artifact API: TEXT id retrieval / bytes column / 400 or 404 for invalid segment
- mutation body 413 (oversize)
- OperationReplayedFailureError (failed 後の同 key は throw、新 key は new operation)
- LocalBlobStore path validation (get/head/delete で invalid sha は throw)
- verifyExternalBlobs opts なしで全件 verify

最終 test count: 1099 → 1116 passed (+17 total in 2 round)。

---

## Phase 10-16 完了時点の triage status (2026-05-24)

Phase 10-16 は close 済み。post-close / 外部レビュー第 2 弾の扱いは以下で確定:

- **Accepted / landed:** A1-A8 + B1-B6。Phase 13 dashboard artifact API /
  mutation body cap / OperationRunner idempotency semantics、Phase 16
  LocalBlobStore / verifyExternalBlobs safety、Phase 14-16 close report の
  infrastructure-only scope label を反映済み。
- **Deferred to Phase 17:** D1-D8 + C1-C8。中心は schema v12、Phase 11
  consensus gate completion、state_version writer map、OperationRunner
  coverage map、dashboard server split、Phase 14-16 CLI / runtime wire-up。
- **Current verification:** `npm run typecheck` pass。`npm test` は sandbox
  内で dashboard server の `127.0.0.1` listen が `EPERM` となり同一 18
  tests だけ fail、残り 1098 passed / 1 skipped。該当
  `tests/integration/dashboard-server-skeleton.test.ts` を sandbox 外で再実行し
  18 passed。合算で 1116 passed / 1 skipped。

次に Phase 17 に入る場合は、この triage doc を backlog source of truth として
使い、C1 / C7（review governance completion）と D4 / D1（schema v12）を
最初の分岐点にする。
