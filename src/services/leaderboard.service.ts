import { getDb } from "../db/connection";
import { getSetting, putSetting } from "./settings.service";

// ── Types ──────────────────────────────────────────────────────────────────

export type LeaderboardRankingMode = "classic" | "confidence" | "experimental";

export interface LeaderboardSettings {
  enabled: boolean;
  rankingMode: LeaderboardRankingMode;
  minimumVotes: number;
  showUnofficialRanks: boolean;
  mergeAcrossProviders: boolean;
  antiSpamPerMinute: number;
  antiSpamPerHour: number;
  duplicateDampingWindowSec: number;
  rouletteConnectionIds: string[];
}

export interface LeaderboardQuery {
  provider?: string;
  connectionId?: string;
  chatId?: string;
  timeRange?: "24h" | "7d" | "30d" | "all";
}

export interface LeaderboardEntry {
  model: string;
  raw_model: string;
  canonical_model: string;
  provider: string;
  connection_id: string | null;
  elo: number;
  wins: number;
  losses: number;
  total_votes: number;
  official_rank: number | null;
  is_official: boolean;
  win_rate: number;
  confidence_score: number;
  trend_24h: number;
  trend_7d: number;
  tie_breaker: string;
  why_rank: string;
}

export interface LeaderboardVote {
  id: number;
  message_id: string;
  swipe_id: number;
  chat_id: string;
  model: string;
  raw_model: string;
  canonical_model: string;
  provider: string;
  vote: number;
  confidence: number;
  effect_weight: number;
  ranking_mode: string;
  created_at: number;
}

export interface LeaderboardAlias {
  id: number;
  provider_scope: string;
  alias_key: string;
  canonical_key: string;
  display_name: string | null;
  updated_at: number;
}

export interface RoulettePair {
  left: Pick<LeaderboardEntry, "model" | "raw_model" | "canonical_model" | "provider" | "elo" | "wins" | "losses" | "total_votes">;
  right: Pick<LeaderboardEntry, "model" | "raw_model" | "canonical_model" | "provider" | "elo" | "wins" | "losses" | "total_votes">;
  connection_id: string | null;
  ranking_mode: LeaderboardRankingMode;
  tie_breaker: string;
}

export interface RouletteVoteResult {
  left: LeaderboardEntry;
  right: LeaderboardEntry;
}

interface CastVoteInput {
  messageId: string;
  swipeId: number;
  chatId: string;
  model: string;
  provider: string;
  connectionId?: string | null;
  vote: 1 | -1;
  confidence?: number;
}

interface RouletteVoteInput {
  leftModel: string;
  leftProvider: string;
  rightModel: string;
  rightProvider: string;
  winner: "left" | "right" | "skip";
  confidence?: number;
  connectionId?: string | null;
}

export class LeaderboardRateLimitedError extends Error {
  status = 429 as const;
}

const DEFAULT_ELO = 1500;
const RANK_TIE_BREAKER = "ELO > votes > wins > name";

export const DEFAULT_LEADERBOARD_SETTINGS: LeaderboardSettings = {
  enabled: true,
  rankingMode: "classic",
  minimumVotes: 5,
  showUnofficialRanks: true,
  mergeAcrossProviders: false,
  antiSpamPerMinute: 30,
  antiSpamPerHour: 240,
  duplicateDampingWindowSec: 300,
  rouletteConnectionIds: [],
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeModelId(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\s\-_./]+/g, "")
    .trim();
}

function toProviderScope(provider: string, mergeAcrossProviders: boolean): string {
  return mergeAcrossProviders ? "*" : provider;
}

function resolveK(mode: LeaderboardRankingMode): number {
  if (mode === "confidence") return 24;
  if (mode === "experimental") return 40;
  return 32;
}

function confidenceMultiplier(mode: LeaderboardRankingMode, confidence: number): number {
  if (mode !== "confidence") return 1;
  return clamp(confidence, 0.25, 2);
}

function computeExpectedScore(playerElo: number, opponentElo: number): number {
  return 1 / (1 + Math.pow(10, (opponentElo - playerElo) / 400));
}

function computeDelta(
  mode: LeaderboardRankingMode,
  playerElo: number,
  opponentElo: number,
  actual: 0 | 1,
  confidence: number,
  weight = 1,
): number {
  const expected = computeExpectedScore(playerElo, opponentElo);
  const k = resolveK(mode) * confidenceMultiplier(mode, confidence) * clamp(weight, 0.1, 2);
  return Math.round(k * (actual - expected));
}

