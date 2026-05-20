# Policy semantics

The harness consumes glob patterns in three places:

- `read` / `write` / `deny_write` per domain (`policies/repos/<id>.yaml`)
- `always_deny_write` in `policies/global.yaml`
- `ignore_untracked` in `policies/global.yaml`

All patterns are matched by [`minimatch`](https://github.com/isaacs/minimatch)
with `{ dot: true, nocomment: true }`. Critically, **this is not the same as
`.gitignore` semantics.** Operators who write policies expecting gitignore
behavior will be surprised.

## How matching actually works

`minimatch` anchors patterns at the **repository root**. The pattern is
compared against the full path of a changed/untracked file.

| Pattern | Matches `apps/orders/dist/out.js`? | Matches `dist/out.js`? |
|---------|-----------------------------------|------------------------|
| `dist/**` | ❌ | ✅ |
| `**/dist/**` | ✅ | ✅ |
| `dist` | ❌ | ❌ (no file `dist` directly) |
| `**/dist` | ❌ (no file `dist` directly) | ❌ |
| `node_modules/**` | ❌ | ✅ |
| `**/node_modules/**` | ✅ | ✅ |

### Rule of thumb

If you want **"this directory anywhere in the repo"**, write:

```yaml
ignore_untracked:
  - "**/node_modules/**"
  - "**/dist/**"
  - "**/coverage/**"
  - "**/.turbo/**"
```

If you want **"this exact path at the repo root"**, omit the leading `**/`:

```yaml
always_deny_write:
  - .git/**
  - package.json     # only the root-level package.json
  - tsconfig.base.json
```

A `package.json` inside an app (e.g. `apps/orders/package.json`) is **not**
matched by the bare `package.json` pattern. If you want every nested
`package.json` denied, write `**/package.json`.

## Why this matters

- `always_deny_write` failing to cover a nested file means a domain may
  legitimately write to that file (e.g. a generated `package.json` in a
  freshly-created package).
- `ignore_untracked` failing to cover a nested `dist/` means codex's build
  output will surface as untracked files and may be validated against
  domain `write` scope — usually producing a false `failed-policy-violation`.

The MVP validation report (`docs/reports/2026-05-20-mvp-validation-initial.md`,
F1) documents the empirical case where `dist/**` failed to ignore
`apps/orders/dist/out.js`.

## Migrating an existing policy

When converting a policy that "looks gitignore-shaped":

- `node_modules/` → `**/node_modules/**`
- `dist/` → `**/dist/**`
- `*.log` → `**/*.log` (matches any file ending in `.log`)
- `.env*` → `**/.env*` (matches dotfiles whose name starts with `.env`, at any depth)

## Future direction

Two options under consideration for post-MVP:

1. Normalize patterns at policy load: rewrite bare `foo/**` to `**/foo/**`
   automatically when the pattern has no leading `**/`. Pros: matches user
   intuition. Cons: surprising for the rare user who really wanted
   root-anchored matching.
2. Switch to a gitignore-style matcher (e.g. `ignore` npm package). Pros:
   matches the most-common operator mental model. Cons: another dependency,
   slightly different semantics for the deny/write scope use case.

Until either is implemented, **explicit `**/foo/**` is required** and is the
documented policy style.
