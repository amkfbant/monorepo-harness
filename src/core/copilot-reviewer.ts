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
  /** Copilot のレビューが投稿済みかを返す。 */
  poll(prNumber: number): Promise<CopilotReviewPollResult>;
}
