import { join } from "path";
import { existsSync, rmSync } from "fs";
import { runGit, getUpstreamRef, getCurrentBranch } from "./lib/git.js";
import {
  PROJECT_ROOT,
  AVAILABLE_BRANCHES,
  TIMEOUT_GIT_FETCH_MS,
  TIMEOUT_GIT_PULL_MS,
  TIMEOUT_GIT_CHECKOUT_MS,
  TIMEOUT_BUN_INSTALL_MS,
  TIMEOUT_BUN_BUILD_MS,
} from "./lib/constants.js";
import { spawnAsync } from "./lib/spawn-async.js";

export interface UpdateState {
  available: boolean;
  commitsBehind: number;
  latestMessage: string;
}

function log(text: string): void {
  const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
  console.log(`[${ts}] [runner] ${text}`);
}

/**
 * Run git fetch and check how many commits we're behind upstream.
 */
export async function checkForUpdates(): Promise<UpdateState> {
  const remote = runGit("remote");
  if (!remote.ok || !remote.out) {
    return { available: false, commitsBehind: 0, latestMessage: "" };
  }

  // Bounded fetch — a dead remote must not stall the periodic update check.
  const fetch = await spawnAsync(["git", "fetch", "--quiet"], {
    cwd: PROJECT_ROOT,
    timeoutMs: TIMEOUT_GIT_FETCH_MS,
    ignoreStdout: true,
  });
  if (fetch.exitCode !== 0) {
    if (fetch.timedOut) log("Update check: git fetch timed out.");
    return { available: false, commitsBehind: 0, latestMessage: "" };
  }

  const branch = getCurrentBranch();
  if (!branch) return { available: false, commitsBehind: 0, latestMessage: "" };

  const upstream = getUpstreamRef(branch);
  if (!upstream) return { available: false, commitsBehind: 0, latestMessage: "" };

  const revList = runGit("rev-list", "--count", `HEAD..${upstream}`);
  if (!revList.ok) return { available: false, commitsBehind: 0, latestMessage: "" };

  const behind = parseInt(revList.out, 10);
  if (behind > 0) {
    const logMsg = runGit("log", "--format=%s", "-1", upstream);
    const latestMessage = logMsg.ok ? logMsg.out : "";
    log(`Update available: ${behind} commit${behind > 1 ? "s" : ""} behind`);
    return { available: true, commitsBehind: behind, latestMessage };
  }

  return { available: false, commitsBehind: 0, latestMessage: "" };
}

/**
 * Apply update: stash → clear cache → delete dist → pull → install → build → restart
 */
export async function applyUpdate(
  stopServer: () => Promise<void>,
  startServer: () => Promise<void>
): Promise<void> {
  log("Preparing update...");

  // Stash local changes
  const status = runGit("status", "--porcelain");
  if (status.ok && status.out) {
    log("Stashing local changes...");
    runGit("stash", "push", "-m", "lumiverse-runner-auto-stash");
  }

  // Stop server before destructive operations
  await stopServer();

  // Clear Bun transpiler cache
  log("Clearing transpiler cache...");
  Bun.spawnSync(["bun", "--clear-cache"], { cwd: PROJECT_ROOT, stdout: "ignore", stderr: "ignore" });

  // Delete frontend/dist to prevent git conflicts
  const frontendDir = join(PROJECT_ROOT, "frontend");
  const frontendDistDir = join(frontendDir, "dist");
  if (existsSync(frontendDistDir)) {
    log("Removing frontend/dist...");
    rmSync(frontendDistDir, { recursive: true, force: true });
  }

  // Pull latest
  log("Pulling latest changes...");
  const pull = await spawnAsync(["git", "pull", "--ff-only"], {
    cwd: PROJECT_ROOT,
    timeoutMs: TIMEOUT_GIT_PULL_MS,
  });

  if (pull.exitCode !== 0) {
    const reason = pull.timedOut
      ? `git pull timed out after ${TIMEOUT_GIT_PULL_MS / 1000}s`
      : pull.stderr.trim() || pull.stdout.trim();
    log(`Update failed: ${reason}`);
    await recoverFrontendAndStart(frontendDir, startServer);
    throw new Error(`git pull failed: ${reason}`);
  }

  for (const line of pull.stdout.trim().split("\n")) {
    if (line.trim()) log(`  ${line.trim()}`);
  }

  // Install dependencies and rebuild
  await installAndBuild(frontendDir);

  log("Update complete. Restarting server...");
  await startServer();
}

/**
 * Switch branch: stash → stop → clear cache → delete dist → checkout → pull → install → build → restart
 */
