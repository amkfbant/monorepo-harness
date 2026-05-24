# Phase 14 — Human-authored assets DB canonical 設計書

**作成日:** 2026-05-24
**対象:** `phase13-close` (commit `5dbb21e`) 後の `monorepo-harness`
**実装計画:** `tmp/phase10-16-design-plans/phase14-human-authored-assets-db-canonical-plan.md`
**ステータス:** 設計確定 (Phase 14-0)。

---

## 1. 位置づけ

Phase 6〜13 で runtime / review / mutation はすべて DB canonical。
残るのは **human-authored assets**:

- `projects/*.yaml` — project profile
- `policies/repos/*.yaml` + `policies/repos/*.generated.json` — policy
- `docs/knowledge/**/*.md` — knowledge entries (markdown body)

これらは人間が編集する資産で、Phase 9 まで DB canonical 化を見送って
きた (runtime artifact と性質が違うため)。Phase 14 で **revision-based
DB canonical** に移行し、files は compat export として再生成可能に
する。edit UX と audit を含める。

Phase 14 で Phase 13 OperationRunner を流用し、各 edit を operation
ledger に記録する (`operation_type` = `project.edit` / `policy.edit` /
`knowledge.edit`)。

---

## 2. canonical 境界 (Phase 14 確定値)

```
DB canonical (Phase 14 で追加):
  project_profile_revisions (project profile YAML の history)
  projects.current_profile_revision_id (current pointer)
  policy_templates (template history)
  effective_policy_snapshots (generated policy)
  knowledge_entry_revisions (markdown body history)
  knowledge_entries.current_revision_id (current pointer)
  asset_exports (compat export tracking + sha256)

files (compat export):
  projects/<projectId>.yaml             ← project_profile_revisions
  policies/repos/<repoId>.yaml          ← policy_templates
  policies/repos/<repoId>.generated.json ← effective_policy_snapshots
  docs/knowledge/**/*.md                ← knowledge_entry_revisions
```

runtime profile / policy / knowledge resolution は **DB-first** に
切り替わる。file は compat export (operator が手で確認 / git 管理) で
あり、runtime は読まない (legacy fallback も Phase 14 close 後の dual
period のみ)。

---

## 3. 確定した設計判断

### A. Revision-based history

各 asset は (current row) + (revision history) のペア:

```
TABLE <asset>_revisions:
  revision_id INTEGER PK AUTOINCREMENT
  <asset>_id  TEXT (project_id / repo_id+'@'+policy_scope / entry_id)
  version     INTEGER     -- 1, 2, 3, ... per asset_id
  body_*      raw payload (YAML / markdown / parsed_json)
  body_sha256 stable hash
  actor       'cli:...' / 'http:...' / 'import-from-file'
  reason      optional commit-message-like text
  created_at
  supersedes_revision_id (optional)
  UNIQUE(<asset>_id, version)
```

Current pointer は別 row (or column):
- `projects.current_profile_revision_id`
- `policy_templates` の最新 row が current (rule_version で order)
- `knowledge_entries.current_revision_id`

### B. Files = compat export (default behaviour)

Phase 14 close 時点で:

- DB が source of truth
- `harness {project,policy,knowledge} export` で files を再生成
- ファイル直接編集の reconcile path は明示 (`assets import --from-files
  --dry-run` → confirm → `--accept-file-changes`)

`assets export` は idempotent: 同 revision なら no-op。

### C. Conflict detection (sha256-based)

`asset_exports`:

```sql
CREATE TABLE asset_exports (
  export_id      INTEGER PK AUTOINCREMENT,
  asset_type     TEXT CHECK (asset_type IN
                   ('project_profile', 'policy_template',
                    'effective_policy', 'knowledge_entry')),
  asset_id       TEXT NOT NULL,
  revision_id    INTEGER NOT NULL,
  relative_path  TEXT NOT NULL,
  sha256         TEXT NOT NULL,
  exported_at    TEXT NOT NULL,
  status         TEXT CHECK (status IN ('synced', 'dirty', 'removed')),
  UNIQUE(asset_type, asset_id, relative_path)
);
```

