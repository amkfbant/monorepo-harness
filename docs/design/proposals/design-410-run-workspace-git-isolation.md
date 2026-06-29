# design-410 — run workspace の git 隔離（共有 .git/config 汚染の構造的封じ込め）

> 状態: **Phase 1 + Phase 2（clone capability）実装済み**（#410）。本書は「何をどう直すか」の
> 設計と AS-IMPLEMENTED の差分注記。実装は operator-direct（self-orchestrate は #410 当事者ゆえ
> 使わない）。残るのは self profile を `clone` に切替える follow-up と Phase 2.5（いずれも
> [`../../future-features.md`](../../future-features.md) に defer）。調査の全文は issue #410 のコメント参照。

## 問題（要約）

`hitch orchestrate --repo <target>` の run workspace は target の **`git worktree`**
（`src/workspace/git-worktree.ts:34-38`）で、target の実 `.git` **common-dir を共有**する。
作業ツリーは隔離されるが **git config 層は無隔離**で、`core.bare` 等 `core.*` は per-worktree でなく
共有 `<target>/.git/config` に集約される（`extensions.worktreeConfig` 未設定）。

worktree を cwd として走る無 sandbox の **allowed-command runner**（`src/core/command-runner.ts:223-244`、
seatbelt/landlock なし）が `npx vitest run`（self では harness 自身の git-heavy スイート）を実行すると、
worktree 内の git 操作が共有 `<target>/.git/config` に着弾し **`core.bare=true`** を立て、target 本体と
全 worktree を同時に fatal 化する（`fatal: this operation must be run in a work tree`）。実機で2度発生。

**敵対検証の確定事項**:
- `GIT_CONFIG_GLOBAL/SYSTEM=/dev/null` 等の env 隔離は **global/system scope のみ**。`core.bare` は
  **repo-LOCAL** config なので **env では決定論的に塞げない**（防御層にしかならない）。
- 共有 .git を物理的に断つ＝**workspace を worktree でなく独立 clone にする**のが唯一の構造的・決定論的修正。

## 修正方針（多層防御）

### Phase 1（実装する・bounded・即効の被害封じ込め）: core.bare ガード

env 隔離は #410 を塞がないため採らない。代わりに **target の `core.bare` 不変を run ライフサイクルで
fail-closed に守る**。これは「予防」でなく「検出 + 自動修復」だが、catastrophic な silent fatal を
決定論的に検出・回復し、operator の手修復を不要にする（実際に手修復が2回必要だった）。

- **配置**: `src/core/run-worktree-gc.ts`（既に run 開始時に best-effort で走る #404 GC の隣）。**実装済み**。
- **pre-run（実装済み・本 PR）**: `gcWorktreesBeforeRun` の **冒頭**（prune/reclaim より前。後段の
  git op が bare で fail するのを避けるため）で `repairCoreBareFlip` を呼ぶ。`git rev-parse
  --is-bare-repository` で検出し、`true` なら `git config core.bare false` で **修復して warn**。
  fail-closed: probe 失敗（"not a git repository" 以外）は warn、非 git path は静かに no-op、いずれも
  throw せず run を止めない。読み書きは `git-cli.ts` 経由。
- **不変条件テスト（実装済み）**: target の core.bare を人工的に flip → ガードが検出・`false` 修復することを pin
  （`tests/unit/core/repair-core-bare-flip.test.ts`・実 git mkdtemp・`--global` 無しで実 `~/.gitconfig` 非汚染）。
- 注: これは Phase 2 が入るまでの被害封じ込め。Phase 2 で根本が消えてもガードは安価な保険として残す。

#### Phase 1.5（follow-up・本 PR 外）: post-run 検出 + run 失敗化

pre-run 修復は「次 run 開始時」に効くため、汚染した run 自体は成功扱いになり得て、修復までの間は
operator の手動 git も fatal のまま。これを塞ぐには run 完了（成功/失敗/escalate いずれも）後に同
チェックを行い、`true` を検出したら `false` に戻し **run を `failed-workspace-corruption` 系に倒して
loud 記録**する（汚染を「成功」に偽装しない）。run-completion 経路への配線が要る（surface 増）ため
本 PR からは外し follow-up とする。

