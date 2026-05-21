# Overview

## ハーネスの目的

monorepo の中の **1 つの domain（例: `apps/catalog`）に対する codex exec の編集を policy で制約し、結果をレビュー artifact として保存する** 最小ランナー。

```
operator → `harness run --domain apps/catalog --goal "..."`
            │
            ├─ resolve policy from policies/global.yaml + policies/repos/<id>.yaml
            ├─ acquire per-domain lock
            ├─ git worktree add (isolated copy of target repo)
            ├─ spawn codex exec (sandbox=workspace-write by default)
            ├─ collect diff (tracked + untracked, no `git add -N`)
            ├─ validate paths (deny_write > unsafe_path > write scope)
            ├─ build artifacts (summary.md, review-request.md, …)
            └─ finalize status + release lock
```

操作者の責務は **policy の設計とレビュー**。codex の振る舞いを直接コントロールするのではなく、安全境界 (path / symlink / secret / size / lock) を harness が事後検査して、reviewer に decision を委ねる **bounded review gate** 型。

## できること

- 1 つの target monorepo を `--repo` で指定して、その内部の domain (= subdirectory tree) を targets として codex を走らせる
- policy で domain ごとの read / write / deny_write を定義し、違反を `failed-policy-violation` で reject
- untracked file（codex が新規作成したファイル）を validation 対象に含める
- symlink を follow せずに target だけ記録（worktree 外への参照を artifact 化しない）
- filename / content heuristics で secret-shape のファイルを redact（`*.env*` / AWS key / OpenAI key / etc.）
- `**/node_modules/**` などの政策的 ignore で build 出力を除外（ただし validation はスキップする扱い）
- domain 単位の lockfile で同一 domain への並行 run を防止
- run の全 artifact を `runs/<runId>/` に保存し、worktree も削除せず残す（レビュー後に手動 cleanup する想定）
- review-request.md + review-decision.yaml を生成（reviewer はこの 2 ファイルでレビューと決定を行う）
- `harness review process --run-id <id>` で review-decision.yaml を読んで `meta.status` を `approved` / `changes_requested` / `rejected` に遷移、reviewer / reviewedAt を meta に記録、`review_processed` event を追記
- path validation 通過後に `policy.allowedCommands`（例: `npm test` / `npm run lint`）を worktree 内で順次実行、失敗時は `failed-command` ステータス + `meta.commandResults` に結果保存
- `harness cleanup --run-id <id> [--force] [--scope workspace|run|all]` で worktree + branch（+ scope に応じ run dir）を削除（`changes_requested` / `running` は強制でも残す）
- `harness review list` で全 run の meta.json を読みテーブル/JSON 表示。default は review queue（`needs_review` + `changes_requested`）、`--all` / `--status` / `--domain` / `--limit` / `--json` で絞り込み。壊れた run dir は invalid として分離（stderr 警告 or `invalidRuns[]`）
- `harness rerun --from-review <parent-run-id> [--max-attempts <n>]` で `changes_requested` の親から `required_changes` を組み込んだ新 run を起動（`meta.parentRunId` / `rootRunId` / `rerunAttempt` で監査チェーン、`--max-attempts` 超過で拒否）。`harness rerun chain --run-id <id>` で再実行系譜をツリー表示
- `harness review auto --run-id <id>` で reviewer agent（read-only sandbox の codex）が artifacts を読んで `review-decision.yaml` を生成（適用は別途 `review process`）
- `harness knowledge list / reject / promote` で候補をレビュー — status 一覧、reject 決定の sidecar 記録、`--reviewer` 必須の昇格（YAML frontmatter + (run,index)/content-hash 重複制御）。`knowledge-candidates.yaml` は不変

## できないこと（MVP の範囲外）

- `review process` → `rerun` → `review` の完全自動ループ（各ステップは手動トリガ）
- knowledge md の confirmed ストア統合 / LLM への自動注入（`knowledge promote` は md 書き出しまで）
- multi-agent orchestration（writer agent / reviewer agent の同時並走など）
- 複数 target repo を 1 run で扱う
- 非ファイル系の検査（HTTP リクエストログ、外部 API 呼び出し履歴 等）
- secret heuristic の DLP 級厳密性（あくまで「reviewer の見落とし防止」レベル）
- Windows でのプロセスツリー kill の E2E テスト（実装は taskkill 経路あり、未検証）

## 用語

| 用語 | 意味 |
|------|------|
| **target repo** | codex を走らせる対象の git repository。harness の外側にある |
| **domain** | target repo 内のディレクトリ（例: `apps/catalog`）。1 domain = 1 codex run = 1 lock |
| **harness root** | このリポジトリ自身。`policies/`, `runs/`, `workspaces/`, `locks/` を持つ |
| **worktree** | target repo の `git worktree` で作った isolated copy。`workspaces/<runId>/repo/` |
| **artifact** | run の成果物。`runs/<runId>/` 配下の meta.json / summary.md など |
| **review gate** | run 完了時の状態 `needs_review`。reviewer が `review-decision.yaml` を編集 → `harness review process` で `approved` / `changes_requested` / `rejected` に遷移 |

## Agent role separation（Phase 3-3）

harness は 2 種類の LLM agent と harness 自身の 3 ロールに権限を分離する。**LLM の出力は信用しない / 状態遷移は harness だけが行う**が大原則。