`assets status` の判定:

| file | DB | asset_exports | result |
|---|---|---|---|
| sha == exported.sha == current | synced | synced | **synced** |
| sha != exported.sha, DB unchanged since export | exported.sha != current ? | dirty file | **dirty file** |
| sha == exported.sha, DB updated since | current_revision != exported.revision | dirty DB | **dirty DB** |
| sha != exported.sha, DB updated since | both | conflict | **conflict** |
| no file | exists | exported but file missing | **removed** |
| no DB row | (n/a) | (n/a) | **missing** |

### D. Editor UX

```
harness project edit <id>           opens $EDITOR with current body_yaml
harness policy edit <id>            ditto for policy_yaml
harness knowledge edit <entry_id>   ditto for body_markdown
```

実装:

1. current revision を temp file に write
2. spawn $EDITOR (default: vi) on temp file
3. on save, validate (project schema / policy schema / md frontmatter)
4. if valid, insert new revision + update current pointer (in
   OperationRunner で audit; `operation_type` = `*.edit`)
5. ask "export compat file?" (default Y)

### E. Runtime resolution

```
project profile read:
  1. DB から current profile を読む (project_profile_revisions joined)
  2. なければ projects/*.yaml fallback (Phase 14 close 後の dual period)

policy resolution (resolvePolicy):
  1. DB の policy_template (current) + effective_policy_snapshot
  2. なければ policies/repos/*.yaml fallback

knowledge digest:
  1. DB knowledge_entries.current_revision の body
  2. なければ docs/knowledge/**/*.md fallback
```

`HARNESS_ASSET_SOURCE=file` で fallback path を強制可 (debug / migration
中)。Phase 15+ で fallback を廃止。

### F. Phase 13 OperationRunner 統合

すべての edit / import / export は OperationRunner で wrap:

- `operation_type='project.edit'` / `'project.import'` / `'project.export'`
- `target_type='project'`, `target_id=<projectId>`
- `result_json` に `{ revisionId, exportedFiles, ... }`
- audit trail が dashboard で見える (Phase 12 GET /api/operations 経由)

---

## 4. schema v9

`SCHEMA_VERSION = 9`。Phase 14-1 で land:

```sql
-- project profile
CREATE TABLE project_profile_revisions (
  revision_id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL,
  version     INTEGER NOT NULL,
  body_yaml   TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  parsed_json TEXT NOT NULL,
  actor       TEXT NOT NULL,
  reason      TEXT,
  created_at  TEXT NOT NULL,
  supersedes_revision_id INTEGER,
  UNIQUE(project_id, version)
);
CREATE INDEX project_profile_revisions_project_idx
  ON project_profile_revisions(project_id, version);

ALTER TABLE projects ADD COLUMN current_profile_revision_id INTEGER
  REFERENCES project_profile_revisions(revision_id);

-- policy
CREATE TABLE policy_templates (
  policy_template_id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_type  TEXT NOT NULL CHECK (scope_type IN ('repo', 'project', 'domain', 'global')),
  scope_id    TEXT NOT NULL,
  version     INTEGER NOT NULL,
  body_yaml   TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  parsed_json TEXT NOT NULL,
  actor       TEXT NOT NULL,
  reason      TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE(scope_type, scope_id, version)
);
CREATE TABLE effective_policy_snapshots (
  snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT,
  project_id  TEXT,
  repo_id     TEXT,
  domain      TEXT,
  template_revision_id INTEGER REFERENCES policy_templates(policy_template_id),
  generated_policy_yaml    TEXT NOT NULL,
  generated_policy_sha256  TEXT NOT NULL,
  provenance_json          TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- knowledge
CREATE TABLE knowledge_entry_revisions (
  revision_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id         TEXT NOT NULL,
  version          INTEGER NOT NULL,
  body_markdown    TEXT NOT NULL,
  body_sha256      TEXT NOT NULL,
  frontmatter_json TEXT NOT NULL,
  title            TEXT,
  actor            TEXT NOT NULL,
  reason           TEXT,
  created_at       TEXT NOT NULL,
  supersedes_revision_id INTEGER,
  UNIQUE(entry_id, version)
);
ALTER TABLE knowledge_entries ADD COLUMN current_revision_id INTEGER
  REFERENCES knowledge_entry_revisions(revision_id);

-- compat export tracking
CREATE TABLE asset_exports (
  export_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_type    TEXT NOT NULL CHECK (asset_type IN
                  ('project_profile', 'policy_template',
                   'effective_policy', 'knowledge_entry')),
  asset_id      TEXT NOT NULL,
  revision_id   INTEGER NOT NULL,
  relative_path TEXT NOT NULL,
  sha256        TEXT NOT NULL,
  exported_at   TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('synced', 'dirty', 'removed')),
  UNIQUE(asset_type, asset_id, relative_path)
);
```

