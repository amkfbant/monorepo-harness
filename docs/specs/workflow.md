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
14. PASS 1 — post-codex diffAndValidate(worktree, baseSha, policy):
    attemptDiff → DiffOutcome { ok, trackedChangedPaths, untrackedAll, patch, error? }
    partitionUntracked(untrackedAll, ignoreUntracked) → { kept, ignored }
    if diff.ok: validateChangedPaths(policy, tracked ∪ kept) → violations + safetyStatus
    emit diff_collection_failed / policy_validation_completed with stage="post-codex"
15. PASS 2 — if diff.ok && safetyStatus=allowed && codex ok && allowedCommands non-empty:
    setStatus('verified'); emit commands_started
    runAllowedCommands(worktree, allowedCommands) → results; emit commands_completed
    RE-RUN diffAndValidate against the post-command worktree
    emit diff_collection_failed / policy_validation_completed with stage="post-command"
16. setSafetyStatus  (from the final — post-command if commands ran — validation)
17. split kept untracked → (allowed, denied) based on the final violations set
18. write final-diff.patch
19. write untracked-files.{txt,patch} for allowed (with secret-scan redaction)
20. write untracked-denied.txt for denied (metadata only)
21. write untracked-secrets.txt for secret suspects (metadata only)
22. emit diff_collected (stage = post-command if commands ran, else post-codex)
23. determine RunStatus from priority:
    diff failure > codex timeout > codex non-zero > policy violation
    > command failure > needs_review
24. readTail(codex-output.log), readStderrTail(codex-error.log)
25. write summary.md
26. write knowledge-candidates.yaml (4 signal kinds)
27. write review-decision.yaml (initial: pending)
28. write review-request.md
29. finalize(meta, status, safetyStatus, counts, commandResults, finishedAt)
30. emit run_completed
31. release domain lock (finally)
```

ステップ 14/15 の 2 pass 構成が F8（コマンドの副作用も path policy で再検査）の核心。`allowedCommands` が無ければ pass 2 は skip され、pass 1 の結果がそのまま使われる。

worktree は **削除しない**。レビュー後の cleanup は `harness cleanup`（[`cli.md`](./cli.md)）で行う。

Goal-mode executions can wrap one or more `domain-coding` runs in a
[`goal-convergence`](./goal-convergence.md) session. The run status machine
remains unchanged; goal convergence records the surrounding attempts, review
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

priority は上から下（post-command pass が走った場合は、その後の状態で評価される）:

1. `!diff.ok` → `failed-diff-collection`
2. `codex.timedOut` → `failed-codex-timeout`
3. `codex.exitCode !== 0` → `failed-codex`
4. `safetyStatus === "denied"` → `failed-policy-violation`
   （codex 直後 / commands 実行後のどちらの validation で denied になっても）
5. `allowedCommands` が走り 1 つでも失敗 → `failed-command`
6. else → `needs_review`

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
  context-pack-manifest.yaml  # OPTIONAL: `run --project` で context pack を注入したときのみ
workspaces/<runId>/repo/   # git worktree (削除しない)
locks/<repoId>--<domain-slug>-<hash>.lock  # active run の lock; runId / pid / hostname / acquiredAt
```

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
{"type":"policy_validation_completed","status":"allowed","stage":"post-codex"}
{"type":"commands_started","count":2}
{"type":"commands_completed","results":[{"command":"npm test","exitCode":0,"durationMs":4521,"timedOut":false},{"command":"npm run lint","exitCode":0,"durationMs":1102,"timedOut":false}],"allPassed":true}
{"type":"policy_validation_completed","status":"allowed","stage":"post-command"}
{"type":"diff_collected","tracked":["apps/catalog/src/validation.ts"],"untrackedAllowed":[],"untrackedDenied":[],"ignored":[],"stage":"post-command"}
{"type":"run_completed","status":"needs_review","safetyStatus":"allowed","ignoredUntrackedCount":0,"secretSuspectCount":0,"commandResultsCount":2}
```

### diff / validation の stage

`diff_collected` / `policy_validation_completed` / `diff_collection_failed` には **`stage`** フィールドが付く:

- `post-codex` — codex 実行直後の diff / path validation
- `post-command` — `allowedCommands` 実行後の **再** diff / 再 validation（F8: コマンドの副作用も同じ安全境界で検査）

`allowedCommands` が空、または codex / 初回 validation で既に失敗している場合、`post-command` の validation は走らず post-codex のみが残る。`diff_collected`（最終 diff の確定）の `stage` は、コマンドが走ったなら `post-command`、そうでなければ `post-codex`。

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
記述する（実装中）。

- **domain lock の DB 化** — `runDomainCoding` の lock 取得は Phase 9 で
  file lock + DB lock の **dual-lock**。DB lock は lease (5 分) +
  heartbeat (1 分) + fencing token (= `domain_locks.lock_id`) を持つ。
  Phase 9 期間中は file lock が primary serialization のため、runtime 経路の
  lease stealing は発生しにくい（full-path integration は Phase 10）。
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
- stdout/stderr は file stream に pipe、close 後 `finished()` で flush 完了を待つ

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

## Phase 10 — lease stealing / scratch lifecycle（設計確定・実装中）

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

## Phase 11 — Review governance / consensus flow（設計確定・実装中）

Phase 11 で review process は **consensus mode** が default となる (project
profile で `review.mode` が `latest-proposal` 以外を指定した場合)。設計は
[`../superpowers/specs/2026-05-24-phase11-review-governance-consensus-design.md`](../superpowers/specs/2026-05-24-phase11-review-governance-consensus-design.md)。

### review auto → consensus re-evaluate flow

```
1. harness review auto <runId> --reviewer codex
2. reviewer-agent が verdict を作成
3. proposal を review_proposals に INSERT
   (reviewer_id / reviewer_type / model / prompt_sha256 / lifecycle='active' を埋める)
4. consensus evaluator を呼び、新 active consensus を review_consensus に
   INSERT (旧 active は superseded_at = now で update)
5. 旧 active proposal (同 reviewer) は lifecycle='superseded' に
```

複数 reviewer が並行で auto を走らせると、それぞれが proposal を insert
し、consensus が re-evaluate される。

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
