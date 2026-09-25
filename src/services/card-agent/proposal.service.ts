import { getDb } from "../../db/connection";
import * as charactersSvc from "../characters.service";
import type { Character, UpdateCharacterInput } from "../../types/character";
import {
  REVISION_FIELDS,
  StaleCharacterError,
  applyRevisionedUpdate,
  characterContentHash,
  recordRevision,
  snapshotCharacter,
  type CharacterSnapshot,
  type CharacterRevision,
} from "./revision.service";

/**
 * Human-approved edit proposals.
 *
 * The agent never writes to a character. It files proposals here; a proposal
 * becomes a real edit only when the user applies it. This module owns that
 * boundary.
 */

export type ProposalStatus = "pending" | "applied" | "rejected" | "stale";

/** A single field change. `from` is the value the agent saw, `to` is the proposal. */
export interface FieldChange {
  from: unknown;
  to: unknown;
}

export type ProposalChanges = Record<string, FieldChange>;

export interface EditProposal {
  id: number;
  character_id: string;
  character_name: string;
  session_id: string | null;
  chat_id: string | null;
  changes: ProposalChanges;
  rationale: string | null;
  status: ProposalStatus;
  base_content_hash: string;
  base_updated_at: number | null;
  applied_revision_id: number | null;
  created_at: number;
  resolved_at: number | null;
}

interface ProposalRow {
  id: number;
  character_id: string;
  character_name: string;
  session_id: string | null;
  chat_id: string | null;
  changes: string;
  rationale: string | null;
  status: string;
  base_content_hash: string;
  base_updated_at: number | null;
  applied_revision_id: number | null;
  created_at: number;
  resolved_at: number | null;
}

function toProposal(row: ProposalRow): EditProposal {
  return {
    ...row,
    changes: JSON.parse(row.changes) as ProposalChanges,
    status: row.status as ProposalStatus,
  };
}

/**
 * Reject change sets that touch anything outside the known card fields, or that
 * are empty.
 *
 * This is a trust boundary: `changes` arrives from a model. An unknown key
 * would be silently dropped by `updateCharacter`, but validating here means the
 * proposal record is honest about what it would do rather than carrying a
 * change that can never apply.
 */
export function validateChanges(
  changes: ProposalChanges,
  snapshot: CharacterSnapshot,
): { valid: boolean; error?: string } {
  const keys = Object.keys(changes);
  if (keys.length === 0) return { valid: false, error: "A proposal must change at least one field" };

  const allowed = new Set<string>(REVISION_FIELDS);
  const unknown = keys.filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    return { valid: false, error: `Unknown card field(s): ${unknown.join(", ")}` };
  }

  for (const key of keys) {
    const change = changes[key];
    if (!change || typeof change !== "object") {
      return { valid: false, error: `Change for "${key}" must be an object with from/to` };
    }
    // Arrays are only valid for the list-shaped fields.
    const expected = snapshot[key as keyof CharacterSnapshot];
    if (Array.isArray(expected) && !Array.isArray(change.to)) {
      return { valid: false, error: `Field "${key}" must be a list` };
    }
    if (typeof expected === "string" && typeof change.to !== "string") {
      return { valid: false, error: `Field "${key}" must be a string` };
    }
  }

  return { valid: true };
}

export interface CreateProposalInput {
  characterId: string;
  changes: ProposalChanges;
  rationale?: string | null;
  sessionId?: string | null;
  /** Chat the proposal was filed in, when it came from a conversation. */
  chatId?: string | null;
}

/**
 * File a proposal. Writes nothing to the character.
 *
 * The card's current content hash is captured as `base_content_hash`; applying
 * later will refuse if the card has moved since.
 */