### Phase 2（**実装済み・capability**・構造的決定論修正）: clone-based workspace 隔離（opt-in）

run workspace を worktree でなく **独立 clone** にし、共有 .git/config を物理的に断つ。
ブラスト半径を抑えるため **project profile の opt-in フラグ**で、既定は現行 worktree（非 self は無影響）。

> **AS-IMPLEMENTED（capability・self profile の切替は follow-up）**: 既定 `worktree`／opt-in
> `clone` の配線を実装済み。現状仕様は spec が正本（[`../../specs/workspace.md`](../../specs/workspace.md)
> の「run workspace の隔離モード」節 / フィールドは [`../../specs/policy.md`](../../specs/policy.md) ・
> [`../../specs/project.md`](../../specs/project.md)）。設計時の候補から確定した点:
> - **作成**: `createCloneWorkspace`（`src/workspace/git-worktree.ts`）= `git clone --no-checkout
>   <target> <wtPath>` → origin を target の GitHub URL に `remote set-url`（target に origin
>   無しは warn+skip で fail-closed・push 段で loud fail）→ `checkout -b <branch> <baseSha>`。
>   object は git のローカル clone **hardlink** で共有（下記 `--reference` alternates 案は不採用＝
>   堅牢性優先・target の `gc` でも壊れない）。
> - **dispatch**: `createRunWorkspace`（同ファイル）が `policy.workspace.isolation` で分岐。既定
>   `worktree` は `createWorktree` をそのまま呼ぶ（非 self は byte 不変）。
> - **cleanup / #404 reclaim**: `workspaceGitKind`（`.git` が dir=clone / file=worktree / 不在=absent）
>   で FS 判別（schema 変更なし）。clone は `rm -rf`（`git worktree remove` は "not a working tree"
>   で失敗）・target 上の branch 削除はスキップ。`src/core/cleanup.ts`。
> - **push / PR**: origin 張替により無改修（`reviewed-branch-push.ts` / `pr-creator.ts`）。

- **profile schema**: `workspace.isolation?: "worktree" | "clone"`（既定 `"worktree"`）。
  self profile（`projects/monorepo-harness.yaml`）で `clone` を選ぶ。`src/policy/schema.ts` /
  project profile loader に追加。
- **workspace 作成**（`src/workspace/git-worktree.ts` / `src/core/workflow-runner-inner.ts:135-143`）:
  - `worktree` モード: 現行どおり `git worktree add`。
  - `clone` モード: `git clone <target> <wtPath>` で clone は **独自の `.git/config` を持つ**
    （`core.*` は clone ごと＝共有 config を物理的に断つ）。続けて base SHA を
    `git -C <wtPath> checkout -b <branch> <baseSha>`。
    **object 共有のトレードオフ**（config 隔離はどの形でも保たれる・選ぶのはディスク/堅牢性）:
    - `--reference <target>`（`--dissociate` 無し）= source の object を alternates 経由で**継続共有**
      してディスク節約。ただし source の prune/gc で壊れる脆さ（alternates 依存）。
    - `--reference <target> --dissociate` または素の `git clone <target>` = 必要 object を clone 側へ
      **取り込んで自己完結**（共有しない・堅牢・ディスク多め）。cleanup は clone dir の `rm -rf`。
    - 既定推奨は自己完結（堅牢性優先）。`--reference` の alternates は `assertNoObjectGraphTampering`
      が意図的に非ゲートゆえ採用しても安全（`reviewed-branch-push.ts:357-364`）。
- **push / PR の origin 再設定**（最大の破壊点）: clone の `origin` はローカル target path になり、
  `git push -u origin`（`reviewed-branch-push.ts:314` / `pr-creator.ts:475`）と `gh pr create` が
  GitHub に届かない。→ clone 作成直後に **`git -C <wtPath> remote set-url origin <target の GitHub origin URL>`**
  （`git -C <target> remote get-url origin` で取得）。認証は既存の gh/credential を継承。