function parseSettings(raw: any): LeaderboardSettings {
  const settings = raw && typeof raw === "object" ? raw : {};
  const rankingMode = settings.rankingMode === "confidence" || settings.rankingMode === "experimental"
    ? settings.rankingMode
    : "classic";

  return {
    enabled: settings.enabled !== false,
    rankingMode,
    minimumVotes: Number.isFinite(settings.minimumVotes) ? clamp(Math.floor(settings.minimumVotes), 0, 10_000) : DEFAULT_LEADERBOARD_SETTINGS.minimumVotes,
    showUnofficialRanks: settings.showUnofficialRanks !== false,
    mergeAcrossProviders: settings.mergeAcrossProviders === true,
    antiSpamPerMinute: Number.isFinite(settings.antiSpamPerMinute)
      ? clamp(Math.floor(settings.antiSpamPerMinute), 5, 500)
      : DEFAULT_LEADERBOARD_SETTINGS.antiSpamPerMinute,
    antiSpamPerHour: Number.isFinite(settings.antiSpamPerHour)
      ? clamp(Math.floor(settings.antiSpamPerHour), 30, 3_000)
      : DEFAULT_LEADERBOARD_SETTINGS.antiSpamPerHour,
    duplicateDampingWindowSec: Number.isFinite(settings.duplicateDampingWindowSec)
      ? clamp(Math.floor(settings.duplicateDampingWindowSec), 30, 3_600)
      : DEFAULT_LEADERBOARD_SETTINGS.duplicateDampingWindowSec,
    rouletteConnectionIds: Array.isArray(settings.rouletteConnectionIds)
      ? Array.from(new Set(settings.rouletteConnectionIds.filter((id: unknown): id is string => typeof id === "string" && id.trim().length > 0).map((id: string) => id.trim())))
      : [],
  };
}

export function getLeaderboardSettings(userId: string): LeaderboardSettings {
  const row = getSetting(userId, "leaderboardSettings");
  return parseSettings(row?.value);
}

export function putLeaderboardSettings(userId: string, input: Partial<LeaderboardSettings>): LeaderboardSettings {
  const next = parseSettings({ ...getLeaderboardSettings(userId), ...input });
  putSetting(userId, "leaderboardSettings", next);
  return next;
}

function getTimeRangeCutoff(timeRange: LeaderboardQuery["timeRange"]): number | null {
  const now = Math.floor(Date.now() / 1000);
  if (timeRange === "24h") return now - 24 * 60 * 60;
  if (timeRange === "7d") return now - 7 * 24 * 60 * 60;
  if (timeRange === "30d") return now - 30 * 24 * 60 * 60;
  return null;
}

function getAliasByKey(userId: string, providerScope: string, aliasKey: string): { canonical_key: string; display_name: string | null } | null {
  const db = getDb();
  return (db.query(
    `SELECT canonical_key, display_name
     FROM leaderboard_model_aliases
     WHERE user_id = ? AND provider_scope = ? AND alias_key = ?`,
  ).get(userId, providerScope, aliasKey) as { canonical_key: string; display_name: string | null } | null) ?? null;
}

function resolveCanonicalModel(
  userId: string,
  provider: string,
  model: string,
  settings: LeaderboardSettings,
): { rawModel: string; canonicalModel: string; displayModel: string } {
  const rawModel = model.trim();
  const normalized = normalizeModelId(rawModel);
  const scopedProvider = toProviderScope(provider, settings.mergeAcrossProviders);

  const scopedAlias = getAliasByKey(userId, scopedProvider, normalized);
  if (scopedAlias) {
    return {
      rawModel,
      canonicalModel: scopedAlias.canonical_key,
      displayModel: scopedAlias.display_name || rawModel,
    };
  }

  // Fallback to global provider scope if not already global.
  if (scopedProvider !== "*") {
    const globalAlias = getAliasByKey(userId, "*", normalized);
    if (globalAlias) {
      return {
        rawModel,
        canonicalModel: globalAlias.canonical_key,
        displayModel: globalAlias.display_name || rawModel,
      };
    }
  }

  return {
    rawModel,
    canonicalModel: normalized || rawModel.toLowerCase(),
    displayModel: rawModel,
  };
}

