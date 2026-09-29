import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../../db/connection";
import { runMigrations } from "../../db/migrate";
import * as characters from "../characters.service";
import * as proposals from "./proposal.service";
import { executeCardAgentTool, type CardAgentToolContext } from "./tools.service";

let characterId: string;
let otherCharacterId: string;
let ctx: CardAgentToolContext;

function context(scope: string[] | null): CardAgentToolContext {
  return { userId: "owner", sessionId: "session-1", scope };
}

beforeEach(async () => {
  closeDatabase();
  await runMigrations(initDatabase(":memory:"));
  getDb().run("INSERT INTO user(id,name,email) VALUES(?,?,?)", ["owner", "owner", "owner@example.test"]);
  getDb().run("INSERT INTO user(id,name,email) VALUES(?,?,?)", ["other", "other", "other@example.test"]);

  characterId = characters.createCharacter("owner", {
    name: "Aria Vance",
    description: "A courier running contraband across the belt.",
    personality: "Terse, unsentimental.",
    tags: ["sci-fi", "courier"],
  }).id;
  otherCharacterId = characters.createCharacter("owner", {
    name: "Bram Okafor",
    description: "A dock foreman with debts.",
    tags: ["sci-fi"],
  }).id;
  characters.createCharacter("other", { name: "Not Yours", description: "Another user's card." });

  ctx = context(null);
});

afterEach(() => {
  closeDatabase();
});

describe("search_cards", () => {
  test("returns summaries, never full card text", async () => {
    const result = await executeCardAgentTool(ctx, "search_cards", { query: "Aria" });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("Aria Vance");
    expect(result.content).toContain(characterId);
    // The long description is reduced to a preview, not returned whole.
    expect(result.content).toContain("A courier");
  });

  test("filters by tag", async () => {
    const result = await executeCardAgentTool(ctx, "search_cards", { tags: ["courier"] });
    expect(result.content).toContain("Aria Vance");
    expect(result.content).not.toContain("Bram Okafor");
  });

  test("never surfaces another user's cards", async () => {
    const result = await executeCardAgentTool(ctx, "search_cards", {});
    expect(result.content).not.toContain("Not Yours");
  });
});

describe("read_card", () => {
  test("returns the full card when no sections are given", async () => {
    const result = await executeCardAgentTool(ctx, "read_card", { characterId });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("A courier running contraband");
    expect(result.content).toContain("Terse, unsentimental.");
  });

  test("honours a section subset", async () => {
    const result = await executeCardAgentTool(ctx, "read_card", {
      characterId,
      sections: ["personality"],
    });
    expect(result.content).toContain("Terse, unsentimental.");
    expect(result.content).not.toContain("A courier running contraband");
  });

  test("refuses a character outside the session scope", async () => {
    const scoped = context([characterId]);
    const result = await executeCardAgentTool(scoped, "read_card", { characterId: otherCharacterId });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("outside this session's scope");
  });

  test("cannot read another user's card even by id", async () => {
    const foreign = characters.findCharactersByName("other", "Not Yours")[0];
    const result = await executeCardAgentTool(ctx, "read_card", { characterId: foreign.id });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("No such character");
  });
});

describe("find_similar_cards", () => {
  test("finds same-name cards and honours the exclusion", async () => {
    const duplicate = characters.createCharacter("owner", { name: "Aria Vance", description: "Copy." }).id;

    const found = await executeCardAgentTool(ctx, "find_similar_cards", { name: "Aria Vance" });
    expect(found.ok).toBe(true);
    expect(found.content).toContain(duplicate);

    const excluded = await executeCardAgentTool(ctx, "find_similar_cards", {
      name: "Aria Vance",
      excludeCharacterId: duplicate,
    });
    expect(excluded.content).not.toContain(duplicate);
  });
});

describe("list_tags", () => {
  test("reports tag counts", async () => {
    const result = await executeCardAgentTool(ctx, "list_tags", {});
    expect(result.ok).toBe(true);
    expect(result.content).toContain("sci-fi");
  });
});

describe("propose_card_edit", () => {
  test("files a proposal without modifying the card", async () => {
    const before = characters.getCharacter("owner", characterId)!;
    const result = await executeCardAgentTool(ctx, "propose_card_edit", {
      characterId,
      changes: { personality: { from: before.personality, to: "Warmer, more talkative." } },
      rationale: "Soften the flat affect.",
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("nothing has been modified yet");
    expect(characters.getCharacter("owner", characterId)!.personality).toBe(before.personality);

    const pending = proposals.listProposals("owner", { status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0].session_id).toBe("session-1");
  });

  test("reports a rejected proposal as a tool error the model can correct", async () => {
    const result = await executeCardAgentTool(ctx, "propose_card_edit", {
      characterId,
      changes: { bogus_field: { from: "", to: "x" } },
    });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("Unknown card field");
    expect(proposals.listProposals("owner", { status: "pending" })).toHaveLength(0);
  });

  test("refuses to propose against a character outside scope", async () => {
    const scoped = context([characterId]);
    const result = await executeCardAgentTool(scoped, "propose_card_edit", {
      characterId: otherCharacterId,
      changes: { personality: { from: "", to: "x" } },
    });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("outside this session's scope");
  });
});

describe("unknown tools", () => {
  test("returns an error result rather than throwing", async () => {
    const result = await executeCardAgentTool(ctx, "delete_everything", {});
    expect(result.ok).toBe(false);
    expect(result.content).toContain("Unknown tool");
  });

  test("the tool set contains no write tool", async () => {
    const { CARD_AGENT_TOOL_DEFINITIONS } = await import("./tools.service");
    const names = CARD_AGENT_TOOL_DEFINITIONS.map((t) => t.name);
    expect(names).toContain("propose_card_edit");
    for (const forbidden of ["update_card", "edit_card", "apply_proposal", "delete_card", "create_card"]) {
      expect(names).not.toContain(forbidden);
    }
  });
});