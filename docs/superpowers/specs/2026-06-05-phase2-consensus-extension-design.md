# Phase 2: consensus 拡張 — 設計

GOAL.md Phase 2。`evaluateConsensus`（`src/core/review-consensus.ts`、pure）を
quorum / proposal 鮮度で強化し、consensus が「詰まった」状態を決定論的に検出して
goal orchestrator にエスカレーションを上げる。Phase 3（auto-merge）の安全な merge
gate の前提を作る。

- base ref: `phase1-close`
- 除外: 重み付け投票（GOAL.md スコープ確定メモ）。
- 安全境界（GOAL_RULES.md §G）: 判定は決定論的な harness 側ロジックのみ。LLM の
  自己申告（severity / 「修正した」）を状態遷移の根拠にしない。状態遷移は harness
  のみ。迷ったら fail-closed。

---

## 2-1 quorum / 参加率

### データモデル

`ReviewRuleRequirement`（`src/core/review-rule.ts`）に **任意** の `quorum` を追加。

```ts
export interface ReviewRuleQuorum {
  /** グループ内で non-pending な decision を出した distinct reviewer の最低数。 */
  minParticipants?: number;
  /** 参加率（0..1）。groupSize と併用する。 */
  minParticipationRate?: number;
  /** 参加率の分母（グループの想定 reviewer 数）。 */
  groupSize?: number;
}

export interface ReviewRuleRequirement {
  group: string;
  minApprovals: number;
  blockingDecisions: Array<"changes_requested" | "rejected">;
  quorum?: ReviewRuleQuorum; // 未指定 = 従来挙動（quorum チェックなし）
}
```

### 評価ロジック（`evaluateConsensus`）

consensus mode の各 requirement で:

- **participants** = `groupId === req.group` かつ `reviewerId !== null` かつ
  `decision !== "pending"` な **distinct reviewerId** の数。
- `minApprovals` は従来どおり `approved` の数で判定。
- **quorum 判定**（決定論的・fail-closed）:
  - `minParticipants` 指定時: `participants >= minParticipants`。
  - `minParticipationRate` 指定時: `groupSize` が正の数で
    `participants / groupSize >= minParticipationRate`。`groupSize` 不在/0 は
    **misconfiguration → quorum 未達**（fail-closed）。
  - quorum 未指定 → `quorumMet = true`（後方互換）。
- requirement が満たされる条件 = `approvals >= minApprovals` **かつ** `quorumMet`。
  quorum 未達なら approved にしない → `decisionPath = "requirements-pending"`。

`ConsensusRequirementCheck` に `participants: number` と `quorumMet: boolean` を
追加（summary に出して監査可能にする）。

### 後方互換

quorum 未指定の既存 rule は `quorumMet = true` で従来どおり。既存 consensus テスト
（DEFAULT_REVIEW_RULE / 明示 requirements）は不変。

---

## 2-2 proposal 鮮度管理

### データモデル

`EnrichedProposal` に **任意** の `supersededAt` を追加。

```ts
export interface EnrichedProposal {
  // ...既存
  /** 非 null = この proposal は後続 proposal に置換された（stale）。 */
  supersededAt?: string | null;
}
```

`ReviewRule.staleProposal`（既存: `{ rejectSuperseded: boolean; maxAgeHours?: number }`）
を `evaluateConsensus` が **実際に使う**。

### 鮮度フィルタ（決定論的）

`evaluateConsensus` の冒頭で proposal 集合をフィルタ（override path より後、集計より
前）。両 mode（latest-proposal / consensus）に適用:

- `staleProposal.rejectSuperseded === true` かつ `proposal.supersededAt != null`
  → 除外。
- `staleProposal.maxAgeHours` 定義時、`hoursBetween(reviewedAt, evaluatedAt) >
  maxAgeHours` → 除外（古い）。`reviewedAt > evaluatedAt` のような負経過は除外しない。

除外された proposal は集計（quorum / approvals / blocking / pickLatest）から外す。
`ConsensusSummary` に `excludedProposals: Array<{ proposalId; reason: "superseded"
| "stale_age" }>` を追加して監査可能にする。

### 後方互換

現行 caller（`recordConsensusForReviewProcess`）は単一の未 supersede proposal のみ
渡し、DEFAULT_REVIEW_RULE は `maxAgeHours` 未指定なので除外は発生しない。既存挙動
不変。

---

## 2-3 エスカレーション連携（consensus stall）

### 検出器（pure）— `src/core/consensus-stall.ts`

consensus 評価のスナップショット列から「詰まり」を決定論的に判定する純関数。

```ts
export interface ConsensusProgressSnapshot {
  /** 評価時刻（ISO）。昇順を期待。 */
  evaluatedAt: string;
  status: ConsensusStatus;        // approved/pending/changes_requested/rejected
  /** 全 requirement の approvals 合計。 */
  totalApprovals: number;
  /** 全 requirement の participants 合計。 */
  totalParticipants: number;
  /** いずれかの requirement が blocking 中か。 */
  blocked: boolean;
}

export interface ConsensusStallConfig {
  /** この回数以上の連続スナップショットで「進展なし」なら stall。既定 3。 */
  stallAfterSnapshots: number;
  /** maxAgeHours 的な絶対経過（任意）。最古 pending からの経過がこれを超えたら stall。 */
  maxPendingHours?: number;
}

export interface ConsensusStallResult {
  stalled: boolean;
  reason: string | null;
}

export function detectConsensusStall(
  snapshots: ConsensusProgressSnapshot[],
  config: ConsensusStallConfig,
): ConsensusStallResult;
```

