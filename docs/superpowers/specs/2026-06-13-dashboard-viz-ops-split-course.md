# Course: dashboard を可視化主体へ再スコープ + 操作 API 分離（最小計画）

- **course slug（案）**: `dashboard-viz-ops-split`
- **前提**: dev 側で実装（ops checkout は pin・read-only）。本 doc は roadmap
  （DB 正本 course→phase）へ bootstrap する前の設計ドラフト。
- **status**: draft（codex xhigh レビュー r1–r5 反映済み・未解決 P0/P1 ゼロで収束）

## 背景 / 動機

dashboard の構想はプロジェクト最初期に立てられた一体型（read + mutation を 1 サーバに
同居）で、当時から「やりたいこと」が変化した。現状 `dashboard serve --enable-mutation`
は閲覧（read, 状態リスクゼロ）と操作（mutation, guard クリティカル）を 1 サーバに
混ぜており、その結合のため「閲覧するだけでも bearer token 必須」等の歪みが出ている
（`checkAuth` は verb 非依存の入口ゲートで、token 設定時は GET も要求する）。

本 course は **dashboard を可視化主体（read 専用）に再スコープ**し、**harness との
通信（操作 / mutation）を独立した API 面に分離**する。＝以前の議論の (B)。

## ゴール（不変条件）

1. dashboard の **HTTP 面は read / 可視化専用**。workflow 状態遷移を一切持たない。
2. 操作（review/cleanup/pr/rerun/backlog run の **現行 5 POST のみ**）は独立した
   operations API 面に集約。既存 core オペレーション + guard + bearer + CSRF +
   idempotency を **流用**（再発明しない）。
3. **書き込み面は常に 1 つ**。移行中も dashboard と operations の二重 write 面を作らない
   （D2 内で atomic に切替。下記参照）。
4. 安全境界（事後 git diff 検証 / 状態遷移は harness のみ / LLM 自己申告を信用しない /
   MCP `confirmation_required` を迂回しない / fail-closed）は不変。relocation は
   **behavior-preserving**（挙動・ステータスコード同一）であること。

### 「read 専用」の厳密な意味（P2 r1）
- **dashboard serve の HTTP read 面は DB / workflow state を書かない**（`autoImport:false`
  で DB を read-only オープン。`server.ts` の read route 群）。
- `dashboard export` の既定 auto-import は **derived cache（`harness.sqlite`）の refresh**
  であって workflow 状態遷移ではない。この区別を spec に明記する。

## スコープ外（最小化のため明示。別 course で扱う）

- 新しい SPA / チャート可視化フロント本体（フレームワーク導入・ビルド基盤）。
- read API の拡張（pagination / time-series / 集計エンドポイント追加）。
- BFF / セッション cookie 認証 / ネットワーク公開 / TLS。
- **generic operation executor は作らない**。operations API は現行 5 POST の relocation
  に限定し、任意操作を実行する汎用面を新設しない（P1 r1）。
- **`operation confirm/reject` 相当の HTTP endpoint は作らない**。MCP dangerous /
  `requireConfirmation` は従来どおり CLI out-of-band のまま（`harness operation
  confirm/reject`）。operations API はこの確認面の抜け道にならない（P1 r1）。
- これらは「分離と contract 確定」後の follow-up。本 course は **分離のみ**。

## Phase 構成（最小: 3 phase）

### D1 — read contract 棚卸し & 確定（doc のみ・src 挙動変更なし）
- 既存の read route を **個別に列挙**し、可視化フロント向け read contract を確定する。
  `GET /api/*` を一括 freeze せず、endpoint ごとに分類する（P1 r1）。
- 特に `GET /api/operations` / `GET /api/operations/:operationId`（audit ledger の
  read）は **dashboard 側に read-only として残す audit visualization** と位置付ける。
  operations API へ移すのは **write POST のみ**。audit read と write 面の置き場所を
  ここで確定し、D2 で衝突しないようにする（P1 r1）。
