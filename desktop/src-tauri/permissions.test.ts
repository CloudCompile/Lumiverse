import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

/**
 * A Tauri command is only callable when two separate things are true: it is
 * registered in `generate_handler!`, and a capability that reaches the calling
 * window grants it. Rust enforces the first at compile time and nothing
 * enforces the second, so a command can be registered, invoked, and silently
 * denied at runtime — the control simply does nothing.
 *
 * These tests close the gap left by Rust's command registration checks: a
 * registered command without a matching permission is denied only at runtime.
 */

const HERE = import.meta.dir;
const PERMISSIONS_DIR = join(HERE, "permissions");
const CAPABILITIES_DIR = join(HERE, "capabilities");

function readSource(name: string): string {
  return readFileSync(join(HERE, "src", name), "utf8");
}

/** Commands exposed to the webview via `generate_handler!`. */
function registeredCommands(): string[] {
  const lib = readSource("lib.rs");
  const block = lib.match(/generate_handler!\[([\s\S]*?)\]/);
  if (!block) throw new Error("generate_handler! block not found in lib.rs");
  return [...block[1].matchAll(/(?:runner|frontend|notifications|remote_instance)::([a-z0-9_]+)/g)].map((m) => m[1]);
}

/** Every command name appearing in any `commands.allow` list. */
function permittedCommands(): Set<string> {
  const names = new Set<string>();
  for (const file of readdirSync(PERMISSIONS_DIR).filter((f) => f.endsWith(".toml"))) {
    const toml = readFileSync(join(PERMISSIONS_DIR, file), "utf8");
    for (const list of toml.matchAll(/commands\.allow\s*=\s*\[([\s\S]*?)\]/g)) {
      for (const entry of list[1].matchAll(/"([a-z0-9_]+)"/g)) names.add(entry[1]);
    }
  }
  return names;
}

function capabilities(): Array<{ file: string; json: Record<string, unknown> }> {
  return readdirSync(CAPABILITIES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((file) => ({
      file,
      json: JSON.parse(readFileSync(join(CAPABILITIES_DIR, file), "utf8")),
    }));
}

describe("tauri command registration", () => {
  test("every registered command is granted by some permission", () => {
    const permitted = permittedCommands();
    const orphaned = registeredCommands().filter((name) => !permitted.has(name));
    // A registered-but-unpermitted command compiles, invokes, and is denied at
    // runtime with no error surfaced to the user.
    expect(orphaned).toEqual([]);
  });

  test("every permitted command is actually registered", () => {
    const registered = new Set(registeredCommands());
    const dangling = [...permittedCommands()].filter((name) => !registered.has(name));
    // A permission naming a command that no longer exists is dead grant surface
    // and hides a rename.
    expect(dangling).toEqual([]);
  });

  test("the stale-shell command remains covered", () => {
    const permitted = permittedCommands();
    // Regression pins: desktop_shell_sha was registered but unpermitted, which
    // silently disabled the stale-shell check entirely.
    expect(permitted.has("desktop_shell_sha")).toBe(true);
  });
});

describe("capability origins", () => {
  /**
   * Labels of windows the Rust side builds from a bundled page. A capability
   * covering one of these must apply to local origins, or it matches the
   * window's label and grants it nothing.
   */
  function localWindowLabels(): string[] {
    const frontend = readSource("frontend.rs");
    const labels: string[] = [];
    for (const m of frontend.matchAll(
      /WebviewWindowBuilder::new\(\s*&app,\s*([^,]+?),\s*WebviewUrl::App/g,
    )) {
      const constName = m[1].trim().replace(/^&/, "");
      // Resolve `const FOO: &str = "bar";` to its literal.
      const decl = frontend.match(
        new RegExp(`const\\s+${constName}\\s*:\\s*&str\\s*=\\s*"([^"]+)"`),
      );
      if (decl) labels.push(decl[1]);
    }
    return labels;
  }

  function matchesWindow(pattern: string, label: string): boolean {
    if (pattern === label) return true;
    if (!pattern.includes("*")) return false;
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`).test(label);
  }

  test("a local window is never left to a remote-only capability", () => {
    const labels = localWindowLabels();
    expect(labels.length).toBeGreaterThan(0);

    const broken: string[] = [];
    for (const label of labels) {
      const matching = capabilities().filter((c) =>
        ((c.json.windows as string[]) ?? []).some((w) => matchesWindow(w, label)),
      );
      if (matching.length === 0) continue;
      // `local` defaults to true when the key is absent.
      const reachable = matching.some((c) => c.json.local !== false);
      if (!reachable) {
        broken.push(`${label} → only ${matching.map((c) => c.file).join(", ")} (all local:false)`);
      }
    }
    expect(broken).toEqual([]);
  });

  test("remote instance credentials are callable only from local windows", () => {
    const grants = capabilities().filter((capability) =>
      ((capability.json.permissions as Array<string | { identifier?: string }>) ?? [])
        .some((permission) => permission === "remote-instance-commands"
          || (typeof permission === "object" && permission.identifier === "remote-instance-commands")),
    );
    expect(grants.length).toBeGreaterThan(0);
    expect(grants.every((capability) => capability.json.remote === undefined)).toBe(true);
    expect(grants.flatMap((capability) => capability.json.windows as string[])).not.toContain("frontend");
  });
});
