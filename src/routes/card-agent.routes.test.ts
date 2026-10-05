import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { runMigrations } from "../db/migrate";
import * as characters from "../services/characters.service";
import * as proposals from "../services/card-agent/proposal.service";
import { cardAgentRoutes } from "./card-agent.routes";

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
    tags: ["sci-fi"],
  }).id;

  // The route module reads the caller from context; stand in for requireAuth.
  app = new Hono();
  app.use("*", async (c, next) => {
    c.set("userId", "owner");
    await next();
  });
  app.route("/api/v1/card-agent", cardAgentRoutes);
});

afterEach(() => {
  closeDatabase();
});

describe("proposal routes", () => {
  test("list reports a diff against the live card", async () => {
    proposals.createProposal("owner", {
      characterId,
      changes: { description: { from: "STALE", to: "Tightened." } },
    });

    const res = await request("GET", "/api/v1/card-agent/proposals?status=pending");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ diff: { fields: Array<{ field: string; from: unknown }> } }>;
    expect(body).toHaveLength(1);
    const field = body[0].diff.fields.find((f) => f.field === "description")!;
    expect(field.from).toBe("A courier.");
  });

  test("applying returns the updated character and its revision", async () => {
    const proposal = proposals.createProposal("owner", {
      characterId,
      changes: { description: { from: "A courier.", to: "Tightened." } },
    });

    const res = await request("POST", `/api/v1/card-agent/proposals/${proposal.id}/apply`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { character: { description: string }; revision: { id: number } };
    expect(body.character.description).toBe("Tightened.");
    expect(body.revision.id).toBeGreaterThan(0);
  });

  test("applying a stale proposal returns 409, not 400", async () => {
    const proposal = proposals.createProposal("owner", {
      characterId,
      changes: { description: { from: "A courier.", to: "Agent version." } },
    });
    characters.updateCharacter("owner", characterId, { description: "User version." });

    const res = await request("POST", `/api/v1/card-agent/proposals/${proposal.id}/apply`);
    expect(res.status).toBe(409);
  });

  test("apply-batch is routed as a literal, not captured as an id", async () => {
    proposals.createProposal("owner", {
      characterId,
      changes: { description: { from: "A courier.", to: "Applied." } },
    });

    const res = await request("POST", "/api/v1/card-agent/proposals/apply-batch", {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { applied: number };
    expect(body.applied).toBe(1);
    expect(characters.getCharacter("owner", characterId)!.description).toBe("Applied.");
  });

  test("a non-numeric proposal id is rejected rather than coerced", async () => {
    const res = await request("GET", "/api/v1/card-agent/proposals/not-a-number");
    expect(res.status).toBe(400);
  });

  test("rejecting a proposal leaves the card untouched", async () => {
    const proposal = proposals.createProposal("owner", {
      characterId,
      changes: { description: { from: "A courier.", to: "Nope." } },
    });

    const res = await request("POST", `/api/v1/card-agent/proposals/${proposal.id}/reject`);
    expect(res.status).toBe(200);
    expect(characters.getCharacter("owner", characterId)!.description).toBe("A courier.");
  });
});

describe("revision routes", () => {
  test("history round-trips and revert restores an earlier state", async () => {
    const { applyRevisionedUpdate } = await import("../services/card-agent/revision.service");
    applyRevisionedUpdate("owner", characterId, { description: "v2" });
    applyRevisionedUpdate("owner", characterId, { description: "v3" });

    const listRes = await request("GET", `/api/v1/card-agent/characters/${characterId}/revisions`);
    expect(listRes.status).toBe(200);
    const revisions = (await listRes.json()) as Array<{ id: number; revision_number: number }>;
    expect(revisions.length).toBe(2);

    const preV3 = revisions.find((r) => r.revision_number === 2)!;
    const revertRes = await request(
      "POST",
      `/api/v1/card-agent/characters/${characterId}/revisions/${preV3.id}/revert`,
    );
    expect(revertRes.status).toBe(200);
    const body = (await revertRes.json()) as { character: { description: string } };
    expect(body.character.description).toBe("v2");
  });

  test("a revision belonging to another card is not found", async () => {
    const { applyRevisionedUpdate } = await import("../services/card-agent/revision.service");
    applyRevisionedUpdate("owner", characterId, { description: "v2" });
    const other = characters.createCharacter("owner", { name: "Other" }).id;

    const res = await request("GET", `/api/v1/card-agent/characters/${other}/revisions/1`);
    expect(res.status).toBe(404);
  });
});

describe("session routes", () => {
  test("a session can be created, listed, and deleted", async () => {
    const createRes = await request("POST", "/api/v1/card-agent/sessions", {
      title: "Editor",
      connectionId: null,
      scopeMode: "all",
    });
    expect(createRes.status).toBe(201);
    const session = (await createRes.json()) as { id: string; title: string };
    expect(session.title).toBe("Editor");

    const listRes = await request("GET", "/api/v1/card-agent/sessions");
    expect((await listRes.json()) as unknown[]).toHaveLength(1);

    const deleteRes = await request("DELETE", `/api/v1/card-agent/sessions/${session.id}`);
    expect(deleteRes.status).toBe(200);
    expect((await (await request("GET", "/api/v1/card-agent/sessions")).json()) as unknown[]).toHaveLength(0);
  });

  test("unknown sessions 404 on read", async () => {
    const res = await request("GET", "/api/v1/card-agent/sessions/does-not-exist/messages");
    expect(res.status).toBe(404);
  });

  test("deleting a session clears its pending proposals", async () => {
    const session = (await (
      await request("POST", "/api/v1/card-agent/sessions", { title: "S" })
    ).json()) as { id: string };
    proposals.createProposal("owner", {
      characterId,
      sessionId: session.id,
      changes: { description: { from: "A courier.", to: "x" } },
    });

    await request("DELETE", `/api/v1/card-agent/sessions/${session.id}`);
    const res = await request("GET", `/api/v1/card-agent/sessions/${session.id}/proposals`);
    // The session is gone, so the scoped listing 404s rather than showing them.
    expect(res.status).toBe(404);
    expect(proposals.listProposals("owner", { status: "pending" })).toHaveLength(0);
  });
});