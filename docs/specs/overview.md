# Overview

これは全体像の **入口 doc**。各機能の詳細は対応する spec に委ね、ここでは俯瞰に
徹する。詳細は [`policy.md`](./policy.md) / [`workflow.md`](./workflow.md) /
[`cli.md`](./cli.md) / [`project.md`](./project.md) / [`db.md`](./db.md) /
[`dashboard.md`](./dashboard.md) / [`mcp.md`](./mcp.md) /
[`hitch-convergence.md`](./hitch-convergence.md) を参照。

## ハーネスの目的

monorepo の中の **1 つの domain（例: `apps/catalog`）に対する codex exec の編集を
policy で制約し、結果をレビュー artifact として保存する** ランナー。状態の正本は
`.harness/harness.sqlite`（[`db.md`](./db.md)）で、`runs/` 以下の file は既定では
吐かない（opt-in の互換 export）。

```
operator → `harness run --project <id> --domain apps/catalog --goal "..."`
            │
            ├─ resolve policy（project profile → policy compile、または repos/<id>.yaml）
            ├─ acquire DB-backed domain lock（lease + heartbeat + fencing token）
            ├─ git worktree add（isolated copy of target repo）
            ├─ spawn codex exec（sandbox=workspace-write by default）
            ├─ collect diff（tracked + untracked, no `git add -N`）
            ├─ validate paths（deny_write > unsafe_path > write scope）
            ├─ build artifacts（DB へ書く / blob は DB or external store）
            └─ finalize status + release lock
```

操作者の責務は **policy の設計とレビュー**。codex の振る舞いを直接コントロールする
のではなく、安全境界 (path / symlink / secret / size / lock) を harness が事後検査
して、reviewer に decision を委ねる **bounded review gate** 型。

## 安全モデル（中核・不変）

harness の中核は次の安全モデルである。これは Phase が進んでも変わらない。

1. **bounded review gate** — codex の振る舞いを直接制御せず、harness が事後に
   安全境界を検査し、最終 decision は reviewer に委ねる。
2. **2 層の安全境界**
   - **policy ベースのスコープ制御** — `policies/global.yaml` +
     `policies/repos/<id>.yaml`（あるいは project profile から compile した結果）の
     write / deny_write で、どの path を編集してよいかを宣言的に定義する。
   - **事後 `git diff` 検証** — codex 実行後の diff を path / symlink / secret /
     size の観点で検査し、違反を `failed-policy-violation` で reject する。
   - **LLM の出力は信用しない。** policy 違反検査も状態遷移も、LLM が何を出力した
     かに依存しない。
3. **状態遷移は harness だけが行う** — `meta.status` / `runs.status` を
   `approved` / `changes_requested` / `rejected` に遷移させるのは
   `harness review process`（および同等の core オペレーション）のみ。LLM が出力に
   「approved」と書いても状態は動かない。

## Agent role separation

harness は 2 種類の LLM agent と harness 自身の 3 ロールに権限を分離する。
**LLM の出力は信用しない / 状態遷移は harness だけが行う**が大原則。

| ロール | 目的 | 権限 | 出力 |
|--------|------|------|------|
| **coder agent** | domain 内の実装変更 | 標準は `workspace-write` sandbox（cwd = worktree） | worktree のファイル変更、`codex-output.log` / `codex-error.log` |
| **reviewer agent** | run artifacts を読み verdict を提案 | `read-only` sandbox。コード編集不可、status 変更不可 | review verdict（codex stdout）、`reviewer-agent.*.log` |
| **harness** | 状態遷移・安全検査 | authoritative。run state / events / artifact を DB に書く / cleanup | review decision ほか artifacts |

**構造上の境界:**
- coder の cwd は worktree（`workspaces/<runId>/repo/`）。`workspace-write` sandbox
  では worktree に書き込みが閉じ、harness の状態（DB / harness root 配下）には
  到達できない → **coder は review decision を変更できない**。coder が出力に
  「approved」と書いても status は動かない（`harness review process` のみが遷移）。
  - ⚠️ この境界は **標準の `workspace-write` sandbox 前提**。policy で
    `codex.sandbox: danger-full-access` を設定すると coder が harness root を含め
    どこでも書けるようになり、この保証は **失効する**。domain-coding workflow では
    `workspace-write`（または `read-only`）を推奨。
- reviewer agent は `read-only` sandbox で動き、**直接コードも artifacts も変更
  できない**。codex の出力（verdict）は harness が検証したうえで review decision に
  反映する（agent が直接書くのではない）。prompt に編集指示が混ざっても無害。

