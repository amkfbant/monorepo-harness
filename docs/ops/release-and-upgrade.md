# Release & upgrade — agent-facing runbook

ハーネスの**版上げ（release）**と、ops checkout を新バージョンへ**アップデート**する
手順。エージェントもこの作業を行うため、決定論的な手順とゲートをここにまとめる。

- 仕様の正本: リリース tooling は [`docs/specs/release.md`](../specs/release.md)、schema
  version / migration は [`docs/specs/db.md`](../specs/db.md)、ops/dev モードの定義は
  [`CLAUDE.md`](../../CLAUDE.md)。本ファイルは「どう実行するか」の runbook。
- 安全境界: 版を切る決定的行為（version bump / tag）は **release-please のみ**。`harness
  release plan/check` は読み取り専用で「教える / 止める」だけ。**fail-closed**（未宣言の
  破壊的変更・解析の不完全さがあれば止める）。

---

## 1. リリース機構（release-please）

このリポジトリは **release-please** で版を切る（手動の version bump はしない）。

- `.github/workflows/release.yml` が Conventional Commit 履歴から
  **version bump（`package.json` / `.release-please-manifest.json`）/ `CHANGELOG.md` /
  release PR / `vX.Y.Z` tag + GitHub Release** を自動生成・維持する。
- **版を切るのは release PR の merge**。merge した瞬間に tag と GitHub Release ができる。
- bump 規則（`release-please-config.json`）:
  - `release-type: node`、`bump-minor-pre-major: true`。
  - **pre-1.0（0.x）では breaking change も MINOR bump**（`feat!` / `BREAKING CHANGE:`
    → 0.5.0 なら 0.6.0）。`feat` → minor、`fix`/`perf` → patch。
  - これは `docs/specs/release.md` の「0.x では breaking も MINOR」と整合。1.0.0 に
    上げたい場合のみ別途判断（`bump-minor-pre-major` を外す or `Release-As: 1.0.0`）。
- 特定版を強制したいときは、コミット footer に `Release-As: X.Y.Z` を付ける（one-time
  override）。通常は不要（config の bump 規則に従う）。

### エージェントの版上げ手順

```
1. harness release plan   # 把握（推奨 bump / schema delta / 削除された surface）
2. harness release check  # 青信号ゲート（exit 0 で OK）
3. release-please PR を merge   # ← ここで version/CHANGELOG/tag/Release が切られる
```

- `harness release plan [--since <tag>] [--to HEAD] [--json]`: 推奨 SemVer bump、DB
  schema delta（no-downgrade 影響）、削除/改名された CLI/MCP surface、未宣言の破壊的
  変更の警告。**exit 2 = 未宣言の破壊的変更 or 解析が不完全**（fail-closed シグナル）。
- `harness release check [--since <tag>] [--to HEAD]`: 4 check を全 pass で exit 0 —
  ① plan-clean（plan が exit-2 でない）② version-consistency（`package.json` と
  manifest 一致）③ spec-sync（追加 surface が `mcp.md`/`cli.md`/`db.md` に記載）
  ④ clean-tree（未コミット変更なし）。1 つでも fail で **exit 1**。
- build/test は CI（typecheck/build/test の node 20/24 matrix）の担当。`release check`
  は置き換えず補完する。

---

## 2. ops checkout のアップデート（pinned release tag）

ops モードは **不変の release tag（`vX.Y.Z`）に pin した detached HEAD** で動かす
（`git describe --tags --exact-match` が成功する状態）。`src/` は read-only。新バージョン
へ上げる手順:

```bash
# ops checkout（例: ~/ops/monorepo-harness）で
git fetch --tags origin
git checkout vX.Y.Z          # 新しい release tag（detached HEAD に pin）
npm ci                       # prepare が dist/ を自動ビルド（bin/harness を更新）
npm run typecheck            # 健全性確認（任意）
harness db migrate           # 未適用 migration を冪等に適用（schema を上げる）
```

アップデート後に必要な反映:

- **MCP serve の再起動**: 新しい MCP tool（例: SP-2 の `harness.course.orchestrate`）は
  `harness mcp serve` を**再起動**しないと露出しない。
- **DB migration**: 上の `harness db migrate` で未適用分を適用するのが確実
  （`docs/specs/db.md`）。多くの write/CLI/MCP-init 経路でも自動適用されるが、純粋な
  read-only 経路（`openManagedDb` だけ・read tools）は migrate しないので、upgrade 時は
  明示的に `harness db migrate` を回す。**no-downgrade ガード**により、**新しい schema の
  DB を古い harness が開くと拒否**される（後方限定）。複数 checkout で同一 `HARNESS_ROOT`
  の DB を共有する場合は、**全 checkout を同時に上げる**（古い harness が新 DB を開けない）。
- コード変更が要るなら **dev クローン側で issue/PR**にする（ops で直接直すと pin が崩れる）。

---

## 3. アップグレード互換メモ（〜0.6.0 の breaking / surface 変更）

`harness release plan` の `compatibilityNotes` をこの節へ転記して運用する。0.6.0 時点の
要点（0.5.0 からの累積）:

- **`goal` → `hitch` 改名（SP-0・breaking）**: CLI `harness goal …` は `harness hitch …`
  に改名。MCP は `harness.goal.*` → `harness.hitch.*`。利用者・自動化・MCP クライアント
  config（`.harness/mcp.yaml` の `allowedOperations` 等）を `hitch.*` に更新する。
  `harness goal` は当面 erroring stub（次リリースで削除予定）。
- **`course → phase` DB roadmap（SP-1）**: DB schema **v21**（`courses` / `phases` /
  `phase_hitches` を additive 追加）。roadmap の正本が markdown（旧 `GOAL.md`）から DB へ。
  `harness course` / `harness phase`、MCP `harness.course.*` / `harness.phase.*` が追加。
- **自律 `course orchestrate`（SP-2・migration ゼロ）**: CLI `harness course orchestrate`、
  MCP `harness.course.orchestrate`（guarded mutation）を追加。**serve 再起動**で露出。
- **schema**: `SCHEMA_VERSION = 21`（SP-2 は schema 追加なし）。migration は自動・additive。
- **schema V22（非 additive DROP）**: dead-code 整理で未配線の `db_stats_snapshots` テーブルを
  **DROP**（`SCHEMA_VERSION = 22`）。実データは未使用のため実質ゼロだが、**V22 適用前に
  `harness db backup`（または DB ファイルのコピー）を推奨**。no-downgrade ガードにより、
  V22 適用後の DB は V21 以前のハーネスでは開けない（後方限定・既存ポリシー）。

---

## 4. チェックリスト（版上げ）

- [ ] `harness release plan` を確認（推奨 bump・削除 surface・exit≠2）
- [ ] surface 変更が spec に記載済み（`mcp.md` / `cli.md` / `db.md`）= `release check` の spec-sync
- [ ] `harness release check` が exit 0
- [ ] release-please PR の version が想定どおり（0.x breaking → minor）
- [ ] PR を merge（tag / Release が切られる）
- [ ] ops checkout を新 tag へ：`git fetch --tags && git checkout vX.Y.Z && npm ci`
- [ ] `harness db migrate`（未適用 migration を適用）
- [ ] `harness mcp serve` を再起動（新 tool 露出）
- [ ] 共有 DB は全 checkout を同時更新（no-downgrade）
