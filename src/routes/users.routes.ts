import { Hono } from "hono";
import { requireOwner } from "../auth/middleware";
import { auth, allowCreation, CREATION_NONCE_HEADER } from "../auth";
import { getDb } from "../db/connection";
import { hashPassword, verifyPassword } from "../crypto/password";
import { rateLimit } from "../middleware/rate-limit";
import { purgeUser } from "../services/user-data/purge.service";

const app = new Hono();

type UserRole = "user" | "admin" | "owner";

function getTargetUser(id: string): { id: string; role: UserRole } | null {
  return getDb()
    .query('SELECT id, role FROM "user" WHERE id = ?')
    .get(id) as { id: string; role: UserRole } | null;
}

function isOwnerSession(c: any): boolean {
  return c.get("session")?.user?.role === "owner";
}

function canManageTarget(c: any, targetRole: UserRole): boolean {
  if (isOwnerSession(c)) return true;
  return targetRole === "user";
}

// scrypt-backed endpoints: bound how often a single client can request work
// from the libuv thread pool. 5 attempts per 5 minutes per IP is generous for
// real users (typo, retry) but cripples a brute-force loop.
const passwordLimiter = rateLimit({
  bucket: "user-password",
  max: 5,
  windowMs: 5 * 60 * 1000,
  message: "Too many password attempts. Try again later.",
});

// ── Self-service (any authenticated user) ───────────────────────────────

// POST /me/password — change own password
app.post("/me/password", passwordLimiter, async (c) => {
  const session = c.get("session");
  const body = await c.req.json();

  if (!body.currentPassword || !body.newPassword) {
    return c.json({ error: "currentPassword and newPassword are required" }, 400);
  }

  if (body.newPassword.length < 8 || body.newPassword.length > 128) {
    return c.json({ error: "Password must be between 8 and 128 characters" }, 400);
  }

  const account = getDb()
    .query('SELECT password FROM account WHERE userId = ? AND providerId = ?')
    .get(session.user.id, "credential") as { password: string } | null;

  if (!account) {
    return c.json({ error: "Account not found" }, 404);
  }

  const valid = await verifyPassword({
    hash: account.password,
    password: body.currentPassword,
  });
  if (!valid) {
    return c.json({ error: "Current password is incorrect" }, 403);
  }

  const hashed = await hashPassword(body.newPassword);
  getDb().run(
    'UPDATE account SET password = ? WHERE userId = ? AND providerId = ?',
    [hashed, session.user.id, "credential"]
  );

  // Revoke all other sessions so stolen tokens are invalidated
  getDb().run(
    "DELETE FROM session WHERE userId = ? AND id != ?",
    [session.user.id, session.session.id]
  );

  return c.json({ success: true });
});

// ── Admin routes (require owner/admin role) ─────────────────────────────

const admin = new Hono();
admin.use("/*", requireOwner);

// GET / — list all users
admin.get("/", (c) => {
  const rows = getDb()
    .query('SELECT id, name, email, username, role, banned, banReason, banExpires, createdAt, updatedAt FROM "user" ORDER BY createdAt DESC')
    .all();
  return c.json(rows);
});

// GET /stats — instance-wide overview for the admin dashboard.
admin.get("/stats", (c) => {
  const db = getDb();
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

  const roleRows = db
    .query('SELECT role, COUNT(*) AS count FROM "user" GROUP BY role')
    .all() as { role: string; count: number }[];
  const byRole: Record<string, number> = { user: 0, admin: 0, owner: 0 };
  for (const row of roleRows) byRole[row.role ?? "user"] = row.count;

  const totalUsers = roleRows.reduce((sum, r) => sum + r.count, 0);
  const bannedUsers = (db.query('SELECT COUNT(*) AS count FROM "user" WHERE banned = 1').get() as { count: number }).count;
  const newUsersLast7d = (db.query('SELECT COUNT(*) AS count FROM "user" WHERE createdAt * 1000 >= ?').get(weekAgo) as { count: number }).count;

  // A session row counts as active while its expiry is still in the future.
  const activeSessions = (db.query('SELECT COUNT(*) AS count FROM "session" WHERE expiresAt > ?').get(now) as { count: number }).count;
  const activeUsersLast24h = (db.query('SELECT COUNT(DISTINCT userId) AS count FROM "session" WHERE expiresAt > ? AND updatedAt * 1000 >= ?').get(now, dayAgo) as { count: number }).count;

  return c.json({
    totalUsers,
    byRole,
    bannedUsers,
    newUsersLast7d,
    activeSessions,
    activeUsersLast24h,
    generatedAt: now,
  });
});

