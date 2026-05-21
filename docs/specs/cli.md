# CLI reference

実装: `src/cli/run.ts`。commander v12 ベースの subcommand 構成。

## エントリーポイント

```bash
HARNESS_ROOT=<harness-dir> npm run --silent harness -- <subcommand> [opts]
```

- `HARNESS_ROOT` は省略時 `process.cwd()`。`policies/`, `runs/`, `workspaces/`, `locks/` の起点
- `HARNESS_CODEX_BIN` で codex 実行ファイルを差し替え可（default: `codex`）

## `harness run` (default subcommand)

domain-coding workflow を 1 回実行する。

### Synopsis

```bash
harness run \
  --repo <target-repo-path> \
  --repo-id <id> \
  --domain <subdir> \
  --goal <text> \
  [--base-branch <name>] \
  [--keep-worktree] \
  [--dry-run]
```

### Options

| Option | Required | Default | 説明 |
|--------|:--------:|---------|------|
| `--repo <path>` | ✅ | — | target repo のパス（絶対 or 相対） |
| `--repo-id <id>` | ✅ | — | `policies/repos/<id>.yaml` を特定する識別子。`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` でなければ reject |
| `--domain <subdir>` | ✅ | — | repo policy 内の domain key（例: `apps/catalog`） |
| `--goal <text>` | ✅ | — | codex に渡す task 説明。stdin 経由で渡される |
| `--base-branch <name>` | — | `main` | 差分の基準。`git rev-parse --verify` で SHA に解決 |
| `--keep-worktree` | — | `false` | （MVP では no-op。worktree は常に保持） |
| `--with-knowledge` | — | `false` | `docs/knowledge-context/<domain>.md` を codex prompt に注入（Phase 3-4）。事前に `knowledge build-context` が必要 |
| `--knowledge-context <path>` | — | — | 注入する knowledge-context ファイルを明示指定（`--with-knowledge` より優先） |
| `--dry-run` | — | `false` | policy 解決のみ、JSON で標準出力、ファイル変更なし |

