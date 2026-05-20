import { readFile, writeFile } from "node:fs/promises";
import { parse as parseYaml, stringify as yamlStringify } from "yaml";
import {
  ReviewDecisionFileSchema,
  type ReviewDecisionFile,
} from "./review-decision-schema.js";

export async function loadReviewDecision(
  path: string,
): Promise<ReviewDecisionFile> {
  const raw = await readFile(path, "utf8");
  const parsed = parseYaml(raw);
  return ReviewDecisionFileSchema.parse(parsed);
}

export async function writeReviewDecision(
  path: string,
  data: ReviewDecisionFile,
): Promise<void> {
  await writeFile(path, yamlStringify(data), "utf8");
}
