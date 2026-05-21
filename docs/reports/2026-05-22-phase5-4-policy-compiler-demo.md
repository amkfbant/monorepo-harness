# Phase 5-4 — Policy Compiler / Proposal Engine

**Date:** 2026-05-22
**Trigger:** `tmp/phase5/phase-5-4.md`（Phase 5-4 設計）
**Scope tag:** （Phase 5-4、close タグなし）

## 目的

project profile + policy template + command preset から、既存 `RepoPolicy` /
`GlobalPolicy` へコンパイルできるようにする。`project init --dry-run` の中核。

## 成果物

| ファイル | 内容 |
|----------|------|
| `src/project/provenance.ts` | `PolicyProvenance`（Zod schema）+ serialize / parse。サイドカー JSON |
| `src/project/policy-compiler.ts` | `compileProjectPolicy` / `loadCompileInputs`。template placeholder 展開、command preset コンパイル、GlobalPolicy 合成 |
| `src/project/policy-proposal.ts` | `buildPolicyProposal` — repo policy YAML / provenance JSON シリアライズ + domain summary |
| `src/project/format-proposal.ts` | `formatProposalMarkdown` — dry-run 用 Markdown |

## 設計上のポイント

- placeholder 展開: `{root}` → domain root、`{other_domain_roots}` → 兄弟 root
  ごとに1エントリ、`{root_deny}` → root-deny リスト。
- deny_write は template に関係なく兄弟 root + root-deny を常に含め、domain 分離を保証。
- 出力は決定論的（sort + dedup）。`generatedAt` のみ caller 供給。
- generated repo policy は既存 `RepoPolicySchema` をそのまま満たす。provenance は
  サイドカー JSON。

## codex レビュー（gpt-5.5 xhigh）

P0: 0 / P1: 3 / P2: 2。全件対応済み。

| ID | 指摘 | 対応 |
|----|------|------|
| P1 | command dedup が legacy string の `cmd-N` auto-id を無視 → resolvePolicy が duplicate で throw | resolver の id 規則を再現し fixpoint で dedup |
| P1 | domain root `.` で `{root}/**` が `./**` になり minimatch にマッチしない | `normalizeRootGlob` で `./` を除去、root `.` は `**` に |
| P1 | `parseProvenance` がネストフィールドを検証せず cast | `PolicyProvenanceSchema`（Zod）で完全検証 |
| P2 | `formatProposalMarkdown` の table / list が未エスケープ | cell の `\|` / 改行をエスケープ |
| P2 | `package_script` の script 存在を repo signals で未確認 | domain の package.json scripts に無ければ skip + warning |

## テスト

`tests/unit/project/{provenance,policy-compiler,policy-proposal}.test.ts`。
レビュー指摘のケース（cmd-N 衝突 dedup / root `.` 正規化 / package_script skip /
malformed provenance）も追加。`npm run typecheck` green、Phase 5-4 ユニットテスト
全 pass。

## Close 条件

- [x] profile から `RepoPolicy` が作れる。
- [x] 生成 policy は既存 `RepoPolicySchema` で parse できる。
- [x] `resolvePolicy()` が全 domain で通る。
- [x] proposal に warnings と provenance が出る。
- [x] 出力が決定論的。
