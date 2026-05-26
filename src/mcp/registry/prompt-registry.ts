export interface McpPromptArgument {
  name: string;
  description: string;
  required?: boolean;
}

export interface McpPromptDefinition {
  name: string;
  title: string;
  description: string;
  arguments: McpPromptArgument[];
  buildMessages: (args: Record<string, unknown>) => Array<{
    role: "user" | "assistant";
    content: { type: "text"; text: string };
  }>;
}

function textPrompt(text: string): Array<{
  role: "user";
  content: { type: "text"; text: string };
}> {
  return [{ role: "user", content: { type: "text", text } }];
}

function encoded(value: unknown): string {
  return encodeURIComponent(String(value));
}

export const MCP_PROMPTS: McpPromptDefinition[] = [
  {
    name: "harness.prompt.inspect_project",
    title: "Inspect project",
    description: "Inspect a project and propose safe next harness actions.",
    arguments: [{ name: "projectId", description: "Project id", required: true }],
    buildMessages: (args) =>
      textPrompt(
        `Inspect project ${String(args.projectId)} using harness MCP resources: ` +
          `harness://project/${encoded(args.projectId)}, ` +
          `harness://project/${encoded(args.projectId)}/profile, ` +
          `harness://project/${encoded(args.projectId)}/policy/effective. ` +
          "Summarize domains, policy, health, and safe next actions.",
      ),
  },
  {
    name: "harness.prompt.plan_backlog_item",
    title: "Plan backlog item",
    description: "Plan work for a backlog item using project and policy context.",
    arguments: [
      { name: "itemId", description: "Backlog item id", required: true },
      { name: "projectId", description: "Optional project id" },
      { name: "domain", description: "Optional domain" },
    ],
    buildMessages: (args) =>
      textPrompt(
        `Plan backlog item ${String(args.itemId)} using ` +
          `harness://backlog/${encoded(args.itemId)}. ` +
          (args.projectId !== undefined
            ? `Also read harness://project/${encoded(args.projectId)}. `
            : "") +
          (args.projectId !== undefined && args.domain !== undefined
            ? `Domain context: harness://project/${encoded(args.projectId)}/domain/${encoded(args.domain)}. `
            : "") +
          "Include policy constraints, knowledge context, risks, and a dry-run first step.",
      ),
  },
  {
    name: "harness.prompt.review_run",
    title: "Review run",
    description: "Review a run for correctness, policy, security, or regression risk.",
    arguments: [
      { name: "runId", description: "Run id", required: true },
      {
        name: "focus",
        description: "correctness | policy | security | regression | all",
      },
    ],
    buildMessages: (args) =>
      textPrompt(
        `Review run ${String(args.runId)} with focus ` +
          `${String(args.focus ?? "all")}. Read ` +
          `harness://run/${encoded(args.runId)}, ` +
          `harness://run/${encoded(args.runId)}/timeline, ` +
          `harness://run/${encoded(args.runId)}/review, and ` +
          `harness://run/${encoded(args.runId)}/artifacts. ` +
          "Lead with findings and cite artifacts.",
      ),
  },
  {
    name: "harness.prompt.summarize_run",
    title: "Summarize run",
    description: "Summarize a run and its artifacts.",
    arguments: [{ name: "runId", description: "Run id", required: true }],
    buildMessages: (args) =>
      textPrompt(
        `Summarize run ${String(args.runId)} using ` +
          `harness://run/${encoded(args.runId)}, ` +
          `harness://run/${encoded(args.runId)}/timeline, ` +
          `harness://run/${encoded(args.runId)}/review, and ` +
          `harness://run/${encoded(args.runId)}/artifacts.`,
      ),
  },
  {
    name: "harness.prompt.prepare_rerun",
    title: "Prepare rerun",
    description: "Prepare a rerun based on review findings.",
    arguments: [{ name: "runId", description: "Run id", required: true }],
    buildMessages: (args) =>
      textPrompt(
        `Prepare a rerun plan for ${String(args.runId)}. Read ` +
          `harness://run/${encoded(args.runId)}/review and ` +
          `harness://run/${encoded(args.runId)}/artifacts. Include the exact ` +
          "changes requested, context to preserve, and dry-run checks first.",
      ),
  },
];

export function getMcpPrompt(name: string): McpPromptDefinition | undefined {
  return MCP_PROMPTS.find((p) => p.name === name);
}
