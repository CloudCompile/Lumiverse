import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  convertImageToPng,
  readImageMetadata,
  resizeInsideToWebp,
  writeInsideAvif,
  writeInsideWebp,
} from "./image-pipeline";

const workDir = mkdtempSync(join(tmpdir(), "lumiverse-bun-image-test-"));
const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

afterAll(() => rmSync(workDir, { recursive: true, force: true }));

describe("Bun-native image pipeline", () => {
  test("reads metadata and converts supported bitmap inputs", async () => {
    expect(await readImageMetadata(onePixelPng)).toMatchObject({
      width: 1,
      height: 1,
      format: "png",
    });

    const webp = await resizeInsideToWebp(onePixelPng, 32, 32, 80, {
      withoutEnlargement: true,
    });
    expect(await readImageMetadata(webp)).toMatchObject({
      width: 1,
      height: 1,
      format: "webp",
    });

    const png = await convertImageToPng(webp);
    expect((await readImageMetadata(png)).format).toBe("png");
  });

  test("writes WebP output without buffering it in the caller", async () => {
    const destination = join(workDir, "thumbnail.webp");
    await writeInsideWebp(onePixelPng, destination, 32, 32, 80, {
      withoutEnlargement: true,
    });
    expect(await readImageMetadata(destination)).toMatchObject({
      width: 1,
      height: 1,
      format: "webp",
    });
  });

  test("writes AVIF output through Sharp", async () => {
    const destination = join(workDir, "thumbnail.avif");
    await writeInsideAvif(onePixelPng, destination, 32, 32, 54, {
      withoutEnlargement: true,
    });
    expect(await readImageMetadata(destination)).toMatchObject({
      width: 1,
      height: 1,
      format: "avif",
    });
  });

  test("falls back to Sharp for formats outside Bun.Image", async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8"><rect width="12" height="8" fill="red"/></svg>',
    );
    expect(await readImageMetadata(svg)).toMatchObject({
      width: 12,
      height: 8,
      format: "svg",
    });
    const webp = await resizeInsideToWebp(svg, 6, 6, 80);
    expect(await readImageMetadata(webp)).toMatchObject({
      width: 6,
      height: 4,
      format: "webp",
    });
  });
});
