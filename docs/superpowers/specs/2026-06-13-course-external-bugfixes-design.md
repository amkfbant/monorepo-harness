# course 外バグ修正バンドル（design）

- 日付: 2026-06-13
- 対象: monorepo-harness（dev）
- 由来: open issue のうち **course 未掲載 ∧ non-enhancement** を棚卸しし、修正対象を確定したもの。
- 対象 issue: **#177 / #170 / #172 / #169 / #142**
  - 除外した近接 issue: #171 / #165（active な course-353fbb6a Phase B「divergence robustness #155/#164」と
    convergence 表示・dedup 領域で結合するため、本バンドルでは扱わず course 側に委ねる）。
  - #132（AbortSignal 貫通）は横断・独立設計 Phase が要る大物で SP-2 で意図 defer のため対象外。

## 全体方針

- 5 件は 2 つの独立 subsystem に属する。**backlog read 経路**（#177）と **hitch lifecycle/finding CLI**
  （#170/#172/#169/#142）。相互依存は無く、サブ Phase に分割して順に実装できる。
- 安全境界（CLAUDE.md / GOAL_RULES.md §G）は不可侵: policy 検証は事後 git diff ベース・LLM 自己申告を
  状態遷移の根拠にしない・状態遷移は harness のみ・fail-closed。本バンドルの追加はすべて
  **CLI / repository / read 経路の追加または既存ロジックの合成**であり、検証や状態機械を緩めない。
- migration が要るのは #169 と #142 の audit イベントのみ（後述、1 本に集約）。#177/#170/#172 は schema 不変。

### サブ Phase 分割（feature branch `fix/course-external-bugfixes` 1 本、origin/main から分岐）

- **G1 — #177**: backlog read 経路（list/show）を DB 正本化。
- **G2 — #170**: `hitch finding list` 追加（読み取り専用 CLI）。
- **G3 — #172**: `hitch finding defer --classify-out-of-scope` 合成フラグ。
- **G4 — #169 + #142**: lifecycle audit イベント拡張（migration V29）＋ `hitch adopt-pr` ＋ `hitch update`。
  - #169/#142 は同じ `hitch_lifecycle_events.event` CHECK 拡張 migration を共有するため同一サブ Phase に束ねる。

各サブ Phase は GOAL_RULES.md 準拠: TDD（RED→GREEN→REFACTOR）・codex `-m gpt-5.5 -c model_reasoning_effort="xhigh"`
レビュー（サブ最大 3 回）・未解決 P0 ゼロ gate・関連テスト＋typecheck 緑・spec 同コミット更新。

---

## G1 — #177: backlog read 経路の DB 正本化

### 問題

`hitch finding defer --backlog` と `backlog add` は `addBacklogItem()` 経由で `backlog_items`（DB）に
INSERT し、YAML を export する。`backlog done` / `backlog defer` も `transitionBacklogItem()` で DB を更新する
（write 経路は DB 正本）。しかし read 経路が非対称:

- `backlog list`（scope フィルタ無し）→ `listItems(paths.backlogDir, status)`（`src/core/backlog.ts:152`）が
  **YAML ファイルのみ**を走査。
- `backlog show --item-id`（`src/cli/run.ts:1870`）→ `showItem(paths.backlogDir, itemId)` が **YAML のみ**。
- DB-only 行（export 失敗・export 前）は read で不可視。`--project` / `--repo-id` を渡したときだけ
  `runScopedBacklog()` → `backlogList(db, filter)`（`src/db/repositories/aggregates.ts:476`）で DB を読む。

DB-canonical 原則（docs/specs/db.md）に照らすと、read もデフォルトで DB を正本にすべき。

### 変更