export function createProposal(userId: string, input: CreateProposalInput): EditProposal {
  const character = charactersSvc.getCharacter(userId, input.characterId);
  if (!character) throw new Error("Character not found");

  const snapshot = snapshotCharacter(character);
  const validation = validateChanges(input.changes, snapshot);
  if (!validation.valid) throw new Error(validation.error);

  const db = getDb();
  db.run(
    `INSERT INTO character_edit_proposals
     (user_id, character_id, session_id, chat_id, character_name, changes, rationale,
      base_content_hash, base_updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      input.characterId,
      input.sessionId ?? null,
      input.chatId ?? null,
      character.name,
      JSON.stringify(input.changes),
      input.rationale ?? null,
      characterContentHash(character),
      character.updated_at ?? null,
    ],
  );

  const id = (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
  const created = getProposal(userId, id);
  if (!created) throw new Error("Failed to create proposal");
  return created;
}

export function getProposal(userId: string, proposalId: number): EditProposal | null {
  const row = getDb()
    .query(
      `SELECT id, character_id, character_name, session_id, chat_id, changes, rationale, status,
              base_content_hash, base_updated_at, applied_revision_id, created_at, resolved_at
       FROM character_edit_proposals
       WHERE user_id = ? AND id = ?`,
    )
    .get(userId, proposalId) as ProposalRow | null;
  return row ? toProposal(row) : null;
}

export function listProposals(
  userId: string,
  options: { status?: ProposalStatus; characterId?: string; sessionId?: string; chatId?: string; limit?: number } = {},
): EditProposal[] {
  const where: string[] = ["user_id = ?"];
  const params: unknown[] = [userId];

  if (options.status) {
    where.push("status = ?");
    params.push(options.status);
  }
  if (options.characterId) {
    where.push("character_id = ?");
    params.push(options.characterId);
  }
  if (options.sessionId) {
    where.push("session_id = ?");
    params.push(options.sessionId);
  }
  if (options.chatId) {
    where.push("chat_id = ?");
    params.push(options.chatId);
  }

  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  params.push(limit);

  const rows = getDb()
    .query(
      `SELECT id, character_id, character_name, session_id, chat_id, changes, rationale, status,
              base_content_hash, base_updated_at, applied_revision_id, created_at, resolved_at
       FROM character_edit_proposals
       WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(...(params as never[])) as ProposalRow[];

  return rows.map(toProposal);
}

/**
 * A pending proposal is stale once the card's content no longer matches the
 * hash captured when it was filed.
 *
 * Computed rather than stored so the flag cannot go out of date on its own.
 */
export function isStale(userId: string, proposal: EditProposal): boolean {
  const character = charactersSvc.getCharacter(userId, proposal.character_id);
  if (!character) return true;
  return characterContentHash(character) !== proposal.base_content_hash;
}

export interface ApplyProposalResult {
  character: Character;
  revision: CharacterRevision;
  proposal: EditProposal;
}

/**
 * Apply a pending proposal to its character.
 *
 * Re-verifies the content hash immediately before writing, so two tabs (or a
 * user edit racing an apply) cannot silently overwrite each other.
 */
export function applyProposal(userId: string, proposalId: number): ApplyProposalResult {
  const proposal = getProposal(userId, proposalId);
  if (!proposal) throw new Error("Proposal not found");
  if (proposal.status === "applied") throw new Error("This proposal has already been applied");
  if (proposal.status === "rejected") throw new Error("This proposal was rejected");

  const existing = charactersSvc.getCharacter(userId, proposal.character_id);
  if (!existing) throw new Error("Character not found");

  if (characterContentHash(existing) !== proposal.base_content_hash) {
    // Mark it stale so the queue reflects reality without recomputing later.
    getDb().run(
      `UPDATE character_edit_proposals SET status = 'stale', resolved_at = unixepoch()
       WHERE user_id = ? AND id = ? AND status = 'pending'`,
      [userId, proposalId],
    );
    throw new StaleCharacterError();
  }

  const input: UpdateCharacterInput = {};
  for (const [field, change] of Object.entries(proposal.changes)) {
    (input as Record<string, unknown>)[field] = change.to;
  }

  const { character, revision } = applyRevisionedUpdate(
    userId,
    proposal.character_id,
    input,
    {
      origin: "agent",
      sessionId: proposal.session_id,
      label: proposal.rationale ?? "Applied proposed edit",
      expectedContentHash: proposal.base_content_hash,
    },
  );

  getDb().run(
    `UPDATE character_edit_proposals
     SET status = 'applied', applied_revision_id = ?, resolved_at = unixepoch()
     WHERE user_id = ? AND id = ?`,
    [revision.id, userId, proposalId],
  );

  const updated = getProposal(userId, proposalId);
  if (!updated) throw new Error("Failed to update proposal");
  return { character, revision, proposal: updated };
}

export function rejectProposal(userId: string, proposalId: number): EditProposal {
  const proposal = getProposal(userId, proposalId);
  if (!proposal) throw new Error("Proposal not found");
  if (proposal.status !== "pending" && proposal.status !== "stale") {
    throw new Error(`Cannot reject a ${proposal.status} proposal`);
  }

  getDb().run(
    `UPDATE character_edit_proposals SET status = 'rejected', resolved_at = unixepoch()
     WHERE user_id = ? AND id = ?`,
    [userId, proposalId],
  );

  const updated = getProposal(userId, proposalId);
  if (!updated) throw new Error("Failed to update proposal");
  return updated;
}

/**
 * Apply every pending, non-stale proposal for one session in a single pass.
 *
 * Rejected proposals are skipped rather than aborting the batch — a partial
 * pass over a large cleanup is the expected case. The per-character revision
 * write means an undesirable batch is still fully reversible.
 */
export function applyProposalBatch(
  userId: string,
  options: { sessionId?: string; characterIds?: string[] } = {},
): { applied: number; failed: Array<{ proposalId: number; characterId: string; error: string }> } {
  const pending = listProposals(userId, { status: "pending", sessionId: options.sessionId, limit: 500 });
  const scoped = options.characterIds
    ? pending.filter((p) => options.characterIds!.includes(p.character_id))
    : pending;

  let applied = 0;
  const failed: Array<{ proposalId: number; characterId: string; error: string }> = [];

  for (const proposal of scoped) {
    try {
      applyProposal(userId, proposal.id);
      applied++;
    } catch (err) {
      failed.push({
        proposalId: proposal.id,
        characterId: proposal.character_id,
        error: err instanceof Error ? err.message : "Failed to apply",
      });
    }
  }

  return { applied, failed };
}

/**
 * Discard every pending proposal from a session.
 *
 * Used when a session is deleted so its unreviewed work does not linger in the
 * review queue.
 */
export function rejectProposalsForSession(userId: string, sessionId: string): number {
  const result = getDb().run(
    `UPDATE character_edit_proposals SET status = 'rejected', resolved_at = unixepoch()
     WHERE user_id = ? AND session_id = ? AND status IN ('pending', 'stale')`,
    [userId, sessionId],
  );
  return result.changes;
}

/**
 * Build the field-level diff a proposal represents, with the live `from` value
 * filled in from the character rather than the value the agent recorded.
 *
 * The agent's `from` is a claim; this is what the UI should show the user.
 */
export function describeProposal(
  userId: string,
  proposal: EditProposal,
): {
  characterId: string;
  characterName: string;
  stale: boolean;
  fields: Array<{ field: string; from: unknown; to: unknown; changed: boolean }>;
} {
  const character = charactersSvc.getCharacter(userId, proposal.character_id);
  const current = character ? snapshotCharacter(character) : null;

  const fields = Object.entries(proposal.changes).map(([field, change]) => {
    const live = current ? (current as unknown as Record<string, unknown>)[field] : change.from;
    return {
      field,
      from: live,
      to: change.to,
      changed: JSON.stringify(live) !== JSON.stringify(change.to),
    };
  });

  return {
    characterId: proposal.character_id,
    characterName: proposal.character_name,
    stale: isStale(userId, proposal),
    fields,
  };
}
