# Workflow `domain-coding`

`harness run` が呼ぶ唯一の workflow。実装: `src/core/workflow-runner.ts`。

## 高レベルなフロー

```text
1. load global + repo policy, resolve into ResolvedPolicy
2. generate unique runId, acquire per-domain lockfile
3. resolveBaseSha(baseBranch) — pin the commit to diff against
4. createRunLog(runsDir, runId, meta) — atomic mkdir + meta.json + events.jsonl
5. emit run_started event, write resolved-policy.yaml
6. createWorktree(repo, baseSha, runId) — git worktree add detached at baseSha
7. emit worktree_created event
8. build codex prompt from goal + policy → write codex-prompt.md
9. emit codex_exec_started
10. spawn codex exec (detached process group, sandbox/approval/timeout from policy)
11. read codex-output.log + codex-error.log (after stream flush)
12. emit codex_exec_completed (exitCode, timedOut)
13. setStatus('generated')
14. attemptDiff(worktree, baseSha, gitTimeoutMs)
    → DiffOutcome { ok, trackedChangedPaths, untrackedAll, patch, error? }
15. partitionUntracked(untrackedAll, ignoreUntracked) → { kept, ignored }
16. if diff.ok: validateChangedPaths(policy, tracked ∪ kept) → violations + safetyStatus
    else:        safetyStatus = "skipped"
17. setSafetyStatus
18. split kept untracked → (allowed, denied) based on violations set
19. write final-diff.patch
20. write untracked-files.{txt,patch} for allowed (with secret-scan redaction)
21. write untracked-denied.txt for denied (metadata only)
22. write untracked-secrets.txt for secret suspects (metadata only)
23. emit diff_collected
24. determine RunStatus from priority:
    diff failure > codex timeout > codex non-zero > policy violation
    > command failure > needs_review
25. if path validation passed: setStatus('verified'); then if policy.allowedCommands.length > 0:
    runAllowedCommands(worktree, allowedCommands) → results
    on any failure → status = 'failed-command'
26. readTail(codex-output.log), readStderrTail(codex-error.log)
27. write summary.md
28. write knowledge-candidates.yaml (4 signal kinds)
29. write review-decision.yaml (initial: pending)
30. write review-request.md
31. finalize(meta, status, safetyStatus, ignoredUntrackedCount, secretSuspectCount, finishedAt)
32. emit run_completed
33. release domain lock (finally)
```

worktree は **削除しない**。レビュー後の cleanup は別フェーズ（MVP 未実装）。

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

### RunStatus 優先順位

priority は上から下:

1. `!diff.ok` → `failed-diff-collection`
2. `codex.timedOut` → `failed-codex-timeout`
3. `codex.exitCode !== 0` → `failed-codex`
4. `safetyStatus === "denied"` → `failed-policy-violation`
5. else → `needs_review`

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
  codex-output.log         # codex stdout (生)
  codex-error.log          # codex stderr (生; readStderrTail で patch echo を抑制してから artifact に転載)
  final-diff.patch         # tracked changes の unified diff (against baseSha)。常に生成 (変更なしなら空)
  untracked-files.patch    # OPTIONAL: allowed untracked がある場合のみ。inline + secret hit は redact
  untracked-files.txt      # OPTIONAL: allowed untracked がある場合のみ。path list
  untracked-denied.txt     # OPTIONAL: denied untracked がある場合のみ。size + sha256、content なし
  untracked-secrets.txt    # OPTIONAL: secret hit がある場合のみ。reasons のみ、content なし
  summary.md               # 人間向け短いサマリ
  knowledge-candidates.yaml # 自動抽出 signal (4 kinds; 後述)
  review-request.md        # reviewer 向け詳細 (status / safety / lists / artifacts / codex tails / checklist)
  review-decision.yaml     # 初期: { decision: pending, … } — reviewer がここを編集する
  commands/                # OPTIONAL: policy.allowedCommands があるときだけ生成
    00-<slug>.out.log
    00-<slug>.err.log
    01-<slug>.out.log
    ...
workspaces/<runId>/repo/   # git worktree (削除しない)
locks/<domain-slug>.lock   # active run の lock; runId / pid / hostname / acquiredAt
```

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
{"type":"codex_exec_completed","exitCode":0,"timedOut":false}
{"type":"policy_validation_completed","status":"allowed"}
{"type":"diff_collected","tracked":["apps/catalog/src/validation.ts"],"untrackedAllowed":[],"untrackedDenied":[],"ignored":[]}
{"type":"commands_started","count":2}
{"type":"commands_completed","results":[{"command":"npm test","exitCode":0,"durationMs":4521,"timedOut":false},{"command":"npm run lint","exitCode":0,"durationMs":1102,"timedOut":false}],"allPassed":true}
{"type":"run_completed","status":"needs_review","safetyStatus":"allowed","ignoredUntrackedCount":0,"secretSuspectCount":0,"commandResultsCount":2}
```

`harness review process` 実行時にはさらに追記される:

```jsonl
{"type":"review_processed","runId":"run-…","decision":"approved","previousStatus":"needs_review","newStatus":"approved","reviewer":"alice","reviewedAt":"2026-05-20T12:00:00Z"}
```

`harness cleanup` 実行時（`--scope workspace` のとき。`run` / `all` は run dir ごと消えるので event も残らない）:

```jsonl
{"type":"cleaned","runId":"run-…","scope":"workspace","previousStatus":"approved","worktreeRemoved":true,"branchRemoved":true}
```

通常の `failed-*` 終了（policy-violation / codex / codex-timeout / diff-collection）は **`run_completed` イベントに最終 status を載せる** だけで、`run_failed` は emit されない。`run_failed` は **post-`createRunLog` で unexpected exception が catch された場合のみ** 1 行追加される（その後 `failed-internal-error` で finalize して rethrow）。

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

`required_changes` / `non_blocking_comments` / `out_of_scope_suggestions` は MVP processor では読み取られるが利用されない（将来の Phase 3 retry loop で prompt 生成に使う予定）。

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
- stdout/stderr は file stream に pipe、close 後 `finished()` で flush 完了を待つ

## limits / timeout

- codex: `policy.codex.timeoutMs` (default 15 min)
- git: `policy.limits.gitTimeoutMs` (default 30 s) — git invocation 各々に対して

timeout 到達 / エラーの扱い:
- codex 子プロセスの timeout → `failed-codex-timeout`
- diff collection 中の git error / timeout → `attemptDiff` が catch して `diff.ok = false` → `failed-diff-collection`
- それ以外の git 操作（resolveBaseSha / createWorktree）の throw、または createRunLog 後の unexpected exception → inner try/catch が `failed-internal-error` で finalize して rethrow

createRunLog **以前** の throw（policy load / lock acquire / baseSha 解決 / worktree 作成手前で異常）は finalize できないので、harness は通常の throw として伝播させる（outer finally で lock release は走る）。
