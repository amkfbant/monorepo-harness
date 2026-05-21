# Phase 2-6 — Reviewer Agent Robustness 実機デモ

**Date:** 2026-05-21
**Trigger:** `tmp/phase2/phase2-6-reviewer-agent-robustness.md`（Phase 2-6 設計）の実装と E2-6 デモ
**Harness range:** `29de9e0`（Phase 2-6 実装 + codex review fix）
**Scope tag:** `mvp-validation`

## 背景

Phase 2-4 で `review auto` の正常系は実機検証済み。Phase 2-6 は **異常系・防御** を固めた:

- invalid codex output 時に `review-auto-error.json` を生成（新規）
- 非 `pending` decision は `--allow-overwrite` なしで上書き拒否（新規）
- `--dry-run`（新規）
- artifact 改竄検出を timeout/exitCode より前に + 再帰 snapshot（codex review fix）

## 実装

| 層 | 変更 |
|----|------|
| `src/core/reviewer-agent.ts` | `review-auto-error.json` artifact、`--allow-overwrite` gate（codex 呼び出し前）、`--dry-run`、再帰 snapshot |
| `src/cli/run.ts` | `review auto` に `--allow-overwrite` / `--dry-run` |
| `docs/specs/cli.md` | review auto の保証範囲・限界・invalid output 挙動を明記 |

unit +16 / integration 新規 6（fake codex bin）。**303 tests PASS / 1 skipped**、typecheck クリア。

## codex review (gpt-5.5 / xhigh)

P0 なし。P1 ×2 + P2 ×1、全件 same-cycle fix:

| ID | severity | 概要 | 修正 |
|----|----------|------|------|
| 1 | P1 | `verifyArtifactsUnchanged` が timeout/exitCode チェックの後 → tamper 後に非ゼロ終了/timeout すると改竄が見逃される | verify を `codexRunner.run` 直後・gate より前に移動 |
| 2 | P1 | `review-decision.yaml` / `review-auto-error.json` を snapshot allowlist から除外 → codex がこれらを改竄しても検出されず、「invalid output で decision を壊さない」保証が sandbox escape 時に崩れる | allowlist を `reviewer-agent.*.log` の 2 つに限定。decision/error file は snapshot 対象（harness は verify 後にのみ write/rm） |
| 3 | P2 | snapshot が run dir 直下のみ → `commands/` 等のサブディレクトリ改竄が見逃される | 再帰 walk、相対パスで snapshot/verify |

## 実機デモ（mini-commerce、run `mpe9vluk4ec0ec90`）

実機 codex 呼び出し計 3 回（D-A / D-C / E2-6-1）。

### D-A: 正常系 review auto

```
$ harness review auto --run-id run-20260520-apps-catalog-mpe9vluk4ec0ec90 --reviewer-name codex-reviewer-p26
run=… decision=approved reviewer=codex-reviewer-p26 reviewedAt=2026-05-21T07:17:41Z
note: review-decision.yaml was overwritten; run 'harness review process …' to apply.
```

✅ codex が fenced YAML を返し review-decision.yaml に decision=approved を書き込み。

### D-B: overwrite gate（`--allow-overwrite` なし）

D-A 後（decision=approved の非 pending 状態）に再度 review auto:

```
$ harness review auto --run-id run-20260520-apps-catalog-mpe9vluk4ec0ec90
harness error: review-decision.yaml already has decision="approved"; pass --allow-overwrite to replace it
exit=1
```

✅ exit 1。**codex を呼ぶ前** に gate で拒否（pre-codex チェック）。人間/過去 agent の verdict が保護される。

### D-C: `--dry-run`

```
$ harness review auto --run-id … --allow-overwrite --dry-run
run=… decision=approved reviewer=codex-reviewer reviewedAt=…
note: --dry-run — review-decision.yaml was NOT written.
```

✅ codex は実行されたが `review-decision.yaml` は変化なし（`diff` で UNCHANGED 確認）。

### E2-6-1: prose 混入（実機 codex）

`PROMPT_PREAMBLE` を一時的に改変し（"Output ONLY a single fenced YAML block" → "First write 2-3 sentences of explanation, THEN output a fenced YAML block"）、codex に prose を誘導:

codex の生 output（`reviewer-agent.out.log`）:

```
The diff is scoped to `apps/catalog` and implements the requested `priceMin`/`priceMax`
validation with the existing `err(...)` AppError pattern. Added smoke checks cover ...

​```yaml
decision: approved
required_changes: []
non_blocking_comments:
  - "Tests were added, but this run only recorded placeholder/file-existence commands ..."
out_of_scope_suggestions: []
​```
```

結果: `review auto` は exit 0、`review-decision.yaml` には**YAML block の中身だけ**が書かれ、先頭の説明文（prose）は混入しなかった。

✅ **実機 codex の prose 混入を `extractYamlBlock` が正しく処理**。これは Phase 2-4 close 時に Phase 3 送りとした「reviewer agent の実機異常系サンプル」の一部を前倒しで取得したもの。

> デモ後、`PROMPT_PREAMBLE` の一時改変は完全に revert 済み（`git diff` でクリーン確認）。

### 異常系（invalid decision / malformed YAML / artifact 改竄 / overwrite gate / dry-run）

実機 codex に invalid output を**確実に**出させるのは非決定的で困難なため、これらは unit + integration test（fake codex bin）で決定論的に担保:

- `tests/unit/core/reviewer-agent.test.ts`（32 ケース）— invalid decision / 非 string entry / unparseable YAML / 不明 decision / artifact 改竄（+非ゼロ終了 / +timeout / `commands/` サブディレクトリ / `review-decision.yaml` 自体）/ overwrite gate / dry-run / error artifact
- `tests/integration/cli-review-auto.test.ts`（6 ケース）— fake codex bin で CLI E2E（正常 / dry-run / overwrite 拒否 / overwrite 許可 / invalid output → error artifact / prose 抽出）

## 閉じる条件チェック（Phase 2-6 設計 2-6.6）

```txt
[x] prose混入出力から YAML block を抽出できる        — E2-6-1 実機 + unit
[x] invalid decision は reject される                — unit + integration
[x] invalid output で review-decision.yaml が壊れない — unit + integration（write は検証通過後のみ）
[x] reviewer agent は status を変更しない            — 設計（review process のみ status 遷移）
[x] artifact 改竄試行を検出または防止できる          — 再帰 snapshot + verify、tamper test 群
[x] read-only sandbox が維持される                   — codex sandbox=read-only + snapshot 二重防御
[x] 失敗時 exit code が 1 / 2 の規約に合う            — gate/output error→1、内部例外→2
[x] unit / integration / 実機サンプルがある           — 上記 + E2-6-1 実機
[x] docs に review auto の保証範囲と限界が明記される   — docs/specs/cli.md「保証範囲」「限界」節
```

## 新規 finding

なし。codex review の P1×2 + P2×1 は実装直後に fix 済み。

## Deferred

- 実機 codex で invalid decision / malformed YAML を**確実に**誘発する異常系サンプルは未取得（非決定的なため。決定論的カバレッジは fake-runner テストで担保）→ Phase 3
- reviewer agent の verdict の**品質**評価（複数モデル / 複数回） → Phase 3

## 後片付け

- デモ run `mpe9vluk4ec0ec90` は `needs_review` のまま runs/ に残置（review auto は status を変えない）。review-decision.yaml は E2-6-1 の decision=approved（reviewer=codex-reviewer-prose-test）
- `PROMPT_PREAMBLE` の一時改変は revert 済み
