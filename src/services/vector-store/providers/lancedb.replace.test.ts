import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fresh process per case so provider singletons and DATA_DIR cannot leak. The
// tables are real Lance tables; `replaceByFilter` runs the delete and the
// merge-insert under a single cross-process write-lock acquisition.
const fixture = `
  import assert from "node:assert/strict";
  const { andFilter, eq, inSet, ownerScope } = await import("./src/services/vector-store/addressing.ts");
  const provider = await import("./src/services/vector-store/providers/lancedb.ts");
  const store = new provider.LanceDbStore();
  const row = (id, owner, source, content) => ({
    id, user_id: "u1", source_type: "chat_chunk", source_id: source,
    owner_id: owner, chunk_index: 0, content, vector: [1, 0], metadata_json: "{}", updated_at: 1,
  });
`;

async function runCase(body: string): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "lance-replace-integration-"));
  try {
    const child = Bun.spawn({
      cmd: [process.execPath, "--eval", fixture + `
        try { ${body} } finally { await store.close(); }
      `],
      cwd: join(import.meta.dir, "../../../.."),
      env: { ...process.env, DATA_DIR: dataDir, LUMIVERSE_LANCEDB_CROSS_PROCESS_LOCK: "true" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(exitCode, stdout + stderr).toBe(0);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

describe("LanceDB atomic replace isolation", () => {
  test("replacing chat A leaves chat B and other source types untouched", async () => {
    await runCase(`
      await store.upsert("embeddings", [
        row("a1", "chatA", "a1", "A old candidate one"),
        row("a1b", "chatA", "a1b", "A old candidate two"),
        row("b1", "chatB", "b1", "B must survive"),
      ]);
      await store.upsert("embeddings_world_books", [{
        id: "wb1", user_id: "u1", source_type: "world_book_entry", source_id: "wb-entry",
        owner_id: "book1", chunk_index: 0, content: "world book row", vector: [1, 0],
        metadata_json: "{}", updated_at: 1,
      }]);

      const filter = andFilter([
        ownerScope("u1", "chat_chunk", "chatA"),
        inSet("source_id", ["a1", "a1b"]),
      ]);
      await store.replaceByFilter("embeddings", filter, [
        row("a1", "chatA", "a1", "A refreshed candidate one"),
        row("a2", "chatA", "a2", "A appended candidate"),
      ]);

      const chatA = await store.getRowsByFilter("embeddings", ownerScope("u1", "chat_chunk", "chatA"));
      assert.deepEqual(
        chatA.map((r) => r.id).sort(),
        ["a1", "a2"],
        "chat A should hold exactly the replacement ids",
      );
      assert.equal(
        chatA.find((r) => r.id === "a1").content,
        "A refreshed candidate one",
      );

      const chatB = await store.getRowsByFilter("embeddings", ownerScope("u1", "chat_chunk", "chatB"));
      assert.deepEqual(chatB.map((r) => r.id), ["b1"], "chat B must remain untouched");

      const worldBooks = await store.getRowsByFilter("embeddings_world_books", eq("user_id", "u1"));
      assert.deepEqual(worldBooks.map((r) => r.id), ["wb1"], "world-book rows must remain untouched");
    `);
  });

  test("replaceByFilter with empty rows deletes only the scoped chat", async () => {
    await runCase(`
      await store.upsert("embeddings", [
        row("a1", "chatA", "a1", "A to delete"),
        row("b1", "chatB", "b1", "B to keep"),
      ]);

      const filter = andFilter([
        ownerScope("u1", "chat_chunk", "chatA"),
        inSet("source_id", ["a1"]),
      ]);
      await store.replaceByFilter("embeddings", filter, []);

      const chatA = await store.getRowsByFilter("embeddings", ownerScope("u1", "chat_chunk", "chatA"));
      assert.equal(chatA.length, 0, "chat A rows should be gone");
      const chatB = await store.getRowsByFilter("embeddings", ownerScope("u1", "chat_chunk", "chatB"));
      assert.deepEqual(chatB.map((r) => r.id), ["b1"], "chat B must survive a delete-only replace");
      const all = await store.countRows("embeddings");
      assert.equal(all, 1, "only the intended row was removed");
    `);
  });
});
