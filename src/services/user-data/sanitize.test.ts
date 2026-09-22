import { describe, expect, test } from "bun:test";
import { sanitizeEntry } from "./sanitize";

const IMAGE_ID = "123e4567-e89b-12d3-a456-426614174000";

describe("user-data thumbnail archive paths", () => {
  test("accepts WebP and AVIF v2 thumbnails", () => {
    for (const codec of ["webp", "avif"] as const) {
      expect(sanitizeEntry(`files/thumbnails/${IMAGE_ID}_thumb_sm_v2.${codec}`)).toMatchObject({
        kind: "files",
        bucket: "thumbnails",
        inner: `${IMAGE_ID}_thumb_sm_v2.${codec}`,
      });
    }
  });

  test("continues to reject unapproved thumbnail extensions", () => {
    expect(() => sanitizeEntry(`files/thumbnails/${IMAGE_ID}_thumb_lg_v2.png`)).toThrow(
      "files/thumbnails entry must be a UUID_thumb file",
    );
  });
});