**prompt template:** 各 agent の prompt は名前付き・version 付きのテンプレート
（coder の `coder-domain-task`、reviewer の `reviewer-run-artifacts`、rerun の
`rerun-from-review` など）。詳細は [`workflow.md`](./workflow.md)。

## できること

俯瞰のみ。詳細は各 spec へ。

- **domain-coding run**（[`workflow.md`](./workflow.md) / [`cli.md`](./cli.md)）—
  1 target repo の 1 domain に対し codex を走らせ、policy で read / write /
  deny_write を制約。untracked file を validation 対象に含め、symlink を follow
  せず、secret-shape を redact し、`**/node_modules/**` 等を政策的 ignore する。
  path validation 通過後に `policy.allowedCommands` を worktree 内で実行。
- **review gate**（[`workflow.md`](./workflow.md)）— `review list`（review queue
  可視化）/ `review auto`（reviewer agent が verdict 提案）/ `review process`
  （decision を読んで status を遷移）。
- **bounded review→rerun ループ**（[`cli.md`](./cli.md)）— `rerun --from-review`
  で `changes_requested` の親から `required_changes` を組み込んだ新 run を起動
  （parentRunId / rootRunId / rerunAttempt の監査チェーン、`--max-attempts` 上限）。
  `workflow reviewed-run` は run → review → rerun を **1 コマンドの bounded loop**
  として回す。
- **knowledge ループ**（[`cli.md`](./cli.md)）— `knowledge list / reject / promote / deprecate`
  で候補と採用済み知見をレビューし、`knowledge promote` で `docs/knowledge/` に展開。
  `run --with-knowledge`（または `--knowledge-context <path>`）で
  `docs/knowledge-context/<domain>.md` を codex prompt に注入する。
- **Project Abstraction（Phase 5）**（[`project.md`](./project.md)）— `projects/<id>.yaml`
  の project profile を domain registry / template / preset / context pack 経由で
  policy へ compile。`project inspect / init / check`（いずれも Codex 不使用）。
  `run --project <id>` で起動。既存 `--repo + --repo-id` path は後方互換で従来どおり。
- **DB 完全移行（Phase 6-17）**（[`db.md`](./db.md)）— run state / events / artifact
  body(blob) / domain lock / review proposal の canonical は `.harness/harness.sqlite`
  （schema v16）。`db init / migrate / import / export-files / backup / restore /
  checkpoint / vacuum / stats / status / doctor / repair / check-consistency /
  archive / upgrade-check / blob-store / migrate-blobs` 等。external blob storage
  （Phase 16/17）。
- **concurrency（Phase 9）**（[`db.md`](./db.md)）— DB-backed domain lock
  （lease + heartbeat + fencing token）で同一 domain の並行 run を防ぎ、DB-wide
  maintenance lock で破壊的メンテを排他する。file lock は撤去済み。
- **review governance（Phase 11）**（[`cli.md`](./cli.md) / [`db.md`](./db.md)）—
  reviewer registry / review rules / consensus（`review evaluate` / `review
  proposals` / `reviewers`）と human override。
- **dashboard（Phase 12-14）**（[`dashboard.md`](./dashboard.md)）— `dashboard export`
  は依存ゼロの静的 HTML 成果物、`dashboard serve` は DB を read model とする HTTP
  サーバ。既定は localhost / GET・HEAD のみの read-only。`--enable-mutation` で
  POST mutation route を有効化（Bearer token 必須 + CSRF）。Phase 14 で
  human-authored asset の read も提供。
- **MCP server（Phase 18）**（[`mcp.md`](./mcp.md)）— `harness mcp serve --transport
  stdio` の JSON-RPC server。read / dry-run / mutation tools を公開し、mutation は
  permission allowlist + out-of-band confirmation + rate budget + audit/redaction
  でガードする。raw shell は公開しない。
- **hitch convergence（Phase 19）**（[`hitch-convergence.md`](./hitch-convergence.md)）—
  bounded coding-agent hitch loop の DB-backed 収束コントローラ。`harness hitch` CLI
  + MCP hitch tools。scope freeze / finding lifecycle / close decision を持ち、
  convergence decision（`continue` / `needs_fix` / `needs_classification` /
  `close_ready` / `diverging` / `budget_exhausted` / `escalate` 等）を返す。

## できないこと（現状の deferred / 範囲外）

