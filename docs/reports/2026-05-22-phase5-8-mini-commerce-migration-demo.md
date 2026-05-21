# Phase 5-8 — mini-commerce Migration

**Date:** 2026-05-22
**Trigger:** `tmp/phase5/phase-5-8.md`（Phase 5-8 設計）
**Scope tag:** （Phase 5-8、close タグなし）

## 目的

既存 `mini-commerce` を project profile 形式へ移行し、Phase 5 の代表例にする。

## 成果物

| ファイル | 内容 |
|----------|------|
| `projects/mini-commerce.yaml`（新規） | project profile（source of truth）。`default-docs` context pack を含む |
| `policies/repos/mini-commerce.yaml`（更新） | profile から compile 生成された policy artifact |
| `policies/repos/mini-commerce.generated.json`（新規） | provenance サイドカー |
| `docs/examples/mini-commerce.md` | profile 移行を反映 |
| `tests/integration/mini-commerce-profile.test.ts`（新規） | 同等性 / 非 drift / dry-run / check の検証 |

## 移行方法

`migratePolicyToProfile` で既存 policy → profile（domain scope を explicit に引き継ぎ、
repo-level read を各 domain へ畳み込む）。`policy.template: strict-monorepo-v1`。
compile → `policies/repos/mini-commerce.yaml` を再生成。両 domain で
`resolvePolicy` 出力が移行前後で完全一致することを確認。

## codex レビュー（gpt-5.5 xhigh）

P0: 0 / P1: 2 / P2: 1。全件対応済み。

| ID | 指摘 | 対応 |
|----|------|------|
| P1 | profile に設計要求の `default-docs` context pack が無い | inline `default-docs` context pack（README/docs/contracts/shared）を追加、両 domain が参照 |
| P1 | test が generated-policy drift で pass しうる（`ok\|warn` 許容、scope のみ比較） | 生成 policy YAML / provenance サイドカーの exact byte 比較を追加、check は `status: ok` を要求 |
| P2 | `docs/examples/mini-commerce.md` の policy snippet が旧手書き形のまま | profile が source of truth である説明へ書き換え |

## 後方互換

生成 policy は各 domain `deny_write` に `packages/contracts/**` / `packages/shared/**`
を保持するため、legacy `harness run --repo-id mini-commerce`（共有 `policies/global.yaml`
併用）でも従来どおり保護される。codex レビューでも scope の widening/narrowing なしと確認。

## テスト

`tests/integration/mini-commerce-profile.test.ts` 4 件 pass。
`npm run typecheck` green。`npm test` 648 pass / 1 skip。

## Close 条件

- [x] mini-commerce の project profile が存在する。
- [x] generated policy が existing policy と同等（resolvePolicy 出力一致）。
- [x] mini-commerce で `init --dry-run` 相当（migrate） / `check` / `run --project --dry-run` が通る。
- [x] README と example docs が更新されている（example docs は本 phase、README は Phase 5-10）。
