# spec-review-layer — 仕様（案C / #231）

phase spec（`scope` / `closeConditions`）の **起案 → 検証 → 批准 → 整合 enforcement** 層。
SP-19〜SP-22 で出荷済の挙動の **現状スナップショット**（実装と一致。aspirational な記述・TODO は書かない）。
起案そのもの（多エージェント NGT/Delphi）は **harness の外**で行い、harness は
**validate / ratify / persist / 整合 enforcement / runtime drift 診断** のみを所有する（§7）。

> 関連: [`roadmap.md`](./roadmap.md)（phase データモデル・ratify CLI）、
> [`hitch-convergence.md`](./hitch-convergence.md)（close-condition kind 分類・ratified phase 互換 gate・drift 診断）、
> [`cli.md`](./cli.md)（`phase ratify` / `phase start-hitch` / `phase link-hitch`）、
> [`db.md`](./db.md)（`review_state_version` v33・CAS）。実装の source-of-truth は
> `src/hitch/{gap-to-kind,spec-validation,spec-gates,convergence}.ts` と
> `src/roadmap/phase-repository.ts`。設計の正本は `docs/design/proposals/design-231-spec-drafting-review-layer.md`。

---

## 1. ギャップ行テンプレート（人間）→ machine GapRow（橋渡し）

起案は既存フレームワーク（[`../design/consulting-frameworks.md`](../design/consulting-frameworks.md) §2.2/§2.3/§2.4、
[`../design/deliberation.md`](../design/deliberation.md) §3/§5）の **ギャップ行**
`asIs / toBe / gap / cause / action / owner / deadline / metric` を reuse する（新たに著さない）。

このうち **`metric`** が close condition の素になる。harness に渡る machine 入力は人間行の
full shape ではなく、`src/hitch/gap-to-kind.ts` の `GapRow = { metric: string; count: number; gap: number; reason?: string }`
に **橋渡し**する（`metric` が写像対象・`count`/`gap` は規模・`reason` は任意の補足）。

> 注意（consulting-frameworks.md の caveat 継承）: `metric` は実在の `HitchCloseConditionKind`
> へ写像される素であり、`count` という名の kind は存在しない。kind は §3 の 7 種のみ。

---

## 2. gap → closeCondition kind 写像（TOTAL・fail-closed）

純関数 `mapGapMetricToCloseConditionKind(gap, context)`（`src/hitch/gap-to-kind.ts`）は
`metric` を以下のいずれかの kind に **TOTAL** に写像する。写像できない／曖昧な metric は
**REJECT**（沈黙で `manual` に default しない）。

| metric パターン | kind | category |
|---|---|---|
| metric が intent regex（`command`/`cmd`/`npm`/`pnpm`/`yarn`/`test`/`typecheck`/`lint` ＋ `pass`/`passes`/`succeed`/`succeeds`/`green`）に合致し、かつ `policy.allowedCommands` に **whitespace-delimited token 一致**（`tokenPresent`。短 id `test` が `latest` の部分文字列にはマッチしない） | `command` | auto-verify |
| `maxOpenInScopeP0/P1/P2` / `maxOpenUnknownScope` の閾値 | `finding_policy` | auto-verify |
| review 承認（approved） | `review_consensus` | auto-verify |
| artifact / file の存在（`metadata.path` 明示） | `artifact_exists` | external-evidence |
| operator 検証（human verified / manual verification） | `manual` | external-evidence |
| external operation status（`metadata.operationId` 明示） | `operation_status` | external-evidence |
| `db` / `database` … `migration` … `valid`（この語形のみ。汎用の「DB migration」全般ではない） | `db_doctor` | external-evidence |

**REJECT（fail-closed・`{ ok: false, code }`）**:

- `unmapped_metric` — どの kind にも候補が立たない。
- `ambiguous_metric` — 複数 kind に候補が立つ（曖昧）。
- `kind_not_allowed` — 候補 kind が `context.allowedKinds` に含まれない。

> fail-closed の核: 写像不能・曖昧な metric は clarification を要求する（`manual` 黙認で
> ask_human 待ちに化けさせない）。`command` の allowlist 解決は token 一致で fail-closed。

---

## 3. kind 選択 decision tree と auto-verify / external-evidence 分類

closeCondition kind は厳密に 7 種（`HitchCloseConditionKind`）。**自動検証 kind** と
**外部証拠待ち（ask_human）kind** を区別する。自動ゲート意図の条件が ask_human kind に
化けないこと。

