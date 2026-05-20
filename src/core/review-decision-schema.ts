import { z } from "zod";

export const ReviewDecisionValueSchema = z.enum([
  "pending",
  "approved",
  "changes_requested",
  "rejected",
]);
export type ReviewDecisionValue = z.infer<typeof ReviewDecisionValueSchema>;

export const ReviewDecisionFileSchema = z
  .object({
    runId: z.string().min(1),
    domain: z.string().min(1),
    decision: ReviewDecisionValueSchema,
    required_changes: z.array(z.string()),
    non_blocking_comments: z.array(z.string()),
    out_of_scope_suggestions: z.array(z.string()),
    reviewer: z.string().nullable(),
    reviewed_at: z.string().nullable(),
  })
  .strict();

export type ReviewDecisionFile = z.infer<typeof ReviewDecisionFileSchema>;
