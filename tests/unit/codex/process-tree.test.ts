import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { killProcessTree } from "../../../src/codex/process-tree.js";

describe.skipIf(process.platform === "win32")(
  "killProcessTree (POSIX)",
  () => {
    it("kills the immediate child", async () => {
      const child = spawn("sh", ["-c", "sleep 30"], {
        detached: true,
        stdio: "ignore",
      });
      expect(child.pid).toBeGreaterThan(0);
      killProcessTree(child);
      const code = await new Promise<number | null>((res) => {
        child.on("close", (c) => res(c));
      });
      // SIGKILL → null exit code (signaled), or non-zero
      expect(code === null || code !== 0).toBe(true);
    });

    it("kills grandchildren too via the process group", async () => {
      // sh forks a backgrounded sleep, prints its pid, then waits.
      // Without process-group kill, the grandchild would survive.
      const child = spawn("sh", ["-c", "sleep 30 & echo $! ; wait"], {
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const grandchildPid = await new Promise<number>((res) => {
        child.stdout!.once("data", (d) =>
          res(Number(d.toString().trim())),
        );
      });
      expect(grandchildPid).toBeGreaterThan(0);
      killProcessTree(child);
      await new Promise<void>((res) => child.on("close", () => res()));
      // give kernel a moment to reap
      await new Promise((res) => setTimeout(res, 100));
      let alive = true;
      try {
        // kill(pid, 0) probes existence without sending a signal
        process.kill(grandchildPid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    });
  },
);
