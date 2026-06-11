# Design: `harness onboard` — guided onboarding wizard (#92)

Status: approved (brainstorm) — pending implementation plan.
Date: 2026-06-11.

## Problem

Standing up a new target repo on the harness requires ~15 steps scattered across
README sections and `docs/ops/`: inspect → init (profile/policy) → check →
`db init` / `db import` → write `.harness/mcp.yaml` by hand → serve. The biggest
pitfalls:

- **`.harness/mcp.yaml` is fully manual.** MCP mutations are gated **twice**
  (`decideMcpPermission`, `src/mcp/security/permissions.ts:120-135`): the client
  must resolve to `mode: guarded-mutation` **and** the operation must be in
  `allowedOperations` (read tools and dry-run are unaffected — only the mutation
  allowlist defaults to deny-all). A repo set up without a `clients` entry +
  `allowedOperations` has every MCP mutation denied with no obvious cause
  (`mutation_disabled_for_client` / `operation_not_allowed`; cf. #81).
- `project import` vs `db import --from-files` is undocumented/ambiguous.
- A first-time operator has no single, ordered, resumable path; setup-induced
  escalations result.

`harness onboard` collects these into one **interactive TTY wizard** that drives
the safe deterministic steps and guides the external ones.

## Scope

In scope (the wizard **drives**, up to a serve smoke check):

1. Preflight (HARNESS_ROOT; probe codex/gh — report only).
2. `inspect` the repo → present domain candidates.
3. Profile + policy: dry-run proposal → confirm → write
   `projects/<id>.yaml` + `policies/repos/<id>.yaml` (+ scaffold
   `policies/global.yaml` if missing, via #78).
4. `check` the profile (ok/warn/error).
5. DB: `db import --from-files` (registers the project DB-canonically; it runs
   migrations, so a standalone `db init` is redundant) → `db check-consistency`.
6. Generate/merge `.harness/mcp.yaml` (add the project to `allowedProjects`,
   respecting the allow-all case; mutations stay deny-all unless the operator
   opts in, which then also adds a `clients` entry so the opt-in actually works).
7. Serve smoke: resolve the **effective** MCP config (`loadMcpConfig` — note this
   falls back to a `projects/*.yaml` `mcp:` section, so a generated
   `.harness/mcp.yaml` shadows it; the wizard shows the effective config and warns
   if profile-embedded MCP settings exist) and evaluate
   `isProjectAllowed` + `decideMcpPermission` as pure functions to confirm the
   project is visible and the chosen operations would be permitted for the named
   client — report only, **without spawning a long-lived `serve` daemon**.
8. Final summary + remaining manual steps.

Out of scope (YAGNI): driving codex/gh interactive auth; managing a long-lived
`serve` daemon; replacing the individual commands (they remain; `onboard` only
orchestrates them).

## UX model

An **interactive TTY wizard** (the user chose this over a doctor-style guide or a
single non-interactive orchestrator). Because the harness is otherwise entirely
non-interactive (no inquirer/readline prompt infra), the design splits the wizard
into a deterministic core and a thin IO layer so the interactive surface stays
testable and the safety posture stays fail-closed.

## Architecture

Three layers:

- **`src/onboard/steps.ts` (pure core)** — an ordered `OnboardStep[]` and a
  deterministic state machine. Each step exposes:
  - `probe(ctx): "done" | "pending" | "blocked"` — deterministic completion
    detection (so the wizard is **idempotent and resumable**).
  - `describe(ctx): string` — what the step will do (shown before acting).
  - `run(ctx, answers): StepResult` — drives the underlying existing logic.

  No prompts here → unit-testable with a fake `ctx`. `nextStep(state)` /
  `applyResult(state, result)` are pure.
- **`src/onboard/prompts.ts` (thin IO)** — a `readline/promises` adapter
  (`confirm(q)`, `input(q, default?)`, `select(q, choices)`). **No new
  dependency** (Node built-in). Injectable, so tests pass a scripted fake.
- **`src/cli/onboard.ts`** — the commander command; wires steps + prompts +
  TTY detection.

Each step **reuses existing logic** rather than reimplementing it:

| Step | Reused surface |
|------|----------------|
| inspect | `inspectProject` (`src/project/inspector.ts`) / `scanRepoSignals` |
| profile+policy | `buildPolicyProposal` (`src/project/policy-proposal.ts`) + `runProjectInit` writers (`src/project/init.ts`, profile + repo policy + provenance; linkSync no-clobber); a small **global-only writer** for `policies/global.yaml` (writes only when missing — `runProjectInit` does NOT write global, and `writeCompiledPolicyFiles` writes repo-first and would conflict, so onboard writes the global from `proposal.result.globalPolicy`) |
| check | `checkProject` (`src/project/checker.ts:61`) → `status: ok\|warn\|error` |
| db | `importProjects` (`src/db/import/projects.ts`; it runs migrations, so a separate `db init` is redundant) + `db check-consistency` |
| mcp.yaml | new small YAML **merge** writer (`src/onboard/mcp-config.ts`) |
| serve smoke | `loadMcpConfig` (effective config, incl. `projects/*.yaml` fallback) + `isProjectAllowed` + `decideMcpPermission` evaluated **as pure functions** (no daemon, no static registry); `listMcpTools` for the catalog |

## Data flow

```
onboard(repo, projectId)
  → ctx = { harnessRoot, repoPath, projectId, isTTY, prompts }
  → state = initial; for each step in order:
       probe(ctx) == done      → skip (resume)
       probe(ctx) == blocked    → stop, print remediation (fail-closed)
       else describe + confirm  → run(ctx, answers) → applyResult
  → final summary (done steps / remaining manual steps)
```

Writes are **dry-run-first**: the profile/policy proposal and the `.harness/mcp.yaml`
content are shown and confirmed before anything is written.

## Safety boundaries

- **Permission grants are explicit and actually take effect.** `.harness/mcp.yaml`
  is generated with `defaultMode: dry-run` and `allowedOperations: []` (the
  mutation allowlist is deny-all; read tools are unaffected). Because mutations
  need a `guarded-mutation` **client** too (P1: two-stage gate), the opt-in is a
  single explicit step that, when accepted, asks for a client name and writes
  BOTH a `clients` entry (`mode: guarded-mutation`, that name) AND the chosen
  operations — otherwise the allowlist would silently never apply (the #81 trap).
  `defaultMode` stays `dry-run` so unknown clients are never elevated. The starter
  set is offered as **two separate opt-ins**: `goal.start` (cheap) and
  `run.start` (**starts a codex run — incurs cost / edits the repo**); declining
  both leaves the repo read-only. The wizard never silently grants mutations.
- **No-clobber, and the merge never widens or silently narrows.**
  `projects/<id>.yaml` / policy files reuse the init writers' no-clobber +
  `--force`-on-confirm semantics. `.harness/mcp.yaml` is **merged, not
  overwritten** — `deniedOperations` / `requireConfirmation` defaults are kept. A
  pre-existing config with `allowedProjects: []` means **allow-all**; appending
  one project would flip it to "only that one" and break other projects' access,
  so the wizard detects the allow-all case and **does not silently append** — it
  surfaces it and asks whether to keep allow-all or switch to an explicit list
  (seeded from the existing `projects` rows). The MCP step's `probe` is defined by
  `isProjectAllowed(effectiveConfig, projectId)` (not raw list membership) so an
  allow-all repo is not reported as forever-pending.
- **Idempotent + resumable.** `probe` skips completed steps; a Ctrl-C'd run
  resumes from where it stopped; nothing is half-written without the next run
  detecting it.
- **TTY required, fail-closed otherwise.** When stdin is not a TTY (CI / piped),
  the wizard does **not** proceed with defaults for a permission-granting flow —
  it errors with the equivalent non-interactive commands listed.
- **Existing boundaries untouched.** Onboarding is an outer convenience layer; it
  does not modify post-hoc `git diff` policy verification, MCP
  `confirmation_required`, or any state-transition logic.
- Each step **fails closed** and preserves prior progress; `check` `error`
  (e.g. an uncompilable profile) stops the wizard with guidance.

## Error handling

- `probe` is deterministic and side-effect-free; a probe that itself errors
  (e.g. unreadable DB) is treated as `blocked` with the cause reported.
- A step's `run` failure stops the wizard, prints the failing step + remediation,
  and leaves earlier results intact for a resume.
- External tools (codex/gh): probed via `--version` / `auth status`; absence is a
  **warning + guidance**, not a hard stop (you can finish onboarding and
  authenticate later).

## Testing

- **Pure core** (`steps.ts`): unit tests for `nextStep` / `probe` / resume —
  done-step skipping, blocked-step stop, ordering — with a fake `ctx`.
- **Step `run`** : integration tests over a temp repo + `HARNESS_ROOT` with a
  **scripted fake prompt adapter**: asserts profile/policy files written, the
  global-only scaffold (missing → written; present → untouched),
  `.harness/mcp.yaml` **merge** (project appended to a non-empty list; existing
  `clients` / `deniedOperations` preserved), the **allow-all case** (`allowedProjects: []`
  is not silently narrowed), starter-set **opt-in (writes a `clients` entry +
  ops) vs decline (stays read-only)**, and existing-file no-clobber.
- **Permission round-trip**: after an opt-in, `decideMcpPermission` returns
  `mutation_allowed` for the named client on the chosen op, and stays denied for
  a different client / a non-chosen op (guards the two-stage gate, P1-1).
- **`check` error stop**: an uncompilable profile makes `checkProject` return
  `error`; the wizard stops with guidance and **preserves prior results** (resumable).
- **Non-TTY fallback**: asserts a fail-closed error naming the equivalent
  commands.
- No skip/xfail; full suite + `npm run typecheck` green; no schema change
  (onboarding writes files / reads the existing DB; it adds no tables).

## Files

New:
- `src/cli/onboard.ts` — command wiring + TTY detection (`process.stdin.isTTY`,
  the existing precedent in `src/cli/run.ts`).
- `src/onboard/steps.ts` — pure step model + state machine (probes per the table:
  profile = `existsSync(projects/<id>.yaml)`; DB = `projects` row whose
  `project_profiles.source_sha256` matches the file sha; MCP =
  `isProjectAllowed(effectiveConfig, projectId)`).
- `src/onboard/prompts.ts` — `readline/promises` adapter (injectable).
- `src/onboard/mcp-config.ts` — `.harness/mcp.yaml` merge writer (allow-all-aware
  `allowedProjects` merge; `clients` + `allowedOperations` starter opt-in).
- a small global-policy writer (in `onboard/` or reusing a shared helper).
- tests under `tests/unit/onboard/` and `tests/integration/`.

Touched (registration / docs only):
- `src/cli/` command registration.
- `docs/specs/cli.md` (new `harness onboard`), `docs/specs/mcp.md` (config
  generation), `README.md` quick-start pointer.

## Non-goals / future

- A non-interactive `--yes`/flag-driven onboard for CI (could be added later on
  the same step model; deferred — the interactive flow is the requested surface).
- A `--reconfigure` mode to revisit a done step (e.g. opt into the starter set
  after declining): since `probe` done → skip, re-opting-in is not possible in v1;
  the operator edits `.harness/mcp.yaml` directly. Deferred.
- Driving codex/gh auth; serve daemon supervision.