- **【codex P1 反映】full-item を返す DB read API を新設する**（summary の `backlogList` は流用しない）。
  既存 `backlogList(db, filter)`（`aggregates.ts:476`）は `goal` / `tags` / `createdAt` / `linkedRuns` を
  返さない summary API であり、現行 file formatter（`src/core/backlog.ts:361`）が前提とする full
  `BacklogItem` と非互換。そのまま流用すると「現行出力スキーマ維持」と両立しない。
  - `BacklogRepository`（`src/db/repositories/backlog.ts`）に **full item を返す read メソッド**を追加:
    `listItemsWithRuns(filter?)`（全件 or status/scope フィルタ、`backlog_run_links` を join して linkedRuns 込み、
    `BacklogItem` と同形を返す）と `getItemWithRuns(itemId)`（単一、not found は null）。
  - `backlog list`（`src/cli/run.ts:1834-1862`）/ `backlog show`（`:1863-1881`）の read をこの DB read API に切替。
    status フィルタ（open/doing/done/deferred）・`--project`/`--repo-id` scope を filter に渡す。
- **legacy-file 行の扱い**: `backlog_items` は `source_mode=legacy-file` の行も保持するため、DB read で
  legacy も db-first も**両方**出る（混在で全件可視）。file にしか無い未 import の legacy item を取りこぼさない
  ため、DB read 前に既存の **file→DB import/refresh** を通す（`runFullImport` は db-first を上書きしないので安全。
  G1 着手時に既存 import 経路の発火条件を確認し、過剰 import を避ける形で最小限に呼ぶ）。
- **DB 不在時のフォールバック**: harness root に DB が無い旧環境では従来の file read にフォールバック
  （後方互換のための fail-open read。書き込み経路は変えない）。判定は既存 DB 解決ヘルパ
  （`backlogDbContext()` / harness paths）に倣う。
- 出力フォーマット（テキスト / `--json`）は現行の file 由来出力と**同一スキーマ**を保つ（item_id, domain,
  title, goal, status, priority, tags, created_at, linked runs）。回帰で既存テストの期待が壊れないこと。

### 非対象

- file→DB の再 import や export 修復はしない（read を DB に寄せるだけ。export は既存の dirty フラグ機構が担う）。
- backlog item のスキーマ変更なし。

### テスト（G1）

- `defer --backlog` で作った DB-only 行が `backlog list` / `backlog show` に出る（#177 の再現が解消）。
- `backlog done` 後に status=done が list/show に反映。
- file 由来の legacy 行（source_mode=legacy-file）も引き続き出る（混在で全件見える）。
- status フィルタ・`--json` 出力の形が現行と一致（回帰防止）。
- DB 不在環境での file フォールバック。

---

## G2 — #170: `hitch finding list`

### 問題

`hitch finding` の subcommand は add / classify / fixed / defer のみ。findingId を得る正規手段が無く、
`hitch status <id> --json` を jq/python で漁る必要がある。

### 変更

- `src/cli/hitch.ts` に `finding list <hitch-id> [--open] [--severity <P0|P1|P2|P3|info>] [--scope <...>]
  [--limit <n>] [--json]` を追加。
- 既存 `HitchRepository.listFindings(filter)`（`src/hitch/repository.ts:1091`）を再利用。`--open` は
  `OPEN_FINDING_LIFECYCLES`（open/reopened/escalated）でフィルタ。`--severity` / `--scope` は filter に直結。
- **【codex P2 反映】default limit による silent 隠蔽を防ぐ**: `listFindings` の default limit は 200。
  CLI は `--limit` を受け付け、未指定時は `hitch status` と同様に大きな上限（`limit: 10_000`）を明示する。
- **【codex P2 反映】存在しない hitch-id**: 空一覧ではなく `requireSession()` でエラーにする（operator が
  typo に気づける）。finding ゼロの**実在** hitch は空一覧（エラーにしない）。
- 出力列: findingId / severity / lifecycleStatus / scopeStatus / category / summary（＋`--json` は HitchFinding
  full row）。`first_seen_at ASC, finding_id ASC` 順（listFindings の既定順）。
- 読み取り専用。状態遷移・副作用なし。

### テスト（G2）

