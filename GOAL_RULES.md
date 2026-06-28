# GOAL_RULES.md — hitch モード実行ルール

> **roadmap（何を作るか）は DB の `course → phase`（SP-1/SP-2）が正本**になり、旧
> markdown roadmap `GOAL.md` は廃止した。本ファイル（どう作るか＝リトライ/レビュー/
> close 条件/安全境界）は **DB に移さず docs/prompt-context として残す正本**（SP-1 設計）。
> 「goal モード」は **hitch モード**、`harness goal` は `harness hitch` に改名済み
> （SP-0、`docs/specs/hitch-convergence.md`）。

このリポジトリを **hitch モード**（`harness hitch` 系）で自律実装させる際の実行
ルール。作業は **大 Phase**（feature 単位）と、その下の **サブ Phase**（1〜数コミット
規模の作業単位）に分割される前提とする（roadmap の正本は DB の course/phase。
`harness course status` 等で読む）。本ファイルはその分割をどう進め、どこでレビューし、
何をもって完了とみなすかを定める。

> 本ルールは [`/Users/kn/.claude/CLAUDE.md`](file:///Users/kn/.claude/CLAUDE.md)
> 配下のグローバル規約（immutability / 小ファイル / Conventional Commits /
> TDD / 80% カバレッジ / セキュリティチェック）を前提とし、それを hitch モード
> 向けに具体化したもの。グローバル規約と矛盾する場合はグローバル規約が優先。

---

## 0. 用語

- **大 Phase** — DB roadmap の course のトップレベル phase。1 機能（例: auto-merge、
  Copilot review 連携）に対応。feature branch 1 本 ＝ 大 Phase 1 つ。
- **サブ Phase** — 大 Phase を構成する作業単位。1〜数コミットで完結し、関連
  テストと typecheck が緑になる粒度。
- **codex レビュー** — 外部 LLM による差分レビュー。**必ず `harness codex exec` 透過ラッパ
  経由で起動し、`--harness-label` で review 種別を、適用可能な `--harness-hitch-id` /
  `--harness-course-id` で usage を紐付ける**（usage の READ 経路は #403）。`-s read-only` ＋
  stdin クローズ `< /dev/null` で hang 回避。正本は [`CLAUDE.md`](./CLAUDE.md):

  ```
  # course 駆動下の hitch レビュー（label + 実在する ID を併記）
  harness codex exec --harness-label=hitch-review --harness-hitch-id=<hitchId> --harness-course-id=<courseId> \
    -- -m gpt-5.5 -c model_reasoning_effort="xhigh" -s read-only -o <out> "<prompt>" < /dev/null
  ```

  **付ける ID は実在するものだけ**: hitch 単体運用（course 無し）なら `--harness-hitch-id` のみ、
  course 駆動下の hitch なら両方。**course id を捏造しない**（course-level 集計が壊れる）。
  ⚠ wrapper は省略したフラグを env（`HARNESS_COURSE_ID` / `HARNESS_HITCH_ID` 等）で補完する
  （`src/codex/external-exec.ts`）ので、hitch 単体運用で環境に course が残る場合は
  **`--harness-course-id=`（空値）で明示クリア**（または clean env）し、stale な course link の
  混入を防ぐ。
  hitch / course 文脈の無い単発 PR レビューは ID を省略し `--harness-label=pr-review` のみ。
  **`--harness-label` は常に付ける**（省略時 `external` になり review が他の外部呼び出しと
  混ざる）。`--` の前が wrapper フラグ（`=` 形式の単一トークンのみ認識）、後が codex への
  verbatim 引数。

- **finding** — レビューが挙げた指摘。下記 **B** の P0〜P3 で分類する。

---

## A. レビューのリトライと続行判断（最重要）

レビューは指摘ゼロになるまで修正→再レビューを繰り返す。ただしリトライには上限が
あり、上限到達時の挙動は **未解決 P0 の有無**で決まる。

- **サブ Phase レビュー**: リトライ **最大 3 回**。
- **大 Phase レビュー**: リトライ **最大 5 回**。

### 上限到達時（修正版ルール）

1. **未解決 P0 が 1 件でも残っていれば → 停止してエスカレーション。**
   人間の判断を仰ぐまで先に進まない。hitch の状態は `escalated` に倒す。
2. **未解決 P0 がゼロなら → 続行してよい。** 残った P1/P2/P3 は下記 **F** に
   従い backlog / follow-up に積み、スコープは広げない。

> 「続行」は P1 以下を無視してよいという意味ではない。リトライ内で直せる P1 は
> 直す。上限に達してなお残った P1 以下のみ follow-up に送る。

---

## B. finding の分類

レビューの各 finding を必ず次の 4 段階に分類する。

| レベル | 意味 | 対応 |
|--------|------|------|
| **P0** | 安全境界違反・データ破壊・状態破綻・セキュリティ・致命バグ | **修正必須。** 未解決なら close もリトライ続行も不可。 |
| **P1** | 仕様未達・回帰・明確なバグ | **修正必須**（リトライ枠内で直す）。 |
| **P2** | 設計改善・可読性・軽微な不整合 | 判断。直せるなら直す。defer 可。 |
| **P3** | nit・好み・将来検討 | 判断。原則 defer。 |

分類は **harness 側 / 実装者**が行う。LLM の自己申告（severity）を鵜呑みにせず、
安全境界に触れる指摘は迷ったら P0 に倒す（fail-closed）。

---

## C. close 条件

サブ Phase / 大 Phase を「完了」とみなす条件。**全て満たすまで close しない。**

- [ ] 対象スコープのテストが緑（サブ＝関連テスト、大＝フルスイート。下記 **D**）
- [ ] `npm run typecheck` が緑
- [ ] **未解決の P0 がゼロ**
- [ ] 関連ドキュメント（`docs/specs/*` / `README.md` / spec / plan）を更新済み
- [ ] （大 Phase のみ）feature branch が **GitHub Actions CI 緑 ＋ PR bot レビュー反映** →
      main へマージ済み（下記 **E**）

---

## D. テスト粒度（回帰禁止）

- **サブ Phase**: 変更に関連するテスト＋ `npm run typecheck`。TDD（RED→GREEN→
  REFACTOR）で進め、新規挙動には必ず先にテストを書く。
- **大 Phase**: フルスイート `npm test`（`vitest run`）＋ `npm run typecheck`。
- **回帰は許容しない。** 既存の緑テストを赤にする変更は close 不可。テストを
  弱める・skip する形での「緑化」は禁止（テストが間違っている明確な根拠がある
  場合のみ、根拠を commit message と REVIEW_NOTES に記して修正する）。

> CI / 実機の制約で一部テストが実行不能な場合（例: native binding 不在）は、
> その事実・理由・スキップ範囲を明示的に記録する（黙ってスキップしない）。

---

## E. ブランチ / マージ運用

- **大 Phase 単位で feature branch** を切る（`feat/<phase-slug>` 等）。
- サブ Phase（または小粒度の変更）ごとに **commit**。Conventional Commits 形式
  （`feat:` / `fix:` / `refactor:` / `test:` / `docs:` / `chore:`）。
- commit 前に必ず `npm run typecheck`。
- 大 Phase 完了時に **push → GitHub Actions CI green → main へマージ**。CI（`ci.yml`:
  node 20/24 matrix で `npm ci` → typecheck → build → `npm test` フルスイート）が **赤のまま
  main へは入れない**（必須 gate。docs/md のみの変更は `paths-ignore` で skip される）。
- **PR レビューは二段**: ① merge 前に **`harness codex exec` で差分レビュー**（§0 の起動形・§A のリトライ上限・finding
  分類・未解決 P0 ゼロ gate）。② PR を上げたら **PR 上の bot レビュー（codex App
  `chatgpt-codex-connector[bot]` / Copilot）の受け入れ指摘も反映**してから merge（P0/P1 必須・
  P2 は判断）。codex App reaction の意味論: **👀=レビュー中 / 👍=指摘なし / inline comment=指摘あり**。
  PR 投稿後 3 分経っても codex App の reaction が付かない場合は、PR に `@codex review <id>`
  形式の追加コメントを投げてレビューを明示的に起動する（`<id>` は当該 PR / run を識別できる
  短い値）。
- spec 駆動: 大 Phase 着手前に spec / plan を用意し、実装はそれに紐づける。

---

## F. スコープ管理

- レビューや実装中に見つかった **スコープ外の finding は backlog / follow-up**
  に積む（`docs/future-features.md` や issue / TODO）。その場で直さない。
- **スコープを勝手に広げない。** 「ついでに直す」「while I'm here」リファクタは
  禁止。大 Phase の目的に直接資する変更のみ行う。

---

## G. 安全境界（不可侵）

harness の安全設計はいかなる hitch 実装でも侵してはならない。

- **policy 検証は事後 `git diff` ベース**で行う設計を維持する。検証を緩める／
  バイパスする変更は不可。
- **LLM の出力を信用しない。** severity・「修正した」等の自己申告を状態遷移の
  根拠にしない。判定は決定論的な harness 側ロジックで行う。
- **状態遷移は harness のみが行う。** hitch / run / finding のライフサイクルを
  LLM やレビュー出力が直接書き換えることを許さない。
- fail-closed: 判断に迷う安全関連事項は、必ず安全側（停止・エスカレーション）に
  倒す。

### G-1. 合議制（jury）の provenance footprint と提案／決定の物理分離（#230）

合議制 classification jury（issue #230）など **LLM 提案を入力とする決定論ゲート**を
実装・拡張する際は、次の 2 つの不変を守る。安全境界 §G の具体化であり、LLM 出力が
状態遷移の根拠にならないことを監査可能にするための規律。

- **provenance footprint（監査行のメタ列）**: jury 監査入力表
  （`jury_classification_proposals` / `jury_classification_refutations` /
  `jury_severity_audits`）の各行には、その提案を **誰が・どの実行で・どの prompt から**
  生成したかを追える footprint 列を持たせる。**3 表共通**:
  `run_id` / `hitch_id` / `finding_id` / `model` / `prompt_sha256`
  （NOT NULL・business-key の一部） / `usage_kind` / `usage_seq` / `created_at`。
  **2 つの分類表のみ**（`jury_classification_proposals` /
  `jury_classification_refutations`）はさらに `reviewer_id`（例 `jury-<lens>` /
  `jury-refuter`） / `prompt_provenance_json` / `audit_dir_path` を持つ。
  `jury_severity_audits` は reviewer 単位でなく finding 単位の advisory 集計のため
  `reviewer_id` / `prompt_provenance_json` / `audit_dir_path` を持たず、3 lens の
  severity 票は `jury_votes_json` に格納する。
  `prompt_sha256` は `(kind, finding, lens/role, round)` の決定論 digest で、
  `deliberation_id` と併せて retry を冪等化する（同一 deliberation は dedup、別
  deliberation は別行）。新しい監査行・列を足すときも、この footprint を欠損させない
  （provenance を辿れない LLM 出力を audit に残さない）。`model` /
  `prompt_provenance_json` / `usage_kind` / `usage_seq` は現状 nullable で writer が
  常時は埋めないが、**列は予約済み**であり、将来 writer がトークン計上や prompt 系譜を
  記録する際の正規の置き場とする（別表を作らない）。

- **提案（proposal）と決定（decision）の物理分離**: LLM 由来の出力は
  **append-only の入力表にだけ**書く（上記 3 表）。`scope` / `severity` /
  `lifecycle` 等の **決定**は、決定論ゲート（`aggregateDeliberation` /
  classify runner Phase 3）の出力にのみ反映する（`hitch_findings` の
  `classifyFinding`・`hitch_convergence_decisions` の packet）。LLM の自己申告
  （「修正した」「severity は P0」等）が決定表へ直接流れる経路を作らない。
  入力表の行が増えても、それ自体は finding の scope/severity/status を 1 ビットも
  動かさない（doctor は両者の整合を**事後監査**で報告するだけで自動修復しない）。

---

## H. 開発規律

- **TDD**: RED（失敗するテスト）→ GREEN（最小実装）→ REFACTOR。テストを書く前に
  production コードを書かない。
- **Conventional Commits** 形式でコミット。
- **commit 前に `npm run typecheck`。**
- immutability・適切なエラーハンドリングなどグローバル規約を遵守。

### H-1. cohesion-first リファクタ規約（#125 RP1-RP5）

探索性 / 局所的簡潔性 / 常時コンテキストが薄い を理念に、行数は cohesion の proxy
として扱う（行数 target を機械目的にしない）。

- **RP1（薄い always-on context）**: 毎セッション自動ロードされる `CLAUDE.md` のみが
  真の always-on コスト。分量は char/token で測り、session 開始時に不要な詳細は
  on-demand 層（`GOAL_RULES.md` / `docs/`）へ relocate する（分割でなく移動）。
  `tests/meta/context-budget.test.ts` が ratchet で機械監視する。
- **RP2（cohesion-first + 800 HARD cap）**: 分割は cohesion（1 ファイル＝1 責務・
  1 read-order）で判断。**800 行は HARD cap**（超過は分割必須）。`file-size.test.ts`
  が grandfather ratchet で強制（既存 800 超＝現サイズ baseline・縮小のみ／新規＝
  800 以下／schema.ts・tool-registry.ts＝append-only 台帳の構造的恒久例外）。
  「小さすぎる/低凝集な分割を避ける」も同格の規律（過剰分割は探索性を下げる）。
- **RP3（関数粒度）**: 1 関数＝1 論理単位。上限 80 行を超えたら extract-method を
  検討（soft・機械 gate にしない）。下限は設けない（5-20 行の純 helper は健全）。
  register*/dispatcher 等の container は最大 inner callback で測る。
- **RP4（コメント）**: 非自明コードのコメントは {何の問題/脅威を防ぐか・どの不変条件が
  成立すべきか・なぜ非自明な選択をしたか・変えると何が壊れるか・編集前にどの doc を
  読むか} の1つに答える。behavior の再記述は禁止（`docs/specs` が正本）。密度を品質の
  proxy にしない。
- **RP5（大ドメイン README）**: 命名で navigate しきれない大ドメインに nav-map README
  （ファイル→責務 + entrypoint + `docs/specs` への link）を置く。小 dir には置かない
  （stub の rot を生む）。frozen-core dir は §G への STOP beacon にする。

enforcement の現実: CI は billing-blocked ゆえ meta-test は local soft gate、唯一の
実 hard gate は PR 毎の codex xhigh レビュー（`harness codex exec` 経由）。grandfather/budget の baseline を上げる
変更は PR で明示的に正当化する（silent な肥大化を防ぐ）。

---

## I. サブエージェント運用（Claude 側・軽量ポリシー）

hitch を駆動する Claude が使うサブエージェント（`Agent` ツール）の方針。**ハーネス
内部の codex coder / reviewer agent とは別層**であり、混同しない。原則は「探索に
活用し、レビューの正本は codex に保ち、重複ゲートを作らない」。

- **探索は常用してよい。** 広いコードベース調査・複数箇所の横断把握は
  `Explore` / `general-purpose` サブエージェントに任せ、結論だけ持ち帰る（メイン
  context を汚さない）。独立した調査は**並列**で投げてよい。
- **実装の subagent-driven 化は任意。** 大きい / 独立したサブ Phase は fresh
  subagent per task（superpowers subagent-driven-development）で context を綺麗に
  保てる。軽微な変更に使うのは過剰なので避ける。**実装サブエージェントは並列に
  しない**（同一 worktree で競合するため、逐次）。
- **レビューの正本は codex（重複させない）。** Claude 側の code-reviewer /
  spec-reviewer は使ってよいが、その位置づけは **codex レビューに出す前の自己
  レビュー前段**に限定する。`GOAL_RULES.md` §A の codex サブ/大レビューを置き換え
  たり、二重のレビューゲートにしたりしない。
- **安全境界はサブエージェントでも不変。** サブエージェントも §G を侵さない
  （policy 検証 / 状態遷移 / MCP `confirmation_required` を迂回しない）。read-only
  であるべき調査エージェントに書き込みをさせない。
- **コスト意識。** サブエージェントは token を消費する。タスクに見合うときだけ
  使い、トリビアルな単発編集はメインで直接行う。

---

## J. spec-review 層の運用（#231）

phase spec（`scope` / `closeConditions`）の **起案 → 検証 → 批准 → 整合 enforcement** の運用。
**正本は [`docs/specs/spec-review-layer.md`](./docs/specs/spec-review-layer.md) §5 / §7 / §8**
（設計の正本は `docs/design/proposals/design-231-spec-drafting-review-layer.md`）。ここは
hitch を回す際の **運用差分だけ**を薄く記す（behavior の再記述はしない。詳細はリンク先が正本）。

- **起案は harness の外**（§7）。多エージェントの起案 → 重複排除 → 批判 → 統合（NGT / Delphi、
  `superpowers:dispatching-parallel-agents` 等）は operator 側で行う。harness が所有するのは
  **validate / ratify / persist / spec↔hitch 整合 / runtime drift 診断**のみ。起案フレームワークは
  [`docs/design/consulting-frameworks.md`](./docs/design/consulting-frameworks.md) /
  [`docs/design/deliberation.md`](./docs/design/deliberation.md) のギャップ行を reuse する（新たに著さない）。
- **批准は人間（accountable owner 1 名）**: `harness phase ratify <phase-id> --approved-by <actor>`。
  批准前は提案、批准で canonical。**ratify は spec を編集しない**（committed の `[scope, closeConditions]`
  を hash して `specApproval` に記録するのみ）。spec 自体の編集は事前に
  `phase update --scope-file/--close-file` で行う（§4 validator + spec-gates を通る）。
- **整合 gate は ratify 済 phase のみ**: `phase link-hitch` / `phase start-hitch` は hitch spec を
  **現在の phase spec**（批准時 snapshot ではない）と比較し、**同一または厳格化のみ**許可する。scope
  拡大は `--allow-scope-widen`、required close 条件の削除 / optional 化 / gate 弱化は `--allow-gate-loosen`
  が無ければ reject（より厳しい追加条件は許容）。判定は live な hitch config 更新と **同じ純述語**
  （`isScopeWidening` / `closeConditionsLoosenGate`）を共用する。未 ratify の phase は従来通り自由に
  link/start でき gate は skip（ratify は opt-in）。
- **close-condition kind は auto-verify と ask_human を区別する**（§3）。**kind の正本は実装
  `HITCH_CLOSE_CONDITION_KINDS`（`src/hitch/types.ts`）と [`docs/specs/hitch-convergence.md`](./docs/specs/hitch-convergence.md)**
  で、ここの列挙は網羅ではなく現状のスナップショット（drift し得るので正本を見る）。現状 auto-verify＝
  `command` / `finding_policy` / `review_consensus` / `facet_red_test` / `evidence_attached`（convergence の
  決定論ゲートで充足）、external-evidence（ask_human）＝`manual` / `artifact_exists` / `operation_status` /
  `db_doctor`（外部証拠を記録するまで pending）。**auto 検証意図の条件を ask_human kind に化けさせない**。
  gap → kind 写像は TOTAL・fail-closed で、写像不能 / 曖昧な metric は **REJECT**（沈黙で `manual` に default しない）。
- **severity / LLM 出力は advisory（状態遷移の根拠にしない）**: spec-review でも安全境界 §G と
  footprint 規律 §G-1 がそのまま適用される。LLM の severity 自己申告は決定へ流さず、scope / severity /
  lifecycle の決定は harness の決定論ゲートのみが行う。
- **drift は warning（fail-open にしない）**: 批准後に spec を手編集すると link/start 時に specHash
  drift warning が出る（reject はしない）。convergence は ask_human message に drift を診断する
  （[`docs/specs/hitch-convergence.md`](./docs/specs/hitch-convergence.md)）。

---

## レビューテンプレート

codex レビューに渡すプロンプトの雛形。`<...>` を実値で埋めて
`harness codex exec --harness-label=<種別> [--harness-hitch-id=<id>] [--harness-course-id=<id>] -- -m gpt-5.5 -c model_reasoning_effort="xhigh"`
に渡す（§0 用語「codex レビュー」を正本とし、付ける ID は実在するものだけ・label は常に付ける）。

### サブ Phase 用（差分の簡易レビュー）

```
あなたは monorepo-harness のコードレビュアです。以下はサブ Phase
「<サブ Phase 名>」の差分です。

対象差分: git diff <サブ Phase の base ref>..HEAD

このツールは codex exec 駆動の自律実装ハーネスで、安全設計（事後 git diff に
よる policy 検証 / LLM 出力を信用しない / 状態遷移は harness のみ）が中核です。

次の観点で簡潔にレビューしてください:
- spec / 親 Phase の意図との整合
- TDD: 変更挙動にテストがあるか、テストが本物の挙動を検証しているか
- 回帰: 既存挙動を壊していないか
- 安全境界: policy 検証・状態遷移・LLM 出力の扱いを侵していないか
- 明白なバグ / エラーハンドリング漏れ / mutation（非 immutable）

各指摘を P0 / P1 / P2 / P3 で分類してください:
- P0: 安全境界違反・データ破壊・致命バグ
- P1: 仕様未達・回帰・明確なバグ
- P2: 設計改善・軽微な不整合
- P3: nit・好み

指摘ごとに「ファイル:行 / 内容 / 推奨対応」を 1〜2 行で。指摘が無ければ
「指摘なし」と明記してください。冗長な要約は不要です。
```

### 大 Phase 用（変更点全体のレビュー）

```
あなたは monorepo-harness の上級コードレビュアです。以下は大 Phase
「<大 Phase 名>」全体の差分です。

対象差分: git diff <大 Phase の base ref（前 Phase の close タグ等）>..HEAD
関連 spec: <spec パス>
関連 plan: <plan パス>

このツールは codex exec 駆動の自律実装ハーネスで、安全設計（事後 git diff に
よる policy 検証 / LLM 出力を信用しない / 状態遷移は harness のみ / fail-closed）
が中核です。

次の観点で横断的にレビューしてください:
- spec の網羅: spec の各要件が実装されているか。未達・取りこぼしはないか
- 設計の一貫性: サブ Phase 間で型・命名・抽象が揃っているか。重複や責務漏れ
- 安全境界: policy 検証 / 状態遷移 / LLM 出力の扱いを一切侵していないか
- 回帰: 既存機能・既存テストへの影響
- エラーハンドリング・境界条件・並行性・resumability
- ファイル肥大 / 過度な結合 / mutation などの保守性

各指摘を P0 / P1 / P2 / P3 で分類してください（定義はサブ用と同じ）。
指摘ごとに「ファイル:行 / 内容 / 推奨対応 / 根拠」を簡潔に。P0 は特に
理由を明確に。指摘が無ければ「指摘なし」と明記してください。
```

---

## フロー要約

```
大 Phase 開始
  └ feature branch を切る / spec・plan を用意
  ├ サブ Phase 1
  │   ├ TDD で実装（関連テスト + typecheck 緑）
  │   ├ commit（Conventional Commits, commit 前 typecheck）
  │   └ codex サブレビュー（最大 3 回）
  │       ├ P0 残 → 修正して再レビュー / 上限なら停止+エスカレーション
  │       └ P0 ゼロ → 残 P1↓ は follow-up に積んで次へ
  ├ サブ Phase 2 …（同上）
  └ 大 Phase レビュー（最大 5 回, フルスイート + typecheck 緑が前提）
      ├ P0 残 → 修正して再レビュー / 上限なら停止+エスカレーション
      └ P0 ゼロ → close 条件(C)を満たしたら push → GitHub Actions CI green
                  ＋ PR bot レビュー反映 → main merge
```