```
metric は自動で検証できるか？
├─ 可（auto-verify）
│  ├─ コマンド実行で判定 …………………… command       （close-check runner が実行）
│  ├─ open finding の閾値 …………………… finding_policy （evaluateFindingPolicy）
│  └─ レビュー承認 ………………………………… review_consensus（review runner が充足）
└─ 不可（外部証拠が要る = ask_human）
   ├─ 成果物 / ファイルの存在 ……………… artifact_exists （metadata.path）
   ├─ operator の手動確認 …………………… manual
   ├─ 外部 operation の状態 ………………… operation_status（metadata.operationId）
   └─ DB migration 検証（runner 未実装）… db_doctor
```

| kind | category | 評価 |
|---|---|---|
| command / finding_policy / review_consensus | auto-verify | convergence の決定論ゲートで充足 |
| manual / artifact_exists / operation_status / db_doctor | external-evidence | ask_human routing（外部証拠を記録するまで pending） |

詳細な routing は [`hitch-convergence.md`](./hitch-convergence.md)。分類の裏付けは
`src/hitch/spec-validation.ts` の hard/advisory split（§4）。

---

## 4. validateCloseConditions（form / kind ガード）

`validateCloseConditions(conditions, context)`（`src/hitch/spec-validation.ts`）は
`HitchCloseConditionSchema`（Zod enum）の **次段** の defense-in-depth。**form チェックのみ**で
あり、close 判定の権限は持たない（close は convergence のまま）。HARD error が 1 つでもあれば
`HitchValidationError` を throw（`assertValidCloseConditions`）。advisory warning は block しない。

**HARD error（write を拒否）**:

| code | 条件 |
|---|---|
| `missing_condition_id` | condition id が空 |
| `duplicate_condition_id` | 同一 array 内で id 重複 |
| `unknown_kind` | kind が 7 種外（Zod の二重チェック） |
| `finding_policy_unknown_rule` | `rule` キーが `{maxOpenInScopeP0,P1,P2,maxOpenUnknownScope}` 以外（`rule.count` 等は hard error） |
| `finding_policy_invalid_threshold` | rule 値が非負数でない |
| `operation_status_missing_operation_id` | `operation_status` で `metadata.operationId` 欠落 |
| `db_doctor_required_without_runner` | `db_doctor` かつ `required:true`（`context.allowRequiredDbDoctor` 無しでは reject。自動 runner 未実装ゆえ） |

**ADVISORY warning（error にしない・false-positive 回避）**:

| code | 条件 |
|---|---|
| `external_evidence_missing_description` | external-evidence kind で description 空 |
| `artifact_exists_missing_path` | `artifact_exists` で `metadata.path` 欠落 |
| `auto_intent_external_kind` | description の NL（`npm test passes` 等）が auto 意図を示すのに kind が external-evidence |
| `review_consensus_ambiguous_description` | `review_consensus` の description が承認語彙を含まず曖昧 |
| `external_evidence_majority` | external-evidence kind が条件の 50% 超 |

**command は form-only**: validator は kind + syntax（bare-id 受理）のみを見て、allowlist の
一意解決と ambiguous 検出は **close-check runner（`orchestrator-close-check-runner.ts`）に defer**
する（validator で allowlist 解決を再実装しない）。

---

## 5. ratify ceremony と phase ↔ hitch 整合 gate

**批准前は提案、批准で canonical。** accountable owner 1 名が署名する。詳細な CLI / データ
モデルは [`cli.md`](./cli.md) / [`roadmap.md`](./roadmap.md) を正本とし、ここでは要約と相互参照に留める。

- `harness phase ratify <phase-id> --approved-by <actor> [--reason <text>] [--json]`：
  `--approved-by` 必須（無しは reject）。ratify は **spec を編集しない** —
  `recordSpecApproval` が **その時点で committed の `[scope, closeConditions]`** を hash して
  `review_state_json.specApproval = { approvedBy, approvedAt, reason, specHash }` を **namespaced** に記録する
  のみ。`specHash = sha256(canonicalJson([scope, closeConditions]))`。書き込みは `review_state_version` の
  **CAS**（最大 3 retry → `ReviewStateConflictError`、fail-closed）。**spec 自体の編集は事前に
  `phase update --scope-file/--close-file`（→ `updateSpec()`・§4 validator + spec-gates を通す）で行う**
  （ratify は別コマンド）。
- **整合 gate（ratify 済 phase のみ）**: `phase link-hitch` / 新 `phase start-hitch` が hitch spec を
  phase の **現在 spec** と比較し、**同一または厳格化（tightening）** を require する（批准時 snapshot ではなく
  current phase spec が gate の基準）。判定は live な hitch config 更新と同一の純述語
  （`isScopeWidening` / `closeConditionsLoosenGate`、`src/hitch/spec-gates.ts`）。scope 拡大は `--allow-scope-widen`、
  required close 条件の削除 / optional 化 / gate fingerprint 弱化は `--allow-gate-loosen` 無しで reject。
  より厳しい追加条件は許容。
