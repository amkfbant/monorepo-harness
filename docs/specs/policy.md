# Policy

ハーネスは 2 つの YAML から構成される 1 つの `ResolvedPolicy` を毎 run 解決して使う。

- `policies/global.yaml` — 全 run 共通の defaults / limits / always_deny / ignore
- `policies/repos/<repo-id>.yaml` — 1 target repo の domain ごとの read/write/deny

実装: `src/policy/schema.ts` (Zod) → `src/policy/loader.ts` (YAML パース) → `src/policy/resolver.ts` (マージ)。

`policies/repos/<repo-id>.yaml` は手書きのほか、project profile から
コンパイルして生成できる（`harness project init`、Phase 5）。生成される policy は
このファイルで説明する `RepoPolicySchema` をそのまま満たすため、`resolvePolicy()`
の入力としては手書き policy と区別なく扱われる。生成元の provenance はサイドカー
`policies/repos/<repo-id>.generated.json` に持つ。詳細は [`project.md`](./project.md)。

既存 profile から **policy ファイルを直接 materialize** するには
`harness policy compile --project <id>`（#78）を使う: `policies/repos/<repoId>.yaml`
（`hitch orchestrate` が repoId モードで読むファイル）を生成し、`policies/global.yaml`
不在時はそれも scaffold する（不在 ENOENT 回避）。既存ファイルは `--force` 必須。生成
YAML 先頭に provenance ヘッダ（コメント＝loader は無視）が付く。DB は変更しない。

## グロブの大原則

