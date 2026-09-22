import { describe, expect, test } from "bun:test";
import { clearMacroAstCache, parse } from "./MacroParser";

describe("MacroParser cache", () => {
  test("rebuilds parsed templates after a pressure release", () => {
    const first = parse("Hello, {{char}}!");
    expect(parse("Hello, {{char}}!")).toBe(first);

    clearMacroAstCache();

    expect(parse("Hello, {{char}}!")).not.toBe(first);
  });
});
