# 実装ロードマップ（build sequence）— epic #228 合議制 統合

> Cycle 1 で 4設計ノート（#229/#230/#231/DB）+ 5関数仕様 を**重複排除して単一の依存順サブPhase列**に統合したもの。
> 実装順: **DB 基盤(v31) → 案A(#230) → 案B(#229) → 案C(#231)**。共有成果物は 1 SP が所有し他はそれに dependsOn。
> 規律: サブ Phase = 関連テスト+typecheck 緑 / 大 Phase = フルスイート+typecheck 緑。回帰禁止。

# 統合実装ロードマップ — epic #228 AI 合議制（DB → 案A → 案B → 案C）

> 計画のみ。実装は別セッションが **dev クローンの `origin/main` ベース隔離ブランチ**で TDD（RED→GREEN→REFACTOR）。
> 駆動は ops ハーネス。base ref（当時）: `SCHEMA_VERSION=30`、migration head=v30、`run_usage` PK=`(run_id,kind,seq)`、`phases.review_state_json` は specApproval 専用書込経路が無い（既存 writer は note 用 `setNote()` のみ・CAS なし）、`ALL_TABLE_NAMES` は手動 union。**現 main = v0.7.15（`SCHEMA_VERSION=31`、migration head=v31）。着手時は HEAD で file:line を再取得**。
>
> **⚠️ 版番号同期（2026-06-17・最重要）**: 本ロードマップは「DB 基盤(v31 単一ブロック) → 案A(#230) → 案B(#229) → 案C(#231)」を
> 前提に書かれているが、**実際は #230(案A) が先に v31 を単独出荷・リリース済み（0.7.15）**＝実装順が逆転した。**shipped v31 = #230 jury 3表のみ**
> （`jury_classification_proposals` / `jury_classification_refutations` / `jury_severity_audits`）。確定（design-230-deepened R12:124/511/661）:
> **#229 `review_refute_votes` = v32 / #231 `phases.review_state_version` = v33**（逐次・別 migration）。**出荷済み v31 statements は不可侵**
> （後から CREATE/ALTER を足すと適用済み DB を壊す）。よって本書中の「SP-1 が v31 で 3表＋phases ALTER を作る」「共有 v31 単一ブロック」は無効
> で、**SP-1 は #229 分=v32 / #231 分=v33 に分割**する。さらに **SP-3D の orphan/hitch_id doctor check は #230 が既に出荷済**
> （`src/db/jury-doctor-checks.ts` の `jury.orphan_rows` / `jury.hitch_mismatch`）なので、#229 SP-3D は **v32 `review_refute_votes` 用の
> check のみ**に rescope（jury 表ぶんの再実装は DoctorCheck id 重複）。

## 1. 背景

epic #228 の3 sub-issue は LLM 多体の **提案・票・分類・spec 候補**を生む。harness は DB-canonical なので、これらを**監査/入力**として DB に蓄積しつつ、**状態遷移は決定論ゲートのみ**に保つ必要がある。4設計ノート（DB横断 / #230案A / #229案B / #231案C）+ 5関数仕様 + DB v2 を、重複排除して**単一の依存順サブPhase列**にした。

## 2. 実装順（人間批准済み）: DB 基盤(v31) → 案A(#230) → 案B(#229) → 案C(#231)

DB 永続化（migration + repository + review_state_json 書込経路）が**3案の下回り**。各案は共有成果物（後述）に dependsOn し、所有 SP は1つに集約する。**※ 版番号は逐次に確定済み（冒頭バナー参照）: v31=#230（出荷済）/ v32=#229（`review_refute_votes`）/ v33=#231（`review_state_version`）。** 旧「単一 v31 ブロック」は #230 の先行出荷で不成立。

```
大Phase 0 (DB 基盤)  : SP-1 → SP-2 → SP-3 → SP-3D   [v32 refute migration(#229) / v33 phases ALTER(#231) ※v31 jury は #230 出荷済 / refute(v32) precomputed-hash repo ※jury repo は #230 出荷済 / review_state CAS / consistency-doctor(refute 用のみ追加)]
大Phase A (#230)     : SP-4 → SP-5 → SP-6 → SP-7 → SP-8 → SP-9
大Phase B (#229 1a)  : SP-10 → SP-11 → SP-12 → SP-13 → SP-14
大Phase B' (#229 1b) : SP-15
大Phase B'' (#229 P2): SP-16 → SP-17 → SP-18  [refute verify(binding/hash version は SP-16 所有); 別issue 化は要人間批准]
大Phase C (#231)     : SP-19 → SP-20 → SP-21 → SP-22 → SP-23
```

> **v2 改訂（codex ロードマップレビュー反映）**: (1) SP-2 を「precomputed `target_change_hash` の append/list/dedupe」までに縮小し、`normalizeChangeText`/`targetChangeHash`/`verifyRefuteBinding` と hash version 方針は SP-16(refute) が所有。(2) SP-2 直後に **SP-3D（consistency-doctor）** を追加（orphan/hitch_id 整合は DB 基盤内、refute hash 再計算 check は SP-16 後に拡張）。(3) jury enum を DB v2 DDL に合わせ `proposedScope∈{in_scope,out_of_scope,unknown}` + `proposalStatus`（SP-4 の型/テスト）。(4) criticalPath に SP-22 を含める（SP-21→SP-22→SP-23）。(5) SP-3 の CAS 競合ポリシーを acceptance に固定（bounded retry N→typed conflict error）。(6) gate-specs の古い refute DDL（`UNIQUE(run_id,target_change_hash,reviewer_id)` / `REFERENCES reviewers` / hash 再計算）は廃止し **DB v2 business key `(run_id,target_change_hash,reviewer_id,prompt_sha256)` + FK 無し**に統一。

## 3. 共有アーティファクト（複数案が共有 → 1 SP 所有 + 他は dependsOn）

| 成果物 | 所有 SP | consumer |
|---|---|---|
| **migration（逐次）**: v31=#230 jury 3表（**出荷済・不変**）/ **v32=#229 `review_refute_votes` CREATE** / **v33=#231 `phases.review_state_version` ALTER**。各版で `SCHEMA_VERSION` bump（v32 は `V32_TABLE_NAMES`=`review_refute_votes` を `ALL_TABLE_NAMES` union に append。**v33 は phases ALTER のみ＝新 table 名なし・table-name 登録不要**） | **SP-1** | 案B-P2(refute表=v32)/案C(review_state_version=v33) ※案A jury は出荷済 |
| **provenance footprint 規約**（run_id/hitch_id/finding_id/reviewer_id/model/prompt_sha256/prompt_provenance_json/usage_kind/usage_seq）+ `(run_id,usage_kind,usage_seq)` で run_usage 一意 JOIN（FK 張らない） | **SP-1**（DDL）+ **SP-19/docs** | 全合議行 |
| **consistency-doctor 整合 check**（orphan / `hitch_id` 整合 = stored vs finding_id→join。FK を張らない設計の必須セット。design-db-persistence §3.4/§8-#8）。**※ jury 3表ぶんは #230 が出荷済**（`jury-doctor-checks.ts`: `jury.orphan_rows` / `jury.hitch_mismatch`）。#229 は **v32 `review_refute_votes` 用 check のみ新設**（重複回避） | **SP-3D**（refute 表の orphan + hitch_id 整合）+ **SP-16**（refute hash 再計算 check を拡張） | DB 基盤の append-only 監査保証 |
| **refute target binding / hash version**（`normalizeChangeText`/`targetChangeHash`/`verifyRefuteBinding` + normalize version 方針）。**SP-2 は precomputed `target_change_hash` の append/list/dedupe のみ**で binding 検証は持たない | **SP-16** | 案B-P2 refute(SP-17/SP-18)、SP-3D の hash 再計算 check 拡張 |
| **`review_state_json` CAS 書込経路**（`updateReviewState()`/`recordSpecApproval()`、`review_state_version` で `db.transaction().immediate()` + CAS） | **SP-3** | 案C(specApproval) |
| **`ReviewRule` 解決**（`compileProfileReviewRule`/`resolveEffectiveRule(profile?)`/`ReviewRuleCompileError`、`reviewRuleResolution` 全入口 thread） | **SP-10** | 案B-1a 本体（案A は jury で consensus rule 不要なので消費しない） |
| **`HitchDecisionPacket` 型 + formatter**（`buildJurySplitPacket`/`buildOperatorOriginPacket`、`recommended_next_action` additive JSON） | **SP-6** | 案A(escalate packet)/案C(optional `decisionPacketId` 予約のみ) |
| **`aggregateJuryVotes`**（純関数・決定論集約） | **SP-4** | 案A jury 配線 |
| **`spec-gates.ts`**（`isScopeWidening`/`closeConditionsLoosenGate` を repository.ts private から抽出、hitch/phase 共用） | **SP-19** | 案C(phase updateSpec / link-hitch 整合) |

## 4. サブPhase build sequence 表

| SP | title | 大Phase | dependsOn |
|---|---|---|---|
| SP-1 | 逐次 migration（v32 #229 `review_refute_votes` / v33 #231 phases ALTER。v31 jury は #230 出荷済・不変）+ ALL_TABLE_NAMES union | 0 DB | — |
| SP-2 | **v32 `review_refute_votes` repository のみ**（footprint・precomputed target_change_hash の append/list/dedupe・存在/一致 hard 検査）。**jury repository は #230 出荷済（`src/db/repositories/jury-*.ts`）＝対象外**。**binding 検証/hash version は持たず SP-16 に移譲** | 0 DB | SP-1 |
| SP-3 | review_state CAS 書込経路（updateReviewState/recordSpecApproval、bounded retry N→typed conflict error） | 0 DB | SP-1 |
| SP-3D | consistency-doctor 整合 check（orphan proposal/vote/audit + hitch_id 整合）。refute hash 再計算は SP-16 後拡張 | 0 DB | SP-2 |
| SP-4 | `aggregateJuryVotes` 純関数（型 + 決定論集約） | A #230 | SP-1 |
| SP-5 | `auditSeverity` 純関数（advisory-only severity audit） | A #230 | SP-4 |
| SP-6 | `HitchDecisionPacket` 型 + formatter（packet 共有成果物） | A #230 | SP-4 |
| SP-7 | jury proposer（3 lens・DB非書込・fail-closed parse） | A #230 | SP-4 |
| SP-8 | classify runner 3フェーズ配線 + orchestrator packet 永続化（P1-1/P1-2） | A #230 | SP-2,SP-5,SP-6,SP-7 |
| SP-9 | 案A docs/specs + RACI + 回帰 + e2e | A #230 | SP-8 |
| SP-10 | profile `review:` schema + ReviewRule 解決 + 全入口 thread（共有） | B #229-1a | SP-9 |
| SP-11 | `ReviewerRepository.listByGroup` + N-dispatch consensus 集約決定論 | B #229-1a | SP-10 |
| SP-12 | orchestrator N reviewer dispatch + pending→stall catch 経路 | B #229-1a | SP-11 |
| SP-13 | reviewed-run consensus 明示拒否（typed error） | B #229-1a | SP-10 |
| SP-14 | 案B-1a docs/specs + 入口別 integration + 回帰 | B #229-1a | SP-12,SP-13 |
| SP-15 | lens 別 prompt 配線（"multi-lens" 本物化、別 PR） | B' #229-1b | SP-14 |
| SP-16 | refute target binding data model + `normalizeChangeText`/`targetChangeHash`/`verifyRefuteBinding` + doctor hash check 拡張 | B'' #229-P2 | SP-2,SP-15,SP-3D |
| SP-17 | refute requirement rule DSL + `runRefuteAgent` + evaluateConsensus 第2 requirement | B'' #229-P2 | SP-16 |
| SP-18 | orchestrator refute dispatch + advisory 反映 + docs + 回帰 | B'' #229-P2 | SP-17 |
| SP-19 | spec-gates 抽出 + gap→kind 写像 + validateCloseConditions（共有 + 純ロジック） | C #231 | SP-18 |
| SP-20 | write barrier 接続（createSession choke / expand_scope / phase updateSpec） | C #231 | SP-19,SP-3 |
| SP-21 | phase ratify（recordSpecApproval）+ link/start-hitch 整合 gate | C #231 | SP-20,SP-3 |
| SP-22 | runtime spec drift 診断 | C #231 | SP-21 |
| SP-23 | 案C docs/specs（spec-review-layer / spec-draft-and-review / cli / roadmap / GOAL_RULES）+ 回帰 | C #231 | SP-21,SP-22 |

## 5. 各 SP の完了定義（受け入れ）

- **大Phase gate（A/B/C 各末尾 SP）= フルスイート vitest + typecheck 緑、回帰禁止**（テストを弱める/skip する緑化は禁止）。
- **サブ Phase（各 SP）= 関連テスト + typecheck 緑**、RED を先に書く（TDD）。
- **spec 駆動**: `src/`/policy が変わったら同コミットで `docs/specs/*` 更新。

詳細な RED テスト/受け入れは各 subPhase の `redTests`/`acceptance` を参照。

## 6. 安全境界（全 SP で不可侵）

- 集約・状態遷移は**決定論ゲート**（review-processor / convergence / evaluateConsensus / aggregateJuryVotes / auditSeverity / validateCloseConditions）のみ。LLM 出力（提案/票/refute/severity 自己申告/gap metric）は**入力/監査**であって状態の権威にしない。
- jury 不一致は必ず人間 escalate（自動確定しない / fail-closed）。severity 自動降格しない（advisory）。P1→P2 降格は close gate(convergence) の権限に留める。
- consensus/refute は expected-status guard（needs_review）を必ず通す。多数決を直接 run.status にしない。
- v31 migration は additive・後方互換。DB-only 監査行は append-only（CASCADE 張らない / FK 張らない）。
- confidence float gate 禁止（提案 count・票一致度のみで判定）。
- 迷ったら fail-closed。

## 7. リスク

- **逐次 migration の merge 順**: 旧「3案が v31 を共有」は #230 の v31 単独出荷で不成立。**v31=#230（出荷済）→ v32=#229 → v33=#231** の順で land し、同一 version 番号で 2 branch 同時 open を禁止（merge order ゲート）。#229/#231 着手前に未確定 version を予約し番号衝突を防ぐ。**出荷済み v31 statements は不可侵**。
- **v31 表先行 → LLM verdict→状態直結の誘惑**: jury 提案表（SP-1/SP-2）が決定論ゲート（SP-4 aggregateJuryVotes）より先に land すると安全境界が崩れる。**SP-4 land まで提案表に書く配線（SP-8）を入れない**。
- **review_state CAS 競合解決ポリシー**（DB v2 Q4）: **bounded retry N 回（read→merge→retry）、超過で typed conflict error（後勝ち禁止）に確定**。SP-3 の acceptance に機械検証可能な形で固定（リトライ上限/typed error）。
- **consistency-doctor を follow-up にしない**: FK を張らない設計（P1-1）は doctor による orphan/hitch_id 整合 check とセット（design-db-persistence §3.4/§8-#8）。SP-2 直後の **SP-3D で orphan + hitch_id 整合を DB 基盤内**に置き、refute hash 再計算 check は SP-16 で拡張する。
- **normalizeChangeText 正規化規則の不変性**: 一度決めたら変えない（変えると既存 DB hash が invalid）。version を hash に含める設計を SP-16 で確定。
- **refute（案B-P2）を #229 に含めるか別 issue か**: openQuestions 参照。

## 8. 受け入れ（epic 全体）

各案ノートの受け入れ条件対応表（design-230 §8 / design-229 §8 / design-231 §8 / design-db-persistence §8）を全て満たす。v31 additive・後方互換、DB-only 監査表が export/import 非対象（fresh DB のみ空 / 既存 DB では残る）・backup 包含、provenance footprint 一貫、決定論集約の同入力→同出力、固定 mapping/close gate 不変の回帰緑、docs 同コミット更新。

---

## サブPhase build sequence（一覧）

| SP | title | traces | dependsOn | files | 受け入れ(完了定義) |
|---|---|---|---|---|---|
| SP-1 | **逐次 migration**: v32=#229 `review_refute_votes` CREATE / v33=#231 `phases.review_state_version` ALTER（v31 jury 3表は #230 出荷済・触らない）+ v32 のみ table-name 登録 | design-db-persistence §2.1/§3.1/§3.2/§3.4/§4 + DB v2 changeLog P1-1/P1-2/P2-3/P2-4/P3-1/migration連番。関数仕様 #229-P2「review_refute_votes table (**v32**)」P2-DB |  | src/db/migrations.ts<br>src/db/schema.ts<br>tests/unit/db/migrations.test.ts | v32/v33 が additive・後方互換（fresh と v31→v32→v33 upgrade 両方で適用、idempotent）。FK 一切無し（orphan 残置で doctor advisory 検出と両立）。**出荷済み v31 statements は一切変更しない**。**v32 の `V32_TABLE_NAMES`（`review_refute_votes`）のみ `ALL_TABLE_NAMES` 登録（v33 は phases ALTER で新 table 無し＝登録不要）**。関連 migration テスト + typecheck 緑。docs/specs/db.md 同コミット更新。 |
| SP-2 | **v32 `review_refute_votes` repository のみ**（footprint・**precomputed target_change_hash の append/list/dedupe**・存在/hitch一致 hard 検査）。**jury 2表 repository は #230 出荷済（`src/db/repositories/jury-classification-proposals.ts` 等）＝対象外**。**binding 検証/hash version は持たない（SP-16 所有）** | design-db-persistence §3.0②/§3.1/§3.5 + DB v2 changeLog P1-1/P1-2/P2-3/P2-4 + unresolved「finding_id を FK にしない→repository insert で hard reject」。関数仕様 #229-P2 ReviewRefuteVotesRepository。**CC8: refute UNIQUE = DB v2 business key `(run_id,target_change_hash,reviewer_id,prompt_sha256)`、FK 無し（gate-specs 1083/1099 の `REFERENCES reviewers`/3列 UNIQUE は廃止参照）** | SP-1 | src/db/repositories/review-refute-votes.ts<br>tests/unit/db/review-refute-votes.test.ts | review_refute_votes repository が footprint 規約に従い append-only insert。`target_change_hash` は**呼び出し側が事前計算した値をそのまま append/list/dedupe**（repository は normalize/hash しない）。dedupe は business key UNIQUE（refute は `(run_id,target_change_hash,reviewer_id,prompt_sha256)`）。存在 + hitch 一致を hard 検査（不一致 reject）。DB-only（export/import 非対象、backup 包含）。関連 repository テスト + typecheck 緑。 |
| SP-3 | review_state_json CAS 書込経路（updateReviewState / recordSpecApproval、review_state_version で transaction.immediate + CAS、**bounded retry N→typed conflict error**） | design-db-persistence §2.4/§3.3 + DB v2 changeLog P1-3/P3-2 + Q4(CAS 競合: A 案 bounded retry 確定)。関数仕様 #231 PhaseRepository.recordSpecApproval。実コード裏取り: phase-repository.ts add():70 .immediate() / transitionStatus():116 CAS と同方式 | SP-1 | src/roadmap/phase-repository.ts<br>tests/unit/roadmap/phase-repository-review-state.test.ts | review_state_json 書込経路が新設され、CAS（review_state_version + transaction.immediate）で lost-update を構造的に防ぐ。**CAS 競合は bounded retry（read→merge→retry 最大 N 回）、超過で typed conflict error（後勝ち禁止・fail-closed）**。specHash は app 層 canonical JSON。他 key 保全。関連テスト + typecheck 緑。docs（roadmap.md）は SP-23 で更新。 |
| SP-3D | consistency-doctor 整合 check（orphan proposal/vote/audit + hitch_id 整合 advisory）。refute hash 再計算 check は SP-16 後に拡張 | design-db-persistence §3.4（doctor）/§6 consistency/doctor/§8-#8。FK を張らない（P1-1）設計の必須セット（親 purge 後も行が残るので doctor が orphan を報告）。CC5: hitch_id 整合 = `(stored hitch_id) != (finding_id→hitch_findings.hitch_id join)` を advisory finding | SP-2 | src/db/consistency.ts<br>src/db/doctor.ts<br>tests/unit/db/doctor-consensus-integrity.test.ts | **※ jury 3表の orphan/hitch_id check は #230 出荷済（`jury-doctor-checks.ts`）。SP-3D は重複追加せず、v32 `review_refute_votes` 用の** orphan（finding_id/run_id/hitch_id が消えた refute 行。finding_id も advisory target として保持されるため対象に含む）+ hitch_id 整合 advisory check **のみ新設**。**refute `target_change_hash` の TS recompute 整合 check は SP-16（normalizeChangeText 確定後）に拡張**。repair DELETE は default dry-run + operator 承認 gate（破壊的・fail-closed、auto-DELETE しない）。関連 unit テスト + typecheck 緑。 |
| SP-4 | aggregateJuryVotes 純関数（型定義 + 決定論集約、float gate 無し） | 関数仕様 #230案A「jury決定論集約関数」WI-1/WI-2/WI-3。design-230 §3.1/§6.2。#228 N-dispatch P1-G(WI-1 型)。共有成果物（案A jury 配線が消費）。**CC5: jury 判定不能は scope 値 `unknown_inconclusive` ではなく `proposedScope='unknown'` + 別フィールド `proposalStatus`（DB v2 DDL `proposed_scope IN (in_scope,out_of_scope,unknown)` + `proposal_status IN (complete,timeout,parse_error,inconclusive)` と一致）** | SP-1 | src/hitch/types.ts<br>src/hitch/jury-aggregation.ts<br>tests/unit/hitch/jury-aggregation.test.ts | 純関数・決定論（同入力→同出力）。**unanimous は `proposals.length===3` かつ 全3票 `proposalStatus==='complete'` かつ proposedScope 全一致のみ**（lens 不足/第3 lens 欠落 = split、`proposalStatus!=='complete'` または `proposedScope==='unknown'` の混在 = split/escalate、fail-closed）。confidence を gate に使わない。型（JuryProposal{proposedScope:'in_scope'\|'out_of_scope'\|'unknown'; proposalStatus:'complete'\|'timeout'\|'parse_error'\|'inconclusive'} / JuryAggregate）追加。enum 値のみ使用（lens 3値 correctness/scope_fit/spec_adherence、proposedScope 3値）。reason は固定順の count 文字列（決定論テスト可）。関連 unit テスト + typecheck 緑。 |
| SP-5 | auditSeverity 純関数（advisory-only severity audit、固定 mapping 不変） | 関数仕様 #230案A「severity audit集約」WI-1/WI-10s/WI-11s。design-230 §3.2/§6.2 受け入れ条件②。safety: severity 自動降格禁止 | SP-4 | src/hitch/types.ts<br>src/hitch/severity-audit.ts<br>tests/unit/hitch/severity-audit.test.ts | advisory-only。harnessSeverity を絶対に変えない（固定 mapping review-integration.ts:291/310/330 が authoritative）。diverged/inconclusive は packet に escalate:true を記録するのみ。enforcement_mode 列を作らない。関連 unit テスト + typecheck 緑。 |
| SP-6 | HitchDecisionPacket 型 + formatter（buildJurySplitPacket / buildOperatorOriginPacket、recommended_next_action additive JSON） | 関数仕様 #228 N-dispatch WI-1/WI-6。design-230 §2.3/§3.3/§6.3。共有成果物（案A escalate packet + 案C は optional decisionPacketId 予約のみ） | SP-4 | src/hitch/types.ts<br>src/hitch/orchestrator-types.ts<br>src/hitch/decision-packet.ts<br>tests/unit/hitch/decision-packet.test.ts | HitchNextAction に optional decisionPacket?、HitchDecisionPacket(packetVersion:1) 型追加。formatter 2種。既存 reader 非破壊（additive）。migration 不要（recommended_next_action JSON）。関連 unit テスト + typecheck 緑。 |
| SP-7 | jury proposer（generateJuryProposals、3 lens 別プロンプト・DB非書込・fail-closed parse） | design-230 §3.1/§3.5 JuryProposerDeps contract/§6 WI-4/WI-5。関数仕様は jury runner 本体（決定論ゲート外の入力層） | SP-4 | src/hitch/jury-proposer.ts<br>tests/unit/hitch/jury-proposer.test.ts | generateJuryProposals が JuryProposerDeps（worktreePath/harnessRoot/logPaths/timeoutMs/parseSchema/auditDir/reviewerRunner）で 3体・入力専用 proposal を生成。DB が閉じた状態で走る前提。fail-closed。関連 unit テスト + typecheck 緑。 |
| SP-8 | classify runner 3フェーズ DB分離配線 + source filter + orchestrator packet 永続化（P1-1/P1-2/P2-1） | design-230 §3.1/§3.3/§4 WI-8/WI-9/WI-9b/WI-11/WI-11s/WI-12/WI-13。関数仕様 #228 N-dispatch WI-9b/P1-G/ClassifyRunnerResult。SP-2(jury repo 書込)/SP-5(severity)/SP-6(packet)/SP-7(proposer) を統合 | SP-2, SP-5, SP-6, SP-7 | src/hitch/orchestrator-runners.ts<br>src/hitch/orchestrator.ts<br>src/hitch/orchestrator-types.ts<br>src/hitch/convergence.ts | classify runner が async 3フェーズ化 + source filter(heuristic 前) + jury + aggregateJuryVotes + auditSeverity + packet。ClassifyRunnerResult を返す。orchestrator が escalate 前に packet を必ず永続化。既存 heuristic 確定パス不変。jury 提案/severity audit が DB 蓄積。関連 unit + integration テスト + typecheck 緑。 |
| SP-9 | 案A docs/specs + RACI + 回帰 + e2e（大Phase A gate） | design-230 §3.4 RACI/§4 WI-10/WI-14/WI-15/§6.5 回帰/§7 docs。受け入れ条件①〜④ | SP-8 | docs/specs/hitch-convergence.md<br>docs/specs/workflow.md<br>docs/specs/mcp.md<br>docs/specs/cli.md | hitch-convergence.md に jury flow(3フェーズ) + RACI 表(Accountable=人間1名) + 決定パケット format + severity precedence(mapping authoritative/jury advisory-only)。workflow/mcp/cli/db.md 更新。**フルスイート vitest + typecheck 緑、回帰禁止**。#230 受け入れ条件①〜④を Phase1 だけで満たす。 |
| SP-10 | profile review: schema + ReviewRule 解決（compileProfileReviewRule/resolveEffectiveRule/ReviewRuleCompileError）+ 全入口 thread（共有成果物） | 関数仕様 #229「profile→ReviewRule コンパイル・スレッド化」P1-A/P1-B/P1-C + #228 N-dispatch P1-A/P1-B/P1-C/P1-H。design-229 §3.1/§3.2/§4 P1-A/B/C/H。P0-1 fail-closed | SP-9 | src/project/schema.ts<br>src/core/review-rule.ts<br>src/project/run-project.ts<br>src/core/workflow-runner.ts | review: optional schema（zod enum + 意味検証）。**`ReviewRule`(top-level) に `maxReviewers?:number`、`ReviewRuleRequirement`(per-group) に `reviewerIds?:string[]` / `lensAxes?:string[]` を additive 追加（camelCase。YAML は top-level `max_reviewers` / requirement 内 `reviewer_ids`・`lens_axes` を compile マッピング＝design-229 §3.2 の profile 例の shape）し rule_json に serialize＝Phase 1a の C4 frozen-set + multiReviewerRequired compile gate がこれらで成立（codex #257。refute=SP-17 まで遅延しない）**。compile invalid=throw / 欠落=DEFAULT。reviewRuleResolution{rule,source,ruleSha256} が PreparedProjectRun→RunDomainCodingOpts→reviewed-run→orchestrator→MCP→CLI の全入口 thread。snapshot 凍結（profile 後編集は in-flight run に retroactive に効かない）。関連 unit + 入口別 integration テスト + typecheck 緑。 |
| SP-11 | ReviewerRepository.listByGroup + N-dispatch consensus 集約決定論（P1-D/P1-G） | 関数仕様 #228 N-dispatch P1-D/P1-G。design-229 §3.3/§3.6/§4 P1-D/P1-G。P2-determinism | SP-10 | src/db/repositories/reviewers.ts<br>src/core/review-processor.ts<br>src/core/reviewer-agent.ts<br>tests/unit/db/reviewers.test.ts | listByGroup 字句順 distinct。processConsensusModePath / recordConsensusReEvaluation の集約を固定順に。order independence test が summary まで検証。**P1-ISO（per-reviewer artifact 隔離・design-229 §3.4 step3.5）も本 SP で land**: runReviewerAgent の runDir/decisionPath/log を `runDir/reviewers/<path-safe id>/` per-reviewer subdir 化 + **prefix-aware** REVIEWER_WRITE_ALLOWLIST + reviewer の sandbox/worktreePath root を subdir に scope（共有 artifact の tamper baseline は runDir 全体維持・後続が先行 verdict を読めない。codex #257）。関連 unit テスト + typecheck 緑。 |
| SP-12 | orchestrator N reviewer dispatch + preflight + pending→stall catch 経路（P1-E/P1-a/P1-b） | 関数仕様 #228 N-dispatch P1-E。design-229 §3.4/§4 P1-E。P1-a(pending stall)/P1-b(allowOverwrite)/P2(dispatch 上限) | SP-11 | src/hitch/orchestrator-runners.ts<br>tests/integration/hitch-orchestrate-consensus.test.ts | consensus mode で N reviewer 逐次 dispatch（全 allowOverwrite:true、preflight で quorum 照合、不足は事前 escalate）→1回 processReviewDecision。pending throw を catch→cycle 記録→stall 直接評価（握り潰さない、harness-only 状態遷移）。**C4 部分失敗の安全ゲート（design-229 §I.2.4・RED C4a-g）も本 SP で land**: expected reviewer set freeze + frozen-set filter（集合外/stale 票を quorum/blocking に効かせない・processConsensusModePath と recordConsensusReEvaluation 両 call site）+ サイクル前 stale active を `superseded_at` で retire + per-reviewer clean 失敗=non-participant 継続/tamper=abort + recordConsensusReEvaluation の status guard+snapshot+insert を同一 immediate tx 内維持（frozen-set parse 失敗は tx 内 throw=fail-closed）。codex #257。latest-proposal 後方互換。関連 integration テスト + typecheck 緑。 |
| SP-13 | reviewed-run consensus rule 明示拒否（typed error、P1-d/P1-H） | 関数仕様 #228 N-dispatch P1-H。design-229 §3.4b/§4 P1-H。P1-d | SP-10 | src/core/reviewed-run-workflow.ts<br>tests/integration/cli-review-process.test.ts | reviewed-run が consensus(quorum>1) rule を検出したら ReviewWorkflowUnsupportedError を agent 起動前に throw（partial 実行を防ぐ）。N-dispatch helper 共有は follow-up。関連 integration テスト + typecheck 緑。 |
| SP-14 | 案B-1a docs/specs + 入口別 thread integration + 回帰（大Phase B gate） | design-229 §6/§7/§4 P1-F/P1-SPEC/P1-TEST。受け入れ条件(#229)対応表 | SP-12, SP-13 | src/cli/run.ts<br>docs/specs/project.md<br>docs/specs/workflow.md<br>docs/specs/db.md | project.md に review: schema（後方互換/不正=run 拒否）。workflow.md に N-dispatch/stall 経路/determinism。cli.md に reviewers list --group。future-features に Phase1a 実装済 + lens=1b/refute=P2 を記載。**フルスイート vitest + typecheck 緑、回帰禁止**。#229 1a 受け入れ条件（multi-reviewer consensus 実到達・集約決定論・回帰なし・spec 更新）を満たす（**これは 1a milestone gate＝#229 close ではない。#229 close は lens land=SP-15 まで必須。design-229 I.0/H1・codex #257**）。 |
| SP-15 | lens 別 prompt 配線（multi-lens 本物化、別 PR 推奨） | design-229 §3.0/§3.3b/§4 Phase1b(P1b-A/B/C)。P0-2。受け入れ条件 multi-lens | SP-14 | src/db/repositories/reviewers.ts<br>src/cli/run.ts<br>src/core/reviewer-agent.ts<br>src/hitch/orchestrator-runners.ts | reviewer metadata_json の lens_prompt を reviewer prompt に実注入。集約は依然 evaluateConsensus(決定論)、lens 自己申告は状態遷移根拠にしない。**lens_axes schema/round-trip + 決定論 MECE preflight（lens_axes ⊆ dispatch reviewer の lens・空/重複 lens reject）+ untrusted lens fence/provenance stamp（design-229 G1/C1・RED#13）も本 SP のゲートに含める**（close gate ゆえ lens_prompt 注入だけでは不十分・空/重複 lens で #229 を close させない。codex #257）。#229 multi-lens 受け入れ条件を満たす。**#229 の close は本 SP-15(lens land)完了が必須**（design-229 I.0/H1。SP-14 の大Phase B gate は 1a=multi-reviewer milestone であって #229 close ではない＝lens 未 land で #229 を close しない。codex #257）。関連テスト + typecheck 緑。**Phase1a と別 PR（人間批准事項、下記 openQuestions）**。 |
| SP-16 | refute target binding data model + normalizeChangeText / targetChangeHash / verifyRefuteBinding（Phase 2-0、binding/hash version の単一所有者） | 関数仕様 #229 Phase2「反証 verify」P2-0。design-229 §3.5/§4 P2-0。P1-e。DB v2 付録B(normalize 規則不変)。refute 表は SP-1 で建立済・precomputed hash の append/list は SP-2 で実装済（binding は本 SP が所有）。**CC8: `verifyRefuteBinding` は `input.refuteVote.target_change_hash === targetChangeHash(change.change_text)` で比較（vote の hash を再ハッシュしない）。required changes の集約源は `ReviewProposalRow.requiredChanges`（`ConsensusSummary.proposals` に requiredChanges は無い）** | SP-2, SP-15, SP-3D | src/core/review-rule.ts<br>src/core/refute-binding.ts<br>src/db/doctor.ts<br>tests/unit/core/refute-binding.test.ts | normalizeChangeText/targetChangeHash/verifyRefuteBinding を app 層に実装（SP-2 repository は本 SP の `targetChangeHash` 出力を precomputed 値として受け取るだけ）。正規化規則は決定論・whitespace/case/punctuation を網羅テスト。binding 検証 = `verifyRefuteBinding({refuteVote, activeRequiredChanges})` が vote の `target_change_hash` を active change の `targetChangeHash(change_text)` と等値比較（再ハッシュしない、CC8）。positive binding test（一致→bound:true）+ mismatch test（不一致→bound:false, reason）。fail → errors list（**participant proposal は insert しないが、review_refute_votes に validation_status='rejected' + reject_reason の audit 行は書く**＝design-db §3.1 / future-features の fail-closed 監査 trail。codex #257）。normalize version を hash に含める（または migration rehash 方針を確定）。**SP-3D の refute hash 整合 doctor check を本 SP で拡張**（TS で `targetChangeHash(normalizeChangeText(change_text))` 再計算）。関連 unit テスト + typecheck 緑。 |
| SP-17 | refute requirement rule DSL + runRefuteAgent + evaluateConsensus 第2 requirement（P2-A/P2-B/P2-C） | 関数仕様 #229 Phase2 P2-A/P2-B/P2-C。design-229 §3.5/§4 P2-A/B/C。severity 経由しない決定論集約。**CC2: `ReviewRule.maxReviewers`(top-level) と `ReviewRuleRequirement.reviewerIds?`/`lensAxes?`(per-group) の additive は SP-10(Phase 1a)で実装済（本 SP は再定義しない・codex #257）。CC3: refute quorum/集約は preflight だけでなく `processConsensusModePath`/`evaluateConsensus` の決定論ゲート内で再評価（1票=100% 防止）** | SP-16 | src/core/review-rule.ts<br>src/project/schema.ts<br>src/core/reviewer-agent.ts<br>src/core/refute-agent.ts | refute requirement DSL（profile review.refute、snake→camel は compile で明示マッピング）+ runRefuteAgent（distinct registered reviewer_id、binding 検証 fail→escalate に積み、**review_proposals/participant は非 insert だが review_refute_votes に validation_status='rejected'+reject_reason の audit 行は書く**＝design-db §3.1 監査 trail・codex #257）+ evaluateConsensus 第2 requirement（target-bound、**厳密 majority: refute 票数 > 過半でのみ advisory 降格、同数=tie は降格しない=fail-closed。`>= threshold` ではなく strict `>`**、severity フィールド非経由、expected-status guard(needs_review) 通過、quorum を決定論ゲート内で再評価して 1票=100% を防ぐ）。Codex 実行中は短い immediate transaction を保持しない（既存 consensus promotion 流儀）。関連 unit テスト + typecheck 緑。 |
| SP-18 | orchestrator refute dispatch + advisory 反映 + docs + 回帰（大Phase B'' gate） | 関数仕様 #229 Phase2 P2-D/P2-SPEC。design-229 §4 P2-D/P2-SPEC/§7。冪等性・quorum fail-closed | SP-17 | src/hitch/orchestrator-runners.ts<br>src/core/review-processor.ts<br>docs/specs/hitch-convergence.md<br>docs/future-features.md | orchestrator が rule.refute 定義時に refute group dispatch → review-processor で advisory 反映。quorum 未達は blocking 維持（fail-closed）。severity 経由しない。冪等。hitch-convergence.md に refute verify 仕様。**フルスイート vitest + typecheck 緑、回帰禁止**。#229 refute 受け入れ条件（第2 consensus requirement 経路の決定論テスト）を満たす。 |
| SP-19 | spec-gates 抽出 + gap→kind 写像 + validateCloseConditions（共有 spec-gates + 純ロジック） | 関数仕様 #231 WI.4a/WI.1/WI.2/WI.3。design-231 §3.2/§3.3/§3.4/§4 SP-A。P2-2(spec-gates 共用)/P1-2(bare-id)/P2-1(operationId)/P3-1(rule.count) | SP-18 | src/hitch/spec-gates.ts<br>src/hitch/repository.ts<br>src/hitch/gap-to-kind.ts<br>src/hitch/spec-validation.ts | spec-gates.ts に isScopeWidening/closeConditionsLoosenGate 抽出（hitch/phase 共用、repository.ts は import 化、挙動不変）。gap-to-kind TOTAL 写像（fail-closed REJECT）。validateCloseConditions（HARD error + ADVISORY warning、kind 分類表）。HitchValidationError 追加。関連 unit テスト + typecheck 緑。 |
| SP-20 | write barrier 接続（createSession choke point / expand_scope update path / phase updateSpec） | 関数仕様 #231 WI.4/WI.4b/WI.5。design-231 §3.4/§4 SP-B。P1-3(createSession)/P1-4(expand_scope)/fail-open 修正 | SP-19, SP-3 | src/hitch/repository.ts<br>src/mcp/tools/hitch-tools.ts<br>src/roadmap/phase-repository.ts<br>src/cli/course.ts | createSession 内に parse+validator 埋込（真の choke point）。expand_scope を updateSessionConfig 経由化（isScopeWidening gate 継承）。PhaseRepository.updateSpec() 新設 + add() validator 経由 + course phase update raw SQL 撤去。MCP も同 path 継承。関連 integration テスト + typecheck 緑。 |
| SP-21 | phase ratify（recordSpecApproval）+ link/start-hitch 整合 gate + specHash drift | 関数仕様 #231 WI.6/WI.6a。design-231 §3.5/§3.7/§4 SP-C。P1-1(批准 spec 強制)/P3-2(namespaced key)。SP-3 の recordSpecApproval を消費 | SP-20, SP-3 | src/cli/course.ts<br>src/mcp/tools/course-tools.ts<br>src/roadmap/phase-repository.ts<br>tests/integration/phase-ratify.test.ts | course phase ratify（--approved-by 必須、recordSpecApproval で specApproval namespaced + specHash）。link-hitch/新 start-hitch に phase 批准 spec ↔ hitch spec 同一/厳格化チェック（spec-gates.ts 共用、緩和は gate flag 必須、未 ratify phase は skip）。specHash drift warning。orchestrator 不変。関連 integration テスト + typecheck 緑。 |
| SP-22 | runtime spec drift 診断（ask_human message enrichment） | 関数仕様 #231 WI.7。design-231 §3.7/§4 SP-C/§6 R14 | SP-21 | src/hitch/convergence.ts<br>tests/unit/hitch/convergence-drift.test.ts | convergence の escalate(ask_human) message に spec drift 診断を enrich（required 外部証拠条件の pending サイクル数 + specHash drift）。決定論ゲートのロジック自体は不変（message 強化のみ）。関連 unit テスト + typecheck 緑。 |
| SP-23 | 案C docs/specs（spec-review-layer / spec-draft-and-review / cli / hitch-convergence / roadmap / GOAL_RULES）+ 後方互換回帰（大Phase C gate） | 関数仕様 #231 WI.8。design-231 §7/§6.3 回帰/§8。R15/R16/R17。DB v2 docs(db.md v31 節 / footprint 規約) | SP-21, SP-22 | docs/specs/spec-review-layer.md<br>docs/workflows/spec-draft-and-review.md<br>docs/specs/cli.md<br>docs/specs/hitch-convergence.md | spec-review-layer.md（既存 docs/design reuse、gap→kind 写像表、kind 選択 tree、ratify ceremony、phase↔hitch 整合、案A 連携 optional decisionPacketId）+ spec-draft-and-review.md（NGT/Delphi harness 外）+ cli/hitch-convergence/roadmap/db.md + GOAL_RULES（spec-gates 共用 / footprint 規約 / severity advisory-only）。**フルスイート vitest + typecheck 緑、回帰禁止**。#231 受け入れ条件を満たす。 |

### 各SPの RED テスト

**SP-1 逐次 migration（v32=#229 `review_refute_votes` CREATE / v33=#231 `phases.review_state_version` ALTER。v31 jury 3表は #230 出荷済・不変）+ ALL_TABLE_NAMES union**
- migration: MIGRATIONS に version:32(#229)/33(#231) が version 順・name・statements 非空、LATEST_SCHEMA_VERSION=33
- migration: fresh DB v1→v33 後 schema_migrations に 33 行、`review_refute_votes`(v32) が PRAGMA table_info で存在、phases に review_state_version 列(v33・DEFAULT 0)
- migration: v31→v32→v33 upgrade で既存 jury/review/hitch テーブル無変更・既存 phase 行に review_state_version=0
- migration: idempotent（2回目 run は no-op）
- migration: ALL_TABLE_NAMES に V32 名（`review_refute_votes`）が含まれ重複なし（v33 は phases ALTER のみ＝新 table 名登録なし）、DROPPED_TABLE_NAMES 維持（V31 名は #230 出荷分で登録済）
- DDL: v32 `review_refute_votes` に FK 句が無い（REFERENCES 不在）・append-only audit・confidence BETWEEN 0 AND 1 CHECK。**（jury severity CHECK=P0,P1,P2,P3,info / proposed_scope=in_scope/out_of_scope/unknown / proposal_status 別列 / escalate_flag IN(0,1) は #230 v31 出荷分のテストで担保済＝本 SP 対象外）**
- DDL: business key UNIQUE。**refute は単一 UNIQUE ではなく partitioned partial unique（passed participant `(run_id,target_change_hash,reviewer_id,prompt_sha256) WHERE validation_status='passed' AND refute_verdict IN('uphold','refute')` / inconclusive 同4キー `WHERE ...refute_verdict='inconclusive'` / rejected `(...,source_sha256) WHERE validation_status='rejected'`）＝design-db §3.1。inconclusive→uphold/refute 遷移と rejected retry を許す（codex #257）** / jury:(finding_id,lens,reviewer_id,prompt_sha256) / severity:(finding_id,prompt_sha256)。UNIQUE(created_at) は使わず INDEX のみ、finding_id index あり、nullable usage_kind/usage_seq 列あり

**SP-2 v32 `review_refute_votes` repository のみ（jury 2表 repo は #230 出荷済＝対象外）footprint・precomputed target_change_hash の append/list/dedupe・存在/hitch一致 hard 検査**
- ReviewRefuteVotesRepository.insert: footprint 列を全て書く / listByRun / listByTarget(runId,targetHash)。`target_change_hash` は呼び出し側が事前計算した値をそのまま保存（repository は normalize/hash しない）
- insert: **passed participant(uphold/refute)** の同 (runId,targetHash,reviewerId,prompt_sha256) を2回 → partial unique 違反で2行目 dedup。**inconclusive→uphold/refute は別 predicate で衝突せず共存・rejected は source_sha256 違いで共存**（partitioned partial unique・design-db §3.1・codex #257）（gate-specs の3列 UNIQUE は採用しない）
- insert: finding_id が存在しない → hard reject（fail-closed、doctor 待ちにしない）
- insert: hitch_id（denormalized advisory）が finding_id→hitch_findings.hitch_id と不一致 → reject
- DDL 整合: refute 表に `REFERENCES reviewers` 等の FK が無い（PRAGMA foreign_key_list 空。gate-specs 1083 の FK は廃止）
- round-trip: db export-files で 3表は file 化されない（DB-only）。db import --from-files 後、既存 DB では 3表行は残る／fresh DB のみ空。既存 runs/review_decisions/required_changes は正常 round-trip
- provenance: (run_id,usage_kind,usage_seq) で run_usage と一意 JOIN（FK 無し）

**SP-3 review_state_json CAS 書込経路（updateReviewState / recordSpecApproval、review_state_version で transaction.immediate + CAS、bounded retry N→typed conflict error）**
- updateReviewState: read-modify-write が他 key を保全（既存 review_state_json の非 specApproval key が残る）
- recordSpecApproval: {specApproval:{approvedBy,approvedAt,reason,specHash}} を namespaced 書込・read-back、specHash = sha256(canonical(scope)+canonical(close)) を TS で計算
- CAS: review_state_version をインクリメント、WHERE review_state_version=? で楽観ロック。version 不一致で書込失敗（後勝ち禁止）
- CAS 競合ポリシー: stale version 衝突を bounded retry（read→merge→retry 最大 N 回）で吸収、N 超過で **typed conflict error を throw（後勝ち禁止・fail-closed）**。retry 内で他 key を消さない
- 後方互換: review_state_json=null または specApproval 無しの phase が deserialize OK、updateReviewState で初期化される
- **既存 writer の CAS 統一**: `setNote()`（`phase-repository.ts:131-144` の note 用 review_state_json RMW・現状 `.immediate()`/CAS なし）も同 CAS 経路（`review_state_version` bump + `transaction.immediate`）へ移行し、setNote↔specApproval 間の lost-update を塞ぐ（design-db §2.4）

**SP-3D consistency-doctor 整合 check（orphan proposal/vote/audit + hitch_id 整合）**
- consistency RUNTIME 列挙に `review_refute_votes`(v32) が出ない（export drift 非対象。jury 3表は #230 出荷分でカバー済）
- orphan: finding_id/run_id/hitch_id が消えた `review_refute_votes`(v32) 行 → advisory finding（finding_id も advisory 列なので対象。FK 無しで親 purge 後も残る = append-only 監査）
- hitch_id 整合: stored hitch_id != finding_id→hitch_findings.hitch_id join → advisory finding（CC5）
- repair DELETE は default dry-run + --apply 必須（破壊的・operator 承認 gate、auto-DELETE しない）
- refute `target_change_hash` の TS recompute 整合 check は本 SP に**含めない**（SP-16 で normalizeChangeText 確定後に拡張）

**SP-4 aggregateJuryVotes 純関数（型定義 + 決定論集約、float gate 無し）**
- aggregate-deterministic: 同一 proposals × 2回 → 同一 JuryAggregate
- aggregate-unanimous-confirms: 全3票 proposedScope=in_scope ∧ proposalStatus=complete → unanimous/in_scope; 全3票 out_of_scope → unanimous/out_of_scope
- aggregate-unanimous-requires-three: proposals.length===3 かつ全 proposalStatus=complete のみ unanimous（第3 lens 欠落 = split、fail-closed）
- aggregate-no-float-gate: confidence を変えても decision 不変
- aggregate-split-2v1: in_scope(2) vs out_of_scope(1) → split, scope=undefined
- aggregate-split-1v1v1: in_scope/out_of_scope/unknown 各1 → split
- aggregate-split-unknown-scope: proposedScope='unknown' が混在 → split（fail-closed）
- aggregate-split-incomplete-status: proposalStatus∈{timeout,parse_error,inconclusive} が混在 → split/escalate（CC5: unknown_inconclusive という scope 値は使わない）
- aggregate-split-insufficient: proposals.length<2 OR >3 → split
- aggregate-reason-deterministic: reason は固定順の count 文字列（同入力→同文字列）

**SP-5 auditSeverity 純関数（advisory-only severity audit、固定 mapping 不変）**
- audit-deterministic: 同一 context × 2回 → 同一 SeverityAuditResult
- audit-aligned: jury majority = harness → aligned, escalate=false, harnessSeverity 不変
- audit-diverged: jury majority ≠ harness → diverged, escalate=true, harnessSeverity 不変, juryConsensus=majority
- audit-inconclusive: jury 票不一致 → inconclusive, escalate=true, juryConsensus=undefined
- audit-no-severity-mutation: diverged/inconclusive でも return.harnessSeverity === input.harnessSeverity

**SP-6 HitchDecisionPacket 型 + formatter（buildJurySplitPacket / buildOperatorOriginPacket、recommended_next_action additive JSON）**
- packet-has-integrated-fields: split packet が recommendation/evaluationAxes(3軸 lensVotes)/rejectedProposals/minorityView/riskFlags/unvalidatedAssumptions/nextActions(owner=operator)/severityAudit? を満たす
- packet-additive-backward-compat: kind/message/findingIds 従来通り保持、decisionPacket optional、message に JSON を詰めない
- packet-roundtrip: JSON.stringify/parse で loss なし、既存 decisionPacket===undefined 行が parse OK
- operator-origin: buildOperatorOriginPacket が decisionKind='operator_origin_unknown'

**SP-7 jury proposer（generateJuryProposals、3 lens 別プロンプト・DB非書込・fail-closed parse）**
- proposer: 3 lens(correctness/scope-fit/spec準拠)別プロンプトで dispatch、DB を書かない
- fail-closed: exitCode≠0 / timedOut / parse 失敗 / context 欠如 → その lens を `proposedScope='unknown'` + `proposalStatus∈{timeout,parse_error,inconclusive}`（CC5: `unknown_inconclusive` という scope 値は使わず status 列で表す。DB v2 DDL と一致）
- proposer: logPaths(jury/<hitch>/<finding>/<lens>.{stdout,stderr,events}) と auditDir に raw log + parsed proposal を保存
- proposer: events/stdout から JuryProposalSchema で厳格 parse（{lens, proposedScope, proposalStatus, reasoning, confidence?, severity?}、CC1: 内部は camelCase）

**SP-8 classify runner 3フェーズ DB分離配線 + source filter + orchestrator packet 永続化（P1-1/P1-2/P2-1）**
- 3フェーズ DB分離: snapshot(同期)→DB閉→jury(await)→DB再open再検証。jury 実行中 DB handle 解放(jury-runs-with-db-closed)
- operator-origin-unknown-skips-heuristic-and-jury: source=mcp/human の unknown → heuristic も jury も通らず即 escalate(packet decisionKind=operator_origin_unknown)
- unanimous → repo.classifyFinding(再検証後のみ) / split → {resolved:false, decision:escalate, recommendedNextAction.decisionPacket}
- stale-finding-skipped-on-reopen: jury 実行中に他経路で分類された finding は Phase3 で skip
- WI-9b: orchestrator が classify 失敗時 recordConvergenceDecisionWithStatus(decision:escalate + decisionPacket) を呼んでから return → DB の recommended_next_action.decisionPacket に永続化(read-back assert)
- jury proposal/severity audit 行が SP-2 repository 経由で DB に append される（監査）
- benign-unknown-rescued-by-unanimous-jury: heuristic unknown → fake 3体 unanimous → 自動分類・escalate されない

**SP-9 案A docs/specs + RACI + 回帰 + e2e（大Phase A gate）**
- regression-p0-escalates-before-jury / regression-budget-exhausted / regression-diverging: jury 不通過で従来通り
- regression-heuristic-confirmed-bypasses-jury: heuristic in_scope → jury 非起動
- regression-fixed-severity-unchanged: required_change=P1/non_blocking=P2 不変、severity audit は escalate flag のみ
- regression-close-gate-unchanged: severity 自動降格なし → close gate(convergence.ts:702-708) 不変
- WI-10: convergence 直接 escalate 経路(P0 等)にも decisionPacket additive 付与可能(既存挙動不変)
- regression-existing-suites-green: フルスイート緑（fixture-matrix は convergence-only）

**SP-10 profile review: schema + ReviewRule 解決（compileProfileReviewRule/resolveEffectiveRule/ReviewRuleCompileError）+ 全入口 thread（共有成果物）**
- compileProfileReviewRule: invalid quorum.minParticipants=0 / mode=consensus+requirements=[] → throw ReviewRuleCompileError（DEFAULT に落ちない）
- resolveEffectiveRule: profile.review=undefined → DEFAULT/source='default'（後方互換）
- resolveEffectiveRule: valid profile.review → compiled/source='project-profile'、ruleSha256 一致
- determinism: 同 profile 入力 → 同 ruleSha256 × 2回
- ProjectProfileSchema: review 欠落 profile が通る（後方互換）、top-level count は .strict() で reject
- CLI run --project: source='project-profile' snapshot が run_review_rule_snapshots に凍結
- MCP orchestrate: prepared.reviewRuleResolution.source='project-profile'
- workflow-runner: review 宣言済 run で snapshot 失敗時 hard error（fail-closed、握り潰さない）

**SP-11 ReviewerRepository.listByGroup + N-dispatch consensus 集約決定論（P1-D/P1-G）**
- listByGroup: [bob,alice,charlie] 登録 → [alice,bob,charlie] reviewer_id 字句順 distinct、空 group → []
- consensus 集約決定論: proposals/includedRows/sourceProposalIds を reviewer_id,proposal_id 昇順に固定。挿入順/dispatch 順を入替えても required_changes ∧ summary.proposals ∧ sourceProposalIds 同一
- enrichRows: 未登録 reviewer → groupId=null → per-group check を落とす（安全方向）

**SP-12 orchestrator N reviewer dispatch + preflight + pending→stall catch 経路（P1-E/P1-a/P1-b）**
- RED-4: consensus rule(quorum=2) + 2 reviewer 登録 → runReviewerAgent 2回(alice,bob) → 2 active proposal → processReviewDecision 1回 → run.status=approved
- RED-7b: 既存 active proposal 1件あっても全 allowOverwrite:true で 2体目まで dispatch が落ちない。preflight が expected/registered/quorum 照合
- RED-8: quorum=2, 1体のみ approved → ReviewGateError(pending) catch → cycle 記録 → evaluateConsensusStallForHitch 直接呼び。pending review_consensus 行が timeline に蓄積(DB assert)
- RED-9: preflight escalate reason に group=reviewers,required=2,registered=1 を含む
- latest-proposal(DEFAULT)後方互換: review 欠落 → 1体 dispatch、最新 proposal で promote

**SP-13 reviewed-run consensus rule 明示拒否（typed error、P1-d/P1-H）**
- RED-10b: consensus rule の run を reviewed-run に流すと ReviewWorkflowUnsupportedError で agent 起動前に拒否
- override × consensus: per-run override が consensus を short-circuit する挙動

**SP-14 案B-1a docs/specs + 入口別 thread integration + 回帰（大Phase B gate）**
- RED-7c: 入口別 thread — CLI run / reviewed-run prepare / MCP orchestrate / hitch CLI 各入口で source='project-profile' snapshot 凍結
- evaluateConsensus 回帰: tie-break/override/latest-proposal/quorum/staleness、proposal 配列順入替で status 不変
- reviewers list --group(listByGroup) / add --group の spec 整合

**SP-15 lens 別 prompt 配線（multi-lens 本物化、別 PR 推奨）**
- metadata_json.lens/lens_prompt を CLI で設定可能
- runReviewerAgent に lensPrompt/reviewerName を prompt 注入、promptSha256/prompt_provenance に lens 反映
- 異 lens_prompt の alice/bob → 各 proposal の prompt_sha256 が異なり集約は決定論(order 非依存)

**SP-16 refute target binding data model + normalizeChangeText / targetChangeHash / verifyRefuteBinding（Phase 2-0、binding/hash version の単一所有）**
- normalizeChangeText preserves semantic identity: targetChangeHash('add validation') === targetChangeHash('  ADD VALIDATION  ')
- verifyRefuteBinding positive: `verifyRefuteBinding({refuteVote:{target_change_hash}, activeRequiredChanges:[{idx,change_text}]})` で `target_change_hash === targetChangeHash(change_text)` → {bound:true, boundToIdx}（CC8: vote の hash を再ハッシュしない）
- verifyRefuteBinding rejects mismatched target hash: 不一致 → {bound:false, reason:'does not match'}
- normalize 規則の不変性 regression: 定義変更で古い hash と新 hash が食い違わないか（version を hash に含める設計を検証）
- doctor hash 整合 拡張: SP-3D の doctor check に refute `target_change_hash` の TS recompute（`targetChangeHash(normalizeChangeText(change_text))`）整合 advisory を追加

**SP-17 refute requirement rule DSL + runRefuteAgent + evaluateConsensus 第2 requirement（P2-A/P2-B/P2-C）**
- `ReviewRule.maxReviewers`(top-level) と `ReviewRuleRequirement.reviewerIds`/`lensAxes`(per-group) の additive は **SP-10(Phase 1a)で実装済**（CC2・codex #257。Phase 1a の C4 frozen-set/compile gate が依存するため refute まで遅延しない。design-229 §3.2 の profile shape）。本 SP は refute 専用 DSL（`review.refute`）を追加するのみ
- evaluateConsensus drops required_change when refute > 過半: 2x refute + 1x uphold（refute 2 > 過半 1.5）→ summary.refuteDropped に含まれ blockingRequiredChanges から除外
- refute strict-majority gate: refute 票数 > 過半（厳密 `>`）でのみ降格。**tie（refute==uphold、例 1 refute + 1 uphold）は降格しない = blocking 維持（fail-closed、`>= threshold` 不可）**
- refute vote <過半 keeps blocking: 1 refute + 2 uphold（33%）→ blocking 維持
- refute quorum re-verified in deterministic gate: 1票のみ（quorum 未達）では 100% 扱いにならず blocking 維持（CC3: preflight だけでなく processConsensusModePath/evaluateConsensus 内で再評価）
- 集約源は ReviewProposalRow.requiredChanges（CC8: ConsensusSummary.proposals に requiredChanges は無い）
- runRefuteAgent binding verification fail → errors list、participant は inserted=[]（review_proposals 非書込）。**review_refute_votes には validation_status='rejected' + reject_reason の audit 行を書く（'DB row 未書込' にしない＝design-db §3.1 / future-features の fail-closed 監査 trail。codex #257）**
- determinism: proposal 順を入替えても summary.refuteDropped 同一
- advisory 降格は required_changes 除外で表現（severity フィールドを一切経由せず finding.severity を直接 UPDATE しない）

**SP-18 orchestrator refute dispatch + advisory 反映 + docs + 回帰（大Phase B'' gate）**
- orchestrator dispatch refute group when rule.refute defined: 各登録 reviewer に runRefuteAgent
- refute requirement quorum not met → blocking stays（fail-closed）
- refute→advisory が close gate severity に影響しない（finding P1 のまま、hitch_convergence_decisions 不変）
- required_changes advisory 降格の冪等性（一度落ちた change は blocking に戻らない、各 requirement 独立 >50%）

**SP-19 spec-gates 抽出 + gap→kind 写像 + validateCloseConditions（共有 spec-gates + 純ロジック）**
- R16: isScopeWidening/closeConditionsLoosenGate 抽出が抽出前と同一判定（代表 matrix、挙動不変）
- R2: gap→kind TOTAL 写像（auto/external パターン → 正 kind、写像不能 → error、沈黙 manual default しない）
- R1: schema 7 kind 通過、top-level count reject、rule.count は schema 通過（validator が R4 で hard error）
- R3: command bare-id 解決（一意→valid、0件/複数件→hard error）
- R4: finding_policy rule whitelist（maxOpen* のみ valid、count:0/負数→hard error）
- R5: external kind 必須 field（description/path/operationId 欠落→hard error）
- R6: db_doctor required:true → hard error
- R7: duplicate condition id → hard error
- R8: NL keyword ミスマッチは advisory warning（hard error にしない）

**SP-20 write barrier 接続（createSession choke point / expand_scope update path / phase updateSpec）**
- R10c: createSession に未検証(parse 前)の不正 scope/closeConditions を直接渡す → validator/parse で reject（CLI 事前 parse 非依存）
- R10b: MCP expand_scope → updateSessionConfig 経由（widen gate 継承、raw UPDATE 撤去）
- R10: course phase update / add / MCP phaseAddTool に不正 closeConditions → DB 未書込、validator error
- R11: 自動ゲート kind が ask_human に化けない（command runnable / manual→external）

**SP-21 phase ratify（recordSpecApproval）+ link/start-hitch 整合 gate + specHash drift**
- R12: phase ratify --approved-by → review_state_json.specApproval 書込・read-back、既存他 review key 保全。--approved-by 無し → reject
- R13b: ratified phase に緩める hitch を link/start → gate flag 無しは reject、tightening → pass、specHash drift → warning
- R13: locked phase override gate（hitch start で gate 緩和は --allow-gate-loosen/--allow-scope-widen 必須）

**SP-22 runtime spec drift 診断（ask_human message enrichment）**
- R14: required external-evidence 条件が N サイクル pending → ask_human メッセージに 'condition X kind=manual pending N cycles' + specHash drift があればその旨を含む

**SP-23 案C docs/specs（spec-review-layer / spec-draft-and-review / cli / hitch-convergence / roadmap / GOAL_RULES）+ 後方互換回帰（大Phase C gate）**
- R15: dashboard-demo hitches の closeConditions(bare-id command 含む)を validator に通して pass
- R17: review_state_json=null または specApproval 無しの phase が deserialize OK、validator/ratify/linkHitch 後も require/get/list 成功
- R16(回帰): convergence.decide()/requiredPendingCloseCheckRouting() 挙動不変、spec-gates 判定が抽出前と同一

---

## クリティカルパス

SP-1 → SP-2 → SP-3D → SP-4 → SP-5 → SP-6 → SP-7 → SP-8 → SP-9 → SP-10 → SP-11 → SP-12 → SP-14 → SP-15 → SP-16 → SP-17 → SP-18 → SP-19 → SP-20 → SP-21 → SP-22 → SP-23

> SP-3D（consistency-doctor）は SP-2 後・SP-16（refute hash 整合 check 拡張）の前提として DB 基盤内に置く。SP-23 は SP-22（runtime spec drift 診断）に依存するため criticalPath に SP-22 を明示する（P3 fix）。

## 共有成果物（所有 SP）

- migration（逐次）: v31=#230 jury 3表（出荷済）/ v32=#229 `review_refute_votes` / v33=#231 phases.review_state_version ALTER（各版 SCHEMA_VERSION bump + Vxx_TABLE_NAMES union）→ 所有 SP-1。consumer: 案B-P2(refute 表=v32)/案C(review_state_version=v33) ※案A jury は出荷済
- provenance footprint 規約（run_id/hitch_id/finding_id/reviewer_id/model/prompt_sha256/prompt_provenance_json/usage_kind/usage_seq、(run_id,usage_kind,usage_seq) で run_usage 一意 JOIN、FK 張らない）→ 所有 SP-1(DDL)+SP-23(docs)。consumer: 全合議行(SP-2/SP-8/SP-17)
- review_state_json CAS 書込経路（updateReviewState / recordSpecApproval、review_state_version + transaction.immediate + CAS、競合 = bounded retry N→typed conflict error）→ 所有 SP-3。consumer: 案C specApproval(SP-21)
- consistency-doctor 整合 check（orphan proposal/vote/audit + hitch_id 整合 = stored vs finding_id→join、FK を張らない設計の必須セット、非破壊 repair gate）→ 所有 SP-3D（orphan + hitch_id）+ SP-16（refute hash 再計算 check 拡張）。consumer: DB 基盤の append-only 監査保証
- refute target binding / hash version（normalizeChangeText / targetChangeHash / verifyRefuteBinding + normalize version 方針）→ 所有 SP-16。consumer: 案B-P2 refute(SP-17/SP-18)、SP-3D の hash 整合 check 拡張。**SP-2 は precomputed target_change_hash の append/list/dedupe のみ（binding 検証は持たない）**
- ReviewRule 解決（compileProfileReviewRule / resolveEffectiveRule(profile?) / ReviewRuleCompileError / reviewRuleResolution 全入口 thread）→ 所有 SP-10。consumer: 案B-1a consensus 本体(SP-11/SP-12/SP-13)、案B-P2 refute requirement(SP-17)
- HitchDecisionPacket 型 + formatter（buildJurySplitPacket / buildOperatorOriginPacket、recommended_next_action additive JSON）→ 所有 SP-6。consumer: 案A escalate packet(SP-8)、案C optional decisionPacketId 予約のみ(SP-23 docs)
- aggregateJuryVotes 純関数（決定論集約、float gate 無し）→ 所有 SP-4。consumer: 案A jury 配線(SP-8)
- spec-gates.ts（isScopeWidening / closeConditionsLoosenGate を repository.ts private から抽出、hitch/phase 共用）→ 所有 SP-19。consumer: 案C phase updateSpec(SP-20) / link-hitch 整合(SP-21)

## 人間批准が要る点

### Q1. #229 Phase1b（lens 別 prompt 配線 = SP-15）を Phase1a（SP-10〜14）と同一 PR にするか、別 PR にするか。#229 受け入れ条件文言は 'multi-lens' だが Phase1a 単独では同一 prompt の N reviewer（multi-reviewer）止まり。
推奨: 別 PR を推奨（design-229 付録H H1）。1a（reachable consensus）は prompt 配線を含まず独立にレビュー可能で land リスクが低い。1a の受け入れ条件は 'multi-reviewer consensus が quorum>1 実到達' と正直に表現し、#229 を閉じる前に 1b まで land して 'multi-lens' を満たす。誇張（1a 完了時点で multi-lens 達成と書く）は避ける。本ロードマップは SP-15 を独立 SP として別 PR を前提に構成済み。

### Q2. refute verify（#229 Phase 2 = SP-16〜18）を #229 のクローズ条件に含めるか、別 issue に切り出すか。受け入れ条件は '反証 verify が finding を advisory に降格できる経路のテスト' を含むが、安全な機構は P2-0(target binding data model) の追加設計を要し proven core(Phase1) と分離して land すべき。
推奨: 別 issue 切り出しを推奨（design-229 付録H H2）。Phase1(a+b)だけで主要受け入れ条件（quorum>1 実到達・異レンズ集約決定論・回帰なし・spec 更新）を満たし独立にレビュー可能。refute は SP-16 の target binding data model が前提。ただし #229 を Phase1 で閉じ refute を新 issue にするか #229 を Phase2 まで開き続けるかは人間批准事項。本ロードマップは SP-16〜18 を独立サブ大Phase(B'')として後置し、どちらにも対応できる構成。

### Q3. 共有 v31 migration（SP-1）の PR merge 順をどう強制するか。#229/#230/#231 が全て v31 を共有する（DB v2 Q3 確定: 単一 v31 ブロック案A）ため、並行ブランチ着地時の番号衝突（v29↔v30 renumber 痛の既往）リスク。
**推奨（2026-06-17 更新）**: 当初は単一 v31 ブロック案だったが、**#230 が v31 を単独出荷したため逐次採番に確定**: v31=#230（出荷済）→ v32=#229（`review_refute_votes`）→ v33=#231（`review_state_version`）。同一 version で 2 branch 同時 open を禁止（merge order ゲート）し、#229/#231 着手前に version を予約して番号衝突を防ぐ。**出荷済み v31 statements は不可侵**（後から CREATE/ALTER を足さない）。

### Q4. review_state_version CAS（SP-3）の競合解決ポリシー（DB v2 付録A Q5）: CAS 失敗時に bounded リトライ（read→merge→retry）で吸収するか、即エラーで fail-closed にするか。
**確定（v2 改訂、acceptance に固定）**: A 案（CAS + **bounded retry N 回（read→merge→retry）、超過で typed conflict error を throw・後勝ち禁止**）。add()/transitionStatus() の既存 CAS 流儀に揃う。現状 specApproval を書く writer は recordSpecApproval 1 経路のみで競合確率が低いため per-key merge 関数は writer 増加時まで defer。**この機械検証可能ポリシー（リトライ上限 N + typed conflict error）を SP-3 の acceptance/RED テストに固定し、operator 向け文言を docs 化する**（codex P2: 完了定義は機械検証可能であるべき → SP-3 開始前に確定済みとする）。

### Q5. finding_id を FK にしない（DB v2 P1-1/unresolved）ことで存在しない finding_id を持つ合議行を insert できる。repository insert 時の存在検査を hard reject にするか、doctor advisory に委ねるか。
推奨: repository insert で finding_id の存在 + hitch_id 一致を hard 検査して reject（fail-closed）、かつ doctor でも事後 orphan を advisory 検出する二重化を推奨。insert 検査だけだと後から親が purge された行を拾えず、doctor だけだと不正 insert を即時に止められない。**v2 改訂: doctor 整合（orphan + hitch_id）を follow-up にせず SP-2 直後の SP-3D（DB 基盤内）に置く**（codex P1: FK を張らない設計は doctor とセット）。refute hash 再計算 check のみ SP-16（normalizeChangeText 確定後）に拡張する。容量上限の db prune-audit は引き続き follow-up（§9）。

### Q6. phase↔hitch 整合チェック（SP-21）で tightening 判定に spec-gates.ts の isScopeWidening/closeConditionsLoosenGate（hitch update 用セマンティクス）をそのまま流用してよいか。phase spec=previous, hitch spec=next のセマンティクスが hitch update と完全一致するか未検証（design-231 付録H H2）。
推奨: WI.6a(SP-21)実装時に spec-gates 関数を phase↔hitch 文脈に適用したテーブルテスト(R13b)を先に書き、意味論ズレ（例: phase に scope.targetFiles が無い場合の widen 判定）を RED で炙り出す。ズレがあれば spec-gates に phase 用 thin wrapper を足す（関数本体は共用のまま）。


---

---

# 付録: cycle2 changeLog（codex ロードマップ指摘の対処）

- (P1) SP-2 を『precomputed target_change_hash の append/list/dedupe』に縮小し、normalizeChangeText/targetChangeHash/verifyRefuteBinding と normalize hash version 方針を SP-16(refute) の単一所有に移譲（section 2/3/4 表 + 詳細表 SP-2/SP-16 + RED テスト + 共有成果物リスト + Q5）
- (P1) SP-2 直後の DB 基盤内に SP-3D（consistency-doctor: orphan proposal/vote/audit + hitch_id 整合 advisory）を新設。refute hash 再計算 check は SP-16 後に拡張（section 2 図 + 4 表 + 詳細表 + RED テスト + 共有成果物 + risk + Q5）
- (P1) jury enum を DB v2 DDL に統一: SP-4 の型/テストを proposedScope∈{in_scope,out_of_scope,unknown}+proposalStatus∈{complete,timeout,parse_error,inconclusive} に修正、unknown_inconclusive scope 値を廃止。SP-7 proposer の fail-closed 出力も status 列方式に統一（CC5）
- (P1) SP-16 の verifyRefuteBinding を input.refuteVote.target_change_hash===targetChangeHash(change.change_text) の等値比較に修正（vote の hash を再ハッシュしない）。positive binding test 追加。集約源を ReviewProposalRow.requiredChanges と明記（CC8）
- (P2) SP-3 の CAS 競合ポリシーを acceptance/RED に固定: bounded retry N 回→超過で typed conflict error throw（後勝ち禁止・fail-closed）。Q4 を『SP-3 実装時に確定』→『確定済み・機械検証可能』に更新
- (P2) gate-specs の古い refute DDL（UNIQUE(run_id,target_change_hash,reviewer_id) / REFERENCES reviewers / hash 再計算）を廃止参照化し、DB v2 business key (run_id,target_change_hash,reviewer_id,prompt_sha256)+FK 無しに統一。SP-2 に PRAGMA foreign_key_list 空 RED を追加（CC8）
- (P3) criticalPath に SP-22 を含め SP-21→SP-22→SP-23 に修正。SP-2→SP-3D も path に明示
- (CC2) `ReviewRuleRequirement.reviewerIds?`/`lensAxes?`(per-group) と `ReviewRule.maxReviewers?`(top-level) の additive は **SP-10(Phase 1a)所有**（YAML: requirement の reviewer_ids/lens_axes ＋ top-level max_reviewers→camelCase compile。design-229 §3.2 shape。codex #257）
- (CC3) SP-17 に refute quorum を processConsensusModePath/evaluateConsensus の決定論ゲート内で再評価（1票=100% 防止）+ 厳密 majority（refute 票数 > 過半、tie=fail-closed、>= threshold 不可）を反映

---

# 付録: codex exec gpt-5.5 xhigh レビュー（ロードマップ v1 への指摘 = v2 改訂根拠）

**P0**
なし。

**P1**
- **SP-2 / SP-16: refute content-hash bind が前方依存になっている。**  
  SP-2 が `content-hash bind` を受け入れに含む一方、`normalizeChangeText` / `targetChangeHash` / `verifyRefuteBinding` と normalize version 方針は SP-16 で初めて作る設計です。[impl-roadmap.md:105](/Users/kn/ops/monorepo-harness/docs/design/proposals/impl-roadmap.md:105), [impl-roadmap.md:119](/Users/kn/ops/monorepo-harness/docs/design/proposals/impl-roadmap.md:119), [design-db-persistence.md:403](/Users/kn/ops/monorepo-harness/docs/design/proposals/design-db-persistence.md:403)  
  推奨: SP-2 の refute repository は「precomputed `target_change_hash` の append/list/dedupe」までに縮め、binding 検証と hash version 方針は SP-16 に移す。もしくは refute repository 部分だけ SP-16 後へ分割する。

- **SP-2 / DB基盤: consistency-doctor を follow-up 扱いにしており、DB設計の完了条件と矛盾。**  
  FK を張らない設計は doctor による orphan / hitch_id drift / refute hash 不整合検出とセットです。DB設計は doctor 追加を要求していますが、ロードマップは doctor 整合を follow-up としています。[design-db-persistence.md:17](/Users/kn/ops/monorepo-harness/docs/design/proposals/design-db-persistence.md:17), [design-db-persistence.md:282](/Users/kn/ops/monorepo-harness/docs/design/proposals/design-db-persistence.md:282), [design-db-persistence.md:364](/Users/kn/ops/monorepo-harness/docs/design/proposals/design-db-persistence.md:364), [impl-roadmap.md:312](/Users/kn/ops/monorepo-harness/docs/design/proposals/impl-roadmap.md:312)  
  推奨: SP-2 直後に doctor/consistency SP を追加する。最低限 orphan と hitch_id 整合は DB基盤内、refute hash 再計算は SP-16 後に拡張する。

- **SP-4 / SP-7 / SP-8: jury enum が DB DDL と関数仕様で不一致。**  
  DB v31 は `proposed_scope IN ('in_scope','out_of_scope','unknown')` + `proposal_status` で判定不能を表すのに、`aggregateJuryVotes` 仕様と roadmap tests は `unknown_inconclusive` を scope 値として使っています。[design-db-persistence.md:193](/Users/kn/ops/monorepo-harness/docs/design/proposals/design-db-persistence.md:193), [design-gate-specs.md:45](/Users/kn/ops/monorepo-harness/docs/design/proposals/design-gate-specs.md:45), [impl-roadmap.md:159](/Users/kn/ops/monorepo-harness/docs/design/proposals/impl-roadmap.md:159), [types.ts:110](/Users/kn/ops/monorepo-harness/src/hitch/types.ts:110)  
  推奨: SP-4 の型/テストを DB に合わせ、`proposedScope: 'in_scope'|'out_of_scope'|'unknown'` + `proposalStatus` にする。`proposalStatus !== 'complete'` または `proposedScope === 'unknown'` は split/escalate。

- **SP-16: `verifyRefuteBinding` 仕様コードが target hash を再ハッシュしている。**  
  `targetChangeHash(input.refuteVote.target_change_hash)` は hash 文字列をさらに hash 化するため、正常な change でも一致しません。[design-gate-specs.md:1053](/Users/kn/ops/monorepo-harness/docs/design/proposals/design-gate-specs.md:1053)  
  推奨: `input.refuteVote.target_change_hash === targetChangeHash(change.change_text)` を比較する。SP-16 に positive binding test も追加する。

**P2**
- **SP-3: CAS 競合ポリシーが完了定義としてまだ固定されていない。**  
  Q4 で「SP-3 実装時に確定」となっていますが、acceptance は機械検証可能であるべきです。[impl-roadmap.md:309](/Users/kn/ops/monorepo-harness/docs/design/proposals/impl-roadmap.md:309), [design-db-persistence.md:578](/Users/kn/ops/monorepo-harness/docs/design/proposals/design-db-persistence.md:578)  
  推奨: SP-3 開始前に「bounded retry N 回、超過で typed conflict error」などを acceptance に固定する。

- **関数仕様側の refute DDL が統合DB設計より古い。**  
  gate-specs は unique を `(run_id,target_change_hash,reviewer_id)` としており、統合DB設計/roadmap の `prompt_sha256` 付き business key とずれています。[design-gate-specs.md:1099](/Users/kn/ops/monorepo-harness/docs/design/proposals/design-gate-specs.md:1099), [design-db-persistence.md:164](/Users/kn/ops/monorepo-harness/docs/design/proposals/design-db-persistence.md:164), [impl-roadmap.md:137](/Users/kn/ops/monorepo-harness/docs/design/proposals/impl-roadmap.md:137)  
  推奨: gate-specs の古い DDL を削除または v31 統合DDLへの参照に置換する。

**P3**
- **criticalPath 表記が stale。**  
  detailed roadmap の criticalPath は SP-22 を飛ばして SP-23 に進んでいますが、SP-23 は SP-22 に依存します。[impl-roadmap.md:286](/Users/kn/ops/monorepo-harness/docs/design/proposals/impl-roadmap.md:286), [impl-roadmap.md:125](/Users/kn/ops/monorepo-harness/docs/design/proposals/impl-roadmap.md:125)  
  推奨: 表記を `... SP-21 → SP-22 → SP-23` に修正する。依存表自体は正しいです。

**判定**
GO-with-fixes。大枠の DB→A→B→C、v31 単一所有、SP-3/10/19 など共有成果物の所有は妥当です。ただし P1 の4点は実装前に直してください。

未検証点: GitHub issue 本文は未確認。`docs/design/proposals/` はこの ops checkout では未追跡に見えました。コード実行・テスト実行はしていません。
