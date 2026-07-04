# Changelog

## [0.7.19](https://github.com/amkfbant/monorepo-harness/compare/v0.7.18...v0.7.19) (2026-07-04)


### Features

* **cli:** add run artifact-get ([c079a41](https://github.com/amkfbant/monorepo-harness/commit/c079a41df5275036f21a5c828efb605914ab54b6)), closes [#421](https://github.com/amkfbant/monorepo-harness/issues/421)

## [0.7.18](https://github.com/amkfbant/monorepo-harness/compare/v0.7.17...v0.7.18) (2026-07-04)


### Features

* agent-usage telemetry — agent_invocation/agent_usage_turn dual-write ([#206](https://github.com/amkfbant/monorepo-harness/issues/206) Phase-1) ([5b89cf8](https://github.com/amkfbant/monorepo-harness/commit/5b89cf8c88c53c1caff9278801ba1763325fc945))
* **claude:** [#191](https://github.com/amkfbant/monorepo-harness/issues/191) follow-up — claude in orchestrate/MCP coder, usage internal, claude review auto ([#360](https://github.com/amkfbant/monorepo-harness/issues/360)) ([5e49810](https://github.com/amkfbant/monorepo-harness/commit/5e4981094350ec22b39be9fdef8ba3a6e5ad1081))
* **claude:** claude -p coder backend (opt-in) — [#191](https://github.com/amkfbant/monorepo-harness/issues/191) Phase-B/C ([#359](https://github.com/amkfbant/monorepo-harness/issues/359)) ([b6ec676](https://github.com/amkfbant/monorepo-harness/commit/b6ec67681ab1dcd7f00c60eed8fa5bcdc8f329db))
* **codex:** external codex exec usage telemetry ([#206](https://github.com/amkfbant/monorepo-harness/issues/206) Phase-2) ([a99f87d](https://github.com/amkfbant/monorepo-harness/commit/a99f87d1cf7b9b251d4de63ad0defc82c900a855))
* **db:** external_review_events table + repository ([#395](https://github.com/amkfbant/monorepo-harness/issues/395) P0+P1) ([#397](https://github.com/amkfbant/monorepo-harness/issues/397)) ([6138a59](https://github.com/amkfbant/monorepo-harness/commit/6138a59b7cbc2098dd194338aacf168ca2a5e674))
* **hitch:** [#91](https://github.com/amkfbant/monorepo-harness/issues/91) Stage A — hitch evidence store & surface ([#367](https://github.com/amkfbant/monorepo-harness/issues/367)) ([332cf56](https://github.com/amkfbant/monorepo-harness/commit/332cf5685dd1aef1d72a60a9ce0ddd50e091903d))
* **hitch:** [#91](https://github.com/amkfbant/monorepo-harness/issues/91) Stage B — evidence_attached deterministic close-condition gate ([#368](https://github.com/amkfbant/monorepo-harness/issues/368)) ([637a0b7](https://github.com/amkfbant/monorepo-harness/commit/637a0b747e48502433d71c48cedf6bb05c229881))
* **hitch:** defer --to-issue links an existing issue URL ([#90](https://github.com/amkfbant/monorepo-harness/issues/90) Stage B) ([#366](https://github.com/amkfbant/monorepo-harness/issues/366)) ([d3f12dc](https://github.com/amkfbant/monorepo-harness/commit/d3f12dc5ab932436d187de25b02aba409e07a726))
* **hitch:** record external review verdicts to the v40 ledger ([#395](https://github.com/amkfbant/monorepo-harness/issues/395) P2, Site A) ([#399](https://github.com/amkfbant/monorepo-harness/issues/399)) ([7b841fa](https://github.com/amkfbant/monorepo-harness/commit/7b841faa77c894e58c2d73a7b12ae79d3b2e9663))
* **policy:** per-project coder backend via policy.codex.backend ([#191](https://github.com/amkfbant/monorepo-harness/issues/191)) ([#361](https://github.com/amkfbant/monorepo-harness/issues/361)) ([bbc0c91](https://github.com/amkfbant/monorepo-harness/commit/bbc0c91eb82360fde971181ac7c2783f60a3e9e9))
* **reporter:** [#90](https://github.com/amkfbant/monorepo-harness/issues/90) Stage A — surface deferredBacklogItemId on finding display surfaces ([#365](https://github.com/amkfbant/monorepo-harness/issues/365)) ([c6d4bb6](https://github.com/amkfbant/monorepo-harness/commit/c6d4bb67e1779974cc3ba2f9b37d8b5b39502344))
* **reporter:** hitch summary across a course ([#84](https://github.com/amkfbant/monorepo-harness/issues/84) Stage A) ([#362](https://github.com/amkfbant/monorepo-harness/issues/362)) ([7d1d8c7](https://github.com/amkfbant/monorepo-harness/commit/7d1d8c75d3a4b9b958e19730d6051b64360d23ce))
* **reporter:** hitch summary status/domain filter (--status/--domain) ([#84](https://github.com/amkfbant/monorepo-harness/issues/84) Stage C) ([#364](https://github.com/amkfbant/monorepo-harness/issues/364)) ([89f9418](https://github.com/amkfbant/monorepo-harness/commit/89f9418738e0b7ca838fc43ea9ff27343c2a7256))
* **reporter:** hitch summary time window (--since/--until) ([#84](https://github.com/amkfbant/monorepo-harness/issues/84) Stage B) ([#363](https://github.com/amkfbant/monorepo-harness/issues/363)) ([5e54ea5](https://github.com/amkfbant/monorepo-harness/commit/5e54ea5e5a1e3d1ccec73cc3a7a9dcb040ea1280))
* **safety:** [#410](https://github.com/amkfbant/monorepo-harness/issues/410) Phase 2 — clone-based run workspace isolation (opt-in) ([#414](https://github.com/amkfbant/monorepo-harness/issues/414)) ([201297c](https://github.com/amkfbant/monorepo-harness/commit/201297c49b27d044aab3677c17df4846537fab63))
* **safety:** [#410](https://github.com/amkfbant/monorepo-harness/issues/410) ship clone isolation for the self project profile ([#416](https://github.com/amkfbant/monorepo-harness/issues/416)) ([aa2be3b](https://github.com/amkfbant/monorepo-harness/commit/aa2be3b2da200c86931e20355a67066868b735c0))
* **telemetry:** Claude subagent usage consumer ([#206](https://github.com/amkfbant/monorepo-harness/issues/206) Phase-3 / [#235](https://github.com/amkfbant/monorepo-harness/issues/235)) ([7d2ee00](https://github.com/amkfbant/monorepo-harness/commit/7d2ee003d9a5097270f197bdbee021816ea315dd))
* **usage:** add 'harness usage codex' read path for external codex usage ([#403](https://github.com/amkfbant/monorepo-harness/issues/403)) ([#420](https://github.com/amkfbant/monorepo-harness/issues/420)) ([8c4df6c](https://github.com/amkfbant/monorepo-harness/commit/8c4df6c893311ee625fd8e8cb1ca1f05165e7bdb))


### Bug Fixes

* [#393](https://github.com/amkfbant/monorepo-harness/issues/393) finding-92 validate operations review override payload types (run-20260624-self-mqsaelri97d37bdb) ([da417bd](https://github.com/amkfbant/monorepo-harness/commit/da417bd1c45d8bc7bde357a224a27ceceae8f74e))
* [#393](https://github.com/amkfbant/monorepo-harness/issues/393) finding-92 validate operations review override payload types (run-20260624-self-mqsaelri97d37bdb) ([c2616e7](https://github.com/amkfbant/monorepo-harness/commit/c2616e7e686e1932dd416eb7970e1d00fe6c1d49))
* [#404](https://github.com/amkfbant/monorepo-harness/issues/404) reclaim stale worktrees on run start (git worktree prune) ([#406](https://github.com/amkfbant/monorepo-harness/issues/406)) ([74582d1](https://github.com/amkfbant/monorepo-harness/commit/74582d1eb33cf3579a4f8919a623725cce6ee353))
* [#404](https://github.com/amkfbant/monorepo-harness/issues/404) reclaim terminal run worktrees on run start (follow-up) ([#407](https://github.com/amkfbant/monorepo-harness/issues/407)) ([708addd](https://github.com/amkfbant/monorepo-harness/commit/708adddc61d08e4845e9ba6f248ebf626c398973))
* Avoid empty knowledge decisions exports (run-20260624-self-mqs91ny1cbed8b6b) ([bbf30d1](https://github.com/amkfbant/monorepo-harness/commit/bbf30d10885066463e9ed670fc0dc99f4d8d5c36))
* Avoid empty knowledge decisions exports (run-20260624-self-mqs91ny1cbed8b6b) ([c903896](https://github.com/amkfbant/monorepo-harness/commit/c903896563013bd57087daa4b8fa3e318bf0d932))
* block manual review-consensus close-check certification ([#376](https://github.com/amkfbant/monorepo-harness/issues/376)) ([7e4a8ce](https://github.com/amkfbant/monorepo-harness/commit/7e4a8cee92fb1b45442df9371755904b1e00db1b))
* cover course.ts/onboard.ts in release CLI_PATHS + coverage gate ([#317](https://github.com/amkfbant/monorepo-harness/issues/317)) ([12761ba](https://github.com/amkfbant/monorepo-harness/commit/12761ba39b831561ad5e7e9f3b512860110a924c))
* detect BREAKING-CHANGE conventional commit footer ([#388](https://github.com/amkfbant/monorepo-harness/issues/388)) ([744cf28](https://github.com/amkfbant/monorepo-harness/commit/744cf2893596467d7561231356ebb4af8f4f14fe))
* guard continuation materialization against ancestor symlinks ([#372](https://github.com/amkfbant/monorepo-harness/issues/372)) ([f41d827](https://github.com/amkfbant/monorepo-harness/commit/f41d82787ca12c163c0561b2457d8165d5436f38))
* **hitch:** [#396](https://github.com/amkfbant/monorepo-harness/issues/396) part 2 — transient close-PR push rechecks instead of terminal-escalate ([#418](https://github.com/amkfbant/monorepo-harness/issues/418)) ([23f7af7](https://github.com/amkfbant/monorepo-harness/commit/23f7af7df9cf820ce5a657cb9e2793c543a7ef3e))
* ignore invalid rejected indices in knowledge digest ([#390](https://github.com/amkfbant/monorepo-harness/issues/390)) ([3dab4b4](https://github.com/amkfbant/monorepo-harness/commit/3dab4b4a9d854fc4492dcb905ece3ab3ffd2d028))
* make phase update atomic ([#384](https://github.com/amkfbant/monorepo-harness/issues/384)) ([eb381c8](https://github.com/amkfbant/monorepo-harness/commit/eb381c868bc3f2b8e64dacbe5128968718b78da1))
* preserve truncated artifact status during blob migration ([#386](https://github.com/amkfbant/monorepo-harness/issues/386)) ([62810ae](https://github.com/amkfbant/monorepo-harness/commit/62810ae6f725b7cade2df096fadb53b29f0cb039))
* prevent MCP finding scope downgrade on ingest ([#374](https://github.com/amkfbant/monorepo-harness/issues/374)) ([701757e](https://github.com/amkfbant/monorepo-harness/commit/701757e62a857e50a62f5c0af78abc7f51f48ee1))
* redact codex tail artifacts ([#382](https://github.com/amkfbant/monorepo-harness/issues/382)) ([7bed19e](https://github.com/amkfbant/monorepo-harness/commit/7bed19ea5066d2485bf6fabc2e9645dcecc26eeb))
* redact name-based secrets in codex events ([#378](https://github.com/amkfbant/monorepo-harness/issues/378)) ([779319c](https://github.com/amkfbant/monorepo-harness/commit/779319c03e8800975d296a2bcb27773485e0c06e))
* **safety:** [#410](https://github.com/amkfbant/monorepo-harness/issues/410) repair core.bare flip at run start + workspace isolation design ([#411](https://github.com/amkfbant/monorepo-harness/issues/411)) ([6193453](https://github.com/amkfbant/monorepo-harness/commit/6193453c338c9ea91c90ee1528eec1a4448539da))
* scan full untracked inline content for secrets ([#380](https://github.com/amkfbant/monorepo-harness/issues/380)) ([279fecc](https://github.com/amkfbant/monorepo-harness/commit/279feccab6872ce2d58d49567c70f1342cdc4f8a))
* **telemetry:** [#206](https://github.com/amkfbant/monorepo-harness/issues/206) follow-up — ingest robustness, fail-open, never-gates, hygiene ([#354](https://github.com/amkfbant/monorepo-harness/issues/354)) ([5acb7d0](https://github.com/amkfbant/monorepo-harness/commit/5acb7d06c6ab50159462b3abfbc2c6885bbd8d29))


### Refactors

* **cli:** split course.ts course/phase command groups into sub-modules ([#125](https://github.com/amkfbant/monorepo-harness/issues/125) A15) ([#330](https://github.com/amkfbant/monorepo-harness/issues/330)) ([5f92892](https://github.com/amkfbant/monorepo-harness/commit/5f9289227b5c056b9180c5070b584e841cbf0ef0))
* **cli:** split db.ts command group into per-concern sub-modules ([#125](https://github.com/amkfbant/monorepo-harness/issues/125) A15) ([#328](https://github.com/amkfbant/monorepo-harness/issues/328)) ([467a3f1](https://github.com/amkfbant/monorepo-harness/commit/467a3f19b32be48bde2e19719ff4f8c2c2d38bbf))
* **cli:** split hitch.ts command group into per-concern sub-modules ([#125](https://github.com/amkfbant/monorepo-harness/issues/125) A15) ([#331](https://github.com/amkfbant/monorepo-harness/issues/331)) ([fdb2651](https://github.com/amkfbant/monorepo-harness/commit/fdb265191c7a3a25b44b81220676a7652ff21f25))
* **cli:** split knowledge.ts command group into per-concern sub-modules ([#125](https://github.com/amkfbant/monorepo-harness/issues/125) A15) ([#329](https://github.com/amkfbant/monorepo-harness/issues/329)) ([92945ac](https://github.com/amkfbant/monorepo-harness/commit/92945acef2d5694526b1a1e4477fc90286deb59c))
* **core:** extract review-processor types + path implementations ([#125](https://github.com/amkfbant/monorepo-harness/issues/125) A15) ([#333](https://github.com/amkfbant/monorepo-harness/issues/333)) ([740d3c5](https://github.com/amkfbant/monorepo-harness/commit/740d3c51f63ca6ac750108161a9d307b7de12c9f))
* **core:** extract review-rule types + snapshot reader ([#125](https://github.com/amkfbant/monorepo-harness/issues/125) A15) ([#335](https://github.com/amkfbant/monorepo-harness/issues/335)) ([9012ff8](https://github.com/amkfbant/monorepo-harness/commit/9012ff8298cc35de28bbb80b2a5da278b79986fa))
* **core:** extract reviewer-agent prompt/decision/types/usage modules ([#125](https://github.com/amkfbant/monorepo-harness/issues/125) A15) ([#336](https://github.com/amkfbant/monorepo-harness/issues/336)) ([fcb4f62](https://github.com/amkfbant/monorepo-harness/commit/fcb4f6237f82ec8481a8dbd5c04abcfd22a09765))
* **core:** split workflow-runner.ts into shared/diff/inner modules ([#125](https://github.com/amkfbant/monorepo-harness/issues/125) A15) ([#343](https://github.com/amkfbant/monorepo-harness/issues/343)) ([ed80856](https://github.com/amkfbant/monorepo-harness/commit/ed808563aa2683db123cd66ea0318417143ee5d2))
* **dashboard:** split server.ts into route/auth/types modules ([#125](https://github.com/amkfbant/monorepo-harness/issues/125) A15) ([#339](https://github.com/amkfbant/monorepo-harness/issues/339)) ([4a78aee](https://github.com/amkfbant/monorepo-harness/commit/4a78aeef25864bd1ca0ddb209e316ec291131282))
* **db:** extract RunFinalizeRepository + types from runs.ts ([#125](https://github.com/amkfbant/monorepo-harness/issues/125) A15) ([#341](https://github.com/amkfbant/monorepo-harness/issues/341)) ([d4427c3](https://github.com/amkfbant/monorepo-harness/commit/d4427c322d7b831a202cfccf6f87d96dd37bfe54))
* extract lock command group into src/cli/lock.ts ([#125](https://github.com/amkfbant/monorepo-harness/issues/125)) ([#319](https://github.com/amkfbant/monorepo-harness/issues/319)) ([689ef39](https://github.com/amkfbant/monorepo-harness/commit/689ef398735f8aa3480902be656437283e47a01a))
* extract release/rerun/diagnostics command groups from run.ts ([#125](https://github.com/amkfbant/monorepo-harness/issues/125)) ([#321](https://github.com/amkfbant/monorepo-harness/issues/321)) ([718afcf](https://github.com/amkfbant/monorepo-harness/commit/718afcfebdd7e4cd034558dd5625dd1219d3eedc))
* extract review/knowledge/workspace command groups from run.ts ([#125](https://github.com/amkfbant/monorepo-harness/issues/125)) ([#322](https://github.com/amkfbant/monorepo-harness/issues/322)) ([1c49b5f](https://github.com/amkfbant/monorepo-harness/commit/1c49b5f12ca487797cb9b4886d2dacab94047709))
* extract run-core logic + pr/backlog from run.ts ([#125](https://github.com/amkfbant/monorepo-harness/issues/125) complete) ([#323](https://github.com/amkfbant/monorepo-harness/issues/323)) ([575e89f](https://github.com/amkfbant/monorepo-harness/commit/575e89f02b8f8a82034aeb911128715412ef49b9))
* **hitch:** extract convergence types + metrics helpers ([#125](https://github.com/amkfbant/monorepo-harness/issues/125) A15) ([#342](https://github.com/amkfbant/monorepo-harness/issues/342)) ([b42fde6](https://github.com/amkfbant/monorepo-harness/commit/b42fde677ed2c2bdd5a2bc0d7929dc491021ea63))
* **hitch:** repository.ts C0-C4 sub-repo split + B8/B9 meta-tests ([#125](https://github.com/amkfbant/monorepo-harness/issues/125)) ([#325](https://github.com/amkfbant/monorepo-harness/issues/325)) ([c8590b4](https://github.com/amkfbant/monorepo-harness/commit/c8590b46a4ef81f228811a80efe43bda0aa92c8c))
* **hitch:** split orchestrator-runners.ts into per-concern modules ([#125](https://github.com/amkfbant/monorepo-harness/issues/125) A15) ([#345](https://github.com/amkfbant/monorepo-harness/issues/345)) ([fdc9f90](https://github.com/amkfbant/monorepo-harness/commit/fdc9f903c37cf81f31189aed6db79805b59e2a20))
* **mcp:** split dry-run-tools.ts into a per-domain barrel ([#125](https://github.com/amkfbant/monorepo-harness/issues/125) A15) ([#338](https://github.com/amkfbant/monorepo-harness/issues/338)) ([1ebc595](https://github.com/amkfbant/monorepo-harness/commit/1ebc59516f34634523bc1cef4308ba6876a5955e))
* **mcp:** split hitch-tools.ts into a per-concern barrel ([#125](https://github.com/amkfbant/monorepo-harness/issues/125) A15) ([#340](https://github.com/amkfbant/monorepo-harness/issues/340)) ([c380ce2](https://github.com/amkfbant/monorepo-harness/commit/c380ce2cd37785716f53ccfe93c14ec704528ba5))
* **mcp:** split mutation-tools.ts into a per-concern barrel ([#125](https://github.com/amkfbant/monorepo-harness/issues/125) A15) ([#344](https://github.com/amkfbant/monorepo-harness/issues/344)) ([2628c4b](https://github.com/amkfbant/monorepo-harness/commit/2628c4b215b2ebb33d05863ab99616f63692c933))
* **mcp:** split read-tools.ts into a per-domain barrel ([#125](https://github.com/amkfbant/monorepo-harness/issues/125) A15) ([#337](https://github.com/amkfbant/monorepo-harness/issues/337)) ([4bbc0a3](https://github.com/amkfbant/monorepo-harness/commit/4bbc0a33bdc624f3f21b71912ea9439f8727ce9f))
* **roadmap:** extract course-orchestrator types + helpers ([#125](https://github.com/amkfbant/monorepo-harness/issues/125) A15) ([#332](https://github.com/amkfbant/monorepo-harness/issues/332)) ([7283535](https://github.com/amkfbant/monorepo-harness/commit/72835353f1051bab9622e53dcb03eeef88e6b82c))

## [0.7.17](https://github.com/amkfbant/monorepo-harness/compare/v0.7.16...v0.7.17) (2026-06-19)


### Bug Fixes

* [#303](https://github.com/amkfbant/monorepo-harness/issues/303): db-first artifact sync で意図的 quarantine と削除済 artifact を区別し stale 行を prune（[#272](https://github.com/amkfbant/monorepo-harness/issues/272) transcript 保持は維持） ([#310](https://github.com/amkfbant/monorepo-harness/issues/310)) ([508b5cf](https://github.com/amkfbant/monorepo-harness/commit/508b5cf61a13cff9becf8c48976d70d84ec1d2e2))
* [#306](https://github.com/amkfbant/monorepo-harness/issues/306): review import（findings import + supersede 解決 + cycle 完了）を単一 transaction で atomic 化（crash-partial 解消） ([#313](https://github.com/amkfbant/monorepo-harness/issues/313)) ([5ed4393](https://github.com/amkfbant/monorepo-harness/commit/5ed4393ca3f545edcd30f96c90b38e13945a42e4))
* [#308](https://github.com/amkfbant/monorepo-harness/issues/308): facet_red_test の recovery routing 改善（fail-open message 保持・no-test facet pending を coder へ・evidence-recoverable は ask_human 維持） ([#312](https://github.com/amkfbant/monorepo-harness/issues/312)) ([814230e](https://github.com/amkfbant/monorepo-harness/commit/814230ef1a54d2a5993b8388646da6358f0838d1))

## [0.7.16](https://github.com/amkfbant/monorepo-harness/compare/v0.7.15...v0.7.16) (2026-06-19)


### Bug Fixes

* [#270](https://github.com/amkfbant/monorepo-harness/issues/270): テスト TMPDIR leak を per-run private subroot で解消（globalSetup で harness-vitest-run-* 作成→TMPDIR redirect、teardown で自分の subroot のみ削除）+ leak 検知テスト ([#300](https://github.com/amkfbant/monorepo-harness/issues/300)) ([be1189f](https://github.com/amkfbant/monorepo-harness/commit/be1189fb5b07a34b4a514918cbeccfc6483a6511))
* [#271](https://github.com/amkfbant/monorepo-harness/issues/271): DB schema version-skew の早期検出 + 方向別の actionable guidance（schema-compat ヘルパ + orchestrate preflight + upgrade-check 改善） ([#301](https://github.com/amkfbant/monorepo-harness/issues/301)) ([b0a8d0a](https://github.com/amkfbant/monorepo-harness/commit/b0a8d0a831fcb66c7b242307544b33db1aea300c))
* [#272](https://github.com/amkfbant/monorepo-harness/issues/272): reviewer verdict を round 中 DB-only 化（per-reviewer review-decision.yaml を file-export gate）+ read-jail 不到達の fail-closed assertion ([#302](https://github.com/amkfbant/monorepo-harness/issues/302)) ([a3867a3](https://github.com/amkfbant/monorepo-harness/commit/a3867a3f0ec8f9a34cca6b7032a28203e8f841da))
* [#278](https://github.com/amkfbant/monorepo-harness/issues/278): 後続 approve 時に先行 cycle の review-blocking findings を deterministic 自動解決（resolveSupersededReviewFindings） ([#305](https://github.com/amkfbant/monorepo-harness/issues/305)) ([4e2b04f](https://github.com/amkfbant/monorepo-harness/commit/4e2b04ff626b651318074d75a4ed55f20da3c3fe))
* [#279](https://github.com/amkfbant/monorepo-harness/issues/279): 新 close-check kind facet_red_test（contracted facet ごとの RED test を run_changed_files+記録 evidence で deterministic 検証・opt-in・fail-closed）+ reviewer prompt 強化(advisory) ([#307](https://github.com/amkfbant/monorepo-harness/issues/307)) ([faee27e](https://github.com/amkfbant/monorepo-harness/commit/faee27e2a54450c841eaea74a52859ede91d2049))
* [#280](https://github.com/amkfbant/monorepo-harness/issues/280): cumulative-diverging hitch の sanctioned gated recovery（hitch recover-diverging・open P0/P1=0 ∧ close-check 緑で budget 拡張・非budget trigger は fail-closed 拒否） ([#309](https://github.com/amkfbant/monorepo-harness/issues/309)) ([6b1b935](https://github.com/amkfbant/monorepo-harness/commit/6b1b935039f76155453525e19399c793487b89f7))
* [#283](https://github.com/amkfbant/monorepo-harness/issues/283): 非actionable advisory category を divergence churn counter から除外（category-based・scope非依存） ([#304](https://github.com/amkfbant/monorepo-harness/issues/304)) ([97065a1](https://github.com/amkfbant/monorepo-harness/commit/97065a14fc5915634dbaa36e3cb7c051eb604b70))
* [#296](https://github.com/amkfbant/monorepo-harness/issues/296): phase.link_hitch に handler-side ensureProjectVisible 追加（sibling phase tool と対称化・null-project fail-closed） ([#299](https://github.com/amkfbant/monorepo-harness/issues/299)) ([b3058cf](https://github.com/amkfbant/monorepo-harness/commit/b3058cff37ab30863418232f27af5f3c95630f0b))
* harness fix [#275](https://github.com/amkfbant/monorepo-harness/issues/275): failed-command(allowed) parent からの rerun 継続許可（[#163](https://github.com/amkfbant/monorepo-harness/issues/163) follow-up） (run-20260618-self-mqirlh6c6ec14ed6) ([#276](https://github.com/amkfbant/monorepo-harness/issues/276)) ([8493cf9](https://github.com/amkfbant/monorepo-harness/commit/8493cf94240df66b9886f7fb249088b3f729b417))
* **review:** ignore OS metadata (.DS_Store/._*) in reviewer tamper snapshot ([#269](https://github.com/amkfbant/monorepo-harness/issues/269)) ([#273](https://github.com/amkfbant/monorepo-harness/issues/273)) ([00c5407](https://github.com/amkfbant/monorepo-harness/commit/00c54070dedb8b6ba5a7cd6e920a23305e24a3cb))
* SP-1: 逐次 migration（v32 review_refute_votes / v33 phases.review_state_version ALTER。v31 jury は [#230](https://github.com/amkfbant/monorepo-harness/issues/230) 出荷済・不変）+ ALL_TABLE_NA (run-20260617-self-mqhf93f4fe427c70) ([#261](https://github.com/amkfbant/monorepo-harness/issues/261)) ([a140eab](https://github.com/amkfbant/monorepo-harness/commit/a140eabc86283ce072e63c9da2b75eff8f93155c))
* SP-10: profile review: schema + ReviewRule 解決（compile/resolveEffectiveRule/CompileError）+ 全入口 thread（共有成果物） (run-20260617-self-mqhkyut6ad324370) ([#266](https://github.com/amkfbant/monorepo-harness/issues/266)) ([a16329c](https://github.com/amkfbant/monorepo-harness/commit/a16329c3be21f54a49eb6a58c28b95df98dcfcdd))
* SP-11: listByGroup + consensus 集約決定論 + P1-ISO（3基準・SP-12除外・高budget・既知finding seed） (run-20260617-self-mqhw6b5j2ce7d6bf) ([#267](https://github.com/amkfbant/monorepo-harness/issues/267)) ([ce38cf5](https://github.com/amkfbant/monorepo-harness/commit/ce38cf5198848816c54eefae60f271040645c380))
* SP-12: consensus N-reviewer dispatch + C4 frozen-set partial-failure safety gate ([#277](https://github.com/amkfbant/monorepo-harness/issues/277)) ([3015abc](https://github.com/amkfbant/monorepo-harness/commit/3015abc5c669a6cbf22e83a4df7af031d9388f33))
* SP-13: reviewed-run consensus rule 明示拒否（ReviewWorkflowUnsupportedError、--dry-run 含む agent 起動前） ([#282](https://github.com/amkfbant/monorepo-harness/issues/282)) ([ab9c1d9](https://github.com/amkfbant/monorepo-harness/commit/ab9c1d9e17a78153c46b66b16374749dcd5ca23d))
* SP-14: 案B-1a docs/specs + 入口別 thread integration + 回帰（大Phase B gate） (run-20260618-self-mqj4y54a0e2a8b3b) ([#284](https://github.com/amkfbant/monorepo-harness/issues/284)) ([e3d77ac](https://github.com/amkfbant/monorepo-harness/commit/e3d77ace101aaec277e6fd8fab699062fb6db9c5))
* SP-15: lens 別 prompt 配線（multi-lens 本物化 + MECE preflight + untrusted lens fence） ([#286](https://github.com/amkfbant/monorepo-harness/issues/286)) ([7b6d4fc](https://github.com/amkfbant/monorepo-harness/commit/7b6d4fc0ab2795c671b93c3b10bcbf251c13a766))
* SP-16: refute target binding data model（normalizeChangeText / targetChangeHash / verifyRefuteBinding + versioned hash + verify-and-record adapter + doctor） ([#288](https://github.com/amkfbant/monorepo-harness/issues/288)) ([5e6e0af](https://github.com/amkfbant/monorepo-harness/commit/5e6e0af2cd575432d1b4efd841a6d72472c943b0))
* SP-17: refute requirement DSL + runRefuteAgent + evaluateConsensus 第2 requirement（P2-A/B/C・厳密 majority・fail-closed） ([#290](https://github.com/amkfbant/monorepo-harness/issues/290)) ([e6fd359](https://github.com/amkfbant/monorepo-harness/commit/e6fd35921e7577aa414b019df141bb2606acac96))
* SP-18: orchestrator refute dispatch + advisory 反映 + docs + 回帰（大Phase B'' gate） ([#292](https://github.com/amkfbant/monorepo-harness/issues/292)) ([8574a9d](https://github.com/amkfbant/monorepo-harness/commit/8574a9d17b91f918649f5191405793d1d22fef7a))
* SP-19: spec-gates 抽出 + gap→kind 写像 + validateCloseConditions（大Phase C [#231](https://github.com/amkfbant/monorepo-harness/issues/231) SP-A） ([#293](https://github.com/amkfbant/monorepo-harness/issues/293)) ([917791a](https://github.com/amkfbant/monorepo-harness/commit/917791ad4d1bb49c73791332c7dcf1e324d4db20))
* SP-2: v32 review_refute_votes repository のみ（precomputed target_change_hash の append/list/dedupe・存在/hitch一致 hard 検査） (run-20260617-self-mqhh7or69b543acd) ([#263](https://github.com/amkfbant/monorepo-harness/issues/263)) ([6408fc7](https://github.com/amkfbant/monorepo-harness/commit/6408fc7757d862e9ff70ebc1033e46e21e348b09))
* SP-20: write barrier 接続（createSession choke point / expand_scope update path / phase updateSpec） (run-20260618-self-mqk3nn2k404af8f6) ([#294](https://github.com/amkfbant/monorepo-harness/issues/294)) ([7432aa0](https://github.com/amkfbant/monorepo-harness/commit/7432aa0aca2703bf7f4e6d4f4457f39fda871f56))
* SP-21: phase ratify（recordSpecApproval）+ link/start-hitch 整合 gate + specHash drift (run-20260618-self-mqk5luss477786dd) ([#295](https://github.com/amkfbant/monorepo-harness/issues/295)) ([1a8ecd1](https://github.com/amkfbant/monorepo-harness/commit/1a8ecd12bc69b76e6bf82a20e03be2213bd4b6f5))
* SP-22: runtime spec drift 診断（ask_human message enrichment） (run-20260619-self-mqk7smfo65d750f4) ([#297](https://github.com/amkfbant/monorepo-harness/issues/297)) ([bfcfca0](https://github.com/amkfbant/monorepo-harness/commit/bfcfca0bbeb604cc13fed718107497078d1d960f))
* SP-23: 案C spec-review-layer docs + 大Phase C gate（[#231](https://github.com/amkfbant/monorepo-harness/issues/231)・最終） ([#298](https://github.com/amkfbant/monorepo-harness/issues/298)) ([dea0813](https://github.com/amkfbant/monorepo-harness/commit/dea0813cae7c0e4b0e22c7b5fe2e9541dab92b23))
* SP-3: review_state CAS 書込経路（updateReviewState / recordSpecApproval、bounded retry N→typed conflict error） (run-20260617-self-mqhi2b5od5f2cbc4) ([#264](https://github.com/amkfbant/monorepo-harness/issues/264)) ([80b7462](https://github.com/amkfbant/monorepo-harness/commit/80b7462c67887da91907899bd787c9a0fe1aa5d7))
* SP-3D: consistency-doctor 整合 check（v32 review_refute_votes の orphan + hitch_id 整合 advisory） (run-20260617-self-mqhk199qff5e5903) ([#265](https://github.com/amkfbant/monorepo-harness/issues/265)) ([60df00d](https://github.com/amkfbant/monorepo-harness/commit/60df00da74c8d7d253a526ddc8fff8f5a3e72e76))

## [0.7.15](https://github.com/amkfbant/monorepo-harness/compare/v0.7.14...v0.7.15) (2026-06-16)


### Features

* **hitch:** [#230](https://github.com/amkfbant/monorepo-harness/issues/230) deliberation jury — 5-stage classification, v31 audit, MCDA decision packet ([#254](https://github.com/amkfbant/monorepo-harness/issues/254)) ([846db38](https://github.com/amkfbant/monorepo-harness/commit/846db38856287c0f951dd7f2aad5b5efd43efb6d))

## [0.7.14](https://github.com/amkfbant/monorepo-harness/compare/v0.7.13...v0.7.14) (2026-06-16)


### Bug Fixes

* **hitch:** honor --base-branch over the project profile base branch ([#236](https://github.com/amkfbant/monorepo-harness/issues/236)) ([#250](https://github.com/amkfbant/monorepo-harness/issues/250)) ([c8e5ede](https://github.com/amkfbant/monorepo-harness/commit/c8e5ede78c821fd536cf7f2df0169c23505959c8))

## [0.7.13](https://github.com/amkfbant/monorepo-harness/compare/v0.7.12...v0.7.13) (2026-06-15)


### Bug Fixes

* **orchestrate:** abort the in-flight hitch drive on course-lease loss ([#132](https://github.com/amkfbant/monorepo-harness/issues/132)) ([#249](https://github.com/amkfbant/monorepo-harness/issues/249)) ([3b41a4c](https://github.com/amkfbant/monorepo-harness/commit/3b41a4c33eafc8ada9ba4d256acd24585858546e))
* **rollup:** re-derive force-closed phase decision live + add phase audit note ([#171](https://github.com/amkfbant/monorepo-harness/issues/171)) ([#247](https://github.com/amkfbant/monorepo-harness/issues/247)) ([b666e70](https://github.com/amkfbant/monorepo-harness/commit/b666e70ee38dfde568badd0b8e4f718acc205649))

## [0.7.12](https://github.com/amkfbant/monorepo-harness/compare/v0.7.11...v0.7.12) (2026-06-15)


### Bug Fixes

* **convergence:** re-derive diverging live so a cleared trigger self-heals ([#164](https://github.com/amkfbant/monorepo-harness/issues/164)) ([#244](https://github.com/amkfbant/monorepo-harness/issues/244)) ([cd85e84](https://github.com/amkfbant/monorepo-harness/commit/cd85e84a06c417e78922e282106fcef7d38c6179))

## [0.7.11](https://github.com/amkfbant/monorepo-harness/compare/v0.7.10...v0.7.11) (2026-06-15)


### Bug Fixes

* **orchestrate:** resolve the run base from origin/&lt;base&gt;, fail-fast on an unresolvable base ([#154](https://github.com/amkfbant/monorepo-harness/issues/154), [#195](https://github.com/amkfbant/monorepo-harness/issues/195)) ([#242](https://github.com/amkfbant/monorepo-harness/issues/242)) ([4f81dc8](https://github.com/amkfbant/monorepo-harness/commit/4f81dc8e5fafe98e57331ef86b04c86134ab41ea))

## [0.7.10](https://github.com/amkfbant/monorepo-harness/compare/v0.7.9...v0.7.10) (2026-06-15)


### Bug Fixes

* **project:** extend ignore_untracked from profile + add Python artifacts to strict-monorepo-v1 ([#240](https://github.com/amkfbant/monorepo-harness/issues/240)) ([a52b607](https://github.com/amkfbant/monorepo-harness/commit/a52b607739d4de6bac662976f69231dc18b1b6ac)), closes [#239](https://github.com/amkfbant/monorepo-harness/issues/239)
* **security:** redact secret-shaped content in on-disk command logs ([#186](https://github.com/amkfbant/monorepo-harness/issues/186)) ([#238](https://github.com/amkfbant/monorepo-harness/issues/238)) ([368188e](https://github.com/amkfbant/monorepo-harness/commit/368188e534e592f106f0e1d85e7542ea6c45240f))

## [0.7.9](https://github.com/amkfbant/monorepo-harness/compare/v0.7.8...v0.7.9) (2026-06-15)


### Bug Fixes

* **git:** harden git object-graph integrity and authenticate harness commits in push gates ([#234](https://github.com/amkfbant/monorepo-harness/issues/234)) ([4024906](https://github.com/amkfbant/monorepo-harness/commit/402490626352c1f880010fe511fc18dc0fe7c401))

## [0.7.8](https://github.com/amkfbant/monorepo-harness/compare/v0.7.7...v0.7.8) (2026-06-15)


### Bug Fixes

* [[#197](https://github.com/amkfbant/monorepo-harness/issues/197)] review the last succeeded coder run before budget_exhausted ([#224](https://github.com/amkfbant/monorepo-harness/issues/224)) ([602181f](https://github.com/amkfbant/monorepo-harness/commit/602181f58e3fcdec9b4f9d1cbfac832f36d4465a))
* **git:** force --no-renames across all security diff gates so renames can't hide out-of-scope deletions ([#226](https://github.com/amkfbant/monorepo-harness/issues/226)) ([cf83033](https://github.com/amkfbant/monorepo-harness/commit/cf8303395bfd9bae89c820548b74afc0779a52cf))

## [0.7.7](https://github.com/amkfbant/monorepo-harness/compare/v0.7.6...v0.7.7) (2026-06-15)


### Bug Fixes

* [[#141](https://github.com/amkfbant/monorepo-harness/issues/141)/[#197](https://github.com/amkfbant/monorepo-harness/issues/197)] normalize the coder-committed worktree before review (close-check regression) + close two fail-opens it surfaced ([#221](https://github.com/amkfbant/monorepo-harness/issues/221)) ([a8ee6fa](https://github.com/amkfbant/monorepo-harness/commit/a8ee6fa9b373d0106230a9db4662af9aac8a580e))

## [0.7.6](https://github.com/amkfbant/monorepo-harness/compare/v0.7.5...v0.7.6) (2026-06-15)


### Bug Fixes

* [[#141](https://github.com/amkfbant/monorepo-harness/issues/141)] coder run per-run change budget (diff-size / deletion guard) — fail-closed pre-review gate (run-20260614-self-mqea1sf0e3e8c24f) ([#219](https://github.com/amkfbant/monorepo-harness/issues/219)) ([7945f8a](https://github.com/amkfbant/monorepo-harness/commit/7945f8ae6e21d985fa7fe25c520c8ced60fec4eb))

## [0.7.5](https://github.com/amkfbant/monorepo-harness/compare/v0.7.4...v0.7.5) (2026-06-14)


### Bug Fixes

* [[#168](https://github.com/amkfbant/monorepo-harness/issues/168)] course orchestrate: bounded budget consumption is budget_reached (exit 0), not budget_exhausted (run-20260614-self-mqe4wpaabd2918dd) ([#216](https://github.com/amkfbant/monorepo-harness/issues/216)) ([c0e675c](https://github.com/amkfbant/monorepo-harness/commit/c0e675ca299cc1f5bf080a09f24126e0df44d6fa))
* [[#183](https://github.com/amkfbant/monorepo-harness/issues/183)] fix(consensus): normal review import must use the DB-canonical decision, fail-closed when undeterminable (run-20260614-self-mqe6nl149682ab9f) ([#218](https://github.com/amkfbant/monorepo-harness/issues/218)) ([e975dc4](https://github.com/amkfbant/monorepo-harness/commit/e975dc49bb44544aa62e1ec50b6558a867714c5b))

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
