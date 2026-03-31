import { Hono } from "hono";
import { resolve, dirname, basename } from "path";
import { existsSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { requireOwner } from "../auth/middleware";
import { getDb } from "../db/connection";
import { scanSTData } from "../migration/st-reader";
import {
  executeMigration,
  isMigrationRunning,
  getActiveMigration,
  getLastMigration,
} from "../migration/st-migration.service";

const app = new Hono();

// All routes require owner or admin role
app.use("/*", requireOwner);

// ─── GET /browse — filesystem directory browser ─────────────────────────────

app.get("/browse", (c) => {
  const rawPath = c.req.query("path") || homedir();
  const resolved = resolve(rawPath);

  try {
    const stat = statSync(resolved);
    if (!stat.isDirectory()) {
      return c.json({ error: "Not a directory" }, 400);
    }
  } catch (err: any) {
    if (err.code === "ENOENT") return c.json({ error: "Directory not found" }, 404);
    if (err.code === "EACCES") return c.json({ error: "Permission denied" }, 403);
    return c.json({ error: "Cannot access path" }, 500);
  }

  try {
    const rawEntries = readdirSync(resolved);
    const entries: { name: string }[] = [];

    for (const name of rawEntries) {
      if (name.startsWith(".")) continue; // skip hidden
      try {
        const fullPath = resolve(resolved, name);
        if (statSync(fullPath).isDirectory()) {
          entries.push({ name });
        }
      } catch {
        // skip inaccessible entries
      }
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    const parent = resolved === "/" ? null : dirname(resolved);

    return c.json({ path: resolved, parent, entries });
  } catch (err: any) {
    if (err.code === "EACCES") return c.json({ error: "Permission denied" }, 403);
    return c.json({ error: "Failed to read directory" }, 500);
  }
});

// ─── POST /validate — validate SillyTavern installation ────────────────────

app.post("/validate", async (c) => {
  const body = await c.req.json();
  const rawPath = body.path;

  if (!rawPath || typeof rawPath !== "string") {
    return c.json({ error: "path is required" }, 400);
  }

  const resolved = resolve(rawPath);

  if (!existsSync(resolved)) {
    return c.json({ valid: false, error: "Directory does not exist" });
  }

  // Check for multi-user layout: data/{user}/characters/
  const dataDir = resolve(resolved, "data");
  if (existsSync(dataDir)) {
    try {
      const userDirs = readdirSync(dataDir).filter((name) => {
        if (name.startsWith(".")) return false;
        try {
          const userPath = resolve(dataDir, name);
          return statSync(userPath).isDirectory() && existsSync(resolve(userPath, "characters"));
        } catch {
          return false;
        }
      });

      if (userDirs.length > 0) {
        return c.json({
          valid: true,
          basePath: resolved,
          stUsers: userDirs,
          layout: "multi-user",
        });
      }
    } catch {
      // fall through to legacy check
    }
  }

  // Check for legacy layout: public/characters/
  const legacyChars = resolve(resolved, "public", "characters");
  if (existsSync(legacyChars)) {
    return c.json({
      valid: true,
      basePath: resolved,
      stUsers: [],
      layout: "legacy",
    });
  }

  return c.json({ valid: false, error: "No SillyTavern data found at this path" });
});

// ─── POST /scan — preview available data ────────────────────────────────────

app.post("/scan", async (c) => {
  const body = await c.req.json();
  const dataDir = body.dataDir;

  if (!dataDir || typeof dataDir !== "string") {
    return c.json({ error: "dataDir is required" }, 400);
  }

  const resolved = resolve(dataDir);
  if (!existsSync(resolved)) {
    return c.json({ error: "Directory does not exist" }, 404);
  }

  const counts = await scanSTData(resolved);
  return c.json(counts);
});

// ─── POST /execute — start migration ────────────────────────────────────────

app.post("/execute", async (c) => {
  if (isMigrationRunning()) {
    return c.json({ error: "A migration is already in progress" }, 409);
  }

  const body = await c.req.json();
  const { dataDir, targetUserId, scope } = body;

  if (!dataDir || typeof dataDir !== "string") {
    return c.json({ error: "dataDir is required" }, 400);
  }
  if (!targetUserId || typeof targetUserId !== "string") {
    return c.json({ error: "targetUserId is required" }, 400);
  }
  if (!scope || typeof scope !== "object") {
    return c.json({ error: "scope is required" }, 400);
  }

  const resolved = resolve(dataDir);
  if (!existsSync(resolved)) {
    return c.json({ error: "Data directory does not exist" }, 404);
  }

  // Permission enforcement
  const callerUserId = c.get("userId");
  const callerRole = c.get("session")?.user?.role;

  if (callerRole === "owner") {
    // Owner can only migrate to themselves
    if (targetUserId !== callerUserId) {
      return c.json({ error: "Owner can only migrate to their own account" }, 403);
    }
  } else if (callerRole === "admin") {
    // Admin can migrate to self or user-role accounts
    if (targetUserId !== callerUserId) {
      const targetUser = getDb()
        .query('SELECT id, role FROM "user" WHERE id = ?')
        .get(targetUserId) as { id: string; role: string } | null;

      if (!targetUser) {
        return c.json({ error: "Target user not found" }, 404);
      }
      if (targetUser.role === "owner" || targetUser.role === "admin") {
        return c.json({ error: "Admins can only migrate to their own account or user-role accounts" }, 403);
      }
    }
  }

  const migrationId = crypto.randomUUID();

  // Run migration asynchronously — return immediately
  executeMigration(migrationId, callerUserId, targetUserId, resolved, {
    characters: !!scope.characters,
    worldBooks: !!scope.worldBooks,
    personas: !!scope.personas,
    chats: !!scope.chats,
    groupChats: !!scope.groupChats,
  });

  return c.json({ migrationId }, 202);
});

// ─── GET /status — check migration status ───────────────────────────────────

app.get("/status", (c) => {
  const active = getActiveMigration();
  if (active) {
    return c.json({
      status: "running",
      migrationId: active.migrationId,
      phase: active.phase,
      startedAt: active.startedAt,
    });
  }

  const last = getLastMigration();
  if (last) {
    return c.json({
      status: last.error ? "failed" : "completed",
      migrationId: last.migrationId,
      phase: last.phase,
      startedAt: last.startedAt,
      results: last.results,
      error: last.error,
    });
  }

  return c.json({ status: "idle" });
});

export { app as stMigrationRoutes };
