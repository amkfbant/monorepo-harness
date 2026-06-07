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

All mutation tools use `OperationRunner`. MCP is not a privileged side door
around the CLI, dashboard, DB repositories, idempotency ledger, or audit
records.

Goal-mode agents must also obey the goal convergence controller documented in
[`goal-convergence.md`](./goal-convergence.md). MCP goal tools record findings,
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

`harness.operation.confirm` is not listed as an MCP tool by default. If it is
ever exposed, it requires an explicit `allowAgentConfirm` config setting and
the same audit trail as other mutations.

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
	    - goal.start
	    - goal.record_findings
	    - goal.classify_finding
	    - goal.mark_finding_fixed
	    - goal.defer_finding
	    - goal.record_close_check
	    - goal.check_convergence

  requireConfirmation:
    - review.process
    - cleanup.apply
    - pr.create
    - goal.close
    - goal.cancel
    - goal.expand_scope
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
    requireOutOfBand: true
    allowAgentConfirm: false

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
1. deniedOperations always wins.
2. requireConfirmation returns confirmation_required and permits preview only.
3. read tools are allowed by mode unless denied/project-scoped out.
4. dry-run tools are allowed for dry-run and guarded clients unless denied/project-scoped out.
5. allowedOperations permits immediate execution for guarded mutation tools.
6. safe default permits read and dry-run, denies immediate mutation.
```

The permission engine normalizes MCP tool names by stripping the `harness.`
prefix. `harness.pr.create` is checked as operation `pr.create`. Exact matches
are used unless a future spec explicitly adds wildcards.

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
harness.goal.list
harness.goal.get
harness.goal.status
harness.goal.findings
harness.goal.decisions
harness.backlog.list
harness.backlog.get
harness.knowledge.search
harness.knowledge.get
harness.db.status
harness.doctor.summary
harness.operation.list
harness.operation.get
harness.workspace.list
```

`harness.workspace.list`（read）は agent workspace の coordination view（DB index）を
返す: agent / branch / worktree_path / linked goal とその convergence decision /
objective / heartbeat / last checkpoint。`agent` で絞り込み可。**read tool なので既定で
許可**（allowlist 不要）。**git state（dirty / ahead-behind）は含めない**。mutating な
create/remove/checkpoint と git-inclusive な inspect/recover は、filesystem/git アクセスと
（mutation には）confirmation gate を要するため**現状 CLI 専用**（[`cli.md`](./cli.md#harness-workspace)・
将来の MCP mutation tool は follow-up）。

`harness.knowledge.get` tool results omit entry body by default and include a
capped body only when `includeBody` is true. `harness://knowledge/{entryId}`
resources may include the body, capped by `resources.maxResourceBytes`.

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
harness.goal.start
harness.goal.record_findings
harness.goal.classify_finding
harness.goal.mark_finding_fixed
harness.goal.defer_finding
harness.goal.record_close_check
harness.goal.check_convergence
```

`harness.run.start`, `harness.review.auto`, `harness.rerun.start`, and
`harness.review.process` also accept optional `goalId`. When present, the tool
validates the goal's project/repo/domain boundary against the target project or
run and writes goal attempt/review-cycle records after the operation succeeds.
A project-scoped or domain-scoped goal is rejected for an unscoped or mismatched
run.

Dangerous mutations, confirmation-required by default:

```txt
harness.review.process
harness.cleanup.apply
harness.pr.create
harness.goal.close
harness.goal.cancel
harness.goal.expand_scope
harness.db.repair.apply
harness.db.archive.apply
harness.db.migrate_blobs.apply
harness.db.gc_blobs.apply
```

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
  "goalId": "goal-...",
  "idempotencyKey": "uuid"
}
```

Requires `run.start` allowlist, project allowlist, budget availability, and an
idempotency key. It returns `operation_started` with `operationId` and `runId`
when execution starts.
If `goalId` is supplied, the operation metadata includes `goalId` and `goal_id`
and `goal_attempts` receives an `implement` attempt linked to the resulting run.

`harness.review.auto`

Input:

```json
{
  "runId": "run-...",
  "goalId": "goal-...",
  "reviewer": "codex-reviewer",
  "idempotencyKey": "uuid"
}
```

Allowed only for runs in `needs_review` or `changes_requested`, after resolving
the run's project and applying project allowlist and `review.auto` allowlist.
If `goalId` is supplied, the review attempt is linked to the latest goal attempt
for the same run and reuses that iteration so review-only bookkeeping does not
consume implementation budget.

`harness.rerun.start`

Input:

```json
{
  "runId": "run-...",
  "goalId": "goal-...",
  "idempotencyKey": "uuid"
}
```

When linked to a goal, the generated child run is recorded as a `rerun` attempt
with the parent run attempt as `parentAttemptId` when available.

`harness.review.process`

Input:

```json
{
  "runId": "run-...",
  "goalId": "goal-...",
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
If `goalId` is supplied, confirmed execution imports the exact proposal into
`goal_review_cycles` / `goal_findings`, records a `review_consensus` close check
when the goal requires one, and records a convergence decision. Negative
decisions with no explicit required changes become an in-scope P1 blocker.

Goal tools:

```txt
harness.goal.start
harness.goal.record_findings
harness.goal.classify_finding
harness.goal.mark_finding_fixed
harness.goal.defer_finding
harness.goal.record_close_check
harness.goal.check_convergence
harness.goal.close
harness.goal.cancel
harness.goal.expand_scope
```

All goal mutation tools use `OperationRunner`, require idempotency keys, and
write operation audit metadata with `goalId`/`goal_id` where a goal is known.
`goal.close` is executable without confirmation only when convergence is
`close_ready`; forced close, cancel, and scope expansion are always
confirmation-required.

`harness.cleanup.apply`, `harness.pr.create`, `harness.db.repair.apply`,
`harness.db.archive.apply`, `harness.db.migrate_blobs.apply`, and
`harness.db.gc_blobs.apply` also return `confirmation_required` by default and
must have corresponding preview/dry-run paths.

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
harness.goal.convergence
harness.goal.review-findings
harness.goal.close-check
```

Goal prompts carry additional rules:

```txt
harness.goal.convergence:
  read the goal session, findings, close checks, and decisions; recommend the
  next action without expanding scope

harness.goal.review-findings:
  classify findings before fixing; new unrelated delta/close findings default
  out_of_scope; stop on unknown scope

harness.goal.close-check:
  check original close conditions only; stop on confirmation_required and run
  harness.goal.check_convergence after recording evidence
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