function getOrCreateRating(
  userId: string,
  provider: string,
  model: string,
  canonicalModel: string,
  connectionId: string | null,
): { elo: number; wins: number; losses: number; total_votes: number } {
  const db = getDb();
  const found = db.query(
    `SELECT elo, wins, losses, total_votes
     FROM leaderboard_ratings
     WHERE user_id = ? AND provider = ? AND canonical_model = ?`,
  ).get(userId, provider, canonicalModel) as { elo: number; wins: number; losses: number; total_votes: number } | null;

  if (found) return found;

  db.run(
    `INSERT INTO leaderboard_ratings
     (user_id, model, raw_model, canonical_model, provider, connection_id, elo, confidence_score)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    [userId, model, model, canonicalModel, provider, connectionId, DEFAULT_ELO],
  );

  return { elo: DEFAULT_ELO, wins: 0, losses: 0, total_votes: 0 };
}

function ensureVoteRateLimit(userId: string, settings: LeaderboardSettings): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const perMinute = db.query(
    `SELECT COUNT(*) as c FROM leaderboard_votes WHERE user_id = ? AND created_at >= ?`,
  ).get(userId, now - 60) as { c: number };

  if (perMinute.c >= settings.antiSpamPerMinute) {
    throw new LeaderboardRateLimitedError("Vote rate limit exceeded for the current minute.");
  }

  const perHour = db.query(
    `SELECT COUNT(*) as c FROM leaderboard_votes WHERE user_id = ? AND created_at >= ?`,
  ).get(userId, now - 60 * 60) as { c: number };

  if (perHour.c >= settings.antiSpamPerHour) {
    throw new LeaderboardRateLimitedError("Vote rate limit exceeded for the current hour.");
  }
}

function computeDuplicateDamping(
  userId: string,
  provider: string,
  canonicalModel: string,
  settings: LeaderboardSettings,
): number {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const row = db.query(
    `SELECT COUNT(*) as c
     FROM leaderboard_votes
     WHERE user_id = ? AND provider = ? AND canonical_model = ? AND created_at >= ?`,
  ).get(userId, provider, canonicalModel, now - settings.duplicateDampingWindowSec) as { c: number };

  if (row.c <= 0) return 1;
  return clamp(1 / (1 + row.c * 0.35), 0.2, 1);
}

function updateRating(
  userId: string,
  provider: string,
  canonicalModel: string,
  patch: { elo: number; wins: number; losses: number; total_votes: number; model?: string; raw_model?: string; connection_id?: string | null },
): void {
  const db = getDb();
  const confidenceScore = patch.total_votes <= 0
    ? 0
    : clamp(Math.sqrt(patch.total_votes) / 10, 0, 1);

  db.run(
    `UPDATE leaderboard_ratings
     SET elo = ?, wins = ?, losses = ?, total_votes = ?, confidence_score = ?,
         model = COALESCE(?, model), raw_model = COALESCE(?, raw_model),
         connection_id = COALESCE(?, connection_id), updated_at = unixepoch()
     WHERE user_id = ? AND provider = ? AND canonical_model = ?`,
    [
      patch.elo,
      patch.wins,
      patch.losses,
      patch.total_votes,
      confidenceScore,
      patch.model ?? null,
      patch.raw_model ?? null,
      patch.connection_id ?? null,
      userId,
      provider,
      canonicalModel,
    ],
  );
}

function toEntry(row: {
  model: string;
  raw_model?: string;
  canonical_model: string;
  provider: string;
  connection_id: string | null;
  elo: number;
  wins: number;
  losses: number;
  total_votes: number;
  confidence_score?: number;
  trend_24h?: number;
  trend_7d?: number;
},
settings: LeaderboardSettings,
rank: number): LeaderboardEntry {
  const totalVotes = row.total_votes || 0;
  const wins = row.wins || 0;
  const official = totalVotes >= settings.minimumVotes;
  const winRate = totalVotes > 0 ? wins / totalVotes : 0;
  const confidenceScore = row.confidence_score ?? clamp(Math.sqrt(totalVotes) / 10, 0, 1);

  return {
    model: row.model,
    raw_model: row.raw_model || row.model,
    canonical_model: row.canonical_model,
    provider: row.provider,
    connection_id: row.connection_id,
    elo: row.elo,
    wins,
    losses: row.losses || 0,
    total_votes: totalVotes,
    official_rank: official ? rank : null,
    is_official: official,
    win_rate: Number(winRate.toFixed(4)),
    confidence_score: Number(confidenceScore.toFixed(4)),
    trend_24h: row.trend_24h || 0,
    trend_7d: row.trend_7d || 0,
    tie_breaker: RANK_TIE_BREAKER,
    why_rank: `Ranked by ${RANK_TIE_BREAKER}. Confidence ${(confidenceScore * 100).toFixed(0)}% from ${totalVotes} vote${totalVotes === 1 ? "" : "s"}.`,
  };
}

function getTrendDeltas(userId: string): Map<string, { d24: number; d7: number }> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const rows = db.query(
    `SELECT provider, canonical_model,
            SUM(CASE WHEN created_at >= ? THEN elo_delta ELSE 0 END) as d24,
            SUM(CASE WHEN created_at >= ? THEN elo_delta ELSE 0 END) as d7
     FROM leaderboard_votes
     WHERE user_id = ?
     GROUP BY provider, canonical_model`,
  ).all(now - 24 * 60 * 60, now - 7 * 24 * 60 * 60, userId) as Array<{
    provider: string;
    canonical_model: string;
    d24: number;
    d7: number;
  }>;

  const out = new Map<string, { d24: number; d7: number }>();
  for (const row of rows) {
    out.set(`${row.provider}:${row.canonical_model}`, { d24: row.d24 || 0, d7: row.d7 || 0 });
  }
  return out;
}

export function getLeaderboard(userId: string, query: LeaderboardQuery = {}): LeaderboardEntry[] {
  const db = getDb();
  const settings = getLeaderboardSettings(userId);
  if (!settings.enabled) return [];

  const where: string[] = ["user_id = ?"];
  const params: any[] = [userId];

  if (query.provider) {
    where.push("provider = ?");
    params.push(query.provider);
  }

  if (query.connectionId) {
    where.push("connection_id = ?");
    params.push(query.connectionId);
  }

  const rows = db.query(
    `SELECT model, raw_model, canonical_model, provider, connection_id,
            elo, wins, losses, total_votes, confidence_score
     FROM leaderboard_ratings
     WHERE ${where.join(" AND ")}`,
  ).all(...params) as Array<{
    model: string;
    raw_model?: string;
    canonical_model: string;
    provider: string;
    connection_id: string | null;
    elo: number;
    wins: number;
    losses: number;
    total_votes: number;
    confidence_score?: number;
  }>;

  const cutoff = getTimeRangeCutoff(query.timeRange);
  let activityGate = new Set<string>();

  if (cutoff != null || query.chatId) {
    const clauses = ["user_id = ?"];
    const voteParams: any[] = [userId];
    if (cutoff != null) {
      clauses.push("created_at >= ?");
      voteParams.push(cutoff);
    }
    if (query.chatId) {
      clauses.push("chat_id = ?");
      voteParams.push(query.chatId);
    }

    const activeRows = db.query(
      `SELECT provider, canonical_model
       FROM leaderboard_votes
       WHERE ${clauses.join(" AND ")}
       GROUP BY provider, canonical_model`,
    ).all(...voteParams) as Array<{ provider: string; canonical_model: string }>;

    activityGate = new Set(activeRows.map((row) => `${row.provider}:${row.canonical_model}`));
  }

  const trends = getTrendDeltas(userId);

  const rankedRows = rows
    .filter((row) => activityGate.size === 0 || activityGate.has(`${row.provider}:${row.canonical_model}`))
    .sort((a, b) => {
      if (b.elo !== a.elo) return b.elo - a.elo;
      if (b.total_votes !== a.total_votes) return b.total_votes - a.total_votes;
      if (b.wins !== a.wins) return b.wins - a.wins;
      return a.model.localeCompare(b.model);
    });

  const entries = rankedRows.map((row, idx) => {
    const trend = trends.get(`${row.provider}:${row.canonical_model}`);
    return toEntry(
      { ...row, trend_24h: trend?.d24 || 0, trend_7d: trend?.d7 || 0 },
      settings,
      idx + 1,
    );
  });

  if (!settings.showUnofficialRanks) {
    return entries.filter((entry) => entry.is_official);
  }
  return entries;
}

export function getVoteForMessage(
  userId: string,
  messageId: string,
  swipeId: number,
): LeaderboardVote | null {
  const db = getDb();
  return (
    (db
      .query(
        `SELECT id, message_id, swipe_id, chat_id, model, raw_model, canonical_model,
                provider, vote, confidence, effect_weight, ranking_mode, created_at
         FROM leaderboard_votes
         WHERE user_id = ? AND message_id = ? AND swipe_id = ?`,
      )
      .get(userId, messageId, swipeId) as LeaderboardVote | null) ?? null
  );
}

export function getVotesForChat(
  userId: string,
  chatId: string,
): LeaderboardVote[] {
  const db = getDb();
  return db
    .query(
      `SELECT id, message_id, swipe_id, chat_id, model, raw_model, canonical_model,
              provider, vote, confidence, effect_weight, ranking_mode, created_at
       FROM leaderboard_votes
       WHERE user_id = ? AND chat_id = ?`,
    )
    .all(userId, chatId) as LeaderboardVote[];
}

export function castVote(userId: string, input: CastVoteInput): LeaderboardEntry {
  const db = getDb();
  const settings = getLeaderboardSettings(userId);
  if (!settings.enabled) throw new Error("Leaderboard voting is disabled.");

  const {
    messageId,
    swipeId,
    chatId,
    model,
    provider,
    connectionId,
    vote,
  } = input;

  const confidence = clamp(input.confidence ?? 1, 0.25, 2);
  const identity = resolveCanonicalModel(userId, provider, model, settings);

  ensureVoteRateLimit(userId, settings);

  const existing = db
    .query(
      `SELECT id, vote, effect_weight, confidence, ranking_mode, elo_delta, provider, canonical_model
       FROM leaderboard_votes
       WHERE user_id = ? AND message_id = ? AND swipe_id = ?`,
    )
    .get(userId, messageId, swipeId) as {
      id: number;
      vote: number;
      effect_weight: number;
      confidence: number;
      ranking_mode: LeaderboardRankingMode;
      elo_delta: number;
      provider: string;
      canonical_model: string;
    } | null;

  let rating = getOrCreateRating(
    userId,
    provider,
    identity.displayModel,
    identity.canonicalModel,
    connectionId ?? null,
  );

  let { elo, wins, losses, total_votes } = rating;

  if (existing && existing.vote === vote) {
    return getLeaderboard(userId).find(
      (entry) => entry.provider === provider && entry.canonical_model === identity.canonicalModel,
    ) || toEntry(
      {
        model: identity.displayModel,
        raw_model: identity.rawModel,
        canonical_model: identity.canonicalModel,
        provider,
        connection_id: connectionId ?? null,
        elo,
        wins,
        losses,
        total_votes,
      },
      settings,
      0,
    );
  }

  if (existing) {
    elo -= existing.elo_delta;
    if (existing.vote === 1) wins = Math.max(0, wins - 1);
    if (existing.vote === -1) losses = Math.max(0, losses - 1);
    total_votes = Math.max(0, total_votes - 1);
  }

  const damping = computeDuplicateDamping(userId, provider, identity.canonicalModel, settings);
  const delta = computeDelta(
    settings.rankingMode,
    elo,
    DEFAULT_ELO,
    vote === 1 ? 1 : 0,
    confidence,
    damping,
  );

  elo += delta;
  if (vote === 1) wins++;
  else losses++;
  total_votes++;

  if (existing) {
    db.run(
      `UPDATE leaderboard_votes
       SET vote = ?, model = ?, raw_model = ?, canonical_model = ?, provider = ?, connection_id = ?,
           ranking_mode = ?, confidence = ?, effect_weight = ?, elo_delta = ?, created_at = unixepoch()
       WHERE id = ?`,
      [
        vote,
        identity.displayModel,
        identity.rawModel,
        identity.canonicalModel,
        provider,
        connectionId ?? null,
        settings.rankingMode,
        confidence,
        damping,
        delta,
        existing.id,
      ],
    );
  } else {
    db.run(
      `INSERT INTO leaderboard_votes
       (user_id, message_id, swipe_id, chat_id, model, raw_model, canonical_model, provider,
        connection_id, vote, ranking_mode, confidence, effect_weight, elo_delta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        messageId,
        swipeId,
        chatId,
        identity.displayModel,
        identity.rawModel,
        identity.canonicalModel,
        provider,
        connectionId ?? null,
        vote,
        settings.rankingMode,
        confidence,
        damping,
        delta,
      ],
    );
  }

  updateRating(userId, provider, identity.canonicalModel, {
    elo,
    wins,
    losses,
    total_votes,
    model: identity.displayModel,
    raw_model: identity.rawModel,
    connection_id: connectionId ?? null,
  });

  const entries = getLeaderboard(userId);
  return entries.find((entry) => entry.provider === provider && entry.canonical_model === identity.canonicalModel)
    || toEntry(
      {
        model: identity.displayModel,
        raw_model: identity.rawModel,
        canonical_model: identity.canonicalModel,
        provider,
        connection_id: connectionId ?? null,
        elo,
        wins,
        losses,
        total_votes,
      },
      settings,
      0,
    );
}

