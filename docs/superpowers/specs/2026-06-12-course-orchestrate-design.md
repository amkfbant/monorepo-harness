# Design: 自律 `course orchestrate`（SP-2）

Status: brainstorm 承認済み — spec self-review → user review → writing-plans へ。
Date: 2026-06-12.

## Problem

SP-1 で `course → phase → hitch` の DB roadmap 層（`courses` / `phases` /
`phase_hitches` ＋ `rollupCourse`）が main にマージされた。phase ↔ hitch の link は
**manual**（`phase.link_hitch`）で、roadmap の前進は operator が hitch を 1 つずつ
`hitch orchestrate` で駆動する手作業に依存する。

SP-2 は SP-1 のモデルの上に **drive-only の bounded driver** を 1 階層上に載せ、
「link 済み hitch を phase tree 順に駆動し、phase status を機械的に advance し、
結果を報告する」ところまでを自律化する。これは foundation の第 3 サブプロジェクト
（SP-0 = goal→hitch rename、SP-1 = roadmap 層、いずれもマージ済み）。

## Settled decisions（brainstorm — user 承認済みの 4 方向 + Fable レビューの 6 修正）

ユーザーが選んだ 4 つの方向性（すべて「推奨」）を Fable-5 が実コードを `file:line`
で検証してレビューし、方向は維持しつつ 6 点を修正した。本 spec はその修正版を採る。

**4 方向（維持）**:
1. **Drive-only**: 既に link 済みの hitch のみを駆動。auto-spawn しない（spawn は
   後続増分に defer）。
2. **phase status は `in_progress` まで**: driver が自動で書く状態遷移は
   `pending → in_progress` のみ。close は書かない（operator）。
3. **1 pass / 冪等再開**: 1 回の呼び出しで phase tree を 1 回走査して return。再呼び
   出しで live rollup から再開。
4. **常に `stopAtCloseReady`（PR なし）**: CLI も MCP も配下 hitch を
   `stopAtCloseReady: true` で駆動し、PR を開かない。

**Fable レビューの 6 修正（必須）**:
1. **`needs_link` は leaf 限定・報告のみ・続行**。`rollup.ts` の walk は pre-order で
   親が先（大 phase は hitch を持たず子が持つのが通常形）。「未 link で即 hard stop」
   だとほぼ全 course が最初の親ノードで停止する。未 link は危険ではなく planning の
   隙間なので、止めても fail-closed 保護は増えない。leaf（子ゼロ）かつ actionable
   かつ hitch ゼロのときだけ `needs_link` outcome を記録し、**pass は続行**する。
2. **phase write を CAS 化**。現 `PhaseRepository.setStatus` は blind UPDATE
   （`src/roadmap/phase-repository.ts:82-87`）で、operator の
   `phase update --status blocked` と driver の `in_progress` が競合すると後勝ちで
   operator の制限を上書きする（非対称原則の逆転）。`transitionStatus(phaseId,
   from: PhaseStatus[], to)` を新設し、`pending → in_progress` を **CAS でのみ**書く。
3. **course-pass lease ＋ active ガード**。同一 course への並行 pass / 手動 hitch
   orchestrate と domain lock が衝突すると orchestrator の fail-closed catch が
   **偽 escalation** を記録する（`src/hitch/orchestrator.ts:123-148`）。pass 開始時に
   `domain_locks` を `course-orchestrate:<courseId>` の domainKey で取得（schema 変更
   不要）。busy なら即 refuse。`course.status !== "active"` も即 refuse。
4. **hard stop は「driver 例外 / budget 枯渇 / not-active・lease busy」のみ**。
   escalation は **subtree 隔離**で扱う。phase 間依存は data model に無い
   （`docs/specs/roadmap.md` の「loosely linked / ordered planning nodes」）ため、
   「1 つ詰まると後続全停止」は依存意味論の発明。escalation した hitch を持つ phase の
   **top-level subtree の残りを skip し、次の top-level subtree から続行**する。
5. **drivability 述語を `allowedByConvergence` に一本化**。独自述語は MCP per-hitch
   gate（`src/hitch/mutation-gate.ts:90-101`）と判定がズレる。course dispatch は
   `allowedByConvergence("hitch.orchestrate", convergence)` を再利用する。