すべてのパターンは [minimatch](https://github.com/isaacs/minimatch) で `{ dot: true, nocomment: true }` 評価される。**gitignore ではない**。詳細と落とし穴は [`docs/policy-semantics.md`](../policy-semantics.md)。

要点:
- `dist/**` は repo root の `dist/foo` だけにマッチ。`apps/orders/dist/foo` には **マッチしない**。
- ネストされた dist を ignore したいなら `**/dist/**` を使う。
- ファイル単独に効かせたいなら `**/file.ext` の形に。

## global.yaml

```yaml
defaults:
  codex:
    sandbox: workspace-write          # read-only | workspace-write | danger-full-access
    approval: on-request              # codex 内部の approval policy 設定
    timeout_ms: 900000                # codex 子プロセスの kill timeout (15 min)
    model: gpt-5.5                    # 任意 — agent-usage telemetry に記録する advisory model (#206)
    backend: claude                   # 任意 — coder backend (codex | claude)。#191。未設定=codex
    claude_model: opus-4.8            # 任意 — backend=claude 時の advisory claude model

limits:
  git_timeout_ms: 30000               # 各 git invocation の kill timeout (30 s)
  change_budget:
    max_deleted_lines: 800            # tracked/index diff の削除行上限
    max_total_changed_lines: 5000     # insertions + deletions の上限
    max_deleted_files: 20             # 削除された tracked/index file 数上限
    max_changed_files: 40             # changed tracked/index + allowed untracked file 数上限
    enforce: true                     # false は pre-gate skip + loud audit + review backstop

always_deny_write:
  - .git/**
  - .github/**
  - package.json                      # root package.json のみ。ネストは別パターンが必要
  - pnpm-lock.yaml
  - yarn.lock
  - package-lock.json
  - pnpm-workspace.yaml
  - turbo.json
  - nx.json
  - tsconfig.base.json
  - packages/shared/**
  - packages/contracts/**

ignore_untracked:                     # minimatch root-anchored
  - "**/node_modules/**"
  - "**/dist/**"
  - "**/coverage/**"
  - "**/.turbo/**"
```

### フィールド

| Field | Type | 解説 |
|-------|------|------|
| `defaults.codex.sandbox` | enum | codex の `--sandbox` フラグに渡る。`workspace-write` が MVP の既定 |
| `defaults.codex.approval` | string? | codex の `-c approval_policy=…` に渡る |
| `defaults.codex.timeout_ms` | number? | runner.timeoutMs。未設定なら 15 min default |
| `defaults.codex.model` | string? | agent-usage telemetry に記録する advisory model (#206)。harness は `-m` を注入しないため実モデルと食い違い得る best-effort 値。coder のみ参照（reviewer/evaluator は `HARNESS_CODEX_MODEL` 経由）。未設定なら `HARNESS_CODEX_MODEL` → `NULL` |
| `defaults.codex.backend` | enum? | (#191) **coder** backend = `codex` \| `claude`。precedence は `policy 値 > HARNESS_CODER_BACKEND env > codex`（`resolveCodexModel` と同型・ただし `'claude'` 厳密一致のみ opt-in で fail-closed）。これにより project A=claude / B=codex が 1 つの ops driver で env を触らず共存。未設定なら env→codex。**reviewer は当面 codex 固定**（F16 推奨構成 + S4 reviewer-redaction follow-up）。`claude -p` の安全境界は cwd=worktree（F15・`--add-dir` 不使用） |
| `defaults.codex.claude_model` | string? | (#191) `backend=claude` 時の advisory claude model（`model` の claude 版）。`createClaudeCliRunner` の `--model` に注入。未設定なら `HARNESS_CLAUDE_MODEL` → stream 由来 model → `NULL` |
| `limits.git_timeout_ms` | number | gitCli の SIGKILL タイマー。未設定なら 30 s |
| `limits.change_budget` | object? | run ごとの tracked diff size / deletion guard。未設定でも fail-closed default が適用される |
| `always_deny_write` | string[] | 全 domain で必ず deny される path glob |
| `ignore_untracked` | string[] | untracked のうち validation スキップ + artifact カウント除外する glob |

## repos/<repo-id>.yaml

```yaml
repo_id: mini-commerce                # ファイル名と一致させること

read:                                 # repo-level の参照可能パス（情報提供。validation には未使用）
  - README.md
  - docs/**
  - package.json
  - tsconfig.base.json
  - pnpm-workspace.yaml
  - packages/contracts/**
  - packages/shared/**

domains:
  apps/catalog:                       # domain key = harness の --domain 引数
    read:
      - apps/catalog/**
      - docs/**
      - packages/contracts/**
      - packages/shared/**
      - package.json
      - tsconfig.base.json
    write:                            # 編集が許可される path glob (positive)
      - apps/catalog/**
    deny_write:                       # 編集が必ず拒否される path glob (negative; deny_write が write より優先)
      - apps/orders/**
      - packages/contracts/**
      - packages/shared/**
      - package.json
      - pnpm-lock.yaml
      - pnpm-workspace.yaml
      - tsconfig.base.json
      - .github/**
    change_budget:                    # 任意。global.limits.change_budget を field ごとに override
      max_deleted_lines: 200
      max_total_changed_lines: 2000
      max_deleted_files: 5
      max_changed_files: 25
      enforce: true
    commands:                         # path validation 通過後にこの allowlist を順次実行
      allow:
        - "npm run lint"              # legacy string form: sh -c
        - id: test-catalog            # structured form: id-based logs
          cmd: npm                    # argv-style spawn, no shell escaping
          args: ["test", "--filter", "catalog"]
          timeout_ms: 600000          # per-command override
          env:                        # per-command env merged on top of defaults
            NODE_ENV: test
      defaults:                       # 任意 — domain ごとに上書き可能
        timeout_ms: 300000            # default 5 min when per-command も未指定
        env_allowlist:                # 省略時は DEFAULT_COMMAND_ENV_ALLOWLIST
          - PATH
          - HOME
          - NODE_ENV

  apps/orders:
    # ...同様
```

### repo_id の制約

`assertValidRepoId` で `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` + `..` 含まないことを強制。

無効: `../foo` / `foo/bar` / `foo\\bar` / `..` / `.hidden` / 64 char 超 / 空文字。

ファイル名が repo_id と異なるとパス解決時に EEXIST or 別 policy になるので一致させること。

## 解決ルール (resolvePolicy)

```ts
ResolvedPolicy {
  repoId: repo.repo_id,
  domain: <args.domain>,
  read: uniq([...repo.read, ...domain.read]),
  write: uniq(domain.write),
  denyWrite: uniq([...global.always_deny_write, ...domain.deny_write]),
  allowedCommands: uniq(domain.commands?.allow),
  commandDefaults: {
    timeoutMs: domain.commands?.defaults?.timeout_ms ?? 300_000,
    // envAllowlist: domain.commands?.defaults?.env_allowlist  // when defined
  },
  ignoreUntracked: uniq(global.ignore_untracked),
  codex: {
    sandbox: global.defaults?.codex?.sandbox ?? "workspace-write",
    approval: global.defaults?.codex?.approval,    // optional
    timeoutMs: global.defaults?.codex?.timeout_ms ?? 900_000,
    model: global.defaults?.codex?.model,          // optional advisory (#206)
    backend: global.defaults?.codex?.backend,      // optional coder backend (#191)
    claudeModel: global.defaults?.codex?.claude_model, // optional (#191)
  },
  limits: {
    gitTimeoutMs: global.limits?.git_timeout_ms ?? 30_000,
    changeBudget: field-wise merge(global.limits.change_budget, domain.change_budget)
      with defaults { maxDeletedLines: 800, maxTotalChangedLines: 5000,
                      maxDeletedFiles: 20, maxChangedFiles: 40, enforce: true },
  },
}
```

`repo.read` は domain.read と連結されるが、`always_deny_write` と `domain.deny_write` は OR (より広い deny を取る) で連結される。

存在しない domain を指定すると `policy: domain "X" not found in repo "Y"` で throw。

## change_budget の扱い

`change_budget` は path policy の後に重ねる deterministic guard。LLM 出力は入力にせず、
`git diff --no-ext-diff --no-textconv --no-renames --numstat -z <baseSha>` と staged/index
側の `--cached --numstat -z <baseSha>` を path 単位に統合し、
`--diff-filter=D --name-only -z` / `--cached --diff-filter=D --name-only -z`
から得た tracked/index diff の整数で評価する。**`--no-renames` は安全フラグ**: rename 検出
が有効だと out-of-scope な tracked source を in-scope path に rename したとき destination
だけに collapse し、source 削除を policy/budget から隠してしまう。`--no-renames` で rename は
常に delete（source）+ add（destination）として現れ、out-of-scope source 削除が必ず検査される
（fail-closed・保守側）。同じ `DIFF_BASE_ARGS`（`--no-ext-diff --no-textconv --no-renames`）が
collectDiff の全 path list / numstat / patch 収集に適用される。あわせて `gitCli` は
**`GIT_NO_REPLACE_OBJECTS=1` を中央で強制**し（caller env / 継承 env で override 不可）、
全 git read が `refs/replace/*` を無視して **REAL object graph** を見る。これがないと coder が
`git replace <real> <sanitized>` を仕込んで diff/rev-list/reset を sanitized view で通しつつ
`git push` で real object を送り出せる（grafts / shallow は別途 push gate で fail-closed 拒否、
[`workflow.md`](./workflow.md) の salvage / `pr create` gate 参照）。さらに、policy validation 後に
PR に乗りうる allowed untracked file は `insertions` / `total_changed_lines` /
`changed_files` に含める（テキスト file の行数を加算し、binary / symlink / non-file は
行数 0 だが changed file として数える）。
numstat で binary file が `-` として出る場合、行数は 0 として扱うが
`filesChanged` には数える。deleted file 数は `--diff-filter=D` の結果だけを正本にし、
numstat から推測しない。

評価は inclusive: `actual == limit` は通過、`actual == limit + 1` は
`enforce:true` なら `failed-budget-exceeded`。対象 metric は:

- `deleted_lines` = numstat deletions
- `total_changed_lines` = numstat insertions + deletions
- `deleted_files` = `--diff-filter=D` の path 数
- `changed_files` = numstat rows

未設定でも次の fail-closed default が必ず適用される:

```yaml
max_deleted_lines: 800
max_total_changed_lines: 5000
max_deleted_files: 20
max_changed_files: 40
enforce: true
```

default は self-domain の実績に合わせて、通常の大きめ spec/test sweep を誤停止しない
値にしている。代表として #155/#165 の commit `ab754f2` は
`git show --shortstat --no-renames ab754f2` で **16 files changed, 2640 insertions,
52 deletions**、合計 2692 changed lines だった。`max_total_changed_lines=5000` と
`max_changed_files=40` はこの規模を十分に通しつつ、異常な mass rewrite を止める。
`max_deleted_lines=800` / `max_deleted_files=20` は正常な multi-file refactor の削除量を
超える destructive deletion を pre-review で止めるための ceiling。

global の `limits.change_budget` は全 domain の default。domain の `change_budget` は
field ごとに global を上書きし、未指定 field は global、さらに未指定なら上記 default
に fallback する。

`enforce: false` は operator の明示 opt-out として pre-review budget hard gate を
skip し、breach があっても `needs_review` へ進める。ただし silent pass ではない:
validator は常に breach を計算し、breach 時は `exceeded-but-allowed` と
`change_budget_disabled` event、summary、review-request に超過 metric / actual / limit を
loud に記録する。review gate（codex reviewer / human reviewer）は必ず走るため、
`enforce:false` は fail-open ではなく「pre-gate skip + review backstop」。

## 評価順 (validateChangedPaths)

`src/policy/path-policy-validator.ts`:

```text
for each changed path p:
  1. if isUnsafePath(p)              → violation: unsafe_path
  2. else if any denyWrite glob hits → violation: deny_write
  3. else if no write glob hits       → violation: not_in_write_scope
  4. else                              → allowed
```

`unsafe_path` の判定:
- 空文字
- NUL を含む
- 絶対パス (`/...`) または Windows ドライブレター (`C:`)
- backslash を含む
- `..` セグメント

つまり `unsafe_path` > `deny_write` > `not_in_write_scope` の優先度。

## ignore_untracked の扱い

`validateChangedPaths` は untracked の **filter 後** リストを受け取る。filter は `src/core/workflow-runner.ts:partitionUntracked` で実行され、`ignoreUntracked` glob にマッチする untracked file は:

- validation 対象から除外
- `runs/<runId>/untracked-files.patch` から除外
- `runs/<runId>/untracked-files.txt` から除外
- meta.json の `ignoredUntrackedCount` に +1
- summary.md / review-request.md の `## Ignored by ignore_untracked` セクションに path を表示（content は表示しない）

> **注意:** `ignore_untracked` は **validation を skip するだけ**。実際のファイル削除はしない。codex の build 出力が worktree に残っているのは普通。レビュー後の cleanup で worktree ごと消す。

## allowedCommands 実行

`domain.commands.allow` に並べた shell コマンドは、path validation が通過した直後（`needs_review` に確定する前）に **worktree 内** で `sh -c "<cmd>"` として順次実行される。実装: `src/core/command-runner.ts`。

- 各コマンドの stdout/stderr は `runs/<runId>/commands/<id>.{out,err}.log` に保存。`id` は policy 指定値 (structured form) または `cmd-<index>` (legacy string form)
- 1 つでも `exitCode !== 0` or timeout したら status = `failed-command`、`safetyStatus` は据え置き
- **timeout**: per-command `timeout_ms` > domain `commands.defaults.timeout_ms` > **5 分** (`DEFAULT_COMMAND_TIMEOUT_MS`) の順で決まる。tree-kill で子孫プロセスも SIGKILL
- **環境変数**: `commands.defaults.env_allowlist` でホワイトリスト指定可。未指定は **`PATH / HOME / USER / SHELL / LANG / LC_ALL / TERM / TMPDIR`** （`DEFAULT_COMMAND_ENV_ALLOWLIST`）。空配列 `[]` を明示すれば env なしで起動。`OPENAI_API_KEY` 等は default では **伝播しない**。per-command `env` を指定すると base env の上にマージされる
- **shell escaping**: legacy string form (`- "npm test"`) は `sh -c <cmd>` で実行。structured form (`{ cmd, args: [...] }`) は `spawn(cmd, args)` で **shell を介さない**（クォート / `$VAR` 展開なし）。誤実行リスクを下げたい場合は structured form 推奨
- 空 (`commands.allow: []`) の場合はステップそのものが skip
- **commands 実行後** に diff + path validation が **再評価される**。コマンドが scope 外に書いたら `failed-policy-violation` に flip（F8）

典型用途: `npm test`, `npm run lint`, `python -m pytest -q`。`pnpm test` を使う場合は target repo に `node_modules` が事前にあることが前提（harness は `pnpm install` を起動しない）。

`commandResults` は `meta.json` に配列で保存:

```json
"commandResults": [
  { "command": "npm test", "exitCode": 0, "durationMs": 4521, "timedOut": false },
  { "command": "npm run lint", "exitCode": 1, "durationMs": 1102, "timedOut": false }
]
```

## secret heuristic

`ignore_untracked` で除外されず、policy validation も通った untracked file に対して、`src/reporter/secret-scan.ts` が以下を check:

**filename パターン** (case-insensitive):
- `.env` / `.env.*` / `*.env` / `*.env.*`
- `*secret*` / `*token*` / `*credential(s)*` / `*password*`
- `id_{rsa,dsa,ecdsa,ed25519}` （SSH 秘密鍵）
- `*.{pem,key,pfx,p12}`

**content パターン** (先頭 32KB の strict UTF-8 sample):
- PEM private key header
- AWS access key id (`AKIA[0-9A-Z]{16}`)
- GitHub token (`gh{p,s,o,u,r}_*` or `github_pat_*`)
- OpenAI key (`sk-(proj-)?[A-Za-z0-9_-]{20,}`)
- Stripe live/test key (`sk_(live|test)_*`)

**free-text / log パターン**: prompt / log / Codex events の文字列 redaction は
同じ `containsLikelySecret` gate を使う。上記 vendor-shaped token に加えて、
`AWS_SECRET_ACCESS_KEY=...`、`api_key: ...`、`password=...` のような
name-based assignment、generic `*_key` assignment、`Authorization: Bearer ...`、
および `Authorization: Basic ...`（base64 decode 後に `:` を含む credential）を
secret-shaped とみなす。file artifact と違い、free-text callers は hit した
field / line 全体を置換し、raw value の部分置換はしない。

hit したファイルは:
- content を artifact に保存しない（`untracked-files.patch` には `@@ secret-suspect @@` + sha256 のみ）
- `runs/<runId>/untracked-secrets.txt` に reasons を別 artifact として保存
- summary.md / review-request.md に強調表示
- meta.json の `secretSuspectCount` に +1

`safetyStatus` には影響しない（path policy 通過した allowed file が対象なので）。

## verify-guarded — out-of-band 変更の検知（#69）

policy 検証はハーネス**自身**の変更を事後 `git diff` で見るが、対象 repo の guarded ドメインへの
**out-of-band（非ハーネス）変更**（素手編集など）は未強制だった。`harness verify-guarded`
（[`cli.md`](./cli.md)）は read-only でこれを補う: 各ドメインの `write` + `deny_write` glob を
guarded scope とし、対象 repo の**未コミット working-tree 変更**で guarded scope に該当するものを
検出して fail-closed（exit 1）に倒す。ハーネスはレビュー済み run のコミット経由でのみ land するため、
guarded path への未コミット変更は定義上未検証。「常時ハーネス強制」はせず、operator / CI / pre-push
hook が呼び出し側で gate する設計（強制は呼び出し側の選択）。

> committed 履歴の帰属（過去コミットがレビュー済み run 由来か）は健全判定に reviewed-head-sha の記録が
> 要るため対象外（follow-up）。working-tree 検知は最頻・最も明確に fail-closed なケースを担保する。

## 既知の限界

- minimatch root-anchored が gitignore と違うこと（[policy-semantics.md](../policy-semantics.md) F1）
- secret heuristic は確定検出ではない（base64 化や 32KB 後ろの埋め込みで回避可能）
- `read` は MVP では情報提供のみで enforcement なし（codex の sandbox 設定で間接的に効くが harness は読み込みを監視しない）