export function removeVote(
  userId: string,
  messageId: string,
  swipeId: number,
): boolean {
  const db = getDb();

  const existing = db
    .query(
      `SELECT id, vote, provider, canonical_model, elo_delta
       FROM leaderboard_votes
       WHERE user_id = ? AND message_id = ? AND swipe_id = ?`,
    )
    .get(userId, messageId, swipeId) as
    | { id: number; vote: number; provider: string; canonical_model: string; elo_delta: number }
    | null;

  if (!existing) return false;

  const rating = db
    .query(
      `SELECT model, raw_model, connection_id, elo, wins, losses, total_votes
       FROM leaderboard_ratings
       WHERE user_id = ? AND provider = ? AND canonical_model = ?`,
    )
    .get(userId, existing.provider, existing.canonical_model) as
    | {
      model: string;
      raw_model: string;
      connection_id: string | null;
      elo: number;
      wins: number;
      losses: number;
      total_votes: number;
    }
    | null;

  if (rating) {
    const elo = rating.elo - existing.elo_delta;
    const wins = existing.vote === 1 ? Math.max(0, rating.wins - 1) : rating.wins;
    const losses = existing.vote === -1 ? Math.max(0, rating.losses - 1) : rating.losses;
    const total_votes = Math.max(0, rating.total_votes - 1);

    updateRating(userId, existing.provider, existing.canonical_model, {
      elo,
      wins,
      losses,
      total_votes,
      model: rating.model,
      raw_model: rating.raw_model,
      connection_id: rating.connection_id,
    });
  }

  db.run(`DELETE FROM leaderboard_votes WHERE id = ?`, [existing.id]);
  return true;
}

