# CLAUDE.md — monorepo-harness

このリポジトリで作業する際の指針。`codex exec` を駆動して **モノレポの 1 ドメイン
だけ** を安全に編集させる TypeScript CLI ハーネス。ハーネスは事後に `git diff` を
取り、policy の `write` / `deny_write` スコープで変更 path を検証する。

> グローバル規約（`~/.claude/CLAUDE.md` 配下: immutability / 小ファイル /
> Conventional Commits / TDD / セキュリティチェック）が前提。本ファイルはそれを
> このプロジェクト向けに具体化する。矛盾時はグローバル規約が優先。

---

## goal モードのとき（最重要）

このハーネスを **goal モード**（`harness goal` 系で実装/レビュー/修正ループを
回す）で動かす・実装する際は、以下を**必ず**参照する。

1. **[`GOAL.md`](./GOAL.md)** — 「何を作るか」。大 Phase / サブ Phase の定義と
   実装順、スコープ確定メモ（含む/含まない）。
2. **[`GOAL_RULES.md`](./GOAL_RULES.md)** — 「どう作るか」。レビューのリトライ
   と続行判断（未解決 P0 ゼロが続行/close の必須条件）、finding の P0〜P3 分類、
   close 条件、テスト粒度、ブランチ/マージ運用、スコープ管理、安全境界、開発規律、
   codex レビューテンプレート（サブ用 / 大用）。
3. **[`AGENTS.md`](./AGENTS.md)** — goal convergence の運用ルール（goal session
   を先に立てる / read → dry-run → guarded mutation の順 / 各レビュー後に finding
   記録 / `harness goal check-convergence` / escalate・diverging・budget_exhausted・
   needs_classification で自動修正を止める / MCP `confirmation_required` を shell で
   迂回しない）。

**codex レビューコマンドは常に** `codex exec -m gpt-5.5 -c model_reasoning_effort="xhigh"`
（サブ Phase は最大 3 回、大 Phase は最大 5 回リトライ。詳細は `GOAL_RULES.md`）。

---

## 安全境界（不可侵）

どの作業でも侵してはならない。`GOAL_RULES.md` §G と同一。

- **policy 検証は事後 `git diff` ベース**。検証を緩める/バイパスする変更は不可。
- **LLM の出力を信用しない**。severity や「修正した」等の自己申告を状態遷移の
  根拠にしない。判定は決定論的な harness 側ロジックで行う。
- **状態遷移は harness のみ**。goal / run / finding / review のライフサイクルを
  LLM やレビュー出力が直接書き換えることを許さない。
- **MCP `confirmation_required` を shell で迂回しない**。dangerous operation は
  `operation confirm` / `operation reject` で out-of-band に処理する。
- 迷ったら安全側（停止・エスカレーション）に倒す（fail-closed）。

---

## 主要コマンド

```bash
npm run typecheck      # tsc --noEmit。commit 前に必須
npm test               # vitest run（フルスイート）
npm run test:watch     # vitest（watch）
npm run build          # dist/ ビルド
npm run harness -- <args>   # 開発時の CLI 起動（tsx 経由、HARNESS_ROOT 指定）
```

- **commit 前に必ず `npm run typecheck`。**
- サブ Phase = 関連テスト + typecheck 緑、大 Phase = フルスイート + typecheck 緑
  （回帰禁止。テストを弱める/skip する形の「緑化」は禁止）。
- CLI の全 subcommand は [`docs/specs/cli.md`](./docs/specs/cli.md)。

---

## 参照すべきドキュメント

| 場所 | 内容 | いつ読む |
|------|------|---------|
| [`GOAL.md`](./GOAL.md) | 実装ロードマップ（大/サブ Phase） | goal モードの実装着手前 |
| [`GOAL_RULES.md`](./GOAL_RULES.md) | goal モード実行ルール | goal モードの実装中ずっと |
| [`AGENTS.md`](./AGENTS.md) | goal convergence 運用ルール | goal セッション運用時 |
| [`docs/README.md`](./docs/README.md) | docs 全体の index | 迷ったらまず |
| [`docs/specs/overview.md`](./docs/specs/overview.md) | 何ができて何ができないか | 全体像把握 |
| [`docs/specs/cli.md`](./docs/specs/cli.md) | 全 CLI subcommand リファレンス | コマンドを使う前 |
| [`docs/specs/policy.md`](./docs/specs/policy.md) | policy YAML 形式と評価順 | policy を書く前 |
| [`docs/policy-semantics.md`](./docs/policy-semantics.md) | minimatch root-anchored の落とし穴 | policy を書く前（必読） |
| [`docs/specs/workflow.md`](./docs/specs/workflow.md) | run の status machine / codex 起動方式 / artifact | run/codex 周りを触る前 |
| [`docs/specs/db.md`](./docs/specs/db.md) | `harness.sqlite`（DB read/canonical）と import | DB を触る前 |
| [`docs/specs/mcp.md`](./docs/specs/mcp.md) | MCP server（tools/resources/permission/confirmation） | MCP を触る前 |
| [`docs/specs/dashboard.md`](./docs/specs/dashboard.md) | dashboard（read-only API + mutation API） | dashboard を触る前 |
| [`docs/specs/goal-convergence.md`](./docs/specs/goal-convergence.md) | goal convergence controller の仕様 | goal 内部を触る前 |
| [`docs/specs/project.md`](./docs/specs/project.md) | Project Abstraction 層 | project profile を触る前 |
| [`docs/future-features.md`](./docs/future-features.md) | 将来 feature（スコープ外の保留事項） | スコープ外を見つけたとき |
| [`docs/ops/`](./docs/ops/) | 認証/secret・DB メンテ・運用 manual | 運用設定時 |
| [`docs/reports/`](./docs/reports/) | 実機検証ログ + finding registry | 過去の経緯確認時 |
| [`docs/examples/mini-commerce.md`](./docs/examples/mini-commerce.md) | 検証用ダミー monorepo の構成 | テスト/検証時 |

---

## 開発規律

- **TDD**: RED（失敗するテスト）→ GREEN（最小実装）→ REFACTOR。production コードの
  前にテストを書く。
- **Conventional Commits**（`feat:` / `fix:` / `refactor:` / `test:` / `docs:` /
  `chore:` / `perf:` / `ci:`）。attribution（Co-Authored-By）は付けない。
- **spec 駆動**: `src/` や policy の動作が変わったら、対応する `docs/specs/*` を
  **同じコミットで**更新する。`docs/specs/` は現状のスナップショット（TODO を
  書かない）。
- **immutability**（新オブジェクトを作り、mutate しない）、小ファイル（〜400 行
  目安・800 行上限）、適切なエラーハンドリング、`console.log` を残さない。
- **スコープを広げない**: 作業中に見つけたスコープ外の事項は backlog /
  `docs/future-features.md` / follow-up に積む（その場で直さない）。

---

## アーキテクチャの要点

- **DB-canonical**: `.harness/harness.sqlite`（現行 schema）が runtime の source of
  truth。files は互換 export。DB を触る変更は migration / import / consistency を
  確認する（`docs/specs/db.md`）。
- **codex は単発・ステートレス**: `codex exec --ephemeral` で毎回新規 prompt。
  会話セッションは持たない（再現性・監査性のための設計判断。`docs/future-features.md`
  の「Codex session continuation」参照）。文脈は prompt 注入（rerun の
  `required_changes` / knowledge context）と run lineage（`parentRunId` /
  `rootRunId`）で引き継ぐ。
- **runner は DI 抽象**: `CodexExecRunner`（`src/codex/`）。テストは
  `createFakeCodexRunner()` を使う。
