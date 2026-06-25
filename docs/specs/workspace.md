# Agent workspaces

複数の LLM エージェント / ターミナルが**同一プロジェクトを並行作業**するための、
エージェントごとの**隔離 git worktree** を管理するレイヤー。各エージェントは独立した
作業ツリー（独立 index / HEAD）を `agent/<name>` ブランチ上に持ち、共有 checkout を
取り合わない。harness の state（`HARNESS_ROOT` / `.harness` DB・domain ロック・hitch・
knowledge）は**共有**したまま協調できる。

実装: `src/workspace/`（`agent-workspace.ts` = git-only / `workspace-reconcile.ts` /
`workspace-status.ts` / `workspace-conflicts.ts` / `workspace-hitch-link.ts` /
`workspace-status-builder.ts`）、DB は `src/db/repositories/workspaces.ts`。

> **ステータス: 現状仕様（0.3.0）。** コマンドの確定仕様は [`cli.md`](./cli.md) の
> `harness workspace` 節、MCP tool は [`mcp.md`](./mcp.md)、DB テーブルは
> [`db.md`](./db.md) を正本とする。本ファイルは概念・安全モデル・ライフサイクルを
> まとめ、各 spec へ relay する overview。

---

## 何を解決するか

「複数ターミナルで同じ repo を開いて LLM を起動し、同一プロジェクトを並行作業」を
**素手の git で**やると、共有 checkout の index / HEAD / 作業ツリーを取り合って衝突する。
harness の **run 層は並行安全**（run ごとに `workspaces/<runId>/repo/` の隔離 worktree を
切る）だが、**人間 / エージェントが直に編集する作業ツリー**は別物で、ここが衝突源だった。

agent workspace は、エージェントごとに `git worktree` で**独立した作業ツリー**を与えて
この衝突を消す。一方で `.harness` DB（domain ロック・hitch・knowledge・operation 監査）は
共有するので、**隔離（作業ツリー）と協調（harness state）を両立**する。

---

## 安全モデル（§0 非対称 — 不可侵）

[`GOAL_RULES.md`](../../GOAL_RULES.md) §G / `AGENTS.md` と同じ非対称をこの層でも貫く。

- **git が worktree 存在の source of truth。** DB（`workspaces` テーブル）は worktree の
  ミラーではなく、harness 側の**協調メタ**（objective / advisory hitch link / heartbeat /
  checkpoint）だけを持つ。worktree が消えたかは常に live git に問う（DB drift しない）。
- **checkpoint の narrative は advisory（非権威）。** 「何をしたか / 次の一手」は人間 /
  LLM の自己申告であり、**状態遷移や next-steps の根拠にしない**。recover の next-steps は
  **git（inspect）＋ linked hitch の `ConvergenceService` 判定だけ**から決定論的に導出し、
  narrative は文脈として重ねるのみ。
- **path-first 解決。** workspace の同定は **agent 名ではなく正規化した worktree path**。
  名前衝突（別 path の stale 行が同名 agent を持つ）で別 workspace のメタを誤付与しない。
  `adopt` 時に **1 path 1 agent / 1 agent 1 worktree** を強制。
- 迷ったら安全側（停止・除外・`stale` 表示）に倒す（fail-closed）。未解決の git や未知の
  hitch decision は `blocked` / `base-unknown` 等で**握りつぶさず可視化**する。

### 共有 DB domain lock と fencing

run 層と course-pass 層は同じ `.harness` DB の `domain_locks` lease を共有する。
lock handle は `heartbeat()`（lease 延長）に加えて、`assertHeld()`（延長しない検証）を
持つ。`assertHeld()` は `lock_id` / `holder_run_id` / `released_at IS NULL` /
`expires_at > now` を DB で確認し、lease が released / expired / replaced の場合は
`LeaseGuardFailedError` として fail-closed する。

状態遷移や write の直前 fencing はこの DB 検証を使う。course-pass の phase CAS
(`pending -> in_progress`) は `assertHeld()` 成功後に実行され、さらに同じ lease 条件を
単一 `UPDATE` の `EXISTS` 述語に畳み込む。`changes=0` の場合は lease 述語だけを再評価し、
lease 喪失なら `LeaseGuardFailedError`、lease 保持中の status mismatch なら通常の CAS miss
として扱う。dry-run / plan パスは lease を取らず write もしない。run 層の write は従来どおり
`assertActiveLease` で `runs.lease_lock_id` と active `domain_locks` 行を照合する。

一時的な lock / lease 衝突（`DomainLockBusyError`, `LeaseLostError`,
`LeaseGuardFailedError`、および `RunFinalizedError` の cause がこれらの場合）は
「他プロセスが同じ domain を作業中」という停止条件であり、hitch を `escalated` にしない。
hitch coder runner はこの場合、作成済み attempt を no-op として discard し、iteration /
rerun budget を消費しない。