export function resetLeaderboard(userId: string): void {
  const db = getDb();
  db.run(`DELETE FROM leaderboard_votes WHERE user_id = ?`, [userId]);
  db.run(`DELETE FROM leaderboard_roulette_votes WHERE user_id = ?`, [userId]);
  db.run(`DELETE FROM leaderboard_ratings WHERE user_id = ?`, [userId]);
}

export function listAliases(userId: string, providerScope?: string): LeaderboardAlias[] {
  const db = getDb();
  if (providerScope) {
    return db.query(
      `SELECT id, provider_scope, alias_key, canonical_key, display_name, updated_at
       FROM leaderboard_model_aliases
       WHERE user_id = ? AND provider_scope = ?
       ORDER BY provider_scope ASC, alias_key ASC`,
    ).all(userId, providerScope) as LeaderboardAlias[];
  }

  return db.query(
    `SELECT id, provider_scope, alias_key, canonical_key, display_name, updated_at
     FROM leaderboard_model_aliases
     WHERE user_id = ?
     ORDER BY provider_scope ASC, alias_key ASC`,
  ).all(userId) as LeaderboardAlias[];
}

export function upsertAlias(userId: string, input: {
  providerScope?: string;
  alias: string;
  canonical: string;
  displayName?: string | null;
}): LeaderboardAlias {
  const db = getDb();
  const providerScope = (input.providerScope || "*").trim() || "*";
  const aliasKey = normalizeModelId(input.alias);
  const canonicalKey = normalizeModelId(input.canonical);
  const displayName = typeof input.displayName === "string" && input.displayName.trim().length > 0
    ? input.displayName.trim()
    : null;

  if (!aliasKey || !canonicalKey) {
    throw new Error("alias and canonical model names are required");
  }

  db.run(
    `INSERT INTO leaderboard_model_aliases
     (user_id, provider_scope, alias_key, canonical_key, display_name, updated_at)
     VALUES (?, ?, ?, ?, ?, unixepoch())
     ON CONFLICT(user_id, provider_scope, alias_key)
     DO UPDATE SET canonical_key = excluded.canonical_key,
                   display_name = excluded.display_name,
                   updated_at = excluded.updated_at`,
    [userId, providerScope, aliasKey, canonicalKey, displayName],
  );

  const row = db.query(
    `SELECT id, provider_scope, alias_key, canonical_key, display_name, updated_at
     FROM leaderboard_model_aliases
     WHERE user_id = ? AND provider_scope = ? AND alias_key = ?`,
  ).get(userId, providerScope, aliasKey) as LeaderboardAlias;

  return row;
}

