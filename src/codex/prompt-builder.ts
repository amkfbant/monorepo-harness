import type { ResolvedPolicy } from "../policy/schema.js";

export interface PromptInputs {
  goal: string;
  policy: ResolvedPolicy;
  /**
   * Optional promoted-knowledge context (the body of a
   * docs/knowledge-context/<domain>.md file). Appended verbatim as a
   * trailing section so the `Goal: ... Target domain:` shape stays
   * parseable by prepareRerunFromReview.
   */
  knowledgeContext?: string;
}

export function buildCodexPrompt({
  goal,
  policy,
  knowledgeContext,
}: PromptInputs): string {
  const writeList =
    policy.write.map((p) => `- ${p}`).join("\n") || "- (none)";
  const denyList =
    policy.denyWrite.map((p) => `- ${p}`).join("\n") || "- (none)";
  const lines = [
    "You are working on a monorepo domain task.",
    "",
    "Goal:",
    goal,
    "",
    "Target domain:",
    policy.domain,
    "",
    "You may edit only:",
    writeList,
    "",
    "Do not edit:",
    denyList,
    "",
    "You may read surrounding files to understand conventions, but keep changes scoped to the writable domain.",
    "After completing the task, provide a short summary of changed files and rationale.",
    "",
  ];
  if (knowledgeContext && knowledgeContext.trim() !== "") {
    lines.push(
      "## Relevant knowledge from past runs",
      "",
      "The following lessons were promoted from earlier runs in this " +
        "domain. Treat them as guidance, not as part of the task:",
      "",
      knowledgeContext.trim(),
      "",
    );
  }
  return lines.join("\n");
}
