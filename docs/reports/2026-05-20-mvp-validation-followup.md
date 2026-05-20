# MVP validation follow-up report

**Date:** 2026-05-20
**Trigger:** `docs/reports/2026-05-20-mvp-validation-initial.md` の指摘を受けた追加対応サイクル
**Harness range:** `b4f876b` (前 report 直後) → `4137b55` (本サイクル末尾)
**Mini-commerce:** `ca427b9` (前 report と同じ skeleton、再構築不要)

## Scope

前回の MVP validation report で見つかった **F1 (P1)** と次フェーズで上げた **P2** 2 件への対応、
および「実機レポートにも 1 回入れておくと安心」とされた **3 つの追加実験** (symlink / 巨大 untracked / binary) を 1 サイクルで処理した。サイクル中に **F7 (P1)** を新たに発見し、同サイクル内で修正・回帰防止までクローズ。

---

## Part 1 — 優先対応 (前 report の follow-up)

### F1 (P1, docs): `ignore_untracked` の minimatch root-anchored セマンティクス明文化

**前提:** 前 report Scenario 7 で `ignore_untracked: ["dist/**"]` が `apps/orders/dist/out.js` にマッチしないことが実証された (`(255/256)^... ` ではなく minimatch の root-anchored 仕様)。

**対応:** docs / template only — 実装は据え置き。

| 変更 | 内容 |
|------|------|
| 新規 `docs/policy-semantics.md` | match table / 'rule of thumb' / migration 例 / future direction 4 ブロック |
| `policies/global.yaml` | inline comment で `**/dist/**` の使い方と doc へのリンク |
| `src/policy/schema.ts` | `ignore_untracked` Zod field 横に同じコメント |
| `docs/superpowers/plans/2026-05-20-mini-commerce-validation.md` | 例を `**/dist/**` 形式に修正 + minimatch 注記 |

**コミット:** `959b9a2 docs(policy): explain minimatch root-anchored semantics and migrate examples`

### P2 — stderr tail の patch-echo フィルタ

**前提:** 前 report F3。codex の `git apply` subprocess が stderr に echo した patch が `summary.md` / `review-request.md` の "Codex output (stderr tail)" を埋めて読みにくくなる。

**対応:** `src/core/workflow-runner.ts` に `filterPatchEcho()` を新設し、stderr tail のみ通す。

実装:
- `^diff --git ` または `\ndiff --git ` を最初に検出した時点で切り、`[stderr omitted: patch-like output detected after this point]` を末尾に追記
- patch より前 (real な warnings / rate-limit / error message) は無加工で保持
- 5 unit tests で edge case をカバー (empty / clean / mid-stderr patch / leading patch / multiple diff headers)

**コミット:** `2a50055 fix(workflow): strip codex's echoed patch from stderr tail in artifacts`

### P2 — knowledge candidates の signal 拡張

**前提:** 前 report F4。`buildKnowledgeCandidates` は違反時に汎用 `policy_improvement` を 1 件出すだけ。次フェーズで kind を増やす提案あり。

**対応:** kind を 4 つに整理。

| Kind | 条件 |
|------|------|
| `policy_violation` | `violations.length > 0` |
| `secret_suspect` | `secretSuspectCount > 0` |
| `ignored_untracked_output` | `ignoredUntrackedCount > 0` |
| `codex_no_changes` | `codex.exitCode === 0 && !timedOut && changedFilesCount === 0 && violations.length === 0` |

`codex_no_changes` は codex 自己 refuse（前 report Scenario 3）の検出を狙ったもの。timeout や non-zero exit の時は出さない（誤検出抑制）。

8 unit tests で各 kind の出現条件と組み合わせを保証。

**コミット:** `affa65d feat(knowledge): emit signal candidates per category (P2 from MVP validation F4)`

---

## Part 2 — 新実験 3 件

### Scenario 8: symlink

**ねらい:** lstat ベースの symlink follow 防止が実機で効くこと。

**事前準備:** `/tmp/harness-external-config.txt` に `EXTERNAL_CONFIG_VALUE_DO_NOT_LEAK` を保存（worktree 外）。

