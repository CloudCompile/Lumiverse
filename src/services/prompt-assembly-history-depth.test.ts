import { describe, expect, test } from "bun:test";

import type { LlmMessage } from "../llm/types";
import { resolveChatHistoryInsertionIndex } from "./prompt-assembly.service";

function makeMessage(role: LlmMessage["role"], content: string, chatHistory = false): LlmMessage {
  const msg = { role, content } as LlmMessage;
  if (chatHistory) {
    (msg as any).__chatHistorySource = true;
  }
  return msg;
}

describe("resolveChatHistoryInsertionIndex", () => {
  test("inserts relative to tagged chat history instead of prompt tail", () => {
    const messages: LlmMessage[] = [
      makeMessage("system", "preamble"),
      makeMessage("user", "u1", true),
      makeMessage("assistant", "a1", true),
      makeMessage("system", "post-history utility"),
    ];

    expect(resolveChatHistoryInsertionIndex(messages, 1)).toBe(2);
    expect(resolveChatHistoryInsertionIndex(messages, 0)).toBe(3);
  });

  test("ignores non-history insertions interleaved around chat messages", () => {
    const messages: LlmMessage[] = [
      makeMessage("system", "before"),
      makeMessage("user", "u1", true),
      makeMessage("system", "within-history note"),
      makeMessage("assistant", "a1", true),
      makeMessage("user", "u2", true),
      makeMessage("system", "after"),
    ];

    expect(resolveChatHistoryInsertionIndex(messages, 2)).toBe(3);
    expect(resolveChatHistoryInsertionIndex(messages, 1)).toBe(4);
    expect(resolveChatHistoryInsertionIndex(messages, 5)).toBe(1);
  });

  test("falls back to the prompt tail when no chat history exists", () => {
    const messages: LlmMessage[] = [
      makeMessage("system", "only system"),
      makeMessage("assistant", "prefill"),
    ];

    expect(resolveChatHistoryInsertionIndex(messages, 4)).toBe(messages.length);
  });
});