6. **rollup に派生 `readyToClose` 追加**。stored status にはせず、live
   `ConvergenceService.evaluate`（read-only）から導出する。`course status` で常時
   可視化し見落としを防ぐ。stale になりうる `latestDecision` には依存しない。

## アーキテクチャ（ファイル分割・責務）

```
src/roadmap/
  orchestrator-types.ts      型のみ: PhaseAction / PhaseOutcome /
                             CourseOrchestrationResult / CourseStopReason
  orchestrate-dispatch.ts    純粋関数 decideCoursePhaseAction（DB 非依存・全分岐 unit）
  ready-to-close.ts          派生: derivePhaseReadiness（live convergence → readyToClose）
  rollup.ts                  [変更] PhaseRollup に readyToClose: boolean を追加
  phase-repository.ts        [変更] transitionStatus(phaseId, from[], to): boolean（CAS）
  course-orchestrator.ts     CourseOrchestrator: walk / lease / budget / CAS write /
                             HitchOrchestrator 起動（DI）
src/cli/course.ts            [変更] course orchestrate subcommand
src/mcp/tools/course-tools.ts [変更] harness.course.orchestrate（guarded mutation）
src/mcp/registry/tool-registry.ts [変更] 登録
docs/specs/roadmap.md        [変更] SP-2 節 ＋ 旧 SP-2 文言（spawn 含み）を増分計画へ修正
docs/specs/cli.md / mcp.md   [変更]
CLAUDE.md                    [変更] ポインタ
```

各 unit は単一責務: dispatch は判定のみ、ready-to-close は派生のみ、orchestrator は
実行・lease・budget のみ。hitch の駆動自体は既存 `HitchOrchestrator` ＋
`createOrchestratorRunners`（**publisher なし** = PR を開かない構成）に完全委譲する。

## per-phase 決定論 dispatch（確定版）

`decideCoursePhaseAction(input) → PhaseAction`。入力は phase（`declaredStatus` /
`hitchIds` / `isLeaf`）と、各 linked hitch の **live** `HitchConvergenceResult`
（`ConvergenceService.evaluate` — read-only）のみ。LLM 出力は入力にしない。

1. `declaredStatus === "closed"` → `skip_closed`
2. `declaredStatus === "blocked"` → `skip_blocked`（blocker として報告。auto-unblock
   しない）
3. `hitchIds.length === 0`:
   - 子あり（container）→ `container`（自身は no-op、子へ降りる）
   - leaf → `needs_link`（**報告のみ・続行**）
4. linked hitch（`hitchIdsFor` の決定論順）ごとに分類:
   - decision ∈ {escalate, diverging, budget_exhausted, needs_classification}
     → `blocked_hitch`（hitchId ＋ decision 付き）→ **subtree 隔離発動**
   - `allowedByConvergence("hitch.orchestrate", convergence) === true` → drive 対象
   - close_ready / closed / cancelled → ready 集計
5. drive 対象 ≥ 1 → `drive`（対象 hitchId 列）
6. 全 linked hitch が close_ready/closed ∧ 独立 SQL 集計の derived open P0/P1 = 0
   → `ready_to_close`（報告のみ）
7. 上記以外（drive 不可だが ready でもない）→ `report_only`

`needs_classification` の hitch は MCP entry gate で deny される（loop 中の自律
classify とは別。`src/hitch/orchestrator.ts:76-87` は loop 中のみ）。course driver は
**MCP の entry 意味論に合わせ**、entry 時点 needs_classification は drive せず
escalation 系として報告する。

## 実行ループ（CourseOrchestrator.run）

```
1. course を require、status !== "active" → 即 error（course_not_active）
2. domain_locks に lease 取得: domainKey = `course-orchestrate:<courseId>`。busy → 即 error
3. rollupCourse 実行（tree 不整合は throw を継承して abort）
4. tree pre-order walk。top-level subtree ごとに:
   a. 各 phase: live convergence を評価 → decideCoursePhaseAction
   b. action === drive:
      - transitionStatus(phaseId, ["pending"], "in_progress")（CAS、失敗→再読、
        blocked/closed なら skip）
      - 対象 hitch を順に HitchOrchestrator.run({maxSteps: maxStepsPerHitch,
        stopAtCloseReady: true, createdBy: "course-orchestrate:<courseId>"})
        ※runners は publisher なしで構築
      - 各 drive 前: budget 残量チェック（drivenHitches < maxDrivenHitches）と
        phase declared status 再読（途中で blocked/closed になっていたら残りを中止）
      - drive 結果が escalated → blocked_hitch outcome → この subtree の残りを
        blocked_subtree で skip、次の top-level subtree へ
   c. budget 枯渇 → stopReason = budget_exhausted、残り phase を not_driven で記録して return
5. 走査完了 → stopReason = completed
6. finally: lease release。driver 例外は op row を failOperation して再 throw（fail-closed abort）
```