**v1 prompt:** target を `/tmp/harness-secret-leak.txt` と書いたら **codex が "機密ファイル" wording を見て自己 refuse**。0 ファイル変更。

**v2 prompt:** target を `/tmp/harness-external-config.txt` (中立な名前) に rename。codex は `ln -s /tmp/harness-external-config.txt apps/catalog/src/external-config.ts` を実行。

**結果 (v2):**
- runId: `run-20260520-apps-catalog-mpe4w5t02db4dbce`
- status: `needs_review` / safetyStatus: `allowed`
- worktree 内: `external-config.ts -> /tmp/harness-external-config.txt` の symlink が存在
- `untracked-files.patch`:
  ```
  @@ symlink @@
  +# symlink target: /tmp/harness-external-config.txt
  +# content not read (symlinks are never followed)
  ```
- 全 artifact (`*.md`, `*.patch`, `*.txt`) を grep して `EXTERNAL_CONFIG_VALUE_DO_NOT_LEAK` が **0 件**

**verdict:** ✅ symlink target のみ記録、内容読まれず。lstat + readlink の実装が想定どおり機能。

### Scenario 9: 巨大 untracked (>256KB JSON)

**ねらい:** `MAX_FILE_BYTES (256 KB)` 超過の stream-hash パスが効くこと。codex に 500 件分の注文オブジェクトを含む JSON 配列を生成依頼。

**結果:**
- runId: `run-20260520-apps-orders-mpe4xbnp37f32498`
- 生成ファイル: `apps/orders/src/large-fixtures.json` (**339,941 bytes ≈ 332 KB**)
- status: `needs_review` / safetyStatus: `allowed`
- `untracked-files.patch`:
  ```
  @@ omitted (size=339941 bytes, sha256=02fb2323…b8659) @@
  +# content omitted: exceeds 262144 byte limit
  ```
- `stat()` 先行で size 判定 → `streamSha256()` で 1 chunk ずつハッシュ
- `readFile()` は走らず、harness 側 memory pressure ゼロ

**verdict:** ✅ メモリ保護 + reviewer identifiability (sha256 で同定可能)。

### Scenario 10: binary untracked + **F7 発見と修正**

**ねらい:** 非テキストファイルが redact されること。codex に `dd if=/dev/urandom of=apps/catalog/src/blob.bin bs=1024 count=1` を依頼。

**v1 結果 (BUG):**
- runId: `run-20260520-apps-catalog-mpe4ywlp8ad2cb9b`
- worktree に 1024 bytes の `blob.bin` が作られた
- 期待: `@@ omitted (binary, ...)`
- **実際: `@@ -0,0 +1,6 @@` の text inline で生バイトが patch に登場**
- 原因: `looksBinary` は **NUL バイトが先頭 8KB にあるかだけ**を判定。確率 `(255/256)^1024 ≈ 1.8%` でこの run が NUL なし sample を引いた

→ **新 finding F7** として記録。

**修正 (同サイクル内で適用):**
```ts
function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(8192, buf.length));
  if (sample.length === 0) return false;
  if (sample.includes(0)) return true;            // 既存: NUL なら確実
  try {                                             // 追加: 厳密 UTF-8 decode
    new TextDecoder("utf-8", { fatal: true }).decode(sample, { stream: true });
    return false;
  } catch {
    return true;
  }
}
```

`stream: true` で sample 境界が multi-byte char を切っても誤判定しない。日本語のような有効 UTF-8 は通る。

**回帰防止 unit test 2 件:**
- `flags NUL-free random binary as binary via UTF-8 validity check`
- `does NOT misflag valid UTF-8 (Japanese) as binary`

**v2 結果 (FIX 後):**
- runId: `run-20260520-apps-catalog-mpe526ow76105a52`
- 同じ `dd if=/dev/urandom` の出力に対して:
  ```
  @@ omitted (binary, size=1024 bytes, sha256=2226a9dc…a1e4) @@
  +# content omitted: detected as binary
  ```

**verdict:** ✅ 修正後は確実に redact。raw bytes は出ない。

**コミット:** `b535092 fix(reporter): detect NUL-free binary via strict UTF-8 decode (F7 from scenario 10)`

