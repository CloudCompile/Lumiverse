import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configureBundleOwner, hasConfiguredOwner, validateOwner } from "../src/runtime/bundle-setup";

export async function configureAndroidOwner(dataDir: string, port: number, input: Record<string, unknown>): Promise<void> {
  validateOwner(input.username, input.password);
  if (hasConfiguredOwner(dataDir)) throw new Error("This device already has a Lumiverse account.");
  const storageMiB = Number(input.extensionStorageMiB);
  const globalMaxBytes = storageMiB * 1024 * 1024;
  if (!Number.isSafeInteger(storageMiB) || storageMiB < 1 || !Number.isSafeInteger(globalMaxBytes)) {
    throw new Error("Choose a whole number of MiB for extension storage (at least 1).");
  }
  // Use the same durable configuration read by the extension pool service.
  const directory = join(dataDir, "spindle");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "ephemeral-pools.json");
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify({
    globalMaxBytes,
    extensionDefaultMaxBytes: Math.min(Math.floor(globalMaxBytes / 10), 50 * 1024 * 1024),
    extensionMaxOverrides: {},
    reservationTtlMs: 600_000,
  }, null, 2), { mode: 0o600 });
  renameSync(temporary, path);
  await configureBundleOwner({ format: 1, dataDir, port, host: "127.0.0.1" },
    join(dataDir, "android-server.json"), input.username, input.password);
}
