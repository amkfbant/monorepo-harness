import { spawn, type ChildProcess } from "node:child_process";

/**
 * Kill a child process AND its descendants.
 *
 * Requires the child to have been spawned with `detached: true` on POSIX
 * so it is the leader of its own process group; otherwise this falls back
 * to a plain SIGKILL of the immediate child and leaves grandchildren
 * (test runners, dev servers, package managers) running.
 *
 * On Windows uses `taskkill /T /F` for tree-kill.
 */
export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
      });
      killer.on("error", () => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already dead
        }
      });
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // already dead
      }
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already dead
    }
  }
}
