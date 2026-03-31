import { Hono } from "hono";
import * as dreamWeaverSvc from "../services/dream-weaver/dream-weaver.service";

const app = new Hono();

// Create session
app.post("/sessions", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const session = dreamWeaverSvc.createSession(userId, body);
  return c.json(session, 201);
});

// List sessions
app.get("/sessions", (c) => {
  const userId = c.get("userId");
  const sessions = dreamWeaverSvc.listSessions(userId);
  return c.json(sessions);
});

// Get session
app.get("/sessions/:id", (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.param("id");
  const session = dreamWeaverSvc.getSession(userId, sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);
  return c.json(session);
});

// Update session
app.put("/sessions/:id", async (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.param("id");
  const body = await c.req.json();
  const session = dreamWeaverSvc.updateSession(userId, sessionId, body);
  return c.json(session);
});

// Generate draft
app.post("/sessions/:id/generate", async (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.param("id");
  const draft = await dreamWeaverSvc.generateDraft(userId, sessionId);
  return c.json(draft);
});

// Finalize
app.post("/sessions/:id/finalize", async (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.param("id");
  const result = await dreamWeaverSvc.finalize(userId, sessionId);
  return c.json(result);
});

// Delete session
app.delete("/sessions/:id", (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.param("id");
  dreamWeaverSvc.deleteSession(userId, sessionId);
  return c.json({ success: true });
});

export { app as dreamWeaverRoutes };
