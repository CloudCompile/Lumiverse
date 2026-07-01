import { Hono } from "hono";
import * as svc from "../services/leaderboard.service";

const app = new Hono();

/** GET / — ranked leaderboard for the authenticated user */
app.get("/", (c) => {
  const userId = c.get("userId");
  return c.json(svc.getLeaderboard(userId));
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
  const { messageId, swipeId, chatId, model, provider, connectionId, vote } = body;
  if (!messageId || swipeId == null || !chatId || !model || !provider) {
    return c.json({ error: "messageId, swipeId, chatId, model, and provider are required" }, 400);
  }
  if (vote !== 1 && vote !== -1) {
    return c.json({ error: "vote must be 1 (thumbs up) or -1 (thumbs down)" }, 400);
  }
  const result = svc.castVote(userId, {
    messageId,
    swipeId: Number(swipeId),
    chatId,
    model,
    provider,
    connectionId: connectionId ?? null,
    vote,
  });
  return c.json(result);
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

/** POST /reset — reset all leaderboard data */
app.post("/reset", (c) => {
  const userId = c.get("userId");
  svc.resetLeaderboard(userId);
  return c.json({ success: true });
});

export const leaderboardRoutes = app;
