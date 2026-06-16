# 実装設計ノート v2 — issue #231「[案C] spec 策定/レビュー層 (As-Is/To-Be + ギャップ → closeConditions)」

> これは実装計画。コードは変更しない。実装は別セッションが dev クローンの origin/main ベース隔離ブランチで TDD(RED→GREEN→REFACTOR)で行う。
> 読んだソースは ops checkout(v0.7.10)で origin/main と同一を確認済み、file:line は実装ブランチでも有効。
> 着手順は **A→B→C に確定**(#231=案C は案A 確定後に着手)。案A(#230)の決定パケット形式は **インターフェイス前提**として扱い、本 issue 単体は案A 無しで ship できる構造にする。

---

## v2 改訂履歴(codex P0/P1 反映)

- **P1-1**(批准済み phase spec が linked hitch に強制されない): §3.5・§3.7(新設)・§4(WI.6a 新設)・§5・§6(R13 を `link-hitch`/`start-hitch` 経路に拡張、R13b 新設)に反映。`linkHitch`/新 `start-hitch` に「phase 批准 spec と hitch spec の **同一/厳格化**チェック」を追加。orchestrator が phase spec を見ない事実(course-orchestrator.ts:534-552)を grounding として明記。
- **P1-2**(`kind=command` の command 必須化が既存規約を壊す): §3.3 HARD error 2・§3.3 分類表・§6 R3 を訂正。hard rule を「`command` 非空、**または** `id` が `allowedCommands` に一意解決できる」に緩和。必須化は撤回(orchestrator-close-check-runner.ts:319-348 の bare-id 解決を尊重)。
- **P1-3**(`createSession` 自体は choke point でない): §2.5・§3.4 を訂正。`HitchRepository.createSession()`(repository.ts:510-511)が `input.scope`/`input.closeConditions` を raw `json()` 保存している事実を明記し、**`createSession()` 内で `parseHitchScope`/`parseHitchCloseConditions` + 新 validator を必ず実行**する設計に変更(CLI/MCP の事前 parse に依存しない真の choke point 化)。
- **P1-4**(MCP `hitch.expand_scope` の raw SQL): §2.5・§3.4・§5・§6 R10b/R16 に反映。`expandHitchScope`(hitch-tools.ts:1010-1014)が `updateSessionConfig` を通らず raw `UPDATE scope_json` する事実を明記。**shared update path(`updateSessionConfig`)に通す**(scope widen gate を継承)を第一選択とし、互換上やむを得ない場合の明示例外には threat model + regression test を必須化。
- **P2-1**(`operation_status` の `metadata.operationId` 必須): §3.3 HARD error 8・§3.3 分類表・§6 R5 に追加。
- **P2-2**(gate 関数の重複/drift): §3.4 を訂正。`isScopeWidening`/`closeConditionsLoosenGate`(repository.ts:1935/2007、現状 private)を **`src/hitch/spec-gates.ts` に抽出**し hitch/phase 両方が同一関数を使う(mirror=duplication を避ける)。WI.4a 新設。
- **P2-3**(db_doctor「永久 stall」は言い過ぎ): §2.4・§3.3・§5 の表現を「自動 runner が無く ask_human に落ちる(operator は `hitch close-check record`/MCP で外部証拠を記録でき、`required:true` の hard error 方針自体は誤分類防止として妥当)」に修正(close-check record は cli/hitch.ts:986、repository.ts insert)。
- **P3-1**(`count` の top-level と `rule.count` の区別): §2.1・§2.3 に明記。top-level `count` は `.strict()`(schemas.ts:65)が reject、`rule.count` は schema を通り `evaluateFindingPolicy`(close-checks.ts:129-150)の whitelist で silent ignore される。
- **P3-2**(`review_state_json` の key 衝突): §3.5 を訂正。既存 docs(roadmap.md:63)が `review_state_json` を「phase-level review facts(hitch convergence でない codex/Fable レビュー)」用としているため、批准記録は **namespaced key `{ specApproval: { ... } }`** に固定。
- **§2.6 grounding 訂正**(人間指示): `docs/design/consulting-frameworks.md`・`docs/design/deliberation.md` は origin/main(実装先)に **実在**(PR #227 / 現 checkout v0.7.10 にも在る)。ギャップ行スキーマ・意思決定マトリクスは「新規に著す」ではなく **既存 docs/design から reuse** に訂正。

---

## 1. 背景と #231 ゴール

epic #228 案C。上流(仕様)の品質を上げる。決定論的 ground truth が無く判断比重が大きい領域(scope/closeConditions の起案)に、NGT/Delphi 型の起案→重複排除→批判→統合と**人間批准**の構造を入れる。現状ハーネスには明示的な spec レビュー層が無く空白地帯。

**着手順序の前提(確定)**: A→B→C。#231(案C)は案A(#230 決定パケット形式)確定後に着手する。案C 本体は案A 無しでも ship 可能だが、決定パケット形式を **インターフェイス前提**として再利用する(§3.6)。

**不可侵の原則(設計全体を貫く)**:
- 成果物(spec)は**人間が批准**し、harness が canonical scope として記録する(委員会は決めない)。
- closeConditions は実在する `HitchCloseConditionKind` のみ。**自動検証 kind と外部証拠待ち kind を区別**し、自動ゲート意図の条件が ask_human kind(`manual`/`artifact_exists`/`operation_status`/`db_doctor`)に化けないこと。
- spec の enforcement(close 判定)は決定論ゲート。**合議は起草のみ**。
- 曖昧合意への spec drift を招かない。迷ったら fail-closed。

---

## 2. 検証済みの現状(file:line — 本設計で全件裏取り済み)

### 2.1 closeConditions kind は厳密に7種・Zod enum で強制
- `src/hitch/types.ts:189-196` — `HitchCloseConditionKind` = `command | finding_policy | manual | operation_status | db_doctor | review_consensus | artifact_exists`(ちょうど7種)。
- `src/hitch/schemas.ts:47-65` — `HitchCloseConditionSchema` が `z.enum([...])`(:50-58)で7種を強制、`.strict()`(:65)で**余剰 top-level field を拒否**。`HitchCloseCondition` の field は `{id, kind, required, description?, command?, rule?, metadata?}`(types.ts:198-206)。
- **`count` の二重性(P3-1 明記)**: **top-level** の `count`(例 `{id, kind, count:0}`)は `.strict()`(schemas.ts:65)が **reject**。一方 `rule` は `z.record(z.unknown())`(schemas.ts:62)なので **`rule.count`(例 `{rule:{count:0}}`)は schema を素通し**、後段 `evaluateFindingPolicy` の whitelist で silent ignore される(下記 2.3)。→ validator で `rule.count` 等を hard error にする根拠はここ。

### 2.2 「自動検証」と「外部証拠待ち」の振り分けは convergence が kind で決定論的に行う
- `src/hitch/convergence.ts:236-265` `requiredPendingCloseCheckRouting()`:
  - `command` + runnable status → `hasRunnableCommand=true`(close-check runner が自動実行)(:247-252)。
  - `review_consensus` → skip(:254)。ask_human に行かない(review runner が consensus 記録で充足)。
  - **それ以外すべて**(`manual` / `artifact_exists` / `operation_status` / `db_doctor`)→ `externalEvidenceLabels` に追加(:255)→ 後段で `ask_human` routing。
- `src/hitch/close-checks.ts:46-91` `evaluateCloseConditions()`:
  - `finding_policy` のみ `evaluateFindingPolicy()`(決定論カウント評価、:67)。
  - **他全 kind** は `evaluateRecordedCheck()`(:69)= DB の recorded check status を読むだけ。評価ロジック無し。

### 2.3 finding_policy は4キーしか honor しない(`rule.count` は無効)
- `src/hitch/close-checks.ts:123-163` `evaluateFindingPolicy()` は `maxOpenInScopeP0/P1/P2/maxOpenUnknownScope` のみ(:129-150、`numberRule` で抽出)。**未知の rule キー(`rule.count` 等)は silent ignore**。→ validator で `rule` を whitelist に絞り `rule.count` 等を **hard error** にする根拠。

### 2.4 db_doctor は runner 未実装(自動 runner が無く ask_human に落ちる)
- `grep -rn "db_doctor" src/` は **schemas.ts:55 と types.ts:194 のみ**。runner / close-check-runner / 実装コードはゼロ。`required:true` の db_doctor は convergence で externalEvidenceLabels(:255)→ ask_human routing に落ちる。
- **訂正(P2-3)**: これは「永久 stall」ではない。**自動 runner が存在しない**だけで、operator は `hitch close-check record`(`src/cli/hitch.ts:986-1014`、repository.ts:1733 付近 insert)/ MCP で**外部証拠を手動記録できる**。ただし「自動ゲートのつもりで作った db_doctor が決定論実行されない」のは誤分類なので、`required:true` の db_doctor を hard error にする方針自体は妥当(§3.3)。

### 2.5 起案・レビュー構造が無い & **fail-open な write path が複数存在(批判で指摘・本設計で確認)**

**hitch 側**:
- CLI 入力: `src/cli/hitch.ts:230-239`(`--scope-file/--close-file`)→ `parseHitchScope`/`parseHitchCloseConditions`(schemas.ts:139-147)で Zod 検証してから create。MCP `hitch.start`: `src/mcp/tools/hitch-tools.ts:318-319` は **args schema 後に `repo.createSession` 直行**(close conditions の二段 parse なし)。
- **`createSession()` 自体は parse/validator choke point ではない(P1-3 訂正)**: `src/hitch/repository.ts:510-511` は `input.scope ?? {}` / `input.closeConditions ?? []` を **そのまま `json()` 保存**。CLI が事前 parse しているから安全に見えるだけで、MCP/将来の caller が未検証値を渡せば素通りする。→ §3.4 で **`createSession()` 内に parse + validator を埋め込み**、真の choke point 化する。
- hitch **update** は guard 有り: `src/hitch/repository.ts:702-741` が `isScopeWidening`(:718)+ `closeConditionsLoosenGate`(:727、定義 :2007)+ `policyLoosensGate`(:736)を強制(`--allow-scope-widen` / `--allow-gate-loosen` 無しでは throw)。
- **MCP `hitch.expand_scope` は update path を迂回(P1-4 実在ホール)**: `src/mcp/tools/hitch-tools.ts:1003-1020` `expandHitchScope()` は `updateSessionConfig` を**通らず** raw `UPDATE hitch_sessions SET scope_json = ...`(:1010-1014)。scope を merge(:1022 `mergeScope`)してから書くため、**`isScopeWidening` gate を一切経由しない**。dangerous tool として confirmation は要る(`src/mcp/registry/tool-registry.ts:1745` `kind:"dangerous"`)が、widen gate は無い。→ §3.4 で shared update path に通す。

**phase 側(guard 無し=fail-open の中核)**:
- `src/cli/course.ts:666-682` `course phase update --scope-file/--close-file` は **raw SQL** `UPDATE phases SET scope_json = ..., close_conditions_json = ...`(:667-682)。**schema 検証なし・loosen gate なし**。
- `src/roadmap/phase-repository.ts:39-71` `add()` は `closeConditions`/`scope` を **`JSON.stringify(...)` でそのまま INSERT**(:66-67)。**schema 検証なし**。
- MCP `phaseAddTool`(`src/mcp/tools/course-tools.ts:422` 付近、`scope?: unknown` / `closeConditions?: unknown`)も同 `PhaseRepository.add()` 経由。
- → **phase の scope/closeConditions write path は、不正 kind / parse 不能 / gate 緩和を素通しで永続化できる実在ホール**。spec レビュー層はこの write barrier を閉じることが安全上の中核。
- `src/roadmap/phase-repository.ts:10,20` phase row は `scope_json` / `close_conditions_json` / **`review_state_json`** の3 JSON カラムを既に持つ(:20 で `parse` 経由 deserialize)。**`review_state_json` は既存カラム** → 人間批准の最小記録に migration 不要で使える(ただし key namespacing 必要、§3.5 / P3-2)。

**phase 批准 spec が linked hitch に強制されない(P1-1 実在ホール)**:
- hitch は単独作成でき(`src/cli/hitch.ts:218` `createSession`)、後から `course phase link-hitch`(`src/cli/course.ts:691-698` → `PhaseRepository.linkHitch`、phase-repository.ts:172-190)で phase に結ぶ。`linkHitch` は **project 一致と double-link しか検証しない**(:174-189)。phase の `scope_json`/`close_conditions_json` と hitch の spec の整合は**一切見ない**。
- course orchestrator は phase spec を読まない: `src/roadmap/course-orchestrator.ts:534-552` `actionForPhase()` は `phases.hitchIdsFor(phase.phaseId)` を取り、**linked hitch の `convergence.evaluate(hitchId)` だけ**で `decideCoursePhaseAction` する。phase の `scope`/`closeConditions` は読まれない。
- 現状 `course phase start-hitch` という command は**存在しない**(`link-hitch`/`unlink-hitch` のみ)。
- → phase を ratify(批准)しても、その批准 spec と無関係な hitch を link して回せてしまう。**批准 spec が enforcement に効かない**。§3.7 で link/start-hitch 経路に同一/厳格化チェックを入れて閉じる。

### 2.6 docs/design/* は実在(grounding 訂正)
- `docs/design/consulting-frameworks.md` / `docs/design/deliberation.md` は **origin/main(実装先)に実在**(PR #227。現 ops checkout v0.7.10 にも在る)。
- ギャップ行スキーマ(asIs/toBe/gap/cause/action/owner/deadline/metric)・意思決定マトリクス構造は **これら既存 docs/design から reuse** する(新規に著すのではない)。v1 の「新規に著す/false premise」記述は撤回。spec-review-layer の docs は既存 framework を案C の文脈(gap→kind 写像 + ratify ceremony)に**具体化・接続**する位置づけ。

---

## 3. 中核設計判断

批判の `recommendedBackbone` を採用。**Backbone = Proposal 3(kind-guard-validator)**: 全 spec write path を repository 層の決定論 validator に通し fail-closed。これに P2(gap→kind 写像/TDD)・P4(人間批准/audit lineage)・P5(runtime drift 診断)・P1(起案 fan-out は harness 外)を graft。

### 3.1 起案ワークフローの所在(decisive)
**NGT/Delphi の多エージェント fan-out(独立起案→重複排除→批判→統合)は harness の外**(operator ツール / `superpowers:dispatching-parallel-agents`)で実行する。**harness が所有するのは validate + ratify + persist + spec/hitch 整合 enforcement のみ**。

理由: (a) CLAUDE.md の bootstrapping 規律「ops ハーネスが driver、未確定 dev コードで自己駆動しない」を守る — 合議(LLM consensus)を harness core に入れない。(b) 起案・批判・投票は決定権が人間にあり、CLI state machine より手順書(ドキュメント)が適切。(c) 出力(spec-candidate YAML)は harness 外の GitHub branch/PR で audit/再実行する。

→ harness 側の実装は「(1)gap→kind 写像の純関数 + (2)closeCondition guard validator + (3)全 write path への validator 接続(fail-closed)+ (4)phase ratify(人間批准の最小記録)+ (5)phase 批准 spec ↔ linked hitch spec の同一/厳格化 enforcement + (6)runtime drift 診断」に絞る。起案の進め方は docs(workflow + テンプレート、既存 docs/design を reuse)で規定。

### 3.2 ギャップ → closeConditions 写像(P2 由来、fail-closed 強化)
ギャップ行 `asIs/toBe/gap/cause/action/owner/deadline/metric`(既存 docs/design スキーマを reuse)の **metric** が close condition の素。純関数 `mapGapMetricToCloseConditionKind(gap, context)` を **TOTAL** にする:

| metric パターン | kind | category |
|---|---|---|
| `command X passes`(policy.allowedCommands に解決) | `command` | auto-verify |
| `finding count threshold`(maxOpen* policy) | `finding_policy` | auto-verify |
| `review decision = approved` | `review_consensus` | auto-verify |
| `file/artifact exists`(path 明示) | `artifact_exists` | external-evidence |
| `operator verified X` | `manual` | external-evidence |
| `external operation status`(operationId 明示) | `operation_status` | external-evidence |
| `DB migration valid`(runner 未実装) | `db_doctor` | external-evidence(自動 runner 無) |
| **写像不能 / 曖昧** | **REJECT** | — |

**fail-closed の核**: 写像不能・曖昧な metric は**沈黙で `manual` に default しない**(それは ask_human 待ちを生む)。**REJECT して clarification を要求**する。実装は `src/hitch/gap-to-kind.ts`(純関数、I/O 無し、testable)。

### 3.3 kind-guard validator(Backbone、決定論・repository 層 choke point)
`src/hitch/spec-validation.ts`(新規)に `validateCloseConditions(conditions, context)` を実装。`HitchCloseConditionSchema`(Zod enum)の**次段**の defense-in-depth。**validator ≠ enforcement**(form check のみ。close 判定は convergence のまま)。

**HARD error(fail-closed、DB write を rollback)**:
1. kind が実在7種外(Zod で既に弾くが念のため二重)。
2. **(P1-2 訂正)** `kind=command` の validator は **context.allowedCommands を resolver へ delay** する。create-session/phase-write 時点で allowedCommands context 無い場合、「形式のみ(TOTAL kind)」をチェックし bare-id 解決は後段 runner(`orchestrator-close-check-runner.ts:319-348`)に委ねる。既存 bare-id fixture 依存と runner 解決ロジックを保全。
   - WI 計画: validator は 2-phase。(a)choke-point phase(create-session/updateSpec)= syntax + kind hard-gate、allow-command 解決スキップ、(b)run-time resolver phase(runner) = allow-commands context 有で一意解決＆ambiguous 検出。
3. `kind=finding_policy` で `rule` キーが `{maxOpenInScopeP0, maxOpenInScopeP1, maxOpenInScopeP2, maxOpenUnknownScope}` 以外を含む(**`rule.count` 等は hard error**。close-checks.ts:129-150 が silent ignore する事実の防御)。各値は非負数。
4. external-evidence kind(`manual`/`artifact_exists`/`operation_status`/`db_doctor`)で `description` が空 → **ADVISORY warning のみ**(既存の valid spec で description 空の fixture 存在)。hard error は撤回。
5. `kind=artifact_exists` で `metadata.path`(対象指定)が無い/曖昧 → **ADVISORY warning のみ**。hard error は撤回。
6. 同一 closeConditions array 内の **duplicate condition id**。
7. **`kind=db_doctor` かつ `required:true`** は、runner 未実装の間は **hard error**(明示的 `--allow-external-evidence` acknowledge が無い限り)。理由: 自動 runner が無いため決定論実行されず、まさに「自動ゲート意図が外部証拠待ちに化ける」失敗。**(P2-3)** これは「永久 stall」ではなく「自動 runner なしで ask_human に落ちる」だが、誤分類防止として hard error は妥当。
8. **(P2-1 追加)** `kind=operation_status` で `metadata.operationId` が無い。`operation_status` も runner 未実装で ask_human group に落ちる(convergence.ts:254 で除外されず external へ)ため、最低限 operationId を必須化して外部証拠記録の宛先を確定させる。

**ADVISORY warning(error にしない、false-positive リスク回避)**:
- description の自然言語 keyword(`npm test passes` / `count >= N` / `run` / `execute`)が auto 意図を示唆するのに kind が external-evidence → **warning のみ**(NL ヒューリスティクスは hard gate にしない)。
- ask_human kind が closeConditions の >50% → advisory(spec が決定論的でない兆候)。
- `review_consensus` で description が曖昧 → advisory。

**kind 分類テーブル**(convergence.ts:236-265 / close-checks.ts:46-91 / orchestrator-close-check-runner.ts:319-348 を line-by-line 写像。これらロジック変更時は本テーブルも要更新 — constraint として GOAL_RULES/docs に明記):

| kind | category | runner/評価 | guard 必須 field(hard error 条件) |
|---|---|---|---|
| command | auto-verify | close-check runner(convergence.ts:248、resolveCommandForCondition) | `command` 非空 **OR** `id` が allowedCommands に一意解決 |
| finding_policy | auto-verify | evaluateFindingPolicy(close-checks.ts:67) | `rule` ⊂ maxOpen* whitelist、非負数 |
| review_consensus | auto-verify | review runner(convergence.ts:254 skip) | (description 推奨/advisory) |
| manual | external-evidence | ask_human(convergence.ts:255) | description 非空 |
| artifact_exists | external-evidence | ask_human | description + metadata.path |
| operation_status | external-evidence | ask_human | description + **metadata.operationId** |
| db_doctor | external-evidence(自動 runner 無) | ask_human(by omission) | required:true は hard error |

### 3.4 全 write path への validator 接続(repository 層 choke point — fail-open ホールを閉じる)
**CLI でも MCP でも各 command に置かず、repository 層の1箇所に置く**ことで両者が継承する(MCP が CLI 検証を迂回する穴を作らない。CLAUDE.md §G の confirmation 迂回禁止と対称)。

**(P2-2)** `isScopeWidening`(repository.ts:1935)・`closeConditionsLoosenGate`(repository.ts:2007)・補助(`arrayFieldWidens`/`targetFilesWiden`/`excludedCategoriesWiden`/`conditionGateFingerprint`)は現状 repository.ts の **private 関数**。phase に mirror すると duplication/drift する。→ **`src/hitch/spec-gates.ts`(新規)に抽出**し、hitch repository と phase repository が**同一 export 関数**を import する(WI.4a)。挙動不変(pure refactor)を R16 で守る。

**(P1-3)** hitch:
- **`HitchRepository.createSession()`(repository.ts:490-523)内で `parseHitchScope`/`parseHitchCloseConditions` + 新 validator を必ず実行**してから INSERT する(現状 :510-511 は raw `json()`)。CLI/MCP の事前 parse に依存せず、`createSession` を真の choke point にする。createSession は新規作成なので loosen gate は不要(空 baseline からは widening が定義できない)。
- `updateSessionConfig()`(repository.ts:702-741)は既に Zod parse 済み → ここに新 validator を追加。gate は抽出後の `spec-gates.ts` を使う。

**(P1-4)** MCP `hitch.expand_scope`:
- `expandHitchScope`(hitch-tools.ts:1003-1020)の raw `UPDATE scope_json`(:1010-1014)を **`updateSessionConfig()` 経由に置換**(merge 後 scope を `updateSessionConfig({scope, reason, allowScopeWiden})` に渡す)。これで `isScopeWidening` gate を継承する。expand は意味上 widen を許す操作なので `allowScopeWiden:true` を渡すのは正当だが、**gate を通った上で渡す**(silent bypass を消す)。
- 互換上 `updateSessionConfig` 経由にできない制約が判明した場合のみ **明示例外**とし、(a) threat model を docs に記載、(b) raw path 専用の regression test(R10b/R16)を追加する。

phase(fail-open を閉じる中核):
- `PhaseRepository` に新 method `updateSpec(input: {phaseId, scope?, closeConditions?, approval?, allowGateLoosen?, allowScopeWiden?, now?})` を追加。内部で `parseHitchScope` + `parseHitchCloseConditions` + 新 validator + `spec-gates.ts` の `closeConditionsLoosenGate`/`isScopeWidening`(hitch と同一関数)を実行してから write。
- `add()`(phase-repository.ts:39-71)も `scope`/`closeConditions` を validator + parse 経由に変更(:66-67 の raw `JSON.stringify` を置換)。
- `course phase update`(course.ts:666-682)の **raw SQL を撤去**し、新 `updateSpec()` に置き換え。
- MCP `phaseAddTool`(course-tools.ts:422 付近)は `PhaseRepository.add()` 経由なので自動的に継承。

### 3.5 人間批准 & roadmap 接続(P4 由来、migration 無しの最小 canonical 記録)
**批准前は提案、批准で canonical**。委員会は決めず、accountable owner 1名が署名。

- `harness course phase ratify <phase-id> --close-file <path> [--scope-file <path>] --approved-by <actor> [--reason <text>]` を新設。
- ratify は (a) validator + parse + loosen gate(spec-gates.ts)を通し、(b) phase の `scope_json`/`close_conditions_json` を `updateSpec()` 経由で更新、(c) **`review_state_json` + 新規 `review_state_version` カラム + CAS write path への依存**。DB スキーマ migration (v31→v32) で `review_state_version` INTEGER DEFAULT 0 を phases テーブルに追加、lost-update 防止の CAS(version 一致 check)を ratify write に埋め込む。
- **(P3-2)** `review_state_json` は既存 docs(roadmap.md:63)で「phase-level review facts(hitch convergence でない codex/Fable レビュー)」用に予約済み。**key 衝突を避けるため namespaced key に固定**する:
  ```jsonc
  {
    // 既存の phase-level review facts は他 key に残る(本層は触らない)
    "specApproval": {
      "approvedBy": "<actor>",
      "approvedAt": "<ISO-8601>",
      "reason": "<text?>",
      "specHash": "<sha256 of canonical(scope_json)+canonical(close_conditions_json)>"
    }
  }
  ```
  `specApproval.specHash` で link/start-hitch 時に「批准後の手編集」を検知できる(§3.7)。read-modify-write で他 key を保全する。
- `--approved-by` 無し → reject(approval 必須、fail-closed)。
- **locked phase override の扱い**: ratify 後に hitch start で明示 `--scope-file/--close-file` が **gate を緩める**(required 削除/scope 拡大)なら、hitch update と同じ `--allow-gate-loosen`/`--allow-scope-widen` を要求。**tightening(より厳しく)は許容**。→ ratify の silent bypass を防ぐ(§3.7 と連動)。
- roadmap 接続: phase の `scope_json`/`close_conditions_json` が DB-canonical。`docs/specs/roadmap.md` は human-readable snapshot。phase write path がガード対象 = roadmap 接続点そのものがガードされる。

### 3.6 案A(#230 決定パケット形式)再利用 — additive にして blocking しない(P2 由来)
案C は **案A 無しで ship する**。案A の決定パケット形式は**インターフェイス前提**として扱い、spec-candidate アーティファクトに forward-compatible な **optional `decisionPacketId` field を予約**しておき、案A が landing したら additive に統合できる構造にする。

- 再利用予定: ギャップ行 → closeConditions の synthesis で「最終推奨/採用理由/棄却案/少数意見/重大リスク/未検証前提/次アクション」を埋める。複数エージェントが同 gap に異なる kind を提案 → 決定パケットで衝突を surface し、operator が批准時に選ぶ。
- 相違(quorum/tie-break ルール、severity クロスチェック scope)は **openQuestions / unresolvedForHuman** へ。

### 3.7 phase 批准 spec ↔ linked hitch spec の整合 enforcement(P1-1、新設・中核安全配線)
**批准した phase spec が enforcement に効くようにする**。現状(§2.5)は批准 spec と無関係な hitch を link/drive できる穴。

- 対象経路は **2つ**: (a) `course phase link-hitch`(`src/cli/course.ts:691-698` → `PhaseRepository.linkHitch`、phase-repository.ts:172)、(b) 新設 `course phase start-hitch`(phase から hitch を作って即 link する convenience。現状 start-hitch は未実装なので新規)。MCP の link(`course-tools.ts:540`)も同 `linkHitch` 経由なので継承。
- **整合チェック(決定論)**: phase が ratify 済み(`review_state_json.specApproval` あり)なら、link/start 対象 hitch の `scope`/`closeConditions` が phase の批准 spec に対して **同一または厳格化(tightening)**であることを require。緩和(scope 拡大 / required 削除 / gate fingerprint 弱化)は **`--allow-gate-loosen`/`--allow-scope-widen` 無しでは reject**。判定には §3.4 で抽出した `spec-gates.ts` の `isScopeWidening`/`closeConditionsLoosenGate` を**そのまま**使う(phase spec を previous、hitch spec を next とみなす)。
- **未 ratify phase**: 整合チェックは skip(後方互換。既存の自由な link を壊さない)。ratify は opt-in。
- **specHash drift 検知**: link/start 時に phase の `scope_json`/`close_conditions_json` から再計算した hash と `specApproval.specHash` を比較し、不一致(批准後に手編集)なら **warning を出す**(reject はしない — 編集自体は `updateSpec` の gate を通っている前提)。drift は ask_human surface(§6 R14)で operator に可視化。
- **orchestrator は変更しない**: `actionForPhase`(course-orchestrator.ts:534-552)はそのまま linked hitch convergence で進む。整合は **link/start 時点の gate** で保証する(enforcement の決定論性を保ちつつ、orchestrate ループに新たな spec 読み出しを足さない)。

---

## 4. work item DAG(依存順 / サブPhase / 触るファイル)

> サブPhase = 関連テスト + typecheck 緑、大Phase = フルスイート + typecheck 緑。各 WI は RED→GREEN→REFACTOR。

- **SP-A 基盤(gate 抽出 + validator + 写像、純ロジック)**:
  - **WI.4a**(先行・refactor): `isScopeWidening`/`closeConditionsLoosenGate` + 補助を `src/hitch/spec-gates.ts` に抽出。repository.ts は import に置換。**挙動不変**(R16)。← P2-2。他 WI の前提。
  - WI.1: `src/hitch/gap-to-kind.ts` 純関数(TOTAL 写像、写像不能=REJECT)。← §3.2。
  - WI.2: `src/hitch/spec-validation.ts` `validateCloseConditions`(HARD/ADVISORY、§3.3 全 rule、command bare-id 解決対応、operationId 必須)。
  - WI.3: kind 分類テーブル + validator 出力整形。
- **SP-B write barrier 接続(fail-open を閉じる)**(SP-A 依存):
  - WI.4: hitch — `createSession()` 内に parse+validator 埋め込み(P1-3)+ `updateSessionConfig` に validator 追加 + `spec-gates.ts` 利用。
  - WI.4b: MCP `hitch.expand_scope` を `updateSessionConfig` 経由に置換(P1-4)。
  - WI.5: phase — `PhaseRepository.updateSpec()` 新設 + `add()` を validator/parse 経由化 + `course phase update` raw SQL 撤去。MCP `phaseAddTool` 継承確認。
- **SP-C 人間批准 & spec/hitch 整合 & runtime 診断**(SP-B 依存):
  - WI.6: `course phase ratify`(--approved-by 必須、`review_state_json.specApproval` namespaced 記録、specHash)。← §3.5 / P3-2。
  - **WI.6a**: `linkHitch`/新 `course phase start-hitch` に phase 批准 spec ↔ hitch spec 同一/厳格化チェック + specHash drift warning(P1-1)。← §3.7。
  - WI.7: runtime spec drift 診断(required external-evidence 条件が N サイクル pending を ask_human メッセージに surface)。
- **SP-D ドキュメント/spec(同コミット)**: WI.8(全 WI 依存、最後)。既存 docs/design を reuse。

詳細は workItemDag 構造体参照。

---

## 5. 安全境界マッピング(各 item が不可侵を侵さない理由)

| 不可侵 | どう守るか | 関連 WI |
|---|---|---|
| **enforcement=決定論ゲート** | validator は form check のみ。close 判定は `convergence.decide()`(変更しない)が kind ベースで決定論実行。validator pass ≠ close 充足。phase↔hitch 整合も link/start 時の決定論 gate(spec-gates.ts)。 | WI.2, WI.4, WI.5, WI.6a |
| **合議は起草のみ** | NGT/Delphi fan-out は harness 外(3.1)。harness は validate/ratify/persist/整合 enforcement のみ。LLM の severity/「修正した」自己申告を状態遷移根拠にしない。 | WI.8(docs), 全体 |
| **状態遷移は harness のみ** | spec write は repository 層 choke point(`createSession`/`updateSessionConfig`/`updateSpec`)を通り、validator/parse fail で transaction rollback。LLM/レビュー出力が直接 DB を書き換えない。 | WI.4, WI.4b, WI.5 |
| **人間批准** | `phase ratify --approved-by` 必須、`review_state_json.specApproval`(namespaced)に署名+specHash 記録。批准前 spec は canonical でない。批准 spec は link/start 時に hitch へ強制(P1-1)。 | WI.6, WI.6a |
| **kind 区別(化け防止)** | validator が auto-verify/external-evidence を分類表で区別。db_doctor/operation_status required の field 不足を hard error。`rule.count` hard error。command は bare-id 解決を許容しつつ未解決を hard error。自動ゲート意図 NL ヒューリスティクスは advisory。 | WI.1, WI.2, WI.3 |
| **fail-open ホール(phase/expand_scope)** | phase の raw SQL / 無検証 add を repository validator(`updateSpec`)に置換。MCP も同 path 継承。`hitch.expand_scope` を `updateSessionConfig` 経由化し widen gate 継承。 | WI.4b, WI.5 |
| **spec drift** | (a)起案時=validator が曖昧/不正を弾く、(b)link/start=specHash drift warning + 整合 gate、(c)runtime=条件が N サイクル pending を ask_human に「kind=manual pending N cycles」と surface。 | WI.2, WI.6a, WI.7 |
| **MCP confirmation 迂回禁止** | 検証を repository 層に置くことで MCP write path も同じ fail-closed を継承(CLI 迂回穴を作らない)。`expand_scope` の raw bypass を update path に統合。 | WI.4b, WI.5 |
| **迷ったら fail-closed** | 写像不能 metric は REJECT(沈黙 manual default しない)。db_doctor/operation_status required は field 不足で error。approval 無し ratify は reject。ratify 済み phase の緩和 link は gate flag 必須。 | WI.1, WI.2, WI.6, WI.6a |

> 注(P2-3): db_doctor / operation_status は「永久 stall」ではなく「**自動 runner が無く ask_human に落ちる**」。operator は `hitch close-check record`(cli/hitch.ts:986)/ MCP で外部証拠を記録できる(証拠記録の経路は存在する)。hard error は「自動ゲート意図の誤分類」を起案時に止めるための fail-closed であり、外部証拠待ちを禁止するものではない(意図的な外部証拠待ちは `--allow-external-evidence` で明示 acknowledge)。

---

## 6. TDD テスト計画(RED 一覧)

### 6.1 unit(純ロジック、`src/hitch/__tests__/`)
- **R1 schema 通過/不正 kind 拒否 + count 二重性**: 実在7 kind は parse 成功、**top-level `count`** は `.strict()` で reject、**`rule.count`** は schema を通る(が validator が R4 で hard error にする)。
- **R2 gap→kind 写像(TOTAL)**: auto metric+allowedCommand → `command`、external approval → `review_consensus`、写像不能/曖昧 metric → **REJECT**(沈黙 manual default しないことを assert)。
- **R3 validator: command bare-id 解決**(P1-2 訂正): `kind=command` + `command` 空 + `id` が allowedCommands に**一意解決** → valid。`command` 空 + `id` 未解決(0 件) → hard error。`id` が**複数解決**(ambiguous) → hard error。`command` 非空 → valid。
- **R4 validator: finding_policy rule キー whitelist**: `{maxOpenInScopeP0:0}` → valid、`{count:0}`(=`rule.count`) → **hard error**、負数 → hard error。
- **R5 validator: external kind の必須 field**: `manual`/`artifact_exists`/`operation_status`/`db_doctor` で description 空 → hard error。`artifact_exists` で `metadata.path` 欠落 → hard error。**`operation_status` で `metadata.operationId` 欠落 → hard error**(P2-1)。
- **R6 validator: db_doctor required:true → hard error**(runner 未実装/`--allow-external-evidence` 無し)。
- **R7 validator: duplicate condition id → hard error**。
- **R8 自動ゲート意図 NL ミスマッチは WARNING のみ**(`kind=manual` + description `npm test passes` → warning、error にならない)。
- **R9 kind 分類表 = auto/external 区別表示**: validator 出力が分類表で 7 kind を明確に区別。
- **R16a spec-gates 抽出の挙動不変**(P2-2): 抽出した `isScopeWidening`/`closeConditionsLoosenGate` が抽出前と同一判定(代表ケース parametrized)。

### 6.2 integration(`tests/unit/` / `tests/integration/`)
- **R10 phase write barrier(fail-open 修正の回帰)**: 不正 closeConditions を `course phase update --close-file` / `phase add --close-file` / MCP `phaseAddTool` に渡す → **DB write されず error**(現状は素通しで永続化される回帰を防ぐ)。
- **R10b expand_scope が update path を通る**(P1-4): MCP `hitch.expand_scope` で `scope_json` 更新後、`updateSessionConfig` 経由(widen gate 継承)を assert。明示例外を取った場合は raw path の threat-model 限定動作を assert。
- **R10c createSession が真の choke point**(P1-3): `HitchRepository.createSession` に**未検証(parse 前)**の不正 scope/closeConditions を直接渡す → validator/parse で reject(CLI 事前 parse に依存しないことを assert)。
- **R11 自動ゲート kind が ask_human に化けない回帰**: `kind=command`(runnable)を作成 → convergence が `hasRunnableCommand=true`(run_close_check)。`kind=manual/artifact_exists/operation_status/db_doctor` → externalEvidenceLabels(ask_human)。逆(command 意図が ask_human 化)を fail で catch。
- **R12 人間批准明示 + namespaced key**(P3-2): `phase ratify --approved-by <actor>` → `review_state_json.specApproval = {approvedBy, approvedAt, reason, specHash}` 書込・read-back。**既存の他 review key が保全される**ことを assert。`--approved-by` 無し → reject。
- **R13 locked phase override gate(hitch start)**: ratify 後 hitch start で明示 file が gate を緩める override → `--allow-gate-loosen`/`--allow-scope-widen` 無しは reject、tightening は pass。
- **R13b 批准 spec の link/start enforcement**(P1-1): ratify 済み phase に、(a)批准 spec を緩める hitch を `link-hitch`/新 `start-hitch` → gate flag 無しは reject、(b)同一/厳格化 hitch → pass、(c)未 ratify phase は従来通り自由 link、(d)批准後 phase spec を手編集(specHash drift) → link/start で warning。
- **R14 runtime spec drift 診断**: required external-evidence 条件が N サイクル pending → ask_human メッセージに `condition X kind=manual pending N cycles`(及び specHash drift があればその旨)を含む。
- **R15 既存 spec の pass-through**: dashboard-demo hitches の closeConditions を validator に通して ok(bare-id command 条件含む)。

### 6.3 regression(回帰禁止)
- **R16 convergence + gate 抽出 不変**: validator/抽出追加後も `convergence.decide()` / `requiredPendingCloseCheckRouting()` の挙動が不変。`isScopeWidening`/`closeConditionsLoosenGate` の判定が抽出前と同一(repository update path の既存テスト緑)。
- **R17 phase repository 後方互換**: 既存 `review_state_json=null` または `specApproval` 無しの phase が validator/ratify/整合チェック追加後も require/get/list で deserialize 成功。既存 fixture の bare-id command 条件が壊れない。
- **R18 フルスイート緑**(大Phase gate)。テストを弱める/skip する緑化は禁止。

---

## 7. docs/specs 更新一覧(同コミット)

1. **docs/specs/cli.md** — `harness course phase ratify`(--approved-by/--reason/specHash)、新 `course phase start-hitch`、`link-hitch` の批准 spec 整合チェック、phase update/add の validator 適用、close conditions file 形式 + kind 選択ガイド(auto vs external 区別)、command の bare-id 解決規約。
2. **docs/specs/hitch-convergence.md** — closeConditions kind 実装パターン(自動検証 vs ask_human routing、convergence.ts:236-265 の振り分け明文化)、kind 分類表(operationId/path 必須)、command bare-id 解決(:413 既存記述と整合)、runtime drift 診断、validator≠enforcement の境界、`expand_scope` が update path 経由になった旨。
3. **docs/specs/roadmap.md** — phase の scope/closeConditions が spec drafting workflow + ratify 経由で lock される旨、`review_state_json.specApproval`(namespaced、:63 の既存 review-facts 用途と共存)の批准記録 role、phase write path が validator/gate でガードされる旨、批准 spec が linked hitch に強制される旨。
4. **docs/specs/spec-review-layer.md(新規)** — ギャップ行テンプレート(既存 docs/design から reuse、asIs/toBe/gap/cause/action/owner/deadline/metric)、kind 選択 decision tree、gap→kind 写像表、lint 規則、人間批准 ceremony、phase↔hitch 整合、安全境界、案A 連携(optional decisionPacketId、インターフェイス前提)、5+ サンプル。
5. **docs/workflows/spec-draft-and-review.md(新規)** — NGT/Delphi 起案→重複排除→批判→統合の段階・actor 分担・出力形式・harness 外実行の明記(superpowers:dispatching-parallel-agents 連携、既存 docs/design/deliberation.md・consulting-frameworks.md を reuse)、critic-checklist。
6. **GOAL_RULES.md / AGENTS.md** — spec レビュー層の validator 検証段階・closeConditions 修正時の validator 経由・kind 分類表更新の constraint(convergence/runner/close-checks ロジック変更時に validator テーブル + spec-gates を同期)、`spec-gates.ts` が hitch/phase 共用である旨を追記。

---

## 8. 受け入れ条件(#231)対応表

| 受け入れ条件 | 実装 | 検証 |
|---|---|---|
| 起案→批判→統合の成果物テンプレートが存在し、**人間批准ステップが明示** | WI.8(spec-review-layer.md + spec-draft-and-review.md、既存 docs/design reuse)、WI.6(`phase ratify`)、WI.6a(批准 spec の hitch 強制) | R12, R13b |
| 生成 closeConditions が実在 kind のみで `HitchCloseConditionSchema` を通る検査(無効 kind を出さない) | WI.2(validator)+ 既存 Zod enum、WI.4/4b/5(全 write path 接続: createSession 真 choke point 化 / expand_scope update path / phase updateSpec) | R1, R10, R10b, R10c |
| 自動検証 kind と外部証拠待ち kind がテンプレート上で区別され、自動ゲート意図の条件が ask_human kind に化けない検査 | WI.2(分類表 + db_doctor/operation_status required hard error + NL advisory + command bare-id 解決)、WI.1(写像 fail-closed) | R3, R5, R6, R8, R9, R11 |
| docs/specs/roadmap.md 等を同コミットで更新 | WI.8 | — |
| **(派生)批准済み phase spec が linked hitch に効く** | WI.6a(link/start-hitch 整合 gate、spec-gates.ts 共用) | R13b |

---

## 9. スコープ外 / follow-up

- **roadmap-phase sync 検査**(`harness db check-consistency --with-roadmap-sync`): docs/specs/roadmap.md と phase repo の sync verify。本 issue では design のみ、実装は別 phase。
- **shell syntax validation**(command kind): false-positive リスクのため初版は warning-only、strict 化は future。
- **db_doctor / operation_status runner 実装**: 本 issue は required を hard error で fail-closed にするのみ。runner 実装は別 epic(実装時は R6/R11 に regression 追加必須)。
- **案A 決定パケットの完全統合**: optional decisionPacketId を予約するのみ(インターフェイス前提)。quorum/tie-break 統合は案A landing 後。
- **MCP `hitch.expand_scope` の明示例外を取る場合**: update path 統合が互換上不可能と判明した時のみ、threat model + raw-path regression を伴う明示例外として残す(第一選択は update path 経由)。
- **multi-language/multi-repo の allowedCommands scope フィルタ**: context.allowedCommands は flat list。scope-aware filtering は future。
- **specApproval を専用カラム/events テーブルへ昇格**: query 要件(批准履歴の検索等)が出てから。初版は `review_state_json.specApproval` namespaced key で migration 回避。

---

# 付録C: 反証検証した主要アーキ前提

### 前提1 — **confirmed**
- 主張: HitchCloseConditionKind は厳密に {command, finding_policy, manual, operation_status, db_doctor, review_consensus, artifact_exists} の7種のみで、HitchCloseConditionSchema(schemas.ts:47-57)が enum で強制する。count 等は無効。
- 根拠: 1. Type definition: src/hitch/types.ts:189-196 defines HitchCloseConditionKind as union of exactly 7 string literals.

### 前提2 — **confirmed**
- 主張: The architectural premise that closeConditions kinds are routed deterministically by kind — with command/finding_policy/review_consensus being auto-validated by harness, and manual/artifact_exists/operation_status/db_doctor being routed to ask_human by convergence.ts:240-265 — is CONFIRMED with one critical caveat: db_doctor has NO auto-execution path and no explicit handler, so it is correctly placed in the ask_human group by omission, but the type's inclusion suggests future intent with incomplete implementation.
- 根拠: 

### 前提3 — **confirmed**
- 主張: scope/closeConditions are passed via hitch start --scope-file/--close-file (course.ts:576/653) as structured files parsed once at create time, and no independent agent-driven spec drafting/review structure (NGT/Delphi rounds, multi-agent proposals, critic iteration, consensus-driven closure) exists in the codebase for generating or iterating on these conditions.
- 根拠: 

### 前提4 — **confirmed**
- 主張: Close-condition enforcement (the decide() function's judgment of whether conditions pass/fail/pend) is a deterministic gate with no LLM involvement. Merging consensus-drafted condition specifications does not introduce evaluation ambiguity because the judge (convergence.decide()) is purely algorithmic.
- 根拠: 1. **Evaluation is split into two phases, only first is evaluated:** 

### 前提5 — **confirmed**
- 主張: 「HitchCloseConditionSchema を通る」ことは「自動検証される」ことを意味しない: schema を通っても ask_human kind(manual/artifact_exists/operation_status/db_doctor)なら convergence は operator 証拠待ちで stall する。
- 根拠: 

---

# 付録F: codex exec gpt-5.5 xhigh レビュー（v1 設計への指摘 = v2 の改訂根拠）

検証結果: §2.1-2.5 の主要 grounding は概ね正しいです。7 kind、convergence の kind routing、`finding_policy.rule.count` silent ignore、`db_doctor` runner 未実装、phase write path fail-open、`review_state_json` 既存カラムは実コードで確認しました。§2.6 は指示どおり再指摘しません。

**P0**
なし。

**P1**
1. 該当: §3.5 / §6 R13  
問題: 批准済み phase spec が、実際に linked hitch へ強制される設計になっていません。現状は hitch を単独作成して後から `phase link-hitch` でき、course orchestrator は phase の `scope_json` / `close_conditions_json` を見ず linked hitch の convergence だけで進みます。  
根拠: hitch 作成は [src/cli/hitch.ts](/Users/kn/ops/monorepo-harness/src/cli/hitch.ts:218)、link は project/double-link のみ [src/roadmap/phase-repository.ts](/Users/kn/ops/monorepo-harness/src/roadmap/phase-repository.ts:172)、orchestrator は linked hitch convergence だけを見る [src/roadmap/course-orchestrator.ts](/Users/kn/ops/monorepo-harness/src/roadmap/course-orchestrator.ts:534)。  
推奨: `course phase start-hitch` か `phase link-hitch` に、phase 批准 spec と hitch spec の同一/厳格化チェックを入れる。R13 は `hitch start` だけでなく link 経路を必ず覆う。

2. 該当: §3.3 `kind=command` hard error  
問題: `command` field 必須化は既存仕様と多数 fixture を壊します。現 runner は `command` 未指定なら condition `id` を allowed command id として解決する仕様です。  
根拠: 解決ロジック [src/hitch/orchestrator-close-check-runner.ts](/Users/kn/ops/monorepo-harness/src/hitch/orchestrator-close-check-runner.ts:323)、docs [docs/specs/hitch-convergence.md](/Users/kn/ops/monorepo-harness/docs/specs/hitch-convergence.md:413)、README 例 [README.md](/Users/kn/ops/monorepo-harness/README.md:167)、fixture [tests/integration/hitch-orchestrate.test.ts](/Users/kn/ops/monorepo-harness/tests/integration/hitch-orchestrate.test.ts:444)。  
推奨: hard rule は「`command` 非空、または `id` が allowedCommands に一意解決できる」に変更。必須化するなら migration/docs/tests 更新を WI に追加。

3. 該当: §2.5 / §3.4 repository choke point  
問題: 「hitch create path は Zod parse 済み」は CLI/MCP caller では概ね正しいが、`HitchRepository.createSession()` 自体は parse/validator choke point ではありません。  
根拠: `createSession` は `input.scope` / `input.closeConditions` をそのまま `json()` 保存 [src/hitch/repository.ts](/Users/kn/ops/monorepo-harness/src/hitch/repository.ts:510)。CLI は事前 parse [src/cli/hitch.ts](/Users/kn/ops/monorepo-harness/src/cli/hitch.ts:230)、MCP は args schema 後に repo 直行 [src/mcp/tools/hitch-tools.ts](/Users/kn/ops/monorepo-harness/src/mcp/tools/hitch-tools.ts:318)。  
推奨: `createSession()` 内で `parseHitchScope` / `parseHitchCloseConditions` + 新 validator を必ず実行する、と設計に明記。

4. 該当: §3.4 “all spec write path”  
問題: MCP `hitch.expand_scope` が `updateSessionConfig()` を通らず raw SQL で `scope_json` を更新します。closeConditions ではないが、scope は spec surface です。  
根拠: [src/mcp/tools/hitch-tools.ts](/Users/kn/ops/monorepo-harness/src/mcp/tools/hitch-tools.ts:1007)、dangerous tool 定義 [src/mcp/registry/tool-registry.ts](/Users/kn/ops/monorepo-harness/src/mcp/registry/tool-registry.ts:1745)。  
推奨: shared update path に通すか、明示的な例外として threat model と regression test を追加。

**P2**
1. 該当: §3.3 `operation_status`  
問題: guard table では `metadata.operationId` 必須だが、HARD error 一覧と R5 に入っていません。  
根拠: `operation_status` は schema/type 以外に runner 実装なしで ask_human group に落ちる [src/hitch/convergence.ts](/Users/kn/ops/monorepo-harness/src/hitch/convergence.ts:254)。  
推奨: `metadata.operationId` 必須を hard rule と R5 に追加。

2. 該当: §3.4 phase gate mirror  
問題: `isScopeWidening` / `closeConditionsLoosenGate` は hitch repository private 関数なので、phase に mirror すると duplication/drift しやすい。  
根拠: [src/hitch/repository.ts](/Users/kn/ops/monorepo-harness/src/hitch/repository.ts:1935)、[src/hitch/repository.ts](/Users/kn/ops/monorepo-harness/src/hitch/repository.ts:2007)。  
推奨: `src/hitch/spec-gates.ts` などへ抽出し、hitch/phase 両方が同じ関数を使う。

3. 該当: §2.4 / §3.3 `db_doctor`  
問題: 「永久 stall」は言い過ぎです。runner は無いが、operator は `hitch close-check record` / MCP で外部証拠を記録できます。  
根拠: CLI record [src/cli/hitch.ts](/Users/kn/ops/monorepo-harness/src/cli/hitch.ts:986)、repository insert [src/hitch/repository.ts](/Users/kn/ops/monorepo-harness/src/hitch/repository.ts:1733)。  
推奨: 表現を「自動 runner が無く ask_human に落ちる」に修正。`required:true` hard error 方針自体は、自動ゲート意図の誤分類防止として妥当。

**P3**
1. 該当: §2.1 / §2.3  
問題: `count` は top-level field なら `.strict()` で拒否、`rule.count` は schema を通って evaluator に silent ignore される、という区別を明記した方がよいです。  
根拠: schema [src/hitch/schemas.ts](/Users/kn/ops/monorepo-harness/src/hitch/schemas.ts:47)、evaluator [src/hitch/close-checks.ts](/Users/kn/ops/monorepo-harness/src/hitch/close-checks.ts:129)。

2. 該当: §3.5  
問題: `review_state_json` 相乗りは migration 不要で妥当ですが、既存 docs は phase-level review facts としているため key 衝突対策が必要です。  
根拠: [docs/specs/roadmap.md](/Users/kn/ops/monorepo-harness/docs/specs/roadmap.md:63)。  
推奨: `{ specApproval: { ... } }` のように namespaced key を固定。

**総合判定**
GO-with-fixes。phase fail-open ホールの現状分析と validator 方針は正しいので実装方向は妥当です。ただし P1、特に「批准済み phase spec と linked hitch の結合」と「command field 必須化の互換性」は、実装前に設計ノートへ反映してください。未検証: origin/main 上の PR #227 docs 実在性は、今回の指示どおり前提として扱い、再確認していません。

---

# 付録G: v2 changeLog（codex finding ごとの対処）

### P1-1
- 対処: 批准済み phase spec が linked hitch に強制されない穴を §3.7(新設)で塞ぐ。linkHitch(phase-repository.ts:172)が project+double-link のみ検証し、orchestrator(course-orchestrator.ts:534-552)が phase の scope/closeConditions を読まない事実を §2.5 に grounding。link-hitch / 新設 start-hitch に『phase 批准 spec ↔ hitch spec の同一/厳格化(tightening)チェック』を決定論 gate(spec-gates.ts 共用)で追加し、緩和は --allow-gate-loosen/--allow-scope-widen 無しで reject。未 ratify phase は skip(後方互換)。specHash drift は warning。WI.6a 新設、R13(link/start 経路に拡張)+R13b 新設。orchestrator 自体は不変。
- 反映 §: v2 改訂履歴, §2.5, §3.1, §3.7(新設), §4 WI.6a, §5 安全境界マッピング, §6 R13/R13b, §8 派生受け入れ条件

### P1-2
- 対処: kind=command の command 必須化を撤回。現 runner resolveCommandForCondition(orchestrator-close-check-runner.ts:319-348)が command 未指定時に condition id を allowed command id として一意解決する仕様、および docs/README/fixture 依存を確認。HARD error 2 を『command 非空 OR id が allowedCommands に一意解決できる』に変更。0件/複数件(ambiguous)解決のみ hard error。§3.3 分類表・R3 を訂正。
- 反映 §: v2 改訂履歴, §3.3 HARD error 2, §3.3 分類表, §6 R3, §9 follow-up(spec-review docs に bare-id 規約)

### P1-3
- 対処: createSession() が choke point でない事実(repository.ts:510-511 が input.scope/closeConditions を raw json() 保存、CLI 事前 parse に依存、MCP は repo 直行 hitch-tools.ts:318-319)を §2.5 に明記。§3.4 で『createSession() 内に parseHitchScope/parseHitchCloseConditions + 新 validator を必ず実行』と設計変更し真の choke point 化。R10c で未検証値を createSession に直接渡して reject を assert。
- 反映 §: v2 改訂履歴, §2.5, §3.4, §4 WI.4, §6 R10c

### P1-4
- 対処: MCP hitch.expand_scope が updateSessionConfig を通らず raw UPDATE scope_json(hitch-tools.ts:1010-1014)で isScopeWidening gate を迂回する事実を §2.5 に grounding(dangerous tool だが widen gate 無し)。§3.4 で『updateSessionConfig 経由に置換し widen gate 継承』を第一選択に。互換上不可能な場合のみ threat model + raw-path regression を伴う明示例外。WI.4b 新設、R10b。
- 反映 §: v2 改訂履歴, §2.5, §3.4, §4 WI.4b, §5 安全境界マッピング, §6 R10b, §9 follow-up

### P2-1
- 対処: operation_status の metadata.operationId 必須を HARD error 8 として追加(convergence.ts:254 で除外されず ask_human group に落ちる事実に基づく)。§3.3 分類表の必須 field 欄、R5 に operationId 欠落=hard error を追加。
- 反映 §: v2 改訂履歴, §3.3 HARD error 8, §3.3 分類表, §6 R5

### P2-2
- 対処: isScopeWidening/closeConditionsLoosenGate(repository.ts:1935/2007、現状 private)を mirror すると drift する点を踏まえ、§3.4 で『src/hitch/spec-gates.ts に抽出し hitch/phase が同一 export 関数を import』に変更。WI.4a を先行 refactor として新設、R16/R16a で挙動不変を担保。
- 反映 §: v2 改訂履歴, §3.4, §4 WI.4a, §6 R16/R16a, §7 GOAL_RULES/AGENTS

### P2-3
- 対処: db_doctor『永久 stall』表現を『自動 runner が無く ask_human に落ちる(operator は hitch close-check record(cli/hitch.ts:986)/MCP で外部証拠を記録できる)』に §2.4・§3.3・§5 注で修正。required:true hard error 方針自体は誤分類防止として妥当と明記。
- 反映 §: v2 改訂履歴, §2.4, §3.3 HARD error 7, §5 注

### P3-1
- 対処: count の二重性を §2.1・§2.3 に明記。top-level count は .strict()(schemas.ts:65)が reject、rule.count は z.record(z.unknown())(schemas.ts:62)を通り evaluateFindingPolicy whitelist(close-checks.ts:129-150)で silent ignore。validator は rule.count を hard error にする(R4)。
- 反映 §: v2 改訂履歴, §2.1, §2.3, §3.3 HARD error 3, §6 R1/R4

### P3-2
- 対処: review_state_json が既存 docs(roadmap.md:63)で phase-level review facts 用に予約済みのため、批准記録を namespaced key { specApproval: { approvedBy, approvedAt, reason, specHash } } に固定。read-modify-write で他 key 保全。R12 で既存 review key 保全を assert。
- 反映 §: v2 改訂履歴, §3.5, §6 R12, §7 roadmap.md

### grounding-§2.6
- 対処: 人間指示に従い §2.6 を訂正: docs/design/consulting-frameworks.md・deliberation.md は origin/main(PR #227 / v0.7.10)に実在。ギャップ行スキーマ・意思決定マトリクスは『新規に著す』ではなく既存 docs/design から reuse。WI.8/§7 の新規 docs も reuse 前提に修正。v1 の false-premise 記述を撤回。
- 反映 §: v2 改訂履歴, §2.6, §3.2, §7 docs 4/5, §8 受け入れ条件

---

# 付録H: v2 残件（人間批准が要る）

## H1. 案A(#230 決定パケット形式)の quorum / tie-break ルールと severity クロスチェックの scope。案A 確定後に additive 統合する前提だが、複数エージェントが同一 gap に異なる kind を提案した際の operator 批准時の衝突解決(過半数か全会一致か、tie をどう割るか)が未確定。
推奨: 案C 単体は optional decisionPacketId を予約するだけで ship し、quorum/tie-break は案A landing 後に決める。それまでは『同一 gap の kind 衝突は operator が ratify 時に1案を選ぶ(harness は選択を記録するだけ、合議しない)』を暫定ルールにする。

## H2. ratify 済み phase に対する link/start-hitch 整合チェックを『緩和は reject、tightening は許容』とする際、tightening の判定を spec-gates.ts の isScopeWidening/closeConditionsLoosenGate(現状 hitch update 用の意味論)でそのまま流用してよいか。phase spec=previous, hitch spec=next のセマンティクスが hitch の update セマンティクスと完全一致するかは要確認。
推奨: WI.6a 実装時に spec-gates 関数を phase↔hitch 文脈に適用したテーブルテスト(R13b)を先に書き、意味論ズレ(例: phase に scope.targetFiles が無い場合の widen 判定)が無いか RED で炙り出す。ズレがあれば spec-gates に phase 用 thin wrapper を足す(関数本体は共用のまま)。

## H3. MCP hitch.expand_scope を updateSessionConfig 経由に統合する際、expand は意味上 scope widen を許す操作なので allowScopeWiden:true を渡すことになるが、これだと『dangerous confirmation を経た widen は無条件許可』になる。confirmation だけで widen gate を実質バイパスするのは安全境界上許容してよいか。
推奨: expand_scope は dangerous tool(confirmation 必須、tool-registry.ts:1745)なので、confirmation = operator の明示 widen 承認とみなし allowScopeWiden:true で update path を通すのを許容する(gate を通った上での意図的 widen)。ただし updateSessionConfig がここで widen の detail(previousScope)を attempt/監査ログに残すことを R10b で確認する。監査が不十分なら raw-path 明示例外+threat model に倒す。

