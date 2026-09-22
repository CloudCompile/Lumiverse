import { describe, expect, test } from "bun:test";

const capability = await Bun.file(
  new URL("../src-tauri/capabilities/frontend-titlebar.json", import.meta.url),
).json();

// Tauri matches remote capability URLs using the URLPattern standard.
// A hostname wildcard alone does not include non-default ports.
const patterns = capability.remote.urls.map((url: string) => new URLPattern(url));
const allows = (url: string) => patterns.some((pattern: URLPattern) => pattern.test(url));

describe("frontend titlebar remote origins", () => {
  test.each([
    "https://lumiverse.example:8444/",
    "https://lumiverse.example:8444/chat/123?view=chat",
    "http://192.168.1.20:7860/",
    "http://localhost:3000/",
    "http://127.0.0.1:3000/",
    "https://lumiverse.example/",
    "http://lumiverse.example/",
  ])("allows window controls for %s", (url) => {
    expect(allows(url)).toBe(true);
  });

  test.each([
    "ftp://lumiverse.example:8444/",
    "file:///tmp/index.html",
    "tauri://localhost/",
  ])("does not grant remote access to %s", (url) => {
    expect(allows(url)).toBe(false);
  });
});