- **autonomous orchestration** — run → review → rerun → close → PR の bounded
  loop は `harness hitch orchestrate`（hitch convergence の収束制御）で提供する。
  close-ready ∧ consensus approved(quorum) ∧ CI green な PR の **自動マージは
  opt-in（既定 OFF、`--auto-merge`）** で提供する（[`workflow.md`](./workflow.md)）。
  人手トリガ無しの常駐 worker / daemon・無制限ループは未実装。
- **MCP の Streamable HTTP transport** — production transport は stdio のみ。
  HTTP は local-only stretch として deferred（[`mcp.md`](./mcp.md)）。
- **リモート blob adapter** — blob store は local adapter のみ。S3 等の remote
  adapter は未実装（[`db.md`](./db.md)）。
- **external issue tracker 連携** — deferred finding は backlog item を作るのみで、
  外部 issue tracker への sync は無い。
- **`pr create` / `rerun` の実 codex smoke** — 2026-06-04 の実 codex smoke で検証済み。
  `rerun --from-review` は real codex の child run、`pr create` は real GitHub remote
  への draft PR 作成まで確認済み
  （[`2026-06-04-real-codex-smoke.md`](../reports/2026-06-04-real-codex-smoke.md)）。
- **multi-target run** — 複数 target repo を 1 run で扱わない（1 run = 1 domain）。
- **secret heuristic の DLP 級厳密性** — あくまで「reviewer の見落とし防止」レベル。
- **Windows プロセスツリー kill の E2E** — 実装は taskkill 経路ありだが未検証。

## 用語

| 用語 | 意味 |
|------|------|
| **target repo** | codex を走らせる対象の git repository。harness の外側にある |
| **domain** | target repo 内のディレクトリ（例: `apps/catalog`）。1 domain = 1 codex run = 1 lock |
| **project** | target repo の profile（`projects/<id>.yaml`）。domain registry / template / context を束ね、policy へ compile する（Phase 5） |
| **harness root** | `HARNESS_ROOT` が指す任意ディレクトリ。`policies/` / `runs/` / `workspaces/` / `.harness/` の親（このリポジトリ自身である必要はない） |
| **worktree** | target repo の `git worktree` で作った isolated copy。`workspaces/<runId>/repo/` |
| **DB** | `.harness/harness.sqlite`。run state / events / artifact body / domain lock / review proposal の canonical（[`db.md`](./db.md)） |
| **artifact** | run の成果物（summary / review-request / log 等）。本体は DB blob or external store に格納 |
| **review gate** | run 完了時の状態 `needs_review`。reviewer の decision を `harness review process` が `approved` / `changes_requested` / `rejected` に遷移させる |

## 主要な型契約

`src/policy/schema.ts` / `src/logging/run-log.ts` から抜粋（中核は概ね不変）:

```ts
type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

interface ResolvedPolicy {
  repoId: string;
  domain: string;
  read: string[];
  write: string[];
  denyWrite: string[];               // global.always_deny_write ∪ domain.deny_write
  allowedCommands: ResolvedCommand[]; // string YAML entries は {id,cmd,args,shell} に lift
  commandDefaults: { timeoutMs: number; envAllowlist?: string[] };
  ignoreUntracked: string[];
  codex: { sandbox: SandboxMode; approval?: string; timeoutMs?: number };
  limits: { gitTimeoutMs: number };
}

type RunStatus =
  | "running" | "generated" | "verified" | "needs_review"
  | "approved" | "changes_requested" | "rejected" | "cleaned"
  | "failed-policy-violation" | "failed-codex" | "failed-codex-timeout"
  | "failed-diff-collection" | "failed-command" | "failed-internal-error";

type SafetyStatus = "allowed" | "denied" | "skipped";

interface RunDomainCodingResult {
  runId: string;
  status: RunStatus;
  safetyStatus: SafetyStatus;
  ignoredUntrackedCount: number;
  secretSuspectCount: number;
}
// RunMeta は加えて reviewer?: string | null と reviewedAt?: string | null を持つ。
// hitch convergence の decision 列挙は hitch-convergence.md を参照。
```

詳細は [`policy.md`](./policy.md) / [`workflow.md`](./workflow.md) /
[`hitch-convergence.md`](./hitch-convergence.md) を参照。

## ディレクトリレイアウト（harness root）

`HARNESS_ROOT` が指す任意ディレクトリ配下のレイアウト。

