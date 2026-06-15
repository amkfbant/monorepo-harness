# Project abstraction

**Phase 5 で導入。** `mini-commerce` 検証用デモアプリに寄った policy / domain /
command / context の形を、任意の新規・既存プロジェクトへ適用できる **Project
Abstraction 層**として分離する。

実装: `src/project/`。実行 backend は引き続き `src/policy/`（`ResolvedPolicy`）。

> **ステータス: Phase 5 close 済み（現状仕様）。** Project Abstraction 層は
> `src/project/` に実装済み。各 schema の確定値は対応する `src/project/*.ts` の
> Zod schema が真。CLI の確定仕様は [`cli.md`](./cli.md) の `harness project` 節。

## 何を解決するか

Phase 4 close 時点では、policy が `mini-commerce` の構成を手書きで持ち、domain
発見・policy 提案・コマンド選択・context 指定がすべて「既に policy を知っている
人」前提だった。Project Abstraction は次の流れを提供する。

```
project profile → domain registry → templates / presets / context packs
    → policy proposal / check → run
```

## スコープと非ゴール

### スコープ

1. 任意 target repo に **project profile**（`projects/<id>.yaml`）を定義できる。
2. domain 候補 / 定義を **domain registry** として扱える。
3. `project inspect` が target repo を静的に読んで domain 候補を出せる（Codex 不使用）。
4. `project init --dry-run` が policy proposal を出せる（書き込みなし・決定論的）。
5. policy template / command preset / context pack を再利用できる。
6. `project check` が Codex を起動せず設定不備を検出できる。
7. `mini-commerce` を project profile 形式へ移行できる。
8. 複数プロジェクトを同じ `HARNESS_ROOT` で扱っても **lock / context pack** が
   混線しない（lock は repo namespaced、context pack は run 単位）。

> metrics / inbox / knowledge digest / backlog の `--project` / `--repo-id`
> filter は Phase 6 で実装済み（DB read model 経由、[`db.md`](./db.md)）。
> promoted knowledge の project namespace は引き続き follow-up。

### 非ゴール

完全な Web dashboard / Docker・OS sandbox 強化 / multi-user permission / 完全自律
merge / 大規模 multi-agent swarm / `read` policy の OS レベル enforcement。

## 後方互換（重要）

Phase 5 は既存の動作を壊さない。

- 既存 `policies/repos/*.yaml` と `harness run --repo-id` は従来どおり動く。
  profile を使わない run path は一切変更しない。
- profile 層は最終的に既存 `RepoPolicy` / `GlobalPolicy` へコンパイルして
  `resolvePolicy()` に渡す。実行 backend は 1 本のまま。
- `RunMeta` に追加する `project` field はすべて optional。`project` を持たない
  旧 run / 旧 knowledge は legacy として扱い、domain-only の filter で従来どおり読める。
- profile / domain registry / policy template / command preset / context pack は
  すべて `version` を持ち、将来の migration に備える。`project inspect` /
  `project init` が registry を使った場合は、その `registry_id` と `version` も
  provenance に記録する。

## データモデル

`projects/<project-id>.yaml`（profile）が起点。CLI の `--project <id>` は
`<HARNESS_ROOT>/projects/<id>.yaml` へ解決する。

### Project profile

```yaml
version: 1
project_id: mini-commerce
description: "..."
repo:
  id: mini-commerce
  path: ../mini-commerce          # profile file からの相対 path 可
  base_branch: main
  package_manager: npm            # npm | pnpm | yarn | bun | none | unknown
policy:
  template: strict-monorepo-v1
  global_deny: [ ... ]
  ignore_untracked: [ ... ]   # optional; merged with the template's ignore_untracked
context_packs:
  default-docs: { description, globs, max_bytes, deny_secret_like }
commands:
  presets: [ node-basic-v1 ]
domains:
  - id: apps/catalog
    root: apps/catalog
    kind: app                     # app | package | service | docs | other
    read: [ ... ]
    write: [ apps/catalog/** ]
    deny_write: [ ... ]
    command_presets: [ node-basic-v1 ]
    commands: { allow: [ ... ] }
    context_packs: [ default-docs ]
```

- `project_id` / `repo.id` は `assertValidRepoId` 相当の安全制約を満たす。
- `domain.id` は既存互換のため slash を許す。空 / absolute path / `..` / backslash
  / NUL は拒否。
- `context_packs` は **read enforcement ではなく** prompt に明示添付する context の定義。

### Domain registry

profile 内 `domains` と外部 reusable registry（`templates/domain-registries/*.yaml`）
の両方。registry の `patterns` が `id_template` / `root_glob` / `kind` /
`policy_template` / `command_presets` / `context_packs` を持ち、`project inspect`
が repo 実体と照合して candidate を出す。

### Policy template / command preset / context pack

