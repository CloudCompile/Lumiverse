import { Hono } from "hono";
import { cpus, totalmem, freemem, platform, arch, release } from "os";
import { exec } from "child_process";
import { join } from "path";
import { requireOwner } from "../auth/middleware";

const app = new Hono();

// H-24: Restrict access to owner/admin — system info contains sensitive
// internal details (hostname, OS, CPU, git history) that should not be
// exposed to regular users.
app.use("*", requireOwner);

async function getBackendVersion(): Promise<string> {
  try {
    const raw = await Bun.file(join(import.meta.dir, "../../package.json")).text();
    const pkg = JSON.parse(raw);
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

// H-24: replaced execSync (blocks event loop) with promise-wrapped exec
function execAsync(cmd: string, cwd: string): Promise<string> {
  return new Promise((resolve) => {
    exec(cmd, { cwd, encoding: "utf-8", timeout: 5000 }, (err, stdout) => {
      resolve(err ? "unknown" : stdout.trim());
    });
  });
}

async function getGitInfo(): Promise<{ branch: string; commit: string }> {
  const projectRoot = join(import.meta.dir, "../..");
  try {
    const [branch, commit] = await Promise.all([
      execAsync("git rev-parse --abbrev-ref HEAD", projectRoot),
      execAsync("git rev-parse --short HEAD", projectRoot),
    ]);
    return { branch, commit };
  } catch {
    return { branch: "unknown", commit: "unknown" };
  }
}

function getDiskUsage(): { total: number; used: number } | null {
  try {
    const { statfsSync } = require("fs");
    const stat = statfsSync("/");
    const total = stat.blocks * stat.bsize;
    const free = stat.bavail * stat.bsize;
    return { total, used: total - free };
  } catch {
    return null;
  }
}

app.get("/info", async (c) => {
  const cpu = cpus();
  const disk = getDiskUsage();

  return c.json({
    os: {
      platform: platform(),
      arch: arch(),
      release: release(),
      // H-24: hostname omitted — exposes internal server identity and is not
      // needed by the UI for any functional purpose.
    },
    cpu: {
      model: cpu[0]?.model ?? "unknown",
      cores: cpu.length,
    },
    memory: {
      total: totalmem(),
      free: freemem(),
    },
    disk,
    backend: {
      version: await getBackendVersion(),
      runtime: `Bun ${Bun.version}`,
    },
    git: await getGitInfo(),
  });
});

export { app as systemRoutes };