```txt
<HARNESS_ROOT>/
  policies/
    global.yaml                    # 全 run 共通の defaults / limits / always_deny / ignore
    repos/<repo-id>.yaml           # 1 target repo の domain ごとの read/write/deny
  projects/<id>.yaml               # project profile（Phase 5）
  templates/                       # policy template / command preset / context pack
  .harness/
    harness.sqlite                 # canonical DB（run state / events / blob / lock / proposal）
    db.lock                        # DB-wide maintenance lock（Phase 9）
  src/                             # 実装
    cli/                           # commander based subcommand entry（run / db / project / hitch …）
    core/                          # workflow オーケストレーション
    policy/, workspace/, git/, codex/, logging/, reporter/, config/
    project/                       # Project Abstraction（Phase 5）
    db/                            # SQLite read/write model・migration・blob・maintenance（Phase 6-17）
    dashboard/                     # export 静的 HTML + serve HTTP server（Phase 12-14）
    operations/                    # OperationRunner（mutation の単一経路）
    storage/                       # blob store adapter（local。Phase 16）
    mcp/                           # MCP server（Phase 18）
    hitch/                         # hitch convergence controller（Phase 19）
  tests/
    unit/, integration/            # 各モジュール単体 + 実 git + fake codex
  runs/                            # runtime。export OFF（既定）では空で DB が canonical。
                                   # `db export-files` で再生成できる互換 export
  workspaces/                      # runtime scratch。export OFF + ingest 成功で削除される
                                   # <runId>/repo/ に git worktree 実体
  locks/                           # legacy（file lock は撤去済み。残骸は warnLegacyFileLocks が警告）
  docs/
    specs/, ops/, reports/, examples/, knowledge/, knowledge-context/, …
```

> `HARNESS_EXPORT_FILES` は **既定 OFF**（Phase 9 で ON → OFF へ反転）。`runs/` /
> 互換 file が欲しい場合のみ `HARNESS_EXPORT_FILES=1` を設定するか、明示的に
> `harness db export-files` を実行する。詳細は [`db.md`](./db.md)。

## エントリーポイント（代表コマンド）

詳細は [`cli.md`](./cli.md)。ここでは入口の代表のみ。

```bash
# DB を初期化 / migration を適用（最初に一度）
HARNESS_ROOT="$PWD" npm run --silent harness -- db init
HARNESS_ROOT="$PWD" npm run --silent harness -- db migrate

# project profile を起点に run（Phase 5）
HARNESS_ROOT="$PWD" npm run --silent harness -- run \
  --project <id> --domain <subdir> --goal "<task>" [--with-knowledge]

# 後方互換の repo-id 指定（profile を使わない path）
HARNESS_ROOT="$PWD" npm run --silent harness -- run \
  --repo <target-repo-path> --repo-id <id> --domain <subdir> --goal "<task>"

# policy 解決だけ確認
HARNESS_ROOT="$PWD" npm run --silent harness -- run ... --dry-run

# review queue 可視化 → decision 反映
HARNESS_ROOT="$PWD" npm run --silent harness -- review list
HARNESS_ROOT="$PWD" npm run --silent harness -- review process --run-id <run-id>

# bounded loop（run → review → rerun を 1 コマンドで）
HARNESS_ROOT="$PWD" npm run --silent harness -- workflow reviewed-run \
  --project <id> --domain <subdir> --goal "<task>" [--max-attempts <n>]

# dashboard（依存ゼロ静的 / 常時最新 HTTP）
HARNESS_ROOT="$PWD" npm run --silent harness -- dashboard export
HARNESS_ROOT="$PWD" npm run --silent harness -- dashboard serve [--enable-mutation]

# MCP server（coding agent 向け JSON-RPC, stdio）
HARNESS_ROOT="$PWD" npm run --silent harness -- mcp serve --transport stdio

# hitch convergence（bounded hitch loop）
HARNESS_ROOT="$PWD" npm run --silent harness -- hitch start \
  --title "..." --scope-file scope.yaml --close-file close.yaml
HARNESS_ROOT="$PWD" npm run --silent harness -- hitch status <hitch-id>
HARNESS_ROOT="$PWD" npm run --silent harness -- hitch check-convergence <hitch-id> --json
```

## 関連 docs

- 認証 / secret 運用（dashboard server auth・MCP token 等）:
  [`../ops/setup-and-secrets.md`](../ops/setup-and-secrets.md)
- DB の定期メンテ（backup / checkpoint / vacuum / archive / doctor）:
  [`../ops/db-maintenance-runbook.md`](../ops/db-maintenance-runbook.md)
- 個人運用フロー（inbox / backlog / metrics / session / maintenance, Phase 4）:
  [`../ops/personal-operating-manual.md`](../ops/personal-operating-manual.md)
