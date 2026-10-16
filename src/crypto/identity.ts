/**
 * Lumiverse Identity File
 *
 * A binary identity file that stores the AES-256 encryption key in an opaque
 * format. The file looks like random binary data — the key is XOR-masked with
 * a derived value so it cannot be extracted without knowing the internal format.
 *
 * File layout (104 bytes):
 *   [0..3]    Magic: \x89LMV  (binary signature, like PNG uses \x89PNG)
 *   [4]       Version: 0x01
 *   [5..7]    Reserved (random padding)
 *   [8..39]   Random salt (32 bytes)
 *   [40..71]  Masked key: AES-256 key XOR SHA-256(salt || DERIVATION_TAG)
 *   [72..103] Integrity: HMAC-SHA256(raw_key, salt)
 *
 * To recover the key the backend reverses the XOR mask and verifies the HMAC.
 * Without knowledge of the derivation tag the file is indistinguishable from
 * 104 bytes of random data.
 *
 * All file I/O uses Bun-native APIs (Bun.file / Bun.write) for reliable
 * cross-platform behavior, including Termux/Android where Node's fs module
 * with explicit mode flags can fail on non-POSIX filesystems.
 */

import { mkdirSync, chmodSync, existsSync, renameSync } from "node:fs";
import { dirname } from "node:path";

const MAGIC = new Uint8Array([0x89, 0x4c, 0x4d, 0x56]); // \x89LMV
const VERSION = 0x01;
const DERIVATION_TAG = new TextEncoder().encode("lumiverse-identity-derivation");
const FILE_SIZE = 104;

// ─── Low-level helpers (sync, Web Crypto) ────────────────────────────────

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return new Uint8Array(hash);
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    data as BufferSource, // salt is the HMAC key
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, key as BufferSource);
  return new Uint8Array(sig);
}

function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Raised when an identity file exists but cannot be trusted: wrong size, bad
 * magic/version, or a failed HMAC integrity check. Callers distinguish this
 * from "file missing" because a corrupt file needs quarantine-and-rebuild
 * rather than fresh generation.
 */
export class IdentityFileCorruptError extends Error {
  readonly code = "IDENTITY_CORRUPT";
  constructor(message: string) {
    super(message);
    this.name = "IdentityFileCorruptError";
  }
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Create a new identity file from a 32-byte raw key.
 * If no key is provided, one is generated randomly.
 */
export async function createIdentityFile(filePath: string, rawKey?: Uint8Array): Promise<Uint8Array> {
  const key = rawKey ?? crypto.getRandomValues(new Uint8Array(32));

  if (key.length !== 32) {
    throw new Error("Identity key must be exactly 32 bytes");
  }

  const salt = crypto.getRandomValues(new Uint8Array(32));
  const reserved = crypto.getRandomValues(new Uint8Array(3));

  // Derive mask: SHA-256(salt || derivation tag)
  const mask = await sha256(concatBytes(salt, DERIVATION_TAG));
  const maskedKey = xorBytes(key, mask);

  // Integrity: HMAC-SHA256(key, salt)
  const integrity = await hmacSha256(key, salt);

  // Assemble file
  const file = new Uint8Array(FILE_SIZE);
  file.set(MAGIC, 0);
  file[4] = VERSION;
  file.set(reserved, 5);
  file.set(salt, 8);
  file.set(maskedKey, 40);
  file.set(integrity, 72);

  mkdirSync(dirname(filePath), { recursive: true });
  await Bun.write(filePath, file);

  // Set restrictive permissions where the filesystem supports it.
  // Android/Termux storage and other non-POSIX filesystems may not honor chmod.
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Non-fatal: filesystem doesn't support Unix permissions
  }

  // Verify the write actually persisted
  const written = Bun.file(filePath);
  if (!(await written.exists()) || written.size !== FILE_SIZE) {
    throw new Error(
      `Failed to write identity file — expected ${FILE_SIZE} bytes, got ${written.size}: ${filePath}`
    );
  }

  return key;
}

/**
 * Read and extract the AES-256 key from an identity file.
 * Throws on corruption, wrong version, or integrity failure.
 */
export async function readIdentityFile(filePath: string): Promise<Uint8Array> {
  const bunFile = Bun.file(filePath);
  if (!(await bunFile.exists())) {
    throw new Error(`Identity file not found: ${filePath}`);
  }

  const buffer = await bunFile.arrayBuffer();
  const file = new Uint8Array(buffer);

  if (file.length !== FILE_SIZE) {
    throw new IdentityFileCorruptError(`Identity file is ${file.length} bytes, expected ${FILE_SIZE}`);
  }

  // Validate magic
  for (let i = 0; i < MAGIC.length; i++) {
    if (file[i] !== MAGIC[i]) {
      throw new IdentityFileCorruptError("Not a Lumiverse identity file (bad magic)");
    }
  }

  // Validate version
  if (file[4] !== VERSION) {
    throw new IdentityFileCorruptError(`Unsupported identity file version: ${file[4]}`);
  }

  const salt = file.slice(8, 40);
  const maskedKey = file.slice(40, 72);
  const storedHmac = file.slice(72, 104);

  // Recover key
  const mask = await sha256(concatBytes(salt, DERIVATION_TAG));
  const key = xorBytes(maskedKey, mask);

  // Verify integrity
  const expectedHmac = await hmacSha256(key, salt);
  if (!constantTimeEqual(storedHmac, expectedHmac)) {
    throw new IdentityFileCorruptError("Identity file integrity check failed — file may be corrupted");
  }

  return key;
}