| ロール | 目的 | 権限 | 出力 |
|--------|------|------|------|
| **coder agent** | domain 内の実装変更 | 標準は `workspace-write` sandbox（cwd = worktree） | worktree のファイル変更、`codex-output.log` / `codex-error.log` |
| **reviewer agent** | run artifacts を読み verdict を提案 | `read-only` sandbox。コード編集不可、status 変更不可 | review verdict（codex stdout）、`reviewer-agent.*.log` |
| **harness** | 状態遷移・安全検査 | authoritative。`meta.json` 更新 / events 追記 / cleanup | `review-decision.yaml` ほか artifacts |

**構造上の境界:**
- coder の cwd は worktree（`workspaces/<runId>/repo/`）。`workspace-write` sandbox では worktree に書き込みが閉じ、`runs/<runId>/review-decision.yaml`（harness root 配下、worktree の外）には到達できない → **coder は review-decision を変更できない**。coder が出力に「approved」と書いても `meta.status` は動かない（`harness review process` のみが遷移させる）。
  - ⚠️ この境界は **標準の `workspace-write` sandbox 前提**。policy で `codex.sandbox: danger-full-access` を設定すると coder が harness root を含めどこでも書けるようになり、この保証は**失効する**。domain-coding workflow では `workspace-write`（または `read-only`）を推奨。
- reviewer agent は `read-only` sandbox で動き、**直接コードも artifacts も変更できない**。codex の出力（verdict）は harness が検証したうえで `review-decision.yaml` に書く（agent が直接書くのではない）。実行前後の artifact snapshot（Phase 2-6）で改竄を検出・拒否するため、prompt に編集指示が混ざっても無害。

**prompt template:** 各 agent の prompt は名前付き・version 付きのテンプレート。`meta.promptTemplate` には **codex-prompt.md を組んだ外側の coder テンプレート** `{name, version}`（`coder-domain-task`）を記録する。reviewer の `reviewer-run-artifacts`、rerun の goal-wrapper `rerun-from-review` も version 付き定数で、後者の version は rerun の `codex-prompt.md` 内に明記される。

## 主要な型契約

`src/policy/schema.ts` / `src/logging/run-log.ts` から抜粋:

```ts
type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

interface ResolvedPolicy {
  repoId: string;
  domain: string;
  read: string[];
  write: string[];
  denyWrite: string[];          // global.always_deny_write ∪ domain.deny_write
  allowedCommands: string[];
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

// RunMeta は加えて reviewer?: string | null と reviewedAt?: string | null を
// 持つ。これらは `harness review process` 実行時にセットされる。
```

詳細は [`workflow.md`](./workflow.md) と [`policy.md`](./policy.md) を参照。

## ディレクトリレイアウト（harness root）

```txt
monorepo-harness/
  policies/
    global.yaml                    # 全 run 共通の defaults / limits / always_deny / ignore
    repos/<repo-id>.yaml           # 1 target repo の domain ごとの read/write/deny
  src/                             # 実装
    cli/run.ts                     # commander based subcommand entry
    core/workflow-runner.ts        # 全体オーケストレーション
    policy/, workspace/, git/, codex/, logging/, reporter/, config/
  tests/
    unit/                          # 各モジュールの単体テスト
    integration/                   # workflow-fake-codex.test.ts 等 (実 git + fake codex)
  runs/                            # runtime 生成、.gitignore'd
    <runId>/                       # 1 run の全 artifact
  workspaces/                      # runtime 生成、.gitignore'd
    <runId>/repo/                  # git worktree 実体
  locks/                           # runtime 生成、.gitignore'd
    <domain-slug>.lock             # 1 domain の active run 情報
  docs/
    specs/, reports/, examples/, policy-semantics.md, superpowers/plans/
```

## エントリーポイント

```bash
# 通常実行
HARNESS_ROOT="$PWD" npm run --silent harness -- run \
  --repo <target-repo-path> \
  --repo-id <id> \
  --domain <subdir> \
  --goal "<task description>" \
  --base-branch main

# policy 解決だけ確認
HARNESS_ROOT="$PWD" npm run --silent harness -- run ... --dry-run

# 残った lock を確認 / 解除
HARNESS_ROOT="$PWD" npm run --silent harness -- lock list
HARNESS_ROOT="$PWD" npm run --silent harness -- lock release --domain <subdir>

# needs_review な run を一覧（処理待ちの可視化）
HARNESS_ROOT="$PWD" npm run --silent harness -- review list

# (任意) reviewer agent に review-decision.yaml を生成させる
HARNESS_ROOT="$PWD" npm run --silent harness -- review auto --run-id <run-id>

# review-decision.yaml を編集 → meta.status を反映
HARNESS_ROOT="$PWD" npm run --silent harness -- review process --run-id <run-id>

# changes_requested を受けて再 run
HARNESS_ROOT="$PWD" npm run --silent harness -- rerun --from-review <run-id>

# レビュー完了後の cleanup
HARNESS_ROOT="$PWD" npm run --silent harness -- cleanup --run-id <run-id> --scope workspace

# knowledge 候補をレビュー → 採用したものを docs/knowledge/ に展開
HARNESS_ROOT="$PWD" npm run --silent harness -- knowledge list --run-id <run-id>
HARNESS_ROOT="$PWD" npm run --silent harness -- knowledge promote --run-id <run-id> --reviewer <name>
```

詳細は [`cli.md`](./cli.md)。
