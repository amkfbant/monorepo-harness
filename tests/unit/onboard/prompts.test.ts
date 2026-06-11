import { describe, it, expect } from "vitest";
import { scriptedPrompts } from "../../../src/onboard/prompts.js";

describe("scriptedPrompts (fake for tests)", () => {
  it("returns queued answers in order and records the questions asked", async () => {
    const p = scriptedPrompts(["my-id", "y", "1"]);
    expect(await p.input("project id?")).toBe("my-id");
    expect(await p.confirm("ok?")).toBe(true);
    expect(await p.select("pick", ["a", "b"])).toBe("a"); // "1" → first choice
    expect(p.asked).toEqual(["project id?", "ok?", "pick"]);
  });

  it("confirm treats y/yes (case-insensitive) as true, everything else false", async () => {
    const p = scriptedPrompts(["Yes", "n", ""]);
    expect(await p.confirm("a")).toBe(true);
    expect(await p.confirm("b")).toBe(false);
    expect(await p.confirm("c")).toBe(false);
  });

  it("throws when the script is exhausted (test wrote too few answers)", async () => {
    const p = scriptedPrompts([]);
    await expect(p.input("q")).rejects.toThrow(/exhausted/);
  });
});
