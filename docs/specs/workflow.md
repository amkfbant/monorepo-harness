# Workflow `domain-coding`

`harness run` が呼ぶ唯一の workflow。実装: `src/core/workflow-runner.ts`。

## 高レベルなフロー

```text
1. load global + repo policy, resolve into ResolvedPolicy
2. generate unique runId, acquire per-domain lockfile
3. resolveBaseSha(baseBranch) — pin the commit to diff against. best-effort
   `git fetch origin <baseBranch>` first, then resolve in priority order:
   `origin/<baseBranch>` (fresh remote tip; #154 — never a stale local ref) →
   local `<baseBranch>` (local-only branches / a raw SHA; #195) → **fail-fast**
   (never silently fall back to a different base; #195)
4. createRunLog(runsDir, runId, meta) — atomic mkdir + meta.json + events.jsonl
5. emit run_started event, write resolved-policy.yaml
6. createWorktree(repo, baseSha, runId) — git worktree add -b harness/<runId>/<domain> at baseSha (occupies that branch)
7. emit worktree_created event
8. build codex prompt from goal + policy → write codex-prompt.md and update
   `runs.prompt_sha256`
9. emit codex_exec_started
10. spawn `codex exec --json -o runs/<runId>/codex-output.log`
    (detached process group, sandbox/approval/timeout from policy)
11. pipe codex stdout JSONL to quarantined `.codex-events.raw.jsonl`;
    read codex-output.log + codex-error.log after streams flush
12. emit codex_exec_completed (exitCode, timedOut, durationMs)
13. redact `.codex-events.raw.jsonl`, write `.codex-events.redacted.tmp`,
    atomically rename it to `codex-events.jsonl`, then delete the raw dotfile;
    if read/write/rename fails, publish only
    `{"type":"redaction.failed","reason":"<short>"}` to `codex-events.jsonl`
    when possible and continue the run
14. record run_usage (`kind='coder'`) from the published `codex-events.jsonl`
    (reviewer / evaluator codex invocations record their own `kind='reviewer'` /
    `kind='evaluator'` rows from their published events on their own paths;
    all per-invocation and fail-open — see [`db.md`](./db.md) run_usage)
15. setStatus('generated')
16. PASS 1 — post-codex diffAndValidate(worktree, baseSha, policy):
    attemptDiff → DiffOutcome { ok, trackedChangedPaths, stagedChangedPaths, untrackedAll, stat, patch, error? }
    partitionUntracked(untrackedAll, ignoreUntracked) → { kept, ignored }
    if diff.ok: validateChangedPaths(policy, tracked ∪ kept) → violations + safetyStatus
    emit diff_collection_failed / policy_validation_completed with stage="post-codex" (validation durationMs on success)
    if diff.ok: validateDiffBudget(policy.limits.changeBudget, stat) and emit
    diff_budget_evaluated; stat covers the whole PR-bound surface (working-tree + staged tracked
    changes + allowed-untracked-kept additions); enforce:false records breach audit as
    exceeded-but-allowed / change_budget_disabled and proceeds toward review
17. PASS 2 — if diff.ok && safetyStatus=allowed && codex ok && allowedCommands non-empty:
    setStatus('verified'); emit commands_started
    runAllowedCommands(worktree, allowedCommands) → results; emit commands_completed
    RE-RUN diffAndValidate against the post-command worktree
    emit diff_collection_failed / policy_validation_completed with stage="post-command" (validation durationMs on success)
    re-run validateDiffBudget against the post-command stat so formatter/build churn is included
18. setSafetyStatus  (from the final — post-command if commands ran — validation)
19. split kept untracked → (allowed, denied) based on the final violations set
20. write final-diff.patch
21. write untracked-files.{txt,patch} for allowed (with secret-scan redaction)
22. write untracked-denied.txt for denied (metadata only)
23. write untracked-secrets.txt for secret suspects (metadata only)
24. emit diff_collected (stage = post-command if commands ran, else post-codex, durationMs)
25. determine RunStatus from priority:
    diff failure > codex timeout > codex non-zero > policy violation
    > enforced budget exceeded > command failure > needs_review
26. readTail(codex-output.log), readStderrTail(codex-error.log);
    codex が失敗（exitCode != 0 / timedOut）した場合は、publish 済みの
    redacted `codex-events.jsonl` から events tail を要約
27. write summary.md
28. write knowledge-candidates.yaml (4 signal kinds)
29. write review-decision.yaml (initial: pending)
30. write review-request.md
31. ingestRunArtifacts into the DB; emit artifacts_ingested (count, totalBytes, durationMs)
32. finalize(meta, status, safetyStatus, counts, commandResults, finishedAt)
33. emit run_completed (runElapsedMs)
34. release domain lock (finally)
```

ステップ 16/17 の 2 pass 構成が F8（コマンドの副作用も path policy で再検査）の核心。`allowedCommands` が無ければ pass 2 は skip され、pass 1 の結果がそのまま使われる。

**base 解決の運用上の含意（ステップ 3 / #154 #195）**: `git fetch` が成功したときだけ `origin/<base>` を信頼する（失敗時は stale な remote-tracking ref を local より優先しない）。したがって (1) **origin が authoritative** — base branch に push せず local commit だけ重ねても base 解決はそれを無視し origin tip を使う（PR-merge-via-`gh pr merge` 運用では正しい）。(2) **origin が設定済みだが到達不能**（firewall / offline）な場合、best-effort fetch が `gitTimeoutMs`（既定 30s）まで blocking してから local に degrade するので、base 解決ごとに最大その分の latency を払う（無限 hang はしない）。offline / firewalled 環境では `fetchRemote:false` 相当の運用 or 短い timeout で緩和できる。base branch 名は branch 名 or 40-hex SHA のみ受理（`main~1` 等の rev-expression / refspec は拒否）。

Diff review and reviewed-fingerprint collection are symlink-safe by design:
paths are evaluated as repository entries and the implementation does not follow
symlinks to read a linked target outside the worktree. A symlink itself can still
appear as a changed path and be checked by policy, but linked file contents are
not traversed through the symlink for diff summaries or fingerprints.

worktree は **削除しない**。レビュー後の cleanup は `harness cleanup`（[`cli.md`](./cli.md)）で行う。

Hitch-mode executions can wrap one or more `domain-coding` runs in a
[`hitch-convergence`](./hitch-convergence.md) session. The run status machine
remains unchanged; hitch convergence records the surrounding attempts, review
cycles, finding classification, and close checks so an agent loop can stop at
`close_ready`, `diverging`, or `budget_exhausted` instead of extending scope.

## RunStatus 遷移

```
                          ┌──────────────────────────┐
                          ▼                          │
running ──► generated ──► verified ──► needs_review  │
   │            │              │                     │
   │            │              │                     ├─► approved              ┐
   │            │              │                     ├─► changes_requested     ├─ harness review process
   │            │              │                     └─► rejected              ┘
   │            │              │                          │
   │            │              │                          └─► cleaned (harness cleanup)
   │            │              │
   │            │              ├─► failed-command (allowed command の exit≠0 / timeout)
   │            │              ├─► failed-budget-exceeded (enforced change_budget exceeded)
   │            │              ├─► failed-policy-violation (safetyStatus=denied)
   │            │
   │            ├─► failed-codex             (codex exit ≠ 0)
   │            ├─► failed-codex-timeout     (codex SIGKILL'd)
   │            └─► failed-diff-collection  (git diff threw)
   │
   └─► failed-internal-error  (catch-all; emit run_failed event then rethrow)
```