- 複数 finding を持つ hitch で全件・`--open` 絞り込み・`--severity P1`・`--scope out-of-scope` が正しく出る。
- `--json` の形が HitchFinding と一致。
- finding ゼロの hitch で空一覧（エラーにしない）。

---

## G3 — #172: `hitch finding defer --classify-out-of-scope`

### 問題

`hitch finding defer` は finding が `in_scope` のままだと拒否される（`repository.ts:1052` /
`followups.ts:203` のガード: `scopeStatus !== "out_of_scope"` で throw）。プロセス系 advisory を defer するたびに
`classify --scope out-of-scope --reason` → `defer --reason` の 2 連打が要る。

### 変更

- `finding defer` に `--classify-out-of-scope` フラグを追加（`src/cli/hitch.ts:721-755`）。
- **【codex P1 反映】部分状態を防ぐため repository-level の単一トランザクション API を新設する。**
  現行 `deferFindingToBacklog()`（`src/hitch/followups.ts:78`）は `addBacklogItem()` が別 DB 接続で backlog row を
  作ってから finding を defer するため、「分類だけ済む / backlog item だけ残る」部分状態が起き得る。spec が
  当初書いた「同一トランザクション」は現 helper 構造では成立しない。
  - `HitchRepository`（または followups 層）に `classifyAndDeferFinding({ findingId, reason, toBacklog })` を追加し、
    **1 つの DB transaction 内**で `classifyFinding(out_of_scope)` → （`--backlog` 時）backlog row insert →
    `deferFinding` を atomically 実行。途中失敗は全 rollback。
  - **【codex P1 反映 (r2)】`--backlog` の直接 insert は `addBacklogItem()` の安全条件を継承する。**
    現行 `addBacklogItem()`（`src/core/backlog-db.ts:96`）は `assertNoLegacyRuntimeRows(db)`（legacy gate）を必ず通し、
    `:92` で file sequence floor を見て id を採番する。新 API が `BacklogRepository.insertItem()` を直接使うなら、
    **同一 transaction 内で legacy gate と id allocation floor を同様に適用**する（既存 backlog write より緩い経路を
    作らない）。可能なら既存 `addBacklogItem()` の内部ロジックを transaction-aware に切り出して共有する。
  - file export（backlog YAML）は **commit 後の best-effort**（export 失敗は warning、DB 状態は確定済み）。
  - `--classify-out-of-scope` 未指定時の挙動は不変（in_scope のままなら従来どおり拒否＝ガード維持）。
  - これは既存 2 操作の atomic 合成であり、新しい状態や緩和ではない（決定論的・harness 側ロジック）。
- `--reason` は既に defer の required option。classify にも同 reason を流用する。
- **安全境界**: severity / scope の判定根拠は引き続き operator 入力（`--scope out-of-scope` を明示的に指示）で
  あり、LLM 自己申告ではない。advisory の自動 allowlist 化（issue 提案の第3案）は**採らない**
  （「既知パターンを自動 out-of-scope」は判定の自動化＝安全側に倒れないため defer。本フラグは operator が
  明示的に out-of-scope と宣言する手間を 1 コマンドに畳むだけ）。

### テスト（G3）

- in_scope finding に `defer --classify-out-of-scope --reason X` → scope=out_of_scope かつ lifecycle=deferred。
- フラグ無しで in_scope finding を defer → 従来どおり拒否（ガード維持の回帰テスト）。
- `--backlog` との併用で backlog item も作られる。
- **atomic 性（codex P1）**: transaction 内のいずれかを失敗させ、classify も defer も backlog row も
  全て rollback される（部分状態が残らない）。export 失敗時は DB が確定しつつ warning が出る。

---

## G4 — #169 + #142: lifecycle audit 拡張（migration V29）＋ adopt-pr ＋ update

### migration V29（共有）

`hitch_lifecycle_events.event` の CHECK 制約は現在 `('reopened','closed','cancelled')`
（`src/db/schema.ts:1661`）。SQLite は CHECK 変更にテーブル再作成が要る（小テーブル）。

