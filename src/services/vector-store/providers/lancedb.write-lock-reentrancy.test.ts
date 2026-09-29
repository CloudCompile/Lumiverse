/**
 * Regression test for the same-PID LanceDB write-lock deadlock.
 *
 * Production symptom (2h46m lock, never released):
 *
 *   [embeddings] Cross-process LanceDB write lock acquisition timed out after 120000ms.
 *   lock=/app/data/.lancedb-write-lock
 *   ownerPid=26 ... currentPid=26
 *
 * Root cause: a write-locked operation (world-book vector commit) invokes a
 * deletion that also takes the write lock. The in-process mutex cannot see the
 * reentrancy, so the nested call queued behind its own caller and then tried to
 * re-acquire the cross-process lock the process already held.
 *
 * These cases run in a child process (fresh module singletons + DATA_DIR) and
 * use real LanceDB tables, mirroring the existing manifest integration test.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture = `
  import assert from "node:assert/strict";
  import { existsSync } from "node:fs";
  import { basename, dirname, join } from "node:path";
  const provider = await import("./src/services/vector-store/providers/lancedb.ts");
  const { LANCEDB_PATH } = provider;
  const lockDir = join(dirname(LANCEDB_PATH), "." + basename(LANCEDB_PATH) + "-write-lock");
  const store = new provider.LanceDbStore();
`;

async function runCase(body: string): Promise<{ exitCode: number; output: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), "lance-reentrancy-"));
  try {
    const child = Bun.spawn({
      cmd: [process.execPath, "--eval", fixture + body],
      cwd: join(import.meta.dir, "../../../.."),
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        LUMIVERSE_LANCEDB_CROSS_PROCESS_LOCK: "true",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, output: stdout + stderr };
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

describe("LanceDB write-lock reentrancy", () => {
  test("a write-locked operation can delete rows without self-deadlocking", async () => {
    const { exitCode, output } = await runCase(`
      const row = (id, sourceId) => ({
        id, user_id: "u1", source_type: "world_book_entry", source_id: sourceId,
        owner_id: "wb1", chunk_index: 0, content: "entry " + sourceId,
        vector: [1, 0], metadata_json: "{}", updated_at: 1,
      });

      // Seed two world-book rows behind a normal lock acquisition.
      await provider.upsertEmbeddingRows([row("a", "e1"), row("b", "e2")], "seed");

      // The deadlock shape: take the write lock, then call deleteByFilter from
      // INSIDE the held critical section. Before the fix this queued behind
      // itself and re-acquired the cross-process lock -> 120s timeout.
      await provider.withWriteLock(async () => {
        await store.deleteByFilter("embeddings_world_books", {
          op: "and",
          clauses: [
            { op: "eq", field: "user_id", value: "u1" },
            { op: "eq", field: "source_type", value: "world_book_entry" },
            { op: "in", field: "source_id", values: ["e2"] },
          ],
        });
        // Nested calls that reach the provider directly (the other path that
        // previously re-acquired the lock).
        await provider.withWriteLock(async () => {
          await provider.withWriteLock(async () => {});
        }, "nested");
      }, "world book commit");

      // e2 deleted, e1 untouched.
      const table = await provider.getTableIfExists("embeddings_world_books");
      const remaining = await table.query().select(["source_id"]).toArray();
      const ids = remaining.map((r) => r.source_id).sort();
      assert.deepEqual(ids, ["e1"], "only the targeted row should be deleted; got " + JSON.stringify(ids));

      // The lock must be released and reclaimable by another task afterward.
      await provider.withWriteLock(async () => {}, "after");
      assert(!existsSync(lockDir), "cross-process lock should be released after the critical section");
      console.log("REENTRANCY_OK");
    `);
    expect(exitCode, output).toBe(0);
    expect(output).toContain("REENTRANCY_OK");
  }, 40_000);

  test("an orphaned own-process lock is reclaimed instead of blocking for 120s", async () => {
    const { exitCode, output } = await runCase(`
      // Simulate a lock left on disk by this still-running process (e.g. a
      // critical section that exited without cleanup). owner.json names our PID
      // with a fresh timestamp, so the stale check alone would NOT reclaim it.
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(join(lockDir, "owner.json"), JSON.stringify({
        pid: process.pid, acquiredAt: Date.now(), cwd: process.cwd(),
      }));

      const startedAt = Date.now();
      await provider.withWriteLock(async () => {}, "reclaim orphan");
      const elapsed = Date.now() - startedAt;
      // Must reclaim quickly, not wait out the 120s acquisition timeout.
      assert(elapsed < 20_000, "reclaim took too long: " + elapsed + "ms");
      assert(!existsSync(lockDir), "reclaimed lock should be gone after release");
      console.log("RECLAIM_OK elapsed=" + elapsed);
    `);
    expect(exitCode, output).toBe(0);
    expect(output).toContain("RECLAIM_OK");
  }, 40_000);
});
