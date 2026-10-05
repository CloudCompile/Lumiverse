import { describe, expect, test } from "bun:test";
import { chunkDocument } from "./document-chunker.service";

describe("chunkDocument", () => {
  test("metadata offsets identify the exact source text", () => {
    const text = "Intro text.\n\n## Details\nFirst paragraph.\n\nSecond paragraph.";
    const chunks = chunkDocument(text, { targetTokens: 2, maxTokens: 4, overlapTokens: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(text.slice(chunk.metadata.startOffset, chunk.metadata.endOffset)).toBe(chunk.content);
    }
  });

  test("splits overlong sentences without exceeding maxTokens", () => {
    const text = `## Words\n${"word ".repeat(40).trim()}`;
    const chunks = chunkDocument(text, { targetTokens: 4, maxTokens: 8, overlapTokens: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(8);
      expect(chunk.tokenCount).toBe(Math.ceil(chunk.content.split(/\s+/).length * 1.33));
      expect(text.slice(chunk.metadata.startOffset, chunk.metadata.endOffset)).toBe(chunk.content);
    }
  });
});
