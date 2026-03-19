import { useState, useCallback, useEffect, useRef } from "react";
import { join } from "path";
import { runGit, getUpstreamRef, getCurrentBranch } from "../lib/git.js";
import { PROJECT_ROOT, UPDATE_CHECK_INTERVAL_MS } from "../lib/constants.js";
import type { LogSource } from "./useLogBuffer.js";

export interface UpdateState {
  available: boolean;
  commitsBehind: number;
  latestMessage: string;
  checking: boolean;
  inProgress: boolean;
}

export interface GitOpsApi {
  updateState: UpdateState;
  currentBranch: string;
  branchSwitchInProgress: boolean;
  checkForUpdates: () => Promise<void>;
  applyUpdate: (onRestart: () => Promise<void>) => Promise<void>;
  switchBranch: (target: string, onRestart: () => Promise<void>) => Promise<void>;
}

export function useGitOps(
  addLog: (text: string, source?: LogSource) => void
): GitOpsApi {
  const [currentBranch, setCurrentBranch] = useState(() => getCurrentBranch());
  const [branchSwitchInProgress, setBranchSwitchInProgress] = useState(false);
  const [updateState, setUpdateState] = useState<UpdateState>({
    available: false,
    commitsBehind: 0,
    latestMessage: "",
    checking: false,
    inProgress: false,
  });

  // Refs to prevent concurrent operations
  const checkingRef = useRef(false);
  const updatingRef = useRef(false);

  const checkForUpdates = useCallback(async () => {
    if (checkingRef.current || updatingRef.current) return;

    // Verify we're in a git repo with a remote
    const remote = runGit("remote");
    if (!remote.ok || !remote.out) return;

    checkingRef.current = true;
    setUpdateState((prev) => ({ ...prev, checking: true }));

    // Fetch in the background
    const fetchProc = Bun.spawn(["git", "fetch", "--quiet"], {
      cwd: PROJECT_ROOT,
      stdout: "ignore",
      stderr: "ignore",
    });
    const fetchCode = await fetchProc.exited;
    if (fetchCode !== 0) {
      addLog("git fetch failed — cannot check for updates.", "system");
      checkingRef.current = false;
      setUpdateState((prev) => ({ ...prev, checking: false }));
      return;
    }

    const branch = getCurrentBranch();
    if (!branch) {
      checkingRef.current = false;
      setUpdateState((prev) => ({ ...prev, checking: false }));
      return;
    }

    const upstream = getUpstreamRef(branch);
    if (!upstream) {
      checkingRef.current = false;
      setUpdateState((prev) => ({ ...prev, checking: false }));
      return;
    }

    // Count commits behind
    const revList = runGit("rev-list", "--count", `HEAD..${upstream}`);
    if (!revList.ok) {
      checkingRef.current = false;
      setUpdateState((prev) => ({ ...prev, checking: false }));
      return;
    }

    const behind = parseInt(revList.out, 10);
    if (behind > 0) {
      const logMsg = runGit("log", "--format=%s", "-1", upstream);
      const latestMessage = logMsg.ok ? logMsg.out : "";

      setUpdateState({
        available: true,
        commitsBehind: behind,
        latestMessage,
        checking: false,
        inProgress: false,
      });

      addLog(
        `Update available: ${behind} commit${behind > 1 ? "s" : ""} behind`,
        "system"
      );
      if (latestMessage) {
        addLog(`  Latest: ${latestMessage}`, "system");
      }
    } else {
      setUpdateState({
        available: false,
        commitsBehind: 0,
        latestMessage: "",
        checking: false,
        inProgress: false,
      });
    }

    checkingRef.current = false;
  }, [addLog]);

  const applyUpdate = useCallback(
    async (onRestart: () => Promise<void>) => {
      if (!updateState.available || updatingRef.current) return;
      updatingRef.current = true;
      setUpdateState((prev) => ({ ...prev, inProgress: true }));

      addLog("Pulling latest changes...", "system");

      // Stash local changes
      const status = runGit("status", "--porcelain");
      if (status.ok && status.out) {
        addLog("Stashing local changes...", "system");
        runGit("stash", "push", "-m", "lumiverse-runner-auto-stash");
      }

      // Pull
      const pullProc = Bun.spawn(["git", "pull", "--ff-only"], {
        cwd: PROJECT_ROOT,
        stdout: "pipe",
        stderr: "pipe",
      });
      const pullOut = await new Response(pullProc.stdout).text();
      const pullErr = await new Response(pullProc.stderr).text();
      const pullCode = await pullProc.exited;

      if (pullCode !== 0) {
        addLog(
          `Update failed: ${pullErr.trim() || pullOut.trim()}`,
          "system"
        );
        updatingRef.current = false;
        setUpdateState((prev) => ({ ...prev, inProgress: false }));
        return;
      }

      for (const line of pullOut.trim().split("\n")) {
        if (line.trim()) addLog(`  ${line.trim()}`, "system");
      }

      // Check which files changed
      const diffFiles = runGit("diff", "--name-only", "HEAD@{1}", "HEAD");
      const changedFiles = diffFiles.ok ? diffFiles.out : "";

      // Reinstall backend deps if package.json changed
      if (changedFiles.includes("package.json")) {
        addLog(
          "package.json changed — reinstalling backend dependencies...",
          "system"
        );
        const installProc = Bun.spawn(["bun", "install"], {
          cwd: PROJECT_ROOT,
          stdout: "pipe",
          stderr: "pipe",
        });
        await installProc.exited;
        addLog("Backend dependencies updated.", "system");
      }

      // Check for frontend changes
      const frontendDir = join(PROJECT_ROOT, "frontend");
      const hasFrontendChanges = changedFiles
        .split("\n")
        .some((f: string) => f.startsWith("frontend/"));

      if (hasFrontendChanges) {
        addLog(
          "Frontend changes detected — installing dependencies...",
          "system"
        );
        const feInstallProc = Bun.spawn(["bun", "install"], {
          cwd: frontendDir,
          stdout: "pipe",
          stderr: "pipe",
        });
        await feInstallProc.exited;
        addLog("Frontend dependencies updated.", "system");

        addLog("Rebuilding frontend...", "system");
        const buildProc = Bun.spawn(["bun", "run", "build"], {
          cwd: frontendDir,
          stdout: "pipe",
          stderr: "pipe",
        });
        const buildOut = await new Response(buildProc.stdout).text();
        const buildErr = await new Response(buildProc.stderr).text();
        const buildCode = await buildProc.exited;

        if (buildCode !== 0) {
          addLog(
            `Frontend build failed: ${buildErr.trim() || buildOut.trim()}`,
            "system"
          );
        } else {
          addLog("Frontend rebuilt successfully.", "system");
        }
      }

      addLog("Update complete. Restarting server...", "system");
      setUpdateState({
        available: false,
        commitsBehind: 0,
        latestMessage: "",
        checking: false,
        inProgress: false,
      });
      updatingRef.current = false;

      await onRestart();
    },
    [updateState.available, addLog]
  );

  const switchBranch = useCallback(
    async (target: string, onRestart: () => Promise<void>) => {
      setBranchSwitchInProgress(true);
      addLog(`Switching to branch '${target}'...`, "system");

      // Stash local changes
      const status = runGit("status", "--porcelain");
      if (status.ok && status.out) {
        addLog("Stashing local changes...", "system");
        runGit(
          "stash",
          "push",
          "-m",
          `lumiverse-branch-switch-${currentBranch}`
        );
      }

      // Checkout
      const checkout = runGit("checkout", target);
      if (!checkout.ok) {
        addLog(
          `Failed to checkout '${target}': ${checkout.out}`,
          "system"
        );
        addLog("Restarting server on current branch...", "system");
        setBranchSwitchInProgress(false);
        await onRestart();
        return;
      }

      setCurrentBranch(target);
      addLog(`Checked out '${target}'.`, "system");

      // Pull latest
      addLog("Pulling latest changes...", "system");
      const pullProc = Bun.spawn(["git", "pull", "--ff-only"], {
        cwd: PROJECT_ROOT,
        stdout: "pipe",
        stderr: "pipe",
      });
      const pullOut = await new Response(pullProc.stdout).text();
      const pullErr = await new Response(pullProc.stderr).text();
      const pullCode = await pullProc.exited;

      if (pullCode !== 0) {
        addLog(
          `Pull failed (non-fatal): ${pullErr.trim() || pullOut.trim()}`,
          "system"
        );
      } else {
        for (const line of pullOut
          .trim()
          .split("\n")
          .filter((l: string) => l.trim())) {
          addLog(`  ${line.trim()}`, "system");
        }
      }

      // Install backend deps
      addLog("Installing backend dependencies...", "system");
      const backendInstall = Bun.spawn(["bun", "install"], {
        cwd: PROJECT_ROOT,
        stdout: "pipe",
        stderr: "pipe",
      });
      await backendInstall.exited;
      addLog("Backend dependencies updated.", "system");

      // Install and rebuild frontend
      const frontendDir = join(PROJECT_ROOT, "frontend");
      addLog("Installing frontend dependencies...", "system");
      const feInstall = Bun.spawn(["bun", "install"], {
        cwd: frontendDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      await feInstall.exited;
      addLog("Frontend dependencies updated.", "system");

      addLog("Rebuilding frontend...", "system");
      const buildProc = Bun.spawn(["bun", "run", "build"], {
        cwd: frontendDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const buildOut = await new Response(buildProc.stdout).text();
      const buildErr = await new Response(buildProc.stderr).text();
      const buildCode = await buildProc.exited;

      if (buildCode !== 0) {
        addLog(
          `Frontend build failed: ${buildErr.trim() || buildOut.trim()}`,
          "system"
        );
      } else {
        addLog("Frontend rebuilt successfully.", "system");
      }

      // Clear update state
      setUpdateState({
        available: false,
        commitsBehind: 0,
        latestMessage: "",
        checking: false,
        inProgress: false,
      });

      addLog(
        `Branch switch complete. Now on '${target}'. Restarting server...`,
        "system"
      );
      setBranchSwitchInProgress(false);

      await onRestart();

      // Re-check updates on new branch
      setTimeout(() => checkForUpdates(), 5000);
    },
    [currentBranch, addLog, checkForUpdates]
  );

  // Start periodic update checking
  useEffect(() => {
    const initialTimer = setTimeout(() => checkForUpdates(), 5000);
    const interval = setInterval(
      () => checkForUpdates(),
      UPDATE_CHECK_INTERVAL_MS
    );

    return () => {
      clearTimeout(initialTimer);
      clearInterval(interval);
    };
  }, [checkForUpdates]);

  return {
    updateState,
    currentBranch,
    branchSwitchInProgress,
    checkForUpdates,
    applyUpdate,
    switchBranch,
  };
}
