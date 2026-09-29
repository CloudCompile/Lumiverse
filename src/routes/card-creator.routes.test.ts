import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { runMigrations } from "../db/migrate";
import * as characters from "../services/characters.service";
import * as proposals from "../services/card-agent/proposal.service";
import { cardCreatorRoutes } from "./card-creator.routes";

let app: Hono;
let characterId: string;

function request(method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(async () => {
  closeDatabase();
  await runMigrations(initDatabase(":memory:"));
  getDb().run("INSERT INTO user(id,name,email) VALUES(?,?,?)", ["owner", "owner", "owner@example.test"]);
  characterId = characters.createCharacter("owner", {
    name: "Aria",
    description: "A courier.",
  }).id;

  app = new Hono();
  app.use("*", async (c, next) => {
    c.set("userId", "owner");
    await next();
  });
  app.route("/api/v1/card-creator", cardCreatorRoutes);
});

afterEach(() => {
  closeDatabase();
});

describe("card creator routes", () => {
  test("creator is seeded on demand and stays out of the library", async () => {
    const res = await request("GET", "/api/v1/card-creator/creator");
    expect(res.status).toBe(200);
    const { character } = (await res.json()) as { character: { id: string; kind: string } };
    expect(character.kind).toBe("card_creator");

    // A second call returns the same row rather than creating another.
    const again = await request("GET", "/api/v1/card-creator/creator");
    const second = (await again.json()) as { character: { id: string } };
    expect(second.character.id).toBe(character.id);

    const listed = characters.listCharacterSummaries("owner", { limit: 50, offset: 0 });
    expect(listed.data.some((c) => c.id === character.id)).toBe(false);
  });

  test("proposals are scoped to the chat they were filed in", async () => {
    proposals.createProposal("owner", {
      characterId,
      chatId: "chat-a",
      changes: { description: { from: "A courier.", to: "Tightened." } },
    });
    proposals.createProposal("owner", {
      characterId,
      chatId: "chat-b",
      changes: { description: { from: "A courier.", to: "Other chat." } },
    });

    const res = await request("GET", "/api/v1/card-creator/proposals?chatId=chat-a");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: number; chat_id: string; diff?: unknown }>;
    expect(body).toHaveLength(1);
    expect(body[0].chat_id).toBe("chat-a");
    // The detail response is diff-annotated so the inline card can render it.
    expect(body[0].diff).toBeDefined();
  });

  test("chatId is required when listing", async () => {
    const res = await request("GET", "/api/v1/card-creator/proposals");
    expect(res.status).toBe(400);
  });

  test("applying a chat proposal writes the card and records a revision", async () => {
    const proposal = proposals.createProposal("owner", {
      characterId,
      chatId: "chat-a",
      changes: { description: { from: "A courier.", to: "Tightened." } },
    });

    const res = await request("POST", `/api/v1/card-creator/proposals/${proposal.id}/apply`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { character: { description: string }; revision: { id: number } };
    expect(body.character.description).toBe("Tightened.");
    expect(body.revision.id).toBeGreaterThan(0);
  });

  test("applying a stale proposal returns 409", async () => {
    const proposal = proposals.createProposal("owner", {
      characterId,
      chatId: "chat-a",
      changes: { description: { from: "A courier.", to: "Agent version." } },
    });
    characters.updateCharacter("owner", characterId, { description: "User version." });

    const res = await request("POST", `/api/v1/card-creator/proposals/${proposal.id}/apply`);
    expect(res.status).toBe(409);
  });

  test("rejecting leaves the card untouched and drops it from the queue", async () => {
    const proposal = proposals.createProposal("owner", {
      characterId,
      chatId: "chat-a",
      changes: { description: { from: "A courier.", to: "Nope." } },
    });

    const res = await request("POST", `/api/v1/card-creator/proposals/${proposal.id}/reject`);
    expect(res.status).toBe(200);
    expect(characters.getCharacter("owner", characterId)!.description).toBe("A courier.");

    const pending = await request("GET", "/api/v1/card-creator/proposals?chatId=chat-a&status=pending");
    expect((await pending.json()) as unknown[]).toHaveLength(0);
  });

  test("a non-numeric proposal id is rejected rather than coerced", async () => {
    const res = await request("GET", "/api/v1/card-creator/proposals/not-a-number");
    expect(res.status).toBe(400);
  });

  test("the card creator cannot be deleted", async () => {
    const res = await request("GET", "/api/v1/card-creator/creator");
    const { character } = (await res.json()) as { character: { id: string } };
    expect(characters.deleteCharacter("owner", character.id)).toBe(false);
    expect(characters.getCardCreator("owner")).not.toBeNull();
  });
});
