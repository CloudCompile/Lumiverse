import { describe, expect, test } from "bun:test";

import { detectDangerousBackendCapabilities, PRIVILEGED_PERMISSIONS } from "./manager.service";

describe("detectDangerousBackendCapabilities", () => {
  test("flags blocked runtime capabilities", () => {
    const code = `
      import { readFileSync } from "node:fs";
      const child = require("node:child_process");
      const db = await import("bun:sqlite");
      const value = process.env.SECRET_KEY;
      Bun.spawn(["whoami"]);
      void readFileSync;
      void child;
      void db;
      void value;
    `;

    expect(detectDangerousBackendCapabilities(code)).toEqual([
      "filesystem module access",
      "subprocess module access",
      "direct SQLite module access",
      "dangerous Bun system API usage",
      "dangerous process API usage",
    ]);
  });

  test("allows ordinary spindle backend logic", () => {
    const code = `
      spindle.onFrontendMessage((payload) => {
        spindle.frontend.postMessage({ ok: true, payload });
      });

      export async function activate() {
        const granted = await spindle.permissions.getGranted();
        return granted.length;
      }
    `;

    expect(detectDangerousBackendCapabilities(code)).toEqual([]);
  });
});

describe("PRIVILEGED_PERMISSIONS", () => {
  test("requires explicit approval for app manipulation", () => {
    expect(PRIVILEGED_PERMISSIONS.has("app_manipulation")).toBe(true);
  });
});
