# Phase 2-4 機能デモ — mini-commerce 実機検証

**Date:** 2026-05-21
**Trigger:** Phase 2-4 で追加した機能のうち、自動テスト (unit / fake-codex integration) のみで実機デモが未実施だったものを mini-commerce 上で E2E 確認する
**Harness range:** `eb6fc28`（Phase 2-4 + codex review fix の最終状態）
**Scope tag:** `mvp-validation`

## 背景

`2026-05-21-phase2-review-commands-cleanup.md` 以降、以下の機能が追加されたが、実機 codex を用いたデモは限定的だった:

- structured command form / commands.defaults
- review process の exit code 統一 / domain lock
- `harness rerun --from-review`
- `harness review auto`（reviewer agent）
- `harness knowledge promote`
- `cleanup --scope`

特に **reviewer agent は実機 codex で一度も動かしていなかった**（fake runner の unit test のみ）。本デモでその gap を埋める。

---

## デモ構成

mini-commerce (`/Users/kn/dev/mini-commerce/`) で 5 ステップ:

| Step | 検証対象 | codex 実行 |
|------|----------|-----------|
| D1 | structured command form + commands.defaults | ✅ 実機 run |
| D2 | reviewer agent（read-only sandbox の codex） | ✅ 実機 review |
| D3a | review process（approved パス） | — |
| D3b | review process（changes_requested）+ rerun | ✅ 実機 rerun |
| D4 | knowledge promote + cleanup --scope ×3 | — |

実機 codex run は計 3 回（D1 / D3b run / D3b rerun）+ reviewer agent 1 回。

---

## D1 — structured command form + commands.defaults

`policies/repos/mini-commerce.yaml` の catalog domain に 3 形式のコマンドを設定:

```yaml
commands:
  allow:
    - "node -e \"console.log('lint ok')\""        # legacy string form
    - id: check-validation-file                    # structured: argv + per-cmd timeout
      cmd: test
      args: ["-f", "apps/catalog/src/validation.ts"]
      timeout_ms: 30000
    - id: node-version                             # structured: per-cmd env
      cmd: node
      args: ["--version"]
      env:
        NODE_ENV: test
  defaults:
    timeout_ms: 120000
    env_allowlist: [PATH, HOME]
```

`--dry-run` で resolved policy を確認 → string form は `shell:true`、structured form は `shell:false`、`commandDefaults` に timeout/envAllowlist が反映されることを確認。

実機 run:
```
run=run-20260521-apps-catalog-mpf297pn59dba39f status=needs_review commands=3/3
```

**確認できたこと:**
- `runs/<id>/commands/` のログファイル名が **id ベース**:
  `cmd-0.{out,err}.log`（legacy）/ `check-validation-file.{out,err}.log` / `node-version.{out,err}.log`
- structured form の argv spawn が動作（`test -f ...` / `node --version` が exit 0）
- `meta.commandResults` に 3 件の `{command, exitCode, durationMs, timedOut}`
- `node --version` → `v24.6.0`（per-command env 付きで実行）

**verdict:** ✅ legacy string と structured form が混在で動作。id ベースのログ命名も期待どおり。

---

## D2 — reviewer agent（実機 codex で初検証）

```bash
harness review auto --run-id run-20260521-apps-catalog-mpf297pn59dba39f \
  --reviewer-name codex-reviewer-gpt-5
```

read-only sandbox で codex を起動。出力:
```
run=… decision=approved reviewer=codex-reviewer-gpt-5 reviewedAt=2026-05-21T05:44:09Z
note: review-decision.yaml was overwritten; run 'harness review process …' to apply.
```

`reviewer-agent.out.log`（codex の生出力）:
```
```yaml
decision: approved
required_changes: []
non_blocking_comments:
  - "The validation returns the expected AppError shape and added smoke tests cover valid and invalid inStock values."
out_of_scope_suggestions:
  - "Consider adding inStock to the shared ProductSearchInput contract …"
```
```

**確認できたこと（実機 codex の挙動）:**
- codex は **prose を混ぜず、fenced YAML block のみ**を返した（`extractYamlBlock` が問題なくパース）
- decision / non_blocking_comments / out_of_scope_suggestions すべて妥当な内容
- `review-decision.yaml` が `reviewer: codex-reviewer-gpt-5` で上書きされた
- artifact 改竄検出（codex 実行前後の size+mtime snapshot 比較）がパス → read-only sandbox が実際に効いている
- status は遷移しない（`needs_review` のまま）。2 段階構成（auto → process）が意図どおり

**verdict:** ✅ **実機 codex で初めて成功**。fake runner 前提だった懸念（prose 混入・decision 不正）は今回の codex では発生せず。ただし 1 サンプルなので、prose 混入時の `extractYamlBlock` fallback と strict schema reject は引き続き unit test で担保。

---

## D3a — review process（approved パス）

D2 が生成した decision をそのまま適用:
```
run=… needs_review → approved reviewer=codex-reviewer-gpt-5 reviewedAt=2026-05-21T05:44:09Z
```

**verdict:** ✅ reviewer agent → review process の連携が成立。`meta.status` / `reviewer` / `reviewedAt` が同期。

---

## D3b — changes_requested + rerun

apps/orders で新規 run（`shippingMethod` バリデーション追加タスク）:
```
run=run-20260521-apps-orders-mpf2gzf6024a6602 status=needs_review
```

人間 reviewer 役で `review-decision.yaml` を編集:
```yaml
decision: changes_requested
required_changes:
  - "shippingMethod の検証エラーメッセージに許可値 (standard / express) を明記すること"
  - "shippingMethod が未指定 (undefined) の場合は検証をスキップし、エラーにしないこと"
reviewer: knkn
```

`review process` → `needs_review → changes_requested`。

