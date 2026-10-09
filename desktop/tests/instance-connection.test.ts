import { describe, expect, test } from "bun:test";
import { normalizeInstanceConnection, normalizeRemoteOrigin } from "../src/instance-connection";

describe("remote instance origins", () => {
  test("canonicalizes a secure URL to its origin", () => {
    expect(normalizeRemoteOrigin(" https://example.com/some/page?x=1 ")).toBe("https://example.com");
  });

  test("allows insecure HTTP only for loopback development", () => {
    expect(normalizeRemoteOrigin("http://localhost:7860/app")).toBe("http://localhost:7860");
    expect(() => normalizeRemoteOrigin("http://192.168.1.2:7860")).toThrow("must use HTTPS");
  });

  test("rejects embedded credentials", () => {
    expect(() => normalizeRemoteOrigin("https://user:secret@example.com")).toThrow("must not contain");
  });
});

describe("saved connection migration", () => {
  test("migrates the former custom URL setting", () => {
    expect(normalizeInstanceConnection(undefined, "https://example.com/chat")).toEqual({
      mode: "remote",
      origin: "https://example.com",
    });
  });

  test("falls back safely when persisted data is invalid", () => {
    expect(normalizeInstanceConnection({ mode: "remote", origin: "javascript:alert(1)" })).toEqual({ mode: "local" });
  });
});