`approved` / `changes_requested` / `rejected` への遷移は `domain-coding` workflow の中では起きない。`harness review process --run-id <id>` で `review-decision.yaml` を読んで遷移させる ([cli.md](./cli.md#harness-review-process) 参照)。同コマンドが `meta.status` / `meta.reviewer` / `meta.reviewedAt` を更新し、`events.jsonl` に `review_processed` イベントを追記する。

failed-* で終わった run も worktree は残る（人間が原因を調べられるように）。

**codex の中断（`AbortSignal` / #132）**: `runDomainCoding` / `runReviewerAgent` は
optional な `signal` を codex runner に渡す。`course orchestrate` がドライブ中に
course lease を失うと、この signal を abort し、codex プロセスツリーを timeout と
同じ経路（`detached` プロセスグループ → `killProcessTree` で SIGKILL）で kill する。
kill された codex は exit≠0 になるので、上記の status priority により run は
`failed-codex` で finalize される（fail-closed＝消費した attempt は記録され、hitch は
resumable なまま）。すでに abort 済みの signal では codex を **spawn せず** に
`aborted` を返す（lease を失った後に新しい codex を起動しない）。`signal` 未指定なら
従来どおり（runner は abort を観測しない）。

codex 自体が失敗した run（`codex.exitCode !== 0` または `codex.timedOut`）では、
`summary.md` と `review-request.md` に `## codex events (tail, redacted)` セクションを
追加する。入力は artifact 用に publish 済みの `codex-events.jsonl` のみで、
quarantined raw dotfile（`.codex-events.raw.jsonl`）は読まない。セクションは
`item.completed` の `command_execution`（command / exit_code）と `agent_message`
（先頭 120 文字）、および `turn.completed.usage` を時系列 tail（既定 10 件）で表示する。
`command` は string、string[]、`{name: string}` のみ表示し、それ以外の shape は
`(command omitted: unrecognized shape)` として fail-closed する。
成功 run にはこのセクションを出さず、既存の summary / review-request 形式を維持する。

### RunStatus 優先順位

priority は上から下（post-command pass が走った場合は、その後の状態で評価される）:

1. `!diff.ok` → `failed-diff-collection`
2. `codex.timedOut` → `failed-codex-timeout`
3. `codex.exitCode !== 0` → `failed-codex`
4. `safetyStatus === "denied"` → `failed-policy-violation`
   （codex 直後 / commands 実行後のどちらの validation で denied になっても）
5. `change_budget` が enforced exceeded → `failed-budget-exceeded`
6. `allowedCommands` が走り 1 つでも失敗 → `failed-command`
7. else → `needs_review`

`safetyStatus` は orthogonal: status が `failed-codex-timeout` でも、validation が走った結果として `denied` のことがある。reviewer はこの 2 軸を両方確認する。

### SafetyStatus

```
type SafetyStatus = "allowed" | "denied" | "skipped";
```

- `allowed` — diff が取れて、validation が全 path を OK と判定
- `denied` — diff が取れて、validation が 1 つ以上の path を NG と判定
- `skipped` — diff collection に失敗、validation が走らなかった

## Run 識別

`runId = "run-" + yyyymmdd + "-" + domain-slug + "-" + (Date.getTime().toString(36) + 8-char uuid)`

例: `run-20260520-apps-catalog-mpe3vgb9e3b0a532`

衝突確率は実質ゼロ。`runs/<runId>` の作成は `mkdir({recursive:false})` で atomic、コリジョン時は EEXIST で fail。

## artifact レイアウト

```txt
runs/<runId>/
  meta.json                # RunMeta (status / safetyStatus / counts / sha / branches)
  events.jsonl             # 各イベント 1 行 JSON (run_started / worktree_created / codex_* / diff_* / run_completed)
  resolved-policy.yaml     # ResolvedPolicy を YAML で
  codex-prompt.md          # codex に渡した prompt 全文
  codex-output.log         # codex `-o/--output-last-message` の最終 agent message
  codex-error.log          # codex stderr (生; readStderrTail で patch echo を抑制してから artifact に転載)
  codex-events.jsonl       # codex `--json` stdout の JSONL events (raw stdout は一時 dotfile に隔離し、redaction 後に atomic publish; command aggregated_output / text / command / command_name / name は secret redaction 済み; turn.completed.usage を含み、run_usage の入力になる。redaction 失敗時は redaction.failed sentinel のみ)
  final-diff.patch         # tracked changes の unified diff (against baseSha)。常に生成 (変更なしなら空)
  untracked-files.patch    # OPTIONAL: allowed untracked がある場合のみ。inline + secret hit は redact
  untracked-files.txt      # OPTIONAL: allowed untracked がある場合のみ。path list
  untracked-denied.txt     # OPTIONAL: denied untracked がある場合のみ。size + sha256、content なし
  untracked-secrets.txt    # OPTIONAL: secret hit がある場合のみ。reasons のみ、content なし
  summary.md               # 人間向け短いサマリ。diff stat / change budget evidence を載せる。codex が非ゼロ exit / timeout で失敗した run のみ redacted codex events tail も載せる
  knowledge-candidates.yaml # 自動抽出 signal (4 kinds; 後述)
  review-request.md        # reviewer 向け詳細 (status / safety / lists / change budget / artifacts / codex tails / redacted events tail on codex failure / checklist)
  review-decision.yaml     # 初期: { decision: pending, … } — reviewer がここを編集する
  commands/                # OPTIONAL: policy.allowedCommands があるときだけ runs/<runId>/commands/ に生成（workspace 内に作らない）
    00-<slug>.out.log      # command stdout; secret-shaped 行は write 層で redaction (#186)
    00-<slug>.err.log      # command stderr; secret-shaped 行は write 層で redaction (#186)
    01-<slug>.out.log
    ...
  context-pack-manifest.yaml  # OPTIONAL: `run --project` で context pack を注入したときのみ
workspaces/<runId>/repo/   # git worktree (削除しない)
locks/<repoId>--<domain-slug>-<hash>.lock  # active run の lock; runId / pid / hostname / acquiredAt
```

**command log redaction (#186)**: `runAllowedCommands`（全 command 種別 — policy commands と hitch close-check の双方）は子プロセスの stdout/stderr を **write 層の Transform で行単位 redaction** してから `*.out.log` / `*.err.log` に書く。secret-shaped な行（`containsLikelySecret`: vendor token / name-based assignment / bearer）は `[redacted: secret-shaped line withheld]` に**丸ごと**置換する（partial 置換はしない＝chunk/行境界で token が断たれて残りが漏れるのを防ぐ）。PEM 秘密鍵は **BEGIN..END の block 全行**を redaction する（base64 本体行は単体では token pattern に一致しないため、redactor が block 状態を持つ）。byte stream は `StringDecoder` で multi-byte char を再結合し、token が chunk をまたいでも行確定時に判定する。partial-line buffer は `COMMAND_LOG_MAX_LINE_CHARS`（1 MiB）で**上限**を設け、改行無しの巨大行は丸ごと withhold する（無界 buffer の OOM と flush 境界での token 断裂を防ぐ）。marker 自体も `containsLikelySecret` で secret 扱いなので、redact 済みログを再 scan（close-check の log excerpt 等）しても withheld のまま。

## Phase 5: project-driven run

`harness run --project <id>` は project profile（`projects/<id>.yaml`）を compile して
実行する。違いは次のとおり（[`project.md`](./project.md)）:

- policy は profile を compile して得る（policy file を読まない）。`meta.project`
  に provenance（projectId / profilePath / profileVersion / template / preset / context pack id）を記録。
- domain に context pack が紐づくと、参照ファイルを prompt の
  `## Explicit project context packs` section に注入し、`context-pack-manifest.yaml`
  を artifact として残す（secret-shaped file は content を入れず redacted 記録）。
- **lock は repo namespaced**: `locks/<repoId>--<domainSlug>-<hash>.lock`。複数 repo が
  同じ domain id を持っても lock が衝突しない。`run` / `review process` / `cleanup` /
  `pr create` は run の `meta.repoId` から同じ lock key を導出する。`repoId` を持たない
  旧 run のみ legacy の domain-only lock。

Project-scoped hitch executions (`hitch orchestrate`, MCP
`harness.hitch.orchestrate`, and course orchestration) use the same
project-runtime inputs as `harness run --project`: `prepareProjectRun` compiles
the profile, and the coder run receives that compiled `{global, repo}` policy,
`meta.project`, and any project context packs. Post-codex and post-command
`diffAndValidate` therefore validate against the compiled project policy, and
the effective policy snapshot records `source: project-runtime`. A hitch without
`projectId` remains a raw repo-policy run for compatibility.

Compatibility note: for project-scoped hitches this is intentionally a
fail-closed tightening. If a project profile narrows the raw repo policy, a path
that raw policy allowed can now finish as `failed-policy-violation` under the
compiled project policy. Non-project hitches are unchanged.

### meta.json 例

```json
{
  "runId": "run-20260520-apps-catalog-mpe3vgb9e3b0a532",
  "repoId": "mini-commerce",
  "repoPath": "/Users/kn/dev/mini-commerce",
  "domain": "apps/catalog",
  "workflow": "domain-coding",
  "baseBranch": "main",
  "baseSha": "ca427b95ea7e90e593f7d9006d6ad071acf8437e",
  "runBranch": "harness/run-20260520-apps-catalog-mpe3vgb9e3b0a532/apps-catalog",
  "status": "needs_review",
  "safetyStatus": "allowed",
  "ignoredUntrackedCount": 0,
  "secretSuspectCount": 0,
  "startedAt": "2026-05-20T13:36:41.301Z",
  "finishedAt": "2026-05-20T13:37:47.609Z"
}
```

### events.jsonl 例

```jsonl
{"type":"run_started","runId":"run-…","baseSha":"ca427b9…"}
{"type":"worktree_created","path":"/Users/kn/dev/monorepo-harness/workspaces/run-…/repo"}
{"type":"codex_exec_started"}
{"type":"codex_exec_completed","exitCode":0,"timedOut":false,"durationMs":61234}
{"type":"codex_events_redacted","redactedCount":1,"droppedCount":0}
{"type":"policy_validation_completed","status":"allowed","stage":"post-codex","durationMs":3}
{"type":"diff_budget_evaluated","stage":"post-codex","status":"within","disabled":false,"stat":{"filesChanged":1,"insertions":4,"deletions":1,"deletedFiles":0},"budget":{"maxDeletedLines":800,"maxTotalChangedLines":5000,"maxDeletedFiles":20,"maxChangedFiles":40,"enforce":true},"breaches":[]}
{"type":"commands_started","count":2}
{"type":"commands_completed","results":[{"command":"npm test","exitCode":0,"durationMs":4521,"timedOut":false},{"command":"npm run lint","exitCode":0,"durationMs":1102,"timedOut":false}],"allPassed":true}
{"type":"policy_validation_completed","status":"allowed","stage":"post-command","durationMs":2}
{"type":"diff_budget_evaluated","stage":"post-command","status":"within","disabled":false,"stat":{"filesChanged":1,"insertions":4,"deletions":1,"deletedFiles":0},"budget":{"maxDeletedLines":800,"maxTotalChangedLines":5000,"maxDeletedFiles":20,"maxChangedFiles":40,"enforce":true},"breaches":[]}
{"type":"diff_collected","tracked":["apps/catalog/src/validation.ts"],"untrackedAllowed":[],"untrackedDenied":[],"ignored":[],"stage":"post-command","durationMs":18}
{"type":"artifacts_ingested","count":8,"totalBytes":123456,"durationMs":11}
{"type":"run_completed","status":"needs_review","safetyStatus":"allowed","ignoredUntrackedCount":0,"secretSuspectCount":0,"commandResultsCount":2,"runElapsedMs":66422}
```

### diff / validation の stage

`diff_collected` / `policy_validation_completed` / `diff_collection_failed` には **`stage`** フィールドが付く:

- `post-codex` — codex 実行直後の diff / path validation
- `post-command` — `allowedCommands` 実行後の **再** diff / 再 validation（F8: コマンドの副作用も同じ安全境界で検査）

`allowedCommands` が空、または codex / 初回 validation で既に失敗している場合、`post-command` の validation は走らず post-codex のみが残る。`diff_collected`（最終 diff の確定）の `stage` は、コマンドが走ったなら `post-command`、そうでなければ `post-codex`。

Change budget evaluation follows the same stage rule. If an enforced post-codex
budget is already `exceeded`, allowed commands are not invoked and the run
finalizes as `failed-budget-exceeded` after artifacts are written. If commands
run, the post-command budget evaluation replaces the post-codex result for final
status and artifacts. The budget stat covers tracked worktree changes,
staged/index changes, and allowed untracked files that can be committed into the
PR. `enforce:false` does not silently pass breaches: the evaluation returns
`exceeded-but-allowed`, emits `change_budget_disabled`, records the breached
metric / actual / limit in summary and review request artifacts, and proceeds to
`needs_review` so the reviewer remains the backstop.

#### worktree index normalization

The reviewed-surface model is working-tree based: the reviewed fingerprint is
computed over the working tree, close-check requires a clean index against it, and
`harness pr create` re-derives a SINGLE reviewed commit from the working tree
(`git add -- reviewedPaths`). A coder, however, may COMMIT or stage its work in
the run worktree (codex does this non-deterministically). After the change-budget
passes — so a staged-only mutation is still gated by the budget — and before the
reviewed surface is frozen, the run normalizes the worktree with
`normalizeWorktreeIndexToBase` (`git reset --mixed <baseSha>`): HEAD and the index
are moved back to the run base while every working-tree edit and untracked file is
left in place. This folds the coder's commits/staging into the working tree (the
net change is preserved; only the commit/staging STRUCTURE is discarded), so the
worktree the close-check and PR-creation paths consume has a clean index. Without
it a committed worktree would escalate close-check (its index ≠ base) and, worse,
leak the coder's intermediate unreviewed commits onto the pushed run branch (PR
creation pushes the branch as-is and only validates the NET `base..HEAD` diff).
The reset is fail-closed: a non-zero / timed-out reset throws and the run
finalizes as `failed-internal-error` rather than proceeding on a worktree that
cannot be proven index-clean.

`policy_validation_completed.durationMs` は path policy 検証にかかった wall-clock の整数 ms、`diff_collected.durationMs` は当該 stage の diff / untracked 収集にかかった wall-clock の整数 ms。いずれも harness が `performance.now()` で計測し、`Math.round` で整数化する。

`artifacts_ingested` は run 完了時の `ingestRunArtifacts` 成功直後、`finalize` 前に emit される。`count` / `totalBytes` は DB blob に取り込んだ artifact body（`meta.json` / `events.jsonl` / `review-decision.yaml` など DB から再構成される artifact を除く）のファイル数と元ファイル byte 合計、`durationMs` は同じく `performance.now()` ベースの整数 ms。

`codex_events_redacted` は `codex_exec_completed` 後、artifact ingest 前に quarantined raw dotfile を redaction して `codex-events.jsonl` へ atomic publish した結果、実際に置換または drop が発生した場合のみ emit される。`item.aggregated_output`、`item.text`、`item.command_name`、`item.name`、および `item.command`（string、string[] の各 string 要素、`{name: string}` の name）の secret-shaped content は `SCAN_SAMPLE_BYTES` ごとの 1KB overlap chunk で全量 scan し、hit した field または要素は `"[redacted: secret-suspect (...)]"` に置換する。parse できない JSONL 行は `{"type":"redaction.dropped_line"}` に置換して保存する。raw dotfile と redaction tmp dotfile は dotfile であり、artifact ingest の対象外。成功時は raw dotfile を削除する。

redaction の raw 読み込み、redacted tmp 書き込み、または `codex-events.jsonl` への rename が失敗した場合、workflow は raw を正式 artifact 名に置かない。可能なら `codex-events.jsonl` には `{"type":"redaction.failed","reason":"<short>"}` の 1 行だけを書き、raw/tmp dotfile の削除を試みる。sentinel 書き込みも失敗した場合は正式名ファイル無しのまま続行する。この場合、run は redaction 失敗だけでは失敗しない。

`run_usage` 記録は `codex_exec_completed` 後、redaction/atomic publish 済みの artifact 用 `codex-events.jsonl` から、post-codex diff 収集前に行う。runner は lease guard (`assertActiveLease`) を通して
`run_usage` に `kind='coder'` の invocation row を INSERT する。`seq` は同一
`(run_id, kind)` 内で採番し、lease guard / seq 採番 / INSERT は同じ `BEGIN IMMEDIATE`
transaction 内で行う。`turn.completed.usage` が正常に読める場合は
`usage_source='exact'`、複数 turn は token fields を合算する。events file が無い /
読めない / 空 / JSON parse 不可 / `turn.completed.usage` 無しの場合も run は止めず、
`usage_source='unavailable'` かつ token fields `NULL` の行を明示的に記録する。
`parsed_log` / `estimated` は予約値であり、G1 の workflow は書き込まない。
`total_tokens` は `input_tokens + output_tokens`（`reasoning_output_tokens` は別列）。

#206 以降この記録は `recordAgentUsage` 経由の **dual-write** になり、同じ
`BEGIN IMMEDIATE` transaction 内で `run_usage`（model 以外 byte-identical）に加えて
`agent_invocation` + per-turn `agent_usage_turn` も書く（both-or-neither）。`model` は
coder では policy `defaults.codex.model` → `HARNESS_CODEX_MODEL` → `NULL`、reviewer /
evaluator（policy を持たない）では `HARNESS_CODEX_MODEL` → `NULL`（harness は `-m`
非注入のため best-effort advisory）。3 経路の lease 有無は変わらない（coder のみ
`assertActiveLease`・reviewer / evaluator は lease-free）。スキーマと不変条件は
[`db.md`](./db.md) の「Agent usage telemetry」節。

**第 4 の usage writer — `harness codex exec`（#206 Phase-2）**: `harness codex exec`
は run lifecycle の外から `recordAgentUsage(role='external')` を呼ぶ。JSONL 永続化なし・
DB 書き込みのみ。モデルは `-m` フラグから sniff。`run_id` は `--harness-run-id` または
env `HARNESS_RUN_ID` で任意リンク（省略時 NULL）。DB が存在しないか書き込み失敗の場合は
fail-open（codex の exit code を伝播し、warning を stderr に 1 行出す）。詳細は
[`cli.md`](./cli.md) の「`harness codex`」節。

**第 5 の usage writer — orchestrate-tail post-hoc ingest（#235, #206 Phase-3）**:
`harness course orchestrate` および `harness hitch orchestrate` は、orchestrate が
正常完了して output を書いた直後に `ingestClaudeSubagentUsage` を呼ぶ（fail-open
tail）。この呼び出しは **MUST never throw** — orchestrate は既に成功しており、
telemetry の失敗が exit code や output を汚染しない。ingest は
`HARNESS_CLAUDE_PROJECTS_DIR` env（設定時）を `claudeProjectDir` override として渡し、
未設定の場合は `harnessRoot` からデフォルト resolve（`~/.claude/projects/<encoded>`）
する。dry-run path は早期 return するため tail に到達せず、dry-run で ingest は呼ばれない。

ingest の詳細な動作（mtime settle / skip-before-read / in-flight transcript
under-count / ops launch-cwd 単一 dir scope）は `docs/specs/db.md` の
「Agent usage telemetry」節を参照。read side は `harness usage subagents`
（[`cli.md`](./cli.md) の「`harness usage`」節）。

`run_completed.runElapsedMs` は `runDomainCoding` 開始から `run_completed` emit 直前までの wall-clock 整数 ms。

コマンドが作った副作用（scope 外書き込み / secret-shaped file / ignored output / symlink / huge / binary）はすべて post-command の再検査で codex 直後と同じ扱いになる — 詳細は [`policy.md`](./policy.md#allowedcommands-実行) の「commands 実行後」。

`harness review process` 実行時にはさらに追記される:

```jsonl
{"type":"review_processed","runId":"run-…","decision":"approved","previousStatus":"needs_review","newStatus":"approved","reviewer":"alice","reviewedAt":"2026-05-20T12:00:00Z"}
```

`harness cleanup` 実行時（`--scope workspace` のとき。`run` / `all` は run dir ごと消えるので event も残らない）:

```jsonl
{"type":"cleaned","runId":"run-…","scope":"workspace","previousStatus":"approved","worktreeRemoved":true,"branchRemoved":true}
```

通常の `failed-*` 終了（policy-violation / codex / codex-timeout / diff-collection）は **`run_completed` イベントに最終 status を載せる** だけで、`run_failed` は emit されない。`run_failed` は **post-`createRunLog` で unexpected exception が catch された場合のみ** 1 行追加される（その後 `failed-internal-error` で finalize して rethrow）。

## Phase 6: DB read model

Phase 6 で DB（[`db.md`](./db.md)）を導入する。**workflow 自体は変わらない** —
`runDomainCoding` は引き続き `runs/<runId>/` の file へ書き、file が write-side の
source of truth。

DB は `harness db import --from-files` で file artifact から構築する read model。
`harness.sqlite` を消しても `runs/` 等の file から import で再構築できる（依存方向は
file → DB の一方向）。ダッシュボード（[`dashboard.md`](./dashboard.md)）や
`metrics` / `inbox` の集計が DB query を使う。

source-of-truth transition:

```txt
Phase 6: files = write-source,  DB = read-source（importer で構築）
Phase 7: DB = write-source,     files = compatibility export
Phase 8: DB complete,           file scan = migration-only
```

Phase 6 のスコープは read-side のみ。`runDomainCoding` 等が DB へ直接書く write
path 化は Phase 7。

## Phase 7: DB-first write path（close 済み・現状仕様）

Phase 7 で runtime write path を DB-first 化した（[`db.md`](./db.md) の
「Phase 7」節）。**workflow の状態遷移と観測挙動は変えない** — 変わるのは state
の保存先（file → DB）だけ。確定は `phase7-close` 時点。

### write+export パターン

移行された各 write コマンドは次の形をとる:

```txt
openDb(read-write)
  → db.transaction(() => { repository の write メソッド群（guard 付き） })
  → commit（db_revision を bump）
  → exportFiles(db, 影響した id 群)   ← atomic write、export_records を更新
  → close
```

`runDomainCoding` は codex exec で数分かかるため 1 トランザクションにしない。
現行の「stage ごとの `meta.json` 逐次更新」と同じく、**stage ごとに短い
トランザクション + export** を行う（run 作成 / codex 完了 / diff 検証 /
finalize）。crash 時は最後に commit した stage で `runs` 行が止まり、現行の部分
`meta.json` と同じ観測挙動になる。

Run 作成時、`runs` 行には harness 側で決定できる実行環境 provenance を保存する:
`harness_version`（package version）、`schema_version_at_run`（run 時点の
`SCHEMA_VERSION`）、`codex_model=NULL`（harness は model を指定しないため予約列）、
`codex_binary_version`（CLI 層が `<codexBin> --version` を fail-open で取得した値）。
codex prompt は run 行作成後に worktree / policy / context から確定するため、
`codex-prompt.md` を書いた直後にその全文の SHA-256 hex を計算し、lease guard 付きの
短い UPDATE で `runs.prompt_sha256` に保存する。この provenance は DB-only で、
`meta.json` / compat export / file import 形式は変更しない。

### state transition guard

`approved` / `changes_requested` / `rejected` への遷移は引き続き
`review process` のみが行う（安全モデル不変）。Phase 7 ではこの遷移を
expected-status guard 付きの `updateRunStatus` で実行する: 現在 status が
expected と一致した場合だけ成功し、不一致なら `StateConflictError`。event append
は status update と同一トランザクション。同一 `operation_id` の再実行は idempotent
no-op。

### review auto と review process の権限境界

```txt
review auto:
  - review proposal / suggested decision / rationale を DB に書く
  - runs.status は変更しない（approved/changes_requested/rejected にしない）

review process:
  - human/operator decision を検証
  - guard 付き updateRunStatus で status transition を実行
```

`review auto` の DB write は proposal 系に限定し、status guard を通る遷移は
一切呼ばない。LLM の出力が状態を動かさない原則は Phase 7 でも不変。

`review auto` / `review evaluate` の reviewer codex JSONL も domain-coding 本体と
同じ quarantine lifecycle を使う。`review auto` は reviewer id を path-safe な
`[A-Za-z0-9][A-Za-z0-9._-]{0,127}`（`..` 不可）に限定し、reviewer ごとの artifact を
`runs/<runId>/reviewers/<reviewer_id>/` に隔離する。**P1-ISO read 独立性**: reviewer の
codex sandbox cwd（`-C`）は runDir 配下ではなく **OS 一時ディレクトリ（`os.tmpdir()` 下の
使い捨て dir）**に置き、許可入力（`review-request.md`/`summary.md`/`final-diff.patch`/
`untracked-files.patch`/`untracked-files.txt`/`untracked-secrets.txt`/
`untracked-denied.txt` ＝ `REVIEWER_INPUT_FILES` ＋ `commands/`）だけを copy（**symlink は
materialize しない**＝fail-closed。`meta.json` は harness が runDir から直接読むため cwd に
は copy しない）。run 後に dir は削除する。これにより先行 reviewer の verdict
（`runs/<runId>/review-decision.yaml` や sibling `reviewers/<other>/`）は cwd から短い `..`
で届く位置に無く、prompt 通り cwd を読む reviewer の自然な読取経路から外れる（working-tree
非露出）。さらに materialize の最後に **fail-closed assertion**
（`assertReviewerInputDirHasNoVerdict`）が input dir を再帰走査し、`review-decision.yaml` /
`review-auto-error.json`（厳密 basename）が 1 つでも copy されていたら
`ReviewerAgentGateError` で停止する（将来の regression で verdict が cwd に紛れ込んでも
leak ではなく fail-closed になる決定論的 backstop）。

**P1-ISO read 独立性の絶対 enforcement（#272）**: codex `--sandbox read-only` は
write/network を制限するが **read を一切 jail しない**（`-C` は chroot でなく、絶対パスでも
任意の path を read できる・codex-cli 0.139 に readable-root 設定は無い＝検証済）。よって cwd を
OS-temp に置く隔離は `..`-相対 read を外すだけで、**予測可能な絶対パスの read は防げない**。
verdict text は **複数の producer・複数のファイルに verbatim で載る**: root/scoped
`review-decision.yaml` だけでなく、(1) 各 reviewer の transcript
（`reviewers/<id>/reviewer-agent.out.log`＝raw codex stdout＝fenced verdict YAML そのもの・
`extractYamlBlock` でここから parse／`.reviewer-agent.events.{raw.jsonl,jsonl}`／`.redacted.tmp`／
`.err.log`。**redaction は secret-only で verdict を落とさない**）、(2) refute transcript
（`reviewers/<id>/refute-agent.out.log` 等＝refute verdict と target change_text）、(3)
`review evaluate` の出力（`review-evaluations/eval-NNN/{reviewer-agent.out.log, events…,
review-decision.yaml}`）—— にも載る。DB-backed export-OFF の sequential round では producer 間で
DB-sync が無いため、次の reviewer が先行の verdict を**絶対パス**から verbatim に復元できてしまう。

**不変条件（enforcement target）**: DB-backed ∧ file-export-OFF の review で、**いずれかの
reviewer codex が起動する瞬間、`runs/<runId>/` 配下のどのファイルにも先行（完了済）reviewer の /
pass の / command の verdict text が無く、reviewer の input allowlist だけが残る**。
`review_proposals`（＋ ingest 済 artifact）が round 中の唯一の source of truth。

OS read-jail（read root 制限 or 隔離コンテナ）は codex 側で決定論的・portable に強制できない
ため、harness 側で決定論的に強制できる唯一の手段として **reviewer codex 実行中は verdict を
ディスク上に一切残さない**。実装は **denylist でなく INPUT-ALLOWLIST 反転**で行う
（`quarantinePriorReviewerVerdictArtifacts`）: codex 起動直前（tamper snapshot より前）に
`runs/<runId>/` 直下を走査し、**reviewer の input allowlist
（`meta.json`／`events.jsonl`／`REVIEWER_INPUT_FILES`＝review-request.md/summary.md/
final-diff.patch/untracked-*／`commands/`）だけを残し、それ以外の全エントリ
（`reviewers/**`・`review-evaluations/**`・refute artifact・root `review-decision.yaml`・
将来の任意の producer 出力）を prior-output として一掃する**。これにより hand-maintained な
verdict-filename list を保守する必要がなく、**現在も将来も verdict-bearing producer を取り
こぼさない**。一掃（root/scoped `review-decision.yaml` の削除を含む）は **run row が存在し
`source_mode='db-first'` のときだけ**実行する（**単一の fail-closed gate**・別経路の ungated な
verdict 削除は無い）: db-first では run dir は ephemeral scratch で DB が canonical ゆえ削除は
recoverable。run row が無い / legacy / file-first なら **no-op**——DB-backed file-first/legacy run
の canonical な verdict sidecar を recovery 無く削除しない。ingestable なファイルは
**まず DB に ingest**（`ingestRunArtifactPaths`＝監査用 artifact set を recoverable に保つ）→ 削除。
raw dotfile stream
（`.reviewer-agent.events.raw.jsonl`／`.redacted.tmp`／`.refute-agent.events.raw.jsonl`）は
`isIngestableRelPath` が dot-prefixed component を弾くため **ingest 対象外＝REMOVE-ONLY**
（意図的に non-recoverable。canonical な published `reviewer-agent.events.jsonl` のみ recover
可能）。**現 reviewer 自身の scoped dir はこの後に作られる**ため消えるのは先行/完了済の出力のみ。
verdict は `review_proposals`、ingestable transcript は DB artifact として recoverable なので
ディスクから消しても失われない。quarantine は ingest 後、保持対象の **durable な
transcript 行だけ**を `markArtifactsQuarantined`（`artifacts.quarantined = 1`）で marking する。
**reviewer gate-error sidecar（`reviewers/<id>/review-auto-error.json`——先頭 2 segment 厳密一致）は
marking から除外**する——これは transient（成功 retry で `runReviewerAgent` が削除し、canonical な
失敗記録は run event log / `review_proposals` 側）であり、durable な監査 transcript ではないため
（#303）。**除外は narrow**: 同 basename でも review-evaluator の per-sample 診断
（`review-evaluations/<sample>/review-auto-error.json`、#279）は durable ゆえ除外しない（quarantine 保持）。
**監査 fidelity**:
round 後 / 次 `review auto` の `syncRunArtifactsToDb` は full `ingestRunArtifacts`（manifest 再構築）
を呼ぶが、`ingestRunArtifacts` は **db-first では DELETE-then-rescan でなく manifest を merge する**
——disk が source of truth でなく DB が canonical ゆえ、scratch file が**意図的に quarantine された**
recoverable な行を「disk に無い」という理由で削除しない。**ただし保持するのは意図的 quarantine 行
だけ**: absent ∧ recoverable でも `quarantined = 0` の行は deliberately removed/superseded（例: 成功
retry が消した stale `review-auto-error.json`、#303）として **prune** し、`exportRun` が stale artifact
を再生しないようにする。**recoverability の鍵は storage tier でなく `blob_sha256 IS NOT NULL`**:
`storage='db'` も `storage='external'`（`db migrate-blobs` 後）も DB-canonical で `exportRun` が
再生できるため、delete 述語は
`relative_path IN (<on-disk>) OR storage NOT IN ('db','external') OR blob_sha256 IS NULL OR quarantined = 0`
——つまり再 scan される行・recover 不能 tier（file 等）・bodyless 行・**非 quarantine の absent 行**
を削除し、blob を持つ db/external 行のうち **quarantine marker を持つもの**だけを absent でも保持する。
disk に再出現した path は再 scan で upsert され `quarantined` が default 0 に戻る（file が再び
authoritative ゆえ）。**upgrade 安全**: `quarantined` 列は schema v35 で追加するが、同 migration が
既存 recoverable 行（`storage IN ('db','external') AND blob_sha256 IS NOT NULL`）を全て
`quarantined = 1` に backfill する——pre-v35 の「absent recoverable を全保持」を grandfather し、
v34 で #272-quarantine 済 transcript が upgrade 直後の sync で誤 prune されないことを保証する
（disk に残る行は次 sync で再 ingest され 0 に戻る・harmless。stricter な prune は upgrade 後に
作られた artifact から適用）。`DB_RECONSTRUCTED`（`meta.json`/`events.jsonl`/`review-decision.yaml`）は
blob を持たず（`blob_sha256 IS NULL`）canonical テーブルから再生されるため、absent なら削除され
（loss でなく再生）present なら再 scan される——正しく保持対象外。file-first / run row 無しは従来
どおり DELETE-then-rescan（disk が truth・marker 無視・stale 行は prune）で **byte-不変**。これに
より quarantine-ingest した transcript は post-round sync を生き延び、`exportRun` が DB から再生する
（main との監査 parity・audit loss 無し）一方、superseded な gate-error は prune される。読むものが
ディスクに無いので、
絶対パスでも `..` でも到達できない。per-reviewer
decision sidecar も **default（`HARNESS_EXPORT_FILES` 未設定 ＝ OFF）では round 中書かず DB-only**。
さらに materialize の最後の `assertReviewerInputDirHasNoVerdict`（cwd 限定 fail-closed backstop）を
defense-in-depth で併用する。（`suppressRunDirVerdictFiles` は decision-yaml 限定の helper として
残るが、ungated に呼ぶと file-first run の canonical verdict を消すため review 経路では呼ばず、
db-first-gated な inversion がその役割を包含する。）

**保たれる経路**: no-DB legacy review は root verdict が canonical なので従来どおり書く
（掃除しない）。`HARNESS_EXPORT_FILES=1` は back-compat で sidecar / transcript を書く
（掃除しない）。round / consensus 完了後の最終 verdict・transcript は export 経路で DB
（`review_proposals` / artifacts）から再生する。掃除は あくまで「DB が source of truth ∧ file
export OFF のとき、reviewer codex 実行中に verdict を ディスクに置かない」ことに限定される。
**residual（design 上残るもの）**: read-only codex は **verdict 以外の repo / run ファイル
（diff / summary / command logs 等）は依然 absolute-read できる**。完全な OS read-jail は
defer（下記）。本 fix は **verdict-leak class** に対して complete。**defer（best-effort）**:
OS-level read-jail wrapper
（macOS `sandbox-exec` / Linux landlock）は defense-in-depth として
[`docs/future-features.md`](../future-features.md) に保留（platform 依存で決定論化できないため未実装）。
codex は
`reviewers/<reviewer_id>/.reviewer-agent.events.raw.jsonl` に stream し、redaction 後だけ
`reviewers/<reviewer_id>/reviewer-agent.events.jsonl` として atomic publish する。
raw/tmp dotfile は artifact ingest 対象外で、redaction 失敗時は sentinel のみ、sentinel
も書けない場合は正式名ファイル無しで続行する。

reviewer が runDir の watched artifact を改変/追加/削除した場合は
`verifyArtifactsUnchanged` が fail-closed で `ReviewerAgentGateError` にする。この
tamper / gate error 後に DB-first runDir を再同期する経路（`review auto` CLI と
`workflow reviewed-run`）は、同期前に reviewer が書き換え可能だった scoped
`reviewers/<reviewer_id>/reviewer-agent.*` artifact を dotfile quarantine 名へ rename し、
artifact ingest 対象から外す。その後は runDir 全体を再 scan / DELETE→再挿入してはならない。
代わりに DB manifest の既存 row を残したまま、harness が生成した
`reviewers/<reviewer_id>/review-auto-error.json` だけを targeted upsert する。
`reviewers/<reviewer_id>/reviewer-agent.events.jsonl` は `publishRedactedCodexEvents` が
`failed: false` を返したことを呼び出し側が保持している場合だけ whitelist に追加して
targeted upsert できる。確認できない場合は fail-closed で隔離する。`summary.md` など既存
DB-canonical artifact は、runDir 上で reviewer が改変しても DB 側では元の body のまま維持する。
隔離は stderr warning と DB `run_events` の `artifacts_quarantined { paths }` で観測できる。
tamper なしの正常経路は従来どおり全 artifact を同期する。

`review-auto-error.json.reason` は保存用の sanitized object であり、human 向け
`Error.message`、YAML parser message、reviewer stdout 断片、raw decision 値は含めない。
形式は `{ reasonCode, field?, valueType?, valueLength?, valueSha256? }`。`reasonCode` は
固定コード、`field` は対象 field 名、`value*` は raw 値の型・長さ・SHA-256 だけを表す。
DB blob へ targeted upsert される内容も同じ sanitized 形式に限定する。

#### reviewer prompt への operational knowledge 注入（issue #57）

`runReviewerAgent` は `dbPath` がある時、reviewer codex prompt（`PROMPT_PREAMBLE`）末尾に
**operational 知識**の `<operational-knowledge>` 参照ブロックを append する（hitch モードの
review も同じ path なので自動で適用される）。**coder prompt には決して注入しない**（issue
#57 の恒久境界。coder は `buildCodexPrompt` の `<knowledge>` = codebase 知識のみ）。スコープ
は決定論的に run の **project + repo**（どちらも portable entry を含む。domain では絞らない＝
operational は domain 固有でないことが多く portable note を取りこぼさないため）、上限 ≤10
エントリ・≤12 KiB、deprecated 除外。fence（`</operational-knowledge>`）は coder 同様に無害化
する。参照資料でありレビュー基準・出力 shape を変えない旨を明記して注入する。実装は
`buildOperationalKnowledgeReviewSection`（`src/core/operational-knowledge.ts`）。

### `run_changed_files` / `policy_violations`

Phase 6 で「file import から取れない」として繰り延べた 2 テーブルは、Phase 7 で
`runDomainCoding` 自身が diff 検証結果を in-memory に持っているため DB へ直接
書ける。`runDomainCoding` の DB-first 化でこの read-side の穴が閉じる。

## Phase 8: runtime DB complete（close 済み・現状仕様）

Phase 8 で **artifact body**（codex ログ / diff / summary 等）も DB へ移し、
file export を optional にした（[`db.md`](./db.md) の「Phase 8」節）。workflow の
状態遷移と観測挙動は不変 — 変わるのは保存先と files の必須性だけ。

- artifact body は `artifact_blobs` / `artifact_blob_chunks` に content-addressed
  で分割保存する。`runDomainCoding` は実行中、artifact を作業用 run dir
  （`runs/<id>/`）に書き、run 完了時（finalize の前）に `ingestRunArtifacts`
  でそれらの body を DB blob へ取り込む（`storage='db'`）。
- **`HARNESS_EXPORT_FILES=0` の意味（重要）。** これが OFF にするのは
  **compatibility export**（DB-canonical state から `runs/<id>/` への構造的な
  再 export）であって、run 実行そのものは依然として作業用 run dir に artifact
  を書く。つまり OFF でも run 実行中・完了直後は run dir に files が存在する
  （pure fileless ではない）。canonical な body は DB blob 側で、run dir は
  `cleanup` または明示削除まで残る。`run show` / `review` / `pr create` /
  `cleanup` / `dashboard` は run dir が無い db-first run でも DB から動き、
  後から `harness db export-files` で files を再生成できる。
- knowledge entry markdown（`docs/knowledge/**/*.md`）は **authored file** で
  あり export gate の対象外 — export OFF でも `knowledge promote` は `.md` を
  書く。export gate がかかるのは DB 由来の sidecar（`knowledge-decisions.yaml`）
  のみ。
- Phase 3-5 の `index.sqlite` / `harness index` は撤去された（Phase 8-7）。
  run 一覧は file scan、集計・ダッシュボードは `harness.sqlite` read model。

## Phase 9: concurrency + runtime completion（close 済み・現状仕様）

Phase 9 は concurrency safety と runtime DB story の完結を扱う。設計は
[`db.md`](./db.md) の「Phase 9」節を参照。本書では workflow 観点の変更を
記述する。

> **multi-agent 並行運用（concurrency の利用者側）**: ハーネスの run/hitch 層は上記
> （DB domain ロック + run ごとの隔離 worktree + WAL DB）で並行安全だが、**複数の
> LLM エージェントが同じ checkout で直接 git を叩く**と共有 index/HEAD/作業ツリーを
> 取り合って衝突する（ハーネス管轄外）。これを避けるため `harness workspace`
> （[`cli.md`](./cli.md#harness-workspace)）でエージェントごとに `agent/<name>`
> ブランチの隔離 worktree を切り、`HARNESS_ROOT`（共有 state DB）を全エージェントで
> 共有する。run 内部の `workspaces/<runId>/repo/`（codex 用・`harness/<runId>/<domain>` ブランチを占有）とは別レイヤー。

- **domain lock の DB 化** — `runDomainCoding` の lock 取得は Phase 9 で
  file lock + DB lock の **dual-lock**。DB lock は lease (5 分) +
  heartbeat (1 分) + fencing token (= `domain_locks.lock_id`) を持つ。
  Phase 9 期間中は file lock が primary serialization のため、runtime 経路の
  lease stealing は発生しにくい（full-path integration は Phase 10）。
  active lease が残っていて busy と判定した場合、`DomainLockBusyError` を throw
  する直前に同じ DB 接続で `domain_lock_contention` へ best-effort INSERT する。
  記録失敗は fail-open で握りつぶし、lock 取得・解放・fencing の意味論は変えない。
- **lease guard / state guard 分離** — run execution stage writes
  （`runs` 行 status 更新 / `run_events` / `artifacts` の DB-first ingest
  等）は `assertActiveLease` で active domain lock を verify。`review process`
  / `cleanup` / `pr create` / `backlog` / `knowledge` は引き続き expected
  status / operation_id guard。
  - **Phase 10 blocker**: `assertActiveLease` は現状 transaction 外で実行され
    （check → SQLite transaction の 2 段階）、Phase 9 dual-lock 期間は file
    lock が serialize するため race にならない。Phase 10 で file lock を撤去
    したら、check と write の間で lease を奪われ得るため、`assertActiveLease`
    を各 write transaction 内部の先頭で呼ぶか、repository write SQL に
    `EXISTS(... domain_locks ...)` 述部を埋め込むかが必要。
- **scratch runDir の lifecycle** — `HARNESS_EXPORT_FILES=0`（Phase 9 で
  default）でも `runDomainCoding` は scratch として `runs/<id>/` に artifact
  を書く。完了 + ingest 成功なら scratch を削除。ingest failure で保持 +
  warning。
- **`HARNESS_EXPORT_FILES` の default 反転** — Phase 9 close で OFF へ。
  未設定時は warning。breaking change として close report で強周知。
- **legacy-file routing 撤去** — `runs` + `backlog_items` の
  `source_mode='legacy-file'` 経路を gate（runtime write 先頭で
  `assertNoLegacyRuntimeRows`、`migrate-legacy` / `db import
  --force-legacy-reconcile` は bypass）。`knowledge_candidates` は
  `syncCandidate` が `legacy-file` を「未決定 marker」として使うため scope
  外（close レポート § "計画からの差分" 参照）。`knowledge_entries`
  （markdown = file-authored）も対象外。
- **`review auto` の verdict が DB canonical** — `review_proposals` テーブル
  に proposal を INSERT し、`review process` が DB から読んで `review_decisions`
  に昇格。`processed_at` で idempotent。sidecar `review-decision.yaml` は
  export ON のときの互換出力。

## knowledge-candidates.yaml の 4 signal

`src/reporter/knowledge-candidates.ts`:

| kind | 条件 | confidence |
|------|------|-----------|
| `policy_violation` | `violations.length > 0` | high |
| `secret_suspect` | `secretSuspectCount > 0` | medium |
| `ignored_untracked_output` | `ignoredUntrackedCount > 0` | low |
| `codex_no_changes` | exit=0 && !timedOut && changedFilesCount=0 && violations.length=0 | low |

`codex_no_changes` は **codex 自己 refuse の候補**を拾う heuristic。timeout や non-zero exit のときは出さない。

## review-decision.yaml の初期値

```yaml
runId: run-…
domain: apps/catalog
decision: pending            # → approved | changes_requested | rejected
required_changes: []
non_blocking_comments: []
out_of_scope_suggestions: []
reviewer: null
reviewed_at: null
```

reviewer がこのファイルを編集して `decision` を `approved` / `changes_requested` / `rejected` に変更後、`harness review process --run-id <id>` で `meta.json` への反映と event 追記が行われる。`reviewed_at` が `null` のままなら processor が現在時刻で auto-fill して書き戻す。

`review process` 自体は `required_changes` / `non_blocking_comments` / `out_of_scope_suggestions` を status 遷移に使わない。ただし `harness rerun --from-review` が `changes_requested` run の `required_changes` を次 run の prompt に組み込む（Phase 2-7）。`review process → rerun → review` を自動で連鎖させる完全自動 retry loop は Phase 3。

## エラーパス

post-`createRunLog` の例外（worktree 作成失敗、codex spawn 失敗、artifact 書き込み失敗）は inner try/catch で捕捉:

```ts
try {
  // workflow body
} catch (e) {
  await log.emit({ type: "run_failed", error: e.message }).catch(() => {});
  await log.finalize({
    status: "failed-internal-error",
    safetyStatus: "skipped",
    ignoredUntrackedCount: 0,
    secretSuspectCount: 0,
    finishedAt: new Date().toISOString(),
  }).catch(() => {});
  throw e;
}
```

`finalize` 自体が失敗しても rethrow 経路が壊れないよう `.catch(() => {})`。

`createRunLog` 以前の例外（policy load 失敗、baseSha 解決失敗、lock acquire 失敗）は finalize できないので普通に throw。outer finally で lock release は走る。

## 並行性

- 同一 domain への並行 run は `locks/<domain-slug>.lock` が `wx` フラグ排他で防止
- 別 domain は同時実行可能
- lockfile には `runId / pid / hostname / acquiredAt` を記録、release 時は runId 一致を確認してから削除（stale recovery への耐性）
- crash で残った lock は `harness lock list` で確認、`harness lock release` で解除

## codex subprocess

`src/codex/codex-cli-runner.ts`:

```bash
codex exec \
  --ephemeral \                      # CODEX_HOME に session を残さない
  --ignore-rules \                   # target repo の .rules を読まない (harness policy が単一情報源)
  --sandbox workspace-write \        # policy.codex.sandbox に応じて
  -C <worktree-path> \
  --skip-git-repo-check \
  [-c approval_policy="<value>"] \   # policy.codex.approval があれば
  -                                  # prompt は stdin から
```

- `detached: true` で新 process group → timeout 時に `process.kill(-pid, "SIGKILL")` でツリー kill (Windows は `taskkill /T /F`)
- env は `DEFAULT_CODEX_ENV_ALLOWLIST` (`PATH / HOME / USER / SHELL / LANG / LC_ALL / TERM / TMPDIR / CODEX_HOME`) のみ通す
- `codexBin` は PATH 名ならそのまま、path separator を含む相対パスなら `process.cwd()` 基準の絶対パスへ解決して runner / version probe の両方で使う
- version probe は解決済み `codexBin` を `os.tmpdir()` cwd で実行し、相対 path の副作用を harness cwd から隔離する
- stdout/stderr は file stream に pipe、close 後 `finished()` で flush 完了を待つ

## Test isolation: temp-dir cleanup + fork-pool bounds

Unit and integration tests that allocate temp roots use
`tests/helpers/tmp.ts` `makeTmpDir(prefix)` instead of raw
`mkdtempSync(join(tmpdir(), prefix))`. The Vitest setup file runs
`flushTmpDirs()` after each test and again after each file, so helper-created
roots are removed in-process.

`vitest run` uses the forks pool with `maxForks=4`, `minForks=1`, and
`teardownTimeout=20s`. The `tests/global-tmp-sweep.ts` `globalSetup` module does
two things at setup:

1. **Stale sweep (backward-compat).** It reclaims real directories under the
   real `os.tmpdir()` whose basenames start with `harness-`, `onb-`, `ws-repo-`,
   or `legacy-lock-warn-` AND are older than 1h (`sweepStaleTmpDirs`). This is
   maxdepth 1, prefix-scoped, skips files/symlinks, and is age-gated (>1h via
   mtime): a concurrent run's freshly-created directories are protected; only the
   theoretical case of a long-lived active directory idle for over an hour could
   be reclaimed.
2. **Per-run private TMPDIR subroot.** It creates a private subroot
   `harness-vitest-run-XXXX` under the real `os.tmpdir()` and points
   `process.env.TMPDIR` at it. Forked test workers inherit this env at fork
   time, so `os.tmpdir()` resolves to the private subroot in every worker —
   including the ~66 integration files that call `mkdtempSync(join(tmpdir(), …))`
   at module top level. All their temp roots therefore land UNDER the private
   subroot. (Locked by a committed regression test
   `tests/integration/tmpdir-redirect-probe.test.ts`: a module-top `mkdtemp` in a
   forked integration worker must resolve under `harness-vitest-run-*`, so a
   future vitest that pre-forks workers before `globalSetup` fails loudly instead
   of silently leaking.)

At **teardown** the module deletes EXCLUSIVELY its own private subroot
(`removeRunTmpRoot` → `rmSync` recursive, errors swallowed). There is no
prefix/snapshot/age scan of the shared tmpdir at teardown, so a concurrent
external or production harness run on the same machine — which creates
same-prefix dirs like `harness-reviewer-input-` directly under `os.tmpdir()` —
is never at risk: the suite only ever removes the one directory it created. This
is the architectural fix for the test-side leak (issue #270): the 66 integration
files that allocate raw temp roots without per-test cleanup no longer need
editing, because their roots are nested inside the wholesale-deleted subroot.

## limits / timeout

- codex: `policy.codex.timeoutMs` (default 15 min)
- git: `policy.limits.gitTimeoutMs` (default 30 s) — git invocation 各々に対して

timeout 到達 / エラーの扱い:
- codex 子プロセスの timeout → `failed-codex-timeout`
- diff collection 中の git error / timeout → `attemptDiff` が catch して `diff.ok = false` → `failed-diff-collection`
- それ以外の git 操作（resolveBaseSha / createWorktree）の throw、または createRunLog 後の unexpected exception → inner try/catch が `failed-internal-error` で finalize して rethrow

createRunLog **以前** の throw（policy load / lock acquire / baseSha 解決 / worktree 作成手前で異常）は finalize できないので、harness は通常の throw として伝播させる（outer finally で lock release は走る）。

## workflow: reviewed-run（Phase 3-1）

`harness workflow reviewed-run` は `domain-coding` workflow を retry loop として束ねる上位 workflow。新しい状態遷移は導入せず、既存の `run` / `review auto` / `review process` / `rerun` を順に呼ぶだけ。

```txt
attempt 0:
  runDomainCoding → needs_review（失敗系なら finalStatus=failed-* で停止）
  runReviewerAgent（review auto）→ review-decision.yaml
    invalid output なら finalStatus=review-auto-failed で停止
  processReviewDecision（review process）→ approved / changes_requested / rejected

if changes_requested かつ attempt < maxAttempts:
  prepareRerunFromReview + runDomainCoding → attempt+1（rerun）
  以降 review auto / review process を繰り返す

停止:
  approved              → finalStatus=approved（exit 0）
  rejected              → finalStatus=rejected
  failed-*              → finalStatus=failed-*（rerun しない）
  changes_requested かつ attempt==maxAttempts → finalStatus=not_converged
```

`--max-attempts n` は **初回 run の後の rerun 回数の上限**。`--max-attempts 2` なら attempt 0（初回）+ attempt 1, 2（rerun）の最大 3 run。attempt n まで `changes_requested` が続けば `not_converged` で停止。

`not_converged` は **workflow result の値**であり、個別 run の `meta.status` は `changes_requested` のまま（新 RunStatus は導入しない）。`--no-auto-review` は coder run のみで `needs_review` 停止、`--stop-on-changes-requested` は最初の `changes_requested` で停止。

workflow artifact は root run（attempt 0 の run）の dir に置く: `workflow.json` / `workflow-summary.md`。各 attempt の `parentRunId` / `rootRunId` / `rerunAttempt` は `rerun` と同じ規則で維持される。

## hitch orchestrate finalization salvage（R2 / issue #72）

`harness hitch orchestrate` の finalization は review-decision 生成 →
`review process` → commit/push → PR の順に進む。`review auto` の直前に
`ensureRunMaterialized({ repairMissingReviewDecision: true })` を呼び、`runs/<id>/`
に `meta.json` はあるが `review-decision.yaml` だけが欠ける部分 materialize を
DB から再生成する。この repair の `run_materializations.reason` は必ず
`ensureRunMaterialized:repair-missing-review-decision` で、generic な
`review-auto` では記録しない。

reviewer gate は run 状態を **DB-canonical** に判別し、欠落した `review-decision.yaml` を
「既に decided（export OFF で sidecar 削除済み・再 orchestrate は no-op = `already_decided`）」と
「真の未完了（recover 可 = `run_incomplete`）」で区別する（#77）。判定は `classifyReviewGate`
（純関数）で行い、`ReviewerAgentGateError.kind` に区分を載せ、メッセージに推奨アクションを併記する。

`hitch orchestrate` の review runner は `runReviewerAgent` を呼ぶ前に DB 正本を確認する。
gate は run の **DB-canonical 決定**（`review_decisions.decision`、個々の participant
proposal ではない）が `approved` で、かつその run の **完了済み review cycle**
（`completedAt != null`）が既に存在する冪等 re-drive のときだけ短絡する。その場合 Codex
reviewer は起動せず、既存の `review_consensus` close 条件へ現在時刻の passed check を
再記録し、review cycle は新規作成しない。evidence の `decision` / `reviewer` /
`sourceSha256` は `review_decisions` 由来（canonical）で、最新 processed proposal は
補助的な `proposalId` / advisories のみを供給する。run が approved でも完了済み review
cycle が無い（import 未実行、または cycle 行を永続化後 findings import 前に crash）場合は、
未 import の review に passed check を被せず **fail-closed で escalate** する。その後の
convergence 再評価が `close_ready` なら通常ループが次 step で `close_and_pr` に進む。
review consensus は fresh だが他の required close 条件が pending の場合は、その condition
id を含む明示的な escalation として fail-closed する。この短絡は LLM 出力を根拠にせず、
DB の `review_decisions` / review cycle / close-check だけを入力にする。

通常の review import も同じ DB-canonical 決定を状態根拠にする。import の canonical
decision は `processResult.newStatus`、それが無い場合は `review_decisions.decision` で、
個々の participant proposal の自己申告 decision にはフォールバックしない。canonical
decision が `approved` と判定できる場合、非 approving member proposal 由来の
blocking `required_change` / `negative_decision` finding は import しない（advisory
`non_blocking_comment` と out-of-scope suggestion は保持する）。canonical decision が
undeterminable（`processResult` も `review_decisions` 行も無い）なら fail-closed として
proposal の blocking finding を抑制せず、approval close-check evidence も mint しない。
`review_consensus` close-check の status / evidence.decision は canonical decision
（normal import では `processResult.newStatus`）由来で、proposal の `reviewDecisionId` は
proposal.decision が canonical decision と一致するときだけ補助 evidence として記録する。

review step が失敗した場合、orchestrator は従来どおり hitch を `escalated`
に倒す。ただし、最新 run が安全に salvage 可能なときだけ、PR を作らず hitch も
close せずに workspace branch を commit/push する。salvage gate は fail-closed:

- canonical run status が `needs_review`
- `safetyStatus === "allowed"`
- `meta.reviewed.paths` と `meta.reviewed.fingerprint` が存在し、現 worktree で再一致
- stage するのは reviewed path のみで、既存 index も reviewed path 以外を含まない
- push 直前に `baseSha..HEAD` の **完全な branch diff** が reviewed path のみである
  ことを検証する（今回 stage した path だけでなく既存 local commit も対象）
- **object-graph tampering を fail-closed 拒否**（salvage push と `pr create` の双方）:
  `refs/replace/*` ref / `info/grafts` file / shallow repository（`git rev-parse
  --is-shallow-repository`）のいずれかが在れば push しない。`git diff`/`rev-list` は
  これらの tampering で sanitized view を返しうるが `git push` は real object を送るため、
  history gate より前に拒否する（`GIT_NO_REPLACE_OBJECTS=1` は read を無害化するが、
  defense-in-depth として push gate でも明示拒否する）。
- harness の commit は **hook 無効化 + verbatim**（`git -c core.hooksPath=/dev/null commit
  --cleanup=verbatim -m <msg>`）で mint する。target repo の `prepare-commit-msg` hook が
  `-m` message に secret を追記する（`--no-verify` では抑止できない）ことと、git の message
  cleanup による改変を防ぐ。
- commit 後に **HEAD commit の message が deterministic harness message と一致**することを
  検証する（`%B`、trailing newline は両側除去）。これは新規 mint commit（hook 抑止の検証）と
  idempotent-retry 許容枝（base+1 commit かつ tracked clean）の双方を認証する。message は
  salvage が `harness salvage: <runId>`、`pr create` が `opts.title`（空/空白なら既定
  `harness: <runId>` に強制）。tree が reviewed fingerprint と一致しても message に secret を
  載せた out-of-band/hook 由来 commit は拒否する（unauthenticated retry commit）
- PR 作成・hitch close はしない。既存 `pr create` の `status === approved` gate と
  reviewed fingerprint 再検証は維持され、salvage で迂回しない
- review-step failure salvage は最新 run の canonical status が `needs_review` でない場合
  `null` を返し、branch push を試みない

escalation reason text には元の失敗理由を残し、push に成功した場合だけ
`workspace branch pushed: <branch> (<sha>)` を追記する。schema は変更しない。salvage
gate が落ちた場合は push せず、その拒否理由だけを escalation reason に追記する。

## Phase 10 — lease stealing / scratch lifecycle（close 済み・現状仕様）

Phase 10 で file domain lock が撤去され、DB-only domain lock が唯一の
serialization になる。dual-lock 期間に hidden だった lease stealing の挙動が
hot path として観測可能になるため、operator から見える振る舞いを確定する。
詳細は [`../superpowers/specs/2026-05-23-phase10-db-only-runtime-completion-design.md`](../superpowers/specs/2026-05-23-phase10-db-only-runtime-completion-design.md) §3.B。

### Lease stealing — operator 視点

次の現象は **正常な挙動** として扱う:

```
process A: harness run ...      # acquire lease X, status=coding に
process A: SIGSTOP / GC pause / event loop block で heartbeat 停止
（LEASE_DURATION_MS = 5min 経過）
process B: harness run ...      # acquire lease Y, A の lease X を soft-release
process A: 再開
process A: 次の guarded write が LeaseLostError で fail
process A: workflow-runner が catch して run を failed/lease-stolen で clean finalize
process A: exit 1
```

この時:

- B の run は影響を受けない（B は B の run_id にしか書かない）
- A の run は `runs.status='failed'`, `failure_reason='lease-stolen'`,
  `lease_lost_at=<時刻>` で確定
- DB の global state は壊れない
- `harness lock list` で B の lease のみが active として見える
- `harness run show <A の runId>` は failed 状態を表示

operator が `harness lock release --force` で active lease を奪った場合も
同じ経路を通る（`release_reason='force'` 違いだけ）。

`db doctor`（Phase 15）の orphan 検出条件で expired-but-not-released な
`domain_locks` 行 / `coding` のまま `lease_lock_id` が released な
`runs` 行を見つけたら警告するが、Phase 10 では fixture として
`tests/integration/db-lease-stealing.test.ts` に同じ SQL を埋め込んでおく。

### Scratch lifecycle（Phase 10）

`runDomainCoding` 内で codex output / diff / artifact を組み立てるための
`runs/<runId>/` は Phase 9 で `HARNESS_EXPORT_FILES=0` 時に ingest 成功後
削除する形になった。Phase 10 ではこれを **scratch materialization** として
明示する:

- `materializeRun({ purpose: 'scratch', ttlMs, reason })` が `runs/<runId>/`
  を作り、`run_materializations` に `status='active'` で row 記録。
- 呼び出し元は handle.cleanup() を finally で呼ぶ。`rmSync` + row を
  `status='cleaned', cleaned_at=now` に update。
- `HARNESS_EXPORT_FILES=1` の compat-export は別経路（`exportRun({ purpose:
  'compat-export' })`）で、`exported_files` + `runs.export_status='synced'`
  を更新する。run_materializations は触らない。
- ingest failure 時、`HARNESS_KEEP_SCRATCH_ON_FAILURE=1` set 時に限り path
  を保持し row を `status='failed'` に。後で `harness db materialize cleanup
  --expired` が回収。

post-run command（`harness review process` の git diff 生成、`harness pr
create` の patch 添付、external review 用 zip）は **必ず scratch** を使う。
compat-export を内部利用しない。

`run_materializations.metadata_json` には呼び出し元（command name /
caller_id）を入れて debug 性を確保する。

## Phase 11 — Review governance / consensus flow（close 済み・現状仕様）

Phase 11 で review consensus 機構（複数 proposal の決定論集約 `evaluateConsensus`）は
実装済み。`resolveEffectiveRule` は profile を呼び出し側から受け取る純関数で、`profile.review`
欠落時だけ `DEFAULT_REVIEW_RULE`（mode=`latest-proposal`）へ解決する。`profile.review`
が存在する場合は `compileProfileReviewRule` が snake_case YAML を `ReviewRule` の
camelCase 形へ変換し、`{ rule, source, ruleSha256 }`（`source='project-profile'`）を
返す。意味的に不正な `review:`（例: consensus なのに requirements が空、正でない
`min_approvals` / `quorum.min_participants`、複数 reviewer requirement の
`reviewer_ids` / `lens_axes` 欠落、**consensus requirements が frozen（`reviewer_ids`
あり）と非 frozen を混在**）は `ReviewRuleCompileError` で fail-closed になり、
DEFAULT へ降格しない。混在禁止の根拠は promote gate が active proposal を全 frozen
`reviewer_ids` の union で filter するため、混在すると非 frozen requirement の blocking
verdict が落ちる fail-open になる点（snapshot read-back 境界も同じ invariant を
`ReviewRuleSnapshotError` として強制する）。設計の基礎は
[`../superpowers/specs/2026-05-24-phase11-review-governance-consensus-design.md`](../superpowers/specs/2026-05-24-phase11-review-governance-consensus-design.md)。

`prepareProjectRun` は compiled policy と同じ project-runtime 成果物として
`reviewRuleResolution` を返す。CLI `run --project` / `rerun` / `workflow reviewed-run`、
hitch CLI、MCP `harness.hitch.orchestrate`、course orchestration はこの値を
`runDomainCoding` まで thread し、run 作成時に `run_review_rule_snapshots` へ凍結する。
`source='project-profile'` の snapshot 失敗は fail-closed（run は
`failed-internal-error` に finalize）で、legacy/default snapshot 失敗だけ従来どおり warning
で継続する。

### review auto → consensus re-evaluate flow

```
1. harness review auto <runId> --reviewer codex
2. reviewer-agent が verdict を作成
3. proposal を review_proposals に INSERT
   (reviewer_id / reviewer_type / model / prompt_sha256 /
   prompt_provenance_json / lifecycle='active' を埋める。file 由来 legacy
   verdict は prompt を持たないため prompt_* は NULL)
4. consensus evaluator を呼び、新 active consensus を review_consensus に
   INSERT (旧 active は superseded_at = now で update)
5. 旧 active proposal (同 reviewer) は lifecycle='superseded' に
```

複数 reviewer が並行で auto を走らせると、それぞれが proposal を insert
し、consensus が re-evaluate される。

consensus evaluator へ渡す active proposal は、DB の insertion order や dispatch order に
依存しない。集約直前に `reviewer_id ASC, proposal_id ASC` で正規化し、同じ順序を
`summary.proposals` / `includedRows` / `sourceProposalIds` / `required_changes` 生成に使う。
未知 reviewer は `groupId = null` / `reviewerType = unknown` として enrichment され、
per-group quorum を満たさない安全側に倒す。

`review auto` の hot-path INSERT は `ReviewProposalRepository.insertProposal`
内の `tx.immediate()` で完結する。transaction の先頭で `runs` row を読み、
`source_mode='db-first'` かつ `status='needs_review'` のときだけ、同 reviewer の
旧 active proposal を supersede して新 proposal を INSERT する。run row が無い、
`legacy-file`、または `review process` により `approved` /
`changes_requested` / `rejected` 等へ promote 済みの場合は
`ReviewerAgentGateError` を throw し、proposal は挿入されない。これにより
`review auto` の pre-check と INSERT の間で並行 process が run を promote する
TOCTOU race は fail-closed になる。

### review process — consensus mode

```
harness review process <runId>
  → rule.mode == 'consensus':
      active consensus を読む
      consensus.status ∈ {approved, changes_requested, rejected}:
        applyReviewDecision を呼び、proposals_summary を review_decisions に
        記録、processed proposals を lifecycle='processed' に
      consensus.status == 'pending':
        StateConflictError ("consensus not yet satisfied")
  → rule.mode == 'latest-proposal' (default):
      pre-Phase11 と等価動作 (最新 active proposal を直接 process)
```

`review_consensus.status = approved` は **static pass** を意味する。すなわち
reviewer / consensus が run artifacts と diff を静的に確認して blocking issue を
見つけなかったという evidence であり、`review_consensus` 自体は test command を
実行しない。`review_consensus.summary_json.semantics` と approved
`review-decision.yaml` の compat export comment はこの意味を明示する。
実テスト実行を close gate にしたい hitch は、別途 `kind: command` close condition
（例: `npm test` / `npm run typecheck`）を hitch 開始時に追加する。
`review_consensus` を synthetic test gate に拡張したり、reviewer の自己申告を
test 実行状態の遷移根拠にしたりしない。

### Human override

```
harness review process <runId> --override approved --reason "Critical hotfix" \
                               [--actor-reviewer lead]
  → rule.overrides.allowedReviewers に actor が含まれること検証
  → reason 必須
  → review_overrides に audit row
  → run_events に review_override
  → consensus re-evaluate (override がある場合は最優先)
  → applyReviewDecision で final decision に昇格
```

### Phase 2 — consensus 拡張（quorum / 鮮度 / stall escalation）

`evaluateConsensus`（`src/core/review-consensus.ts`）は Phase 11 の
requirement（per-group `minApprovals` / `blockingDecisions`）に加えて以下を
決定論的に評価する。設計は
[`../superpowers/specs/2026-06-05-phase2-consensus-extension-design.md`](../superpowers/specs/2026-06-05-phase2-consensus-extension-design.md)。

- **quorum / 参加率**: `ReviewRuleRequirement.quorum`（任意）。`minParticipants`
  はグループ内で non-pending な verdict を出した **distinct reviewer 数** の
  最低値、`minParticipationRate`（要 `groupSize`）は参加率。requirement の充足は
  `approvals >= minApprovals` **かつ** quorum 充足。quorum 未指定は従来挙動
  （`quorumMet = true`）。`minParticipationRate` 指定で `groupSize` が正でない場合は
  fail-closed（quorum 未達）。`ConsensusRequirementCheck` に `participants` /
  `quorumMet` を出力。
- **proposal 鮮度**: `ReviewRule.staleProposal`（`rejectSuperseded` /
  `maxAgeHours`）を集計前に適用。superseded（`EnrichedProposal.supersededAt`）/
  `maxAgeHours` 超過の proposal を除外し `ConsensusSummary.excludedProposals` に
  記録。timestamp 解析不能時は fail-closed（stale 扱いで除外）。負経過
  （reviewedAt が evaluatedAt より後）は除外しない。
- **summary JSON compatibility**: `review.refute` 未設定の rule では
  `ConsensusSummary` に `refute` key を出力しない。`review.refute` 設定時のみ
  frozen reviewer set / strict majority の refute summary を含める。
- **stall escalation**: `detectConsensusStall`（`src/core/consensus-stall.ts`、純
  関数）が consensus 評価スナップショット列（時刻昇順）から「詰まり」を判定する。
  直近 `stallAfterSnapshots` 件が unresolved（pending / changes_requested）のまま
  approvals / participants が増えない、または unresolved streak が
  `maxPendingHours` 超で stall。decisive（approved / rejected）は非 stall。
  hitch 連携（`src/hitch/consensus-stall-check.ts`）は hitch の review 対象 run の
  `review_consensus` 履歴から timeline を再構築し、stall 検出時に hitch を
  **`escalated`** に倒す（harness のみ状態遷移、fail-closed、新スキーマ無し）。
  単一 reviewer の決着フローでは no-op（後方互換）。LLM 出力は一切判定入力にしない。

#### production wiring（consensus mode の実経路）

Phase 2 で consensus mode が実フローに接続された（`src/core/consensus-enrichment.ts`）。

- **`review process`**: run の rule snapshot が `mode: consensus` の場合、単一
  proposal ではなく **全 active proposal**（reviewers registry で group / type を
  enrich）から `evaluateConsensus` を実行する（`processConsensusModePath`）。
  `reviewer_ids` が snapshot に凍結されている場合は、その frozen set に含まれる
  reviewer の proposal だけを評価対象にする。結果が `pending`、または評価対象の
  active proposal が 0 件なら、**promote せず fail-closed**（typed
  `ReviewGateError`）。decisive（approved / changes_requested / rejected）なら
  consensus 由来の decision で run を promote し、consensus row を実 proposal から
  記録、集計対象 proposal を processed にする。`mode: latest-proposal`（既定）は
  従来の単一 proposal 経路のまま。
- **`review auto`**: proposal insert 後、consensus mode なら全 active proposal で
  consensus を再評価し `review_consensus` に（pending を含めて）記録する。この再評価も
  frozen reviewer set がある run では frozen set 外 proposal を除外する。これにより
  multi-reviewer consensus と stall 用の timeline が蓄積される（best-effort: 記録失敗は
  insert を巻き戻さない）。
- **`hitch orchestrate` review runner**: 最新 coding run の snapshot が consensus mode かつ
  `reviewer_ids` を持つ場合、orchestrator は frozen reviewer set を `reviewer_id ASC`
  で逐次 dispatch する。dispatch 前に frozen reviewer の既存 active proposal を
  supersede して、この review cycle で land した proposal だけを参加者候補にする。
  各 reviewer は `allowOverwrite:true` で `runReviewerAgent` に渡されるため、別 reviewer
  の active proposal がある resume/manual 状態でも dispatch が止まらない。timeout /
  non-zero / parse failure など clean な reviewer failure は non-participant として
  記録し、artifact tamper 等の判別不能な reviewer failure は fail-closed に伝播する。
  全 reviewer が clean に失敗して active proposal が 0 件でも、orchestrator は
  no-active-proposals gate error を外へ伝播しない。pending `review_consensus` row と
  hitch review cycle を記録し、既存の consensus-stall detector を実行したうえで
  `decision: pending` を返す。この例外は frozen dispatch かつ clean reviewer failure
  がある cycle に限定し、非 frozen consensus の pending gate は従来どおり
  `ReviewGateError` として fail-closed に surface する。decisive process 後に runner
  が返す `decision` は最後の individual reviewer verdict ではなく、
  `processReviewDecision` の aggregate status。
- **`hitch orchestrate` refute runner**: consensus snapshot が `review.refute` を持ち、
  normal reviewer proposal の決定論的 pre-eval が unrefuted
  `changes_requested` blocker を検出した場合、orchestrator は promotion 前に frozen
  refute reviewer set を `reviewer_id ASC` で dispatch する。dispatch target は
  active proposal の `required_changes` を `targetChangeHash()` で dedupe した
  target-bound list で、既に strict-majority refute 済みの target は再 dispatch しない。
  各 refute reviewer は target ごとに `runRefuteAgent` へ渡され、出力は
  `review_refute_votes` にだけ append される（`review_proposals` は汚染しない）。
  その後 `processReviewDecision` が同じ run の active proposal + refute audit rows を
  transaction 内で再評価し、strict-majority refute が成立した target の
  `changes_requested` blocker だけを neutralize する。refute reviewer の registry /
  group が strict majority を満たせない場合は dispatch 前に
  `ConsensusReviewPreflightError` で fail-closed に止まる。

> 既定の rule は `latest-proposal`（`profile.review` 欠落時の `resolveEffectiveRule`）
> なので、上記 consensus 経路は profile が consensus mode を宣言したときのみ作動する。
> 既存フローは不変。

### 安全境界マッピング（LLM 出力 = 入力 / 集約・状態遷移 = 決定論ゲート）

review → consensus → `run.status` の全経路は「**LLM の出力は入力（提案）に過ぎず、集約と
状態遷移は決定論ゲートのみが行う**」という不可侵境界の上に載る。各層の現状の責務と根拠を
1 枚に集約する（本節は既述の分散した保証を整理したもので、新規挙動ではない）。

| 層 | 担い手 | 入力 / 権威 | 根拠（本ファイル内） |
|---|---|---|---|
| **(1) 提案（入力）** | LLM reviewer（codex agent） | proposal を `review_proposals` に INSERT するだけ。`runs.status` は一切動かさない | 「review auto と review process の権限境界」 |
| **(2) 集約** | `evaluateConsensus`（`src/core/review-consensus.ts`、純関数・決定論） | proposal の **decision ラベル**の集合濃度 quorum + 固定 tie-break（`rejected > changes_requested > approved > pending`）+ stale filter。LLM 自己申告 severity / confidence は集約入力にしない | 「Phase 2 — consensus 拡張」 |
| **(3) 状態遷移** | `review process` の review-decision guard（`RunRepository.applyReviewDecision`、`status='needs_review'` ガード） | 現 status が `needs_review` のときだけ遷移（`WHERE status='needs_review'`）。consensus が `pending` なら **promote せず fail-closed**（`ReviewGateError`）。多数決結果を直接 `run.status` にしない | 「review process — consensus mode」 / 「state transition guard」 |

不可侵の帰結（いずれも現状で成立）:

- **severity は harness 由来マッピング**（`required_change`→P1 / `non_blocking`→P2 等）で、
  reviewer の自己申告 severity を遷移根拠にしない。
- **stall escalation は harness のみ**が決定論で行う（`review_consensus` 履歴の timeline が
  入力で、LLM 出力は判定入力にしない）。
- **artifact tamper は fail-closed**（`verifyArtifactsUnchanged` → `ReviewerAgentGateError`）。
- **rule snapshot の読み戻しは fail-closed**: 永続化済み `rule_json` を runtime で読む
  全経路は raw `JSON.parse` ではなく `parseReviewRuleSnapshot` を通す。JSON 不正・
  未知 mode・`{mode: consensus, requirements: []}`（gate が空になる fail-open 形）・
  非 path-safe reviewer id などは typed `ReviewRuleSnapshotError`（`ReviewRuleCompileError`
  家族）で throw し、緩い default に降格しない。
- **frozen consensus の preflight は dispatch 前に fail-closed**: frozen reviewer set に
  未登録 reviewer がいる / 必要数を満たす group メンバが揃わない場合、reviewer を 1 人も
  起動する前に typed `ConsensusReviewPreflightError`（`causeKind` =
  `unregistered` / `under_quorum` / `wrong_group` / `no_reviewers`）で停止し、
  orchestrator の clean escalation に倒す。multi-reviewer の frozen requirement では
  同じ preflight で reviewer registry の `metadata_json.lens` を決定論的に検査し、
  lens 未設定 / `lens_axes` 未カバー / lens 重複 / metadata 不正も
  `missing_lens` / `missing_axis` / `duplicate_lens` / `invalid_lens` として dispatch 前に
  fail-closed で止める。
- 迷ったら fail-closed（quorum 未達 / rule 不正 / timestamp 解析不能はいずれも安全側）。

frozen consensus dispatch は各 reviewer の `metadata_json.lens` /
`metadata_json.lens_prompt` を `runReviewerAgent` へ渡す。`runReviewerAgent` は
`PROMPT_PREAMBLE` の後に `## Reviewer lens (untrusted)` section を追加し、
`lens_prompt` を `<lens>` fence 内へ中和済み text として入れる。`prompt_sha256` は
この lens section を含む最終 prompt 全文で計算し、`prompt_provenance_json.lens` に
`{reviewerId,lens,lensPromptSha256}` を保存する。lens は proposal を多様化する入力であり、
`evaluateConsensus` の quorum / tie-break / state transition には参加しない。

> **反証 verify の現状仕様**: SP-16 の app 層 target binding に加え、SP-17
> Phase 2 P2-A/B/C で `review.refute` DSL、`runRefuteAgent`、および
> `evaluateConsensus` の target-bound 第2 requirement が実装済み。
> `runRefuteAgent` は通常の `review_proposals` ではなく append-only
> `review_refute_votes` にだけ書く。codex cwd は runDir 外の OS 一時ディレクトリで、
> materialize する refute 入力は diff artifact（`final-diff.patch` /
> `untracked-*.patch`）と `commands/` の test log に限る。root
> `review-decision.yaml` と `reviewers/` は cwd に入れない。run 後は runDir snapshot
> を検証し、codex が許可 log 以外の artifact を改変/追加/削除した場合は
> `validation_status='rejected'` / `reject_reason='artifact_tamper'` にする。
> `refute_verdict='refute'` は
> `refute_reason`、`counter_evidence.kind in {diff,test}` + artifact ref、
> `refute_condition`、`retract_condition` が揃い、target binding と artifact
> existence が決定論検証された場合だけ `validation_status='passed'` になる。
> existence 検証は kind/type binding も含む: `kind='diff'` は `final-diff.patch`
> または root の `untracked-*.patch`、`kind='test'` は `commands/*.out.log`
> だけを受理する。artifact 内容の説得力は評価しない。
> `kind='none'` の refute は `reject_reason='evidence_none'` で rejected。
> `uphold` は target binding が有効なら `kind='none'` でも passed participant、
> `inconclusive` は passed でも participant から除外される。
>
> `evaluateConsensus` は `review.refute.reviewerIds` の frozen set を denominator に
> `refutes > expectedReviewers / 2` の **strict majority** だけを refuted target と
> みなす。rejected / inconclusive / group mismatch / frozen set 外 / duplicate reviewer
> vote は fail-closed で majority に数えない。strict majority に到達した target の
> `changes_requested` blocker だけが neutralized され、`rejected` decision は refute
> できない。通常 consensus の quorum / tie-break / `needs_review` status guard は不変で、
> severity mutation は経由しない。
> `review_consensus` の advisory / pending re-evaluation rows も同じ refute audit rows を
> summary に反映するが、promotion 権限は持たない。run の status transition は常に
> `processReviewDecision` の transaction が再評価した decisive consensus だけで行う。

## Phase 19 — hitch convergence（close 済み・現状仕様）

Phase 19 は `domain-coding` の **状態機械は変えない**。代わりに 1 つ以上の
`domain-coding` run を **hitch session** で束ね、反復 loop が scope を無限に
広げる代わりに `close_ready` / `diverging` / `budget_exhausted` で停止できる
ようにする。DB schema は [`db.md`](./db.md) の「Phase 19」節、feature spec は
[`hitch-convergence.md`](./hitch-convergence.md)。本書では hitch の状態遷移と
`domain-coding` workflow との境界を記述する。

### hitch session と run の関係

hitch session（`hitch_sessions`）は session 開始時に **scope と close 条件を
freeze** する。session 内の各作業は `hitch_attempts`（`implement` / `fix-review`
/ `rerun` / `validate` / `close-check` / `classify-findings` /
`defer-followups` など）として記録され、`implement` / `rerun` 系 attempt は
`run_id` で個別の `domain-coding` run に紐づく。review は `hitch_review_cycles`
（mode `initial → delta → close`）として記録され、検出された問題は
`hitch_findings` に分類（`in_scope` / `out_of_scope` / `unknown` /
`duplicate`）されて貯まる。

run / review の中身は Phase 5〜11 の挙動そのままで、新しい `RunStatus` や
新しい review 遷移は導入しない。hitch は周辺の attempt / cycle / finding /
close-check を記録する **上位 control plane** にとどまる。

**review proposal → finding 分類**: hitch に紐づく `review process` は proposal を
`hitch_review_cycles` に import し、`required_changes` を P1 finding seed として通常の
frozen-scope classifier に通す。scope に合う required change は in-scope blocker、
scope 外/unknown は defer または operator 分類が必要で、fail-open にはしない。
`non_blocking_comments` は原則 P2 finding seed だが、「tests/checks were not run /
could not be run」および「command logs が無い / 見えないため test 実行を確認できない」
系の generic reviewer advisory（local / environment / sandbox / reviewer context を
含むもの）は deterministic pattern で hitch finding 化しない。注記自体は review
proposal / review decision の `non_blocking_comments` に残り、hitch import の
`reviewAdvisories` と `hitch_close_checks.evidence.reviewerAdvisories` として operator に
surface されるが、`hitch_findings` には入らず `needs_classification` /
auto-merge escalation の原因にしない。
この carve-out は non-blocking comment の環境メタ注記だけに適用し、`required_changes`、
close-check failure、実 test failure は従来どおり blocker として扱う。negative decision
に `required_changes` が無い場合は in-scope P1 blocker を作り、negative verdict が
誤って `close_ready` にならないようにする。`out_of_scope_suggestions` は out-of-scope
follow-up として記録される。

**finding 分類（`needs_classification`・3 フェーズ熟議）**: convergence が
`needs_classification` を返す（open かつ `unknown`-scope の finding がある）と、
orchestrator は classify runner（`src/hitch/orchestrator-runners.ts` →
`src/hitch/jury/classify-runner.ts`）を **3 フェーズの DB 分離**で回す（#230 合議制
jury）。安全境界の核心: 状態遷移は harness のみ、`repo.classifyFinding` は決定論ゲート
Stage5 の `auto_confirm` のみで走る（LLM 出力が scope/severity/status を直接書かない）。

**2 つの決定論的決定者・finding 集合を MECE に分割（LLM の発話は分類を決して駆動しない）**:
open かつ `unknown` の finding は、重なりなく **どちらか一方** の*決定論的*（非 LLM）決定者で
解決される。(1) **決定論ヒューリスティック**（`classifyFindingForHitch`・非 LLM・Phase 1）が
解ける明白な **harness-origin** finding は **jury が走る前に**直接分類され（`classifyFinding`）、
jury は **bypass** される（proposer/critique/refuter 呼び出しも監査行も無し）。(2) **決定論ゲート**
（`aggregateDeliberation`・Stage5）は、ヒューリスティック後も `unknown` の残った **jury 候補**
（harness-origin かつ未解決）だけを arbitrate する。したがって **「決定論ゲートが唯一の arbiter」**
不変条件は **jury 候補に限定**して適用される（ヒューリスティック解決分は同じく決定論的な
ヒューリスティックが arbitrate）。どちらの経路でも判定は決定論的な harness ロジックが下し、
LLM の提案/批判/反証はゲートへの *advisory input* に過ぎず決定者ではない。第三の経路も重なりも
無い（finding は ヒューリスティック解決・jury 判定・operator-origin escalate のいずれか一つ）。
正本は [`hitch-convergence.md`](./hitch-convergence.md) の Monotonic 不変条件 §0。

- **Phase 1（DB open・同期 snapshot）**: open かつ `unknown` の finding を origin で分割
  する。**operator-origin（`source` が `human`/`mcp`）は heuristic も jury も通さず**、
  manual 分類のため bundled escalate packet に束ねる（fail-closed・機械分類しない）。
  harness-origin（`review`/`test`/`doctor`/`codex`/`other`）は既存 heuristic
  （`classifyFindingForHitch`）を適用し、確定したら即 `classifyFinding`（heuristic が
  jury を bypass する）。なお `unknown` のものを **jury 候補**として snapshot する。
  heuristic ドレインには既存の no-progress guard を残す（heuristic 確定が DB に効かない
  ケースのみ escalate であり、jury defer を escalate に誤判定しない）。DB を閉じる。
- **Phase 2（DB 閉・LLM）**: jury 候補のうち先頭 `JURY_BATCH_LIMIT`（既定 **25**）件に
  対して `deliberate()`（Stage1 提案 → Stage2 決定論証拠検証 → Stage3 批判 → Stage4
  敵対反証 → Stage5 純関数ゲート）を**メモリ実行**する。DB ハンドルは await を跨いで
  保持しない（reviewer path と同方式）。finding 1 件あたり 4〜7 codex 呼び出し
  （3 lens 提案 + 任意の 3 critique + 1 refute）。最悪上限は `JURY_BATCH_LIMIT × 7`
  ≒ 175 呼び出し/invocation で、`FINDING_BATCH_LIMIT`(200) 以下に抑える。
- **Phase 3（DB 再 open）**: 各 outcome について、(a) 生成された監査行
  （proposals R1/R2・refutations・severity_audits）を **skip 有無に関わらず全て永続化**
  （P2k）、(b) finding がまだ `unknown`+open か再検証（jury 中に他経路が分類した finding は
  `classifyFinding` を skip し監査行だけ残す）、(c) auto_confirm の file-kind verified
  citation を現 worktree に対し `verifyEvidence` で **再 stat**（path 消失/行範囲外なら
  stale → auto_confirm 取り下げて escalate。spec/policy は immutable 扱い）、(d)
  auto_confirm かつ fresh なら `classifyFinding`（reason に駆動した `deliberation_id` を
  刻む: `jury auto_confirm (deliberation_id=<id>)`）、(e) severity 乖離は non-escalating
  な severity packet を `resolved:true` 結果に添える、(f) escalate（split / refuter veto /
  弱証拠 / stale）は bundled escalate packet に束ねる。DB を閉じる。

**batch cap と次 invocation 持ち越し**: jury 候補が `JURY_BATCH_LIMIT` を超えると、この
invocation では cap 件だけ処理し、結果に additive な `moreUnknownsPending:true` を立てる。
orchestrator はこれを見て **当該 invocation のループを clean に halt**（escalate ではない）
する。残りの `unknown` は次回 `orchestrate` invocation の convergence が再び
`needs_classification` を返して処理する。これで per-invocation のコスト上界を 1 jury batch に
抑える。classify runner の戻り型は `ClassifyRunnerResult`（`resolved:true`〔任意で
`severityAuditPacket` / `moreUnknownsPending`〕／ `resolved:false`〔`decision:'escalate'` +
`escalateReason` + consultant 級 `decisionPacket`〕）。MCP `hitch.classify_finding` /
CLI `hitch classify` の standalone 呼び出しは reviewer/worktree/audit context を持たないため
**jury を起動せず従来どおり heuristic + operator-manual**（fail-closed）。

**escalate packet の永続化（WI-9b）**: classify runner が `resolved:false`（jury split /
refuter veto / 弱証拠 / stale）を返したとき、orchestrator は escalate outcome を return する
**前に** `recordConvergenceDecisionWithStatus({ decision:'escalate', reason:escalateReason,
metrics（当該 iteration の convergence metrics を再利用）, recommendedNextAction（consultant 級
`decisionPacket` を含む）, createdBy })` を呼んで decision を `hitch_convergence_decisions` に
永続化する。これで packet（jury reasoning / next actions）が operator 向けに残る（dashboard /
escalation log）。status は既定の `updateStatus:true` で `escalated` に同期する（この escalate は
status を倒すべき経路なので正しい）。状態遷移は harness のみ: LLM 出力が status を直接書かず、
この決定論的な record が唯一の sync 経路。`recommendedNextAction` の `kind`/`message`/`findingIds`
は後方互換のため常時 populate される。

**severity packet の non-escalating 記録（D2b・rollup-neutral）**: classify runner が
`resolved:true` を返し、かつ `severityAuditPacket` を添えている（scope は jury auto_confirm で
確定したが、決定論的 severity audit が harness mapping と乖離した）とき、orchestrator はこの
advisory packet を **1 回だけ non-escalating に記録**する: `recordConvergenceDecisionWithStatus({
updateStatus:false, decision:'continue', reason:<severity 乖離の advisory 文言>, metrics（当該
iteration の convergence metrics）, recommendedNextAction（`kind:'ask_human'` ＋ `findingIds` ＋
`decisionPacket`）, createdBy })`。**hitch status も course/phase rollup も不変**にするため二重の
非 blocking を取る: (1) `updateStatus:false` で hitch status を sync しない、(2) `decision:'continue'`
は rollup の blocked-set（`escalate`/`diverging`/`budget_exhausted`/`needs_classification`、
`orchestrate-dispatch.ts`）の **外** かつ `statusForConvergenceDecision('continue')===null`。
`escalate`/`needs_fix` 等を使うと updateStatus:false でも rollup が最新 decision の値で linked phase を
block するため不可。severity mapping は authoritative・不変であり、この記録は監査・operator review 用の
advisory に限る（状態遷移は harness のみ・LLM が status を倒さない）。record 後は
`moreUnknownsPending` の halt 判定を適用してから loop を継続する。

**packet の後方互換 read（packetVersion・#230 D6 / design §0.1 R6）**: `decisionPacket`
は現行 `packetVersion: 2`（consultant 級 MCDA）。一方、旧版ハーネスが
`hitch_convergence_decisions.recommended_next_action` に永続化した `packetVersion: 1`
の packet 行は migration で消えず DB に残り得る（`deliberation` / `evidence` /
`findings[].deliberationId` が**欠落**）。stored decision を読む経路は **packet shape に
非依存**で設計する: 既存 reader（`HitchRepository.listDecisions` → `rowToDecision` は
`recommended_next_action` を丸ごと `JSON.parse` して `HitchNextAction` として返すだけ・
packet sub-field を触らない / CLI `hitch status` は decisions をそのまま JSON・
`formatHitchStatusLine`〔packet 非参照〕へ渡す / MCP・CLI の run summary は
`recommendedNextAction.kind`〔v1/v2 共通〕のみ参照 / dashboard snapshot・data-source は
両 field を参照しない）。将来 packet sub-field を読む reader を足す場合は **`packetVersion`
で discriminate ＋ optional chaining ＋ default fallback** を徹底し、v1 行（v2 専用 field
は undefined）で throw しないこと。v1/v2 双方の read-back round-trip は
`decision-packet-reader-compat.test.ts` で固定する。

**rerun への finding 注入**: `rerun` 系 attempt（prior coding attempt が既に
ある coder 実行）では、open in-scope finding（lifecycle が `open`/`reopened`/
`escalated`）を集約して coder のゴール文言末尾に「Open in-scope findings to
address」ブロックとして注入する（`augmentGoalWithOpenFindings`）。run 単体の
`required_changes` 注入（`core/rerun.ts`）の hitch-mode 版で、これが無いと rerun は
元のゴール文言だけで「何を直すか」を知らずに再コーディングしてしまう。初回
`implement` pass では注入しない。`unknown`-scope finding は**分類前なので注入
しない**（fail-closed）。件数は上限付き（既定 25・超過分は明示注記）。

**failed-run からの recovery rerun**: 直近の coding attempt が review 到達前に
`failed`（例 `failed-command`）だった場合、convergence は review でなく `needs_fix`/
`fix_findings`（＝coder rerun）へ route する（review runner は `needs_review` 以外で
throw し hitch を dead-end させるため）。この recovery rerun の coder ゴールには失敗した
run status を `augmentGoalWithFailedRun` で注入し、原因を直すよう促す（blind な再
コーディングを避ける）。rerun budget を使い切ると `budget_exhausted` で clean に停止
（無限 rerun しない）。

**rerun の continuation（親 run の作業を引き継ぐ・#163）**: hitch の fix-loop rerun は
親 coding run の作業を **uncommitted な working-tree state として子 run の worktree に
materialize** し、codex がゼロから再実装せず in-place で amend できるようにする。
**commit は一切しない**（`git add`/branch mutation も無し）。親の作業は子 worktree の
uncommitted state としてのみ存在するため、既存の untracked-denied / secret-suspect /
redaction 処理が子 run の diff に特例なしでそのまま効き、git object store / branch /
`final-diff.patch`（committed object）に何も漏れない。

- **resolution（read-only, mutation 無し）**: orchestrator の `coder()` は rerun のとき
  最新 coding run（＝親）の行・worktree path を読み、3 つの gate を read-only に判定する
  （domain lock 取得前に mutation は一切しない）:
  1. **validated-parent gate**: 親 run の **status / safetyStatus が policy-validated
     （完了＋通過）** な場合のみ継続する。継続可能 status は `needs_review` / `approved` /
     `changes_requested`（いずれも path-policy validation を `allowed` で通過済み ＝ worktree
     surface が policy-valid）に加え、`failed-command` は **`safetyStatus=allowed` のときだけ**
     継続可能とする。`failed-command(allowed)` は allowedCommands が失敗しただけで、失敗前後
     の worktree surface は path-policy validation を通過済みなので、recovery rerun はその
     validated surface を amend できる。`failed-policy-violation`（scope 外/deny path を抱える）・
     `failed-command` でも `safetyStatus` が `allowed` でない/欠落しているもの・
     `failed-internal-error`（reset 不能の partial-carry worktree かもしれない）・
     `failed-codex` 等は非 validated → 継続せず `parent_not_validated` で skip し、
     fresh-from-base で再導出する（禁止/部分変更を carry しない）。`rejected` も継続しない。
  2. **base-equality gate**: `parent.baseSha === fresh に解決した base`（read-only
     `git rev-parse`、policy の `gitTimeoutMs` で timeout）。
  3. **worktree existence**: 親 worktree が在ること。

  全て通れば `continueFrom`（親 worktree）と gate 済み `resolvedBaseSha` を `runDomainCoding`
  に渡す。どの gate で落ちても **lineage（parentRunId / rootRunId / rerunAttempt）は必ず
  渡す**（後述）。
- **materialize（domain lock 下・`createWorktree` 後）**: 子 worktree を base から新規作成した
  **後**に、親 worktree の **policy-validated diff surface** を子へ反映する。surface は
  live run と同一定義 = tracked changed paths（add/modify/delete）＋
  `partitionUntracked(untracked, policy.ignoreUntracked).kept`。**policy で ignore される
  untracked（node_modules/dist/.harness 等）は除外**。各 entry は反映前に **子側 dst を
  recursive+force で rm**（no-follow）してから再作成する: これで (a) base symlink を通した
  write-through（worktree 脱出）を防ぎ、(b) 親が path の **kind を入れ替えた**ケース
  （file↔dir / link↔file）でも EEXIST/EISDIR/ENOTDIR にならず継続する。具体的には —
  **symlink は live run の no-follow モデルに合わせて決して dereference しない**（`lstat`
  判定 → `readlink`/`symlink` で symlink として再作成、broken/dangling も symlink のまま）/
  **親が tracked dir を regular file に潰した**ら子の dir を recursive 削除して file を copy /
  **親が tracked file を dir に展開した**ら（src が directory）`cp -r`（no-dereference）で
  tree を再作成 / 親で消えた path（ENOENT・祖先が file 化した ENOTDIR）は子から recursive
  削除。すべて uncommitted。
- **diff/policy base は常に fresh な `baseSha`**（親 tip ではない）。`git diff baseSha` of
  child = 親の変更 + codex の amend。親が触った deny path はそのまま violation。
- **lineage（materialize の有無に関わらず必ず記録）**: 子 `rerunAttempt` は親の **chain
  depth + 1**（親が `rerun_attempt` を持てば `+1`、持たない legacy 親は `parentRunId` chain
  を walk して depth を再構成し `0+1` に潰さない）。`rootRunId` = `parent.rootRunId`（無ければ
  `parentRunId` chain を root まで walk。legacy 親が自身 parentRunId を持つ場合に
  `parent.runId` を root と誤らない）。**継続が skip された場合でも parentRunId / rootRunId /
  rerunAttempt を `runDomainCoding` に渡す**（gate されるのは materialization だけで chain/
  audit ではない）— skip した fresh-from-base 子が新 root になり chain が切れることはない。
  この lineage parent（`continuationParentRunId`）は **duplicate-child gate**（domain lock 下・
  `runDomainCoding`）も keying するので、同一親を解決した 2 つの並行 orchestrator が両方とも
  子を作ることはない（one child per parent）。各子は自分の親を行に記録するので連続 rerun では
  誤発火しない。
- **fail-closed（atomic）**: 曖昧さは全て fresh-from-base に倒し、escalate / throw しない。
  materialize は **all-or-nothing**: copy/remove loop の途中で 1 entry でも失敗したら、
  fallback する **前に** 子 worktree を clean fresh-from-base に reset する
  （domain lock 下で `git reset --hard <baseSha>` + `git clean -ffdx`）。半分だけ
  materialize された partial carry の上で codex が amend することは無い。**reset 自体が失敗
  したら**（clean fresh-from-base に戻せない ＝ amend 不能）skip ではなく `WorktreeResetError`
  を throw して run を hard fail させる。理由を `continuation_skipped` run event に記録する:
  `parent_run_missing`（親 run 行が無い）/ `parent_not_validated`（親 status が非 validated）/
  `parent_work_unavailable`（worktree が無い/cleaned/clean/surface 無し）/ `base_advanced`
  （`parent.baseSha != fresh base`）/ `parent_work_unmaterializable`（git/copy 失敗——reset
  で fresh-from-base 化済み）。git 例外は throw でなく fallback にマップする。base resolve
  が gate で失敗した場合は `resolvedBaseSha` を渡さず、`runDomainCoding` が通常 run と同じく
  自前で base を解決する clean な no-throw skip になる（run 行作成前に throw を増やさない）。
  継続成功時は `continuation_materialized` event（parentRunId / baseSha / paths）を記録する。

### convergence decision → hitch status 連携

各 cycle / attempt の後に convergence evaluator（`src/hitch/convergence.ts` の
`ConvergenceService.evaluate`）が close 条件・finding・budget を総合して
1 つの decision を出す。decision は `hitch_convergence_decisions` に audit
記録され、**同時に `hitch_sessions.status` を遷移させる**
（`src/hitch/convergence-status.ts`）:

```txt
decision           → hitch status
close_ready        → close_ready
diverging          → diverging
budget_exhausted   → budget_exhausted
escalate           → escalated
continue / needs_* → (status 据え置き)
closed / cancel    → (terminal; status は close/cancel 経路で確定)
```

`statusForConvergenceDecision` が status を持たない decision
（`continue` / `needs_fix` / `needs_classification`）を返した場合、status は
原則据え置きだが、`close_ready` だった hitch が再び fix を要する decision を
受けると `in_progress` へ戻す（`syncHitchStatusForConvergence`）。
`closed` / `cancelled` は terminal で、どの decision でも live status へ
戻さない（data-layer guard）。

decision の優先順位は close 条件の評価結果と budget・finding に基づく
（概略）:

```txt
terminal (already closed/cancelled) → そのまま
budget 超過                          → budget_exhausted
open in-scope P0                     → escalate
… (close 条件 / open in-scope finding / unknown finding を順に評価) …
すべての required close 条件 pass    → close_ready
それ以外                              → continue / needs_fix / needs_classification
```

close 条件は **opportunistic な review 拡張より先**に評価される。元の close
条件が pass し、残るのが out-of-scope / accepted-risk / escalated / deferred の
follow-up finding だけなら hitch は close できる。open な in-scope P0/P1 finding
は通常の deferred work として扱えない（[`hitch-convergence.md`](./hitch-convergence.md)
の Core Rules を参照）。

## Phase 3 — auto-merge（opt-in・既定 OFF・現状仕様）

`harness hitch orchestrate` の terminal step（`close_and_pr`）は PR 作成後に
**opt-in の auto-merge** を実行できる。既定 OFF（`--auto-merge` 指定時のみ）。設計は
[`../superpowers/specs/2026-06-05-phase3-auto-merge-design.md`](../superpowers/specs/2026-06-05-phase3-auto-merge-design.md)。

- **merge gate（pure・決定論的）**: `evaluateMergeGate`（`src/core/merge-gate.ts`）。
  入力は DB の事実（close-ready / active `review_consensus` の status + quorumMet /
  human override approve）＋ CI green（`gh pr checks` の snapshot）＋ sensitivity-map
  tier gate。承認は **consensus approved（quorum 達成）or human override approve** が
  必須（fail-closed）。`--auto-merge` 指定時も tier gate は常に有効で、auto-merge
  対象は Tier-0（既定 map: `docs/**` / `tests/**`）だけ。Tier-2（絶対 auto 不可）は
  `src/policy/**`, `src/codex/**`, `src/core/merge-gate.ts`, `src/hitch/**`,
  `src/core/reviewer-agent.ts`, `src/db/repositories/review-*.ts`,
  `src/db/migrations*`, `.github/**`, `policies/**`。未マップ path は Tier-1。
  blocker は hard（`not_close_ready` / `consensus_not_approved` / `quorum_not_satisfied`）
  と transient（`ci_not_green` / `tier_not_auto_eligible`）に分かれる。
  **operator override**: `policies/automerge-tiers.yaml`（任意・`{version: 1, rules:
  [{glob, tier}]}`）があれば、その rule を既定 map に**追記**する
  （`src/core/automerge-tiers-config.ts`）。`tierForPath` は全マッチの **max tier** を
  取るため、operator rule は path の tier を**上げる（厳格化）方向にしか効かず緩め
  られない**（既定 Tier-2 は operator Tier-0 に勝つ）＝fail-closed。ファイル不在は
  既定 map、**malformed は throw**（壊れた merge-gate policy で黙って既定にせず停止）。
  **tests additive-only ガード**: Tier-0 でも、run の diff が **`tests/**` ファイルを
  削除**・**skip/only/todo マーカーを追加**・**test/suite 定義を純減**（同一 `tests/**`
  ファイル内で定義の削除数 > 追加数）していれば（`detectsTestWeakening`、run 時に
  `meta.reviewed.weakensTests` として捕捉）、tier を **Tier-1 へ降格**して auto-merge
  不可にする — カバレッジを削る変更が自動マージで silent に入るのを防ぐ。純減判定は
  **ファイル単位**（足すだけの別ファイルが削るファイルを隠せない）で、バランスした
  rename/refactor（削除数 == 追加数）は降格しない。両誤り方向で fail-safe（false-positive
  は人手 merge=安全 / false-negative は削除・skip シグナル単独と同等）。
- **closeAndPr の分岐**（`src/hitch/orchestrator-runners.ts`）: PR 作成後、
  `deps.autoMerge` があれば gate を評価する。`closeAndPr` の PR 結果と
  `OrchestrationResult` は PR の draft 状態を `draft: boolean` として保持する。
  outcome enum の値は不変で、draft PR の作成でも `outcome` は **`pr_created`** のまま
  （CLI が `draft=true|false` を別フィールド表示）。
  - **PR タイトル（#103）**: `closeAndPr` は hitch title から **Conventional Commit** 形式の
    タイトル（`conventionalPrTitle`：hitch title が既に conventional ならそのまま、でなければ
    `fix:` を付与し `(run-<id>)` を付す）を作り、`createPullRequest({ title })` に渡す。
    `pr-creator` はこのタイトルを **PR title かつ branch commit subject** に使う（squash 設定が
    PR title / commit message のどちらでも squash subject が conventional になり、release-please が
    version/CHANGELOG に拾える）。`(#NN)` は GitHub issue autolink を避けるため使わない。
  - `canMerge` → `gh pr merge --match-head-commit <sha> --<method>`（idempotent:
    既マージ検出、**head commit に pin**: CI 判定前に取得した head SHA に固定し
    head が動けば拒否→escalate）で merge、operation audit（`operations`,
    type=`merge`）に記録、outcome **`merged`**。auto-merge 有効時は PR を
    **non-draft** で作成（draft は merge 不可）。CI 判定は `gh pr view --json
    headRefOid,statusCheckRollup` を `--ci-await-timeout`（既定 1200 秒）まで bounded
    poll する。各 poll の atomic snapshot で head OID != reviewed commit なら即 false
    （head moved, fail-closed）。非空 rollup の全 check が terminal（CheckRun
    `status=COMPLETED`、または StatusContext `SUCCESS` / `FAILURE` / `ERROR`）なら、
    全 green（CheckRun `SUCCESS` / `NEUTRAL` / `SKIPPED`、または StatusContext
    `SUCCESS`）のみ green、いずれか failure/error は即 false。pending / empty rollup は
    poll interval 後に再評価し、timeout 到達・取得失敗・不明 shape は false（ABA race
    安全、不確定は fail-closed）。
  - `hardBlocked` → **merge せず escalate**（fail-closed、hitch は `escalated`）。
  - transient（CI 未 green、または Tier-1/Tier-2）→ merge せず PR を残す
    （outcome `pr_created`）。**resumable な later-merge**: transient が
    **`ci_not_green` のみ**（再チェックで解決しうる temporal な blocker）なら hitch を
    `closed` でなく **`close_ready`** に残す。後続の `hitch orchestrate` が closeAndPr に
    再入し（`createPullRequest` は既存 PR を冪等に返し、reviewed head SHA を run branch
    の tip から解決）、CI が緑になっていれば merge する。`tier_not_auto_eligible`（tier は
    変わらない＝再チェック無意味）は従来どおり `closed`（人手 merge）。新 status /
    migration なしで `close_ready` を「PR up・CI 待ち」に二重利用する。
  - **外部レビュー ingestion**（opt-in `--ingest-external-reviews`）: gate 評価前に
    PR の外部レビュー verdict（codex App / Copilot）を fetch し、**`CHANGES_REQUESTED`**
    を **unknown-scope の advisory finding**（`source=review` /
    `category=external-review-changes-requested`、stableKey で 1 度だけ）として記録する。
    すると closeReady 再評価が落ち gate が escalate → operator が分類（§6: 外部は
    advisory・operator 分類必須）。**approve は ingest しない**（外部の approve は merge を
    authorize できない＝§0 非対称）。fetch 失敗は握って merge path を壊さない。
  - **外部レビュー bounded await**（opt-in `--external-review-timeout <seconds>`、既定
    `0`＝単発 fetch）: CI bounded await と対称。外部レビューは PR 公開後に非同期で
    post されるため、一発の orchestrate が verdict 到着前に gate を評価しうる。正値なら
    `CHANGES_REQUESTED` が出るか budget が尽きるまで 15 秒間隔で poll する（最初に
    blocking を見つけた時点で打ち切り）。budget 内に blocking が無ければ gate 評価へ進む
    （fail-safe。遅れて来た verdict は close_ready 再 check で後から拾える）。`now`/`sleep`
    は注入可能（テスト用）。
  - merge コマンド失敗 → 例外で escalate（audit は `failed`）。
- **既定 OFF**: `deps.autoMerge` 不在（CLI で `--auto-merge` 未指定）なら従来どおり
  PR 作成のみ（`pr_created`）。`--merge-method`（squash|merge|rebase）で方式指定し、
  `--ci-await-timeout <seconds>` で CI bounded await の総 timeout を指定する。
- 状態遷移は harness のみ。LLM 出力を merge 判定の根拠にしない。CI status 取得は
  fail-closed（不確定は緑扱いしない）。
- **observability**: CI status / 外部レビュー verdict 取得で予期しない `gh` 失敗が出た
  場合、gate は緩めない（fail-safe で not-green / verdict なし）まま **stderr に warning
  を出す**（`warnExternalProbeFailure`）— 失敗が silent に隠れて「実は確認できなかった」が
  運用に見えない問題を解消。Copilot review の poll で握りつぶした最後のエラーは skipped 時の
  audit detail（`last poll error: …`）に載る（非 gating）。

### Copilot review（観測ステップ・opt-in・best-effort）

PR 作成後・auto-merge 評価の**前**に、opt-in（`--request-copilot-review`、既定 OFF）
で GitHub Copilot のコードレビューを best-effort でリクエストできる。これは純粋な
**観測ステップ**で、retry-then-skip（request 一時エラーは retry、timeout は skip）し、
例外も握る（非 gating）。outcome は operation audit（`copilot-review`）に記録される
だけで、**close / merge を一切 gate しない**――外部出力を状態遷移の根拠にしない、
という安全境界を守る。`closeAndPr` はレビュー結果に関わらず後続（auto-merge / 
`pr_created`）へ進む。同じ best-effort 処理は単発の [`harness pr request-review`](
./cli.md#harness-pr-request-review) でも実行できる。

poll は総 timeout の残り時間で bounded に実行され、内部 watchdog が発火した場合は
その poll に渡した `AbortSignal` を abort する。gh 実装は signal を子プロセスへ伝播し、
watchdog timer は `finally` で cancel される。この abort は外部観測の中断だけに使い、
Copilot outcome が close / merge の gate になることはない。
