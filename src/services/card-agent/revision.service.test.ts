import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../../db/connection";
import { runMigrations } from "../../db/migrate";
import * as characters from "../characters.service";
import * as revisions from "./revision.service";
import * as proposals from "./proposal.service";

let characterId: string;

beforeEach(async () => {
  closeDatabase();
  await runMigrations(initDatabase(":memory:"));
  getDb().run("INSERT INTO user(id,name,email) VALUES(?,?,?)", ["owner", "owner", "owner@example.test"]);
  getDb().run("INSERT INTO user(id,name,email) VALUES(?,?,?)", ["other", "other", "other@example.test"]);
  characterId = characters.createCharacter("owner", {
    name: "Aria",
    description: "A courier.",
    personality: "Terse.",
    tags: ["sci-fi"],
  }).id;
});

afterEach(() => {
  closeDatabase();
});

describe("revisions", () => {
  test("records the pre-change state so the first write is reversible", () => {
    const before = characters.getCharacter("owner", characterId)!;
    const { character } = revisions.applyRevisionedUpdate("owner", characterId, { description: "Changed." });

    expect(character.description).toBe("Changed.");
    const history = revisions.listRevisions("owner", characterId);
    expect(history).toHaveLength(1);
    expect(history[0].revision_number).toBe(1);
    expect(history[0].origin).toBe("agent");

    const snapshot = revisions.getRevision("owner", characterId, history[0].id)!;
    expect(snapshot.snapshot.description).toBe(before.description);
  });

  test("revert restores content and is itself undoable", () => {
    revisions.applyRevisionedUpdate("owner", characterId, { description: "v2" });
    revisions.applyRevisionedUpdate("owner", characterId, { description: "v3" });

    const history = revisions.listRevisions("owner", characterId);
    // Newest first: the snapshot holding "v2" is the pre-v3 revision.
    const preV3 = history.find((r) => r.revision_number === 2)!;
    const restored = revisions.revertToRevision("owner", characterId, preV3.id);
    expect(restored.character.description).toBe("v2");

    // The revert added a revision rather than consuming one: revisions 1 and 2
    // hold the two pre-change snapshots, revision 3 holds the pre-revert state.
    const after = revisions.listRevisions("owner", characterId);
    expect(after).toHaveLength(3);
    const revertRevision = after.find((r) => r.revision_number === 3)!;
    expect(revertRevision.origin).toBe("revert");
    const revertSnapshot = revisions.getRevision("owner", characterId, revertRevision.id)!;
    expect(revertSnapshot.snapshot.description).toBe("v3");
  });

  test("content hash is stable across key order and moves when content changes", () => {
    const a = characters.getCharacter("owner", characterId)!;
    const b = characters.getCharacter("owner", characterId)!;
    expect(revisions.characterContentHash(a)).toBe(revisions.characterContentHash(b));

    characters.updateCharacter("owner", characterId, { description: "different" });
    const c = characters.getCharacter("owner", characterId)!;
    expect(revisions.characterContentHash(c)).not.toBe(revisions.characterContentHash(a));
  });

  test("revisions are scoped to their owner", () => {
    revisions.applyRevisionedUpdate("owner", characterId, { description: "Changed." });
    expect(revisions.listRevisions("other", characterId)).toHaveLength(0);
    expect(revisions.getRevision("other", characterId, 1)).toBeNull();
  });
});

