/**
 * Copilot PR review 連携の DI 境界（`PrPublisher` / `PrMerger` と同じ慣習）。
 * 実装は `createGhCopilotReviewer`（gh）/ テスト fake。orchestration は
 * `runCopilotReview`（純粋・throw しない）が持つ。
 */

export type CopilotReviewPollResult = "reviewed" | "pending";

export interface CopilotReviewer {
  /**
   * PR に Copilot reviewer を要求する。一時エラーは throw してよい
   * （呼び出し側 = runCopilotReview が retry する）。
   */
  request(prNumber: number): Promise<void>;
  /**
   * Copilot のレビューが投稿済みかを返す。
   *
   * `timeoutMs` が与えられた場合、その時間でこの 1 回の poll を打ち切ってよい
   * （best-effort）。これにより `runCopilotReview` の総タイムアウト（残り時間）が
   * poll 単位で実効化される。optional なので既存 fake は無視してよい（非破壊的）。
   *
   * `timeoutMs` を無視して hang しても安全: `runCopilotReview` 側が残り時間 > 0 の
   * poll を内部 watchdog で包むため、総タイムアウトは harness 側で保証される。
   */
  poll(
    prNumber: number,
    timeoutMs?: number,
  ): Promise<CopilotReviewPollResult>;
}
