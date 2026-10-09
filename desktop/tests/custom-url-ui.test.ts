import { describe, expect, test } from "bun:test";

const desktopRoot = new URL("../", import.meta.url);
const html = await Bun.file(new URL("custom-url.html", desktopRoot)).text();
const css = await Bun.file(new URL("src/custom-url.css", desktopRoot)).text();
const script = await Bun.file(new URL("src/custom-url.ts", desktopRoot)).text();

describe("instance connection selector", () => {
  test("uses full-card native radio targets instead of label-only activation", () => {
    expect(html).toContain('for="connection-mode-local"');
    expect(html).toContain('id="connection-mode-local"');
    expect(html).toContain('for="connection-mode-remote"');
    expect(html).toContain('id="connection-mode-remote"');

    const inputRule = css.match(/\.connection-option > input \{([^}]*)\}/)?.[1] ?? "";
    expect(inputRule).toContain("inset: 0");
    expect(inputRule).toContain("width: 100%");
    expect(inputRule).toContain("height: 100%");
    expect(inputRule).not.toContain("pointer-events: none");
  });

  test("wires mode changes before loading persisted settings", () => {
    const changeListener = script.indexOf('option.addEventListener("change"');
    const settingsLoad = script.indexOf("await loadSettings()");

    expect(changeListener).toBeGreaterThan(-1);
    expect(settingsLoad).toBeGreaterThan(-1);
    expect(changeListener).toBeLessThan(settingsLoad);
    expect(css).not.toContain(":has(");
  });
});
