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

2 つのモードがある: **`--repo` + `--repo-id`**（従来の policy file 経由）と
**`--project`**（Phase 5 の project profile 経由、[`project.md`](./project.md)）。
`--domain` / `--goal` は両モードで必須。

| Option | Required | Default | 説明 |
|--------|:--------:|---------|------|
| `--repo <path>` | repo-id モードで必須 | — | target repo のパス（絶対 or 相対）。`--project` 時は profile の `repo.path` を上書きする任意 override |
| `--repo-id <id>` | repo-id モードで必須 | — | `policies/repos/<id>.yaml` を特定する識別子。`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` でなければ reject |
| `--project <id>` | project モードで必須 | — | `projects/<id>.yaml`（project profile）。policy は profile から compile される（Phase 5） |
| `--domain <subdir>` | ✅ | — | domain key（例: `apps/catalog`） |
| `--goal <text>` | ✅ | — | codex に渡す task 説明。stdin 経由で渡される |
| `--base-branch <name>` | — | profile の `base_branch`、無ければ `main` | 差分の基準。`git rev-parse --verify` で SHA に解決 |
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

## `harness project`

Project Abstraction 層（Phase 5）。任意の repo を **project profile**
（`projects/<id>.yaml`）として定義し、profile から policy を compile して実行する。
データモデルは [`project.md`](./project.md)。

```bash
harness project inspect --repo <path> [--registry <id>] [--json]
harness project init --repo <path> --project-id <id> [--dry-run|--write] [--force] [--json]
harness project init --from-policy <repo-id> --project-id <id> [--repo <path>] [--dry-run|--write]
harness project check --project <id> [--repo <override>] [--json]
harness project show --project <id> [--json]
```

| サブコマンド | 動作 |
|--------------|------|
| `inspect` | target repo を静的に走査（Codex 不使用）し、domain registry と照合して候補 domain を提案。決定論的出力 |
| `init` | profile を生成。`--repo` で repo を inspect、`--from-policy` で既存 `policies/repos/<id>.yaml` を移行。`--dry-run`（既定）は policy proposal を表示し書き込みなし。`--write` で `projects/<id>.yaml` + 生成 `policies/repos/<id>.yaml` + provenance サイドカー `<id>.generated.json` を安全書き込み（既存があれば `--force` 必須） |
| `check` | Codex を起動せず profile / repo layout / 生成 policy / glob / commands / context pack / drift を検査。`ok` / `warn` / `error` に分類。config error で exit 1 |
| `show` | profile を表示 |

`harness run --project <id>` / `harness workflow reviewed-run --project <id>` は
profile を compile して実行する。生成 policy は既存 `RepoPolicySchema` をそのまま
満たすため、`harness run --repo-id <id>` でも同じ policy を使える（後方互換）。

### Exit code

- `0`: 成功（`check` は `ok` / `warn`）
- `1`: project error（profile schema 不正 / repo 不在 / `check` の `error` / 上書き拒否 など）
- `2`: 予期しない例外

## `harness backlog`

やりたいことを harness 管理下に積み、run と紐づける個人 backlog（Phase 4-3）。

```bash
harness backlog add --title <t> --domain <d> --goal <g> [--priority high|medium|low] [--tags a,b] [--project <id>]
harness backlog list [--status open|doing|done|deferred] [--project <id>] [--repo-id <id>] [--json]
harness backlog show --item-id <id>
harness backlog run --item-id <id> --repo <path> --repo-id <id> [--workflow run|reviewed-run] [--base-branch <name>] [--max-attempts <n>]
harness backlog done --item-id <id>
harness backlog defer --item-id <id>
```

- item は `backlog/<status>/item-YYYYMMDD-NNN.yaml`（status = open / doing / done / deferred、ディレクトリが status の source of truth）。`backlog/` は harness root 直下、gitignore 対象
- `backlog run` は item の domain + goal で run を起動（default `reviewed-run`、`--workflow run` で単発 run）。完了後、item の `linkedRuns` に runId を追記し item を `doing` へ移動する
- link は **backlog 側（item の `linkedRuns`）にのみ**保持する。run の meta.json は patch しない（並行 review/cleanup と競合しないため）。`harness run show` は backlog を走査し `linkedRuns` に当該 runId を含む item を逆引きして表示する
- `backlog list --project` / `--repo-id`（Phase 6）は DB read model 経由で絞る（指定時は files から DB を再構築してから集計）。`--status` は scoped path でも効く。scope 無しは従来の file-based 一覧
- `backlog run` は item に `projectId` があれば project mode で起動（`--repo-id` は不要）、無ければ `--repo` + `--repo-id` 必須（Phase 6-1）

## `harness db`

DB read model + DB-first write path（`.harness/harness.sqlite`）の管理。詳細は
[`db.md`](./db.md)。

```bash
harness db init                       # DB を作成し schema を適用
harness db migrate                    # 未適用 migration を適用
harness db status                     # schema version / table 数 / path / size
harness db stats                      # table 別行数 / DB・WAL サイズ / blob 総量
harness db import --from-files        # files から read model を構築
harness db import --from-files --reset  # data テーブルを空にしてから import
harness db import --from-files --json   # ImportReport を JSON 出力
harness db check-consistency          # DB ↔ files の drift を検出
harness db check-consistency --json   # ConsistencyReport を JSON 出力
harness db export-files               # 全 db-first row の files を再 export
harness db export-files --scope backlog --id item-20260522-001  # 範囲指定
harness db import --from-files --force-legacy-reconcile  # db-first row の上書きを許可
harness db migrate-artifacts          # 既存 run の file-backed artifact body を DB へ
harness db migrate-legacy             # legacy-file runtime row を db-first へ移行
harness db backup --out <path>        # 一貫した standalone コピーを書き出す
harness db restore --from <path> --force  # backup で live DB を置換（破壊的）
harness db checkpoint                 # WAL を本体へ checkpoint し truncate
harness db vacuum                     # 空き領域を回収（blob 削除後など）
```

