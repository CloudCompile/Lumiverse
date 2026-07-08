import { Hono } from "hono";
import * as svc from "../services/leaderboard.service";

const app = new Hono();

function asBoolean(input: string | undefined): boolean {
  if (!input) return false;
  return input === "1" || input.toLowerCase() === "true";
}

/** GET / — ranked leaderboard for the authenticated user */
app.get("/", (c) => {
  const userId = c.get("userId");
  const provider = c.req.query("provider") || undefined;
  const connectionId = c.req.query("connectionId") || undefined;
  const chatId = c.req.query("chatId") || undefined;
  const timeRange = c.req.query("timeRange") as "24h" | "7d" | "30d" | "all" | undefined;

  return c.json(svc.getLeaderboard(userId, { provider, connectionId, chatId, timeRange }));
});

/** GET /settings — leaderboard feature settings */
app.get("/settings", (c) => {
  const userId = c.get("userId");
  return c.json(svc.getLeaderboardSettings(userId));
});

/** PUT /settings — update leaderboard feature settings */
app.put("/settings", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  return c.json(svc.putLeaderboardSettings(userId, body || {}));
});

/** GET /votes?chatId=... — all votes for a chat (used to highlight thumbs) */
app.get("/votes", (c) => {
  const userId = c.get("userId");
  const chatId = c.req.query("chatId");
  if (!chatId) return c.json({ error: "chatId is required" }, 400);
  return c.json(svc.getVotesForChat(userId, chatId));
});

/** GET /votes/:messageId/:swipeId — single vote lookup */
app.get("/votes/:messageId/:swipeId", (c) => {
  const userId = c.get("userId");
  const messageId = c.req.param("messageId");
  const swipeId = Number(c.req.param("swipeId"));
  if (Number.isNaN(swipeId)) return c.json({ error: "Invalid swipeId" }, 400);
  const vote = svc.getVoteForMessage(userId, messageId, swipeId);
  return c.json(vote ?? { vote: 0 });
});

/** POST /vote — cast or change a vote */
app.post("/vote", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const { messageId, swipeId, chatId, model, provider, connectionId, vote, confidence } = body;
  if (!messageId || swipeId == null || !chatId || !model || !provider) {
    return c.json({ error: "messageId, swipeId, chatId, model, and provider are required" }, 400);
  }
  if (vote !== 1 && vote !== -1) {
    return c.json({ error: "vote must be 1 (thumbs up) or -1 (thumbs down)" }, 400);
  }

  try {
    const result = svc.castVote(userId, {
      messageId,
      swipeId: Number(swipeId),
      chatId,
      model,
      provider,
      connectionId: connectionId ?? null,
      vote,
      confidence,
    });
    return c.json(result);
  } catch (err: any) {
    if (err instanceof svc.LeaderboardRateLimitedError) {
      return c.json({ error: err.message }, err.status);
    }
    return c.json({ error: err?.message || "Failed to cast vote" }, 400);
  }
});

/** DELETE /vote/:messageId/:swipeId — remove a vote */
app.delete("/vote/:messageId/:swipeId", (c) => {
  const userId = c.get("userId");
  const messageId = c.req.param("messageId");
  const swipeId = Number(c.req.param("swipeId"));
  if (Number.isNaN(swipeId)) return c.json({ error: "Invalid swipeId" }, 400);
  const removed = svc.removeVote(userId, messageId, swipeId);
  if (!removed) return c.json({ error: "No vote found" }, 404);
  return c.json({ success: true });
});

/** GET /aliases — list alias map rows */
app.get("/aliases", (c) => {
  const userId = c.get("userId");
  const providerScope = c.req.query("providerScope") || undefined;
  return c.json(svc.listAliases(userId, providerScope));
});

/** POST /aliases — split/merge aliases */
app.post("/aliases", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const { providerScope, alias, canonical, displayName } = body;
  if (!alias || !canonical) return c.json({ error: "alias and canonical are required" }, 400);
  const row = svc.upsertAlias(userId, { providerScope, alias, canonical, displayName });
  return c.json(row);
});

/** DELETE /aliases/:id — remove an alias mapping */
app.delete("/aliases/:id", (c) => {
  const userId = c.get("userId");
  const aliasId = Number(c.req.param("id"));
  if (!Number.isFinite(aliasId)) return c.json({ error: "Invalid alias id" }, 400);
  const ok = svc.deleteAlias(userId, aliasId);
  if (!ok) return c.json({ error: "Alias not found" }, 404);
  return c.json({ success: true });
});

/** POST /reprocess — reprocess historical rows after alias updates */
app.post("/reprocess", (c) => {
  const userId = c.get("userId");
  return c.json(svc.reprocessLeaderboardModels(userId));
});

/** GET /roulette — fetch a random head-to-head pair */
app.get("/roulette", (c) => {
  const userId = c.get("userId");
  const provider = c.req.query("provider") || undefined;
  const connectionId = c.req.query("connectionId") || undefined;
  const useRouletteConnections = asBoolean(c.req.query("useRouletteConnections"));

  const pair = svc.getRoulettePair(userId, {
    provider,
    connectionId,
    useRouletteConnections,
  });

  if (!pair) return c.json({ error: "Not enough leaderboard entries for roulette" }, 404);
  return c.json(pair);
});

/** POST /roulette/vote — vote for left/right/skip in roulette mode */
app.post("/roulette/vote", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const {
    leftModel,
    leftProvider,
    rightModel,
    rightProvider,
    winner,
    confidence,
    connectionId,
  } = body;

  if (!leftModel || !leftProvider || !rightModel || !rightProvider) {
    return c.json({ error: "left/right model and provider are required" }, 400);
  }

  if (winner !== "left" && winner !== "right" && winner !== "skip") {
    return c.json({ error: "winner must be left, right, or skip" }, 400);
  }

  try {
    const result = svc.castRouletteVote(userId, {
      leftModel,
      leftProvider,
      rightModel,
      rightProvider,
      winner,
      confidence,
      connectionId: connectionId ?? null,
    });
    return c.json(result);
  } catch (err: any) {
    if (err instanceof svc.LeaderboardRateLimitedError) {
      return c.json({ error: err.message }, err.status);
    }
    return c.json({ error: err?.message || "Failed to cast roulette vote" }, 400);
  }
});

/** GET /export — export leaderboard data */
app.get("/export", (c) => {
  const userId = c.get("userId");
  return c.json(svc.exportLeaderboardData(userId));
});

/** POST /import — import leaderboard data */
app.post("/import", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  svc.importLeaderboardData(userId, body || {});
  return c.json({ success: true });
});

/** POST /reset — reset all leaderboard data */
app.post("/reset", (c) => {
  const userId = c.get("userId");
  svc.resetLeaderboard(userId);
  return c.json({ success: true });
});

export const leaderboardRoutes = app;