// GET /:id — fetch a single user's profile plus their active-session count.
admin.get("/:id", (c) => {
  const { id } = c.req.param();
  const db = getDb();
  const user = db
    .query('SELECT id, name, email, username, displayUsername, role, banned, banReason, banExpires, createdAt, updatedAt FROM "user" WHERE id = ?')
    .get(id);
  if (!user) return c.json({ error: "User not found" }, 404);

  const activeSessions = (db
    .query('SELECT COUNT(*) AS count FROM "session" WHERE userId = ? AND expiresAt > ?')
    .get(id, Date.now()) as { count: number }).count;

  return c.json({ ...(user as object), activeSessions });
});

// PATCH /:id/role — change a user's role.  Owner-only: admins must not be able
// to grant or revoke privileges.  The single-owner invariant is preserved —
// nobody can mint a second owner or demote the existing owner via this route.
admin.patch("/:id/role", async (c) => {
  const { id } = c.req.param();
  const session = c.get("session");

  if (!isOwnerSession(c)) {
    return c.json({ error: "Only the owner can change user roles" }, 403);
  }
  if (session.user.id === id) {
    return c.json({ error: "Cannot change your own role" }, 400);
  }

  const body = await c.req.json();
  const role = body?.role;
  if (role !== "user" && role !== "admin") {
    return c.json({ error: "Invalid role. Allowed: user, admin" }, 400);
  }

  const targetUser = getTargetUser(id);
  if (!targetUser) return c.json({ error: "User not found" }, 404);
  if (targetUser.role === "owner") {
    return c.json({ error: "Cannot change the owner's role" }, 403);
  }
  if (targetUser.role === role) {
    return c.json({ success: true, role });
  }

  getDb().run('UPDATE "user" SET role = ?, updatedAt = ? WHERE id = ?', [role, Math.floor(Date.now() / 1000), id]);
  return c.json({ success: true, role });
});

// POST /:id/revoke-sessions — force a user to re-authenticate without banning
// them (e.g. suspected credential compromise).
admin.post("/:id/revoke-sessions", (c) => {
  const { id } = c.req.param();
  const targetUser = getTargetUser(id);
  if (!targetUser) return c.json({ error: "User not found" }, 404);
  if (!canManageTarget(c, targetUser.role)) {
    return c.json({ error: "Admins can only manage user-role accounts" }, 403);
  }

  const result = getDb().run("DELETE FROM session WHERE userId = ?", [id]);
  return c.json({ success: true, revoked: result.changes });
});

// POST / — create a new user
// Only "user" and "admin" are assignable via the create-user API.
// Nobody can create a second "owner" account — the single-owner model
// is a core security invariant.  (Bug from audit: VALID_ROLES previously
// included "owner", allowing privilege escalation.)
const VALID_ROLES = new Set(["user", "admin"]);

admin.post("/", async (c) => {
  const body = await c.req.json();
  const callerIsOwner = isOwnerSession(c);
  if (!body.username || !body.password) {
    return c.json({ error: "username and password are required" }, 400);
  }

  if (body.password.length < 8 || body.password.length > 128) {
    return c.json({ error: "Password must be between 8 and 128 characters" }, 400);
  }

  // Reject arbitrary role strings up front — only the roles registered with
  // BetterAuth's admin plugin are valid.
  if (body.role !== undefined && !VALID_ROLES.has(body.role)) {
    return c.json({ error: `Invalid role. Allowed: ${[...VALID_ROLES].join(", ")}` }, 400);
  }

  const creationNonce = allowCreation();

  try {
    const newUser = await auth.api.signUpEmail({
      headers: new Headers({
        [CREATION_NONCE_HEADER]: creationNonce,
      }),
      body: {
        email: `${body.username}@lumiverse.local`,
        password: body.password,
        name: body.name || body.username,
        username: body.username,
      },
    });

    if (body.role && body.role !== "user") {
      getDb().run('UPDATE "user" SET role = ? WHERE id = ?', [body.role, newUser.user.id]);
    }

    return c.json(newUser.user, 201);
  } catch (err: any) {
    return c.json({ error: err.message || "Failed to create user" }, 400);
  }
});

