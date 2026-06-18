# MCP server target spec

Phase 18 exposes `monorepo-harness` to coding agents through a constrained
Model Context Protocol server. The server follows the MCP 2025-11-25 shape:
tools perform actions and filtered queries, resources provide stable context
bodies, and prompts provide user-selected workflows.

This document starts as the Phase 18 target spec. During Phase 18 it is the
accepted implementation contract; at close it becomes the current behavior
spec for the implemented MCP server.

Implementation entry points:

```txt
src/mcp/server.ts
src/mcp/cli.ts
src/mcp/transports/stdio.ts
src/mcp/registry/
src/mcp/tools/
src/mcp/security/
src/mcp/audit/
```

The production transport is stdio. The server must write only JSON-RPC MCP
messages to stdout; diagnostics go to stderr. Streamable HTTP is treated as a
local-only stretch transport and is documented as deferred until implemented.

## Design contract

Default behavior is safe:

```txt
read tools: enabled
dry-run tools: enabled
mutation tools: disabled unless explicitly allowlisted
dangerous tools: confirmation_required
raw shell: never exposed
```

Mutation tools use the shared operation/idempotency/audit wrappers. Guarded data
mutations use `OperationRunner`; bounded driver tools may use `runMcpOperation`
when they need runtime-specific gate checks. MCP is not a privileged side door
around the CLI, dashboard, DB repositories, idempotency ledger, or audit
records.

Hitch-mode agents must also obey the hitch convergence controller documented in
[`hitch-convergence.md`](./hitch-convergence.md). MCP hitch tools record findings,
classification, close checks, and convergence decisions; they do not authorize
unbounded review/fix loops or automatic scope expansion.

Dangerous operations do not complete from a model-controlled MCP tool call.
They return a preview plus `confirmation_required`. Execution happens through
an out-of-band operator action:

```bash
harness operation confirm <confirmation-id> --preview
harness operation confirm <confirmation-id> --yes
harness operation reject <confirmation-id>
```

There is no `harness.operation.confirm` MCP tool; confirmation/rejection is an
out-of-band CLI action.

Confirmation request `input_json` and `preview_json` are stored at rest in their
original form. This is intentional: confirmation replay reparses the stored
arguments and executes the originally requested operation, so insert-time
redaction would make some confirmations impossible or incorrect. Every display
path (`harness mcp confirmations`, `harness operation confirm --preview`,
`harness operation confirm --yes` pre-execution output, and rejection output)
must redact those stored JSON fields before printing them. The raw DB fields are
not a presentation surface.

## Non-goals

```txt
complete sandbox isolation
autonomous worker queue / scheduler
dashboard mutation UI
remote multi-user deployment
OAuth production authorization server
arbitrary shell execution
unlimited agent approvals
automatic merge
full external network policy
server-initiated LLM sampling
```

## Permission config

Config resolution order:

```txt
1. --config <path>
2. .harness/mcp.yaml
3. project profile mcp section
4. built-in safe default
```

When neither `--config` nor `.harness/mcp.yaml` is present, `projects/*.yaml`
files are scanned in deterministic filename order and any top-level `mcp`
section is merged over the safe defaults. A global `.harness/mcp.yaml` remains
the recommended deployment path for shared agent access.

An explicit `--config <path>` is fail-closed: if the file does not exist, the
server/CLI exits nonzero instead of falling back to broader defaults.

**Stale-rename detection (fail-closed)**: loading a `.harness/mcp.yaml` (or a
`projects/*.yaml` `mcp:` section) whose `allowedOperations` / `requireConfirmation`
/ `deniedOperations` still contain a renamed `goal.*` operation (the feature was
renamed `goal`→`hitch` in SP-0) is **refused** with `McpConfigError`. This stops
a stale `requireConfirmation: [goal.close, …]` from silently leaving the renamed
`hitch.close`/`cancel`/`expand_scope` unconfirmed (gate fails open). The snapshot
parser used to re-verify past confirmation records is exempt, so pre-rename
pending confirmations still resolve. Operators must update `goal.*` → `hitch.*` in
their live config.

**`harness onboard` による `.harness/mcp.yaml` の生成**: 新しい target repo をオンボードする
際は `harness onboard --repo <path> --project-id <id>` が `.harness/mcp.yaml` の生成または
merge を自動で行う。mutation は **deny-all がデフォルト**。opt-in すると `guarded-mutation`
クライアントエントリと `allowedOperations`（`hitch.start` / `run.start`）の**両方**を書き込む
（2 段階パーミッションゲート — どちらか一方では不十分）。既存の allow-all 設定
（`allowedProjects: []`）は黙って narrowing しない（wizard が確認を取り、拒否すれば allow-all
を維持する）。詳細は [`cli.md`](./cli.md) の `harness onboard` 節を参照。

`harness mcp config` prints the full effective MCP config as JSON. With
`--client-name <name>`, it prints the effective permission view for that launch
client instead:

```json
{
  "clientName": "claude",
  "clientId": "claude-local",
  "mode": "guarded-mutation",
  "allowedOperations": ["run.start"],
  "requireConfirmation": ["pr.create"]
}
```

Canonical example:

```yaml
version: 1
mcp:
  enabled: true
  defaultMode: dry-run

  clients:
    - id: codex-local
      names: [codex, claude-desktop]
      mode: guarded-mutation

  allowedProjects:
    - mini-commerce

	  allowedOperations:
	    - run.start
	    - review.auto
	    - rerun.start
	    - backlog.create
	    - backlog.run
	    - knowledge.promote
	    - knowledge.reject
	    - hitch.start
	    - hitch.record_findings
	    - hitch.classify_finding
	    - hitch.mark_finding_fixed
	    - hitch.defer_finding
	    - hitch.record_close_check
	    - hitch.check_convergence

  requireConfirmation:
    - review.process
    - cleanup.apply
    - pr.create
    - hitch.close
    - hitch.cancel
    - hitch.expand_scope
    - db.repair.apply
    - db.archive.apply
    - db.migrate_blobs.apply
    - db.gc_blobs.apply

  deniedOperations:
    - db.restore
    - db.vacuum

  limits:
    maxRunsPerHour: 3
    maxConcurrentRuns: 1
    maxToolCallsPerMinute: 60
    maxMutationOperationsPerHour: 10
    maxArtifactBytesPerToolResult: 131072

  resources:
    artifactBody: summary-only
    maxResourceBytes: 262144
    includeSecretSuspect: false

  confirmation:
    ttlSeconds: 900

  audit:
    recordReadTools: false
    recordDryRuns: true
    recordMutations: true
```

`audit.recordMutations` is retained in config for explicitness and future
compatibility. Current Phase 18 behavior records mutation and dangerous tool
invocations regardless of that flag; this is intentional because MCP mutation
audit is part of the safety boundary.

Permission decisions are explicit:

```ts
interface McpPermissionDecision {
  allowed: boolean;
  mode: "read" | "dry-run" | "mutation" | "confirmation-required";
  reason: string;
  requiredConfirmation?: boolean;
  limits?: {
    remainingRunsThisHour?: number;
    remainingToolCallsThisMinute?: number;
  };
}
```

Permission precedence is deterministic:

```txt
1. disabled MCP config and project visibility deny first.
2. deniedOperations always wins.
3. dangerous tools and **non-read** requireConfirmation operations require
   guarded-mutation client mode; read-only/dry-run clients are denied with
   dangerous_disabled_for_client before any confirmation is created. The gate
   applies only when `kind !== "read"`; a read tool listed in requireConfirmation
   is not gated here (the generic confirmation enqueue is mutation-kind only).
4. guarded-mutation clients receive confirmation_required for dangerous tools
   and requireConfirmation operations; confirmation permits preview only.
5. read tools are allowed by mode unless denied/project-scoped out.
6. dry-run tools are allowed for dry-run and guarded clients unless denied/project-scoped out.
7. allowedOperations permits immediate execution for guarded mutation tools.
8. safe default permits read and dry-run, denies immediate mutation.
```

The permission engine normalizes MCP tool names by stripping the `harness.`
prefix. `harness.pr.create` is checked as operation `pr.create`. Exact matches
are used unless a future spec explicitly adds wildcards.

