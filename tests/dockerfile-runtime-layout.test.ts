import { describe, expect, test } from "bun:test";
import { join } from "node:path";

async function readDockerfile(): Promise<string> {
  const dockerfile = await Bun.file(join(import.meta.dir, "..", "Dockerfile")).text();
  return dockerfile;
}

describe("Docker runtime image", () => {
  test("ships frontend version metadata alongside dist assets", async () => {
    const dockerfile = await readDockerfile();

    expect(dockerfile).toMatch(/cp -R dist package\.json \/app\/frontend\//);
    expect(dockerfile).toMatch(/FRONTEND_DIR=\/app\/frontend\/dist/);
  });

  test("stays within the Small container build limits", async () => {
    const dockerfile = await readDockerfile();

    expect(Buffer.byteLength(dockerfile)).toBeLessThanOrEqual(3000);
    expect(dockerfile.match(/^FROM /gm)).toHaveLength(1);
  });

  test("provisions a writable persistent data dir", async () => {
    const dockerfile = await readDockerfile();

    expect(dockerfile).toMatch(/mkdir -p \/app\/data/);
    expect(dockerfile).toMatch(/DATA_DIR=\/app\/data/);
    expect(dockerfile).toMatch(/VOLUME \/app\/data/);
  });
});
