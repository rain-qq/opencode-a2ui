/**
 * Kill a child process and (on Windows) its entire descendant tree.
 *
 * `child.kill()` only signals the direct child; grandchildren survive and hold
 * resources (ports, file locks) — the ghost-process problem we hit on Windows
 * during serve-mode testing. We use `taskkill /T /F /PID` to take the whole
 * tree down synchronously on win32, SIGTERM elsewhere.
 */

import { spawnSync, type ChildProcess } from "node:child_process";

export function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      // /T = kill descendants, /F = force. spawnSync so it completes before return.
      spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
        windowsHide: true,
      });
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
}
