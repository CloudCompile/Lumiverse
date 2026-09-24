import { getDb } from "../../db/connection";
import * as charactersSvc from "../characters.service";
import type { Character, UpdateCharacterInput } from "../../types/character";

/**
 * Reversible revision history for character cards.
 *
 * The character table has no history of its own — `updateCharacter` overwrites
 * fields in place. This module wraps every write in a snapshot so a card can
 * always be restored, which is the precondition for letting an agent propose
 * edits at all.
 *
 * Snapshots are stored as full JSON of the mutable card fields rather than
 * diffs. Cards are a few KB, and a full snapshot cannot drift the way a diff
 * chain can.
 */

/** The card fields that participate in revisions — everything user- or agent-editable. */
export const REVISION_FIELDS = [
  "name",
  "description",
  "personality",
  "scenario",
  "first_mes",
  "mes_example",
  "creator",
  "creator_notes",
  "system_prompt",
  "post_history_instructions",
  "tags",
  "alternate_greetings",
  "folder",
] as const;

export type RevisionField = (typeof REVISION_FIELDS)[number];

export interface CharacterSnapshot {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  creator: string;
  creator_notes: string;
  system_prompt: string;
  post_history_instructions: string;
  tags: string[];
  alternate_greetings: string[];
  folder: string;
}

export type RevisionOrigin = "agent" | "user" | "import" | "revert" | "system";

export interface CharacterRevision {
  id: number;
  character_id: string;
  revision_number: number;
  origin: RevisionOrigin;
  session_id: string | null;
  label: string | null;
  created_at: number;
}

export interface CharacterRevisionWithSnapshot extends CharacterRevision {
  snapshot: CharacterSnapshot;
}

interface RevisionRow {
  id: number;
  character_id: string;
  revision_number: number;
  snapshot: string;
  origin: string;
  session_id: string | null;
  label: string | null;
  created_at: number;
}

export function snapshotCharacter(character: Character): CharacterSnapshot {
  const snapshot = {} as CharacterSnapshot;
  for (const field of REVISION_FIELDS) {
    (snapshot as unknown as Record<string, unknown>)[field] = (character as unknown as Record<string, unknown>)[field];
  }
  return snapshot;
}

/**
 * Deterministic JSON with sorted keys.
 *
 * Hashing a snapshot is how proposal staleness is detected, so key order must
 * not be able to make two identical cards hash differently.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

/**
 * Fingerprint a character's mutable content.
 *
 * Two cards with the same content hash are indistinguishable to the agent, so
 * a pending proposal computed against one applies cleanly to the other. Any
 * content change moves the hash and forces re-review.
 */
export function characterContentHash(character: Character): string {
  return hashSnapshot(snapshotCharacter(character));
}

export function hashSnapshot(snapshot: CharacterSnapshot): string {
  return String(Bun.hash(canonicalJson(snapshot)));
}

/**
 * Record the character's current content as a revision.
 *
 * Called *before* a mutation so the pre-change state survives. Writing the
 * "before" state rather than the "after" state means the very first write to a
 * card still has something to restore to.
 */
