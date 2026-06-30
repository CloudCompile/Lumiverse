import { betterAuth } from "better-auth";
import { username, admin, bearer } from "better-auth/plugins";
import { getDb } from "../db/connection";
import { env } from "../env";
import { provisionUserDirectories } from "./provision";
import { seedDefaultPreset } from "./default-preset";
import { getAllowedOrigins } from "../services/trusted-hosts.service";

// ─── Signup gate ────────────────────────────────────────────────────────
// All signups are blocked unless a valid nonce is presented.
// Nonces are single-use, short-lived (10s), and cryptographically random.

let creationNonce: string | null = null;
let creationNonceExpiry = 0;
// Race-condition guard: prevents two concurrent user-creation requests from
// both passing the nonce check (audit M-02 / auth race-condition finding).
let _creationLock = false;

export const CREATION_NONCE_HEADER = "x-lumiverse-creation-nonce";

export function allowCreation(): string {
  creationNonce = crypto.randomUUID();
  creationNonceExpiry = Date.now() + 10_000;
  return creationNonce;
}

function consumeNonce(expectedNonce: string | null): boolean {
  if (!creationNonce) return false;
  if (Date.now() > creationNonceExpiry) {
    creationNonce = null;
    return false;
  }
  if (creationNonce !== expectedNonce) return false;
  creationNonce = null; // single use
  return true;
}

// ─── BetterAuth instance ────────────────────────────────────────────────

export const auth = betterAuth({
  database: getDb(),
  baseURL: process.env.AUTH_BASE_URL || `http://localhost:${env.port}`,
  basePath: "/api/auth",
  secret: env.authSecret,
  // Dynamic form so that hosts added via the Operator panel (Host-header
  // allowlist) are also accepted by BetterAuth's origin check. A static array
  // would freeze the env-only baseline at module init, which is why newly
  // added trusted hosts appeared to "revert" on every server restart — the
  // DB-backed hosts were loaded into the middleware's cache but never fed
  // back into BetterAuth.
  trustedOrigins: (request?: Request) => {
    if (env.trustAnyOrigin) {
      const origin = request?.headers.get("origin");
      return origin ? [origin] : [];
    }
    return [...getAllowedOrigins()];
  },
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
  },
  plugins: [
    username({
      usernameNormalization: (u) => u.toLowerCase(),
    }),
    admin({
      defaultRole: "user",
      adminRoles: ["admin", "owner"],
      roles: {
        user: {} as any,
        admin: {} as any,
        owner: {} as any,
      },
    }),
    bearer(),
  ],
  databaseHooks: {
    user: {
      create: {
        before: async (_user, ctx) => {
          const expectedNonce = ctx?.headers?.get(CREATION_NONCE_HEADER) ?? null;
          const isPublicSignup = env.allowPublicSignup === true;

          // Path 1: Nonce-based signup (operator invites)
          if (expectedNonce) {
            if (!consumeNonce(expectedNonce)) {
              return false;
            }
            return true;
          }

          // Path 2: Public signup (self-registration)
          if (isPublicSignup) {
            return true;
          }

          // Path 3: Signup disabled
          return false;
        },
        after: async (user) => {
          // BetterAuth swallows hook exceptions, so surface directory or
          // preset-seed failures independently instead of dropping the user
          // into a half-provisioned state with no signal in the logs.
          try {
            provisionUserDirectories(user.id);
          } catch (err) {
            console.error(
              `[Auth] Failed to provision directories for user ${user.id}:`,
              err instanceof Error ? err.message : err,
            );
          }
          try {
            seedDefaultPreset(user.id, { setActive: true });
          } catch (err) {
            console.error(
              `[Auth] Failed to seed default preset for user ${user.id}:`,
              err instanceof Error ? err.message : err,
            );
          }
        },
      },
    },
  },
});

export type Auth = typeof auth;