- **policy template** (`templates/policy/*.yaml`): domain kind ごとの default
  read / write / deny。**`ignore_untracked`** も供給する（validation skip + artifact
  カウント除外の glob、`policy.md` 参照）。`strict-monorepo-v1` は JS（`node_modules`
  / `dist` / `coverage` / `.turbo`）に加え Python のビルド/キャッシュ（`.venv` /
  `__pycache__` / `*.pyc` / `.mypy_cache` / `.pytest_cache` / `.ruff_cache`）も既定で
  ignore する。
- **`policy.global_deny` / `policy.ignore_untracked`** (profile): compile 時に template
  値とマージされる。`global_deny` は template `root_deny` に、`ignore_untracked` は
  template `ignore_untracked` に追加される（`uniqSort` で dedup）。project 固有の
  言語/ツール由来の untracked を、template を編集せず profile 側で宣言できる。
- **command preset** (`templates/commands/*.yaml`): 現行 policy `commands.allow`
  へコンパイル。structured argv form を標準とし、shell は明示 opt-in。
- **context pack** (`templates/context-packs/*.yaml` または profile inline):
  prompt に入れる明示 context。secret-shaped filename / content を拒否、binary
  skip、byte cap、unsafe glob 拒否、prompt fence neutralize。

### Generated policy の provenance

`project init --write` で生成する `policies/repos/<repo-id>.yaml` は、既存
`RepoPolicySchema` をそのまま満たす（policy YAML に provenance コメントを埋め込ま
ない）。provenance は **サイドカー JSON** `policies/repos/<repo-id>.generated.json`
に持ち、どの profile / domain registry / policy template / command preset /
context pack（それぞれ id + version）から生成されたか、`generatedAt` を記録する。
`project check` はこのサイドカーと profile を照合して
drift を検出する。

## CLI（Phase 5 で追加）

```bash
harness project inspect --repo <path> [--registry <id>] [--json]
harness project init --repo <path> --project-id <id> [--dry-run] [--write] [--force]
harness project init --from-policy <repo-id> --project-id <id> [--dry-run] [--write]
harness project check --project <id> [--repo <override>] [--json]
harness project show --project <id> [--json]
harness run --project <id> --domain <domain> --goal <text>
harness workflow reviewed-run --project <id> --domain <domain> --goal <text>
```

各コマンドの確定仕様は [`cli.md`](./cli.md) の `harness project` 節を参照。

Project-scoped hitch drivers are project-runtime executions too. CLI
`hitch orchestrate`, MCP `harness.hitch.orchestrate`, and course orchestration
resolve `prepareProjectRun(projectId, domain)` before launching the coder, then
thread the compiled policy, `RunMeta.project`, and project context packs into
`domain-coding`. The post-run git diff validation and the
`effective_policy_snapshots` row therefore use the same compiled policy and
`source: project-runtime` provenance as `harness run --project`.

This is a compatibility tightening for project-scoped hitches: when the project
profile narrows a broader raw repo policy, previously accepted writes can be
denied by the compiled profile policy. Hitches without `projectId` intentionally
continue to load raw `policies/global.yaml` + `policies/repos/<repoId>.yaml`.

## Namespace

複数 project を同じ harness root で扱うため、次を namespace 化する。

### lock（dual-mode、Phase 5-7 で実装）

**lock key は run の `RunMeta` から決定論的に導出する。** すべてのライフサイクル
コマンド（`run` / `review process` / `cleanup` / `pr create`）が同一の導出規則を
使うことが必須要件 — でないと run を起こした lock と review/cleanup が取る lock が
ずれる。

導出規則（`src/workspace/domain-lock.ts`）:

- run の `meta` が `repoId` を持つ → namespaced lock
  `locks/<repoSlug>--<domainSlug>-<hash>.lock`。
- それを持たない旧 run → 従来どおりの domain-only `locks/<domainSlug>.lock`。

これにより新旧が同じ harness root に混在しても、各 run の review/cleanup は
その run を起こしたときと同じ lock を取れる。`harness run --repo-id`（profile 非
経由）も `repoId` を持つため namespaced lock を使う。真に legacy なのは
`repoId` を meta に持たない過去の run のみ。

`<hash>` は **raw な `repoId` + `domain` ペアの SHA-1 先頭 12 桁**。slug は読みやすさ
用で lossy（`foo.bar` と `foo-bar` は同 slug）だが、hash により別 (repo, domain)
ペアが同じ lock へ衝突することはない。namespaced lock の手動 release には
`harness lock release --domain <d> --repo-id <id>` を使う。

### run meta

`RunMeta.project`（optional）に projectId / profilePath / profileVersion /
template / preset / context pack id を記録する。旧 run は `project` を持たず
legacy 扱い。

### follow-up

- **metrics / inbox / knowledge digest / backlog の `--project` / `--repo-id`
  filter** — Phase 6 で実装済み（DB read model 経由）。`docs/reports/2026-05-22-phase6-close.md` 参照。
- **knowledge context / promoted knowledge の project namespace** — knowledge
  candidate は `runs/<runId>/` 配下で run 単位に分離済み。`docs/knowledge-context/`
  のディレクトリ namespace 化と promoted frontmatter への `repo_id` / `project_id`
  追加は未実装（Phase 6 でも継続 follow-up）。