- mutation 面（`POST /api/*`, `--enable-mutation`, `render.ts` の inline mutation UI）も
  棚卸しして列挙。
- 不足（pagination / 時系列 / BFF 向け auth など）は follow-up として記録するのみ。
  **ここでは作らない**。
- 成果物: `docs/specs/dashboard.md` への追記は **現状スナップショットの範囲に限定**する
  （現行 read endpoint の個別分類 + 「read 専用の用語定義」のみ）。mutation 撤去や
  分離後の target state を D1 の spec に先書きしない（`docs/specs/*` は現状スナップショット
  であるべきで、未来形を書くと drift する。target state の反映は D2/D3 の同一変更で行う,
  P2 r2）。挙動変更ゼロ。低リスク。

### D2 — operations API 面を behavior-preserving に切り出し（切替は atomic）
- 現行 5 mutation エンドポイント（review/cleanup/pr/rerun/backlog）を dashboard サーバから
  独立した operations API 面（module / CLI entry）へ relocate。
- **同一 commit/phase 内で `dashboard serve --enable-mutation` を fail-fast の migration
  error にする**（旧フラグを残したまま no-op にしない）。これにより D2 完了時点で write
  面はちょうど 1 つ。二重化も silent no-op も作らない（P1 r1）。
- 同一 core ops + guard + bearer + CSRF + Idempotency-Key を流用。挙動・ステータスコードを
  維持（review/cleanup=200、pr/rerun/backlog=202 + `pendingExternalExecutor`、body 1MiB
  cap、route matching、idempotency replay-failure=409 など）。
- CLI: 操作面の入口を新設（案: `harness operations serve` — 説明は "serve mutation HTTP
  API for existing operation requests"。既存 `operations list/show` は audit read として
  明確に分離, P2 r1）。**bearer 必須**で、CSRF token は起動時に一度だけ stdout へ出力
  するか `--csrf-token-env` で受ける（現行 dashboard が HTML meta に埋めていた配布経路を
  operations serve 側へ移す, P2 r2）。
- **この phase が唯一のリスク担持点**。下記 parity matrix を tests で証明できるまで
  close しない。

#### D2 close 条件 — 旧 dashboard write 面の消滅（P1 r2）
relocation の parity だけでなく、**旧面が消えたこと**を証明する:
- 旧 `dashboard serve --enable-mutation` は **token の有無に関わらず listen 前に
  migration error で非 0 終了**する（fail-fast）。
- dashboard の route table に `mutationRoutes()` が **入らない**（5 POST は dashboard 上で
  405）。
- POST を受ける listener は **`operations serve` ただ 1 つ**。
- dashboard HTML に CSRF meta が **残っていない**（D3 の mutation UI 撤去と整合, P2 r2）。

#### D2 close 条件 — endpoint 別 parity matrix（P1 r1 / r2 / r3）
status class だけに畳まず、**5 endpoint それぞれ**について HTTP 層 guard を表で固定する。
**現行挙動の写し（behavior-preserving）であり、新規 hardening を混ぜない**:

dry-run と real は **HTTP status と operation status を別列**で固定する
（`pendingExternalExecutor: !dryRun` のため dry-run と real で op status が異なる, P1 r4）:

| endpoint | real の必須 confirm | 不正 body の期待 | dry-run（HTTP / op） | real（HTTP / op） |
|---|---|---|---|---|
| review | — | 不正 decision enum → 400 | 200 / succeeded | 200 / succeeded |
| cleanup | `confirm:"cleanup"` 必須 | confirm 欠落 → 拒否 | 200 / succeeded | 200 / succeeded |
| pr | `confirm:"create-pr"` 必須 | confirm 欠落 → 拒否 | 202 / succeeded | 202 / pending + `pendingExternalExecutor` |
| rerun | — | invalid runId → 400 | 202 / succeeded | 202 / pending + `pendingExternalExecutor` |
| backlog run | — | **itemId は現行 HTTP 層で未検証**（core へ委譲）。strict validator 追加は follow-up（P1 r3） | 202 / succeeded | 202 / pending + `pendingExternalExecutor` |