---

## レイアウトと同定

- **ブランチ**: `agent/<name>`（convention）。`adopt` した worktree は任意ブランチ可。
- **ディレクトリ**: 既定 `<repo>.agents/<agent>`（repo の sibling。`--dir` で変更可）。
- **canonical repo key**: `git rev-parse --git-common-dir` の realpath。main worktree でも
  agent worktree でも同じ repo を指すので、DB 行は repo 横断で一意に紐づく。
- **branch/HEAD は常に live git から hydrate**（DB の値が stale でも reconcile が live を採る）。
- **2 レイヤーの worktree**: agent workspace（人間 / エージェントが編集・`agent/<name>`）と、
  run 内部の worktree（`workspaces/<runId>/repo/`・codex 実行用）は**別物**。
  reconcile / list / status は run 内部 worktree と main checkout を除外する。
- **run 開始時の stale worktree GC（#404）**: `createWorktree` の直前に `pruneWorktrees`
  （`git worktree prune`）を **best-effort** で実行し、作業 dir が消えた stale admin entry を
  回収する。run worktree の作業 dir が `git worktree remove` を経ずに消えると（crash / 中断
  された cleanup）project の実 `.git/worktrees/` に entry が残り、放置すると蓄積して repo を
  degrade させる（git 操作の劣化・`core.bare` 化の遠因）。`prune` は作業 dir が存在する live
  worktree を消さないので安全、prune 失敗は run を止めない（warn して続行）。
- **run 開始時の terminal worktree 回収（#404 follow-up）**: prune の直後に
  `reclaimTerminalRunWorktrees`（`src/core/cleanup.ts`）を best-effort で実行し、同 repo の
  **terminal run（`approved` / `rejected`）の worktree（作業 dir が残っているもの）**を
  `removeWorktree` + `recordCleanup`（status → `cleaned`）で回収する。`prune` が回収できない
  「作業 dir が残ったまま手動 cleanup されていない」leak を断つ。安全性: run の branch/worktree は
  **local 限定**（PR があれば remote に push 済み）なので local branch 削除は open PR に影響しない。
  `changes_requested`（retry base ＝ continuation source）と非 terminal run（running/generated/
  verified/needs_review）は**対象外**。run DB handle を再利用し（managed-DB の二重 open なし）、
  1 run の失敗は記録してスキップ（run を止めない・並行 status 変化は `recordCleanup` の
  StateConflict で当該 run をスキップ）。

## symlink 可能な FS が前提（#68）

`git worktree` と worktree 上の依存インストール（uv venv・`node_modules/.bin`）は POSIX
symlink を作る。**WSL の 9p/drvfs マウント（`/mnt/*`）など symlink 不可の FS** 上では
`symlink(2)` が `EPERM` を返し、深部で cryptic な errno として失敗する。worktree 作成
（run 内部 = `createWorktree`／agent workspace = `createAgentWorkspace`）は、**worktree が
実際に置かれるディレクトリ**（run は `worktreesDir`・agent は `workspacesDir`）を作成直前に
`assertSymlinkCapable`（`src/workspace/fs-preflight.ts`）で probe し、不可なら FS を名指し＋
「Linux ネイティブ FS（例 `~/ops/...`）で実行せよ」と remediation を示して **fail-fast** する。
元インシデントは **repo の sibling に作られる agent workspace** が `/mnt/d` 上で踏んだもので、
repoPath と HARNESS_ROOT が別 FS のケースを捕捉するため両経路で probe する。EPERM 以外の
probe 失敗は block しない（既知の symlink-EPERM に限定した早期警告）。

---

## ライフサイクル

```
 create / adopt ──▶ (work) ──▶ checkpoint ──▶ status / conflicts / inspect ──▶ recover ──▶ remove
   作成 / 既存登録      編集        save(任意)        観測 / 衝突 pre-check / ブリーフィング   復旧      削除
```

- **create**: `agent/<name>` worktree を作る（冪等・`--base` 既定 HEAD）。共有手順
  （`cd <path> && export HARNESS_ROOT=<sharedRoot>`）を表示し、`workspaces` index にも記録。
- **adopt**: harness が作っていない**既存 worktree** を agent として登録（main / detached は
  拒否・path 重複は拒否）。手動 `git worktree add` を後付け追跡する入口。
- **checkpoint**: advisory narrative ＋ その時点の決定論スナップショット（HEAD sha /
  dirty 数）を append-only に保存。`--hitch` で advisory hitch link、`--objective` で目的設定。
