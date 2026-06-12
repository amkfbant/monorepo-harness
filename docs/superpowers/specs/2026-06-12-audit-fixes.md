# Audit fixes spec — #112–#134（「大」#129/#132 を除く 21 issue）

Status: Fable-5 作成 → codex gpt-5.5 xhigh レビュー対象。実装は codex exec gpt-5.5 high（TDD）。
Date: 2026-06-12 / target: v0.6.0 main。

## 範囲
2026-06-12 の Fable 詳細監査で起票した #112–#134 のうち、**大きな仕様変更（#129 failed-command 自動復帰 / #132 AbortSignal 中断）を除く 21 issue** の修正方針 spec。各 issue: 現状 / 変更内容 / 対象 file:line / 挙動・互換性 / 安全境界考慮 / テスト / 規模。

## 不可侵の安全境界（全 spec が遵守）
policy 事後 git diff 検証を緩めない / LLM 出力を状態遷移根拠にしない / 状態遷移は harness のみ決定論 / MCP confirmation_required を shell で迂回しない / fail-closed / fail-open(完了/許可)=決定論+operator・fail-closed(制限/作業追加)=外部可 の非対称 / 小ファイル・immutability・spec 駆動。

## 調査中の重要メモ
- **#116**: 提案された主修正（insertProposal の tx 内 run-status 再読 + ReviewerAgentGateError）は既に commit `6db3659` で実装済み・テスト有り。本 spec は残存ギャップ（overwrite guard の非アトミック性 = 並行 review auto の後勝ち supersede）に限定。docs/future-features.md の当該 active follow-up は stale。
- **#124 調査中の新発見**: `src/mcp/tools/mutation-tools.ts:1341` の第三の private `runMcpOperation` が input を redact しない（wrapper 版は redact 済み）→ 監査ログへの機微情報混入の可能性。**本バッチ外の新規 issue として起票推奨**。
- schema 変更を伴う #126(DROP) / #130(hitch_lifecycle_events) / #131(prompt_provenance_json) は **migration V22 として設計をまとめてから**個別 PR にする。

---

# Group A（#112–#124）

