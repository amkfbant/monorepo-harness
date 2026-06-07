# Changelog

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
