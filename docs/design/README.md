# docs/design/

設計ノート（提案・思想の正本）。`docs/specs/`（現状実装のスナップショット、TODO を書かない）
とは別レイヤーで、**これから導入する機構の設計前提・安全境界・導入単位**を置く。実装が入って
仕様が確定したら、対応する `docs/specs/*` に反映する。

## AI 合議制 × コンサルフレームワーク

| ファイル | 内容 | いつ読む |
|---|---|---|
| [`deliberation.md`](./deliberation.md) | 合議制の適用方針（会議の回し方・安全境界・判定の境界線） | 合議機構を触る前にまず |
| [`consulting-frameworks.md`](./consulting-frameworks.md) | 選別した 8 フレームワーク（成果物の型・相互参照・可視化） | 成果物スキーマ/可視化を設計する前 |
| [`applications.md`](./applications.md) | 導入カタログ（案 A–G、着手順、受け入れ条件） | enhancement に着手する前 |

元リサーチ（`tmp/consultant/*.md`）はリポジトリ外の調査メモ。上記はそれを**本プロジェクトの
ドメインと安全境界に写像した版**。
