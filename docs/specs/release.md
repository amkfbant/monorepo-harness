# release.md — リリース計画 / 互換性解析

`harness release plan` の仕様。**release-please を置き換えず補完する**、決定論的な
release-readiness + 互換性アナライザ。エージェント駆動の版上げ判断材料を提供する。

## 役割分担

| 担当 | やること |
|------|---------|
| **release-please**（`.github/workflows/release.yml`） | Conventional Commit 履歴から **version bump（package.json / manifest）/ CHANGELOG / release PR / `vX.Y.Z` tag + GitHub Release** を自動生成・維持。merge が版を切る決定的行為。 |
| **`harness release plan`** | release-please が**見ない**ものを決定論的に算出: **DB schema delta（no-downgrade 影響）**・**削除/改名された CLI / MCP surface**・推奨 SemVer bump・未宣言の破壊的変更の警告。任意のタグ範囲（`--since`/`--to`）。 |

`plan` は読み取り専用（git とソースを読むだけ。bump も tag もしない）。

## `harness release plan`

```bash
harness release plan [--since <ref>] [--to <ref>] [--json]
```

| Option | 既定 | 説明 |
|--------|------|------|
| `--since <ref>` | 直近の tag（`git describe --tags --abbrev=0`） | 比較元 |
| `--to <ref>` | `HEAD` | 比較先 |
| `--repo <path>` | カレントディレクトリ | 解析対象の git リポジトリ |
| `--json` | off | JSON 出力（エージェント / CI 用） |

git は `--repo`（既定: `process.cwd()`）のリポジトリで実行する。`--since` / `--to` が解決できなければ exit 1。

### 算出内容

- **commits**: `since..to` の非 merge コミットを Conventional Commit でパースし type 別集計。`feat!` / `BREAKING CHANGE:` を breaking として検出。
- **recommendedBump / recommendedVersion**: SemVer。**0.x では breaking も MINOR**（release-please の node type と一致）、`feat`→minor、`fix`/`perf`→patch、それ以外→none。`recommendedVersion` は `currentVersion`（package.json）＋ bump。
- **compatibility.schema**: `src/db/schema.ts` の `SCHEMA_VERSION` を両 ref で読み、変化があれば範囲内の migration（`MIGRATIONS` の version/name）を列挙。各 migration の **additive 判定**（`DROP TABLE/COLUMN` / `DELETE FROM` / `RENAME`〔table も column も〕を含めば non-additive）。`noDowngrade` は schema が上がれば true（migration runner が「新しい schema の DB を古い harness が拒否」する＝後方限定）。**fail-closed**: `to` ref の `schema.ts` が読めない / `SCHEMA_VERSION` をパースできなければ throw（「unchanged v0」と誤魔化さない）。`since` が schema.ts 以前なら from=v0 とみなす。範囲内の migration 数が version 差と合わなければ `analysisWarnings` に「metadata incomplete」。
- **compatibility.mcpTools / cliCommands**: `tool-registry.ts` の `name: "harness.*"`、CLI コマンド登録ファイル群（`run.ts` ＋ `project.ts` / `policy.ts` / `db.ts` / `goal.ts` / `mcp/cli.ts`）の `.command("…")` を両 ref で正規表現抽出し added/removed を diff（CLI はファイル横断の**トークン union** で比較＝あるファイルで消えても別ファイルに残れば removal にしない）。**`to` ref で当該ファイルが読めない（移動/改名）場合は diff を skip し `analysisWarnings` に記録**（「全削除」と誤検知しない）。CLI は token 単位の best-effort（nested path は復元せず＝共有 token の removal を取りこぼす可能性。安全側に倒れる）。
- **analysisWarnings**: 解析が不完全になった事実（surface 読み取り不可・migration metadata 不足）を出力し、結果を「部分的」と明示する。
- **undeclaredBreaking**: surface 削除 or non-additive migration があるのに `feat!`/`BREAKING` marker が無い場合の警告。**この場合 plan は exit code 2**（エージェント / CI の fail-closed シグナル）。
- **compatibilityNotes**: schema no-downgrade 注意・新規 MCP/CLI surface を、release / upgrade ドキュメントに転記できる形で出力。

### exit code

- `0`: 解析成功（互換問題なし、または additive な変更のみ。analysisWarnings 無し）
- `1`: ref 解決失敗 / tag 無し / `to` の `schema.ts` 読み取り・パース不能（fail-closed）
- `2`: **fail-closed シグナル** — 未宣言の破壊的変更（surface 削除 / non-additive migration に marker 無し）**または** 解析が不完全（`analysisWarnings`：`since` に在った surface ファイルが `to` で消えた / migration metadata 不足）＝「破壊なし」を信用できない状態

### 限界（現状）

- surface 抽出は**正規表現ベースの best-effort**（MCP 名は安定、CLI は token 単位で full path を復元しない）。config キーの diff は未対応。
- migration name/statements は**現在の `MIGRATIONS`** を参照する（`--to` が現行 schema 以下である前提）。
- bump/CHANGELOG/tag は release-please の担当（`plan` は実行しない）。

## `harness release check`

リリースを切ってよいかを判定する **fail-closed なゲート**。`release plan` が「教える」のに対し
`release check` は「止める」。release PR を merge する前にエージェント / CI が回す。CI（typecheck/
build/test）を**置き換えず補完**し、release 固有の前提だけを見る。

```bash
harness release check [--since <ref>] [--to <ref>] [--repo <path>] [--json]
```

4 つの check（全 pass で exit 0、1 つでも fail で **exit 1**）:

1. **plan-clean** — `release plan` が未宣言の破壊的変更も解析の不完全さも持たない（plan の exit-2 条件に当たらない）。
2. **version-consistency** — `package.json` の version と `.release-please-manifest.json` の `"."` が一致。
3. **spec-sync** — 変化した surface が文書化されている（spec 駆動）: 追加 MCP tool は `mcp.md` に、追加 CLI command token は `cli.md` に、schema bump の到達 version `vN` は `db.md` に出現する。
4. **clean-tree** — `git status --porcelain` が空（未コミット変更なし）。

build / test は CI の担当（`release check` は回さない）。エージェントの版上げは実質
`release plan`（把握）→ `release check`（exit 0 で青信号）→ release PR を merge。

将来（`docs/future-features.md`）: `release notes`（`docs/UPGRADING.md` 生成）、surface diff の構造化。
