# Design: `harness onboard` — guided onboarding wizard (#92)

Status: approved (brainstorm) — pending implementation plan.
Date: 2026-06-11.

## Problem

Standing up a new target repo on the harness requires ~15 steps scattered across
README sections and `docs/ops/`: inspect → init (profile/policy) → check →
`db init` / `db import` → write `.harness/mcp.yaml` by hand → serve. The biggest
pitfalls:

- **`.harness/mcp.yaml` is fully manual** and defaults to deny-all, so a repo set
  up without it has every MCP mutation denied with no obvious cause (cf. #81).
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
5. DB: `db init` (if missing) → `db import --from-files` → `db check-consistency`.
6. Generate/merge `.harness/mcp.yaml` (add the project to `allowedProjects`;
   `allowedOperations` defaults to deny-all with an explicit opt-in starter set).
7. Serve smoke: resolve the effective MCP config and build the tool registry
   **in-process** to confirm the project is visible and the chosen operations are
   permitted — report only, **without spawning a long-lived `serve` daemon**.
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
| inspect | `inspectProject` / `scanRepoSignals` (`src/project/`) |
| profile+policy | `buildPolicyProposal` + the `project init --write` writers; `compileProjectPolicy` for the global scaffold (#78) |
| check | `runChecks` (`src/project/checker.ts`) |
| db | `db init` + `importProjects` (`src/db/import/projects.ts`) + `check-consistency` |
| mcp.yaml | new small YAML **merge** writer (`src/onboard/mcp-config.ts`) |
| serve smoke | effective-config resolution (`mcp config`) + in-process tool-registry probe (no daemon) |

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

- **Permission grants are explicit.** `.harness/mcp.yaml` is generated with
  `defaultMode: dry-run` and `allowedOperations: []` (deny-all). A curated safe
  **starter set** (all read + `goal.start` + `run.start`) is added **only** on an
  explicit y/n opt-in; declining leaves it read-only. The wizard never silently
  grants mutation permissions.
- **No-clobber.** Existing `projects/<id>.yaml` / policy files reuse the init
  writers' no-clobber + `--force`-on-confirm semantics. `.harness/mcp.yaml` is
  **merged, not overwritten** (the project is appended to `allowedProjects`; a
  pre-existing config is preserved).
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
  global scaffold, `.harness/mcp.yaml` **merge** (project appended, existing
  config preserved), starter-set **opt-in vs decline**, and existing-file
  no-clobber.
- **Non-TTY fallback**: asserts a fail-closed error naming the equivalent
  commands.
- No skip/xfail; full suite + `npm run typecheck` green; no schema change
  (onboarding writes files / reads the existing DB; it adds no tables).

## Files

New:
- `src/cli/onboard.ts` — command wiring.
- `src/onboard/steps.ts` — pure step model + state machine.
- `src/onboard/prompts.ts` — `readline/promises` adapter (injectable).
- `src/onboard/mcp-config.ts` — `.harness/mcp.yaml` merge writer + starter set.
- tests under `tests/unit/onboard/` and `tests/integration/`.

Touched (registration / docs only):
- `src/cli/` command registration.
- `docs/specs/cli.md` (new `harness onboard`), `docs/specs/mcp.md` (config
  generation), `README.md` quick-start pointer.

## Non-goals / future

- A non-interactive `--yes`/flag-driven onboard for CI (could be added later on
  the same step model; deferred — the interactive flow is the requested surface).
- Driving codex/gh auth; serve daemon supervision.