> 注（P1 r3）: 完全 parity 優先のため `backlog run` の itemId 検証は現行どおり HTTP 層で
> 行わない（`item-YYYYMMDD-NNN` validator の HTTP 適用は別 course）。pr/rerun/backlog は
> `pendingExternalExecutor: !dryRun` で、**dry-run=202/succeeded・real=202/pending** を
> 既存テスト（`dashboard-server-skeleton.test.ts`）と同値で固定する（P1 r4）。

**idempotency / replay semantics（`runOperation` 中央処理・behavior-preserving, P1 r3）**:
同一 Idempotency-Key の再送に対し prior outcome 別に:
- prior = **succeeded / pending** → 元 endpoint の status を返し `replayed:true`（成功 replay。409 ではない）
- prior = **running** → `409 conflict`
- prior = **failed / cancelled** → `409 idempotency_replayed_failure`

**横断 guard も維持を確認**: auth 未充足 → 401 / CSRF 不一致 → 403 / read-only サーバへの
POST → 405 / body oversize → 413 / operation audit row・event が従来同様に記録 /
`GET /api/operations*`（audit read）の可視性維持。
> 注（P3 r4）: auth gate は method check より先に走るため、`405` は **auth 成功後
> （または localhost no-token）条件で検証**する。token 設定時の未認証 POST は 405 ではなく
> 401 になる。
- 既存 mutation テストは移設（コピー放置ではなく新面へ移す。共有ヘルパ抽出は任意, P2 r1）

### D3 — dashboard を可視化専用化（docs / UI / flag の撤去のみ）
- `render.ts` の inline mutation UI と、dashboard 側の `--enable-mutation` 配線
  （D2 で既に fail-fast 化済み）を **完全撤去**する。D3 は docs / UI / flag 型の削除に
  縮小し、挙動の意味変更は伴わない（P1 r1: 実体の write 面切替は D2 で完了済み）。
- dashboard は純 read（localhost no-token 姿勢が単独で成立）。
- spec を同コミット更新（`docs/specs/dashboard.md` / `cli.md` / `workflow.md`）。
- 旧 `--enable-mutation` 利用者向け migration note（→ `operations serve` へ）を記載。

## 順序 / リスク
- D1（doc）→ D2（atomic 切出し + 旧フラグ fail-fast 化）→ D3（旧 UI/flag の撤去）。
- write 面の切替は **D2 内で atomic**。D3 は撤去のみで操作不能期間も二重面も生まない。
- 回帰禁止。テストを弱める/skip する緑化は禁止。各 phase は関連テスト + typecheck 緑、
  course close はフルスイート + typecheck 緑。

## 未決事項 / 推奨（codex r1 反映）
- operations 面の命名: `harness operations serve` で可。説明を "serve mutation HTTP API
  for existing operation requests" とし、`operations list/show`（audit read）と責務分離。
- `--enable-mutation`: hard remove ではなく **D2 で fail-fast migration error に変更**し、
  D3 で配線/UI を撤去（移行導線を明示）。
- D2 は別プロセス必須ではなく、同プロセスで route mount / listener を分離する実装でも可
  （read 面と write 面の auth 姿勢を独立にできることが要件）。
- parity テストは新面へ移設（共有ヘルパ抽出は任意）。

## governance
- dev クローンで実装、`codex exec -m gpt-5.5 -c model_reasoning_effort="xhigh"` で
  各 phase 差分レビュー（P0/P1 必須修正、大 phase ≤5 リトライ）。
- spec は同コミット更新。本 doc 確定後に roadmap（`harness course`）へ bootstrap。
