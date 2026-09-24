-- Card Agent: reversible revision history for characters, a human-approved
-- edit-proposal queue, and agent sessions that propose but never write.
--
-- The agent deliberately has NO write path. It reads the library and files
-- proposals; only the user applies them. Every applied change also lands in
-- character_revisions first, so a bad pass is always reversible.

-- Snapshot history. Cards are only a few KB, so a full JSON snapshot per
-- revision is cheaper to reason about (and to restore) than a field diff.
-- revision_number is monotonic per character and assigned at insert time.
CREATE TABLE IF NOT EXISTS character_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  -- Snapshot of the mutable card fields (not the whole row).
  snapshot TEXT NOT NULL,
  -- What produced this revision: 'agent', 'user', 'import', 'revert', 'system'.
  origin TEXT NOT NULL DEFAULT 'user',
  -- Session id when origin = 'agent', so a pass can be reviewed as a unit.
  session_id TEXT,
  label TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_id, character_id, revision_number)
);

CREATE INDEX IF NOT EXISTS idx_character_revisions_character
  ON character_revisions(user_id, character_id, revision_number DESC);

-- Proposed edits awaiting review. `changes` holds only the fields that would
-- change, as {"field": {"from": ..., "to": ...}}.
--
-- base_content_hash is the load-bearing staleness guard: it fingerprints the
-- card's mutable fields when the proposal was generated. If the card changes
-- before the proposal is applied, the hash no longer matches and the apply is
-- refused rather than silently clobbering the newer edit.
CREATE TABLE IF NOT EXISTS character_edit_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  session_id TEXT,
  character_name TEXT NOT NULL DEFAULT '',
  changes TEXT NOT NULL,
  -- Short model-authored explanation of why this edit is proposed.
  rationale TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  base_content_hash TEXT NOT NULL,
  base_updated_at INTEGER,
  applied_revision_id INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  resolved_at INTEGER,
  CHECK(status IN ('pending', 'applied', 'rejected', 'stale'))
);

CREATE INDEX IF NOT EXISTS idx_character_edit_proposals_pending
  ON character_edit_proposals(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_character_edit_proposals_character
  ON character_edit_proposals(user_id, character_id, created_at DESC);

-- Agent sessions. Mirrors the Weaver session shape: a persisted, resumable
-- record bound to a connection/model, belonging to one user.
CREATE TABLE IF NOT EXISTS card_agent_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  connection_id TEXT,
  model TEXT,
  -- Library scope the agent may read. 'all' or 'selection'.
  scope_mode TEXT NOT NULL DEFAULT 'all',
  -- JSON array of character ids when scope_mode = 'selection'.
  scope_character_ids TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK(scope_mode IN ('all', 'selection'))
);

CREATE INDEX IF NOT EXISTS idx_card_agent_sessions_user
  ON card_agent_sessions(user_id, updated_at DESC);

-- Session transcript. Stored separately so a long conversation does not bloat
-- the session row that list endpoints read.
CREATE TABLE IF NOT EXISTS card_agent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  -- JSON array of tool activity for assistant turns that called tools.
  tool_activity TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK(role IN ('user', 'assistant', 'system'))
);

CREATE INDEX IF NOT EXISTS idx_card_agent_messages_session
  ON card_agent_messages(session_id, id ASC);