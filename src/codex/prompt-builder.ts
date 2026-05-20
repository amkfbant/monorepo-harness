import type { ResolvedPolicy } from "../policy/schema.js";

export interface PromptInputs {
  goal: string;
  policy: ResolvedPolicy;
}

export function buildCodexPrompt({ goal, policy }: PromptInputs): string {
  const writeList =
    policy.write.map((p) => `- ${p}`).join("\n") || "- (none)";
  const denyList =
    policy.denyWrite.map((p) => `- ${p}`).join("\n") || "- (none)";
  return [
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
  ].join("\n");
}
