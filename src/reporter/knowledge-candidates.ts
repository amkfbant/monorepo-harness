import { stringify } from "yaml";
import type { Violation } from "../policy/path-policy-validator.js";
import type { RunMeta } from "../logging/run-log.js";

export interface KnowledgeInputs {
  runId: string;
  domain: string;
  status: RunMeta["status"];
  violations: readonly Violation[];
}

interface Candidate {
  kind: "policy_improvement" | "domain_rule";
  domain: string;
  title: string;
  content: string;
  evidence: string[];
  confidence: "low" | "medium" | "high";
  status: "candidate";
}

export function buildKnowledgeCandidates(i: KnowledgeInputs): string {
  const candidates: Candidate[] = [];
  if (i.violations.length > 0) {
    candidates.push({
      kind: "policy_improvement",
      domain: i.domain,
      title: "Domain wrote outside its scope",
      content:
        "Codex attempted to modify files outside the domain write scope. " +
        "Review whether the workflow needs an additional cross-domain step, or whether the prompt failed to convey scope.",
      evidence: [i.runId],
      confidence: "medium",
      status: "candidate",
    });
  }
  return stringify({ candidates });
}