// POST /:id/reset-password — admin password reset
admin.post("/:id/reset-password", passwordLimiter, async (c) => {
  const { id } = c.req.param();
  const session = c.get("session");
  const body = await c.req.json();
  const targetUser = getTargetUser(id);

  if (!body.newPassword) {
    return c.json({ error: "newPassword is required" }, 400);
  }

  if (body.newPassword.length < 8 || body.newPassword.length > 128) {
    return c.json({ error: "Password must be between 8 and 128 characters" }, 400);
  }

  if (!targetUser) {
    return c.json({ error: "User not found" }, 404);
  }

  if (!canManageTarget(c, targetUser.role)) {
    return c.json({ error: "Admins can only reset passwords for user-role accounts" }, 403);
  }

  // H-23: Enforce role hierarchy — an admin cannot reset the password of a
  // user with a higher privilege level (owner).  Only the owner can reset
  // another owner's password.
  if (session.user.role !== "owner") {
    const targetUser = getDb()
      .query('SELECT role FROM "user" WHERE id = ?')
      .get(id) as { role: string } | null;
    if (!targetUser) return c.json({ error: "User not found" }, 404);
    if (targetUser.role === "owner") {
      return c.json({ error: "Forbidden: cannot modify a higher-privileged account" }, 403);
    }
  }

  const hashed = await hashPassword(body.newPassword);
  const result = getDb().run(
    'UPDATE account SET password = ? WHERE userId = ? AND providerId = ?',
    [hashed, id, "credential"]
  );

  if (result.changes === 0) {
    return c.json({ error: "User not found" }, 404);
  }

  // Revoke all sessions so user must log in with new password
  getDb().run("DELETE FROM session WHERE userId = ?", [id]);

  return c.json({ success: true });
});

// POST /:id/ban — disable user login. Optional body: { reason?: string,
// expiresInDays?: number } records why the user was banned and, when given, an
// automatic expiry timestamp (banExpires) instead of a permanent ban.
admin.post("/:id/ban", async (c) => {
  const { id } = c.req.param();
  const session = c.get("session");
  const targetUser = getTargetUser(id);

  if (session.user.id === id) {
    return c.json({ error: "Cannot ban yourself" }, 400);
  }

  if (!targetUser) {
    return c.json({ error: "User not found" }, 404);
  }

  if (!canManageTarget(c, targetUser.role)) {
    return c.json({ error: "Admins can only ban user-role accounts" }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  let reason: string | null = null;
  if (typeof body?.reason === "string" && body.reason.trim()) {
    reason = body.reason.trim().slice(0, 500);
  }

  let banExpires: number | null = null;
  if (body?.expiresInDays !== undefined && body.expiresInDays !== null) {
    const days = Number(body.expiresInDays);
    if (!Number.isFinite(days) || days <= 0 || days > 3650) {
      return c.json({ error: "expiresInDays must be a number between 1 and 3650" }, 400);
    }
    banExpires = Math.floor(Date.now() / 1000) + Math.floor(days * 24 * 60 * 60);
  }

  const result = getDb().run(
    'UPDATE "user" SET banned = 1, banReason = ?, banExpires = ? WHERE id = ?',
    [reason, banExpires, id]
  );
  if (result.changes === 0) {
    return c.json({ error: "User not found" }, 404);
  }

  // Revoke all sessions for banned user
  getDb().run("DELETE FROM session WHERE userId = ?", [id]);

  return c.json({ success: true, banReason: reason, banExpires });
});

// POST /:id/unban — re-enable user login
admin.post("/:id/unban", async (c) => {
  const { id } = c.req.param();

  const result = getDb().run(
    'UPDATE "user" SET banned = 0, banReason = NULL, banExpires = NULL WHERE id = ?',
    [id]
  );
  if (result.changes === 0) {
    return c.json({ error: "User not found" }, 404);
  }

  return c.json({ success: true });
});

// DELETE /:id — delete user and every artifact they own (SQLite rows,
// LanceDB vectors, on-disk files, running extensions, MCP clients).
admin.delete("/:id", async (c) => {
  const { id } = c.req.param();
  const session = c.get("session");
  const targetUser = getTargetUser(id);

  if (session.user.id === id) {
    return c.json({ error: "Cannot delete yourself" }, 400);
  }

  if (!targetUser) {
    return c.json({ error: "User not found" }, 404);
  }

  if (!canManageTarget(c, targetUser.role)) {
    return c.json({ error: "Admins can only delete user-role accounts" }, 403);
  }

  try {
    const report = await purgeUser(id);
    return c.json({ success: true, report });
  } catch (err: any) {
    console.error(`[users] purge failed for ${id}:`, err);
    return c.json({ error: err?.message || "Failed to delete user" }, 500);
  }
});

// Mount admin routes at the root of this router
app.route("/", admin);

export { app as usersRoutes };