- `db import` は idempotent（run は全 source file の fingerprint で skip、
  malformed file は `import_errors` に記録）。`import` は schema を自動適用するので
  `db init` なしでも動く。
- `db check-consistency` は drift / missing があれば exit 1（CI で gate 可能）。
  Phase 7 では export 追跡も検査する（`export_status` が `dirty`/`failed` の行、
  `exported_files.sha256` と実ファイルの drift）。Phase 8 で `export_status` は
  `synced`/`dirty`/`failed`/`disabled`/`removed` の状態機械になり、`disabled`
  （export OFF）や `removed`（cleanup tombstone）の missing file は drift 扱い
  しない。
- `db export-files`（Phase 7-11）は DB canonical な `db-first` row の
  compatibility files を bulk 再 export する（`--scope run|backlog|knowledge` /
  `--id <id>` で範囲指定可）。crash・export 失敗・`--reset` import のあと、
  および file export を OFF にした DB-only 運用のあとに files を DB から復元する。
- `db import` は `db-first` row を stale file で巻き戻さない（run / backlog item は
  skip）。`--force-legacy-reconcile` 指定時のみ files で上書きする（災害復旧用途）。
- `db migrate-artifacts`（Phase 8-3）は Phase 7 までの file-backed artifact body
  を DB blob へ backfill する。idempotent / resumable、missing / hash mismatch は
  report して移行から除外する。
- `db migrate-legacy`（Phase 8-6）は `source_mode='legacy-file'` の runtime row を
  db-first へ変換する。idempotent。artifact body がまだ file-backed の run は
  先に `migrate-artifacts` を促し、変換しない。
- `db backup / restore / checkpoint / vacuum`（Phase 8-8）は DB 運用コマンド。
  `backup` は WAL を含む一貫した standalone `.sqlite` を書き出す（出力先が既存
  なら拒否）。`restore` は backup を SQLite online backup 経由で検証してから
  atomic に live DB を置換し、live DB が既存なら `--force` を要求する。
  Phase 9 で `restore` は **exclusive maintenance lock** を取るようになり、
  active な runtime process（`harness run` / `review process` 等は shared
  lock を保持中）が release されるまで待つ。重要環境では運用上の安全策として
  「他の harness process を止めてから restore する」を併用することも妥当だが、
  Phase 9 の DB-wide lock 自体が data-safety を担保する。詳細は
  [`db.md`](./db.md) の「DB 運用コマンド」節。
- exit code: `0` 正常 / `1` `DbError`、`check-consistency` の drift/missing 検出、
  または `export-files` の失敗。

## `harness mcp`

Coding agent 向け MCP server（Phase 18）。仕様は [`mcp.md`](./mcp.md)。
production transport は stdio。Streamable HTTP は deferred で、指定すると失敗する。

```bash
harness mcp serve [--transport stdio] [--client-name <name>] [--config <path>]
harness mcp tools [--json]
harness mcp resources [--json]
harness mcp prompts [--json]
harness mcp config [--config <path>] [--client-name <name>]
harness mcp sessions [--limit <n>] [--json]
harness mcp invocations [--session-id <id>] [--limit <n>] [--json]
harness mcp confirmations [--status pending|confirmed|rejected|expired|consumed] [--limit <n>] [--json]
```

- `serve` は JSON-RPC MCP を stdin/stdout で処理する。stdout は MCP message 専用、diagnostic は stderr。
- `tools` / `resources` / `prompts` は client 接続なしで公開 surface を確認するための read-only コマンド。
- `config` は `--config` / `.harness/mcp.yaml` / project profile の `mcp` section / 既定値の優先順で実効 config を JSON 表示する。`--client-name <name>` 指定時は、その client に解決された `mode` / `allowedOperations` / `requireConfirmation` を JSON 表示する。
- 明示 `--config <path>` が存在しない場合は fallback せず非zeroで終了する。
- `sessions` / `invocations` / `confirmations` は MCP 監査 DB を読む。`confirmations --json` の `inputJson` / `previewJson` は redacted 表示で、実行用 raw payload は CLI list には出さない。
- read tools は既定で audit しない。dry-run は既定で audit、mutation/dangerous は常に audit。

Out-of-band confirmation は top-level `operation` command で行う。
これは MCP tool として公開しない。

```bash
harness operation confirm <confirmationId> [--preview] [--yes] [--by <actor>]
harness operation reject <confirmationId> [--by <actor>]
```

- `confirm --preview` は実行せず、対象 confirmation の redacted preview を表示する。
- `confirm <id>` は redacted preview を表示して終了する。実行には `--yes` が必要。
- `confirm --yes` は pending/未期限切れを検証し、permission を再評価してから `OperationRunner` 経由で実行し、request を consumed にする。
- `reject` は pending request を rejected にし、出力する confirmation row の `inputJson` / `previewJson` は redacted する。
- rejected / expired / consumed request は再実行できない。

## `harness goal`

Goal convergence controller（Phase 19）。長い実装/レビュー/修正ループを 1 つの
goal session に束ね、scope / close condition / budget / finding lifecycle を DB に
記録する。仕様は [`goal-convergence.md`](./goal-convergence.md)。