export function recordRevision(
  userId: string,
  character: Character,
  input: { origin?: RevisionOrigin; sessionId?: string | null; label?: string | null } = {},
): CharacterRevision {
  const db = getDb();
  const next = db
    .query(
      `SELECT COALESCE(MAX(revision_number), 0) + 1 AS next
       FROM character_revisions
       WHERE user_id = ? AND character_id = ?`,
    )
    .get(userId, character.id) as { next: number } | null;
  const revisionNumber = next?.next ?? 1;

  db.run(
    `INSERT INTO character_revisions
     (user_id, character_id, revision_number, snapshot, origin, session_id, label)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      character.id,
      revisionNumber,
      canonicalJson(snapshotCharacter(character)),
      input.origin ?? "user",
      input.sessionId ?? null,
      input.label ?? null,
    ],
  );

  return db
    .query(
      `SELECT id, character_id, revision_number, origin, session_id, label, created_at
       FROM character_revisions
       WHERE user_id = ? AND character_id = ? AND revision_number = ?`,
    )
    .get(userId, character.id, revisionNumber) as CharacterRevision;
}

export function listRevisions(
  userId: string,
  characterId: string,
  limit = 50,
): CharacterRevision[] {
  return getDb()
    .query(
      `SELECT id, character_id, revision_number, origin, session_id, label, created_at
       FROM character_revisions
       WHERE user_id = ? AND character_id = ?
       ORDER BY revision_number DESC
       LIMIT ?`,
    )
    .all(userId, characterId, limit) as CharacterRevision[];
}

export function getRevision(
  userId: string,
  characterId: string,
  revisionId: number,
): CharacterRevisionWithSnapshot | null {
  const row = getDb()
    .query(
      `SELECT id, character_id, revision_number, snapshot, origin, session_id, label, created_at
       FROM character_revisions
       WHERE user_id = ? AND character_id = ? AND id = ?`,
    )
    .get(userId, characterId, revisionId) as RevisionRow | null;
  if (!row) return null;
  return { ...row, origin: row.origin as RevisionOrigin, snapshot: JSON.parse(row.snapshot) as CharacterSnapshot };
}

/** Raised when a card changed between proposal and apply. */
export class StaleCharacterError extends Error {
  status = 409 as const;
  constructor(message = "This character changed since the edit was proposed. Re-generate the proposal.") {
    super(message);
    this.name = "StaleCharacterError";
  }
}

/**
 * Wrap a character mutation so the pre-change state is always restorable.
 *
 * Used by the agent's apply path. The ordinary editor route keeps calling
 * `updateCharacter` directly — hooking the core service would force every
 * hand-rolled test schema to grow a revision table.
 */
export function applyRevisionedUpdate(
  userId: string,
  characterId: string,
  input: UpdateCharacterInput,
  options: {
    origin?: RevisionOrigin;
    sessionId?: string | null;
    label?: string | null;
    /** Refuse the write when the card's content moved since this hash. */
    expectedContentHash?: string;
  } = {},
): { character: Character; revision: CharacterRevision } {
  const existing = charactersSvc.getCharacter(userId, characterId);
  if (!existing) throw new Error("Character not found");

  if (
    options.expectedContentHash &&
    characterContentHash(existing) !== options.expectedContentHash
  ) {
    throw new StaleCharacterError();
  }

  const revision = recordRevision(userId, existing, {
    origin: options.origin ?? "agent",
    sessionId: options.sessionId ?? null,
    label: options.label ?? null,
  });

  const updated = charactersSvc.updateCharacter(userId, characterId, input);
  if (!updated) throw new Error("Character not found");

  return { character: updated, revision };
}

/**
 * Restore a card to a stored revision.
 *
 * The restore is itself recorded as a new revision, so reverting is undoable —
 * the state that was live before the revert is not lost.
 */
export function revertToRevision(
  userId: string,
  characterId: string,
  revisionId: number,
): { character: Character; revision: CharacterRevision } {
  const target = getRevision(userId, characterId, revisionId);
  if (!target) throw new Error("Revision not found");

  const input: UpdateCharacterInput = {};
  for (const field of REVISION_FIELDS) {
    (input as Record<string, unknown>)[field] = target.snapshot[field];
  }

  return applyRevisionedUpdate(userId, characterId, input, {
    origin: "revert",
    label: `Reverted to revision ${target.revision_number}`,
  });
}

/** Drop revision history for a deleted character so orphans cannot accumulate. */
export function deleteRevisionsForCharacter(userId: string, characterId: string): void {
  getDb().run(
    `DELETE FROM character_revisions WHERE user_id = ? AND character_id = ?`,
    [userId, characterId],
  );
}