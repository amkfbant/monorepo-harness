import { readFile, writeFile } from "node:fs/promises";
import { parse as parseYaml, stringify as yamlStringify } from "yaml";
import {
  ReviewDecisionFileSchema,
  type ReviewDecisionFile,
} from "./review-decision-schema.js";
import { REVIEW_CONSENSUS_STATIC_APPROVAL_SEMANTICS } from "./review-consensus.js";

export async function loadReviewDecision(
  path: string,
): Promise<ReviewDecisionFile> {
  const raw = await readFile(path, "utf8");
  return parseReviewDecisionYaml(raw);
}

/** Parse + validate a review-decision YAML document already in memory. */
export function parseReviewDecisionYaml(raw: string): ReviewDecisionFile {
  const parsed = parseYaml(raw);
  return ReviewDecisionFileSchema.parse(parsed);
}

/** Serialize a review decision to its canonical YAML document string. */
export function serializeReviewDecision(data: ReviewDecisionFile): string {
  const yaml = yamlStringify(data);
  if (data.decision !== "approved") return yaml;
  return `# ${REVIEW_CONSENSUS_STATIC_APPROVAL_SEMANTICS.approvedMeaning}\n${yaml}`;
}

export async function writeReviewDecision(
  path: string,
  data: ReviewDecisionFile,
): Promise<void> {
  await writeFile(path, serializeReviewDecision(data), "utf8");
}