```bash
harness goal start --title <text> [--goal-id <id>] [--project <id>] [--repo-id <id>] [--domain <domain>] \
  [--scope-file <path>] [--close-file <path>] [--policy-file <path>] \
  [--max-iterations <n>] [--max-review-cycles <n>] [--max-reruns <n>] \
  [--max-total-new-findings <n>] [--json]
harness goal list [--status <status>] [--project <id>] [--repo-id <id>] [--domain <domain>] [--limit <n>] [--json]
harness goal status <goal-id> [--json]
harness goal close <goal-id> --summary <text> [--force] [--json]
harness goal cancel <goal-id> --reason <text> [--json]
```

Finding lifecycle:

```bash
harness goal finding add <goal-id> --severity P1 --category correctness --summary <text> \
  [--source review|test|doctor|human|mcp|codex|other] [--scope in-scope|out-of-scope|unknown|duplicate] [--json]
harness goal finding classify <finding-id> --scope in-scope|out-of-scope|unknown|duplicate --reason <text> [--duplicate-of <finding-id>] [--json]
harness goal finding fixed <finding-id> [--note <text>] [--json]
harness goal finding defer <finding-id> --reason <text> [--backlog] [--json]
```

Attempts, review cycles, close checks, and convergence decisions:

```bash
harness goal attempt start <goal-id> --type plan|implement|fix-review|rerun|validate|close-check|classify-findings|defer-followups \
  [--iteration <n>] [--operation-id <id>] [--run-id <id>] [--parent-attempt-id <id>] [--input-json <json>] [--json]
harness goal attempt complete <attempt-id> --status succeeded|failed|cancelled \
  [--operation-id <id>] [--run-id <id>] [--result-json <json>] [--error <text>] [--json]
harness goal review-cycle start <goal-id> --mode initial|delta|close|regression|manual \
  [--trigger-attempt-id <id>] [--source-review-id <id>] [--source-run-id <id>] [--json]
harness goal review-cycle complete <cycle-id> [--from-findings <path>] \
  [--findings-seen <n>] [--findings-new <n>] [--findings-reopened <n>] \
  [--findings-fixed <n>] [--findings-deferred <n>] [--findings-in-scope-open <n>] [--json]
harness goal close-check record <goal-id> --condition <id> --status passed|failed|pending|skipped|unknown \
  [--checked-by <actor>] [--message <text>] [--evidence-json <json>] [--json]
harness goal check-convergence <goal-id> [--created-by <actor>] [--no-record] [--json]

harness goal orchestrate <goal-id> --repo <path> [--base-branch <name>] [--max-steps <n>] \
  [--dry-run] [--auto-merge] [--merge-method squash|merge|rebase] \
  [--ci-await-timeout <seconds>] [--request-copilot-review]
```

`goal close` は convergence が `close_ready` でない限り `--force` を要求する。
`check-convergence` は `diverging` / `budget_exhausted` / `escalate` で exit 2。
MCP 経由の goal close/cancel/scope expansion は confirmation-required。

`goal orchestrate` は goal を terminal 状態（closed / pr_created / merged /
escalated）まで bounded loop（`--max-steps`、既定 50）で自律駆動する。`--dry-run`
は次の action のみ表示し実行しない。**`--auto-merge`（既定 OFF）** を付けると
terminal の PR 作成後に merge gate（close-ready ∧ consensus approved(quorum) ∧
CI green、または human override）を評価し、満たせば `gh pr merge` で自動マージ
（`--merge-method`、既定 squash）。CI は `--ci-await-timeout` 秒（既定 `1200`）
まで pending / empty rollup を poll し、timeout・head move・terminal failure・取得失敗は
fail-closed。gate が hard 未達なら merge せず escalate（fail-closed）。merge は operation
audit に記録される。詳細は
[`workflow.md`](./workflow.md) の「Phase 3 — auto-merge」。

