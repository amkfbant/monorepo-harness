# Development reports

開発サイクルの成果と発見を、後から検索・参照できる形で保管するためのディレクトリ。

## 目的

- どの判断・修正がどのデータに基づいて行われたかを再現可能にする
- finding (F1, F7, …) を ID として src/test/docs から参照できるようにする
- 実機実験（codex run など API コストを伴うもの）の結果を一度きりで終わらせない

「設計書」「議事録」ではなく、**「実験ログ + 修正サイクルのスナップショット」** が主な内容。

## 命名規則

```
docs/reports/<YYYY-MM-DD>-<kind>-<slug>.md
```

| Component | 例 | 補足 |
|-----------|----|------|
| `YYYY-MM-DD` | `2026-05-20` | サイクル開始日 (UTC、ISO 形式) |
| `<kind>` | `mvp-validation` / `postmortem` / `design-review` / `security-review` / `milestone` / `incident` | 種類。新カテゴリは README に追記する |
| `<slug>` | `initial` / `followup` / `s3-lock-race` | 短い識別子。同日複数あっても区別できるように |

複数日にまたがる場合は **開始日** を使い、本文の `Date` フィールドに `2026-05-20 → 2026-05-22` のように範囲を書く。

## 何を report として残すか

YES:
- 実機 codex run / 大規模実験を伴うサイクル (cost をかけて得た知見)
- 本番に影響する判断（policy/threshold 変更、status enum 拡張、etc.）
- finding を伴う修正サイクル
- post-mortem / incident retrospective

NO:
- 設計書 → `docs/superpowers/plans/`
- 仕様書 → `docs/specs/`
- 自動生成される run artifact → `runs/<run-id>/`（report に貼り付けるのは抜粋のみ）
- 短い fix の commit message で済むもの

迷ったら **「半年後に自分が読み返したくなるか」** で判断。

## 構造

各レポートは `TEMPLATE.md` をコピーして書く。最低限必要なセクション:

- フロントマター (Date / Scope / harness commit range)
- 動機 / Trigger
- やったこと（per task / per scenario）
- Findings（ID 採番 + status）
- Test inventory（新規 / 既存）
- Commits in this cycle
- Next phase（未着手 todo）

Finding ID は **F1, F2, …** で連番。レポート間で連続させる（重複しない）。
新 ID を採番したら、本 README の "Finding registry" 表に追記する。

## Finding registry

レポートをまたいで finding ID の重複を防ぐためのインデックス。新規レポートで採番したら追記する。

| ID | サイクル | カテゴリ | ステータス | 元レポート |
|----|---------|----------|-----------|-----------|
| F1 | 2026-05-20 initial | P1 docs (minimatch semantics) | closed (docs) | `2026-05-20-mvp-validation-initial.md` |
| F2 | 2026-05-20 initial | info (codex self-refusal) | observed | `2026-05-20-mvp-validation-initial.md` |
| F3 | 2026-05-20 initial | P2 UX (stderr noise) | closed (filter) | `2026-05-20-mvp-validation-initial.md` |
| F4 | 2026-05-20 initial | info (knowledge signal) | closed (4 kinds) | `2026-05-20-mvp-validation-initial.md` |
| F5 | 2026-05-20 initial | info (review-request UX) | observed | `2026-05-20-mvp-validation-initial.md` |
| F6 | 2026-05-20 initial | info (worktree review) | observed | `2026-05-20-mvp-validation-initial.md` |
| F7 | 2026-05-20 followup | P1 detection (looksBinary) | closed (impl) | `2026-05-20-mvp-validation-followup.md` |
| F8 | 2026-05-21 phase2 | P0 workflow (post-command re-validation 抜け) | closed (impl) | `2026-05-21-phase2-review-commands-cleanup.md` |
| F9 | 2026-05-21 phase2 | P1 cleanup (branch 削除粒度) | closed (impl) | `2026-05-21-phase2-review-commands-cleanup.md` |
| F10 | 2026-05-21 phase2 | P1 cleanup (domain lock 取らず) | closed (impl) | `2026-05-21-phase2-review-commands-cleanup.md` |
| F11 | 2026-05-21 phase2 | P1 cleanup (runId/meta 検証なし) | closed (impl) | `2026-05-21-phase2-review-commands-cleanup.md` |
| F12 | 2026-05-21 phase2 | P2 cli (cleanup gate exit code) | closed (impl) | `2026-05-21-phase2-review-commands-cleanup.md` |