**【codex P1 反映】既存 V23 DDL の制約を完全維持し、`event` CHECK だけを拡張する。** 現行 V23
（`src/db/schema.ts:1658`）は `hitch_id ... ON DELETE CASCADE` / `reason TEXT NOT NULL` /
`created_by TEXT NOT NULL`。再作成 DDL でこれらを落とすと audit table の制約が緩み、hitch 削除時に
orphan event が残る回帰になる。

```sql
-- migration V29: hitch_lifecycle_events に 'pr_adopted' / 'updated' を許可（他制約は V23 と完全同一）
CREATE TABLE hitch_lifecycle_events_v29 (
  event_id    TEXT PRIMARY KEY NOT NULL,
  hitch_id    TEXT NOT NULL REFERENCES hitch_sessions(hitch_id) ON DELETE CASCADE,
  event       TEXT NOT NULL CHECK (event IN ('reopened','closed','cancelled','pr_adopted','updated')),
  reason      TEXT NOT NULL,
  detail_json TEXT,
  created_at  TEXT NOT NULL,
  created_by  TEXT NOT NULL
);
INSERT INTO hitch_lifecycle_events_v29
  SELECT event_id, hitch_id, event, reason, detail_json, created_at, created_by
  FROM hitch_lifecycle_events;
DROP TABLE hitch_lifecycle_events;
ALTER TABLE hitch_lifecycle_events_v29 RENAME TO hitch_lifecycle_events;
CREATE INDEX hitch_lifecycle_events_hitch_idx ON hitch_lifecycle_events(hitch_id, created_at);
```

- 既存行はそのまま移行（列同一）。`V23_TABLE_NAMES`（`hitch_lifecycle_events`）は rename で同名復帰のため不変。
- `reason NOT NULL` のため `pr_adopted` / `updated` も `--reason` を必須にする（両 CLI で required）。
- migration 実装時は `foreign_keys` pragma と再作成順（PRAGMA off → rebuild → on）の既存流儀に従う。
- `HITCH_LIFECYCLE_EVENTS`（`src/hitch/types.ts:128`）に `'pr_adopted'` / `'updated'` を追加。
- **migration 番号（要調整）**: 現行最新は V28。token-usage-expansion course（`course-cf320ded`、現在
  **ホールド中**だが G1 hitch 駆動足場が進行中）が untracked 設計で V29 を仮押さえしている。ただし migration は
  連番・gap 不可のため、**実装・merge が先に走った側が V29 を取り、後発は V30 へ rebase する**のが唯一整合的
  （未実装の V29 を飛ばして V30 を先に入れることはできない）。本バンドルは独立小規模で先行しやすいので、
  着手時点で `grep MIGRATION_V schema.ts | tail` の次番（=V29 想定）を確保し、token-usage 再開側が rebase する。
  どちらが先かが未確定なら G4 着手前に operator に確認する。

### #169 — `hitch adopt-pr`

operator takeover（diverging hitch を停止 → orchestrate 産 PR を close → 新ブランチ + 新 PR で置換）後、
harness 記録は放棄した旧 PR を指したまま（PR は `runs.pr_url`/`pr_number` にのみ存在、hitch session には PR 列が無い）。

- CLI: `hitch adopt-pr <hitch-id> <pr-url-or-number> --reason <text> [--created-by <actor>] [--json]`。
- repository: `adoptPr({ hitchId, prUrl, prNumber, reason, createdBy })` を追加。
  - lifecycle event `event='pr_adopted'` を insert。`detail_json = { adoptedPr: {url, number},
    supersededPr: {url, number} | null, runId: <latestRunId> | null }`。
  - 旧 PR は `latestRunId(hitchId)` → `runs.pr_url`/`pr_number` から解決し supersededPr に記録（あれば）。
  - **runs テーブルの pr は書き換えない**（run の実体は旧 PR を作った事実として残す＝監査保全）。