既存 `projects` / `knowledge_entries` row は new pointer columns
`current_*_revision_id IS NULL` で migrate。後の `harness {project,
knowledge} import --from-files` で revision を 1 つ作って pointer を
埋める。

---

## 5. CLI 変更計画

```
harness project import projects/<id>.yaml [--actor=<a>] [--reason=<r>]
harness project edit <id>
harness project show <id> [--revision <v>]
harness project history <id>
harness project diff <id> --from <v1> --to <v2>
harness project export <id> [--out <path>]

harness policy import policies/repos/<id>.yaml
harness policy edit <scope:id>
harness policy show <scope:id> [--revision <v>]
harness policy history <scope:id>
harness policy compile --project <id> --domain <d>
harness policy export <scope:id> [--out <path>]

harness knowledge import --from-docs [--root docs/knowledge]
harness knowledge edit <entry_id>
harness knowledge show <entry_id> [--revision <v>]
harness knowledge history <entry_id>
harness knowledge diff <entry_id> --from <v1> --to <v2>
harness knowledge export <entry_id> [--out <path>]

harness assets status
harness assets export --all
harness assets import --from-files --dry-run
harness assets import --from-files --accept-file-changes
harness assets reconcile
```

各 edit / import / export は Phase 13 OperationRunner で audit。

---

## 6. Sub-phase

```
14-0  Design                                              ← 本書
14-1  Schema v9 (5 new tables + 2 pointer columns)
14-2  Project profile DB canonical (import / edit / export /
       runtime resolution DB-first)
14-3  Policy DB canonical (template + effective snapshot)
14-4  Knowledge markdown DB canonical (body + frontmatter + digest)
14-5  Assets status / reconcile (sha256-based detection)
14-6  Dashboard / API integration (asset health 表示 +
       Phase 12 read endpoints)
14-7  Docs / close
```

---

## 7. Close conditions

```
[ ] project profile が DB canonical
[ ] policy template / generated policy が DB canonical
[ ] knowledge markdown body が DB canonical
[ ] project/policy/knowledge に revision history がある
[ ] edit/show/history/diff/export/import CLI がある
[ ] files は compatibility export として再生成できる
[ ] dirty/conflict detection がある
[ ] runtime profile/policy/knowledge resolution が DB を優先する
[ ] existing tests green
[ ] npm run typecheck green
[ ] docs / close report / phase14-close tag
```

---

## 8. Phase 15 への接続

Phase 15 (db doctor / archive / backup) は Phase 14 の asset revision
を doctor の対象に含める:

- `asset.dirty_export` check (asset_exports.status != 'synced')
- `asset.revision_orphan` check (current_*_revision_id が
  *_revisions に無い)
- archive 候補: 古い revisions (`*_revisions WHERE created_at < ...`)

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| project / policy YAML round-trip 破壊 | body_yaml を raw 保存 + parsed_json は派生 |
| knowledge md 多数 import の scope | initial import は 1-shot `knowledge import --from-docs`; 各 file が revision_id=1 で land |
| compat export と DB の divergence | asset_exports.sha256 で detect、明示的 reconcile flow |
| runtime resolution breaking change | Phase 14 内は DB-first + file fallback (dual); Phase 15+ で DB-only |
| 3 asset 種 × full CRUD = scope 巨大 | 各 sub-phase minimum viable: import + export + minimal show, edit / history / diff は後 increment |