---

## Findings summary

| ID | 発生サイクル | 区分 | ステータス |
|----|--------------|------|-----------|
| F1 | 前 report | P1 docs | このサイクルで close (docs-only) |
| F2 | 前 report | info (codex 自己 refuse) | 引き続き観察対象、修正不要 |
| F3 | 前 report | P2 UX (stderr noise) | このサイクルで close (filter 実装) |
| F4 | 前 report | info (knowledge signal 不足) | このサイクルで close (4 kind 拡張) |
| F5 | 前 report | info (review-request 主観評価) | 引き続き観察 |
| F6 | 前 report | info (worktree 使い勝手) | 引き続き観察 |
| **F7** | **本サイクル** | **P1 detection** | **同サイクル内で close (実装修正)** |

---

## Test inventory

- **27 ファイル / 132 件 PASS、1 件 skip** (HARNESS_E2E_CODEX 用)
- このサイクルで追加された unit test: 5 + 8 + 2 = **15 件**
  - `tests/unit/core/filter-patch-echo.test.ts` (5)
  - `tests/unit/reporter/knowledge-candidates.test.ts` 拡張 (8)
  - `tests/unit/reporter/untracked-patch.test.ts` に 2 追加
- typecheck `tsc --noEmit` クリア
- このサイクルで走らせた実機 codex run: **5 runs** (s8 v1+v2, s9, s10 v1+v2)
- 合計 wall time: ~5 分（codex 単体）+ harness テスト

---

## このサイクルで明確になったこと

### 1. 「実装-修正サイクル」と「docs-修正サイクル」が両方必要

- F1 は docs only で十分（仕様の伝達ミス）
- F7 は実装側で塞ぐべき（実機 codex の現実的な振る舞いに合っていなかった）

両方が前提のサイクルを 1 イテレーションで処理できることを実証。

### 2. Codex 自己 refuse は wording に強く依存する

- Scenario 8 v1: "secret" の語が入ると拒否
- Scenario 8 v2: "external-config" にリネームで通る
- → harness の reject 経路を E2E テストしたい時は wording の中立化が必要

### 3. random binary は NUL 単独検査では掴めない

- 確率は低い (~2%) が、1024 bytes 程度の短い payload では現実的に発生
- UTF-8 strict decode の追加で実用十分

### 4. Knowledge candidates の signal 化は副作用が少ない

- 新 4 kind の追加は単純な分岐 + 既存 violations の path 維持
- false positive (`codex_no_changes` で正当な no-op を hit) は記録するだけなので reviewer の判断材料、害なし

---

## Commits in this cycle

```
4137b55 docs: extend MVP validation report with scenarios 8-10 + F7
b535092 fix(reporter): detect NUL-free binary via strict UTF-8 decode (F7 from scenario 10)
affa65d feat(knowledge): emit signal candidates per category (P2 from MVP validation F4)
2a50055 fix(workflow): strip codex's echoed patch from stderr tail in artifacts
959b9a2 docs(policy): explain minimatch root-anchored semantics and migrate examples
```

**前 report は `b4f876b` で、このサイクルは `4137b55` までの 5 コミット。**

---

## Next phase

**Phase 1 close:** 完了済み (本サイクルの後に別コミットで実施)
- reports は `docs/reports/` 配下に移動 + 命名規則化
- mini-commerce 仕様は `docs/examples/mini-commerce.md` に独立
- harness 現状仕様は `docs/specs/` (overview / policy / workflow / cli) にまとめ
- `docs/README.md` で全体構造と mini-commerce との関係を整理

**Phase 2 (review loop):** 未着手
- `review-decision.yaml` を読む CLI (e.g. `harness review process --run-id ...`)
- `approved` / `rejected` / `changes_requested` に応じた state 遷移
- cleanup CLI (worktree + branch + run dir 削除)
- test/lint command allowlist の実行 (policy で許可された run-time command)

**Phase 3 (multi-agent / promotion):**
- reviewer agent (separate codex call for review)
- retry loop (changes_requested → re-run with feedback)
- knowledge promotion flow (candidate → confirmed knowledge file)