- **【codex P0 反映】adopt-pr は audit / status 表示専用とし、auto-merge には絶対に使わない（安全境界）。**
  `await-merge` は「表示」ではなく**実際に merge する**。現行 `closeAndPr`（`src/hitch/orchestrator-runners.ts:645`）は
  `latestRunId()` → `createPullRequest()` → reviewed head SHA pinning で安全を担保しているが、operator が
  adopt した外部 PR には reviewed head SHA / `pull_requests` 正本 / run との検証済み対応が無い。lifecycle event は
  docs 上も状態遷移・判定の source ではない（`docs/specs/hitch-convergence.md:272`）。よって:
  - `hitch status` の **表示**: 最新 `pr_adopted` があればそれを優先表示し、run 由来 PR は superseded と併記
    （監査の見える化。表示のみ）。
  - `await-merge` の **merge 対象解決**: adopted PR は **auto-merge 対象にしない**。`pr_adopted` を持つ hitch に
    対する `await-merge` は **fail-closed で拒否**し「adopted PR は human merge 専用。`hitch close --force` で
    記録上 close せよ」と案内する。harness が未検証 PR を自動 merge する経路を作らない。
  - （将来 adopted PR を auto-merge 対象にしたいなら、`adoptedPr.headSha` を取得・記録し
    `gh pr merge --match-head-commit` 相当で SHA 検証する独立設計が要る。本バンドルでは扱わず
    `docs/future-features.md` に defer。）
- 状態は変更しない（adopt-pr は記録のみ。close は別途 `hitch close --force --summary` で行う）。

### #142 — `hitch update`

`closeConditions` / `scope` / policy を start 後に変更する手段が無く、cancel + 再作成（phase link 貼り直し）しかない。

- CLI: `hitch update <id> [--close-file <path>] [--scope-file <path>] [--policy-file <path>]
  --reason <text> [--allow-scope-widen] [--allow-gate-loosen] [--created-by <actor>] [--json]`。
  - 1 つ以上の `--*-file` 必須（何も指定なしはエラー）。`--reason` 必須。
  - **【codex P2 反映 (r2)】`--allow-gate-loosen`** は policy/close-conditions の更新が close gate を緩める方向の
    ときに要求するフラグ（下記ガード参照）。CLI signature と repository 引数を一致させる。
- repository: `updateSessionConfig({ hitchId, scope?, closeConditions?, policy?, reason, allowScopeWiden,
  allowGateLoosen, createdBy })`。
  - scope-file/close-file/policy-file はそれぞれ既存 parser（`parseHitchScope` / `parseHitchCloseConditions` /
    policy parser）で検証してから適用。指定された列のみ更新（部分更新）。`updated_at` を bump。
  - lifecycle event `event='updated'` を insert。`detail_json = { updatedFields: [...],
    previousScope?, previousCloseConditions?, previousPolicy? }`。
- **scope freeze ガード（安全側）**:
  - **【codex P1 反映 (r1)】拡大判定は `targetFiles` / `targetOperations` だけでなく `allowedFindingCategories` /
    `excludedCategories` も含める。** allowed category の追加・excluded category の削除でも scope は実質広がる。
    `--allow-scope-widen` が無く、かつ新 scope が旧の subset であると**意味論的に証明できない**変更は
    保守的に widening 扱いで **拒否**（fail-closed）。理由を明示するエラー。
  - **【codex P1 反映 (r2)】`targetSummary` も拡大判定に含める。** `targetSummary` は in-scope 分類
    （`src/hitch/classification.ts:143` の `matchedTargetMention()` → `:238` で `session.scope.targetSummary` を
    照合）に実際に使われるため、追加・変更は scope を広げ得る。semantic subset を証明できない `targetSummary` 変更は
    widening 扱い。**非意味フィールドは `notes` のみ**とする。
  - scope の縮小、`notes` のみの変更、および close-conditions の更新は `--allow-scope-widen` 無しで許可。
  - **policy / close-conditions の更新が close gate を緩める**場合（command/finding_policy 等の必須条件を外す方向）も、
    安易なすり抜けを避けるため `--allow-gate-loosen` での明示を要求し、判定が曖昧なら保守的に拒否する
    （fail-closed）。判定詳細（どの変更を「緩和」とみなすか）は G4 着手時に policy/close-condition の意味論を
    確認して確定する。