repo 解決は per-hitch に `prepareProjectRun(projectId, domain)`（MCP `hitch.orchestrate`
と同方式、`src/mcp/tools/mutation-tools.ts:479-494`。client 供給 path を受けない安全
境界を CLI でも踏襲）。projectId/domain が null の hitch は drive せず
`context_unresolved` outcome（fail-closed、続行）。

## 停止 / escalation 条件

- **pass 全体の停止**: `completed` / `budget_exhausted` / 開始前 refuse
  （`course_not_active`・lease busy）/ driver 例外（abort・fail-closed）。
- **subtree 隔離**（pass は止めない）: `blocked_hitch`（escalate/diverging/
  budget_exhausted/needs_classification、runner 例外由来の escalated 含む）→ 当該
  top-level subtree の残りを skip、次の subtree へ続行。
- **報告のみ（止めない）**: `needs_link`（leaf）/ `ready_to_close` / `skip_blocked`
  / `context_unresolved`。

## 戻り値

```typescript
interface CourseOrchestrationResult {
  courseId: string;
  stopReason: "completed" | "budget_exhausted";
  phaseOutcomes: PhaseOutcome[];   // phaseId, action, drivenHitches, blockedHitch?, readyToClose?
  drivenHitches: { hitchId: string; outcome: OrchestrationOutcome; stepCount: number }[];
  rollupAfter: CourseRollup;        // pass 後の live rollup（readyToClose 付き）
  followUps: string[];              // operator 向け: ready hitch の `hitch orchestrate …`
                                    //   コマンド列、needs_link 一覧
}
```

## Budget（course 単位）

コストの実体は codex 実行（≈ orchestrator step）。phase 単位 budget は phase 数に比例
して総コストが無制限になるため **course 単位**にする。2 ノブ:

- `maxDrivenHitches`（course 単位、default 3、clamp ≤ 10）— **drive を開始した hitch
  数**でカウント（visited ではない）。
- `maxStepsPerHitch`（per-hitch、default 20、clamp ≤ 50 — MCP 既存 clamp
  `src/mcp/tools/mutation-tools.ts:454-469` と一致）。

総 step 上限は積で bounded。枯渇時 `stopReason = budget_exhausted`、残り phase は
`not_driven` で記録（何が残ったか可視）。

## CLI / MCP surface

**CLI**: `harness course orchestrate <course-id> [--max-driven-hitches <n>=3]
[--max-steps-per-hitch <n>=20] [--dry-run] [--json]`
- `--dry-run`: dispatch（純関数）の結果のみ表示、write・lease・drive なし。
- exit 0 = completed、1 = user-fixable（not active / lease busy / budget_exhausted）、
  2 = driver 例外。
- pass 単位で operation row（type=`course.orchestrate`、result に phaseOutcomes 要約）を記録。

**MCP**: `harness.course.orchestrate`（**guarded mutation**、operation key
`course.orchestrate`）
- args: `courseId, maxDrivenHitches?, maxStepsPerHitch?, idempotencyKey, actorNote?`
  （clamp: ≤ 10 / ≤ 50）。
- `ensureProjectVisible` を course の `project_id` で事前チェック（course-tools 既存
  パターン）。null-project course は restricted client に不可視。
- per-hitch の gate は drive 直前の `assertHitchCanStartMutation(…, "hitch.orchestrate")`
  で担保（dispatch 述語と同一関数なので二重定義なし）。
- `confirmation_required` は **不要**（PR を開かず close を書かない — `hitch.orchestrate`
  前例と同じ理由付け）。PR / close は引き続き operator の out-of-band 操作。

## Schema 要否

**migration ゼロ。** SP-2 は schema 追加なしで成立する。

- **監査**: MCP は `runMcpOperation` が operation row ＋ idempotency ledger ＋
  mutation budget を既に記録。CLI は `startOperation` / `succeedOperation` 直書きの
  前例（copilot-review: `src/hitch/orchestrator-runners.ts:596-622`、merge: 同 747-786）に
  ならい pass 単位で 1 op row を書く。
