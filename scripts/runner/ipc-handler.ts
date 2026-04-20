import { join } from "path";
import { existsSync, rmSync } from "fs";
import { sendToServer, stopServer, startServer, restartServer } from "./server-manager.js";
import { checkForUpdates, applyUpdate, switchBranch } from "./git-ops.js";
import { readEnvConfig, writeTrustAnyOrigin } from "./env-config.js";
import {
  PROJECT_ROOT,
  AVAILABLE_BRANCHES,
  TIMEOUT_BUN_CACHE_MS,
  TIMEOUT_BUN_INSTALL_MS,
  TIMEOUT_BUN_BUILD_MS,
} from "./lib/constants.js";
import { spawnAsync } from "./lib/spawn-async.js";

/** Cached update state from the last check. */
let lastUpdateState = { available: false, commitsBehind: 0, latestMessage: "" };

/** Whether a destructive operation is in progress. */
let operationInProgress: string | null = null;

let isDev = false;

export function setDevMode(dev: boolean): void {
  isDev = dev;
}

export function getLastUpdateState() {
  return lastUpdateState;
}

export function setLastUpdateState(state: typeof lastUpdateState): void {
  lastUpdateState = state;
}

function respond(id: string, success: boolean, data?: any, error?: string): void {
  sendToServer({ type: "response", id, payload: { success, data, error } });
}

function progress(id: string, operation: string, message: string): void {
  sendToServer({ type: "progress", id, payload: { operation, message } });
}

