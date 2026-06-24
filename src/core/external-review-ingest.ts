import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

import {
  EXTERNAL_REVIEW_STATES,
  EXTERNAL_REVIEWER_TYPES,
  ExternalReviewEventRepository,
  type ExternalReviewEventInsertResult,
  type ExternalReviewerType,
  type ExternalReviewState,
} from "../db/repositories/external-review-events.js";

export interface ExternalReviewVerdict {
  author: string;
  state: string;
  reviewerType?: ExternalReviewerType | null;
  githubReviewId?: string | number | null;
  submittedAt?: string | null;
  summary?: string | null;
  redacted?: boolean;
}

export interface ExternalReviewEventIngestInput {
  db: Database.Database;
  hitchId?: string | null;
  runId?: string | null;
  repoId?: string | null;
  prNumber: number;
  verdicts: readonly ExternalReviewVerdict[];
  createdAt?: string;
}

interface NormalizedExternalReviewVerdict {
  author: string;
  state: ExternalReviewState;
  reviewerType: ExternalReviewerType;
  githubReviewId: string | null;
  submittedAt: string | null;
  summary: string | null;
  redacted: boolean;
}

const COPILOT_BOT_LOGIN = "copilot-pull-request-reviewer";

export function recordExternalReviewEvents(
  input: ExternalReviewEventIngestInput,
): ExternalReviewEventInsertResult[] {
  if (!Number.isInteger(input.prNumber)) {
    throw new Error("external review ingest requires an integer prNumber");
  }
  const repo = new ExternalReviewEventRepository(input.db);
  const baseCreatedAt = input.createdAt ?? new Date().toISOString();
  const results: ExternalReviewEventInsertResult[] = [];
  input.verdicts.forEach((verdict, index) => {
    const normalized = normalizeExternalReviewVerdict(verdict);
    if (normalized === null) return;
    results.push(
      repo.append({
        eventId: externalReviewEventId({
          repoId: input.repoId ?? null,
          prNumber: input.prNumber,
          author: normalized.author,
          state: normalized.state,
          githubReviewId: normalized.githubReviewId,
          index,
        }),
        hitchId: input.hitchId ?? null,
        runId: input.runId ?? null,
        repoId: input.repoId ?? null,
        prNumber: input.prNumber,
        author: normalized.author,
        reviewerType: normalized.reviewerType,
        state: normalized.state,
        githubReviewId: normalized.githubReviewId,
        submittedAt: normalized.submittedAt,
        summary: normalized.summary,
        redacted: normalized.redacted,
        createdAt: createdAtForIndex(baseCreatedAt, index),
      }),
    );
  });
  return results;
}

export function externalReviewEventId(input: {
  repoId: string | null;
  prNumber: number;
  author: string;
  state: ExternalReviewState;
  githubReviewId: string | null;
  index: number;
}): string {
  const reviewKey =
    input.githubReviewId === null
      ? { kind: "index", index: input.index, author: input.author }
      : { kind: "github_review_id", id: input.githubReviewId };
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        repoId: input.repoId,
        prNumber: input.prNumber,
        state: input.state,
        reviewKey,
      }),
    )
    .digest("hex")
    .slice(0, 32);
  return `external-review:${digest}`;
}

export function normalizeExternalReviewState(
  state: string,
): ExternalReviewState | null {
  const normalized = state.trim().toLowerCase().replace(/-/g, "_");
  return EXTERNAL_REVIEW_STATES.includes(normalized as ExternalReviewState)
    ? (normalized as ExternalReviewState)
    : null;
}

export function reviewerTypeForExternalReview(
  author: string,
  explicit?: ExternalReviewerType | null,
): ExternalReviewerType {
  if (
    explicit !== undefined &&
    explicit !== null &&
    EXTERNAL_REVIEWER_TYPES.includes(explicit)
  ) {
    return explicit;
  }
  const lower = author.toLowerCase();
  if (lower === COPILOT_BOT_LOGIN) return "copilot";
  if (lower.includes("codex") && lower.includes("bot")) return "codex_app";
  if (lower.endsWith("[bot]")) return "other";
  return "human";
}

function normalizeExternalReviewVerdict(
  verdict: ExternalReviewVerdict,
): NormalizedExternalReviewVerdict | null {
  const author = verdict.author.trim();
  const state = normalizeExternalReviewState(verdict.state);
  if (author === "" || state === null) return null;
  const githubReviewId =
    verdict.githubReviewId === undefined || verdict.githubReviewId === null
      ? null
      : String(verdict.githubReviewId);
  return {
    author,
    state,
    reviewerType: reviewerTypeForExternalReview(author, verdict.reviewerType),
    githubReviewId: githubReviewId === "" ? null : githubReviewId,
    submittedAt: verdict.submittedAt ?? null,
    summary: verdict.summary ?? null,
    redacted: verdict.redacted === true,
  };
}

function createdAtForIndex(baseCreatedAt: string, index: number): string {
  const ms = Date.parse(baseCreatedAt);
  if (!Number.isFinite(ms)) return baseCreatedAt;
  return new Date(ms + index).toISOString();
}