`--with-knowledge` / `--knowledge-context` を使うと、prompt 末尾に「Relevant knowledge from past runs」section が追加され、`meta.knowledgeContext = { enabled, contextFile }` と events の `knowledge_context_loaded` に記録される。注入されるのは **promote 済み knowledge のみ**（candidate / rejected / deprecated は対象外 — [`harness knowledge build-context`](#harness-knowledge) 参照）。

### Exit code

- `0`: workflow が正常完了し、final status が `needs_review`
- `1`: workflow が result として `failed-policy-violation` / `failed-codex` / `failed-codex-timeout` / `failed-diff-collection` / `failed-command` を返した
- `2`: harness 自体の例外。`failed-internal-error` で meta を finalize した後 rethrow されたケース、policy load / lock acquire 等の throw もここに含む

(`generated` / `verified` は workflow 内部の中間 status。external observer から見える最終 status は `needs_review` または `failed-*`。)

### Stdout 末尾

```
run=<runId> status=<RunStatus> safetyStatus=<SafetyStatus> ignoredUntrackedCount=<n> secretSuspectCount=<n>
```

例:
```
run=run-20260520-apps-catalog-mpe3vgb9e3b0a532 status=needs_review safetyStatus=allowed ignoredUntrackedCount=0 secretSuspectCount=0
```

### Dry-run の出力

```bash
$ HARNESS_ROOT=$PWD npm run --silent harness -- run \
  --repo /Users/kn/dev/mini-commerce --repo-id mini-commerce \
  --domain apps/catalog --goal noop --dry-run

resolved policy for apps/catalog:
{
  "repoId": "mini-commerce",
  "domain": "apps/catalog",
  "read": [...],
  "write": ["apps/catalog/**"],
  "denyWrite": [...],
  "allowedCommands": [],
  "ignoreUntracked": ["**/node_modules/**", "**/dist/**", ...],
  "codex": { "sandbox": "workspace-write", "timeoutMs": 900000, "approval": "on-request" },
  "limits": { "gitTimeoutMs": 30000 }
}
```

policy ファイルの編集後に確認するのが典型用途。

## `harness workflow reviewed-run`

`run → review auto → review process → (changes_requested なら rerun)*` を bounded workflow として 1 コマンドで束ねる（Phase 3-1）。各ステップは既存の `run` / `review auto` / `review process` / `rerun` を順に呼ぶだけで、状態遷移は引き続き harness が行う。

### Synopsis

```bash
harness workflow reviewed-run \
  --repo <path> --repo-id <id> --domain <domain> --goal <text> \
  [--base-branch <name>] [--reviewer-name <name>] [--max-attempts <n>] \
  [--stop-on-changes-requested] [--no-auto-review] [--dry-run]
```

### Options

| Option | Required | 説明 |
|--------|:--------:|------|
| `--repo` / `--repo-id` / `--domain` / `--goal` | ✅ | `harness run` と同じ |
| `--base-branch <name>` | — | default `main` |
| `--reviewer-name <name>` | — | `review auto` の reviewer identity |
| `--max-attempts <n>` | — | root run から数えた retry 上限（default 2） |
| `--stop-on-changes-requested` | — | 最初の `changes_requested` で rerun せず停止 |
| `--no-auto-review` | — | coder run のみ実行し `needs_review` で停止（人間レビュー用） |
| `--dry-run` | — | policy を解決して終了 |

### 動作

1. attempt 0: `run` → `needs_review`（失敗系なら即停止）
2. `review auto`（read-only sandbox の codex）→ `review-decision.yaml`
3. `review process` → `approved` / `changes_requested` / `rejected`
4. `changes_requested` かつ attempt < `--max-attempts` なら `rerun` して 2 へ。`parentRunId` / `rootRunId` / `rerunAttempt` は維持される
5. 停止条件で finalStatus を確定

### finalStatus

| finalStatus | 意味 |
|-------------|------|
| `approved` | 成功 |
| `rejected` | reviewer が reject |
| `changes_requested` | `--stop-on-changes-requested` で停止 |
| `not_converged` | `--max-attempts` まで `changes_requested` が続いた |
| `needs_review` | `--no-auto-review` で停止 |
| `review-auto-failed` | `review auto` が unusable な output（`review-auto-error.json` が残る） |
| `failed-*` | coder run が失敗（rerun しない） |

### artifact

root run の dir に workflow-level artifact を残す:

- `runs/<rootRunId>/workflow.json` — `{ workflow, rootRunId, attempts[], finalStatus, maxAttempts }`
- `runs/<rootRunId>/workflow-summary.md` — attempt 一覧の表

### Exit code

- `0`: finalStatus が `approved`
- `1`: それ以外の finalStatus（`not_converged` / `rejected` / `failed-*` / `review-auto-failed` / `--max-attempts` 不正値 等）
- `2`: 予期しない例外

## `harness lock list`

active な domain lockfile を全表示。

```bash
harness lock list
```

出力例:
```
apps-catalog.lock	runId=run-20260520-apps-catalog-…	pid=12345	host=hostA	acquiredAt=2026-05-20T13:36:41.301Z
apps-orders.lock	runId=run-20260520-apps-orders-…	pid=12346	host=hostA	acquiredAt=2026-05-20T13:38:25.050Z
```

unreadable な lockfile（JSON 壊れ、permission denied 等）も:
```
broken.lock	status=unreadable	error=Unexpected token in JSON at position 1
```

の形で 1 行ずつ表示する（運用デバッグ用）。

ロックが 1 つもなければ `no locks` と出力。

### Exit code

- `0`: 常に（lock 0 件でも 0）

## `harness lock release`

特定 domain の lockfile を削除する。crash 後の手動 recovery 用。

```bash
harness lock release --domain <subdir> [--run-id <id>] [--force]
```

### Options

| Option | Required | 説明 |
|--------|:--------:|------|
| `--domain <subdir>` | ✅ | 対象 domain（例: `apps/catalog`） |
| `--run-id <id>` | — | 指定した場合、lockfile の runId と一致する時だけ削除 |
| `--force` | — | runId mismatch / lockfile unreadable でも削除を強行 |

### 動作

1. `locks/<domain-slug>.lock` が存在しなければ `no lock for domain <subdir>` と表示、exit 0
2. lockfile を JSON parse:
   - 失敗 + `--force` なし → throw（`unreadable; rerun with --force to delete anyway`）
   - 失敗 + `--force` あり → 強制削除
3. `--run-id` 指定あり:
   - lock.runId と一致 → 削除
   - 一致せず + `--force` なし → throw (`runId mismatch: lock has X, requested Y`)
   - 一致せず + `--force` あり → 強制削除
4. 削除成功時:
   ```
   released <domain-slug>.lock (<lockfile-path>)
   ```

### Exit code

- `0`: 削除成功 or lock 不在
- `2`: 引数 / parse / mismatch エラー（throw 経路）

### 典型用途

```bash
# crash で残った lock をまず list
harness lock list

# 自分の runId を指定して安全に release
harness lock release --domain apps/catalog --run-id run-20260520-apps-catalog-xxxxx

# stale lock を強制 release
harness lock release --domain apps/catalog --force
```

## `harness review list`

すべての `runs/<id>/meta.json` を読み、テーブル（または JSON）で表示する。default は **review queue**（`needs_review` + `changes_requested`）。

### Synopsis

```bash
harness review list [--all] [--status <s>] [--domain <d>] [--limit <n>] [--json] [--use-index]
```

### Options

| Option | Required | 説明 |
|--------|:--------:|------|
| `--all` | — | 全ステータスを含める（`--status` を無視） |
| `--status <s>` | — | カンマ区切りの status filter（例: `needs_review,failed-policy-violation`）。指定時は default queue を置き換える |
| `--domain <d>` | — | 単一 domain に絞る |
| `--limit <n>` | — | 表示行数の上限（非負整数。不正値は exit 1） |
| `--json` | — | テーブルでなく JSON (`{ validRuns, invalidRuns }`) を出力 |
| `--use-index` | — | `runs/` を走査せず SQLite index から読む（Phase 3-5）。filter/sort/limit は file scan と同一ロジック。index が無ければ exit 1 |

### Output（table）

タブパディングされた fixed-column table:

```
runId                                    domain        status        safety   reviewer  parent  commands  secrets  ignored  startedAt
run-20260521-apps-catalog-mpf297pn...   apps/catalog  needs_review  allowed  -         -       3/3       0        0        2026-05-21T05:00:00Z
run-20260521-apps-orders-mpf2lhm...     apps/orders   needs_review  allowed  -         mpf2gz  2/2       -        0        2026-05-21T05:30:00Z
```

- 新しい順 (`startedAt` desc) でソート
- runId は **truncate しない**（コピペで `--run-id` 引数に使える）
- 列: runId / domain / status / safety / reviewer / parent (parentRunId) / commands (`ok/total`) / secrets / ignored / startedAt
- 値が無いセルは `-`。command を実行していない run は commands 列が `-`
- valid run が 0 件なら `no runs` を stdout に出す

### Output（--json）

```json
{
  "validRuns": [
    {
      "runId": "run-20260521-apps-catalog-mpf297pn59dba39f",
      "domain": "apps/catalog",
      "status": "needs_review",
      "safetyStatus": "allowed",
      "reviewer": null,
      "reviewedAt": null,
      "parentRunId": null,
      "commandSummary": { "ok": 3, "total": 3 },
      "changedFilesCount": 2,
      "secretSuspectCount": 0,
      "ignoredUntrackedCount": 0,
      "startedAt": "2026-05-21T05:00:00Z",
      "finishedAt": "2026-05-21T05:02:00Z"
    }
  ],
  "invalidRuns": [
    { "runId": "run-20260521-broken", "error": "meta.json invalid JSON: ..." }
  ]
}
```

### 壊れた run dir の扱い

`meta.json` が無い / JSON parse 失敗 / `meta.runId` がディレクトリ名と不一致の run は **invalid** として扱う:

- table モード: invalid run は表に出さず、stderr に `warning: N unreadable run dir(s) hidden …` を出す。`--all` 指定時は各 invalid run の理由も stderr に列挙
- `--json` モード: `invalidRuns[]` に分離（stdout の JSON は常に valid）

### Exit code

- `0`: 正常（0 件 / invalid run があっても 0）
- `1`: `--limit` が非負整数でない / `--use-index` で index が未構築

## `harness index`

`runs/` を走査する代わりに一覧・検索を高速化する **SQLite index**（Phase 3-5）。

```bash
harness index rebuild        # runs/ 全走査から index を再構築
harness index status         # index の状態（件数 / 再構築時刻 / サイズ）
harness index show --run-id <id>   # 1 run の indexed row を表示
```

### source of truth は `runs/` files

**index は派生キャッシュであり source of truth ではない。** source of truth は常に `runs/<runId>/` のファイル群。index（`<HARNESS_ROOT>/.harness/index.sqlite`）が壊れても・消えても `harness index rebuild` で `runs/` から完全に再生成できる。`review list --use-index` は index が古い可能性があるため、run を追加したら rebuild する運用。

### DB 導入方針

- DB を source of truth にしない。run artifacts 全文を DB に入れない（Phase 3-5 非目標）
- index は `runs/` の meta.json から導出できる値のみを持つ（`runs` / `invalid_runs` / `index_meta` テーブル）
- `index rebuild` は db ファイルを削除して作り直す（破損からの確実な回復）
- `review list --use-index` の filter / sort / limit は file scan と**同一の `applyListFilters`** を通すため、index が最新なら結果は file scan と一致する

### Exit code

- `0`: 成功
- `1`: `index show` で runId が index に無い / index が未構築

## `harness pr create`

approved な run を GitHub の **draft pull request** にする（Phase 3-6）。

```bash
harness pr create --run-id <approved-run-id> [--base <branch>] [--title <text>] [--no-draft]
```

| Option | Required | 説明 |
|--------|:--------:|------|
| `--run-id <id>` | ✅ | 対象 run（`status=approved` でなければ拒否） |
| `--base <branch>` | — | PR の base branch（default `main`） |
| `--title <text>` | — | PR タイトル（default は runId + domain から生成） |
| `--no-draft` | — | draft でなく ready な PR を作る（default は draft） |

### 動作

1. `meta.status` が `approved` であることを確認（`needs_review` / `changes_requested` / `failed-*` / PR 作成済みは拒否、exit 1）
2. run の worktree（`workspaces/<runId>/repo`）が残っていることを確認（cleanup 済みなら拒否）
3. worktree の codex 変更を run branch（`meta.runBranch`）に commit
4. run branch を target repo の `origin` に push
5. `gh pr create --draft --base <base> --head <runBranch>` で PR 作成。本文に goal / runId / domain / safetyStatus / commands / reviewer などの run summary を含む
6. `meta.json` に `prUrl` / `prNumber` を保存、`events.jsonl` に `pr_created` を追記

### 前提（GitHub 設定）

- `gh` CLI がインストールされ、`gh auth login` で認証済み（`repo` scope が必要）。`HARNESS_GH_BIN` で実行ファイルを上書き可
- **target repo に GitHub の `origin` remote が設定済み**であること（`git -C <target-repo> remote add origin git@github.com:<owner>/<repo>.git`）
- target repo の base branch（`main` 等）が GitHub 側に push 済みであること（PR の base が無いと作成できない）
- harness は target repo の `origin` にそのまま push する。fork ではなく直接 push できる権限が前提

### Exit code

- `0`: PR 作成成功
- `1`: status != approved / PR 作成済み / worktree 不在 / runBranch 不明 / git push 失敗 / `gh` 失敗 / invalid runId
- `2`: 予期しない例外

## `harness review process`

`runs/<runId>/review-decision.yaml` の `decision` を読み、`meta.status` を遷移させる。

### Synopsis

```bash
harness review process --run-id <id>
```

### Options

| Option | Required | 説明 |
|--------|:--------:|------|
| `--run-id <id>` | ✅ | 対象 run の識別子 |

### 動作

1. `runs/<runId>/meta.json` を読み込み (`status` must be `needs_review`)
2. `runs/<runId>/review-decision.yaml` を読み込み (`decision` must be `approved` / `changes_requested` / `rejected`)
3. runId と domain が meta.json と一致することを check
4. `reviewed_at` が `null` なら現在時刻で auto-fill して yaml に書き戻し
5. `meta.json` の `status` / `reviewer` / `reviewedAt` を更新
6. `events.jsonl` に `review_processed` event を追記

### Output

```
[warning: …]
run=<runId> needs_review → approved reviewer=alice reviewedAt=2026-05-20T12:00:00Z
```

reviewer が null の場合、`warning: reviewer field is null` を stdout に出力するが exit code は 0。

### Exit code

- `0`: 処理成功（reviewer null 警告含む）
- `1`: ユーザが解決可能な refusal（`ReviewGateError`）
  - `decision: pending` のまま
  - current `meta.status` が `needs_review` 以外
  - runId / domain mismatch
  - review-decision.yaml が読めない / YAML or schema parse fail
  - meta.json が読めない / JSON parse fail / run directory 不在
- `2`: 上記以外の予期しない例外（disk full, programming bug など）

`harness cleanup` の exit code と同じ規約。`automation` で「retry しない」分岐は `1`、再試行検討は `2`。

### 典型用途

```bash
# reviewer が review-decision.yaml を編集後
$EDITOR runs/run-20260520-apps-catalog-xxx/review-decision.yaml
harness review process --run-id run-20260520-apps-catalog-xxx
```

## `harness cleanup`

approved / rejected 後の run の worktree / branch / run dir を `--scope` 単位で削除する。

### Synopsis

```bash
harness cleanup --run-id <id> [--force] [--scope workspace|run|all]
```

### Options

| Option | Required | 説明 |
|--------|:--------:|------|
| `--run-id <id>` | ✅ | 対象 run の識別子 |
| `--force` | — | `needs_review` / `failed-*` / `verified` / `generated` を強制 cleanup（**`changes_requested` と `running` には効かない**） |
| `--scope <scope>` | — | `workspace`（default）/ `run` / `all`。下記参照 |

### scope

| scope | 削除対象 | meta |
|-------|---------|------|
| `workspace` (default) | worktree + branch + 空になった `workspaces/<runId>/` | `meta.status` を `cleaned` に更新、run dir は audit のため保持 |
| `run` | workspace の対象 + `runs/<runId>/` 全体 | run dir ごと削除（meta 更新は無し、削除自体が記録） |
| `all` | run の対象 + `git worktree prune`（target repo の stale worktree bookkeeping を一掃） | 同上 |

デバッグに worktree を残したい場合は `--scope workspace`、完全に片付ける場合は `run` / `all`。

### 動作

1. `runs/<runId>/meta.json` を読み込み・検証
2. domain lock を取得（`harness run` / `harness review process` と排他）
3. ステータスごとの判定:
   - `approved` / `rejected` → cleanup 続行
   - `cleaned` → no-op で exit 0
   - `running` → 拒否（active run）
   - `changes_requested` → **`--force` でも拒否**（retry の base なので、一度 `rejected` に手動変換してから削除）
   - その他 (`needs_review` / `failed-*` / `verified` / `generated`) → `--force` 必須
4. worktree (`workspaces/<runId>/repo/`) が存在すれば `git worktree remove --force` で削除
5. 対応する run branch を独立に `git branch -D`（失敗時は throw）
6. scope に応じて run dir 削除 / `meta.status` 更新 + `cleaned` event 追記

### Output

```
run=<runId> scope=workspace previousStatus=approved worktreeRemoved=true branchRemoved=true runDirRemoved=false
```

### Exit code

- `0`: 削除成功、または `cleaned`/`approved`/`rejected` 状態で no-op
- `1`: status が cleanup 対象外（`changes_requested` / `running` / `--force` なしの中間 status）、または `--scope` の値が不正
- `2`: meta.json が読めない、git worktree remove が失敗するなど

### 典型用途

```bash
# review approved 後の cleanup (worktree だけ消す、記録は残す)
harness review process --run-id run-X       # → approved
harness cleanup --run-id run-X              # scope=workspace (default)

# 失敗 run を完全に片付ける
harness cleanup --run-id run-Y --force --scope run
```

## `harness rerun`

`changes_requested` の親 run を base に、`required_changes` を組み込んだ新しい run を起動する。`rerun chain` サブコマンドで再実行系譜を表示できる。

### Synopsis

```bash
harness rerun --from-review <parent-run-id> [--max-attempts <n>]
harness rerun chain --run-id <id>
```

### Options（`rerun --from-review`）

| Option | Required | 説明 |
|--------|:--------:|------|
| `--from-review <id>` | ✅ | 親 run の識別子（`changes_requested` 状態である必要あり） |
| `--max-attempts <n>` | — | chain root から数えた retry 上限（正整数、default 2）。子の `rerunAttempt` がこれを超えると拒否 |

### 動作（`rerun --from-review`）

1. 親 `meta.json` + `review-decision.yaml` を読む
2. 親 status == `changes_requested` かつ decision == `changes_requested` かつ `required_changes` が 1 件以上であることを検証
3. chain bookkeeping を計算: `rootRunId` = 親の `rootRunId`（無ければ親自身）、`rerunAttempt` = 親の `rerunAttempt` + 1
4. `rerunAttempt` が `--max-attempts` を超えるなら拒否（収束しない chain を止める）
5. 親 `codex-prompt.md` から元 goal を復元し、新 prompt を組み立てる:
   `<元 goal>` + `## Required changes from the previous review`（previous run / rerun attempt / reviewer / `required_changes` bullet list）
6. 親と同じ repo / domain / baseBranch で `harness run` 相当を実行
7. 新 run の `meta.parentRunId` / `rootRunId` / `rerunAttempt` を記録

新 run は別 runId・別 branch・別 worktree。親は一切変更しない。

### 収束ルール

| 条件 | 挙動 |
|------|------|
| 親 status != `changes_requested`（`cleaned` / `failed-*` / 不在 含む） | 拒否（exit 1） |
| `review-decision.yaml` の `required_changes` 空 | 拒否（exit 1） |
| `rerunAttempt` > `--max-attempts` | 拒否（exit 1）。「chain が収束していない、手動レビューせよ」 |
| 親の `required_changes` が祖父の `required_changes` と同一 | **warning（stderr）**。前回の rerun が feedback に対応できていないシグナル。実行自体は継続 |

`--max-attempts 2`（default）の場合: original + 2 reruns = 計 3 run まで。3 回目の rerun（attempt 3）で拒否。

### rerun 後の再レビュー

`rerun` で生成された子 run は `needs_review` 状態で、**通常の run と全く同じ手順でレビューする**:

```bash
harness review list                              # 子 run を確認
harness review auto --run-id <child-run-id>      # reviewer agent / または手編集
harness review process --run-id <child-run-id>
harness rerun --from-review <child-run-id>       # まだ changes_requested なら再度
```

### `harness rerun chain`

任意の run を起点に、再実行系譜（root → 子孫）をツリー表示する。`parentRunId` リンクを辿るので、`rootRunId` を持たない旧 rerun でも機能する。

```bash
$ harness rerun chain --run-id run-20260521-apps-orders-c2
run-20260521-apps-orders-root  changes_requested
└─ run-20260521-apps-orders-c1  changes_requested (attempt 1)
   └─ run-20260521-apps-orders-c2  approved (attempt 2)
```

| Option | Required | 説明 |
|--------|:--------:|------|
| `--run-id <id>` | ✅ | chain 内の任意の run |

### Exit code

- `0`: 新 run が `needs_review` などの非失敗 status で完了 / `chain` が表示成功
- `1`: 親が `changes_requested` でない / decision 不一致 / `required_changes` 空 / `--from-review` 不在 or path-traversal / `--max-attempts` 超過 or 不正値 / 新 run prompt が 64 KiB 超 / `chain` の runId 不正 or 不在
- `2`: 予期しない例外

## `harness review auto`

reviewer agent。codex を **read-only sandbox** で呼び、run artifacts を読ませて `review-decision.yaml` を機械生成する。

### Synopsis

```bash
harness review auto --run-id <id> [--reviewer-name <name>] [--allow-overwrite] [--dry-run]
```

### Options

| Option | Required | 説明 |
|--------|:--------:|------|
| `--run-id <id>` | ✅ | 対象 run（`needs_review` 状態） |
| `--reviewer-name <name>` | — | `review-decision.yaml.reviewer` に刻む名前（default `codex-reviewer`） |
| `--allow-overwrite` | — | `review-decision.yaml` が既に非 `pending`（人間 or 過去の agent verdict）でも上書きする |
| `--dry-run` | — | codex を呼んで output を検証するが `review-decision.yaml` は **書かない** |

### 動作

1. `review-decision.yaml` を読む。非 `pending` decision が入っていて `--allow-overwrite` 未指定なら **codex を呼ぶ前に** reject（人間/過去 agent の verdict 保護）
2. `runs/<runId>/` を cwd に、`sandbox=read-only` で codex を起動
3. codex は `review-request.md` / `summary.md` / `final-diff.patch` / `untracked-*` / command logs を読み、fenced YAML block を出力
4. codex 実行前後で run dir のファイル (size + mtime) を snapshot 比較し、`reviewer-agent.*.log` / `review-auto-error.json` 以外が変化していたら reject（read-only sandbox の二重防御）
5. YAML を strict にパース（不明 decision / 非 string entry / `changes_requested` で `required_changes` 空 → 全て output error）
6. `--dry-run` 未指定なら `review-decision.yaml` を上書き、stale な `review-auto-error.json` を削除

**`harness review auto` は status を遷移させない。** 生成された `review-decision.yaml` を人間が確認し、`harness review process` で適用する 2 段構成。

### 保証範囲（review auto が守ること）

- **review-decision.yaml を壊さない**: codex output が invalid（prose-only / malformed YAML / 不明 decision 等）の場合、`review-decision.yaml` は一切触らない。検証は parse → strict schema の順で、書き込みは検証通過後のみ
- **read-only**: codex は read-only sandbox。さらに run dir の全ファイルを snapshot し、`reviewer-agent.*.log` / `review-auto-error.json` 以外が変化したら reject（sandbox 誤設定の二重防御）
- **status を変えない**: meta.json の status 遷移は `review process` のみが行う
- **冪等でない上書き保護**: 非 `pending` decision は `--allow-overwrite` なしには上書きされない

### invalid output 時

codex output が invalid だった場合:

- `review-decision.yaml` は変更しない
- `runs/<runId>/review-auto-error.json` に構造化エラー（reason / rawOutputPath / codexExitCode / timedOut）を書き出す（`--dry-run` 時は書かない）
- `reviewer-agent.out.log` / `err.log` は codex の生 output として残る
- exit 1

### 検証状況・限界

- 実機 codex での**正常系**は検証済み（`docs/reports/2026-05-21-phase2-4-feature-demo.md` D2、`2026-05-21-phase2-6-reviewer-agent-robustness-demo.md` E2-6-1）。codex は fenced YAML block を返し `extractYamlBlock` でパース成功
- prose 混入 / invalid decision / malformed YAML / artifact 改竄 / overwrite gate / dry-run の**異常系は unit + integration test で担保**（`tests/unit/core/reviewer-agent.test.ts`、`tests/integration/cli-review-auto.test.ts`）
- **限界**: review auto は reviewer agent の verdict の**品質**は保証しない。あくまで「壊れた output で harness が壊れない」「verdict を人間が確認するまで status は動かない」ことを保証する。最終判断は `review process` 前に人間が行う想定

### Exit code

- `0`: review-decision.yaml 生成成功（`--dry-run` 時は検証成功）
- `1`: invalid runId / status != needs_review / 非 `pending` decision を `--allow-overwrite` なしで上書き試行 / codex 非ゼロ or timeout / YAML パース不能 / 不明 decision / artifact 改竄検出
- `2`: 予期しない例外

## `harness review evaluate`

reviewer agent を**同じ run に対して N 回**走らせ、verdict のばらつきを観測する（Phase 3-2）。観測ツールであり、run 自身の `review-decision.yaml` や `meta.status` は一切変更しない。

```bash
harness review evaluate --run-id <id> [--samples <n>] [--reviewer-name <name>]
```

| Option | Required | 説明 |
|--------|:--------:|------|
| `--run-id <id>` | ✅ | 対象 run |
| `--samples <n>` | — | reviewer サンプル数（default 3、正の整数） |
| `--reviewer-name <name>` | — | reviewer identity |

各サンプルを `runs/<runId>/review-evaluations/eval-NNN/`（`review-decision.yaml` or `review-auto-error.json` + `reviewer-agent.*.log`）に保存し、`review-evaluations/evaluation-summary.md` に decision 分布・comment 数・**danger flag**（`safetyStatus=denied` / `secretSuspectCount>0` の run を `approved` したサンプル）をまとめる。invalid output のサンプルは `invalid` として記録され、他サンプルは継続する。

### `harness review compare`

2 つの `review-decision.yaml`（典型的には人間 vs agent）を比較する。

```bash
harness review compare --human <path> --agent <path>
```

decision 一致 / 不一致と各 comment 配列の件数差を report する。decision 不一致なら exit 1。

### reviewer quality の限界

- `review evaluate` は verdict の**一致率 / ばらつき**を観測するだけで、どの verdict が「正しい」かは判定しない。最終判断は人間
- danger flag は `safetyStatus` / `secretSuspectCount` という**機械的シグナルとの突き合わせ**のみ。コードの実質的な誤りを検出するわけではない
- reviewer agent は **goal 相対**でレビューする（Phase 3-1 の観察）。goal が不完全な実装を許容していれば、不完全な提出も approve され得る
- サンプル数を増やすほど codex API コストが線形に増える

## `harness knowledge`

run が生成した `knowledge-candidates.yaml` の候補をレビューし、採用したものを `docs/knowledge/<kind>/` に昇格する。**誰が・なぜ・どの候補を**昇格／却下したかを記録する。

データモデル:

- `runs/<runId>/knowledge-candidates.yaml` — run が生成した **immutable な観測ログ**（harness は一切書き換えない）
- `runs/<runId>/knowledge-decisions.yaml` — reviewer の **reject 決定 sidecar**（`knowledge reject` が書く）
- `docs/knowledge/<kind>/*.md` — reviewer が **採用した知見**（`knowledge promote` が書く）
- `docs/knowledge-context/<domain>.md` — domain ごとに集約した **次回 run 用 context**（`knowledge build-context` が書く、Phase 3-4）

### `harness knowledge build-context`

promote 済み knowledge を domain 単位で 1 ファイルに集約し、`harness run --with-knowledge` で注入できる形にする（Phase 3-4）。

```bash
harness knowledge build-context --domain <domain> [--out <dir>]
```

| Option | Required | 説明 |
|--------|:--------:|------|
| `--domain <domain>` | ✅ | 対象 domain（例 `apps/catalog`） |
| `--out <dir>` | — | knowledge root（default `HARNESS_ROOT/docs/knowledge`） |

`docs/knowledge/<kind>/*.md` を走査し、frontmatter の `domain` が一致しかつ `deprecated: true` でないものを `docs/knowledge-context/<domain-slug>.md`（`/`→`-`）に集約する。candidate（`knowledge-candidates.yaml`）と rejected（`knowledge-decisions.yaml`）は `runs/` 配下にあり走査対象外 — **構造上 promote 済み knowledge しか集約されない**。

**knowledge injection の限界:**
- context は `build-context` 実行時点の snapshot。promote / deprecated 編集の後は再生成が必要（自動更新しない）
- context は domain 完全一致でフィルタするだけ。関連 domain / 親 domain の知見は引かない。ベクトル検索や関連度ランキングは無い
- `deprecated` は frontmatter を人間が手編集して立てる（`knowledge deprecate` コマンドは未実装）
- context md 全体を prompt 末尾に追加するだけ。件数が多いと prompt が肥大する（domain 単位での件数制御は運用判断）
- 注入は coder run のみ。reviewer agent には注入しない

### `harness knowledge list`

候補を governance status 付きで一覧する。

```bash
harness knowledge list --run-id <id> [--kind <kind>] [--domain <domain>] [--out <dir>]
```

各候補の status:
- `rejected` — `knowledge-decisions.yaml` に reject 決定がある
- `promoted` — `docs/knowledge/<kind>/<runId>-<idx>-*.md` が存在する
- `candidate` — どちらでもない

### `harness knowledge reject`

候補に reject 決定を記録する（`knowledge-candidates.yaml` は不変、決定は sidecar に）。

```bash
harness knowledge reject --run-id <id> --index <n> --reviewer <name> --reason <text>
```

`--reason` は **必須**（空文字列も不可）。「なぜ却下したか」を残すのが governance の目的のため。

`knowledge-decisions.yaml` に `{ index, decision: rejected, reviewer, reason, decidedAt }` を追記し、`events.jsonl` に `knowledge_rejected` を残す。reject された候補は以降の `promote` で skip される。

### `harness knowledge promote`

候補を `<out>/<kind>/<runId>-<idx>-<slug>.md` に展開する。

```bash
harness knowledge promote --run-id <id> --reviewer <name> [--kind <kind>] [--allow-duplicate] [--out <dir>]
```

| Option | Required | 説明 |
|--------|:--------:|------|
| `--run-id <id>` | ✅ | 対象 run |
| `--reviewer <name>` | ✅ | 各 md の frontmatter `promoted_by` に刻まれる |
| `--kind <kind>` | — | その kind の候補だけ promote |
| `--allow-duplicate` | — | 同一 content hash が既存でも md を作る |
| `--out <dir>` | — | 出力 root（default `HARNESS_ROOT/docs/knowledge`） |

各 md は **YAML frontmatter** を持つ:

```md
---
kind: policy_violation
domain: "apps/catalog"
title: "Codex wrote outside the domain scope"
source_run: run-20260521-...
source_index: 0
confidence: "high"
source_status: "candidate"
promoted_by: "knkn"
promoted_at: "2026-05-21T09:00:00.000Z"
hash: 2e9910abcd1234ef
---

# Codex wrote outside the domain scope
...
```

**重複制御:**
- 同じ `(source run, candidate index)` が既に promote 済み（`<runId>-<idx>-*.md` が存在）→ skip（`promote` は冪等）
- 同じ `content hash`（kind+domain+title+content の SHA-256）の md が既存 → skip。`--allow-duplicate` で上書き作成可
- reject 済み候補 → skip
- `--kind` 不一致 → skip

`promote` の出力は promoted 一覧と skip 一覧（理由つき: `kind-filter` / `rejected` / `duplicate-index` / `duplicate-hash` / `malformed`）。

### source run との独立性

promote された md は `<out>/`（既定 `docs/knowledge/`）に書かれ、`runs/<runId>/` とは**完全に独立**している。

`harness cleanup --scope run` / `--scope all` で source run の `runs/<runId>/` が削除されても、**promote 済みの knowledge md は残る** — knowledge は run のライフサイクルより長く生きる設計。md には runId / source_index / evidence が記録済みなので self-contained（`source_run` 参照は監査用であり存在保証ではない）。

### Exit code（list / reject / promote 共通）

- `0`: 成功
- `1`: invalid runId / candidates yaml 不在 or parse 失敗 / 候補の `kind` が unsafe / reject の index 範囲外 / reviewer 空
- `2`: 予期しない例外

### Exit code

- `0`: promote 成功（0 件含む）
- `1`: invalid runId / candidates yaml 不在 / parse 失敗 / 候補の `kind` が unsafe
- `2`: 予期しない例外

## 環境変数

| Variable | 解説 |
|----------|------|
| `HARNESS_ROOT` | harness の作業 root。`policies/`, `runs/`, `workspaces/`, `locks/`, `.harness/` の親 |
| `HARNESS_CODEX_BIN` | codex 実行ファイルへのパス（default: `codex`） |
| `HARNESS_GH_BIN` | GitHub `gh` CLI のパス（default: `gh`、`harness pr create` で使用） |

codex 子プロセスに渡る env は **`DEFAULT_CODEX_ENV_ALLOWLIST`** で制限される（`PATH / HOME / USER / SHELL / LANG / LC_ALL / TERM / TMPDIR / CODEX_HOME`）。`OPENAI_API_KEY` / `AWS_*` 等は伝播しない。必要なら `src/codex/codex-cli-runner.ts:DEFAULT_CODEX_ENV_ALLOWLIST` を編集する（policy からの動的注入は MVP では未実装）。

## 既存以外の subcommand

将来追加予定（MVP には無い）:

- `harness review process` 完了後の自動 `harness rerun` 連鎖（changes_requested → rerun → review を自動ループ）
- knowledge-candidate の confirmed ストアへの統合（現状 `knowledge promote` は md 書き出しまで）

これらは `docs/superpowers/plans/` 配下に計画 doc を作るタイミングで追加する。
