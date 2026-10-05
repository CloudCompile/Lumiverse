-- Card Creator: a special character you chat with, like any RP card, whose
-- turns carry the card authoring tools.
--
-- Until now the card agent was a separate sidecar surface with its own session
-- and transcript tables. This migration makes the creator a real row in
-- `characters` so the normal chat path resolves it: selecting it starts a chat,
-- and its turns are the only ones with the card toolset attached.
--
-- The row is user-scoped like every other character, but flagged so the rest of
-- the app can keep it out of the library list and refuse to delete it.

-- 'standard' for every existing card; 'card_creator' for the one seeded row.
-- Additive with a default, so no backfill is required.
ALTER TABLE characters ADD COLUMN character_kind TEXT NOT NULL DEFAULT 'standard' CHECK(character_kind IN ('standard', 'card_creator'));

-- At most one creator per user, enforced here rather than trusted to callers.
CREATE UNIQUE INDEX idx_characters_card_creator
  ON characters(user_id)
  WHERE character_kind = 'card_creator';

-- The seeded creator is never listed, so it should not be reachable through the
-- library sort either; the partial index keeps the common listing query off it.
CREATE INDEX idx_characters_user_standard
  ON characters(user_id, created_at DESC)
  WHERE character_kind = 'standard';

-- Proposals now belong to a chat, not a sidecar session: the review UI lives
-- inline in the conversation, so a proposal has to be findable by chat.
-- `session_id` stays for proposals filed before this change.
ALTER TABLE character_edit_proposals ADD COLUMN chat_id TEXT;

CREATE INDEX IF NOT EXISTS idx_character_edit_proposals_chat
  ON character_edit_proposals(user_id, chat_id, created_at DESC);
