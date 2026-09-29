import { describe, expect, test } from "bun:test";
import { join } from "node:path";

async function readRuntimeStage(): Promise<string> {
  const dockerfile = await Bun.file(join(import.meta.dir, "..", "Dockerfile")).text();
  const runtimeStage = dockerfile.split(/\nFROM oven\/bun:[^\s]+\s*\n/).at(-1);

  if (!runtimeStage || runtimeStage === dockerfile) {
    throw new Error("Could not locate the final runtime stage in Dockerfile");
  }

  return runtimeStage;
}

describe("Docker runtime image", () => {
  test("ships frontend version metadata alongside dist assets", async () => {
    const runtimeStage = await readRuntimeStage();

    expect(runtimeStage).toMatch(/COPY --from=frontend-build \/app\/frontend\/dist \.\/frontend\/dist/);
    expect(runtimeStage).toMatch(/COPY --from=frontend-build \/app\/frontend\/package\.json \.\/frontend\/package\.json/);
  });

  test("provisions a writable ephemeral runtime dir for relocated LanceDB", async () => {
    const runtimeStage = await readRuntimeStage();

    // LanceDB must be able to commit locally, so the runtime dir has to exist
    // and be owned by the bun user, and must not be a persistent VOLUME.
    expect(runtimeStage).toMatch(/mkdir -p \/app\/runtime-data && chown -R bun:bun \/app\/runtime-data/);
    expect(runtimeStage).toMatch(/ENV LUMIVERSE_RUNTIME_DIR=\/app\/runtime-data/);
    expect(runtimeStage).not.toMatch(/VOLUME[^\n]*\/app\/runtime-data/);
  });
});