## Reports

| Date | Title | Highlights |
|------|-------|-----------|
| 2026-05-20 | [MVP validation — initial](2026-05-20-mvp-validation-initial.md) | mini-commerce での 7 シナリオ実機検証、F1〜F6 採番 |
| 2026-05-20 | [MVP validation — follow-up](2026-05-20-mvp-validation-followup.md) | F1/P2 fix + scenarios 8-10、F7 発見と修正 |
| 2026-05-21 | [Phase 2 — review/commands/cleanup](2026-05-21-phase2-review-commands-cleanup.md) | review processor + allowedCommands + cleanup CLI、codex review (gpt-5.5/xhigh) で F8-F12 発見&修正、mini-commerce で 5 シナリオ E2E 検証 |
| 2026-05-21 | [Phase 2-4 機能デモ](2026-05-21-phase2-4-feature-demo.md) | structured commands / reviewer agent / rerun / knowledge promote / cleanup --scope を mini-commerce 実機でデモ。reviewer agent は実機 codex で初検証。新 finding なし |
| 2026-05-21 | [Phase 2-5 review list デモ](2026-05-21-phase2-5-review-list-demo.md) | review list 拡張（--status/--domain/--limit/--json、壊れ run 分離）。codex review で P1×1+P2×3 を fix。E2-5-1〜5 実機検証、新 finding なし |
| 2026-05-21 | [Phase 2-6 reviewer agent robustness デモ](2026-05-21-phase2-6-reviewer-agent-robustness-demo.md) | review auto 異常系（error artifact / --allow-overwrite / --dry-run / 再帰 snapshot）。codex review で P1×2+P2×1 を fix。E2-6-1 で実機 prose 混入を検証、新 finding なし |
| 2026-05-21 | [Phase 2-7 rerun convergence デモ](2026-05-21-phase2-7-rerun-convergence-demo.md) | rerun 収束制御（rootRunId/rerunAttempt/--max-attempts/rerun chain）。codex review で P1×1+P2×1 を fix。E2-7-1 で 初回→changes_requested→rerun→review auto→approved の full E2E を実機検証、新 finding なし |
| 2026-05-21 | [Phase 2-8 post-command safety matrix デモ](2026-05-21-phase2-8-post-command-safety-matrix-demo.md) | command 副作用 9 シナリオ（scope外/secret/ignored/symlink/huge/binary 等）を T1-T7 で網羅 + events に stage。codex review で P2×2 を fix。E2-8-1/2/3 を実機検証、新 finding なし |
| 2026-05-21 | [Phase 2-9 knowledge promotion governance デモ](2026-05-21-phase2-9-knowledge-promotion-governance-demo.md) | knowledge list / reject / promote --reviewer、YAML frontmatter、(run,index)/hash 重複制御。codex review で P2×5 を fix（うち 1 件は contentHash の NUL バイト混入）。E2-9-1〜4 を実機検証、新 finding なし |
| 2026-05-21 | [Phase 2 close package](2026-05-21-phase2-close.md) | Phase 2 全体（2-1〜2-10）のクローズ。root README + Phase 2 quick start、全 close 条件チェック、E2-10 walkthrough、Phase 3 deferred items。`phase2-close` タグ |
| 2026-05-21 | [Phase 3-1 reviewed-run デモ](2026-05-21-phase3-1-reviewed-run-demo.md) | `harness workflow reviewed-run`（run→review auto→review process→rerun loop）。codex review で P1×1+P2×2 を fix。E3-1-1 を実機 ×2、E3-1-2〜5 は fake-codex 統合テストで担保。reviewer は goal 相対評価のため実機 cr 誘発は非再現（R5） |
| 2026-05-21 | [Phase 3-4 knowledge context デモ](2026-05-21-phase3-4-knowledge-context-demo.md) | `knowledge build-context` + `run --with-knowledge`。promoted knowledge を domain 別集約 → prompt 注入。codex review で P2×3 を fix。E3-4-1〜3 を実機検証、新 finding なし |
| 2026-05-21 | [Phase 3-2 reviewer evaluation デモ](2026-05-21-phase3-2-reviewer-evaluation-demo.md) | `review evaluate`（N 回サンプリング）/ `review compare`。codex review で P1×1+P2×1 を fix。known-bad run を 3 サンプル評価 → 3/3 非 approved、UNSTABLE 検出。新 finding なし |
| 2026-05-21 | [Phase 3-3 agent role separation デモ](2026-05-21-phase3-3-agent-role-separation-demo.md) | coder/reviewer/harness の role boundary 明文化、prompt template の名前+version 化、`meta.promptTemplate` 記録。codex review で P1×1+P2×3 を fix。E3-3-2/3 を実機検証、新 finding なし |
| 2026-05-21 | [Phase 3-5 SQLite index デモ](2026-05-21-phase3-5-sqlite-index-demo.md) | better-sqlite3 の run index（`index rebuild/status/show`、`review list --use-index`）。codex review で P1×1+P2×2 を fix。E3-5-1〜3 で rebuild / file scan 一致 / 破損回復を実機検証、新 finding なし |
| 2026-05-21 | [Phase 3-6 GitHub PR デモ](2026-05-21-phase3-6-github-pr-demo.md) | `harness pr create`（approved run → draft PR）。codex review で P1×2+P2×1 を fix。E3-6-1 で amkfbant/mini-commerce に draft PR #1 を実機作成（デモ後クローズ）、E3-6-2/3 で非 approved 拒否。新 finding なし |
| 2026-05-21 | [Phase 3 close package](2026-05-21-phase3-close.md) | Phase 3 全体（3-1〜3-6 + 3-8）のクローズ。10 項目の close 条件、CLI 一覧、codex review サマリ。Phase 3-7（stronger sandbox）は Deferred。`phase3-close` タグ |
| 2026-05-21 | [Phase 4-1 run show デモ](2026-05-21-phase4-1-run-show-demo.md) | `run show/timeline/artifacts`（1 run を read-only で一画面集約）。codex review で P2×3 を fix。E4-1-1〜6 を既存 runs/ で実機検証、新 finding なし |
| 2026-05-21 | [Phase 4-2 inbox デモ](2026-05-21-phase4-2-inbox-demo.md) | `harness inbox`（needs_review/cr/failed/cleanup/knowledge を集約 + action hint）。codex review で P2×3 を fix。E4-2-1〜6 を既存 runs/ で実機検証、新 finding なし |
| 2026-05-21 | [Phase 4-3 backlog デモ](2026-05-21-phase4-3-backlog-demo.md) | `harness backlog add/list/show/run/done/defer`（個人 backlog、run と双方向リンク）。codex review で P1×2+P2×3 を fix。E4-3-2 を mini-commerce 実機検証、新 finding なし |
| 2026-05-21 | [Phase 4-4 maintenance デモ](2026-05-21-phase4-4-maintenance-demo.md) | `harness maintenance check/cleanup`（stale lock / orphan worktree 等の検出・掃除）。codex review で P1×1+P2×2 を fix。E4-4-1〜5 を実機検証、新 finding なし |
| 2026-05-21 | [Phase 4-5 knowledge digest デモ](2026-05-21-phase4-5-knowledge-digest-demo.md) | `harness knowledge digest`（candidate/promoted/rejected を期間・domain 別集計）。codex review で P2×3 を fix。E4-5-1〜4 を既存 runs/ で実機検証、新 finding なし |

## Workflow

1. **新しいレポートを始める時**
   - `cp docs/reports/TEMPLATE.md docs/reports/$(date -u +%Y-%m-%d)-<kind>-<slug>.md`
   - フロントマターを埋める
2. **作業中**
   - Finding を見つけたら次の連番（registry の最大 + 1）で採番
   - 修正コミットには finding ID を含める (`fix(...): … (F7 from scenario 10)`)
3. **完了時**
   - Findings registry を更新
   - Reports 索引に 1 行追加
   - `git add docs/reports/*.md` してコミット
4. **後で参照する時**
   - finding ID を grep: `grep -rn "F7" docs/ src/ tests/`
   - サイクル全体: 本 README からリンクを辿る
