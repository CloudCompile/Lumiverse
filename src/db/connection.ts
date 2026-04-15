import { Database } from "bun:sqlite";
import { env } from "../env";
import { mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import { applyBaseDatabasePragmas } from "./maintenance";

let db: Database | null = null;
let dbPathResolved: string | null = null;

export function initDatabase(path?: string): Database {
  if (db) return db;

  const dbPath = path || `${env.dataDir}/lumiverse.db`;
  dbPathResolved = dbPath;
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);
  applyBaseDatabasePragmas(db);

  return db;
}

export function getDb(): Database {
  if (!db) throw new Error("Database not initialized. Call initDatabase() first.");
  return db;
}

export function getDatabasePath(): string {
  return dbPathResolved || `${env.dataDir}/lumiverse.db`;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
  dbPathResolved = null;
}