export function deleteAlias(userId: string, aliasId: number): boolean {
  const db = getDb();
  const result = db.run(
    `DELETE FROM leaderboard_model_aliases WHERE user_id = ? AND id = ?`,
    [userId, aliasId],
  );
  return result.changes > 0;
}

export function reprocessLeaderboardModels(userId: string): { updatedVotes: number; mergedRows: number } {
  const db = getDb();
  const settings = getLeaderboardSettings(userId);

  const votes = db.query(
    `SELECT id, provider, model, raw_model
     FROM leaderboard_votes
     WHERE user_id = ?`,
  ).all(userId) as Array<{ id: number; provider: string; model: string; raw_model: string | null }>;

  let updatedVotes = 0;
  for (const vote of votes) {
    const raw = vote.raw_model && vote.raw_model.trim().length > 0 ? vote.raw_model : vote.model;
    const identity = resolveCanonicalModel(userId, vote.provider, raw, settings);
    db.run(
      `UPDATE leaderboard_votes
       SET model = ?, raw_model = ?, canonical_model = ?
       WHERE id = ?`,
      [identity.displayModel, identity.rawModel, identity.canonicalModel, vote.id],
    );
    updatedVotes++;
  }

  const grouped = db.query(
    `SELECT provider, canonical_model,
            MIN(model) as model,
            MIN(raw_model) as raw_model,
            MAX(connection_id) as connection_id,
            ROUND(AVG(elo)) as elo,
            SUM(wins) as wins,
            SUM(losses) as losses,
            SUM(total_votes) as total_votes
     FROM leaderboard_ratings
     WHERE user_id = ?
     GROUP BY provider, canonical_model`,
  ).all(userId) as Array<{
    provider: string;
    canonical_model: string;
    model: string;
    raw_model: string;
    connection_id: string | null;
    elo: number;
    wins: number;
    losses: number;
    total_votes: number;
  }>;

  db.run(`DELETE FROM leaderboard_ratings WHERE user_id = ?`, [userId]);

  for (const row of grouped) {
    db.run(
      `INSERT INTO leaderboard_ratings
       (user_id, model, raw_model, canonical_model, provider, connection_id, elo, wins, losses, total_votes, confidence_score, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`,
      [
        userId,
        row.model,
        row.raw_model,
        row.canonical_model,
        row.provider,
        row.connection_id,
        row.elo,
        row.wins,
        row.losses,
        row.total_votes,
        clamp(Math.sqrt(row.total_votes || 0) / 10, 0, 1),
      ],
    );
  }

  return { updatedVotes, mergedRows: grouped.length };
}

