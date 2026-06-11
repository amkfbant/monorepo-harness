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
- **status**: 全 workspace の進捗を決定論ラベル（`stale` / `goal-missing` / `blocked` /
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