/**
 * Move a corrupt identity file aside so a replacement can be written at the
 * original path. The original is preserved (never deleted) because it is the
 * only thing that can still decrypt existing secrets if it is repaired offline.
 */
export function quarantineIdentityFile(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  const target = `${filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    renameSync(filePath, target);
    return target;
  } catch {
    return null;
  }
}

export interface IdentityRecoveryResult {
  key: Uint8Array;
  /** Where the unreadable identity file was preserved, when it could be moved. */
  quarantinedPath: string | null;
  /** True when the replacement key came from ENCRYPTION_KEY rather than a new random key. */
  rebuiltFromEnvKey: boolean;
}

/**
 * Rebuild an unreadable identity file.
 *
 * When `ENCRYPTION_KEY` is still present it is authoritative: the operator has
 * the real key, so we re-seal it into a fresh file and existing secrets keep
 * decrypting. Without it there is no way to recover the old key, so a new
 * random identity is generated and the caller must warn that previously
 * encrypted secrets can no longer be decrypted.
 */
export async function rebuildIdentityFile(
  filePath: string,
  envKeyHex: string,
): Promise<IdentityRecoveryResult> {
  const quarantinedPath = quarantineIdentityFile(filePath);

  if (envKeyHex) {
    const key = hexToBytes(envKeyHex);
    await createIdentityFile(filePath, key);
    return { key, quarantinedPath, rebuiltFromEnvKey: true };
  }

  const key = await createIdentityFile(filePath);
  return { key, quarantinedPath, rebuiltFromEnvKey: false };
}

/**
 * Whether an identity file exists but is not usable (wrong size, bad magic, or
 * failed integrity). Returns the reason so the caller can log it; returns null
 * when the file is absent or valid.
 */
export async function inspectIdentityFile(filePath: string): Promise<string | null> {
  if (!existsSync(filePath)) return null;
  try {
    await readIdentityFile(filePath);
    return null;
  } catch (err) {
    if (err instanceof IdentityFileCorruptError) return err.message;
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Convert a hex string (e.g. from ENCRYPTION_KEY env var) to raw bytes.
 */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s/g, "");
  if (clean.length !== 64) {
    throw new Error(`Expected 64-char hex string, got ${clean.length}`);
  }
  return new Uint8Array(clean.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
}

/**
 * Convert raw bytes to hex string.
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Derive a BetterAuth-compatible secret from the identity key.
 * Deterministic: same identity key always produces the same secret.
 */
export async function deriveAuthSecret(key: Uint8Array): Promise<string> {
  const tag = new TextEncoder().encode("lumiverse-auth-secret-v1");
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, tag as BufferSource);
  return bytesToHex(new Uint8Array(sig));
}

export interface ResolvedIdentity {
  key: Uint8Array;
  /** Hex representation for backwards-compat APIs */
  keyHex: string;
  source: "file" | "env-migrated" | "env-ephemeral" | "generated" | "recovered";
}

/**
 * Resolve the encryption identity using the priority chain:
 *
 * 1. Identity file exists and is readable → use it
 * 2. Identity file exists but is corrupt → quarantine it and rebuild, reusing
 *    ENCRYPTION_KEY when present so existing secrets stay decryptable
 * 3. ENCRYPTION_KEY env var set → migrate to identity file, use it
 * 4. Neither → generate new identity file
 *
 * @param identityPath  Full path to the identity file
 * @param envKeyHex     Value of ENCRYPTION_KEY env var (may be empty)
 */
export async function resolveIdentity(identityPath: string, envKeyHex: string): Promise<ResolvedIdentity> {
  // 1. Identity file exists
  if (await Bun.file(identityPath).exists()) {
    try {
      const key = await readIdentityFile(identityPath);
      return { key, keyHex: bytesToHex(key), source: "file" };
    } catch (err) {
      if (!(err instanceof IdentityFileCorruptError)) throw err;

      // The file is unusable. Rebuild rather than refusing to start: a corrupt
      // identity file used to make the server completely unbootable.
      console.error(`[identity] Identity file is corrupt (${err.message}). Attempting automatic recovery...`);
      const recovered = await rebuildIdentityFile(identityPath, envKeyHex);
      if (recovered.quarantinedPath) {
        console.warn(`[identity] Corrupt identity file preserved at ${recovered.quarantinedPath}`);
      }
      if (recovered.rebuiltFromEnvKey) {
        console.warn("[identity] Rebuilt identity file from ENCRYPTION_KEY. Existing secrets remain readable.");
      } else {
        console.error(
          "[identity] Rebuilt identity file with a NEW random key. Secrets encrypted with the "
            + "previous identity can no longer be decrypted and must be re-entered. Restore the "
            + "quarantined file (or set ENCRYPTION_KEY) to recover them.",
        );
      }
      return { key: recovered.key, keyHex: bytesToHex(recovered.key), source: "recovered" };
    }
  }

  // 2. Env var set — migrate to identity file
  if (envKeyHex) {
    const key = hexToBytes(envKeyHex);
    await createIdentityFile(identityPath, key);
    console.log(`[identity] Migrated ENCRYPTION_KEY to identity file: ${identityPath}`);
    console.log("[identity] You can now remove ENCRYPTION_KEY from your .env file.");
    return { key, keyHex: envKeyHex, source: "env-migrated" };
  }

  // 3. Generate fresh
  const key = await createIdentityFile(identityPath);
  console.log(`[identity] Generated new identity file: ${identityPath}`);
  return { key, keyHex: bytesToHex(key), source: "generated" };
}
