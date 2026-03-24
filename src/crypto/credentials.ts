/**
 * Owner Credentials File
 *
 * Stores the owner's username and password hash in `data/owner.credentials`
 * so that plaintext passwords never need to appear in .env or on disk.
 *
 * The password hash is produced by BetterAuth's hashPassword() (scrypt-based)
 * and is the same format stored in the `account` table — meaning the reset
 * script and seed logic can write directly to both locations.
 *
 * File layout: JSON
 *   { username, passwordHash, createdAt, updatedAt }
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

export interface OwnerCredentials {
  username: string;
  passwordHash: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Check whether the credentials file exists.
 */
export function ownerCredentialsExist(filePath: string): boolean {
  return existsSync(filePath);
}

/**
 * Read and parse the owner credentials file.
 * Throws on missing file or malformed JSON.
 */
export function readOwnerCredentials(filePath: string): OwnerCredentials {
  if (!existsSync(filePath)) {
    throw new Error(`Owner credentials file not found: ${filePath}`);
  }

  const raw = readFileSync(filePath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Owner credentials file is corrupted (invalid JSON)");
  }

  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.username !== "string" ||
    typeof obj.passwordHash !== "string" ||
    typeof obj.createdAt !== "number" ||
    typeof obj.updatedAt !== "number"
  ) {
    throw new Error("Owner credentials file is malformed (missing required fields)");
  }

  return obj as unknown as OwnerCredentials;
}

/**
 * Write (create or overwrite) the owner credentials file.
 * Sets file permissions to 0o600 (owner-only read/write).
 */
export function writeOwnerCredentials(
  filePath: string,
  username: string,
  passwordHash: string
): OwnerCredentials {
  const now = Math.floor(Date.now() / 1000);

  let createdAt = now;
  // Preserve original createdAt if updating an existing file
  if (existsSync(filePath)) {
    try {
      const existing = readOwnerCredentials(filePath);
      createdAt = existing.createdAt;
    } catch {
      // File exists but is corrupted — treat as new
    }
  }

  const credentials: OwnerCredentials = {
    username,
    passwordHash,
    createdAt,
    updatedAt: now,
  };

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(credentials, null, 2) + "\n", { mode: 0o600 });

  return credentials;
}
