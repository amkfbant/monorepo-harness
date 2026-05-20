# <Title — e.g. "Auth migration validation" or "Lock race postmortem">

**Date:** YYYY-MM-DD (single day) または YYYY-MM-DD → YYYY-MM-DD (range)
**Trigger:** どの request / 前 report / incident からこのサイクルが始まったか
**Harness range:** `<commit-before>` → `<commit-after>` (この期間にできた変更)
**Scope tag:** `mvp-validation` / `postmortem` / `design-review` / `security-review` / `milestone` / `incident` / ...

> このテンプレは `docs/reports/README.md` の命名規則と合わせて使う。最低限残すべき節は **フロントマター / Scope / Part セクション / Findings / Test inventory / Commits in this cycle / Next phase**。それ以外（"このサイクルで明確になったこと" 等）は不要なら削ってよい。

## Scope

このレポートが扱う範囲を 2–4 文で。何をやって何をやらなかったか。

例: 「前 report の F3 を fix する。同サイクルで新シナリオ X/Y を実機 codex で実行。コストの都合で Z はスキップ。」

---

## Part 1 — <セクション名 e.g. "優先対応" / "実機シナリオ" / "実装変更">

### <タスク / シナリオ名>

**前提:** 背景・なぜこのタスクが必要だったか (1-3 文)

**対応:**
- 何を変えたか (実装 / docs / config)
- 主要ファイル + 行数
- アプローチを 1 行 (代替案を取らなかった理由がある場合のみ追記)

**結果:**
- 実機の場合: runId, status, safetyStatus, counts, 重要なログ抜粋
- 単体の場合: テスト ID, 期待値 vs 実値
- artifact パス

**コミット:** `<sha> <subject>`

**verdict:** ✅ / ⚠ / ❌ + 一行で

### <次のタスク / シナリオ>

(繰り返し)

---

## Part 2 — <次のグルーピング e.g. "新実験" / "リファクタ" / "F7 発見>

(同じ構造で繰り返し)

---

## Findings

| ID | カテゴリ | 一行要約 |
|----|---------|---------|
| F<n> | P0 / P1 / P2 / info | 短く |

### F<n> — <タイトル> (<P*>, status)

**問題:** 一文〜数文

**確率 / 影響範囲:** 該当する場合のみ (定量的に書く)

**修正:** 該当する場合のみ
- コード変更の場所と内容
- 回帰防止テスト名

**verdict:** closed (impl) / closed (docs) / observed (no change) / deferred (...)

---

## Test inventory

- 合計 PASS / skip / fail
- このサイクルで追加した test (file + 件数)
- 走らせた実機 codex run の数と概算 wall time / cost
- typecheck / lint の状態

---

## このサイクルで明確になったこと

(必須ではないが、半年後の自分宛に残すと価値が高い)

1. 学び / 観察 1
2. 学び / 観察 2
3. ...

---

## Commits in this cycle

```
<sha> <subject>
<sha> <subject>
...
```

---

## Next phase / Open items

未着手 todo を **このサイクル内で close できなかった理由付き** で残す。完全な計画は `docs/superpowers/plans/` に別途。

- **<Title>**: 一行で why + 何が前提か
- ...
