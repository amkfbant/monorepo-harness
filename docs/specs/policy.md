# Policy

ハーネスは 2 つの YAML から構成される 1 つの `ResolvedPolicy` を毎 run 解決して使う。

- `policies/global.yaml` — 全 run 共通の defaults / limits / always_deny / ignore
- `policies/repos/<repo-id>.yaml` — 1 target repo の domain ごとの read/write/deny

実装: `src/policy/schema.ts` (Zod) → `src/policy/loader.ts` (YAML パース) → `src/policy/resolver.ts` (マージ)。

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

limits:
  git_timeout_ms: 30000               # 各 git invocation の kill timeout (30 s)

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
| `limits.git_timeout_ms` | number | gitCli の SIGKILL タイマー。未設定なら 30 s |
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
    commands:                         # path validation 通過後にこの allowlist を順次実行
      allow:
        - "npm test"
        - "npm run lint"

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
  ignoreUntracked: uniq(global.ignore_untracked),
  codex: {
    sandbox: global.defaults?.codex?.sandbox ?? "workspace-write",
    approval: global.defaults?.codex?.approval,    // optional
    timeoutMs: global.defaults?.codex?.timeout_ms ?? 900_000,
  },
  limits: { gitTimeoutMs: global.limits?.git_timeout_ms ?? 30_000 },
}
```

`repo.read` は domain.read と連結されるが、`always_deny_write` と `domain.deny_write` は OR (より広い deny を取る) で連結される。

存在しない domain を指定すると `policy: domain "X" not found in repo "Y"` で throw。

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

- 各コマンドの stdout/stderr は `runs/<runId>/commands/<idx>-<slug>.{out,err}.log` に保存
- 1 つでも `exitCode !== 0` or timeout したら status = `failed-command`、`safetyStatus` は据え置き
- timeout 既定値 5 分。tree-kill で子孫プロセスも SIGKILL
- 環境変数は `PATH / HOME / USER / SHELL / LANG / LC_ALL / TERM / TMPDIR` のみ通過。`OPENAI_API_KEY` 等は **伝播しない**
- 空 (`commands.allow: []`) の場合はステップそのものが skip

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

hit したファイルは:
- content を artifact に保存しない（`untracked-files.patch` には `@@ secret-suspect @@` + sha256 のみ）
- `runs/<runId>/untracked-secrets.txt` に reasons を別 artifact として保存
- summary.md / review-request.md に強調表示
- meta.json の `secretSuspectCount` に +1

`safetyStatus` には影響しない（path policy 通過した allowed file が対象なので）。

## 既知の限界

- minimatch root-anchored が gitignore と違うこと（[policy-semantics.md](../policy-semantics.md) F1）
- secret heuristic は確定検出ではない（base64 化や 32KB 後ろの埋め込みで回避可能）
- `read` は MVP では情報提供のみで enforcement なし（codex の sandbox 設定で間接的に効くが harness は読み込みを監視しない）
