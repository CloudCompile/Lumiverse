import { describe, expect, test } from "bun:test";
import { EmbeddingCache } from "./embedding-cache";

describe("EmbeddingCache memory release", () => {
  test("drops the in-memory tier without requiring the disk cache", () => {
    const cache = new EmbeddingCache(2);
    cache.set("one", [1, 2, 3]);
    cache.set("two", [4, 5, 6]);
    expect(cache.size).toBe(2);

    cache.clearMemory();

    expect(cache.size).toBe(0);
  });
});
