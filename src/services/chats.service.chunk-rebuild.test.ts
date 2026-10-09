import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { runMigrations } from "../db/migrate";
import * as embeddingsSvc from "./embeddings.service";
import { resetChatPipelineCoordinatorForTests } from "./chat-pipeline-coordinator.service";
import { getChatChunks, rebuildChatChunksFromMessages } from "./chats.service";

const USER_ID = "chunk-order-user";
const CHAT_ID = "chunk-order-chat";

function seedChat(messageCount: number): void {
  const db = getDb();
  db.query(
    `INSERT INTO "user" (id, name, email, emailVerified)
     VALUES (?, 'Chunk Tester', 'chunks@example.test', 1)`,
  ).run(USER_ID);
  db.query(
    `INSERT INTO characters (id, user_id, name)
     VALUES ('chunk-character', ?, 'Chunk Character')`,
  ).run(USER_ID);
  db.query(
    `INSERT INTO chats (id, user_id, character_id, name, metadata, created_at, updated_at)
     VALUES (?, ?, 'chunk-character', 'Chunk Chat', '{}', 1, 1)`,
  ).run(CHAT_ID, USER_ID);

  for (let index = 0; index < messageCount; index++) {
    const messageId = `message-${index}`;
    const chunkId = `chunk-${index}`;
    db.query(
      `INSERT INTO messages (
         id, chat_id, index_in_chat, is_user, name, content, send_date,
         swipe_id, swipes, swipe_dates, extra, created_at, revision
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, '[]', '{}', 1, 1)`,
    ).run(
      messageId,
      CHAT_ID,
      index,
      index % 2,
      index % 2 ? "User" : "Character",
      `content-${index}`,
      index + 1,
      JSON.stringify([`content-${index}`]),
    );
    db.query(
      `INSERT INTO chat_chunks (
         id, chat_id, start_message_id, end_message_id, message_ids, content,
         token_count, message_count, message_range_start, message_range_end,
         created_at, updated_at, vectorized_at, cortex_warmup_signature
       ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, 100, 100, 100, 'warm')`,
    ).run(
      chunkId,
      CHAT_ID,
      messageId,
      messageId,
      JSON.stringify([messageId]),
      `content-${index}`,
      index,
      index,
    );
  }
}

describe("chat chunk rebuild ordering", () => {
  let configSpy: ReturnType<typeof spyOn>;
  let deleteEmbeddingsSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    closeDatabase();
    initDatabase(":memory:");
    await runMigrations(getDb());
    resetChatPipelineCoordinatorForTests();
    configSpy = spyOn(embeddingsSvc, "getEmbeddingConfig").mockResolvedValue({
      enabled: true,
      vectorize_chat_messages: true,
      model: "test-model",
      retrieval_top_k: 4,
      preferred_context_size: 6,
      similarity_threshold: 0,
      chat_memory_mode: null,
    } as any);
    deleteEmbeddingsSpy = spyOn(embeddingsSvc, "deleteChatChunkEmbeddings")
      .mockResolvedValue(undefined);
  });

  afterEach(async () => {
    configSpy.mockRestore();
    deleteEmbeddingsSpy.mockRestore();
    // Surgical rebuilds enqueue a debounced cache refresh. Let it drain while
    // the full test schema is still available and with normal disabled defaults.
    await Bun.sleep(120);
    resetChatPipelineCoordinatorForTests();
    closeDatabase();
  });

  test("orders same-second chunks by message position despite the DESC timestamp index", () => {
    seedChat(4);

    expect(getChatChunks(USER_ID, CHAT_ID).map((chunk) => chunk.id)).toEqual([
      "chunk-0",
      "chunk-1",
      "chunk-2",
      "chunk-3",
    ]);
  });

  test("coalesces overlapping deleted-message rebuilds to the earliest surgical boundary", async () => {
    seedChat(3);
    const db = getDb();

    db.query("DELETE FROM messages WHERE id = ?").run("message-2");
    const later = rebuildChatChunksFromMessages(USER_ID, CHAT_ID, ["message-2"]);
    db.query("DELETE FROM messages WHERE id = ?").run("message-1");
    const earlier = rebuildChatChunksFromMessages(USER_ID, CHAT_ID, ["message-1"]);

    await Promise.all([later, earlier]);

    expect(db.query(
      `SELECT id, cortex_warmup_signature
       FROM chat_chunks WHERE chat_id = ? ORDER BY message_range_start`,
    ).all(CHAT_ID)).toEqual([
      { id: "chunk-0", cortex_warmup_signature: "warm" },
    ]);
    expect(deleteEmbeddingsSpy).toHaveBeenCalledTimes(1);
    expect(deleteEmbeddingsSpy).toHaveBeenCalledWith(
      USER_ID,
      CHAT_ID,
      ["chunk-1", "chunk-2"],
    );
  });
});
