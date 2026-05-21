# Personal Operating Manual

monorepo-harness を個人で継続運用するための日次・週次フローと判断ルール（Phase 4-9）。

harness は「複数のやりたいこと・複数 run・レビュー待ち・知見・PR 候補を、安全に溜めて・選んで・処理し・振り返る」ためのツール。このマニュアルはその運用ルーティンを定める。

---

## Daily flow（作業開始時）

```bash
harness session summary     # 今 pending なものの件数スナップショット
harness session start --limit 3   # 今日まず着手する 3 件（提案）
harness inbox               # needs_review / failed / cleanup / knowledge の詳細
```

`session start` の提案順は固定ルール: **failed-* → needs_review → changes_requested → cleanup → backlog**。

1. **failed-* を最初に見る** — `harness run show --run-id <id>` で原因を把握。`failed-policy-violation` なら knowledge candidate を確認（後述）。
2. **needs_review を片付ける** — `harness review auto --run-id <id>` でレビュー decision を生成 → `harness review process --run-id <id>` で適用。
3. **changes_requested を rerun** — `harness rerun --from-review <id>`。ただし下記 maxAttempts ルールに従う。
4. 1 run の詳細を見たいときは常に `harness run show` / `run timeline` / `run artifacts`。

---

## Weekly flow（週次メンテナンス）

```bash
harness maintenance check                       # 残骸を一覧
harness maintenance cleanup --dry-run           # 自動削除予定を確認
harness maintenance cleanup --older-than 30d --force   # 30 日超の debris を削除
harness knowledge digest --since 7d             # 直近 1 週間の知見の溜まり
harness metrics summary --since 7d              # 直近 1 週間の運用指標
```

- `maintenance` の `uncleaned-finished`（approved/rejected の worktree 残存）は `harness cleanup --run-id <id>` で個別に処理する（run branch も消える）。
- `harness index rebuild` は Phase 6 で deprecated。代わりに `harness db import
  --from-files` で DB read model（`harness.sqlite`）を更新する。

## DB / dashboard（Phase 6）

```bash
harness db import --from-files        # files から DB read model を更新
harness db check-consistency          # DB ↔ files の drift を検査（drift で exit 1）
harness dashboard export              # project-aware な静的ダッシュボードを生成
harness dashboard export --project <id>   # 特定 project に絞る
```

- DB（`.harness/harness.sqlite`）は files から構築する read model。`runs/` 等の
  files が write-side の source of truth で、DB を消しても再構築できる。
- `dashboard export` は DB が無ければ files から auto-import するので、週次で
  `db import` を回していなくても最新スナップショットになる。
- `metrics summary` / `inbox` / `knowledge digest` / `backlog list` に
  `--project` / `--repo-id` を付けると DB read model 経由で project 別に絞れる。

---

## Backlog handling

やりたいことはその場で run せず、まず backlog に積む。

```bash
harness backlog add --title "..." --domain apps/x --goal "..." --priority high
harness backlog list
harness backlog run --item-id <id> --repo <path> --repo-id <id>   # run を起動して item に紐づく
harness backlog done --item-id <id>      # 完了
harness backlog defer --item-id <id>     # 後回し
```

- `backlog run` は default で `reviewed-run`（run → review → 必要なら rerun）を起動。単発で済むときは `--workflow run`。
- 起動した run は item の `linkedRuns` に記録され、item は `doing` に移る。`harness run show` から逆引きできる。
- session plan の backlog 枠は **open かつ priority 高い順**。high を先に消化する。

---

## Cleanup policy

- **approved run**: PR 化（`harness pr create --run-id <id>`）するか、不要なら `harness cleanup --run-id <id>`。worktree を放置しない。
- **rejected run**: `harness cleanup --run-id <id>` で worktree + branch を片付ける。
- **cleaned 済みなのに worktree が残る** / **orphan worktree** / **stale lock**: `harness maintenance cleanup` が自動で掃除（stale lock は所有プロセスの死亡を確認したものだけ）。
- run dir が肥大化したら `maintenance check` の `large-run-dir` で気づける。

---

## Knowledge policy

- `failed-policy-violation` の run は必ず knowledge candidate を確認する: `harness knowledge list --run-id <id>`。
- 再利用価値のある教訓は `harness knowledge promote --run-id <id> --reviewer <name>`。run 固有で再利用しない指摘は `harness knowledge reject --run-id <id> --reason "..."`（理由は必須）。
- 週次で `harness knowledge digest --since 7d` を見て、未対応 candidate を消化する。
- promote 済み knowledge は `harness knowledge build-context` で集約し、`harness run --with-knowledge` で次回 run の prompt に注入できる。

---

## Retry / 収束ルール

- `changes_requested` の rerun は **maxAttempts まで**（default 2 = 初回 run の後 rerun 2 回、計 3 run まで）。
- それでも収束しない（`not_converged`）chain は **rerun を重ねず手動レビュー**する。`harness metrics summary` の `not_converged workflows` で発生数を把握できる。
- reviewer agent の verdict はばらつき得る（観測のみ、Phase 3-2）。判断に迷ったら `harness review evaluate` で N 回サンプリングして安定性を見る。

---

## 月次の振り返り

```bash
harness metrics summary --since 30d     # approved 率 / rerun 収束率 / safety
harness metrics failures --since 30d    # failed-* の内訳
harness metrics domain <domain>         # domain 別の傾向
```

approved 率が低い・特定 domain で failure が偏る等の傾向が見えたら、policy や goal の書き方を見直す。