**`--request-copilot-review`（既定 OFF・非 gating）** を付けると、closeAndPr で PR
作成後・auto-merge 前に best-effort で Copilot review をリクエストする。outcome は
operation audit（`copilot-review`）に記録されるだけで、close / merge を一切 gate
しない（例外も握る）。挙動は [`harness pr request-review`](#harness-pr-request-review)
と同じ。

## `harness dashboard export`

DB read model から read-only な static HTML ダッシュボードを生成する（Phase 6 で
DB-backed に刷新）。詳細は [`dashboard.md`](./dashboard.md)。

```bash
harness dashboard export                      # docs/dashboard/index.html を生成
harness dashboard export --out <path>         # 出力先を指定
harness dashboard export --project <id>       # project を絞る
harness dashboard export --repo-id <id>       # repo を絞る
harness dashboard export --no-auto-import     # DB を files から再構築せず使う
```

- **server 不要・read-only**: 生成された `index.html` をブラウザで直接開ける。外部アセット・JS を含まない自己完結ページ
- 内容: status banner（DB / consistency / warnings）/ Overview / Projects /
  Inbox / Recent runs / Backlog / Knowledge — すべて `DashboardSnapshot` から描画
- DB が無いときは既定で files から auto-import してから生成（出力に明示）。
  `--no-auto-import` で抑止（その場合 DB 不在は exit 1）
- 補間値はすべて HTML エスケープされる
- 動的な HTTP サーバが必要なら `harness dashboard serve`（下記）を使う

## `harness dashboard serve`

DB read model を配信する HTTP ダッシュボードを起動する（Phase 12 read-only /
Phase 13 mutation / Phase 14 asset reads）。エンドポイント一覧・auth は
[`dashboard.md`](./dashboard.md) の `serve` 節を参照。

```bash
harness dashboard serve                       # 127.0.0.1:8787 で read-only 起動
harness dashboard serve --host <host>         # bind host（既定 127.0.0.1）
harness dashboard serve --port <port>         # bind port（既定 8787）
harness dashboard serve --token-env <ENV>     # env var から Bearer token を読む
harness dashboard serve --cors-origin <origin># 指定 origin に CORS を許可
harness dashboard serve --no-artifact-body    # GET /api/artifacts/:id/body を無効化
harness dashboard serve --max-inline-artifact-bytes <n>  # artifact 本体の上限（既定 1048576）
harness dashboard serve --enable-mutation     # POST mutation route を有効化（token + CSRF 必須）
```

- 既定は **read-only**（GET / HEAD のみ、POST は `405`）。`GET /` は live HTML、
  `/api/*` は JSON
- `--token-env` 設定時は全リクエストに `Authorization: Bearer <token>` が必要。
  非ローカル bind で未設定なら fail-closed で `401`
- `--enable-mutation` は bearer token を必須とし（未設定なら起動時 fail-fast）、
  boot 時に CSRF token を生成して一度だけ表示。ブラウザ POST は `X-CSRF-Token`
  ヘッダで送る
- auth の運用詳細は [`../ops/setup-and-secrets.md`](../ops/setup-and-secrets.md) を参照

## `harness session`

今日何をすべきかをルールベースの順序で提案する（Phase 4-7）。**提案のみで何も実行しない。**

```bash
harness session plan            # 現在の状態から順序付き to-do を出す
harness session start --limit 3 # plan の先頭 N 件
harness session summary         # 保留中のものの compact なスナップショット
```

順序ルール（4-7.3）: `failed-*` → `needs_review` → `changes_requested` → cleanup 候補 → backlog（open、priority 高い順）。各項目に実行コマンド（`→ harness ...`）が付くが、`session` 自体は run/review/cleanup を一切起動しない。inbox（runs）と backlog を統合して見る。

## `harness metrics`

個人運用の改善に使う指標（run / review / retry / safety / maintenance）を集計する（Phase 4-6）。

```bash
harness metrics summary --since 30d        # 全体 summary
harness metrics summary --project <id>     # project を絞る（DB read model 経由、Phase 6）
harness metrics summary --repo-id <id>     # repo を絞る（DB read model 経由、Phase 6）
harness metrics domain apps/orders         # domain 別 summary
harness metrics failures --since 30d       # failed-* の status 別内訳
```

`metrics summary` の `--project` / `--repo-id`（Phase 6）は DB read model 経由で
集計する（指定時は files から DB を再構築）。scoped path でも `--since`（`runs.started_at`
への下限）と `--domain` が効く。scope 無しは従来の file-based 集計。

- **Runs**: total + status 別件数
- **Review**: approved / changes_requested / rejected 件数、approved 率、reviewer 別件数
- **Retry**: rerun 数、rerun chain 数（rootRunId 単位）、approved に到達した chain 数（収束率）
- **Safety**: policy violation 数、secret suspect 数の合計
- **Maintenance**: cleanup 待ち（approved/rejected かつ worktree 残存）件数

run の読み込みは SQLite index があれば使い、無ければ file scan（出力の `[index]`/`[file-scan]` で確認可）。`--since` は `30d` / `12h` 形式。

## `harness knowledge digest`

knowledge candidate / promoted / rejected を期間・domain 別に集計して振り返る（Phase 4-5）。

```bash
harness knowledge digest --since 7d              # 直近 7 日
harness knowledge digest --domain apps/catalog   # domain 別
harness knowledge digest --project <id>          # project を絞る（DB read model 経由、Phase 6）
harness knowledge digest --repo-id <id>          # repo を絞る（DB read model 経由、Phase 6）
```

`--project` / `--repo-id`（Phase 6）は DB read model 経由で集計する。scoped path
でも `--since`（`knowledge_candidates.created_at` への下限）と `--domain` が効く。
scope 無しは従来の file-based 集計。

- **Candidates**: 各 run の `knowledge-candidates.yaml` を kind 別に集計（run の startedAt で `--since`、candidate.domain で `--domain` フィルタ）
- **Promoted**: `docs/knowledge/<kind>/*.md` の frontmatter（`promoted_at` / `domain`）でフィルタして件数
- **Rejected**: 各 run の `knowledge-decisions.yaml` の `rejected` 決定を `decidedAt` でフィルタして件数
- **Suggested actions**: 未対応の candidate を持つ run に `harness knowledge list --run-id` を提案

`--since` は `7d` / `12h` 形式。

## `harness maintenance`

個人運用で溜まる残骸（stale lock / orphan worktree / oversized run dir 等）を検出・掃除する（Phase 4-4）。

```bash
harness maintenance check                      # 残骸を検出して報告（read-only）
harness maintenance cleanup --dry-run          # 削除予定だけ表示
harness maintenance cleanup --older-than 30d   # 30 日より古い残骸に限定
harness maintenance cleanup --force            # 実際に削除（destructive、--force 必須）
```

検出する finding:

| kind | 内容 | cleanup 対象 |
|------|------|:------------:|
| `stale-lock` | `locks/` に古い lock（acquiredAt が 2h 超） | ✅ |
| `orphan-worktree` | `workspaces/<id>` はあるが `runs/<id>` が無い | ✅ |
| `cleaned-with-worktree` | run は `cleaned` だが worktree 残存 | ✅ |
| `uncleaned-finished` | approved/rejected run の worktree 残存 | — （`harness cleanup` 経由） |
| `large-run-dir` | run dir が 50 MiB 超 | — |

`maintenance cleanup` は cleanable な finding のみ削除する。`--dry-run` 無しの実削除は **`--force` 必須**。`stale-lock` は **所有プロセスの生存確認**を行い、同一 host で pid が死んでいる lock だけ auto-cleanable（生存中は finding を出さない、別 host / lock JSON 破損は manual 扱い）。`uncleaned-finished` は run branch も消す `harness cleanup --run-id` 経由で処理する。

### 週次 maintenance 手順

```bash
harness maintenance check                      # 1. 残骸を一覧
harness maintenance cleanup --dry-run          # 2. 自動削除予定を確認
harness maintenance cleanup --older-than 30d --force   # 3. 30 日超の debris を削除
# uncleaned-finished は個別に: harness cleanup --run-id <id>
```

（より詳細な日次・週次フローは `docs/ops/personal-operating-manual.md`、Phase 4-9 で追加。）

## `harness inbox`

今日見るべきものを 1 コマンドに集約する個人運用ビュー（Phase 4-2）。

```bash
harness inbox                 # needs_review / changes_requested / failed / cleanup / knowledge を集約
harness inbox --today         # 今日 start した run のみ
harness inbox --needs-action  # action が要る section のみ（knowledge を除く）
harness inbox --failed        # failed section のみ
harness inbox --cleanup       # cleanup-candidates section のみ
harness inbox --project <id>  # project を絞る（DB read model 経由、Phase 6）
harness inbox --repo-id <id>  # repo を絞る（DB read model 経由、Phase 6）
harness inbox --json          # JSON 出力
```

各 section に次操作の hint（`→ harness ...`）が付く。cleanup candidate は「approved/rejected かつ worktree 残存」、knowledge は `knowledge-candidates.yaml` に候補がある run。run の読み込みは SQLite index があれば使い、無ければ `runs/` の file scan にフォールバック（JSON の `source` で確認可）。

`--project` / `--repo-id`（Phase 6）は DB read model 経由で集計する（needs_review /
changes_requested / failed / knowledge-candidate runs）。scoped path でも `--today`
（`runs.started_at` を当日 00:00 以降に絞る）は効く。section 選択フラグ
（`--needs-action` / `--failed` / `--cleanup`）は scoped path では非対応で warning が
出る（scoped inbox は常に全 section を返す）。scope 無しは従来の file-based ビュー
（cleanup section は scope 経路では worktree 検査をしないため非掲載）。

## `harness run show / timeline / artifacts`

1 つの run の状態を読むための read-only サブコマンド（Phase 4-1）。

```bash
harness run show --run-id <id>       # status / files / commands / review / PR / artifacts を一画面集約
harness run timeline --run-id <id>   # events.jsonl を順序付きで人間向けに整形
harness run artifacts --run-id <id>  # run dir の artifact ファイル一覧
```

- `run show`: `meta.json` から status / domain / safetyStatus / reviewer / parent / root / attempt / 変更ファイル数 / commands / PR を表示。backlog item は `backlog/` を逆引きして表示（`findBacklogItemForRun`）。個々の artifact が欠損していても落ちない
- `run timeline`: `events.jsonl` を 1 行 1 イベントの順序付きリストに整形（events は wall-clock time を持たないため順序＝時系列。timestamp を持つイベントは併記）
- `run artifacts`: run dir 直下のファイルを列挙

Exit code: `0` 成功 / `1` invalid runId・run 不在・meta.json 破損 / `2` 予期しない例外。

## `harness workflow reviewed-run`

`run → review auto → review process → (changes_requested なら rerun)*` を bounded workflow として 1 コマンドで束ねる（Phase 3-1）。各ステップは既存の `run` / `review auto` / `review process` / `rerun` を順に呼ぶだけで、状態遷移は引き続き harness が行う。

### Synopsis

```bash
# repo-id モード
harness workflow reviewed-run \
  --repo <path> --repo-id <id> --domain <domain> --goal <text> \
  [--base-branch <name>] [--reviewer-name <name>] [--max-attempts <n>] \
  [--stop-on-changes-requested] [--no-auto-review] [--dry-run]

# project モード（Phase 5）
harness workflow reviewed-run \
  --project <id> --domain <domain> --goal <text> [...]
```

### Options

| Option | Required | 説明 |
|--------|:--------:|------|
| `--repo` + `--repo-id` | repo-id モードで必須 | `harness run` と同じ。`--project` 指定時は不要 |
| `--project <id>` | project モードで必須 | project profile 経由（Phase 5）。`--repo`/`--repo-id` と排他的に、どちらか一方が必須 |
| `--domain` / `--goal` | ✅ | `harness run` と同じ |
| `--base-branch <name>` | — | default は profile の `base_branch`、無ければ `main` |
| `--reviewer-name <name>` | — | `review auto` の reviewer identity |
| `--max-attempts <n>` | — | **初回 run の後の rerun 回数の上限**（default 2）。`--max-attempts 2` なら 計 run 数は最大 initial + 2 = 3。`changes_requested` が続けば `n` 回目の rerun の後に `not_converged` で停止 |
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
harness lock release --domain <subdir> [--repo-id <id>] [--run-id <id>] [--force]
```

### Options

| Option | Required | 説明 |
|--------|:--------:|------|
| `--domain <subdir>` | ✅ | 対象 domain（例: `apps/catalog`） |
| `--repo-id <id>` | — | namespaced lock の repo id。`harness run` が作る lock は `<repoId>--<domainSlug>-<hash>.lock` 形式なので、それを release するには指定が必要。省略時は legacy の domain-only lock 名を使う |
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

## `harness index`（Phase 8 で撤去）

Phase 3-5 の SQLite run index（`index.sqlite` / `harness index rebuild|status|show`）
は **Phase 8-7 で撤去**された。Phase 6 で `harness.sqlite` read model
（`harness db import` で構築、[`db.md`](./db.md)）に置き換わり deprecated
だった機能で、`review list --use-index` も同時に廃止されている。

`harness index` は即削除せず、1 フェーズだけ **明示エラー stub** として残す。
任意のサブコマンドで exit 1 となり、置き換え先を案内する:

```text
harness error: 'harness index' was removed (Phase 8); index.sqlite is superseded
by the harness.sqlite read model:
  harness db status            — read-model / DB status
  harness db check-consistency — verify the DB against exported files
  harness dashboard export     — derived run views
```

一覧・集計・ダッシュボードは `harness review list` / `harness db` /
`harness dashboard` を使う。

### Exit code

- `1`: `harness index`（およびすべての旧サブコマンド）は常に exit 1 の stub

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

## `harness pr request-review`

作成済み PR に GitHub Copilot のコードレビューを **best-effort**（retry-then-skip・
**非 gating**）でリクエストする。close / merge を一切 gate せず、外部出力を状態遷移の
根拠にしない（安全境界）。

```bash
harness pr request-review <pr-number> --repo <path> \
  [--timeout <seconds>] [--poll-interval <seconds>] [--request-attempts <n>] [--json]
```

| Option | Required | 説明 |
|--------|:--------:|------|
| `<pr-number>` | ✅ | 対象 PR 番号（正の整数） |
| `--repo <path>` | ✅ | target git repo のパス |
| `--timeout <seconds>` | — | poll 総タイムアウト秒。**非負の整数**（`0` = 1 回観測）。default `300` |
| `--poll-interval <seconds>` | — | poll 間隔秒。**正（> 0）の整数**。default `15` |
| `--request-attempts <n>` | — | request の一時エラー retry 上限。**正の整数**。default `3` |
| `--json` | — | 結果を JSON で出力 |

数値引数は秒→ms 変換**前**に検証する。NaN/非有限/負/小数、`--poll-interval 0`、
`--request-attempts` の小数などはすべて stderr に明示して **exit 2**（`Math.floor` で
黙って受けない）。加えて秒→ms 変換**後**、`--timeout` / `--poll-interval` の ms が
`MAX_TIMER_MS`（= 2_147_483_647、Node の `setTimeout` 上限）を超える場合も明示メッセージで
**exit 2**（上限超は 1ms に丸められ busy-loop 化するため fail-closed）。poll 総タイムアウト
は各 poll に残り時間を渡して実効化し（残り時間 > 0 の poll は内部 watchdog で包み、reviewer
が `timeoutMs` を無視して hang しても総タイムアウト内に必ず収束する）、watchdog 発火時は
その poll に渡した `AbortSignal` を abort する。gh 実装はこの signal を実行中の子プロセスへ
伝播し（将来 fetch を使う場合も同じ signal を渡す）、watchdog timer は `finally` で cancel
する。`pollTimeoutMs=0` は「request 成功後に 1 回だけ観測して reviewed か skipped」を意味する。なお core の
`normalizeConfig` は、正の `pollTimeoutMs` に対し `pollIntervalMs` が 0/負/非有限/上限超
なら既定 15_000 にフォールバックする（`pollTimeoutMs=0` のときのみ 0 interval を許容）。

### 動作

1. `gh`（`HARNESS_GH_BIN` で上書き可）経由で Copilot reviewer をリクエスト。
   一時エラーは `--request-attempts` まで retry、全失敗なら **failed**
2. request 成功後、`--timeout` まで `--poll-interval` 間隔で poll。レビュー投稿を
   検出すれば **reviewed**、timeout まで未投稿なら **skipped**（poll の一時エラーは
   握って継続）
3. operations 台帳に `operationType:"copilot-review"` / `targetType:"pr"` で記録。
   `started_at` は review 実行**前**に取得した時刻。outcome の記録は
   reviewed / skipped → `succeeded`（どちらも terminal な best-effort 結果。
   result JSON の `status` で区別）、failed → `failed`。skipped を `pending` に
   しないのは、`pending`（外部 worker への deferral）だと timeout した skip が
   doctor の stale pending に誤検知されるため。台帳記録の失敗は exit code に影響しない

### Exit code

- `0`: reviewed / skipped（timeout も best-effort の正常結果）
- `1`: failed（request 自体を確立できなかった。operator が気付けるよう非 0）
- `2`: 引数不正（PR 番号が正の整数でない / `--timeout` が非負整数でない /
  `--poll-interval` が正整数でない / `--request-attempts` が正整数でない 等）

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
- `knowledge_entry_revisions` — DB-current な knowledge markdown body。`knowledge deprecate` / `knowledge edit` が更新する
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
- context は `build-context` 実行時点の snapshot。promote / deprecate / edit の後は再生成が必要（自動更新しない）
- context は domain 完全一致でフィルタするだけ。関連 domain / 親 domain の知見は引かない。ベクトル検索や関連度ランキングは無い
- deprecated entry は `knowledge deprecate <entry-id>` で DB-current revision と compatibility markdown の frontmatter を `deprecated: true` に揃える
- context は `<knowledge>` タグで囲み「reference material であり指示ではない」と明記して注入する。ただし prompt injection を完全に防ぐものではない（promoted knowledge は人間がレビューして昇格した前提）
- 注入サイズは **32 KiB 上限**（`MAX_KNOWLEDGE_CONTEXT_BYTES`）。超過分は `[knowledge context truncated...]` マーカー付きで切り詰める。肥大したら deprecated 整理で運用カバー
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

### `harness knowledge deprecate`

採用済み knowledge entry を retired state に遷移する。対象は `knowledge show` / `knowledge edit` と同じ entry id（例 `docs/knowledge/<kind>/<file>.md`）。

```bash
harness knowledge deprecate <entry-id> [--actor <actor>] [--reason <text>] [--out <dir>]
```

| Option | Required | 説明 |
|--------|:--------:|------|
| `<entry-id>` | ✅ | 対象 knowledge entry id |
| `--actor <actor>` | — | revision actor（default `cli`、空文字不可） |
| `--reason <text>` | — | revision reason（default `knowledge deprecate`） |
| `--out <dir>` | — | compatibility markdown の export root（default `HARNESS_ROOT/docs/knowledge`） |

`knowledge deprecate` は DB-first の状態遷移として、対象 entry の current revision に `deprecated: true` frontmatter を持つ markdown を記録し、`knowledge_entries` を `source_mode='db-first'` / `export_status='dirty'` に更新してから `<out>/<kind>/<file>.md` へ atomically export する。export 成功時は `knowledge_entries.export_status='synced'` になり、`asset_exports` と `exported_files` に sha を記録する。既に deprecated の entry への再実行は同じ current body を再利用し、stale な compatibility file を再 export できる。

deprecate 済み entry は file-scan の `knowledge build-context --domain ...` と DB-current の scoped build-context の両方から除外される。

### source run との独立性

promote された md は `<out>/`（既定 `docs/knowledge/`）に書かれ、`runs/<runId>/` とは**完全に独立**している。

`harness cleanup --scope run` / `--scope all` で source run の `runs/<runId>/` が削除されても、**promote 済みの knowledge md は残る** — knowledge は run のライフサイクルより長く生きる設計。md には runId / source_index / evidence が記録済みなので self-contained（`source_run` 参照は監査用であり存在保証ではない）。

### Exit code（list / reject / promote / deprecate 共通）

- `0`: 成功
- `1`: invalid runId / candidates yaml 不在 or parse 失敗 / 候補の `kind` が unsafe / reject の index 範囲外 / reviewer 空 / actor 空 / knowledge entry 不在
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
| `HARNESS_GH_BIN` | GitHub `gh` CLI のパス（default: `gh`、PR create / auto-merge / Copilot review で使用） |

codex 子プロセスに渡る env は **`DEFAULT_CODEX_ENV_ALLOWLIST`** で制限される（`PATH / HOME / USER / SHELL / LANG / LC_ALL / TERM / TMPDIR / CODEX_HOME`）。`OPENAI_API_KEY` / `AWS_*` 等は伝播しない。必要なら `src/codex/codex-cli-runner.ts:DEFAULT_CODEX_ENV_ALLOWLIST` を編集する（policy からの動的注入は MVP では未実装）。

## Phase 9 — concurrency + runtime completion（close 済み・現状仕様）

詳細は [`db.md`](./db.md) の「Phase 9」節 + [`workflow.md`](./workflow.md)
の Phase 9 節。本節は CLI 観点の変更点をまとめる（実装中）。

### `harness db` の lock 適用

| コマンド | maintenance lock |
|---------|------|
| `db init` / `db migrate` | exclusive |
| `db restore` / `db vacuum` / `db checkpoint --truncate` | exclusive |
| `db migrate-artifacts` / `db migrate-legacy` | exclusive |
| `db backup` / `db stats` / `db check-consistency` | shared |
| `db export-files` | shared（write も含む — 下記の注） |
| `db status` | shared（または lockless） |

exclusive 系には `--wait` / `--timeout <ms>` が追加される。busy 時は別プロセス
の hint（pid / hostname）を出すエラー。

**shared vs exclusive の意味（混乱しやすいので明文化）**:

- **shared** = 「他の normal write / read と並行可能」。SQLite の WAL +
  transaction が DB write を serialize する一方、maintenance lock は
  「DB そのものを atomic に置換する restore / 全体 vacuum / 構造変更」を
  排他するための上位 sidecar である。よって `db export-files` のように
  `exported_files` を書く読み書きコマンドでも shared でよい。**shared =
  read-only ではない**。
- **exclusive** = 「他の harness 接続を一切許容しない」。`restore` / `vacuum`
  / `checkpoint --truncate` / schema migration / large bulk import 等の
  destructive / atomic-replace 操作。

runtime（`harness run` / `review process` / `cleanup` / `pr create` /
`backlog` / `knowledge`）は **shared maintenance lock を DB handle の
lifetime 中保持**する（Phase 9 post-close P0 fix）。これにより exclusive な
`db restore` を要求する process は runtime が release するまで待つ。

### `harness lock`

`lock list` / `lock release` は Phase 9 で DB-backed 化される（dual-lock
期間: file + DB の両方を表示・release）。heartbeat_at / expires_at /
fencing_token / release_reason を出力。`lock release --force` は active
heartbeat 中の lease を奪い、保持側を `LeaseStolenError` で fail させ
うる（強い stderr warning が出る）。

### `HARNESS_EXPORT_FILES` の default

Phase 9 close で default OFF に反転。未設定時は warning。
`HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1` で抑制可。

### `harness review process` の verdict 経路

`review_proposals` テーブルが DB canonical。`review process` は DB から
最新 active proposal を読む（sidecar `review-decision.yaml` は legacy /
手書きの fallback として残る）。`--reviewer <name>` で reviewer 指定可。

## 既存以外の subcommand

将来追加予定（MVP には無い）:

- `harness review process` 完了後の自動 `harness rerun` 連鎖（changes_requested → rerun → review を自動ループ）
- knowledge-candidate の confirmed ストアへの統合（現状 `knowledge promote` は md 書き出しまで）

これらは `docs/superpowers/plans/` 配下に計画 doc を作るタイミングで追加する。

## Phase 10 — CLI 変更（設計確定・実装中）

Phase 10 の設計は [`../superpowers/specs/2026-05-23-phase10-db-only-runtime-completion-design.md`](../superpowers/specs/2026-05-23-phase10-db-only-runtime-completion-design.md) §5。

### `harness lock`（Phase 10）

| コマンド | 変更 |
|---|---|
| `harness lock list` | DB locks のみ表示。file source 表示を廃止。`heartbeat_at` / `expires_at` / `fencing_token` / `release_reason` を出力 |
| `harness lock release --domain <d> [--run-id <id>] [--force]` | DB lock のみ release。stale (`expires_at < now`) は `--force` なしで release 可。active lease を奪う場合は `--force` 必要、stderr warning + `release_reason='force'` 記録 |
| `harness lock migrate` | **未提供**。Phase 9 でも提供せず、Phase 10 でも作らない |

`.harness/locks/<domain>.lock` が残っている場合、Phase 10 起動時に 1 回
stderr warning（`HARNESS_SUPPRESS_LEGACY_FILE_LOCK_WARNING=1` で抑制可）:

```
warning: legacy file domain lock found at .harness/locks/<domain>.lock — ignored.
         Phase 10 uses DB domain locks (domain_locks table) exclusively.
         You can safely delete .harness/locks/.
```

### `harness db materialize`（Phase 10、新規）

```bash
harness db materialize --run <runId> [--ttl 1h] [--out <dir>] [--reason <text>]
harness db materialize cleanup [--expired] [--run <runId>]
```

scratch materialize 専用。`run_materializations` に `purpose='scratch'`
row を INSERT し、`<out> or runs/<runId>/` に file を書き出す。**`exported_files`
/ `runs.export_status` は触らない**。

`--ttl` は scratch 寿命。default なし（必ず明示）。expire 後の cleanup は
`materialize cleanup --expired` が回収。

### `harness db export-files`（Phase 10 で意味確定）

```bash
harness db export-files --run <runId>
harness db export-files --project <projectId>
harness db export-files --all
```

**compat export 専用**。`exported_files` を更新し、対象 run の
`runs.export_status='synced'` に。scratch materialize と異なり、export は
**永続的な file artifact** を意図する operator 操作。

shared maintenance lock。

### `harness run show` / `harness run artifacts`（Phase 10）

```bash
harness run show <runId> [--source db|files|auto]      # default = auto
harness run artifacts <runId> [--source db|files|auto] # default = auto
```

`--source auto` の resolution:

| `source_mode` | `--source auto` | `--source db` | `--source files` |
|---|---|---|---|
| `db-first` | DB を読む。runDir があっても無視。`export_status != synced` なら 1 行 warning | DB のみ | runDir のみ（debug） |
| `legacy-file` | files を読む（runtime では発生しない経路） | reject | files のみ |

`auto` で `export_status` が `disabled / dirty / failed / removed` のとき:

```
Note: file export status = dirty. Files in runs/<runId>/ may be stale.
      Use --source files to inspect files explicitly,
      or `harness db export-files --run <runId>` to refresh the export.
```

### `harness review process`（Phase 10、idempotency 強化）

```bash
harness review process <runId> [--proposal <id>] [--reviewer <name>]
                               [--expected-state-version <n>]
                               [--operation-id <uuid>]
```

guard 条件は db.md "Review process idempotency" 節。conflict 時の UX:

```
$ harness review process <runId>
error: review proposal state changed since you read it.
       Latest active proposal:    proposal_id=12, reviewer=codex, source_sha256=abcd…
       Run state:                 status=in-review, state_version=4
       You attempted to process:  proposal_id=11, source_sha256=ef01…
       Re-run with the latest proposal, or use --proposal 12 explicitly.
```

`operation_id` 重複時:

- 同一 input / 同一結果 → idempotent no-op、既存結果を出力
- 同一 input / 異なる結果 → `OperationReplayConflictError`、stderr に
  conflict 詳細

### Runtime legacy branch 撤去（Phase 10-6 影響）

runtime write command は `sourceMode === 'legacy-file'` の run / backlog /
knowledge_candidate に対して `assertNoLegacyRuntimeRows(db)` で拒否。
bypass は `db migrate-legacy` / `db import --force-legacy-reconcile` /
`db doctor` / `db check-consistency`。

## Phase 11 — Review governance CLI（設計確定・実装中）

Phase 11 の設計は [`../superpowers/specs/2026-05-24-phase11-review-governance-consensus-design.md`](../superpowers/specs/2026-05-24-phase11-review-governance-consensus-design.md)。

### `harness review reviewers`（Phase 11-2、新規）

```
harness review reviewers list
harness review reviewers add <reviewer_id> --type <human|codex|external|system> \
                             --display-name <name> [--group <id>] \
                             [--trust <advisory|normal|required|policy>]
```

migration v7 適用時に default reviewers が seed される (human / codex /
codex-security / system)。

### `harness review auto`（Phase 11-2 で reviewer 解決）

```
harness review auto <runId> --reviewer <reviewer_id> [--model <m>]
```

`--reviewer` は reviewers table の `reviewer_id`。unknown なら
`UnknownReviewerError` で exit 1。proposal 保存時に reviewer_id /
reviewer_type / model / prompt_sha256 / context_pack_id /
policy_generation_id を埋める。完了後 consensus を re-evaluate (Phase 11-4)。

### `harness review status`（Phase 11-4、新規）

```
harness review status <runId>
```

active consensus + required reviewers + blocking + active proposals 表示。

### `harness review process`（Phase 11-5 で consensus mode 追加）

```
harness review process <runId> [--consensus] [--reviewer <id>]
                               [--override <decision> --reason <reason>
                                [--actor-reviewer <id>]]
                               [--operation-id <uuid>]
                               [--expected-state-version <n>]
```

default は `rule.mode` 依存 (`consensus` / `latest-proposal`)。`--override`
で human override (Phase 11-6; allowedReviewers + reason 必須)。

### `harness review proposals`（Phase 11-7、新規）

```
harness review proposals list <runId> [--include-archived]
harness review proposals archive <proposalId>
harness review proposals vacuum --older-than 30d [--apply]
```

`vacuum` は dry-run default。`superseded` / `rejected_stale` / `processed`
で threshold より古い rows を `archived` 化 (delete はしない)。