`rerun --from-review`:
```
run=run-20260521-apps-orders-mpf2lhm116433953 parentRunId=run-20260521-apps-orders-mpf2gzf6024a6602 status=needs_review
```

新 run の `codex-prompt.md` に required_changes が埋め込まれた:
```
## Required changes from the previous review

Previous run: run-20260521-apps-orders-mpf2gzf6024a6602 (status: changes_requested)
Reviewer: knkn

Apply these specific changes on top of the previous attempt:
- shippingMethod の検証エラーメッセージに許可値 (standard / express) を明記すること
- shippingMethod が未指定 (undefined) の場合は検証をスキップし、エラーにしないこと
```

**確認できたこと:**
- review process が `changes_requested` を正しく適用
- `rerun --from-review` が新 runId・新 branch・新 worktree で別 run を生成
- 親 run は一切変更されない（`meta.parentRunId` で監査チェーンを辿れる）
- 親の元 goal が `codex-prompt.md` から復元され、required_changes と結合された

**verdict:** ✅ retry loop の手動トリガ版（changes_requested → rerun）が実機で成立。

---

## D4 — knowledge promote + cleanup --scope

### knowledge promote

demo run はすべてクリーン（candidates 空）だったため、過去の failed-policy-violation run（`run-20260520-apps-catalog-mpe9z84h9a1ed201`、policy_violation candidate 1 件）で実施:

```
run=… promoted=1 skipped=0 out=…/docs/knowledge
  policy_violation: …/docs/knowledge/policy_violation/run-…-00-codex-wrote-outside-the-domain-scope-2e9910.md
```

生成された md:
- ファイル名は `<runId>-<idx>-<slug>-<hash>.md`（slug + 6 桁 SHA-1）
- 本文は kind / domain / confidence / source run などのメタ + content 本体
- `knowledge-candidates.yaml` 自体は不変、`events.jsonl` に `knowledge_promoted` 追記

**verdict:** ✅ md 書き出し + hash suffix が動作。（デモ生成物は削除済み run を参照するため、デモ後に `docs/knowledge/` を削除）

### cleanup --scope ×3

| run | status | scope | 結果 |
|-----|--------|-------|------|
| D1 (`mpf297pn5…`) | approved | `workspace` | worktree+branch 削除、**run dir 保持**、`status=cleaned` |
| D3b rerun (`mpf2lhm1…`) | needs_review | `run --force` | worktree+branch+**run dir 削除** |
| E5 過去 run (`mpe9z84h…`) | failed-policy-violation | `all --force` | 上記 + `git worktree prune`。`docs/knowledge/` の promoted md は残存（runs/ と独立） |
| D3b (`mpf2gzf6…`) | changes_requested | `run --force` | **拒否 — exit 1**（retry base 保護、`--force` でも効かない） |

```
# changes_requested + --force でも拒否
$ harness cleanup --run-id run-20260521-apps-orders-mpf2gzf6024a6602 --force --scope run
harness error: cannot cleanup …: changes_requested runs are retry bases; …
exit=1
```

**verdict:** ✅ 3 scope すべて期待どおり。`changes_requested` の保護が `--force` を貫通しないことも確認。

---

## サマリ

| 機能 | デモ前の状態 | デモ結果 |
|------|------------|---------|
| structured command form | unit のみ | ✅ 実機 run で混在動作 |
| commands.defaults (timeout/env) | unit のみ | ✅ resolved policy + 実機実行で確認 |
| reviewer agent (`review auto`) | **fake runner のみ** | ✅ **実機 codex で初成功** |
| review process (approved / changes_requested) | E1 で approved のみ | ✅ 両パス確認 |
| `rerun --from-review` | fake-codex integration のみ | ✅ 実機 rerun、parentRunId チェーン確認 |
| `knowledge promote` | unit/integration のみ | ✅ md 書き出し確認 |
| `cleanup --scope` (workspace/run/all) | unit/integration のみ | ✅ 3 scope + gate 拒否確認 |

**全機能が実機 mini-commerce で期待どおり動作。**

## 新規 finding

なし。デモ中に harness の不具合は検出されなかった。

（デモ実施中、cleanup gate 拒否の exit code 確認で `... | tail -2` のパイプ越しに `$?` を読み、一時的に `tail` の exit code を見てしまった。これは検証手順側のミスで、harness の挙動ではない。パイプを外して再確認したところ正しく exit 1 だった。)

## 残課題 / 観察

- **reviewer agent は 1 サンプルのみ**: 今回の codex は素直に fenced YAML を返したが、モデル/プロンプト次第で prose 混入や decision 逸脱はあり得る。`extractYamlBlock` の fallback と strict schema reject は unit test で担保済みだが、実機での異常系サンプルはまだ無い
- **knowledge-candidates が出る run が少ない**: 正常系 run は candidates 空。promote のデモには過去の failed run を流用した。candidate signal の生成条件（policy_violation / secret_suspect / ignored_untracked_output / codex_no_changes）を意図的に作る検証は別途あってもよい
- **rerun の結果コードの良し悪しは未評価**: parentRunId チェーンと prompt 埋め込みの**仕組み**は確認したが、再 run が required_changes を実際に満たしたかは評価していない（本デモは安全境界とフロー確認が目的）

## 後片付け

- demo run のうち `mpf2lhm1…`（rerun）と `mpe9z84h…`（E5）は cleanup で削除済み
- `mpf297pn5…`（D1）は `cleaned`、`mpf2gzf6…`（D3b）は `changes_requested` で runs/ に残置（runs/ は gitignore 対象）
- `docs/knowledge/` のデモ生成物は削除
- `policies/repos/mini-commerce.yaml` の catalog commands は structured form のデモ設定のまま（次の検証でも使えるため保持）