export function getRoulettePair(userId: string, input: { provider?: string; connectionId?: string | null; useRouletteConnections?: boolean } = {}): RoulettePair | null {
  const settings = getLeaderboardSettings(userId);
  const entries = getLeaderboard(userId, {
    provider: input.provider,
    connectionId: input.connectionId || undefined,
    timeRange: "30d",
  });

  const pool = entries.filter((entry) => {
    if (input.useRouletteConnections && settings.rouletteConnectionIds.length > 0) {
      if (!entry.connection_id) return false;
      return settings.rouletteConnectionIds.includes(entry.connection_id);
    }
    return true;
  });

  if (pool.length < 2) return null;

  const leftIndex = Math.floor(Math.random() * pool.length);
  let rightIndex = Math.floor(Math.random() * (pool.length - 1));
  if (rightIndex >= leftIndex) rightIndex++;

  const left = pool[leftIndex];
  const right = pool[rightIndex];

  return {
    left: {
      model: left.model,
      raw_model: left.raw_model,
      canonical_model: left.canonical_model,
      provider: left.provider,
      elo: left.elo,
      wins: left.wins,
      losses: left.losses,
      total_votes: left.total_votes,
    },
    right: {
      model: right.model,
      raw_model: right.raw_model,
      canonical_model: right.canonical_model,
      provider: right.provider,
      elo: right.elo,
      wins: right.wins,
      losses: right.losses,
      total_votes: right.total_votes,
    },
    connection_id: input.connectionId ?? null,
    ranking_mode: settings.rankingMode,
    tie_breaker: RANK_TIE_BREAKER,
  };
}