判定（fail-closed・決定論的）:

- 直近 snapshot が `approved` または `rejected`（= 決着）なら stall でない。
- 直近 `stallAfterSnapshots` 件で `status` が非 approved のまま、かつ
  `totalApprovals` と `totalParticipants` が **増加していない**（= 進展なし）→ stall。
  - blocking 未解消（`blocked` が連続 true）も同じ「進展なし」に含める。
- `maxPendingHours` 指定時、最古の非 approved snapshot からの経過が閾値超 → stall。
- snapshot が `stallAfterSnapshots` 未満なら判定保留（stall でない）。

LLM 出力は一切入力にしない。入力は consensus 評価（harness 内部の決定論的結果）の
み。

### goal 連携

`src/goal/` に薄い連携層を追加（`consensus-stall-check.ts`）。`importReviewProposalToGoal`
の convergence 評価の **後** に、goal の review 対象 run 群の `review_consensus`
行（active + superseded を evaluatedAt 昇順）から `ConsensusProgressSnapshot[]` を
構築し、`detectConsensusStall` を呼ぶ。

- stall 検出時のみ goal を **escalated** に倒す（harness のみ状態遷移、
  `recordConvergenceDecisionWithStatus` と同じ経路 or 専用の escalate 記録）。
- consensus 行が無い / 単一 reviewer の latest-proposal mode で常に approved/決着
  する通常フローでは stall は発生しない（後方互換）。
- fail-closed: 判定に迷う場合は escalate 側に倒す。LLM 出力は根拠にしない。

orchestrator は既存どおり convergence/escalation decision に従うだけ（consensus stall
が出たら escalate decision として扱う）。状態遷移ロジックは harness のみ。

> 設計判断: per-cycle の consensus snapshot を新規テーブルに永続化するのではなく、
> 既存 `review_consensus`（active + superseded 履歴）から timeline を再構築する。
> 追加スキーマ無しで決定論的に評価でき、source of truth を二重化しない。

---

## 2-4 production wiring（consensus mode を実フローに接続）

大レビューで判明: Phase 11 で consensus-mode の production 経路（multi-proposal
enrichment / `review process` の consensus gating / `review auto` の再評価）が未実装
だったため、2-1〜2-3 の拡張が実運用で run promotion を gate できなかった（安全境界
の懸念）。Phase 2 の目的（安全な merge gate の前提）を満たすため接続する。default の
`latest-proposal` mode には一切影響しない（consensus mode 限定）。

- **enrichment**（`src/core/consensus-enrichment.ts`）: run の active（非 superseded・
  非 processed）proposal を reviewers registry で group / type 付与して
  `EnrichedProposal[]` 化。未登録 reviewer は type "unknown" / group null（per-group
  判定に落ちる = 安全側）。
- **`review process` gating**（`processConsensusModePath`）: rule が consensus mode の
  とき全 active proposal で `evaluateConsensus`。`pending` は **fail-closed**
  （`ReviewGateError`、promote しない）。decisive なら consensus decision で promote し
  consensus row を実 proposal から記録、集計 proposal を processed に。
- **`review auto` 再評価**（`recordConsensusReEvaluation`）: proposal insert 後、
  consensus mode なら consensus を再評価し `review_consensus` に記録（pending 含む）。
  stall timeline が蓄積される。best-effort（記録失敗は insert を巻き戻さない）。

> 既知の制約（scope 外・follow-up）: orchestrator の review runner は 1 cycle =
> 単一 reviewer のため、consensus mode で `quorum > 1` は満たせず、pending consensus
> で即 escalate する（multi-cycle stall path は wired flow では発火しない）。stall
> 検出の **能力**（detector + goal 連携）は実装・テスト済みだが、それを駆動する
> **multi-reviewer orchestration** は `docs/future-features.md`（Multi-reviewer
> consensus orchestration）に保留。consensus mode 自体も `resolveEffectiveRule` が
> 既定 latest-proposal を返すため profile 読込（Phase 14）が前提。

## テスト（TDD・回帰禁止）

- `tests/unit/core/review-consensus.test.ts`: quorum（minParticipants /
  participationRate / groupSize 欠落 fail-closed）、鮮度除外（superseded /
  maxAgeHours / 負経過）。既存ケースは不変。
- `tests/unit/core/consensus-stall.test.ts`（新規）: stall 検出の各分岐
  （進展なし / blocking 継続 / maxPendingHours / 決着で非 stall / snapshot 不足）。
- goal 連携テスト（fake repository）: stall 時に goal が escalated に倒れる /
  通常フローで倒れない。
- フルスイート + typecheck 緑（大 Phase close 時）。

## close 条件（GOAL.md Phase 2）

- [ ] フルスイート + typecheck 緑、回帰なし（既存 consensus テスト含む）
- [ ] 未解決 P0 ゼロ
- [ ] quorum / 鮮度 / エスカレーションの新挙動に TDD のテスト
- [ ] 本 spec と関連 `docs/specs/*`（review consensus 記述）を更新