- **cleanup / #404 GC の clone 対応**（`src/core/cleanup.ts:267-292,409-473` / `run-worktree-gc.ts`）:
  - `worktree` モード: 現行どおり `git worktree remove --force` + `branch -D` + prune。
  - `clone` モード: `git worktree remove` は「not a working tree」で失敗するため、**clone dir を `rm -rf`**。
    workspace の種別は metadata（run meta or workspace marker file）で判別。clone を消し損ねると
    フル repo が leak するので fail-closed に掃除する（worktree admin leak より重いリーク）。
- **continuation**: `materializeParentWork`（`workflow-runner-diff.ts:407-472`）は親→子の純コピーで
  clone 非依存。`gateContinuation`（`orchestrator-runners-continuation.ts`）は base を target で解決し
  親 path を existsSync するのみ＝clone でも親 clone dir を残せば動く（#404 reclaim が親を消さないよう順序に注意）。
- **agent-workspace 層**（`src/workspace/agent-workspace.ts`）も worktree 前提だが #410 のスコープ外。
  本 Phase は **run workspace 層のみ**に限定し、agent workspace は別途検討（不整合は doc 注記）。

### Phase 2.5（任意・深層）: `deny_write: .git/**` の実配線

現状 `deny_write: .git/**` は prompt 文言 + 事後 worktree diff のみで sandbox/command-runner に未配線
（共有 commondir は worktree 作業ツリー外＝diff 不可視）。command-runner / claude runner を
common-dir 書込不可の OS sandbox で走らせるか、実行前に commondir を read-only にする等。高コストゆえ defer。

## 回帰テスト（実 repo を汚染せず pin）

正本は **構造 pin**（verifier 3 設計）:
- `tests/integration/worktree-git-isolation.test.ts`（新規）。mkdtemp target + 実 `createWorktree`
  （`tests/integration/git-worktree.test.ts:15-26` に倣う）→ `runAllowedCommands`
  （`tests/unit/core/command-runner.test.ts` に倣う）に `git config core.bare true`（**`--global` 無し**＝
  tmp target の LOCAL config のみ・実 `~/.gitconfig` を触らない）を cwd=worktree で実行 →
  **`git -C <target> rev-parse --is-bare-repository` が `false` 不変**を assert。
  現行 worktree モードでは RED（共有 config が flip）→ **Phase 2 clone モードで GREEN**。
- **Phase 1 ガードの pin**: target の core.bare を flip → `gcWorktreesBeforeRun` 相当が検出・`false` 修復することを assert。
- 補助: 隔離 env が子に届く / `--global` 書込が isolated HOME 外に漏れない（HOME=mkdtemp）。
- 安全: 全 path を mkdtemp 配下、`env.HOME` は isolated tmpdir、`core.bare` repro は `--global` 無しに限定。

## ブラスト半径まとめ

| 変更 | 影響 | リスク |
|------|------|--------|
| Phase 1 core.bare ガード | `run-worktree-gc.ts` のみ | 低（検出+修復・既存 GC の隣） |
| Phase 2 clone（opt-in 既定 worktree） | `git-worktree.ts` / `workflow-runner-inner` / `cleanup` / `run-worktree-gc` / `reviewed-branch-push` / `pr-creator` / profile schema | 中〜高（push origin 再設定・cleanup 書換）。**非 self は既定 worktree で無影響** |
| Phase 2.5 deny_write 配線 | command/claude runner sandbox | 高（defer） |

## 推奨実装順

1. ✅ **Phase 1（core.bare ガード）land 済み**（即効の被害封じ込め・低リスク・self-orchestrate を再び安全寄りに）。
2. ✅ **Phase 2（clone 隔離）を opt-in で land 済み（capability）**（構造的決定論修正）。isolation テストで検証（self-orchestrate に依存しない）。
3. ⏳ **follow-up**: self profile を `workspace.isolation: clone` に切替 → self-orchestrate を復帰（本 capability とは別 PR・[`../../future-features.md`](../../future-features.md)）。
4. Phase 2.5（`deny_write: .git/**` 実配線）は backlog（同上）。