export async function handleIPCMessage(msg: any): Promise<void> {
  if (!msg?.type || !msg.id) return;

  const { type, id, payload } = msg;

  switch (type) {
    case "status": {
      respond(id, true, {
        updateAvailable: lastUpdateState.available,
        commitsBehind: lastUpdateState.commitsBehind,
        latestUpdateMessage: lastUpdateState.latestMessage,
      });
      break;
    }

    case "check-updates": {
      try {
        const state = await checkForUpdates();
        lastUpdateState = state;
        respond(id, true, state);
      } catch (err) {
        respond(id, false, undefined, err instanceof Error ? err.message : "Check failed");
      }
      break;
    }

    case "apply-update": {
      if (operationInProgress) {
        respond(id, false, undefined, `Operation '${operationInProgress}' already in progress`);
        break;
      }
      operationInProgress = "update";
      // Ack before killing the server. The fetch that initiated this request
      // will otherwise die along with the old server process — the frontend
      // relies on WS reconnect to drive the rest of the UX, so an early
      // success is what an "expected" restart looks like on the wire.
      respond(id, true, { message: "Applying update..." });
      try {
        progress(id, "update", "Starting update...");
        await applyUpdate(
          () => stopServer(),
          () => { startServer(isDev); return Promise.resolve(); }
        );
        lastUpdateState = { available: false, commitsBehind: 0, latestMessage: "" };
      } catch (err) {
        // Server should be back up after error recovery in applyUpdate
      } finally {
        operationInProgress = null;
      }
      break;
    }

    case "switch-branch": {
      if (operationInProgress) {
        respond(id, false, undefined, `Operation '${operationInProgress}' already in progress`);
        break;
      }
      const target = payload?.target;
      if (!target) {
        respond(id, false, undefined, "No target branch specified");
        break;
      }
      // Validate the target before killing the server. The inner switchBranch()
      // has the same guard, but throwing from inside would leave the IPC
      // request hanging the full 5-minute timeout with no user feedback.
      if (!AVAILABLE_BRANCHES.includes(target)) {
        respond(id, false, undefined, `Invalid branch: ${target}. Available: ${AVAILABLE_BRANCHES.join(", ")}`);
        break;
      }
      operationInProgress = "branch-switch";
      respond(id, true, { message: `Switching to ${target}...` });
      try {
        progress(id, "branch-switch", `Switching to ${target}...`);
        await switchBranch(
          target,
          () => stopServer(),
          () => { startServer(isDev); return Promise.resolve(); }
        );
      } catch (err) {
        // Server should be back up after error recovery
      } finally {
        operationInProgress = null;
      }
      break;
    }

    case "toggle-remote": {
      if (operationInProgress) {
        respond(id, false, undefined, `Operation '${operationInProgress}' already in progress`);
        break;
      }
      const enable = payload?.enable;
      if (typeof enable !== "boolean") {
        respond(id, false, undefined, "enable (boolean) is required");
        break;
      }
      operationInProgress = "remote-toggle";
      // Ack before .env write + restart so the caller isn't left waiting on
      // a dead socket; the frontend will pick up the WS disconnect.
      respond(id, true, { enabled: enable, message: enable ? "Enabling remote mode..." : "Disabling remote mode..." });
      try {
        progress(id, "remote-toggle", enable ? "Enabling remote mode..." : "Disabling remote mode...");
        await writeTrustAnyOrigin(enable);
        // Restart for .env changes to take effect
        await restartServer(isDev);
      } catch (err) {
        // Restart paths handle their own recovery; the ack already went out.
      } finally {
        operationInProgress = null;
      }
      break;
    }

    case "restart": {
      if (operationInProgress) {
        respond(id, false, undefined, `Operation '${operationInProgress}' already in progress`);
        break;
      }
      operationInProgress = "restart";
      try {
        respond(id, true, { message: "Restarting..." });
        // Small delay to let the response be sent before the server is killed
        await new Promise((r) => setTimeout(r, 100));
        await restartServer(isDev);
      } finally {
        operationInProgress = null;
      }
      break;
    }

    case "quit": {
      respond(id, true, { message: "Shutting down..." });
      await new Promise((r) => setTimeout(r, 100));
      await stopServer();
      process.exit(0);
    }

    case "clear-cache": {
      try {
        progress(id, "clear-cache", "Clearing package cache...");
        const result = await spawnAsync(["bun", "pm", "cache", "rm"], {
          cwd: PROJECT_ROOT,
          timeoutMs: TIMEOUT_BUN_CACHE_MS,
          ignoreStdout: true,
        });
        if (result.exitCode !== 0) {
          const reason = result.timedOut
            ? `timed out after ${TIMEOUT_BUN_CACHE_MS / 1000}s`
            : result.stderr.trim() || "Cache clear failed";
          respond(id, false, undefined, reason);
        } else {
          respond(id, true, { message: "Package cache cleared" });
        }
      } catch (err) {
        respond(id, false, undefined, err instanceof Error ? err.message : "Cache clear failed");
      }
      break;
    }

    case "ensure-deps": {
      try {
        progress(id, "ensure-deps", "Installing backend dependencies...");
        const backend = await spawnAsync(["bun", "install"], {
          cwd: PROJECT_ROOT,
          timeoutMs: TIMEOUT_BUN_INSTALL_MS,
        });
        if (backend.exitCode !== 0) {
          const reason = backend.timedOut
            ? `backend install timed out after ${TIMEOUT_BUN_INSTALL_MS / 1000}s`
            : backend.stderr.trim() || "backend install failed";
          respond(id, false, undefined, reason);
          break;
        }

        progress(id, "ensure-deps", "Installing frontend dependencies...");
        const frontendDir = join(PROJECT_ROOT, "frontend");
        const frontend = await spawnAsync(["bun", "install"], {
          cwd: frontendDir,
          timeoutMs: TIMEOUT_BUN_INSTALL_MS,
        });
        if (frontend.exitCode !== 0) {
          const reason = frontend.timedOut
            ? `frontend install timed out after ${TIMEOUT_BUN_INSTALL_MS / 1000}s`
            : frontend.stderr.trim() || "frontend install failed";
          respond(id, false, undefined, reason);
          break;
        }

        respond(id, true, { message: "Dependencies installed successfully" });
      } catch (err) {
        respond(id, false, undefined, err instanceof Error ? err.message : "Install failed");
      }
      break;
    }

    case "rebuild-frontend": {
      if (operationInProgress) {
        respond(id, false, undefined, `Operation '${operationInProgress}' already in progress`);
        break;
      }
      operationInProgress = "rebuild";
      // Ack now so the caller's fetch resolves before we kill the server.
      // Without this, the HTTP request dies along with the old server and
      // the frontend only finds out via the WS reconnect path.
      respond(id, true, { message: "Rebuilding frontend..." });
      try {
        const frontendDir = join(PROJECT_ROOT, "frontend");
        const distDir = join(frontendDir, "dist");

        progress(id, "rebuild", "Rebuilding frontend...");
        await stopServer();

        if (existsSync(distDir)) {
          rmSync(distDir, { recursive: true, force: true });
        }

        const build = await spawnAsync(["bun", "run", "build"], {
          cwd: frontendDir,
          timeoutMs: TIMEOUT_BUN_BUILD_MS,
        });

        if (build.exitCode !== 0) {
          const reason = build.timedOut
            ? `timed out after ${TIMEOUT_BUN_BUILD_MS / 1000}s`
            : build.stderr.trim() || build.stdout.trim() || "unknown error";
          console.error(`Frontend build failed: ${reason}`);
        }

        startServer(isDev);
      } catch (err) {
        // Try to restart anyway so the server doesn't stay down.
        try { startServer(isDev); } catch {}
      } finally {
        operationInProgress = null;
      }
      break;
    }

    default:
      // Unknown message type — ignore
      break;
  }
}