- **lineage**: `createdBy = "course-orchestrate:<courseId>"`（MCP は
  `mcp:<client>:course-orchestrate:<courseId>`）を HitchOrchestrator に渡せば、
  `hitch_convergence_decisions` / attempts に course 由来が残りクエリ可能。
- **排他**: course-pass lease は `domain_locks` 再利用。
- durable な `course_orchestration_runs` テーブルは consumer（dashboard 等）出現まで
  defer（YAGNI、future-features.md に記録）。

## エラー処理

- HitchOrchestrator 内の runner 失敗は既に clean な escalated 結果に変換される
  （`src/hitch/orchestrator.ts:62-64, 123-148`）→ blocked_hitch / subtree 隔離として吸収。
- orchestrator の**外**の例外（prepareProjectRun・DB・rollup throw）→ pass abort ＋
  failOperation ＋ 再 throw。
- lease は finally で必ず release（abort 時も）。
- CAS 失敗は例外ではなく「再読 → skip」の正常パス。

## 安全境界マッピング（不可侵）

| 境界 | 担保 |
|---|---|
| policy 検証は事後 git diff | 不変 — run 実行は既存 hitch 層をそのまま使う。course 層は run に触れない |
| LLM 出力を状態遷移の根拠にしない | dispatch 入力は SQL 集計 ＋ 決定論 convergence のみ。phase write は driver の dispatch 事実が根拠 |
| 状態遷移は harness のみ | phase write は CAS で harness のみ。hitch 遷移は既存 orchestrator/convergence-status のまま |
| MCP confirmation 迂回なし | PR/close をやらないので confirmation 対象操作が発生しない（`hitch.orchestrate` 前例と同等） |
| fail-closed | driver 例外で abort、lease busy で refuse、tree 不整合 throw 継承。fail-open 方向（phase close・PR・spawn）は一切書かない |

## テスト戦略（TDD）

`createFakeCodexRunner` / fake OrchestratorRunners を流用。

1. **unit — dispatch**: 全分岐（closed/blocked/container/needs_link-leaf/blocked_hitch
   各 decision/drive/ready/混在 hitch）。純関数なので fixture のみ。
2. **unit — ready-to-close 派生**: live evaluate ベース、stale `latestDecision` に依存
   しないことの回帰テスト。
3. **unit — transitionStatus CAS**: pending→in_progress 成功 / blocked からの遷移拒否 /
   並行 2 接続で lost-update が起きないこと。
4. **integration — orchestrator**: fake runners で「2 top-level subtree、片方
   escalation → 隔離して他方前進」「budget 枯渇で not_driven 記録」「再 pass 冪等
   （in_progress 維持・close_ready skip）」「paused course refuse」「lease busy refuse」。
5. **CLI/MCP surface**: `--dry-run` の無副作用、exit code、MCP clamp・visibility・
   idempotency replay。
6. サブ Phase 単位で関連テスト ＋ typecheck 緑、増分マージ前にフルスイート。

## Out of scope（future-features.md / 後続増分へ）

- phase → hitch **auto-spawn**（`needs_link` outcome が接合点）。
- course レベル PR 自動化（`--open-prs`）・phase auto-close（fail-open 方向は operator
  のみ、の原則どおり）。
- hitch の**並列** drive（domain lock との調停が要る）。
- `course_orchestration_runs` durable テーブル / dashboard 統合。
- phase 間依存エッジ（順序ブロッキングをやるならまず schema に依存を入れてから）。

## 実装規律

- コーディングは **`codex exec -m gpt-5.5 -c model_reasoning_effort="high"`** に委譲
  （TDD）。Claude 側は orchestration・検証・コミット・レビュー triage。
- レビュー: タスク毎 Opus サブエージェント ＋ 大 Phase 最終 Fable-5 ＋ codex
  （`-m gpt-5.5 -c model_reasoning_effort="xhigh" -s read-only`）。codex App の PR
  レビューも併せて反映。
- spec 駆動: `src/` / 動作が変わったら対応する `docs/specs/*` を同じコミットで更新。
- ブランチ `feat/course-orchestrate`。サブ Phase = 関連テスト ＋ typecheck 緑、
  大 Phase = フルスイート ＋ typecheck 緑。