- **状態ガード（fail-closed）**: 非終端状態（open / in_progress / close_ready）でのみ更新可。
  - **【codex P2 反映】**終端状態の案内は状態別に分ける。現行 reopen 可能なのは `closed` / `budget_exhausted` /
    `escalated` のみ（`src/hitch/repository.ts:366`）で、`cancelled` / `diverging` は reopen できない。よって
    `closed`/`budget_exhausted`/`escalated` では「`hitch reopen` してから update せよ」と案内、`cancelled`/`diverging`
    では「この状態は reopen 不可。cancel+再作成（diverging の reopen は別設計）」と正確に案内する。
- close 条件更新後、次の `check-convergence` が新条件で評価される（convergence は live 評価のため snapshot 不要）。

### テスト（G4）

- migration V29: 既存 lifecycle 行が移行され、`pr_adopted` / `updated` が insert 可能、旧 enum 値も維持。
  既存 vN→29 前方移行（migration テスト群の applied 配列追従）。
- `adopt-pr`: イベント記録、supersededPr の解決（run に PR がある/無い両方）、`hitch status` の表示が
  adopted PR を優先（superseded 併記）。**`pr_adopted` を持つ hitch への `await-merge` は fail-closed で拒否
  （codex P0 の自動 merge 回避）**。
- `update`: close-conditions のみ / scope 縮小 / policy 更新の各成功、`targetFiles`/`targetOperations` **および
  `allowedFindingCategories`/`excludedCategories`** の拡大が `--allow-scope-widen` 無しで拒否・有りで許可
  （codex P1）、close gate を緩める policy 更新の `--allow-gate-loosen` 要求、終端状態での状態別案内
  （closed系は reopen 案内 / cancelled・diverging は reopen 不可案内、codex P2）、何も指定なしのエラー、
  `updated` イベントの detail_json。

---

## ドキュメント追従（各サブ Phase の同コミット）

- `docs/specs/cli.md`: `backlog list/show`（DB 正本化の明記）、`hitch finding list`、`finding defer
  --classify-out-of-scope`、`hitch adopt-pr`、`hitch update` を追記。
- `docs/specs/db.md`: migration V29（lifecycle event enum 拡張）、backlog read が DB 正本である旨。
- `docs/specs/hitch-convergence.md`: status の PR 表示順（pr_adopted 優先・superseded 併記）、**adopted PR は
  auto-merge 対象外（await-merge は fail-closed 拒否）**、update による close 条件差し替えの扱い。
- `docs/future-features.md`: 「adopted PR の SHA 検証付き auto-merge」を defer として記録（codex P0 の将来案）。
- `docs/policy-semantics.md` 等は変更なし（policy 評価ロジック不変）。

## 完了の定義

- #177: `defer --backlog` 由来の DB 行が `backlog list`/`show` に出る。
- #170: `hitch finding list` で findingId/severity/lifecycle/scope/summary が一覧できる。
- #172: `defer --classify-out-of-scope` で 1 コマンド defer（in_scope ガードは未指定時維持）。
- #169: `hitch adopt-pr` で新 PR を**監査記録**し `hitch status` が実体（新 PR）を優先表示、旧 PR は superseded
  として保全。adopted PR は auto-merge 対象外（await-merge は fail-closed 拒否、human merge 専用）。
- #142: `hitch update` で close 条件/scope/policy を監査付きで差し替え、scope 拡大は fail-closed ガード。
- 関連テスト＋typecheck 緑（各サブ Phase）、最終フルスイート緑、回帰なし。
- 各 issue にバンドル PR を関連付け、close は merge 後。