describe("proposals", () => {
  test("filing a proposal does not touch the character", () => {
    const before = characters.getCharacter("owner", characterId)!;
    const proposal = proposals.createProposal("owner", {
      characterId,
      changes: { description: { from: before.description, to: "New description." } },
      rationale: "Tighten the opening line.",
    });

    expect(proposal.status).toBe("pending");
    expect(characters.getCharacter("owner", characterId)!.description).toBe(before.description);
  });

  test("applying writes the change and links the resulting revision", () => {
    const before = characters.getCharacter("owner", characterId)!;
    const proposal = proposals.createProposal("owner", {
      characterId,
      changes: { description: { from: before.description, to: "New description." } },
    });

    const result = proposals.applyProposal("owner", proposal.id);
    expect(result.character.description).toBe("New description.");
    expect(result.proposal.status).toBe("applied");
    expect(result.proposal.applied_revision_id).toBe(result.revision.id);

    const snapshot = revisions.getRevision("owner", characterId, result.revision.id)!;
    expect(snapshot.snapshot.description).toBe(before.description);
  });

  test("a proposal is refused once the card has moved on", () => {
    const before = characters.getCharacter("owner", characterId)!;
    const proposal = proposals.createProposal("owner", {
      characterId,
      changes: { description: { from: before.description, to: "Agent version." } },
    });

    // Simulate the user editing the card after the proposal was filed.
    characters.updateCharacter("owner", characterId, { description: "User version." });

    expect(() => proposals.applyProposal("owner", proposal.id)).toThrow(
      revisions.StaleCharacterError,
    );
    // The user's edit survives.
    expect(characters.getCharacter("owner", characterId)!.description).toBe("User version.");
    expect(proposals.getProposal("owner", proposal.id)!.status).toBe("stale");
  });

  test("rejected proposals never apply", () => {
    const before = characters.getCharacter("owner", characterId)!;
    const proposal = proposals.createProposal("owner", {
      characterId,
      changes: { personality: { from: before.personality, to: "Warmer." } },
    });

    proposals.rejectProposal("owner", proposal.id);
    expect(() => proposals.applyProposal("owner", proposal.id)).toThrow(/rejected/);
    expect(characters.getCharacter("owner", characterId)!.personality).toBe(before.personality);
  });

  test("unknown fields and empty changesets are refused", () => {
    const before = characters.getCharacter("owner", characterId)!;

    expect(() =>
      proposals.createProposal("owner", {
        characterId,
        changes: { not_a_field: { from: "", to: "x" } },
      }),
    ).toThrow(/Unknown card field/);

    expect(() => proposals.createProposal("owner", { characterId, changes: {} })).toThrow(
      /at least one field/,
    );

    // A list field must stay a list.
    expect(() =>
      proposals.createProposal("owner", {
        characterId,
        changes: { tags: { from: before.tags, to: "not-a-list" } },
      }),
    ).toThrow(/must be a list/);
  });

  test("describeProposal reports the live value, not the agent's claim", () => {
    const before = characters.getCharacter("owner", characterId)!;
    const proposal = proposals.createProposal("owner", {
      characterId,
      changes: { description: { from: "STALE CLAIM", to: "New description." } },
    });

    const diff = proposals.describeProposal("owner", proposal);
    const field = diff.fields.find((f) => f.field === "description")!;
    expect(field.from).toBe(before.description);
    expect(field.to).toBe("New description.");
    expect(field.changed).toBe(true);
    expect(diff.stale).toBe(false);
  });

  test("batch apply skips stale proposals instead of aborting the pass", () => {
    const fresh = characters.createCharacter("owner", { name: "Bram", description: "Original." }).id;
    const shared = characters.createCharacter("owner", { name: "Cy", description: "Original." }).id;

    const p1 = proposals.createProposal("owner", {
      characterId,
      changes: { description: { from: "", to: "Applied." } },
    });
    proposals.createProposal("owner", {
      characterId: fresh,
      changes: { description: { from: "Original.", to: "Applied." } },
    });
    // Invalidate the third proposal after it is filed.
    proposals.createProposal("owner", {
      characterId: shared,
      changes: { description: { from: "Original.", to: "Applied." } },
    });
    characters.updateCharacter("owner", shared, { description: "Moved on." });

    const result = proposals.applyProposalBatch("owner", {});
    expect(result.applied).toBe(2);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].characterId).toBe(shared);

    expect(characters.getCharacter("owner", characterId)!.description).toBe("Applied.");
    expect(characters.getCharacter("owner", fresh)!.description).toBe("Applied.");
    expect(characters.getCharacter("owner", shared)!.description).toBe("Moved on.");

    // Both applied proposals remain linked to real revisions.
    expect(proposals.getProposal("owner", p1.id)!.status).toBe("applied");
  });

  test("deleting a session rejects its pending proposals", () => {
    const proposal = proposals.createProposal("owner", {
      characterId,
      changes: { description: { from: "", to: "x" } },
      sessionId: "session-1",
    });

    proposals.rejectProposalsForSession("owner", "session-1");
    expect(proposals.getProposal("owner", proposal.id)!.status).toBe("rejected");
  });

  test("proposals are scoped to their owner", () => {
    const proposal = proposals.createProposal("owner", {
      characterId,
      changes: { description: { from: "", to: "x" } },
    });
    expect(proposals.getProposal("other", proposal.id)).toBeNull();
    expect(() => proposals.applyProposal("other", proposal.id)).toThrow(/not found/);
  });
});