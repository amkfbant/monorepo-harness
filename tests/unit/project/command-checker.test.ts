import { describe, it, expect } from "vitest";
import { checkGeneratedCommands } from "../../../src/project/command-checker.js";
import { RepoPolicySchema } from "../../../src/policy/schema.js";

function policy(allow: unknown[]) {
  return RepoPolicySchema.parse({
    repo_id: "demo",
    read: [],
    domains: {
      "apps/web": {
        read: [],
        write: ["apps/web/**"],
        deny_write: [],
        commands: { allow },
      },
    },
  });
}

describe("checkGeneratedCommands", () => {
  it("E5-6-2: passes a policy with unique command ids", () => {
    const findings = checkGeneratedCommands(
      policy([
        { id: "a", cmd: "node", args: [] },
        { id: "b", cmd: "node", args: [] },
      ]),
    );
    expect(findings).toHaveLength(0);
  });

  it("flags two structured commands with the same id", () => {
    const findings = checkGeneratedCommands(
      policy([
        { id: "dup", cmd: "node", args: [] },
        { id: "dup", cmd: "node", args: [] },
      ]),
    );
    expect(findings.some((f) => f.level === "error")).toBe(true);
  });

  it("flags a structured 'cmd-N' id colliding with a string entry", () => {
    const findings = checkGeneratedCommands(
      policy(["echo hi", { id: "cmd-0", cmd: "node", args: [] }]),
    );
    expect(findings.some((f) => /cmd-0/.test(f.message))).toBe(true);
  });
});
