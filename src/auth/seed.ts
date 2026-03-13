import { getDb } from "../db/connection";
import { env } from "../env";
import { auth, allowCreation } from "./index";
import { provisionUserDirectories } from "./provision";

const CONTENT_TABLES = [
  "characters",
  "chats",
  "personas",
  "world_books",
  "presets",
  "connection_profiles",
  "images",
  "secrets",
  "settings",
];

export async function seedOwner(): Promise<void> {
  const db = getDb();

  const userCount = db.query('SELECT COUNT(*) as count FROM "user"').get() as { count: number } | null;
  if (userCount && userCount.count > 0) {
    // Users exist — skip initial seed but still enforce the owner role below.
  } else {
    // First run: create the owner account.
    console.log(`[Auth] Seeding owner account: ${env.ownerUsername}`);

    allowCreation();

    try {
      await auth.api.signUpEmail({
        body: {
          email: `${env.ownerUsername}@lumiverse.local`,
          password: env.ownerPassword,
          name: env.ownerUsername,
          username: env.ownerUsername,
        },
      });
    } catch (err) {
      console.error("[Auth] Failed to seed owner:", err);
      throw err;
    }
  }

  // Always ensure the designated owner has role = "owner".
  // signUpEmail() creates users with role = "user" (admin plugin default).
  // The UPDATE is a separate step — if the process crashed between the
  // INSERT and this UPDATE on a previous run, the owner would be stuck
  // as "user" forever since the count-guard above would skip re-seeding.
  const owner = db
    .query('SELECT id, role FROM "user" WHERE username = ?')
    .get(env.ownerUsername) as { id: string; role: string } | null;

  if (owner) {
    if (owner.role !== "owner") {
      db.run('UPDATE "user" SET role = ? WHERE id = ?', ["owner", owner.id]);
      console.log(`[Auth] Promoted ${env.ownerUsername} to owner role (was "${owner.role}")`);
    }
    provisionUserDirectories(owner.id);
  }
}

export function backfillUserIds(): void {
  const db = getDb();

  const owner = db
    .query('SELECT id FROM "user" WHERE role = ? LIMIT 1')
    .get("owner") as { id: string } | null;

  if (!owner) {
    console.log("[Auth] No owner found, skipping backfill.");
    return;
  }

  let totalBackfilled = 0;

  for (const table of CONTENT_TABLES) {
    try {
      // Check if user_id column exists
      const cols = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
      const hasUserIdCol = cols.some((c) => c.name === "user_id");
      if (!hasUserIdCol) continue;

      const result = db.run(
        `UPDATE ${table} SET user_id = ? WHERE user_id IS NULL`,
        [owner.id]
      );
      if (result.changes > 0) {
        totalBackfilled += result.changes;
        console.log(`[Auth] Backfilled ${result.changes} rows in ${table}`);
      }
    } catch {
      // Table may not exist yet
    }
  }

  if (totalBackfilled > 0) {
    console.log(`[Auth] Total backfilled: ${totalBackfilled} rows`);
  }
}
