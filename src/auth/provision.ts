import { mkdirSync, existsSync } from "fs";
import { join, resolve, sep } from "path";
import { env } from "../env";

export function provisionUserDirectories(userId: string): void {
  const userDir = getUserBaseDir(userId);
  const storagePath = join(userDir, "storage");
  const extensionsPath = join(userDir, "extensions");

  if (!existsSync(storagePath)) mkdirSync(storagePath, { recursive: true });
  if (!existsSync(extensionsPath)) mkdirSync(extensionsPath, { recursive: true });
}

export function getUserBaseDir(userId: string): string {
  return join(env.dataDir, "users", userId);
}

export function getUserStoragePath(userId: string): string {
  return join(getUserBaseDir(userId), "storage");
}

export function getUserExtensionPath(userId: string, identifier: string): string {
  const base = join(getUserBaseDir(userId), "extensions");
  // Resolve the full path and verify it is still inside the user's extensions
  // directory.  path.join() does not prevent directory traversal so we must
  // use resolve() + a startsWith() guard.
  const resolved = resolve(base, identifier);
  if (!resolved.startsWith(base + sep) && resolved !== base) {
    throw new Error(`Invalid extension identifier: path traversal detected`);
  }
  return resolved;
}