Project visibility (`project_not_allowed`): a project-scoped client
(`allowedProjects` non-empty) must target a `projectId` in that set. The denial
distinguishes two causes (#81): an **unset** projectId returns a
`projectId is required …` summary listing `allowedProjects`, while a
**present-but-not-allowed** projectId keeps the `project_not_allowed` summary;
both carry `reason: "project_not_allowed"`, `allowedProjects`, and an actionable
`hint`. `harness.hitch.start` additionally **derives** the projectId from a
supplied `repoId` when the repo maps to exactly one project — an ambiguous (0 or
>1) mapping is never guessed (fail-closed) and falls through to the
`projectId is required` denial. A derived projectId is persisted on the hitch.

`requireConfirmation` is not an execution allowlist. A dangerous operation that
appears only in `requireConfirmation` may create a preview and pending
confirmation request, but cannot execute until out-of-band confirmation reruns
the permission check and validates that the operation is still not denied.

Permission identity is launch-controlled and is never overwritten by MCP
`initialize.clientInfo`. Resolution order:

```txt
1. --client-name
2. MCP_CLIENT_NAME
3. unknown
```

`initialize.clientInfo.name/version` are stored only as reported client
metadata for audit/display. They do not select named client config and cannot
upgrade permission mode. Audit actors use:

```txt
actor = mcp:<client-name>
source = mcp
```

## Tool result envelope

All tools return a structured envelope. Human-readable `content` mirrors the
same status and summary; `structuredContent` contains the typed result.

```ts
interface HarnessMcpToolResult<T> {
  status:
    | "ok"
    | "dry_run"
    | "queued"
    | "operation_started"
    | "confirmation_required"
    | "permission_denied"
    | "error";
  summary: string;
  data?: T;
  operationId?: string;
  confirmationId?: string;
  resourceLinks?: Array<{
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
  }>;
  warnings?: string[];
  nextActions?: Array<{
    label: string;
    tool?: string;
    arguments?: Record<string, unknown>;
    command?: string;
  }>;
}
```

`confirmation_required` is a valid business result and is not a protocol
error.

## Tool catalog

Tool names are dot-separated ASCII names.

Read-only tools:

```txt
harness.project.list
harness.project.get
harness.project.inspect
harness.domain.list
harness.policy.get_effective
harness.policy.snapshot.get
harness.run.list
harness.run.get
harness.run.timeline
harness.run.artifacts
harness.run.artifact.get
harness.review.queue
harness.review.proposals
harness.review.consensus
harness.hitch.list
harness.hitch.get
harness.hitch.status
harness.hitch.findings
harness.hitch.decisions
harness.backlog.list
harness.backlog.get
harness.knowledge.search
harness.knowledge.get
harness.ops_knowledge.search
harness.ops_knowledge.get
harness.db.status
harness.doctor.summary
harness.release.plan
harness.inbox
harness.metrics
harness.operation.list
harness.operation.get
harness.workspace.list
harness.workspace.status
harness.workspace.checkpoint
harness.course.list
harness.course.get
harness.course.status
harness.phase.list
harness.phase.get
```

`harness.doctor.summary`（read）は最新 doctor run の header
（doctorRunId / startedAt / completedAt / status / summary）を返す。`allowedProjects`
が空の global client には `doctor_findings` の詳細（findingId / checkId / message /
details / repairable）も従来どおり返す。`allowedProjects` が非空の project-scoped client
では finding→project を決定論的に解決できないため、fail-closed で詳細を伏せる:
`data.findingsRedacted: true`、`data.reason: "project_scoped_client"` を付け、
`latest.findings` は `{severity,status,count}` の集計だけを返す。

`harness.workspace.status`（read）は **1 repo 分**の workspace の **git-inclusive status**
を返す。`repoPath` ＝ **追跡中の worktree path**（`workspace.list` の `worktree_path`）
**またはその配下の subpath**（worktree 内の subdir/file）。一致は純 fs の path 判定のみ
（git は使わない）で、**未知の任意 path で git を実行しない**安全策＝harness が追跡している
repo（workspace 行が 1 つ以上）に限定。CLI の `workspace status` と同じ shape（progress
label + git state(dirty/ahead-behind) + linked hitch + heartbeat）。read tool だが worktree
内で **read-only git**（worktree list / status / rev-list / diff）を回す（提供 path が
stale でも、同 repo の実在 worktree を git cwd に選んで status を組む）。`allowedProjects`
で scope（`workspace.list` と同様）。**scope 外の workspace に当たる path は、未知 path と
同一の "not tracked" エラー**で弾く（scope 所属を漏らさない）。

`harness.workspace.list`（read）は agent workspace の coordination view（DB index）を
返す: agent / branch / worktree_path / linked hitch とその convergence decision /
objective / heartbeat / last checkpoint。`agent` で絞り込み可。**read tool なので既定で
許可**（allowlist 不要）。`allowedProjects` で scope された client には、**linked hitch の
project_id がその集合に入る workspace のみ**返す（unlinked / dangling は project 不明なので
restricted client では fail-closed で除外）。**git state（dirty / ahead-behind）は含めない**。**`harness.workspace.checkpoint`（mutation）** は workspace に advisory checkpoint
（note + hitch link + objective）を記録し heartbeat を更新する **DB-only mutation**（git
スナップショットなし）。`operation = workspace.checkpoint` を **allowlist 必須**（mutation
の既定 deny）・guarded-mutation mode 必須。idempotencyKey で冪等・operation audit に記録・
`allowedProjects` で scope（workspace の hitch project 不可なら deny）。advisory なので
**confirmation は不要**。

**`harness.workspace.inspect` / `harness.workspace.conflicts` / `harness.workspace.recover`
（read）** は git-inclusive な read tool（`workspace.status` と同じ DB-first ガードを共有・
`src/mcp/tools/workspace-tracked-repo.ts`）。`repoPath` は追跡中の worktree path またはその
subpath で、未知 path で git を実行しない。
- **inspect**（per-agent）— 1 agent の決定論 git ブリーフィング（branch / HEAD / dirty /
  ahead-behind / 最終コミット）。対象 agent が scope 外/不在なら「not found」（scope を漏らさない）。
- **conflicts**（per-repo）— 全 workspace の変更ファイル重複 pre-check（committed-ahead ∪
  uncommitted）。**in-scope の workspace のみ** inspect・報告する。
- **recover**（per-agent）— git ブリーフィング ＋ linked hitch の convergence から決定論的な
  next-steps を再構成（checkpoint narrative は advisory 文脈で next-steps の根拠にしない＝§0）。

これらは read なので **allowlist 不要**（既定許可）・`allowedProjects` で scope。**read-only git**
のみ（worktree list / status / rev-list / diff）。

mutating な **create / remove / adopt**（worktree lifecycle）は **CLI 専用**。create/remove は
filesystem の git worktree を破壊的に操作する。**adopt** も MCP では出さない（2026-06 判断）:
クライアント指定 path で server-side git を走らせること（path 探知の surface）になり、かつ
adopt 直後の workspace は hitch/project 未紐付けで `allowedProjects` scope が定まらないため、
read tools の DB-first ガードや mutation の project scope と整合しない。worktree の作成・登録・
削除は人間/CLI 側に留める（[`cli.md`](./cli.md#harness-workspace)）。observability（inspect /
conflicts / recover / status / list）と advisory checkpoint は MCP で提供済み。
**`pr request-review`**（Copilot review リクエスト）も同様に **CLI 専用**: best-effort・非 gating
だが gh を client 指定 path で実行し最大 timeout 秒ブロックして poll するため、bounded な MCP
mutation として出す価値が低い（必要なら結果待ちなしの fire-and-forget 版を follow-up で検討）。

**`harness.inbox` / `harness.metrics`（read）** は DB read model の集計（git/fs アクセス
なし）。`harness.inbox` は「今見るべき run」＝needs_review / changes_requested / failed ＋
knowledge-candidate run 数 ＋ **operational 知識**の slice（`operationalKnowledge.total` ＋
最近エントリ `recent`、issue #57。reference material であり action queue ではない）。
（**時間窓なし**＝現在の actionable 状態。knowledge bucket が窓非対応のため `sinceHours` は
出さない。operational は project/repo scope に **portable entry も含めて** 集計）。
`harness.metrics` は run 件数（status 別）＋ review approved-rate（DB read-model の
`metricsSummary`。`oneShotApprovalRate` / `policyViolationRate` /
`secretSuspectRate` / `lockContentionCount` を含む。D1 KPI の式は [`cli.md`](./cli.md) の
`harness metrics` 節を正規定義とし、MCP でも同じ定義を使う）をトップレベルに返し、
追加で `usage`（`DbTokenUsageSummary`: v30 の per-invocation `run_usage` を集計し、
`exact` token 合算・`runsWithUsage`（`COUNT(DISTINCT run_id)`）・`usage_source` 別件数に加え、
`byKind`（coder / reviewer / evaluator）内訳を持つ。式は [`cli.md`](./cli.md) の
`harness metrics` 節を正規定義とする）と `hitch`
（`DbHitchMetricsSummary`: session status / review-cycle / rerun / finding severity /
resolution / reopen KPI）を返す。`allowedProjects` が空の unrestricted client には
`mcpConfirmations`（`DbMcpConfirmationSummary`: confirmation / expired KPI）も返す。
`mcp_confirmation_requests` は project 列を持たない global table なので、
project-restricted client（`allowedProjects` 非空）では fail-closed で
`mcpConfirmations` フィールド自体を返さない。同じく `domain_lock_contention` は
`project_id` 列を持たず project scope を決定論的に適用できないため、
project-restricted client では fail-closed で `lockContentionCount` フィールド自体を返さない。
`hitch` は呼び出し元の `projectId` / `repoId` / `domain` / `sinceHours` scope を伝播し、
unrestricted client の `mcpConfirmations` は global 値で、`sinceHours` 由来の since のみ伝播する
（project / repo / domain filter は非適用）。`confirmationRate` は
`(confirmed + consumed) / (confirmed + consumed + rejected + expired)`、`expiredRate` は
`expired / (confirmed + consumed + rejected + expired)`。分母 0 は `null`。stored `pending` かつ
`expires_at <= 集計時刻` の request は read-only に effective `expired` として byStatus / rate
へ入れ、DB には書き戻さない。絞り込みは
inbox=`projectId`/`repoId`/`domain`、metrics=それ＋`sinceHours`。
`sinceHours` の対象列は、runs 指標は `runs.started_at`、hitch 指標は
`hitch_sessions.created_at`、MCP confirmations は
`mcp_confirmation_requests.created_at`。**scope**: `allowedProjects` が空（unrestricted）なら
repo 横断、restricted なら `projectId` がその集合に入る必要がある（未指定時は allowed が
1 つなら既定、複数なら `project_required` で deny＝単一 projectId 集計で部分集合を跨がない
fail-closed）。

`harness.knowledge.get` tool results omit entry body by default and include a
capped body only when `includeBody` is true. `harness://knowledge/{entryId}`
resources may include the body, capped by `resources.maxResourceBytes`.

**`harness.ops_knowledge.search` / `harness.ops_knowledge.get`（read、issue #57）**
は **operational 知識**（codebase ではない toolchain / CI / 環境 / harness 運用の学び、
`knowledge_entries.category='operational'`）の recall surface。`harness.knowledge.*`
が codebase 専用なのに対しこちらは operational 専用で、両者は相互に混ざらない（codebase
ツールは operational を返さず、ops ツールは codebase を返さない＝SP1 の fail-closed 境界）。
scope は codebase knowledge と同じ: `allowedProjects` が project 付き entry の可視性を
絞り、**portable（project 無し）entry は常に可視**。`search` は `query`（title/body/
entryId の部分一致）/ `projectId` / `repoId` / `domain` / `includeDeprecated`（既定 false）/
`limit` を取り body を含まない summary を返す。`get` は body を既定で省略し `includeBody`
時のみ capped body を返す（disallowed project の entry は `permission_denied`、不在 /
codebase id は not-found）。CLI からも著述できる（[`harness knowledge ops add`](./cli.md#harness-knowledge-ops)）。

**`harness.ops_knowledge.record` / `harness.ops_knowledge.deprecate`（mutation、issue #57）**
は operational 知識を MCP から著述 / deprecate する **guarded mutation**。`kind:"mutation"`
なので **`guarded-mutation` モード ＋ `allowedOperations` に `ops_knowledge.record` /
`ops_knowledge.deprecate`** が無いと拒否（`mutation_disabled_for_client` /
`operation_not_allowlisted`）。OperationRunner 経由で **idempotency（`idempotencyKey` 必須）/
audit ledger / budget** が効く。actor は `mcp:<clientName>`。`record` は `title` / `body` /
**`key` 必須**（→ 実在の `ops/<key>` を target に。再記録は同一 entry を更新・body 不変なら
no-op）＋ `kind` / `tags` / `project`/`repo`/`domain` scope / `reason`。append-only で
低リスクのため既定で confirmation は不要。

**restricted client の scope（重要）**: `allowedProjects` が非空のクライアントは、
operational write を **自分の許可 project に限定**される — **portable（project 無し）の
record / deprecate は拒否**（portable は全 reviewer scope に注入されるグローバル変更のため）し、
既存 `ops/<key>` が portable / 他 project の場合も拒否（hijack 防止）。`allowedProjects` が
空（unrestricted）なら portable も可。

**`harness.release.plan`（read）** は `harness release plan`（[`release.md`](./release.md)）の
MCP 露出。MCP 駆動エージェントが版上げの readiness + 互換性レポート（推奨 bump / schema
delta・no-downgrade / 追加・削除された CLI+MCP surface / 未宣言の破壊的変更）を直接取得できる。
read-only（git の rev-parse/show/log と source 読み取りのみ。DB / mutation 無し）。`since` /
`to`（既定: 直近 tag .. HEAD）。**解析対象は常に `harnessRoot`**（client が任意のローカル
リポジトリ path を渡せると read 境界を破るため `repo` 引数は無し。別リポジトリの解析は CLI
`--repo`）。ref 解決不能は `error`。**bump / CHANGELOG / tag は release-please の担当**。

**`harness.course.list` / `harness.course.get` / `harness.course.status` /
`harness.phase.list` / `harness.phase.get`（read、SP-1）** は course → phase ロードマップ層の
read surface。データモデル・ロールアップ仕様は [`roadmap.md`](./roadmap.md)。

- `course.list`: `status?` / `projectId?` / `limit?`（既定 50）。
  project-restricted client（`allowedProjects` 非空）は allowed projects の course のみ表示。
  **null-`project_id` course は project-restricted client に fail-closed invisible**。
  explicit `projectId` は事前に visibility check。
- `course.get`: `courseId`。不可視なら `permission_denied`。
- `course.status`: `courseId`。course + `rollupCourse` 出力（phase ツリー全体の derived open
  P0/P1 ＋ course 合計）。ツリーが不整合（cycle / orphan）なら `error`。
- `phase.list`: `courseId`。親 course 経由で visibility check。phase 一覧（position/id 順）。
- `phase.get`: `phaseId`。親 course 経由で visibility check。

すべて read tool なので allowlist 不要。`allowedProjects` が空（unrestricted）なら全 course 可視。

**`harness.course.create` / `harness.course.orchestrate` / `harness.phase.add` /
`harness.phase.update` / `harness.phase.link_hitch`（guarded mutation、SP-1/SP-2）**
は course → phase の構造変更・drive surface。
`guarded-mutation` モード ＋ `allowedOperations` への operation key 追加が必須（deny-by-default）。
`idempotencyKey` 必須。`course.create` / phase mutation は `OperationRunner` 経由で idempotency
ledger / operation audit / mutation budget が効く。`course.orchestrate` は hitch 版同様
`runMcpOperation` 経由で 1 pass を監査し、per-hitch gate / repo 解決を runtime 側で行う。
confirmation は不要（PR を開かず、hitch/phase close もしない bounded drive）。

| Tool | Operation key | 主な制約 |
|------|---------------|---------|
| `harness.course.create` | `course.create` | `projectId` を `ensureProjectVisible` で事前チェック |
| `harness.course.orchestrate` | `course.orchestrate` | `courseId`, `maxDrivenHitches?`, `maxStepsPerHitch?`, `idempotencyKey`, `actorNote?`。親 course の visibility を事前チェック。`maxDrivenHitches` は既定 3 / 最大 10、`maxStepsPerHitch` は既定 20 / 最大 50 に clamp。course-pass lease `course:<id>` を使い、PR は開かない |
| `harness.phase.add` | `phase.add` | 親 course の visibility を `OperationRunner` 前に確認。cross-course parent は拒否。`scope` / `closeConditions` は `PhaseRepository.add()` の parser/validator を通る |
| `harness.phase.update` | `phase.update` | 親 course 経由で visibility 確認。`status` のみ更新（SP-1） |
| `harness.phase.link_hitch` | `phase.link_hitch` | cross-project mismatch と double-link（PK）は操作内で拒否 |

project-restricted client の scope: null-`project_id` course の create / orchestrate / phase 操作は拒否。

Dry-run tools:

```txt
harness.project.check
harness.run.dry_run
harness.cleanup.dry_run
harness.pr.preview
harness.db.repair.dry_run
harness.db.archive.preview
harness.db.migrate_blobs.preview
harness.db.gc_blobs.preview
```

Guarded mutations:

```txt
harness.run.start
harness.review.auto
harness.rerun.start
harness.backlog.create
harness.backlog.run
harness.backlog.update
harness.knowledge.promote
harness.knowledge.reject
harness.hitch.start
harness.hitch.record_findings
harness.hitch.classify_finding
harness.hitch.mark_finding_fixed
harness.hitch.defer_finding
harness.hitch.record_close_check
harness.hitch.check_convergence
harness.hitch.orchestrate
harness.course.create
harness.course.orchestrate
harness.phase.add
harness.phase.update
harness.phase.link_hitch
```

`harness.hitch.orchestrate` is a **bounded driver** for the hitch convergence
loop. It advances a hitch a capped number of orchestrator steps (coder rerun ->
review / command close-check -> convergence) and **halts at `close_ready`
without opening a PR or closing the hitch** (`stopAtCloseReady`) — opening the
PR / closing stays a deliberate, separately-confirmed step (CLI
`harness hitch orchestrate`). Args:
`hitchId` (required), optional `maxSteps` (1-50, default 20). The target repo is
resolved **server-side** from the hitch's own project/domain via
`prepareProjectRun` — the tool never accepts a client-supplied repo path. The
convergence gate permits the driver at **entry** when a per-step mutation would
be permitted (`needs_fix`+`fix_findings`/`run_close_check`, or
`continue`+`run_review`) or when the next step is an internal deterministic
command close-check (`continue`+`run_close_check`); a `close_ready`, terminal,
`defer_followups`, or classification decision denies the driver from *starting*
(an operator drives those out of band). Once started, the orchestrator
re-evaluates convergence each step and may run `classify`/`defer`/allowlisted
command-close-check steps within its bounded budget — those are deterministic
harness-side bookkeeping (no LLM-driven state transition) — and still halts at
`close_ready` without opening a PR. Hitches with no
`projectId`/`domain` are rejected. Each internal coder/review step re-checks its
own convergence gate. Adding this tool requires a `serve` restart to take
effect.

`harness.run.start`, `harness.review.auto`, `harness.rerun.start`, and
`harness.review.process` also accept optional `hitchId`. When present, the tool
validates the hitch's project/repo/domain boundary against the target project or
run and writes hitch attempt/review-cycle records after the operation succeeds.
A project-scoped or domain-scoped hitch is rejected for an unscoped or mismatched
run. For `review.process` in consensus mode, the hitch review import uses the
same DB-canonical consensus selector as the orchestrator path after processing;
it does not import the participant proposal that happened to be bound at
confirmation time. If the active consensus row is malformed or references a
missing proposal, the mutation fails closed instead of falling back to the latest
processed participant proposal.

Dangerous mutations, confirmation-required by default:

```txt
harness.review.process
harness.cleanup.apply
harness.pr.create
harness.hitch.close
harness.hitch.cancel
harness.hitch.expand_scope
harness.db.repair.apply
harness.db.archive.apply
harness.db.migrate_blobs.apply
harness.db.gc_blobs.apply
```

Dangerous tools are not opened by `allowedOperations`; they can only reach their
handler-side confirmation preview when the effective client mode is
`guarded-mutation`. `read-only` and `dry-run` clients fail at the permission
layer before the handler can create a confirmation request. Confirmation replay
uses the stored permission snapshot and re-runs the same permission decision
before executing the handler, so a read-only/dry-run snapshot cannot be executed
out of band.

Disabled:

```txt
harness.db.restore
harness.db.vacuum
harness.shell.exec
```

`harness.shell.exec` is never implemented.

## Key tool contracts

`harness.project.list`

Input:

```json
{
  "includeArchived": false
}
```

Output:

```json
{
  "projects": [
    {
      "projectId": "mini-commerce",
      "repoId": "mini-commerce",
      "currentProfileRevisionId": 12,
      "domains": ["catalog", "checkout"],
      "health": "ok"
    }
  ]
}
```

`harness.run.list`

Input:

```json
{
  "projectId": "mini-commerce",
  "domain": "catalog",
  "statuses": ["needs_review"],
  "limit": 20,
  "cursor": null
}
```

Output includes a stable pagination cursor when more rows are available.

`harness.run.get`

Input:

```json
{
  "runId": "run-...",
  "includeArtifacts": true,
  "includeTimeline": false
}
```

Output returns a concise run summary plus resource links for timeline,
artifacts, and review context. Artifact bodies are not embedded by default.

`harness.run.dry_run`

Input:

```json
{
  "projectId": "mini-commerce",
  "domain": "catalog",
  "goal": "Add product search filter",
  "contextPack": "default"
}
```

Output includes the selected project profile revision, effective policy
snapshot, candidate commands, domain lock availability, estimated context pack
files, and a would-run summary. It does not mutate canonical state except
optional audit.

`harness.run.start`

Input:

```json
{
  "projectId": "mini-commerce",
  "domain": "catalog",
  "goal": "Add product search filter",
  "hitchId": "hitch-...",
  "idempotencyKey": "uuid"
}
```

Requires `run.start` allowlist, project allowlist, budget availability, and an
idempotency key. It returns `operation_started` with `operationId` and `runId`
when execution starts.
If `hitchId` is supplied, the operation metadata includes `hitchId` and `hitch_id`
and `hitch_attempts` receives an `implement` attempt linked to the resulting run.

`harness.review.auto`

Input:

```json
{
  "runId": "run-...",
  "hitchId": "hitch-...",
  "reviewer": "codex-reviewer",
  "idempotencyKey": "uuid"
}
```

Allowed only for runs in `needs_review` or `changes_requested`, after resolving
the run's project and applying project allowlist and `review.auto` allowlist.
If `hitchId` is supplied, the review attempt is linked to the latest hitch attempt
for the same run and reuses that iteration so review-only bookkeeping does not
consume implementation budget.

`harness.rerun.start`

Input:

```json
{
  "runId": "run-...",
  "hitchId": "hitch-...",
  "idempotencyKey": "uuid"
}
```

When linked to a hitch, the generated child run is recorded as a `rerun` attempt
with the parent run attempt as `parentAttemptId` when available.

`harness.review.process`

Input:

```json
{
  "runId": "run-...",
  "hitchId": "hitch-...",
  "decision": "approved",
  "proposalId": 123,
  "sourceSha256": "...",
  "idempotencyKey": "uuid"
}
```

Default result is `confirmation_required`. The preview must include the target
proposal, stale proposal status, source hash, and exact operation that would be
executed. If `proposalId` is omitted, preview binds the latest active proposal
into the stored confirmation input. Confirm revalidates the same proposal id
and `sourceSha256`, then uses the normal proposal-processing path. MCP
`review.process` does not use the human override path.
If `hitchId` is supplied, confirmed execution imports the exact proposal into
`hitch_review_cycles` / `hitch_findings`, records a `review_consensus` close check
when the hitch requires one, and records a convergence decision. Negative
decisions with no explicit required changes become an in-scope P1 blocker.
Reviewer non-blocking comments that only report tests/checks were not run or
that command logs/output are missing are returned under
`hitchIntegration.reviewAdvisories` and copied into
`hitch_close_checks.evidence.reviewerAdvisories`; they are not imported as
`hitch_findings` and therefore do not trigger `needs_classification` or
escalation by themselves. A passed `review_consensus` close check means static
review consensus approved the run. It is not test execution evidence; MCP
clients that need a test gate should start the hitch with a normal `command`
close condition. `harness.hitch.orchestrate` may satisfy that condition by
running the matching effective domain-policy command allowlist entry and writing
evidence to `hitch_close_checks` plus `runs/<runId>/close-checks/`. If the
condition does not resolve to exactly one allowlisted command, no command is
run and the hitch escalates for external evidence.

`harness.review.consensus` returns the persisted `review_consensus` row without
introducing extra enum values. The `active` row is returned raw, so parse
`active.summaryJson` for its `semantics` field; `history` entries are already
parsed, so read `history[].summary.semantics`. `approved` means static review
passed and `testsExecutedByConsensus=false`.

Hitch tools:

```txt
harness.hitch.start
harness.hitch.record_findings
harness.hitch.classify_finding
harness.hitch.mark_finding_fixed
harness.hitch.defer_finding
harness.hitch.record_close_check
harness.hitch.check_convergence
harness.hitch.close
harness.hitch.cancel
harness.hitch.expand_scope
```

All hitch mutation tools use `OperationRunner`, require idempotency keys, and
write operation audit metadata with `hitchId`/`hitch_id` where a hitch is known.
`hitch.close` is executable without confirmation only when convergence is
`close_ready`; forced close, cancel, and scope expansion are always
confirmation-required. `harness.hitch.expand_scope` merges the requested scope
and then calls `HitchRepository.updateSessionConfig()` with explicit
`allowScopeWiden`, so it inherits the shared parser/validator, widening gate, and
`updated` lifecycle audit instead of writing `scope_json` directly.

`harness.hitch.classify_finding` does **NOT** run the deliberation jury (#230,
design §0.1 R13). It is the operator-manual scope-write path: the handler takes
`scopeStatus` straight from the caller and calls `repo.classifyFinding`, never
`deliberate()`. The 5-stage jury (`src/hitch/jury/`) runs **only** inside the
orchestrate-driven classify runner (`harness hitch orchestrate` /
`harness.hitch.orchestrate`), which alone supplies the reviewer runner, run
worktree, and audit context the jury needs (see `docs/specs/workflow.md`
"finding 分類"). When a `record_findings` call omits `scopeStatus`, the only
machine classification applied is the deterministic **heuristic**
(`classifyFindingForHitch`) — still no jury. Operator override of a jury- or
heuristic-assigned classification therefore goes through `classify_finding` as a
**guarded mutation**: it requires `guarded-mutation` client mode, runs under
`OperationRunner` with the stored permission snapshot, and is recorded in the
operation audit. It is NOT a shell bypass of harness state transitions — the
classification write is the harness's deterministic `repo.classifyFinding`, and
the safety boundary (state transitions are harness-only; LLM output never drives
status) holds for the override as for every other path.

When `harness.hitch.start` omits an explicit `hitchId`, the deterministic
default id is derived from the tuple `[projectScope, idempotencyKey]` using
SHA-256 and the `hitch-` prefix. `projectScope` is the effective project id
after repoId-to-project derivation for project-restricted clients; when no
project id is known, the scope is `null`. The `null` scope is intentional:
repoId-only/global hitches with the same idempotency key replay within the same
null-project scope, while project-scoped hitches cannot replay across different
projects. The tuple is JSON-encoded before hashing, so `null` and `""` scopes
remain distinct.

Compatibility note for upgrades: this scoped derivation replaced the earlier
key-only `hitch.start` derivation. A retry that crosses the upgrade boundary
with the same idempotency key but without an explicit `hitchId` may derive a
different hitch id and create a new hitch. Callers that need replay continuity
across the upgrade should provide an explicit `hitchId`.

`harness.cleanup.apply`, `harness.pr.create`, `harness.db.repair.apply`,
`harness.db.archive.apply`, `harness.db.migrate_blobs.apply`, and
`harness.db.gc_blobs.apply` also return `confirmation_required` by default for
guarded-mutation clients and must have corresponding preview/dry-run paths.

`harness.pr.create` preview and execution both use the run row's `base_branch`
and draft mode. Confirm rejects stale confirmations if the run base branch has
changed since preview.

`harness.db.archive.apply` creates a copy-only full DB archive, so it requires
global MCP scope (`allowedProjects: []`). Project-scoped clients may preview
scoped archive candidates, but apply returns `permission_denied`.
The confirmation preview is bound to the exact copy target and includes
`operation: "db-archive-copy"`, `mode: "copy-only-full-db"`, `outPath`,
`defaultOutPath`, `willCopyFullDb: true`, and
`candidateRunsAreInformational: true`. `before` is stored as archive
`rangeEnd` metadata only; it does not filter the rows copied into the archive.
MCP-requested archive output paths must resolve under `.harness/archives`.

`harness.db.migrate_blobs.apply` is also global-scope only because blob
migration can move artifact bodies across projects. Project-scoped clients may
call the preview tool, but apply returns `permission_denied`.

`harness.db.gc_blobs.apply` is also global-scope only because unreferenced
external blob rows are not project-scoped. Project-scoped clients may call the
preview tool, but it returns warnings and no apply `nextActions`.

## Resources

Resources use stable `harness://` URIs.

```txt
harness://project/{projectId}
harness://project/{projectId}/profile
harness://project/{projectId}/policy/effective
harness://run/{runId}
harness://run/{runId}/timeline
harness://run/{runId}/review
harness://run/{runId}/artifacts
harness://artifact/{artifactIdBase64}
harness://backlog/{itemId}
harness://knowledge/{entryId}
harness://db/status
harness://doctor/latest
harness://operation/{operationId}
```

Resource templates:

```txt
harness://run/{runId}
harness://run/{runId}/artifact/{relativePath}
harness://project/{projectId}/domain/{domain}
harness://knowledge/search/{query}
```

Resource policy:

```txt
metadata: returned as JSON/text
artifact body: capped by maxResourceBytes
binary: never embedded, summary only
secret_suspect: redacted unless explicitly allowed
subscriptions: deferred
```

Every resource read is permission-checked. Resource handlers must:

```txt
resolve resource -> run/project/backlog/knowledge/operation row
apply allowedProjects to the resolved project when a project can be derived
apply artifactBody mode before returning artifact content
reject absolute paths, parent traversal, and empty relativePath values
resolve artifactIdBase64 only as an artifact identifier, never as a filesystem path
return permission_denied rather than falling back to file reads outside DB metadata
```

Resources that cannot be mapped to an allowed project are denied unless they
are global doctor/DB metadata resources and the corresponding read operation is
allowed.

## Prompts

Prompts are user-controlled templates. The server never initiates sampling.

```txt
harness.prompt.inspect_project
harness.prompt.plan_backlog_item
harness.prompt.review_run
harness.prompt.summarize_run
harness.prompt.prepare_rerun
harness.hitch.convergence
harness.hitch.review-findings
harness.hitch.close-check
```

Hitch prompts carry additional rules:

```txt
harness.hitch.convergence:
  read the hitch session, findings, close checks, and decisions; recommend the
  next action without expanding scope

harness.hitch.review-findings:
  classify findings before fixing; new unrelated delta/close findings default
  out_of_scope; stop on unknown scope

harness.hitch.close-check:
  check original close conditions only; stop on confirmation_required and run
  harness.hitch.check_convergence after recording evidence
```

## Confirmation workflow

Schema:

```sql
CREATE TABLE mcp_confirmation_requests (
  confirmation_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  actor TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  input_json TEXT NOT NULL,
  preview_json TEXT NOT NULL,
  permission_snapshot_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','confirmed','rejected','expired','consumed')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  confirmed_by TEXT,
  confirmed_at TEXT,
  consumed_operation_id TEXT,
  error_message TEXT
);
```

Dangerous tool behavior:

```txt
tool call
  -> permission decision requires confirmation
  -> build preview
  -> insert mcp_confirmation_requests
  -> return status=confirmation_required
```

Confirm behavior:

```txt
CLI confirm
  -> validate pending and not expired
  -> rerun permission check using permission_snapshot_json captured at preview time
  -> execute OperationRunner
  -> mark request consumed on success or handler failure
```

Rejected, expired, and consumed requests cannot be replayed.
If a confirmed handler throws before returning a structured tool result, the
request is consumed with a redacted `error_message` so it does not remain stuck
in the intermediate `confirmed` state.

Confirmation `input_json` and `preview_json` are stored raw because
out-of-band execution must replay the exact requested operation. The MCP
permission snapshot is also stored raw so `harness operation confirm` cannot
fall back to a different config than the server that created the preview.
Listing APIs and CLI output do not expose raw payloads: `harness mcp
confirmations --json`, `harness operation confirm --preview`, and
`harness operation reject` return redacted JSON for input and preview fields,
and omit the internal permission snapshot. `harness operation confirm <id>`
prints the redacted preview and requires `--yes` before executing.

Phase 18 does not implement crash recovery for rows left in `confirmed` by a
process kill between mark-confirmed and consume/fail, nor does it intersect
stored permission snapshots with later live config denies. These are Phase
19/20 operator tooling candidates: doctor detection for stale confirmed rows,
manual mark-failed recovery, and live-deny or reject-all-pending workflows.

## Audit

Schema:

```sql
CREATE TABLE mcp_sessions (
  session_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  client_version TEXT,
  transport TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  permission_snapshot_json TEXT NOT NULL,
  reported_client_name TEXT,
  reported_client_version TEXT
);

CREATE TABLE mcp_tool_invocations (
  invocation_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  arguments_sha256 TEXT NOT NULL,
  arguments_redacted_json TEXT,
  result_status TEXT NOT NULL,
  operation_id TEXT,
  confirmation_id TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error_message TEXT,
  FOREIGN KEY(session_id) REFERENCES mcp_sessions(session_id)
);
```

Audit defaults:

```txt
read: optional, default false
dry-run: default true
mutation: always
confirmation: always
```

Invocation arguments are hashed before redaction and redacted before storage.
Redaction covers sensitive key names (`token`, `password`, `credential`,
`apiKey`, `idempotencyKey`, etc.) and high-signal secret-shaped string values
using the same secret scanner used for run artifacts. Stored invocation
`error_message` values and list-time invocation output are also redacted so
old rows and error paths do not become a bypass.

The stable `arguments_sha256` is for local audit correlation. A future remote
or multi-user deployment should replace it with an HMAC using a DB-external
audit secret so low-entropy argument values cannot be used as a hash oracle.

Audit/confirmation redaction is a leak-prevention heuristic, not a full DLP
system. It intentionally prioritizes high-signal secrets while preserving
enough context for local debugging.

## Idempotency

Every mutation input requires `idempotencyKey`:

```ts
interface MutationArgsBase {
  idempotencyKey: string;
  actorNote?: string;
}
```

Scope is:

```txt
operation_type + target_id + idempotency_key
```

Same key semantics are inherited from `OperationRunner`: success replays the
prior result, running returns conflict, failed/cancelled returns the prior
failure and requires a new key to retry.

For create-style MCP tools whose target id is derived from the idempotency key,
the target id must include the resource scope before it reaches
`OperationRunner`, because the ledger key above has no project/client dimension.
`harness.hitch.start` and `harness.course.create` scope by effective project id
with `null` for intentionally projectless resources; `harness.phase.add` scopes
by parent course id. Scope and key are hashed as JSON `[scope, key]`, not as a
string-joined pair, so separator injection cannot collapse two different
tuples.

## Error handling

Protocol errors are reserved for malformed JSON-RPC, unknown methods where the
protocol requires it, or invalid MCP framing.

Tool execution errors use the envelope:

```json
{
  "status": "permission_denied",
  "summary": "Operation pr.create requires confirmation",
  "data": {
    "operation": "pr.create",
    "reason": "external_side_effect"
  }
}
```

Malformed tool arguments return `isError: true` with the same envelope shape.
Business responses such as `confirmation_required` return `isError: false`.

## Close criteria

```txt
harness mcp serve works as a stdio MCP server
tools/list, resources/list, prompts/list work
read tools return DB canonical data
dry-run tools do not mutate canonical state
mutation tools use OperationRunner
default mode is read-only + dry-run only
permission config supports project/operation allowlists and rate limits
mutation tools require idempotencyKey
dangerous tools default to confirmation_required
out-of-band confirmation CLI exists
MCP mutation and confirmation audit are recorded
artifact/resource output respects size caps and redaction
no raw shell tool exists
malformed input returns structured errors
fixture matrix passes
npm run typecheck and npm test pass
```

## Phase 18-0 acceptance

```txt
docs/specs/mcp.md exists as the Phase 18 target spec
tool list, resource URI list, and prompt list are explicit
dangerous operation classification is explicit
permission precedence is explicit
resource access is covered by permission and path-safety requirements
```