- **後方互換**: `specApproval` の無い（＝未 ratify の）phase は従来通り自由に link/start でき、整合
  gate は skip される（ratify は opt-in）。
- **specHash drift warning**: link/start 時に **現在 phase spec** から再計算した hash が
  `specApproval.specHash`（批准時 snapshot）と不一致なら **warning**（reject はしない。批准後に spec が
  手編集された＝drift の可視化）。

---

## 6. 案A（決定パケット）連携 — 予約のみ

案C は案A 無しで ship する。案A の決定パケット形式は **forward-compatible な interface premise**
として扱い、spec-candidate アーティファクトに optional な `decisionPacketId` フィールドを
**予約**しておく（案A が land したら additive に統合）。**現状 `src/` に実装参照はゼロ＝docs 上の
予約に留まる**（実装済とは示唆しない）。詳細は design-231 §3.6。

---

## 7. 起案（NGT / Delphi）は harness の外

多エージェントの起案 → 重複排除 → 批判 → 統合（NGT / Delphi）は **harness の外**で実行する
（operator ツール / `superpowers:dispatching-parallel-agents`）。harness が所有するのは
**validate（§2/§4）+ ratify（§5）+ persist + spec/hitch 整合 enforcement（§5）+ runtime drift 診断**
（[`hitch-convergence.md`](./hitch-convergence.md)）のみ。

理由（design-231 §3.1）: (a) CLAUDE.md の bootstrapping 規律（合議を harness core に入れない）、
(b) 起案・批判・批准の決定権は人間にあり手順書が適切、(c) 出力（spec-candidate）は harness 外の
GitHub branch/PR で audit/再実行する。フレームワーク（gap 行・意思決定マトリクス・合議ラウンド）は
[`../design/consulting-frameworks.md`](../design/consulting-frameworks.md) /
[`../design/deliberation.md`](../design/deliberation.md) を reuse する。

> **スコープ注記（WI.8 cut-line）**: 起案ワークフロー手順書（旧 `docs/workflows/spec-draft-and-review.md`
> 案）は本ファイル §7/§8 に再配置した。`GOAL_RULES.md`（repo root）への spec-gates 共用 /
> footprint 規約 / severity advisory-only の追記は self write-scope（`docs/specs/**`）外のため
> SP-23 では行わず operator / follow-up に委ねる（[`roadmap.md`](./roadmap.md) の SP-23 scope note 参照）。
> これは silent omission ではなく明示的な範囲線。

---

## 8. 起案 → 批准 ワークフロー（worked samples）

harness 外の起案手順（出力は spec-candidate YAML：`scope` + `closeConditions`）:

1. **起案（fan-out・harness 外）**: ギャップ行（§1）を複数エージェントが独立に作成 → 重複排除 →
   批判 → 統合。各 `metric` を §2 で kind に写像（写像不能は REJECT して metric を磨き直す）。
2. **検証（harness）**: 候補 closeConditions を `validateCloseConditions`（§4）に通す。HARD error は
   修正必須、ADVISORY は記録の上 owner が判断。
3. **批准（harness・人間）**: `phase ratify --approved-by <accountable owner>`（§5）。これで spec が
   canonical 化し `specApproval` + `specHash` が記録される。
4. **enforcement（harness）**: 以降 `phase link-hitch` / `start-hitch` は批准 spec と同一/厳格化のみ
   許可（§5 整合 gate）。drift は warning + convergence の ask_human message に診断（hitch-convergence.md）。

### 写像サンプル（生成 closeCondition は実 kind のみ・auto / external を区別）

| metric（起案） | 写像 kind | category | 生成 closeCondition（概略） |
|---|---|---|---|
| `command typecheck passes`（allowedCommands に typecheck） | `command` | auto-verify | `{ kind: command, id: typecheck }` |
| `maxOpenInScopeP1 <= 0` | `finding_policy` | auto-verify | `{ kind: finding_policy, rule: { maxOpenInScopeP1: 0 } }` |
| `review decision = approved` | `review_consensus` | auto-verify | `{ kind: review_consensus }` |
| `file docs/specs/roadmap.md exists` | `artifact_exists` | external-evidence | `{ kind: artifact_exists, metadata: { path: ... } }` |
| `operator verified rollout` | `manual` | external-evidence | `{ kind: manual, description: ... }` |
| `external operation status op-123 succeeded` | `operation_status` | external-evidence | `{ kind: operation_status, metadata: { operationId: op-123 } }` |
| `quality is better`（曖昧） | — | REJECT | `unmapped_metric`（metric を磨き直す） |

各 closeCondition は `HitchCloseConditionSchema` を通り、auto-verify kind と外部証拠 kind が混在
する場合は §4 の `external_evidence_majority` advisory が >50% で点く。
