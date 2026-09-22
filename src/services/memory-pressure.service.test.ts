import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { releaseMemoryPressureResources } from "./memory-pressure.service";

beforeEach(() => closeDatabase());
afterEach(() => closeDatabase());

describe("memory pressure resources", () => {
  test("warning pressure releases resources without requiring a database", () => {
    expect(releaseMemoryPressureResources("warning")).toEqual([]);
  });

  test("critical pressure shrinks SQLite without closing or changing it", () => {
    initDatabase(":memory:");
    const db = getDb();
    db.run("CREATE TABLE pressure_probe (value TEXT NOT NULL)");
    db.query("INSERT INTO pressure_probe (value) VALUES (?)").run("still-open");

    expect(releaseMemoryPressureResources("critical")).toEqual([]);
    expect(db.query("SELECT value FROM pressure_probe").get()).toEqual({ value: "still-open" });
  });

  test("critical-only failures do not affect warning pressure", () => {
    const failures = releaseMemoryPressureResources("critical");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/^SQLite:/);
    expect(releaseMemoryPressureResources("warning")).toEqual([]);
  });
});
