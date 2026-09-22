import { describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { readExtensionArchive } from "./extensions";

const MANIFEST = strToU8(JSON.stringify({ identifier: "quiet_toolbox" }));

describe("readExtensionArchive", () => {
  test("reads an extension whose manifest is at the top of the archive", () => {
    const files = readExtensionArchive(zipSync({ "spindle.json": MANIFEST, "dist/backend.js": strToU8("x") }));
    expect([...files.keys()].sort()).toEqual(["dist/backend.js", "spindle.json"]);
  });

  test("installs the contents of the folders a repository download wraps around it", () => {
    const files = readExtensionArchive(zipSync({
      "quiet-toolbox-main/inner/spindle.json": MANIFEST,
      "quiet-toolbox-main/inner/src/backend.ts": strToU8("x"),
      "quiet-toolbox-main/.DS_Store": strToU8("x"),
      "__MACOSX/quiet-toolbox-main/._spindle.json": strToU8("x"),
    }));
    expect([...files.keys()].sort()).toEqual(["spindle.json", "src/backend.ts"]);
  });

  test("refuses an archive without a manifest at its top or inside one wrapping folder", () => {
    expect(() => readExtensionArchive(zipSync({
      "a/spindle.json": MANIFEST,
      "b/readme.md": strToU8("x"),
    }))).toThrow(/spindle.json/);
  });
});