- **status**: 全 workspace の進捗を決定論ラベル（`stale` / `hitch-missing` / `blocked` /
  `needs-work` / `ready-to-close` / `in-progress` / `dirty` / `base-unknown` / `ahead` /
  `behind` / `clean`）で一覧。**heartbeat staleness**（`--stale-after` 既定 24h）で放置
  agent を `⚠idle` 検出。
- **conflicts**: 各 workspace の変更集合（committed-ahead ∪ uncommitted）の**重複を事前検出**。
  「並行 agent はあまり同じファイルを触らない」前提を検証可能にする。
- **inspect**: git だけから決定論ブリーフィング（branch / HEAD / ahead-behind / dirty）を再構成。
- **recover**: inspect（git）＋ hitch convergence から状態を再構成し**決定論的 next-steps** を提示。
  クラッシュ / 再開した LLM が「保存した理解を信じる」のでなく真を取り戻すための復旧口。
- **remove**: worktree ＋ ブランチ ＋ DB 行を掃除（未コミット変更は `--force` 無しで拒否）。
- **verify-pr**（#82）: PR head を **detached（ブランチ非占有）worktree** にチェックアウトして検証する。
  run worktree が PR ブランチ（`harness/<runId>/<domain>`）を占有していると `gh pr checkout <n>` が
  `fatal: '<branch>' is already used by worktree` で失敗するため、ブランチを使わない detached HEAD で
  回避する。`harness workspace verify-pr <n> [--repo <path>] [--remote origin] [--rm]`: `origin` の
  `refs/pull/<n>/head`（**GitHub origin 前提**）を **PR 専用 local ref**（`refs/harness/verify-pr/<n>`・
  共有 `FETCH_HEAD` を使わないので並行 verify-pr が衝突しない）に fetch し、agent workspace と同じ dir
  （既定 `<repo>.agents/verify-pr-<n>/repo`）に detached worktree を作る。**read-only は運用約束**
  （detached worktree は物理的には書ける）。`--rm` で同 PR の検証 worktree を削除（作りっぱなし防止）。
  `createDetachedWorktree` は #68 の symlink preflight も通す。

---

## hitch との連携（auto-link）

`harness hitch orchestrate --repo <path>` が agent worktree（`agent/<name>` か adopt 済み・
サブディレクトリでも `git rev-parse --show-toplevel` で root 解決）で走ると、run 後に
その workspace を hitch に **best-effort で自動リンク**し heartbeat を更新する。これで
`workspace status` が「どの agent がどの hitch を回しているか」を自己申告抜きで反映する
（main worktree は除外・失敗しても orchestration を止めない）。詳細は [`cli.md`](./cli.md) の
`hitch orchestrate` 節。

---

## MCP

read-only な coordination view と低リスク mutation を MCP tool でも公開する（[`mcp.md`](./mcp.md)）。

- **`harness.workspace.list`**（read）— DB index の coordination view（agent / branch /
  worktree path / linked hitch とその decision / objective / heartbeat / last checkpoint）。
  git state は含まない。`allowedProjects` で scope。
- **`harness.workspace.status`**（read）— 1 repo 分の **git-inclusive** status（CLI `status` と
  同形）。`repoPath` は追跡中の worktree path（またはその subpath）で、未知 path で git を
  実行しない DB-first ガード。`allowedProjects` 外の path は「未 track」と同一エラーで弾く。
- **`harness.workspace.checkpoint`**（mutation）— advisory checkpoint の保存（guarded-mutation
  ＋ allowlist ＋ project scope ＋ operation 監査・冪等）。
- **`harness.workspace.inspect` / `.conflicts` / `.recover`**（read）— git-inclusive な
  ブリーフィング / 衝突 pre-check / 復旧 next-steps（`workspace.status` と同じ DB-first
  ガード・read-only git・`allowedProjects` で scope）。

git の**破壊的**操作を要する mutating（create / remove）は**現状 CLI 専用**。

---

## DB テーブル（[`db.md`](./db.md) が正本）

- **`workspaces`**（v17・additive）— agent / repo key / branch / worktree path / status /
  advisory hitch link / objective / heartbeat。
- **`workspace_checkpoints`**（v18・append-only）— checkpoint の narrative ＋ 決定論
  スナップショット（head sha / dirty 数）。`workspaces` への FK（ON DELETE CASCADE）。

どちらも additive migration。既存 hitch / run データには無影響。

---

## 並行運用（運用ガイド）

ターミナルごとに `harness workspace create <agent>` で隔離 worktree を切り、表示された
`HARNESS_ROOT` を**全エージェントで共有**する。これで素手 git の共有作業ツリー衝突を
避けつつ、domain ロック / hitch / knowledge を協調できる。並行安全モデルの全体像は
[`workflow.md`](./workflow.md) の concurrency 節を参照。
