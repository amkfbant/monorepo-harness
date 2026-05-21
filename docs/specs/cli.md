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
| `--dry-run` | — | `false` | policy 解決のみ、JSON で標準出力、ファイル変更なし |

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
harness review list [--all] [--status <s>] [--domain <d>] [--limit <n>] [--json]
```

### Options

| Option | Required | 説明 |
|--------|:--------:|------|
| `--all` | — | 全ステータスを含める（`--status` を無視） |
| `--status <s>` | — | カンマ区切りの status filter（例: `needs_review,failed-policy-violation`）。指定時は default queue を置き換える |
| `--domain <d>` | — | 単一 domain に絞る |
| `--limit <n>` | — | 表示行数の上限（非負整数。不正値は exit 1） |
| `--json` | — | テーブルでなく JSON (`{ validRuns, invalidRuns }`) を出力 |

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
- `1`: `--limit` が非負整数でない

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

`changes_requested` の親 run を base に、`required_changes` を組み込んだ新しい run を起動する。

### Synopsis

```bash
harness rerun --from-review <parent-run-id>
```

### Options

| Option | Required | 説明 |
|--------|:--------:|------|
| `--from-review <id>` | ✅ | 親 run の識別子（`changes_requested` 状態である必要あり） |

### 動作

1. 親 `meta.json` + `review-decision.yaml` を読む
2. 親 status == `changes_requested` かつ decision == `changes_requested` かつ `required_changes` が 1 件以上であることを検証
3. 親 `codex-prompt.md` から元 goal を復元し、新 prompt を組み立てる:
   `<元 goal>` + `## Required changes from the previous review` + `required_changes` の bullet list
4. 親と同じ repo / domain / baseBranch で `harness run` 相当を実行
5. 新 run の `meta.parentRunId` に親 runId を記録

新 run は別 runId・別 branch・別 worktree。親は一切変更しない（監査用にチェーンを `meta.parentRunId` で辿れる）。

### rerun 後の再レビュー

`rerun` で生成された子 run は `needs_review` 状態で、**通常の run と全く同じ手順でレビューする**:

```bash
# 子 run を一覧で確認
harness review list

# reviewer agent または人間がレビュー
harness review auto --run-id <child-run-id>      # または review-decision.yaml を手編集
harness review process --run-id <child-run-id>

# まだ changes_requested なら再度 rerun (チェーンが伸びる)
harness rerun --from-review <child-run-id>
```

`meta.parentRunId` を辿ると `初回 run → rerun → rerun → …` の系譜が全て追える。各 run の `review-decision.yaml` / `summary.md` は run dir に残るので、「前回の required_changes が満たされたか」は子 run の diff と review で確認する。

### Exit code

- `0`: 新 run が `needs_review` などの非失敗 status で完了
- `1`: 親が `changes_requested` でない / decision 不一致 / `required_changes` 空 / `--from-review` が path-traversal / 新 run prompt が 64 KiB 超
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

## `harness knowledge promote`

`knowledge-candidates.yaml` の各候補を `docs/knowledge/<kind>/` 配下の md ファイルに展開する。

### Synopsis

```bash
harness knowledge promote --run-id <id> [--kind <kind>] [--out <dir>]
```

### Options

| Option | Required | 説明 |
|--------|:--------:|------|
| `--run-id <id>` | ✅ | 対象 run |
| `--kind <kind>` | — | 指定すると、その kind の候補だけ promote |
| `--out <dir>` | — | 出力 root（default `HARNESS_ROOT/docs/knowledge`） |

### 動作

各候補を `<out>/<kind>/<runId>-<idx>-<slug>.md` に書き出す。`kind` は単一セグメント名（path traversal ガード）。`slug` は Unicode 対応 + SHA-1 hash suffix。`knowledge-candidates.yaml` 自体は変更しない（audit）。`events.jsonl` に `knowledge_promoted` を追記。

### source run との独立性

promote された md は **`<out>/`（既定 `docs/knowledge/`）に書かれ、`runs/<runId>/` とは完全に独立**している。

つまり `harness cleanup --scope run` / `--scope all` で source run の `runs/<runId>/` が削除されても、**promote 済みの knowledge md は残る**。これは意図的な設計 — knowledge は run のライフサイクルより長く生きるべきもので、cleanup の対象外。

逆に、source run を消した後は md 内の `source run:` 参照が dangling になる（md には runId / source index / evidence が記録済みなので、内容自体は self-contained）。

### Exit code

- `0`: promote 成功（0 件含む）
- `1`: invalid runId / candidates yaml 不在 / parse 失敗 / 候補の `kind` が unsafe
- `2`: 予期しない例外

## 環境変数

| Variable | 解説 |
|----------|------|
| `HARNESS_ROOT` | harness の作業 root。`policies/`, `runs/`, `workspaces/`, `locks/` の親 |
| `HARNESS_CODEX_BIN` | codex 実行ファイルへのパス（default: `codex`） |

codex 子プロセスに渡る env は **`DEFAULT_CODEX_ENV_ALLOWLIST`** で制限される（`PATH / HOME / USER / SHELL / LANG / LC_ALL / TERM / TMPDIR / CODEX_HOME`）。`OPENAI_API_KEY` / `AWS_*` 等は伝播しない。必要なら `src/codex/codex-cli-runner.ts:DEFAULT_CODEX_ENV_ALLOWLIST` を編集する（policy からの動的注入は MVP では未実装）。

## 既存以外の subcommand

将来追加予定（MVP には無い）:

- `harness review process` 完了後の自動 `harness rerun` 連鎖（changes_requested → rerun → review を自動ループ）
- knowledge-candidate の confirmed ストアへの統合（現状 `knowledge promote` は md 書き出しまで）

これらは `docs/superpowers/plans/` 配下に計画 doc を作るタイミングで追加する。
