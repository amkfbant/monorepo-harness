# Phase 5-0 — Spec Skeleton / Guardrails

**Date:** 2026-05-22
**Trigger:** `tmp/phase5/phase-5-0.md`（Phase 5-0 設計）
**Harness range:** `phase4-close` タグ → Phase 5-0 commit
**Scope tag:** （Phase 5-0、close タグなし）

## 目的

Phase 5（Project Abstraction）の実装に入る前に、仕様と安全判断を固定し、既存
Phase 2〜4 を壊さない枠組みを文書として確定する。docs のみのフェーズ。

## 成果物

| ファイル | 内容 |
|----------|------|
| `docs/specs/project.md`（新規） | Project Abstraction の target spec。scope / 非ゴール / データモデル / CLI skeleton / 後方互換 / namespace |
| `docs/specs/README.md` | ToC に `project.md` を追加 |
| `docs/specs/policy.md` | profile → repo policy コンパイルの説明を追加 |
| `docs/specs/cli.md` | Web dashboard の phase ラベルを「将来フェーズ／Phase 5 非ゴール」に訂正 |
| `docs/superpowers/plans/2026-05-22-phase5-project-abstraction.md`（新規） | Phase 5 実装計画のコミット用コピー |

## 確定した安全判断（/plan で合意）

1. **provenance**: 生成 repo policy の provenance はサイドカー JSON
   `policies/repos/<id>.generated.json`。policy YAML は既存 `RepoPolicySchema`
   のまま汚さない。
2. **mini-commerce SoT**: `projects/mini-commerce.yaml` を唯一の source of truth
   とし、`policies/repos/mini-commerce.yaml` は compiler 生成 artifact に置き換える。
3. **lock**: dual-mode。lock key は `RunMeta` から決定論的に導出し、全ライフサイクル
   コマンドが同一の規則を使う。`project`/`repoId` を持つ run は `<repoId>--<domainSlug>`、
   持たない旧 run は domain-only。domainSlug は衝突耐性のあるエンコードにする。

## codex レビュー（gpt-5.5 xhigh）

P0: 0 / P1: 3 / P2: 3。全件対応済み。

| ID | 指摘 | 対応 |
|----|------|------|
| P1 | project.md / policy.md が現状仕様のように読める（`src/project/` 未実装） | project.md 冒頭に「Phase 5 実装中・target spec」ステータスバナーを追加。policy.md を「Phase 5（実装中）」明示に修正 |
| P1 | lock namespace 互換が曖昧 | namespace 節を全面改訂。lock key を `RunMeta` から導出する規則を明文化（全ライフサイクルコマンド共通） |
| P1 | `domainSlug` の衝突（`apps/user-api` vs `apps/user/api`） | slug は衝突耐性のあるエンコードにする要件を明記 |
| P2 | domain registry の version / provenance 記録が欠落 | version を持つ対象に domain registry を追加。provenance に registry id+version を追加 |
| P2 | cli.md の Web dashboard phase ラベルが古い | 「将来フェーズ／Phase 5 非ゴール」に訂正 |
| P2 | committed plan の 5-0 チェックリストが実態とずれ（cli.md / 日付） | plan の 5-0 節を実態（project.md に skeleton、2026-05-22）へ修正 |

## Close 条件

- [x] Phase 5 の scope / non-goals / compatibility が docs に明記されている。
- [x] `project` spec の初版がある（`docs/specs/project.md`）。
- [x] 既存 CLI の後方互換を壊さないことが明記されている。
