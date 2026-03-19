import { useEffect, useRef, useCallback } from "react";
import { watch, existsSync, type FSWatcher } from "fs";
import { join } from "path";
import { PROJECT_ROOT, SELF_RESTART_DEBOUNCE_MS } from "../lib/constants.js";
import type { LogSource } from "./useLogBuffer.js";

/**
 * Watches the runner's own source files for changes and triggers a self-restart.
 *
 * On change:
 * 1. Calls onBeforeRestart() (stop server, cleanup)
 * 2. Leaves alt screen
 * 3. Re-execs the runner process with the same arguments
 */
export function useSelfWatcher(
  addLog: (text: string, source?: LogSource) => void,
  onBeforeRestart: () => Promise<void>,
  leaveAltScreen: () => void
): void {
  const watchersRef = useRef<FSWatcher[]>([]);
  const pendingRef = useRef(false);

  const doRestart = useCallback(async () => {
    addLog("Restarting runner process...", "system");

    // Stop file watchers
    for (const w of watchersRef.current) w.close();
    watchersRef.current = [];

    // Let the caller clean up (stop server, etc.)
    await onBeforeRestart();

    // Restore terminal
    leaveAltScreen();

    console.log("Runner restarting due to source change...");

    // Re-exec ourselves with the same arguments
    const child = Bun.spawn([process.execPath, ...process.argv.slice(1)], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      cwd: PROJECT_ROOT,
    });

    const code = await child.exited;
    process.exit(code);
  }, [addLog, onBeforeRestart, leaveAltScreen]);

  useEffect(() => {
    const filesToWatch = [
      join(PROJECT_ROOT, "scripts/runner.tsx"),
      join(PROJECT_ROOT, "scripts/runner/App.tsx"),
    ];

    // Also watch the entire runner directory
    const dirToWatch = join(PROJECT_ROOT, "scripts/runner");

    const scheduleRestart = (path: string) => {
      if (pendingRef.current) return;
      pendingRef.current = true;
      const filename = path.split("/").pop() || path;
      addLog(`Runner source changed: ${filename}`, "system");
      setTimeout(() => doRestart(), SELF_RESTART_DEBOUNCE_MS);
    };

    // Watch individual files
    for (const file of filesToWatch) {
      if (!existsSync(file)) continue;
      const watcher = watch(file, { persistent: false }, () => {
        scheduleRestart(file);
      });
      watchersRef.current.push(watcher);
    }

    // Watch the runner directory recursively
    if (existsSync(dirToWatch)) {
      try {
        const dirWatcher = watch(
          dirToWatch,
          { persistent: false, recursive: true },
          (_event, filename) => {
            if (filename) {
              scheduleRestart(filename.toString());
            }
          }
        );
        watchersRef.current.push(dirWatcher);
      } catch {
        // recursive watch may not be supported on all platforms,
        // individual file watches above provide fallback coverage
      }
    }

    return () => {
      for (const w of watchersRef.current) w.close();
      watchersRef.current = [];
    };
  }, [addLog, doRestart]);
}