export function castRouletteVote(userId: string, input: RouletteVoteInput): RouletteVoteResult {
  const db = getDb();
  const settings = getLeaderboardSettings(userId);
  if (!settings.enabled) throw new Error("Leaderboard voting is disabled.");

  ensureVoteRateLimit(userId, settings);

  const confidence = clamp(input.confidence ?? 1, 0.25, 2);

  const leftIdentity = resolveCanonicalModel(userId, input.leftProvider, input.leftModel, settings);
  const rightIdentity = resolveCanonicalModel(userId, input.rightProvider, input.rightModel, settings);

  let leftRating = getOrCreateRating(
    userId,
    input.leftProvider,
    leftIdentity.displayModel,
    leftIdentity.canonicalModel,
    input.connectionId ?? null,
  );
  let rightRating = getOrCreateRating(
    userId,
    input.rightProvider,
    rightIdentity.displayModel,
    rightIdentity.canonicalModel,
    input.connectionId ?? null,
  );

  let leftDelta = 0;
  let rightDelta = 0;

  if (input.winner !== "skip") {
    const leftActual: 0 | 1 = input.winner === "left" ? 1 : 0;
    const rightActual: 0 | 1 = input.winner === "right" ? 1 : 0;
    const leftWeight = computeDuplicateDamping(userId, input.leftProvider, leftIdentity.canonicalModel, settings);
    const rightWeight = computeDuplicateDamping(userId, input.rightProvider, rightIdentity.canonicalModel, settings);

    leftDelta = computeDelta(settings.rankingMode, leftRating.elo, rightRating.elo, leftActual, confidence, leftWeight);
    rightDelta = computeDelta(settings.rankingMode, rightRating.elo, leftRating.elo, rightActual, confidence, rightWeight);

    leftRating = {
      elo: leftRating.elo + leftDelta,
      wins: leftRating.wins + (leftActual === 1 ? 1 : 0),
      losses: leftRating.losses + (leftActual === 0 ? 1 : 0),
      total_votes: leftRating.total_votes + 1,
    };
    rightRating = {
      elo: rightRating.elo + rightDelta,
      wins: rightRating.wins + (rightActual === 1 ? 1 : 0),
      losses: rightRating.losses + (rightActual === 0 ? 1 : 0),
      total_votes: rightRating.total_votes + 1,
    };

    updateRating(userId, input.leftProvider, leftIdentity.canonicalModel, {
      ...leftRating,
      model: leftIdentity.displayModel,
      raw_model: leftIdentity.rawModel,
      connection_id: input.connectionId ?? null,
    });
    updateRating(userId, input.rightProvider, rightIdentity.canonicalModel, {
      ...rightRating,
      model: rightIdentity.displayModel,
      raw_model: rightIdentity.rawModel,
      connection_id: input.connectionId ?? null,
    });
  }

  db.run(
    `INSERT INTO leaderboard_roulette_votes
     (user_id, left_model, left_provider, left_canonical_model,
      right_model, right_provider, right_canonical_model,
      winner, confidence, ranking_mode, left_elo_delta, right_elo_delta, connection_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      leftIdentity.displayModel,
      input.leftProvider,
      leftIdentity.canonicalModel,
      rightIdentity.displayModel,
      input.rightProvider,
      rightIdentity.canonicalModel,
      input.winner,
      confidence,
      settings.rankingMode,
      leftDelta,
      rightDelta,
      input.connectionId ?? null,
    ],
  );

  const entries = getLeaderboard(userId);
  const left = entries.find((entry) => entry.provider === input.leftProvider && entry.canonical_model === leftIdentity.canonicalModel);
  const right = entries.find((entry) => entry.provider === input.rightProvider && entry.canonical_model === rightIdentity.canonicalModel);

  if (!left || !right) {
    throw new Error("Failed to resolve updated leaderboard entries.");
  }

  return { left, right };
}

export function exportLeaderboardData(userId: string): {
  settings: LeaderboardSettings;
  ratings: any[];
  votes: any[];
  aliases: LeaderboardAlias[];
  roulette_votes: any[];
  exported_at: number;
} {
  const db = getDb();
  return {
    settings: getLeaderboardSettings(userId),
    ratings: db.query(`SELECT * FROM leaderboard_ratings WHERE user_id = ?`).all(userId) as any[],
    votes: db.query(`SELECT * FROM leaderboard_votes WHERE user_id = ?`).all(userId) as any[],
    aliases: listAliases(userId),
    roulette_votes: db.query(`SELECT * FROM leaderboard_roulette_votes WHERE user_id = ?`).all(userId) as any[],
    exported_at: Math.floor(Date.now() / 1000),
  };
}

export function importLeaderboardData(userId: string, payload: {
  settings?: Partial<LeaderboardSettings>;
  ratings?: any[];
  votes?: any[];
  aliases?: Array<{ provider_scope?: string; alias_key?: string; canonical_key?: string; display_name?: string | null }>;
  roulette_votes?: any[];
}): void {
  const db = getDb();

  if (payload.settings) {
    putLeaderboardSettings(userId, payload.settings);
  }

  const tx = db.transaction(() => {
    if (Array.isArray(payload.aliases)) {
      for (const alias of payload.aliases) {
        if (!alias.alias_key || !alias.canonical_key) continue;
        upsertAlias(userId, {
          providerScope: alias.provider_scope || "*",
          alias: alias.alias_key,
          canonical: alias.canonical_key,
          displayName: alias.display_name ?? null,
        });
      }
    }

    if (Array.isArray(payload.ratings)) {
      for (const row of payload.ratings) {
        if (!row || typeof row !== "object") continue;
        db.run(
          `INSERT INTO leaderboard_ratings
           (user_id, model, raw_model, canonical_model, provider, connection_id, elo, wins, losses, total_votes, confidence_score, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, model, provider)
           DO UPDATE SET raw_model = excluded.raw_model,
                         canonical_model = excluded.canonical_model,
                         connection_id = excluded.connection_id,
                         elo = excluded.elo,
                         wins = excluded.wins,
                         losses = excluded.losses,
                         total_votes = excluded.total_votes,
                         confidence_score = excluded.confidence_score,
                         updated_at = excluded.updated_at`,
          [
            userId,
            row.model,
            row.raw_model ?? row.model,
            row.canonical_model ?? normalizeModelId(row.model || ""),
            row.provider,
            row.connection_id ?? null,
            Number(row.elo) || DEFAULT_ELO,
            Number(row.wins) || 0,
            Number(row.losses) || 0,
            Number(row.total_votes) || 0,
            Number(row.confidence_score) || 0,
            Number(row.updated_at) || Math.floor(Date.now() / 1000),
          ],
        );
      }
    }

    if (Array.isArray(payload.votes)) {
      for (const row of payload.votes) {
        if (!row || typeof row !== "object") continue;
        db.run(
          `INSERT OR REPLACE INTO leaderboard_votes
           (id, user_id, message_id, swipe_id, chat_id, model, raw_model, canonical_model,
            provider, connection_id, vote, ranking_mode, confidence, effect_weight, elo_delta, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            row.id ?? null,
            userId,
            row.message_id,
            Number(row.swipe_id) || 0,
            row.chat_id,
            row.model,
            row.raw_model ?? row.model,
            row.canonical_model ?? normalizeModelId(row.model || ""),
            row.provider,
            row.connection_id ?? null,
            Number(row.vote) >= 0 ? 1 : -1,
            row.ranking_mode || "classic",
            Number(row.confidence) || 1,
            Number(row.effect_weight) || 1,
            Number(row.elo_delta) || 0,
            Number(row.created_at) || Math.floor(Date.now() / 1000),
          ],
        );
      }
    }

    if (Array.isArray(payload.roulette_votes)) {
      for (const row of payload.roulette_votes) {
        if (!row || typeof row !== "object") continue;
        db.run(
          `INSERT OR REPLACE INTO leaderboard_roulette_votes
           (id, user_id, left_model, left_provider, left_canonical_model,
            right_model, right_provider, right_canonical_model,
            winner, confidence, ranking_mode, left_elo_delta, right_elo_delta, connection_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            row.id ?? null,
            userId,
            row.left_model,
            row.left_provider,
            row.left_canonical_model ?? normalizeModelId(row.left_model || ""),
            row.right_model,
            row.right_provider,
            row.right_canonical_model ?? normalizeModelId(row.right_model || ""),
            row.winner || "skip",
            Number(row.confidence) || 1,
            row.ranking_mode || "classic",
            Number(row.left_elo_delta) || 0,
            Number(row.right_elo_delta) || 0,
            row.connection_id ?? null,
            Number(row.created_at) || Math.floor(Date.now() / 1000),
          ],
        );
      }
    }
  });

  tx();
}
