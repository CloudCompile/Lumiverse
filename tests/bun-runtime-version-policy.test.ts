import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { meetsVersion, MIN_BUN_VERSION } from "../scripts/desktop-toolchain";
import {
  MINIMUM_BUN_VERSION,
  canTrustCurrentBunRuntime,
  meetsBunVersion,
  requiredBunVersion,
  windowsRuntimeRoot,
} from "../src/runtime/bun-runtime";

const root = join(import.meta.dir, "..");

async function read(path: string): Promise<string> {
  return (await Bun.file(join(root, path)).text()).replace(/\r\n/g, "\n");
}

describe("Bun runtime version policy", () => {
  test("keeps runtime, types, Docker, desktop CI, and launchers on 1.4.2", async () => {
    const [rootPackage, frontendPackage, dockerfile, desktopBuild, desktopRelease, unixLauncher, windowsLauncher, backendRuntime, desktopRunner] =
      await Promise.all([
        Bun.file(join(root, "package.json")).json(),
        Bun.file(join(root, "frontend", "package.json")).json(),
        read("Dockerfile"),
        read(".github/workflows/desktop-build.yml"),
        read(".github/workflows/desktop-release.yml"),
        read("start.sh"),
        read("start.ps1"),
        read("src/index.ts"),
        read("scripts/runner.ts"),
      ]);

    expect(rootPackage.packageManager).toBe("bun@1.4.2");
    expect(rootPackage.engines?.bun).toBe(">=1.4.2");
    expect(rootPackage.devDependencies?.["bun-types"]).toBe("^1.4.2");
    expect(frontendPackage.devDependencies?.["bun-types"]).toBe("^1.4.2");
    expect(MIN_BUN_VERSION).toBe("1.4.2");

    const pinnedImage =
      "oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61";
    expect(dockerfile.match(new RegExp(pinnedImage, "g"))).toHaveLength(3);
    expect(desktopBuild).toContain("bun-version: 1.4.2");
    expect(desktopRelease).toContain("bun-version: 1.4.2");
    expect(unixLauncher).toContain('MINIMUM_BUN_VERSION="1.4.2"');
    expect(windowsLauncher).toContain('$MinimumBunVersion = [version]"1.4.2"');
    expect(MINIMUM_BUN_VERSION).toBe("1.4.2");
    expect(requiredBunVersion(root)).toBe("1.4.2");
    expect(backendRuntime).toContain("await bootstrapBunRuntime");
    expect(desktopRunner).toContain("await bootstrapBunRuntime");
    expect(await read("scripts/runner/server-manager.ts")).toContain("await ensureBunRuntime(PROJECT_ROOT)");
  });

  test("rejects 1.4.1 and keeps the PowerShell upgrade gate before mode dispatch", async () => {
    expect(meetsVersion("1.4.1", MIN_BUN_VERSION)).toBe(false);
    expect(meetsVersion("1.4.2", MIN_BUN_VERSION)).toBe(true);

    const launcher = await read("start.ps1");
    const gateStart = launcher.indexOf("function Ensure-MinimumBunVersion {");
    const gateEnd = launcher.indexOf("\n# ─── First-run setup wizard", gateStart);
    const gate = launcher.slice(gateStart, gateEnd);

    expect(gateStart).toBeGreaterThan(-1);
    expect(gateEnd).toBeGreaterThan(gateStart);
    expect(gate.match(/Get-BunSemanticVersion/g)).toHaveLength(3);
    expect(gate).toContain('Invoke-BunUpgrade "stable"');
    expect(gate).toContain("Install-LumiverseBunRuntime");
    expect(gate).toContain("exit 1");
    expect(launcher).toContain("Ensure-Bun\nUpdate-BunChannel\nEnsure-MinimumBunVersion\n");
  });

  test("selects a versioned Windows runtime and compares prerelease versions numerically", () => {
    expect(meetsBunVersion("1.4.1", "1.4.2")).toBe(false);
    expect(meetsBunVersion("1.4.2-canary.1", "1.4.2")).toBe(true);
    expect(meetsBunVersion("1.5.0", "1.4.2")).toBe(true);
    expect(windowsRuntimeRoot("1.4.2", {
      LOCALAPPDATA: "C:\\Users\\Alice\\AppData\\Local",
    }, root)).toBe("C:\\Users\\Alice\\AppData\\Local\\Lumiverse\\runtimes\\bun-1.4.2");
  });

  test("trusts an already-running non-Windows Bun without probing its raw executable", () => {
    expect(canTrustCurrentBunRuntime("1.4.2", "1.4.2", "linux")).toBe(true);
    expect(canTrustCurrentBunRuntime("1.5.0", "1.4.2", "darwin")).toBe(true);
    expect(canTrustCurrentBunRuntime("1.4.1", "1.4.2", "linux")).toBe(false);
    // Keep Windows on the side-by-side runtime selection/probe path.
    expect(canTrustCurrentBunRuntime("1.4.2", "1.4.2", "win32")).toBe(false);
  });

  test("updates native Termux Bun and rebuilds its wrapper only when the version changes", async () => {
    const launcher = await read("start.sh");
    const upgradeStart = launcher.indexOf("upgrade_bun_channel() {");
    const upgradeEnd = launcher.indexOf("\nupgrade_bun_if_requested()", upgradeStart);
    const upgradeFunction = launcher.slice(upgradeStart, upgradeEnd);
    const standardPath = upgradeFunction.indexOf("# ── Standard path");
    const nativeTermuxPath = upgradeFunction.slice(0, standardPath);
    const helperStart = launcher.indexOf("upgrade_bun_termux() {");
    const helperEnd = launcher.indexOf("\nverify_termux_bun_install_path()", helperStart);
    const termuxUpgradeHelper = launcher.slice(helperStart, helperEnd);
    const runtimeUpdate = termuxUpgradeHelper.indexOf("update_bun_termux_components bun");
    const unchangedGate = termuxUpgradeHelper.indexOf('if [[ "$after" == "$before" ]]');
    const wrapperUpdate = termuxUpgradeHelper.indexOf("update_bun_termux_components wrapper");

    expect(upgradeStart).toBeGreaterThanOrEqual(0);
    expect(upgradeEnd).toBeGreaterThan(upgradeStart);
    expect(standardPath).toBeGreaterThanOrEqual(0);
    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(helperEnd).toBeGreaterThan(helperStart);
    expect(nativeTermuxPath).toContain('if [[ "$IS_TERMUX" == true ]]');
    expect(nativeTermuxPath).toContain('upgrade_bun_termux "$before"');
    expect(nativeTermuxPath).toContain("_resolve_bun");
    expect(nativeTermuxPath).toContain("verify_termux_bun_install_path");
    expect(nativeTermuxPath).not.toContain("_bun upgrade");
    expect(runtimeUpdate).toBeGreaterThanOrEqual(0);
    expect(unchangedGate).toBeGreaterThan(runtimeUpdate);
    expect(wrapperUpdate).toBeGreaterThan(unchangedGate);
    expect(termuxUpgradeHelper).toContain("Termux wrapper unchanged because the Bun version did not change");
    expect(termuxUpgradeHelper).not.toContain("update_bun_termux_components all");
    expect(nativeTermuxPath).toContain('ok "Bun $after is already up to date"');
    expect(nativeTermuxPath).toContain('ok "Bun upgraded via bun-termux: $before -> $after"');
    expect(launcher).toContain(
      "ensure_bun\nupgrade_bun_if_requested\nensure_minimum_bun_version\nexport_termux_bun_env",
    );
  });
});
