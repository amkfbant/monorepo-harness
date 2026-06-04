# Phase 4: dashboard mutation UI — 設計

GOAL.md Phase 4。完成済みの mutation API（Phase 13: CSRF token + Bearer、
`dashboard serve --enable-mutation`）にブラウザ向けフロントエンド UI を載せる。

- base ref: `goal-phase3-close`
- 現状: backend は完成（POST routes + CSRF + bearer）。`src/dashboard/render.ts` は
  read-only static HTML で mutation UI は無い。server の GET `/` は mutationEnabled
  時に CSRF meta タグ + 静的バナーを文字列置換で inject している（実 UI は無い）。
- 安全: 既定 OFF（`--enable-mutation` 時のみ）。bearer / CSRF を UI 側でも厳守。

---

## アーキテクチャ方針

mutation UI は **`render.ts` に統合**する（HTML 生成の単一箇所・XSS escape 済み・
unit テスト可能）。`renderDashboardHtml(snapshot, options?)` に optional
`options.mutation?: { csrfToken: string }` を追加。

- **未指定（既定 / static export / mutation OFF）**: 従来どおり read-only HTML。
  mutation 要素・JS・CSRF meta は一切出さない。
- **指定時（server が `--enable-mutation` + csrfToken のとき渡す）**: CSRF meta タグ
  + bearer 入力 + 各 mutation 操作の UI + inline JS を出す。

server の GET `/` は、従来の「文字列置換で meta+banner を inject」を廃し、
`renderDashboardHtml(snapshot, { mutation: { csrfToken } })` を呼ぶ（二重 inject
防止）。mutationEnabled が false なら従来どおり `renderDashboardHtml(snapshot)`。

> backend の認証・状態遷移・idempotency は不変。UI は POST を組み立てるだけで、
> 状態遷移は harness（server の operation/state guard）のみが行う。

---

## 4-1 mutation UI 骨格

- `<meta name="harness-csrf-token" content="<esc>">` を head に出す。
- **bearer 入力**: `<input type="password" id="harness-bearer">`（sessionStorage に
  保持して再入力を省く、任意）。
- **inline JS ヘルパ** `harnessPost(path, body, { destructive })`:
  - CSRF token を meta から読む。bearer を入力欄から読む。
  - `fetch(path, { method:"POST", headers:{ "Content-Type":"application/json",
    "X-CSRF-Token": token, "Authorization": "Bearer "+bearer,
    "Idempotency-Key": <uuid（非 dryRun 時）> }, body: JSON.stringify(body) })`。
  - レスポンス（JSON）を結果領域に表示。非 2xx は error として表示。
  - destructive 操作は送信前に `confirm()` ダイアログ。

JS は静的文字列（信頼できない値を JS に補間しない）。run/item id は data-* 属性に
**escape して**埋め、JS は dataset から読む。

## 4-2 各 mutation 操作の UI

snapshot の run / backlog から対象を引き、各 POST route に対応する操作を出す:

- **review decision**（`POST /api/runs/:runId/review`）: needs_review な run 行に
  approve / changes_requested / rejected ボタン。
- **cleanup**（`/cleanup`）: run 行に cleanup ボタン（destructive、`confirm:
  "cleanup"`、scope 選択 workspace/run/all）。
- **pr create**（`/pr`）: run 行に PR 作成ボタン（`confirm: "create-pr"`、202 deferred）。
- **rerun**（`/rerun`）: run 行に rerun ボタン（reason 任意、202 deferred）。
- **backlog run**（`/api/backlog/:itemId/run`）: backlog item 行に run ボタン
  （202 deferred）。
- 各操作に **dry-run チェックボックス**（既定 ON 推奨）。dry-run は安全に計画のみ。

## 4-3 誤操作防止 / エラー表示

- **確認ダイアログ**: 破壊的操作（cleanup / rerun / pr / 非 dry-run の review）に
  送信前 `confirm()`。
- **エラー表示**: 非 2xx レスポンスを結果領域に code/error/message で表示。
  - 409 conflict / idempotency_replayed_failure（stale 状態への操作）を明示表示。
  - 401（bearer 不正）/ 403（CSRF 不正）を明示。
- **楽観排他**: backend が operation idempotency + state guard で stale を 409 で
  弾く。UI は 409 を明示し、再読込を促す。各操作は新規 Idempotency-Key を発行。

---

## テスト（TDD・回帰禁止）

- `tests/unit/dashboard/render.test.ts` 拡張:
  - mutation 未指定 → mutation UI / CSRF meta / inline JS が **出ない**（既存 read-only
    が不変）。
  - mutation 指定 → CSRF meta（escape 済み）/ bearer 入力 / `X-CSRF-Token` /
    `Authorization: Bearer` / 各 POST path（review/cleanup/pr/rerun/backlog）/
    confirm() / dry-run が HTML に含まれる。
  - XSS: csrfToken / run id / backlog id が escape される。
- `tests/integration/dashboard-server-skeleton.test.ts` 拡張:
  - GET `/` mutationEnabled OFF → mutation UI 無し。ON → CSRF meta + mutation UI あり。
  - 既存の CSRF/bearer enforcement テスト（POST は token 必須）は不変。
- フルスイート + typecheck 緑。

## close 条件（GOAL.md Phase 4）

- [ ] フルスイート + typecheck 緑、回帰なし
- [ ] 未解決 P0 ゼロ
- [ ] mutation UI が `--enable-mutation` OFF 時に出ない / CSRF・bearer を要求する
      ことのテスト
- [ ] `docs/specs/dashboard.md` / `overview.md`（mutation UI 未提供の記述）を更新
