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

## 環境変数

| Variable | 解説 |
|----------|------|
| `HARNESS_ROOT` | harness の作業 root。`policies/`, `runs/`, `workspaces/`, `locks/` の親 |
| `HARNESS_CODEX_BIN` | codex 実行ファイルへのパス（default: `codex`） |

codex 子プロセスに渡る env は **`DEFAULT_CODEX_ENV_ALLOWLIST`** で制限される（`PATH / HOME / USER / SHELL / LANG / LC_ALL / TERM / TMPDIR / CODEX_HOME`）。`OPENAI_API_KEY` / `AWS_*` 等は伝播しない。必要なら `src/codex/codex-cli-runner.ts:DEFAULT_CODEX_ENV_ALLOWLIST` を編集する（policy からの動的注入は MVP では未実装）。

## 既存以外の subcommand

将来追加予定（MVP には無い）:

- `harness review process --run-id <id>` — review-decision.yaml を読んで status を `approved` / `changes_requested` / `rejected` に遷移
- `harness cleanup --run-id <id>` — `approved` / `rejected` の run の worktree + branch + run dir を削除
- `harness knowledge promote --run-id <id> --kind <kind>` — knowledge-candidate を確定 knowledge file に昇格

これらは `docs/superpowers/plans/` 配下に計画 doc を作るタイミングで追加する。
