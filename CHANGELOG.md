# Changelog

## [0.7.4](https://github.com/amkfbant/monorepo-harness/compare/v0.7.3...v0.7.4) (2026-06-14)


### Bug Fixes

* **close-check:** exclude node_modules from ignored-untracked pollution check ([#187](https://github.com/amkfbant/monorepo-harness/issues/187) follow-up) ([#214](https://github.com/amkfbant/monorepo-harness/issues/214)) ([c5ea57b](https://github.com/amkfbant/monorepo-harness/commit/c5ea57b164da29d3f2ca20a90f6fd7b6b6123452))
* **orchestrate:** domain-lock contention defers (lock_busy, exit 1) instead of escalating ([#166](https://github.com/amkfbant/monorepo-harness/issues/166)) ([#213](https://github.com/amkfbant/monorepo-harness/issues/213)) ([800bcf6](https://github.com/amkfbant/monorepo-harness/commit/800bcf68804d582ea9c9d514b625f88e90def5fa))

## [0.7.3](https://github.com/amkfbant/monorepo-harness/compare/v0.7.2...v0.7.3) (2026-06-14)


### Bug Fixes

* **convergence:** near-duplicate finding dedup + command-evidence advisory sanction ([#155](https://github.com/amkfbant/monorepo-harness/issues/155), [#165](https://github.com/amkfbant/monorepo-harness/issues/165)) ([#211](https://github.com/amkfbant/monorepo-harness/issues/211)) ([ab754f2](https://github.com/amkfbant/monorepo-harness/commit/ab754f2b34fc8af74a217be393924d0126e6a682))

## [0.7.2](https://github.com/amkfbant/monorepo-harness/compare/v0.7.1...v0.7.2) (2026-06-14)


### Bug Fixes

* **close-check:** detect add/modify/delete of ignored untracked paths ([#187](https://github.com/amkfbant/monorepo-harness/issues/187)) ([#208](https://github.com/amkfbant/monorepo-harness/issues/208)) ([0f5dfd6](https://github.com/amkfbant/monorepo-harness/commit/0f5dfd6aaf7104659da33b91720d544c8f7a1718))
* **convergence:** source-aware divergence — operator findings don't falsely diverge ([#196](https://github.com/amkfbant/monorepo-harness/issues/196)) ([#210](https://github.com/amkfbant/monorepo-harness/issues/210)) ([e8b9a7d](https://github.com/amkfbant/monorepo-harness/commit/e8b9a7d0635019629f93c3f5243b3a7155fef3a8))

## [0.7.1](https://github.com/amkfbant/monorepo-harness/compare/v0.7.0...v0.7.1) (2026-06-14)


### Bug Fixes

* **orchestrate:** hitch rerun continues parent run work, fail-closed on base-advance ([#163](https://github.com/amkfbant/monorepo-harness/issues/163)) ([#207](https://github.com/amkfbant/monorepo-harness/issues/207)) ([cbc16b4](https://github.com/amkfbant/monorepo-harness/commit/cbc16b415152ce39b7ce47af3c1ce2e76f2a1386))
* **test-infra:** bound vitest fork pool + stop tmp-dir disk leak so full vitest run no longer hangs ([#198](https://github.com/amkfbant/monorepo-harness/issues/198)) ([#202](https://github.com/amkfbant/monorepo-harness/issues/202)) ([2d7f1fc](https://github.com/amkfbant/monorepo-harness/commit/2d7f1fcf6c7a294b3019245a7e7b17021547a761))

## [0.7.0](https://github.com/amkfbant/monorepo-harness/compare/v0.6.0...v0.7.0) (2026-06-13)


### ⚠ BREAKING CHANGES

* **cli:** `harness goal` no longer prints a rename hint; it now fails as a generic unknown command. Use `harness hitch …`.
* **roadmap:** `hitch orchestrate` now ends with an error (hitch state unchanged) instead of escalating the hitch when the run layer reports a domain lock-busy / lost lease; `course orchestrate` aborts with lease_lost / lease_busy.
* **hitch:** project-scoped hitch runs now validate diffs against the compiled project policy; a profile that narrowed scope can now deny diffs the raw repo policy previously allowed.
* **mcp:** hitch.start idempotent replay is not preserved across this upgrade (the id derivation changed). Documented in docs/specs/mcp.md.

### Features

* **dashboard:** split mutation API into `operations serve` — dashboard read-only (course D2) ([#194](https://github.com/amkfbant/monorepo-harness/issues/194)) ([ebecff8](https://github.com/amkfbant/monorepo-harness/commit/ebecff8d77c03ae8c31f1f90b96cf9f753683895))
* **hitch:** add `hitch finding list` to enumerate findings without scraping status JSON ([#170](https://github.com/amkfbant/monorepo-harness/issues/170)) ([#180](https://github.com/amkfbant/monorepo-harness/issues/180)) ([602084d](https://github.com/amkfbant/monorepo-harness/commit/602084d018e15cd94cb01a1ba119da69b69d377a))
* **hitch:** adopt-pr (audit-only) + hitch update with scope-freeze guards, migration V29 ([#169](https://github.com/amkfbant/monorepo-harness/issues/169), [#142](https://github.com/amkfbant/monorepo-harness/issues/142)) ([#185](https://github.com/amkfbant/monorepo-harness/issues/185)) ([9cfa7f6](https://github.com/amkfbant/monorepo-harness/commit/9cfa7f6491d203fc8d260c202d7e99ead552a2d3))
* **hitch:** finding defer --classify-out-of-scope to defer advisories in one step ([#172](https://github.com/amkfbant/monorepo-harness/issues/172)) ([#182](https://github.com/amkfbant/monorepo-harness/issues/182)) ([2e136fb](https://github.com/amkfbant/monorepo-harness/commit/2e136fbb9271522879ec8d210b4512fbda502e45))
* **hitch:** persist reopen/close/cancel reasons in hitch_lifecycle_events (migration V23) ([#130](https://github.com/amkfbant/monorepo-harness/issues/130)) ([#156](https://github.com/amkfbant/monorepo-harness/issues/156)) ([1d29791](https://github.com/amkfbant/monorepo-harness/commit/1d297917ee9db5ffe7e892155af26060be0e2a9a))
* **metrics:** KPI wiring over existing data (course telemetry Phase D) ([#161](https://github.com/amkfbant/monorepo-harness/issues/161)) ([1ace655](https://github.com/amkfbant/monorepo-harness/commit/1ace655b777c97afcfa6b08aea2c024c5a76fce6))
* **metrics:** metrics snapshots time series with retention and delta, migration V27 (course telemetry Phase E) ([#175](https://github.com/amkfbant/monorepo-harness/issues/175)) ([2df0bcb](https://github.com/amkfbant/monorepo-harness/commit/2df0bcbe13f45d898e3da1d21e965710d0007ca7))
* **metrics:** telemetry follow-ups — lock contention (V28), events tail, probe cwd isolation ([#176](https://github.com/amkfbant/monorepo-harness/issues/176)) ([6006af9](https://github.com/amkfbant/monorepo-harness/commit/6006af9d0f5a3fde26d1dc1487c7714ea62054df))
* **provenance:** run execution environment provenance, migration V25 (course telemetry Phase B) ([#162](https://github.com/amkfbant/monorepo-harness/issues/162)) ([0625199](https://github.com/amkfbant/monorepo-harness/commit/062519986c3371d4fa41ebd4b0cdff9688a168c4))
* **review:** populate prompt_sha256 and prompt provenance (migration V24) ([#131](https://github.com/amkfbant/monorepo-harness/issues/131)) ([#157](https://github.com/amkfbant/monorepo-harness/issues/157)) ([1db9d84](https://github.com/amkfbant/monorepo-harness/commit/1db9d840e95f75193a4b29d67162df4cc0ad846d))
* **telemetry:** per-phase run timing instrumentation (course telemetry Phase A) ([#160](https://github.com/amkfbant/monorepo-harness/issues/160)) ([0a8585d](https://github.com/amkfbant/monorepo-harness/commit/0a8585df48230363104996b1411b89357058b2f0))
* **usage:** codex token usage collection via --json, migration V26 (course telemetry Phase C) ([#174](https://github.com/amkfbant/monorepo-harness/issues/174)) ([412f793](https://github.com/amkfbant/monorepo-harness/commit/412f7932c111885967c4a68b0b6a4f6c79e3227a))
* **usage:** run_usage を per-invocation 化し coder/reviewer/evaluator token を集計 ([#85](https://github.com/amkfbant/monorepo-harness/issues/85)) ([#200](https://github.com/amkfbant/monorepo-harness/issues/200)) ([8030d5a](https://github.com/amkfbant/monorepo-harness/commit/8030d5ae300838b9dc09277716569628749f93f2))


### Bug Fixes

* [dashboard-split D1] read contract 棚卸し&確定 (doc のみ) (run-20260613-self-mqc9v4ja9a0b26e7) ([#189](https://github.com/amkfbant/monorepo-harness/issues/189)) ([e9bc4fe](https://github.com/amkfbant/monorepo-harness/commit/e9bc4feaf0cd730c785d36d4d2873b6146dcc07f))
* audit minor findings, batch A — lock release order, decision tiebreak, scoped not-found, PR-body perms ([#134](https://github.com/amkfbant/monorepo-harness/issues/134)) ([#158](https://github.com/amkfbant/monorepo-harness/issues/158)) ([1e8107e](https://github.com/amkfbant/monorepo-harness/commit/1e8107e0bfbeab8b02dd63b7c24d2b2c19ac78da))
* audit minor findings, batch B — confirmation preview redaction, dead config, course pause/resume, typed errors ([#134](https://github.com/amkfbant/monorepo-harness/issues/134)) ([#159](https://github.com/amkfbant/monorepo-harness/issues/159)) ([3d2f915](https://github.com/amkfbant/monorepo-harness/commit/3d2f915f7bb26a0b570d51c5d8dbea79c51916bf))
* **backlog:** list/show を DB 正本化（defer --backlog 由来の行を可視化, [#177](https://github.com/amkfbant/monorepo-harness/issues/177)） ([#179](https://github.com/amkfbant/monorepo-harness/issues/179)) ([b37c2a5](https://github.com/amkfbant/monorepo-harness/commit/b37c2a5a9630131fa1f5a75b5b1e07f6d4f20479))
* **cli:** remove the harness goal erroring stub ([#133](https://github.com/amkfbant/monorepo-harness/issues/133)) ([#151](https://github.com/amkfbant/monorepo-harness/issues/151)) ([4e9f889](https://github.com/amkfbant/monorepo-harness/commit/4e9f8898d7431763a8ef39e055c00d72491cf434))
* **hitch:** batch classify/defer runners with deterministic final COUNT ([#121](https://github.com/amkfbant/monorepo-harness/issues/121)) ([#138](https://github.com/amkfbant/monorepo-harness/issues/138)) ([f76fb3c](https://github.com/amkfbant/monorepo-harness/commit/f76fb3cd9e8b16273cc61616b9e011e93511ff1d))
* **hitch:** close_check hardening — routing, git timeout, index, runnable states, secret-safe coder injection ([#184](https://github.com/amkfbant/monorepo-harness/issues/184)) ([#188](https://github.com/amkfbant/monorepo-harness/issues/188)) ([91bcb15](https://github.com/amkfbant/monorepo-harness/commit/91bcb1547978664ab1202a649611df4f998f58df))
* **hitch:** deterministic command close-checks in autonomous orchestrate ([#140](https://github.com/amkfbant/monorepo-harness/issues/140)) ([#181](https://github.com/amkfbant/monorepo-harness/issues/181)) ([a2927d4](https://github.com/amkfbant/monorepo-harness/commit/a2927d4962a17068cde2bb00d20cd3b35d33f0af))
* **hitch:** SQL-aggregate finding scans + escalated active-blocker alignment (audit [#112](https://github.com/amkfbant/monorepo-harness/issues/112)) ([#135](https://github.com/amkfbant/monorepo-harness/issues/135)) ([217ebb9](https://github.com/amkfbant/monorepo-harness/commit/217ebb925991fdd17105e7f7a6b56aa4e0f9cb2c))
* **hitch:** thread compiled project policy into orchestrator/MCP/course coder runs ([#115](https://github.com/amkfbant/monorepo-harness/issues/115)) ([#143](https://github.com/amkfbant/monorepo-harness/issues/143)) ([56d34a0](https://github.com/amkfbant/monorepo-harness/commit/56d34a07a12367c7270ce869646b3724c9471070))
* **mcp:** client-scope hardening — 4 audit findings ([#119](https://github.com/amkfbant/monorepo-harness/issues/119)/[#117](https://github.com/amkfbant/monorepo-harness/issues/117)/[#118](https://github.com/amkfbant/monorepo-harness/issues/118)/[#114](https://github.com/amkfbant/monorepo-harness/issues/114)) ([#136](https://github.com/amkfbant/monorepo-harness/issues/136)) ([836661e](https://github.com/amkfbant/monorepo-harness/commit/836661e216bca25260bc2a537135312b38c84541))
* **mcp:** redact audit input+metadata across all operation paths, consolidate wrappers ([#124](https://github.com/amkfbant/monorepo-harness/issues/124)) ([#149](https://github.com/amkfbant/monorepo-harness/issues/149)) ([246700d](https://github.com/amkfbant/monorepo-harness/commit/246700d7eca0f79221fe2a589560222f7ce7f9eb))
* **review:** fail review-auto insert when it would silently supersede a rival proposal ([#116](https://github.com/amkfbant/monorepo-harness/issues/116)) ([#139](https://github.com/amkfbant/monorepo-harness/issues/139)) ([3eaab68](https://github.com/amkfbant/monorepo-harness/commit/3eaab688ed4e44a72d9adef1e688a8b13103c06b))
* **roadmap:** auto-number phase position so drive order follows creation order ([#120](https://github.com/amkfbant/monorepo-harness/issues/120)) ([#145](https://github.com/amkfbant/monorepo-harness/issues/145)) ([dcb2c33](https://github.com/amkfbant/monorepo-harness/commit/dcb2c332fbd7d39c0ca6eb9477fc3e2bdb1dd16c))
* **roadmap:** fence course-pass phase writes by lease and stop false escalation on lock conflicts ([#113](https://github.com/amkfbant/monorepo-harness/issues/113)) ([#144](https://github.com/amkfbant/monorepo-harness/issues/144)) ([aa836b4](https://github.com/amkfbant/monorepo-harness/commit/aa836b4d77bc4f4005135021cd32f7ff39898608))
* **roadmap:** re-read phase rollup live per phase during a course pass ([#122](https://github.com/amkfbant/monorepo-harness/issues/122)) ([#146](https://github.com/amkfbant/monorepo-harness/issues/146)) ([0e842bd](https://github.com/amkfbant/monorepo-harness/commit/0e842bd402652859e2ce2cb677e36b35608d5a34))
* untrack node_modules symlink and ignore it (.gitignore) ([#193](https://github.com/amkfbant/monorepo-harness/issues/193)) ([95e3ff4](https://github.com/amkfbant/monorepo-harness/commit/95e3ff44fbd0812231469199900f00cbad9f5d69))


### Refactors

* **db:** drop unused db_stats_snapshots (migration V22) and remove dead code ([#126](https://github.com/amkfbant/monorepo-harness/issues/126)) ([#153](https://github.com/amkfbant/monorepo-harness/issues/153)) ([dc9dcd2](https://github.com/amkfbant/monorepo-harness/commit/dc9dcd28867f15f1be78f3fe9bbab888b89df13c))

## [0.6.0](https://github.com/amkfbant/monorepo-harness/compare/v0.5.0...v0.6.0) (2026-06-11)


### ⚠ BREAKING CHANGES

* rename harness 'goal' mode to 'hitch' (SP-0) ([#108](https://github.com/amkfbant/monorepo-harness/issues/108))

### Features

* add 'harness onboard' guided onboarding wizard ([#92](https://github.com/amkfbant/monorepo-harness/issues/92)) ([#107](https://github.com/amkfbant/monorepo-harness/issues/107)) ([c9486aa](https://github.com/amkfbant/monorepo-harness/commit/c9486aa78c91a4423a7528afa413b3b7ba158a54))
* add MCP write for operational knowledge (ops_knowledge.record/deprecate) [[#57](https://github.com/amkfbant/monorepo-harness/issues/57)] ([#67](https://github.com/amkfbant/monorepo-harness/issues/67)) ([9ec6435](https://github.com/amkfbant/monorepo-harness/commit/9ec643576a2dda041ba69765ee22519b11d277c9))
* close [#57](https://github.com/amkfbant/monorepo-harness/issues/57) — operational knowledge file-export parity + digest ([#95](https://github.com/amkfbant/monorepo-harness/issues/95)) ([85ae392](https://github.com/amkfbant/monorepo-harness/commit/85ae392b5d3316ce26f845ac34fecccb79f69bd9))
* close [#73](https://github.com/amkfbant/monorepo-harness/issues/73) — review_consensus static-only semantics + test gate + surface ([#101](https://github.com/amkfbant/monorepo-harness/issues/101)) ([fd97c4c](https://github.com/amkfbant/monorepo-harness/commit/fd97c4cdb0488dc4d670f4005675d18d539f5257))
* course/phase DB roadmap layer (SP-1) ([#109](https://github.com/amkfbant/monorepo-harness/issues/109)) ([342b07f](https://github.com/amkfbant/monorepo-harness/commit/342b07f1fa736fef897abd2f7afb0b4d5d8b291a))
* expose release plan over MCP (harness.release.plan read tool) ([#71](https://github.com/amkfbant/monorepo-harness/issues/71)) ([b4de015](https://github.com/amkfbant/monorepo-harness/commit/b4de0150c71f75d4926d30bdb579cab105f01a5f))
* harness release check — fail-closed release-readiness gate ([#94](https://github.com/amkfbant/monorepo-harness/issues/94)) ([7b2f786](https://github.com/amkfbant/monorepo-harness/commit/7b2f78686af4fe39e9ec691c44a238ab2610bb32))
* harness release plan — release-readiness + compatibility analyzer ([#70](https://github.com/amkfbant/monorepo-harness/issues/70)) ([148b170](https://github.com/amkfbant/monorepo-harness/commit/148b170b777c6a540c6288a4cc401858adacd49d))
* inject operational knowledge into the reviewer prompt (F, [#57](https://github.com/amkfbant/monorepo-harness/issues/57)) ([#66](https://github.com/amkfbant/monorepo-harness/issues/66)) ([c31c069](https://github.com/amkfbant/monorepo-harness/commit/c31c0694a6ce356e379356c5fde73057892b0735))
* surface operational knowledge in the inbox read model [[#57](https://github.com/amkfbant/monorepo-harness/issues/57)] ([#64](https://github.com/amkfbant/monorepo-harness/issues/64)) ([83f69ea](https://github.com/amkfbant/monorepo-harness/commit/83f69ead394494334e03d1581dd3075fbea9808d))
* 大 Phase S — 運用実害 + 安全・信頼性の修正 ([#79](https://github.com/amkfbant/monorepo-harness/issues/79) [#77](https://github.com/amkfbant/monorepo-harness/issues/77) [#103](https://github.com/amkfbant/monorepo-harness/issues/103) [#69](https://github.com/amkfbant/monorepo-harness/issues/69) [#104](https://github.com/amkfbant/monorepo-harness/issues/104) [#76](https://github.com/amkfbant/monorepo-harness/issues/76) [#83](https://github.com/amkfbant/monorepo-harness/issues/83)) ([#105](https://github.com/amkfbant/monorepo-harness/issues/105)) ([6bc50d4](https://github.com/amkfbant/monorepo-harness/commit/6bc50d4d290333efcabd231e7591298f5590ae0b))
* 大 Phase T — 運用セットアップ・DX のつまずき修正 ([#78](https://github.com/amkfbant/monorepo-harness/issues/78) [#81](https://github.com/amkfbant/monorepo-harness/issues/81) [#82](https://github.com/amkfbant/monorepo-harness/issues/82) [#68](https://github.com/amkfbant/monorepo-harness/issues/68)) ([#106](https://github.com/amkfbant/monorepo-harness/issues/106)) ([a62db6b](https://github.com/amkfbant/monorepo-harness/commit/a62db6be8580f34ea7b00058c4ca092e352cd9ff))
* 自律 course orchestrate — drive-only bounded driver (SP-2) ([#110](https://github.com/amkfbant/monorepo-harness/issues/110)) ([e6118f8](https://github.com/amkfbant/monorepo-harness/commit/e6118f8b763a23873b75df56d5db46d9f346180b))


### Refactors

* rename harness 'goal' mode to 'hitch' (SP-0) ([#108](https://github.com/amkfbant/monorepo-harness/issues/108)) ([82dea41](https://github.com/amkfbant/monorepo-harness/commit/82dea414776e3aef723b73223f744e9ac7027b73))

## [0.5.0](https://github.com/amkfbant/monorepo-harness/compare/v0.4.0...v0.5.0) (2026-06-08)


### Features

* add `harness knowledge ops` CLI for operational knowledge [[#57](https://github.com/amkfbant/monorepo-harness/issues/57)] ([#60](https://github.com/amkfbant/monorepo-harness/issues/60)) ([1317595](https://github.com/amkfbant/monorepo-harness/commit/131759506f010079e4220fc58683a403646f271d))
* add MCP read tools for operational knowledge [[#57](https://github.com/amkfbant/monorepo-harness/issues/57)] ([#62](https://github.com/amkfbant/monorepo-harness/issues/62)) ([a6b819d](https://github.com/amkfbant/monorepo-harness/commit/a6b819d2b8cabdd61aa89dcb6b2183a114aa9d29))
* operational knowledge category — storage core + safety isolation (SP1, [#57](https://github.com/amkfbant/monorepo-harness/issues/57)) ([#59](https://github.com/amkfbant/monorepo-harness/issues/59)) ([e1e2480](https://github.com/amkfbant/monorepo-harness/commit/e1e2480d288454ca7bc8468f64982ab225fe95ca))

## [0.4.0](https://github.com/amkfbant/monorepo-harness/compare/v0.3.0...v0.4.0) (2026-06-07)


### Features

* **mcp:** harness.inbox + harness.metrics read tools ([#55](https://github.com/amkfbant/monorepo-harness/issues/55)) ([45685d7](https://github.com/amkfbant/monorepo-harness/commit/45685d7638410abf1c5366971656c90cebaa4952))
* **mcp:** workspace inspect / conflicts / recover read tools ([#53](https://github.com/amkfbant/monorepo-harness/issues/53)) ([3307d23](https://github.com/amkfbant/monorepo-harness/commit/3307d23527d5ee34b90ac78dc79818110b095898))

## [0.3.0](https://github.com/amkfbant/monorepo-harness/compare/v0.2.0...v0.3.0) (2026-06-07)


### Features

* auto-link the agent workspace to the goal on goal orchestrate (B[#6](https://github.com/amkfbant/monorepo-harness/issues/6)) ([#46](https://github.com/amkfbant/monorepo-harness/issues/46)) ([e09972f](https://github.com/amkfbant/monorepo-harness/commit/e09972f10cada88fc3cfbdb701423cdc585423a1))
* git-inclusive harness.workspace.status MCP read tool (A[#2](https://github.com/amkfbant/monorepo-harness/issues/2)) ([#48](https://github.com/amkfbant/monorepo-harness/issues/48)) ([f62f119](https://github.com/amkfbant/monorepo-harness/commit/f62f119db81b9618f6b7a887c3994deb3c226bdb))
* goal finding classify --then-rerun — auto-chain coder rerun (C[#8](https://github.com/amkfbant/monorepo-harness/issues/8)) ([#50](https://github.com/amkfbant/monorepo-harness/issues/50)) ([2c944db](https://github.com/amkfbant/monorepo-harness/commit/2c944db6aad15919998fe659702352b900e697d3))
* harness goal await-merge — poll a close_ready goal's PR to merge (C[#7](https://github.com/amkfbant/monorepo-harness/issues/7)) ([#49](https://github.com/amkfbant/monorepo-harness/issues/49)) ([a027585](https://github.com/amkfbant/monorepo-harness/commit/a0275851640637d690f9198cc2e6655ba37cd151))
* harness workspace — per-agent isolated worktrees for concurrent multi-agent work ([#35](https://github.com/amkfbant/monorepo-harness/issues/35)) ([fef0a41](https://github.com/amkfbant/monorepo-harness/commit/fef0a41adea6ec583aaf19a7fc5935234d5ac0d6))
* harness.workspace.checkpoint MCP mutation tool (A[#1](https://github.com/amkfbant/monorepo-harness/issues/1)) ([#47](https://github.com/amkfbant/monorepo-harness/issues/47)) ([8088cc5](https://github.com/amkfbant/monorepo-harness/commit/8088cc509234e9c7cf310cdeb23d542ba803f709))
* harness.workspace.list MCP read tool — coordination view (W4) ([#42](https://github.com/amkfbant/monorepo-harness/issues/42)) ([badc929](https://github.com/amkfbant/monorepo-harness/commit/badc9297744ba1771f209443c9141709f8042693))
* workspace adopt + path-first reconcile (B[#3](https://github.com/amkfbant/monorepo-harness/issues/3)) ([#45](https://github.com/amkfbant/monorepo-harness/issues/45)) ([9ede907](https://github.com/amkfbant/monorepo-harness/commit/9ede907b6469c5ab04b7ceca7956bddf3c991f5f))
* workspace checkpoint — advisory save + deterministic snapshot (W2b) ([#39](https://github.com/amkfbant/monorepo-harness/issues/39)) ([36e0178](https://github.com/amkfbant/monorepo-harness/commit/36e0178c46e7c50c9668855a7b3946c60e530d55))
* workspace conflicts — cross-agent changed-file overlap pre-check (B[#4](https://github.com/amkfbant/monorepo-harness/issues/4)) ([#43](https://github.com/amkfbant/monorepo-harness/issues/43)) ([090f8cc](https://github.com/amkfbant/monorepo-harness/commit/090f8cca31433bb8a90db466f6a23dc314989bed))
* workspace DB index — additive workspaces table + reconcile (W2a) ([#38](https://github.com/amkfbant/monorepo-harness/issues/38)) ([0c2d62c](https://github.com/amkfbant/monorepo-harness/commit/0c2d62c70bb0cf47b15edb9cbf276d9ca66ce351))
* workspace inspect — deterministic git briefing (W1) ([#37](https://github.com/amkfbant/monorepo-harness/issues/37)) ([588094b](https://github.com/amkfbant/monorepo-harness/commit/588094be6d5486717dbdc00b5df34dd7ead614d7))
* workspace recover — deterministic state reconstruction + next steps (W2c) ([#40](https://github.com/amkfbant/monorepo-harness/issues/40)) ([6bb5303](https://github.com/amkfbant/monorepo-harness/commit/6bb53036a08b8839396cf5780557e3f56a0051af))
* workspace status — deterministic progress projection for all agents (W3) ([#41](https://github.com/amkfbant/monorepo-harness/issues/41)) ([20721d2](https://github.com/amkfbant/monorepo-harness/commit/20721d2e3bfff989c5d012f078c40e200d92caea))
* workspace status heartbeat staleness (B[#5](https://github.com/amkfbant/monorepo-harness/issues/5)) ([#44](https://github.com/amkfbant/monorepo-harness/issues/44)) ([3752b2c](https://github.com/amkfbant/monorepo-harness/commit/3752b2cf66f805832a0cedf45307284bf6b36a33))

## [0.2.0](https://github.com/amkfbant/monorepo-harness/compare/v0.1.0...v0.2.0) (2026-06-06)


### Features

* auto-recover a failed coding run via a bounded rerun (not a dead-end) ([#34](https://github.com/amkfbant/monorepo-harness/issues/34)) ([d234123](https://github.com/amkfbant/monorepo-harness/commit/d234123da7b878d6e5300cf8386f5c7093085eab))
* bounded await for external PR review verdicts (async-checks slice 3) ([#29](https://github.com/amkfbant/monorepo-harness/issues/29)) ([62b209f](https://github.com/amkfbant/monorepo-harness/commit/62b209ff86b5a1b4b6418d1c6b0c108007c91abc))
* detect net test-case decrease in the tier-0 additive-only guard ([#32](https://github.com/amkfbant/monorepo-harness/issues/32)) ([6d4cf1f](https://github.com/amkfbant/monorepo-harness/commit/6d4cf1fcd11175f1c64f66a533082505dcee8240))
* ingest external PR review verdicts as advisory findings (async-checks slice 2) ([#28](https://github.com/amkfbant/monorepo-harness/issues/28)) ([873aaeb](https://github.com/amkfbant/monorepo-harness/commit/873aaeb0a77c89c12b292873a63a3e9afa96846a))
* inject open in-scope findings into the coder goal on a rerun ([#31](https://github.com/amkfbant/monorepo-harness/issues/31)) ([ed16413](https://github.com/amkfbant/monorepo-harness/commit/ed1641330d74997de668d404bd04c2280a0c53eb))
* operator-overridable auto-merge sensitivity map (tighten-only) ([#23](https://github.com/amkfbant/monorepo-harness/issues/23)) ([fd2a923](https://github.com/amkfbant/monorepo-harness/commit/fd2a923a6d7e49db9605445f3138d418a24f1e7c))
* resumable later-merge for CI-not-green auto-merge (slice 1 of async-checks) ([#27](https://github.com/amkfbant/monorepo-harness/issues/27)) ([1cb56f1](https://github.com/amkfbant/monorepo-harness/commit/1cb56f134d89e73ba4acdb37f81f2eaf38f51b4e))
* surface silent external-command (gh/Copilot) probe failures ([#33](https://github.com/amkfbant/monorepo-harness/issues/33)) ([bb4073a](https://github.com/amkfbant/monorepo-harness/commit/bb4073ac1cc038b4ea8b53b7283baad31095edbf))
* tests additive-only guard for tier-0 auto-merge ([#26](https://github.com/amkfbant/monorepo-harness/issues/26)) ([736885b](https://github.com/amkfbant/monorepo-harness/commit/736885b7bef121bd3fd547339dfa6974e561d130))

## [0.1.0](https://github.com/amkfbant/monorepo-harness/compare/v0.1.0...v0.1.0) (2026-06-05)


### Chores

* release 0.1.0 ([b032c38](https://github.com/amkfbant/monorepo-harness/commit/b032c3814f5bd4ba164f033129e362ca4dbad2ba))
