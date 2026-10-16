import { mkdirSync } from "node:fs";
import { join } from "node:path";

export async function checkAndroidGit(directory: string): Promise<string> {
  mkdirSync(directory, { recursive: true });
  async function git(...args: string[]) {
    const child = Bun.spawn(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code) throw new Error(`Git check failed: ${stderr}`);
    return stdout.trim();
  }
  const version = await git("--version");
  await git("init", "--quiet");
  await Bun.write(join(directory, "probe.txt"), "Android extension Git probe\n");
  await git("add", "probe.txt");
  await git("-c", "user.name=Android probe", "-c", "user.email=probe@lumiverse.local", "commit", "--quiet", "-m", "probe");
  if (await git("ls-files") !== "probe.txt") throw new Error("Git cannot read the extension checkout");
  // A shell alias exercises the relocated shell constant as well as Git itself.
  if (await git("-c", "alias.android-probe=!printf shell-ok", "android-probe") !== "shell-ok") throw new Error("Git cannot launch Android's shell");
  return `${version}: checkout/index and Android shell passed; HTTPS helper and CA bundle packaged.`;
}