export async function switchBranch(
  target: string,
  stopServer: () => Promise<void>,
  startServer: () => Promise<void>
): Promise<void> {
  if (!AVAILABLE_BRANCHES.includes(target as any)) {
    throw new Error(`Invalid branch: ${target}. Available: ${AVAILABLE_BRANCHES.join(", ")}`);
  }

  const currentBranch = getCurrentBranch();
  log(`Switching from '${currentBranch}' to '${target}'...`);

  // Stash local changes
  const status = runGit("status", "--porcelain");
  if (status.ok && status.out) {
    log("Stashing local changes...");
    runGit("stash", "push", "-m", `lumiverse-branch-switch-${currentBranch}`);
  }

  // Stop server
  await stopServer();

  // Clear transpiler cache
  log("Clearing transpiler cache...");
  Bun.spawnSync(["bun", "--clear-cache"], { cwd: PROJECT_ROOT, stdout: "ignore", stderr: "ignore" });

  // Delete frontend/dist
  const frontendDir = join(PROJECT_ROOT, "frontend");
  const frontendDistDir = join(frontendDir, "dist");
  if (existsSync(frontendDistDir)) {
    log("Removing frontend/dist...");
    rmSync(frontendDistDir, { recursive: true, force: true });
  }

  // Checkout (bounded — a dirty working tree shouldn't have survived the
  // stash above, but a stuck index lock or slow disk could still hang).
  const checkout = await spawnAsync(["git", "checkout", target], {
    cwd: PROJECT_ROOT,
    timeoutMs: TIMEOUT_GIT_CHECKOUT_MS,
  });
  if (checkout.exitCode !== 0) {
    const reason = checkout.timedOut
      ? `git checkout timed out after ${TIMEOUT_GIT_CHECKOUT_MS / 1000}s`
      : checkout.stderr.trim() || checkout.stdout.trim();
    log(`Failed to checkout '${target}': ${reason}`);
    await recoverFrontendAndStart(frontendDir, startServer);
    throw new Error(`git checkout failed: ${reason}`);
  }

  log(`Checked out '${target}'.`);

  // Pull latest (non-fatal — checkout already succeeded)
  log("Pulling latest changes...");
  const pull = await spawnAsync(["git", "pull", "--ff-only"], {
    cwd: PROJECT_ROOT,
    timeoutMs: TIMEOUT_GIT_PULL_MS,
  });

  if (pull.exitCode !== 0) {
    const reason = pull.timedOut
      ? `git pull timed out after ${TIMEOUT_GIT_PULL_MS / 1000}s`
      : pull.stderr.trim() || pull.stdout.trim();
    log(`Pull failed (non-fatal): ${reason}`);
  } else {
    for (const line of pull.stdout.trim().split("\n").filter((l: string) => l.trim())) {
      log(`  ${line.trim()}`);
    }
  }

  // Install and rebuild
  await installAndBuild(frontendDir);

  log(`Branch switch complete. Now on '${target}'. Restarting server...`);
  await startServer();
}

async function installAndBuild(frontendDir: string): Promise<void> {
  log("Installing backend dependencies...");
  const backend = await spawnAsync(["bun", "install"], {
    cwd: PROJECT_ROOT,
    timeoutMs: TIMEOUT_BUN_INSTALL_MS,
  });
  if (backend.exitCode !== 0) {
    const reason = backend.timedOut
      ? `timed out after ${TIMEOUT_BUN_INSTALL_MS / 1000}s`
      : backend.stderr.trim() || backend.stdout.trim() || "unknown error";
    log(`Backend install failed: ${reason}`);
  } else {
    log("Backend dependencies updated.");
  }

  log("Installing frontend dependencies...");
  const frontend = await spawnAsync(["bun", "install"], {
    cwd: frontendDir,
    timeoutMs: TIMEOUT_BUN_INSTALL_MS,
  });
  if (frontend.exitCode !== 0) {
    const reason = frontend.timedOut
      ? `timed out after ${TIMEOUT_BUN_INSTALL_MS / 1000}s`
      : frontend.stderr.trim() || frontend.stdout.trim() || "unknown error";
    log(`Frontend install failed: ${reason}`);
  } else {
    log("Frontend dependencies updated.");
  }

  log("Rebuilding frontend...");
  const build = await spawnAsync(["bun", "run", "build"], {
    cwd: frontendDir,
    timeoutMs: TIMEOUT_BUN_BUILD_MS,
  });
  if (build.exitCode !== 0) {
    const reason = build.timedOut
      ? `timed out after ${TIMEOUT_BUN_BUILD_MS / 1000}s`
      : build.stderr.trim() || build.stdout.trim() || "unknown error";
    log(`Frontend build failed: ${reason}`);
  } else {
    log("Frontend rebuilt successfully.");
  }
}

/** Rebuild frontend (best-effort) and restart the server after a git failure. */
async function recoverFrontendAndStart(
  frontendDir: string,
  startServer: () => Promise<void>
): Promise<void> {
  log("Rebuilding frontend to restore dist...");
  await spawnAsync(["bun", "run", "build"], {
    cwd: frontendDir,
    timeoutMs: TIMEOUT_BUN_BUILD_MS,
    ignoreStdout: true,
  });
  await startServer();
}
