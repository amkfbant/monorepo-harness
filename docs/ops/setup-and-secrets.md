# Setup & secrets — production operating guide

How to authenticate the harness and the services it drives, and how secrets are
kept out of runs. Read this before running `harness run` against a real repo or
exposing the dashboard / MCP server.

## 1. Codex authentication (required for real runs)

`harness run` spawns the `codex` CLI with a **filtered environment**. Only the
variables in `DEFAULT_CODEX_ENV_ALLOWLIST` are passed through; everything else
(including `OPENAI_API_KEY`) is stripped. The current allowlist
(`src/codex/codex-cli-runner.ts`):

```
PATH, HOME, USER, SHELL, LANG, LC_ALL, TERM, TMPDIR, CODEX_HOME
```

Consequences:

- **Authenticate with `codex login`**, not by exporting `OPENAI_API_KEY`. The
  login stores credentials under `CODEX_HOME` (default `~/.codex`), which *is*
  on the allowlist and reaches the subprocess.
- Exporting `OPENAI_API_KEY` in your shell has **no effect** on harness runs by
  default — it is filtered out before codex starts. If you must inject an API
  key, extend `envAllowlist` (code-level `CodexCliOpts.envAllowlist`); there is
  intentionally no CLI flag that loosens the allowlist casually.
- The filter is a **secret-containment boundary**: it prevents arbitrary host
  secrets in your shell from leaking into the codex subprocess (and thus into
  prompts or generated output).
- Runs are launched `--ephemeral`: codex does not persist session state under
  `CODEX_HOME` between runs.

Verify: `codex --version` and a `--dry-run` first; then one real run (see
`docs/reports/2026-06-04-real-codex-smoke.md`).

## 2. GitHub authentication (for `harness pr create`)

`pr create` shells out to `gh`. Authenticate once with `gh auth login`. Confirm
with `gh auth status`. No token is read from harness config — `gh` owns the
credential. The PR is created as a draft against the project's base branch.

## 3. Dashboard server auth (`harness dashboard serve`)

The HTTP dashboard is read-only by default and gains mutation routes only with
an explicit flag (`src/cli/run.ts`):

- `--token-env <ENV_NAME>` — read the **Bearer token** from the named env var.
  Binding to a non-local host **without** a token only warns; set the token to
  enable auth. Compared with `crypto.timingSafeEqual`.
- `--enable-mutation` — turns on POST mutation routes. **Requires** a bearer
  token (fails fast at startup otherwise) and generates a **CSRF token** at boot
  (printed once). Browser POSTs must send it as the `X-CSRF-Token` header.

Operating rules:

- Keep the dashboard bound to localhost unless you have set a strong token.
- Treat the boot-printed CSRF token as a per-process secret; it rotates on every
  restart.
- Put the bearer token in an env var sourced from your secret manager, never in
  a committed file.

## 4. MCP server auth (`harness mcp serve --transport stdio`)

The MCP server runs over **stdio as a local subprocess** — there is no network
listener and no bearer token. Access control is enforced by:

- **Permissions** (`src/mcp/security/permissions.ts`): each tool runs in a mode
  (`read` / `dry-run` / `mutation` / `confirmation-required`); mutations are
  rejected unless the operation is in `allowedOperations`.
- **Confirmation gate**: dangerous operations require an out-of-band
  confirmation token (not exposed to the agent).
- **Rate budgets** and **audit + redaction**: every session/invocation is
  recorded; outputs are redacted before audit.

Configure via the MCP config (`src/mcp/security/config.ts`); `allowedOperations`
defaults to empty (deny-all mutations) and must be opted into explicitly.

## 5. Secret containment — defense in depth

Secrets are kept out of runs and artifacts by several independent layers:

1. **Codex env allowlist** (§1) — host secrets never reach the subprocess.
2. **Policy `always_deny_write`** (`policies/global.yaml`) — `.git/**`,
   lockfiles, and shared packages can never be written by codex.
3. **Secret scan** (`src/reporter/secret-scan.ts`) — untracked files are
   heuristically scanned; secret-shaped files are flagged
   (`secretSuspectCount`) and their content is **redacted** in artifacts
   (`src/reporter/untracked-patch.ts`).
4. **`ignore_untracked`** — build output (`**/node_modules/**`, `**/dist/**`,
   …) is excluded from artifacts without becoming invisible to policy.

Never hardcode secrets in policies, profiles, or prompts. Provide them via env
vars sourced from a secret manager.

## Quick checklist before first production run

- [ ] `codex login` done; `codex --version` works
- [ ] `gh auth status` shows an active account (if using `pr create`)
- [ ] `--dry-run` resolves the policy you expect
- [ ] dashboard (if exposed) bound to localhost or behind `--token-env`
- [ ] mutation routes / MCP `allowedOperations` opted into deliberately
- [ ] secrets come from env / secret manager, not committed files
