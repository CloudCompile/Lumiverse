import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isInsideWindowsSystem32 } from "./windows-install-location";

describe("isInsideWindowsSystem32", () => {
  test("blocks System32 itself regardless of path casing", () => {
    expect(isInsideWindowsSystem32("C:\\Windows\\System32", "C:\\Windows")).toBe(true);
    expect(isInsideWindowsSystem32("c:\\WINDOWS\\system32\\", "C:\\Windows")).toBe(true);
  });

  test("blocks repositories cloned beneath System32", () => {
    expect(isInsideWindowsSystem32(
      "C:\\Windows\\System32\\Lumiverse",
      "C:\\Windows",
    )).toBe(true);
  });

  test("does not block similarly named or ordinary user directories", () => {
    expect(isInsideWindowsSystem32(
      "C:\\Windows\\System32-backup\\Lumiverse",
      "C:\\Windows",
    )).toBe(false);
    expect(isInsideWindowsSystem32(
      "C:\\Users\\Alice\\Lumiverse",
      "C:\\Windows",
    )).toBe(false);
  });

  test("supports a non-default Windows directory", () => {
    expect(isInsideWindowsSystem32("D:\\WinNT\\System32\\Lumiverse", "D:\\WinNT")).toBe(true);
  });

  test("fails open when Windows did not provide an absolute Windows directory", () => {
    expect(isInsideWindowsSystem32("C:\\Windows\\System32", undefined)).toBe(false);
    expect(isInsideWindowsSystem32("C:\\Windows\\System32", "Windows")).toBe(false);
  });
});

test("the PowerShell launcher runs its first-install guard before installing Bun", () => {
  const launcher = readFileSync(resolve(import.meta.dir, "..", "start.ps1"), "utf8");
  const guardCall = launcher.lastIndexOf("Assert-SafeFirstRunLocation");
  const bunCall = launcher.lastIndexOf("\nEnsure-Bun\n");

  expect(guardCall).toBeGreaterThan(-1);
  expect(bunCall).toBeGreaterThan(guardCall);
});
