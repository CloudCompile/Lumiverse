import { Hono } from "hono";
import * as sessionSvc from "../services/card-agent/session.service";
import * as proposalSvc from "../services/card-agent/proposal.service";
import * as revisionSvc from "../services/card-agent/revision.service";

/**
 * Card Agent routes.
 *
 * Two surfaces: agent sessions (conversation + proposals) and the review queue
 * that applies or rejects those proposals.
 */
export const cardAgentRoutes = new Hono();

function errorStatus(err: unknown): 400 | 409 {
  return err instanceof revisionSvc.StaleCharacterError ? 409 : 400;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

// ─── Sessions ──────────────────────────────────────────────────────────────

cardAgentRoutes.post("/sessions", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json().catch(() => ({}))) as {
    title?: string;
    connectionId?: string | null;
    model?: string | null;
    scopeMode?: "all" | "selection";
    scopeCharacterIds?: string[];
  };
  try {
    return c.json(sessionSvc.createSession(userId, body), 201);
  } catch (err) {
    return c.json({ error: errorMessage(err, "Could not create the session") }, 400);
  }
});

cardAgentRoutes.get("/sessions", (c) => {
  const userId = c.get("userId");
  return c.json(sessionSvc.listSessions(userId));
});

cardAgentRoutes.get("/sessions/:id", (c) => {
  const userId = c.get("userId");
  const session = sessionSvc.getSession(userId, c.req.param("id"));
  if (!session) return c.json({ error: "Session not found" }, 404);
  return c.json(session);
});

cardAgentRoutes.patch("/sessions/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  if (!sessionSvc.getSession(userId, id)) return c.json({ error: "Session not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as Parameters<typeof sessionSvc.updateSession>[2];
  try {
    const updated = sessionSvc.updateSession(userId, id, body);
    if (!updated) return c.json({ error: "Session not found" }, 404);
    return c.json(updated);
  } catch (err) {
    return c.json({ error: errorMessage(err, "Could not update the session") }, 400);
  }
});

cardAgentRoutes.delete("/sessions/:id", (c) => {
  const userId = c.get("userId");
  const removed = sessionSvc.deleteSession(userId, c.req.param("id"));
  if (!removed) return c.json({ error: "Session not found" }, 404);
  return c.json({ ok: true });
});

cardAgentRoutes.get("/sessions/:id/messages", (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  if (!sessionSvc.getSession(userId, id)) return c.json({ error: "Session not found" }, 404);
  return c.json(sessionSvc.listMessages(userId, id));
});

cardAgentRoutes.get("/sessions/:id/proposals", (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  if (!sessionSvc.getSession(userId, id)) return c.json({ error: "Session not found" }, 404);
  const status = c.req.query("status") as proposalSvc.ProposalStatus | undefined;
  const proposals = proposalSvc.listProposals(userId, { sessionId: id, status });
  return c.json(
    proposals.map((p) => ({ ...p, diff: proposalSvc.describeProposal(userId, p) })),
  );
});

/**
 * Run one turn.
 *
 * The reply, the tool activity, and any proposals filed are returned together
 * so the UI can render the whole turn from a single response.
 */
cardAgentRoutes.post("/sessions/:id/turns", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { message?: string };
  const message = typeof body.message === "string" ? body.message : "";

  const signal = c.req.raw.signal;
  try {
    const result = await sessionSvc.runTurn(userId, id, message, { signal });
    return c.json(result);
  } catch (err) {
    return c.json({ error: errorMessage(err, "The turn failed") }, 400);
  }
});

// ─── Review queue ──────────────────────────────────────────────────────────

cardAgentRoutes.get("/proposals", (c) => {
  const userId = c.get("userId");
  const status = c.req.query("status") as proposalSvc.ProposalStatus | undefined;
  const characterId = c.req.query("characterId") || undefined;
  const sessionId = c.req.query("sessionId") || undefined;
  const proposals = proposalSvc.listProposals(userId, { status, characterId, sessionId });
  return c.json(
    proposals.map((p) => ({ ...p, diff: proposalSvc.describeProposal(userId, p) })),
  );
});

/**
 * Batch-apply every pending proposal, optionally scoped to one session.
 *
 * Registered before `/proposals/:id` — Hono matches in order, and the
 * parameterized route would otherwise capture "apply-batch" as an id.
 */
cardAgentRoutes.post("/proposals/apply-batch", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json().catch(() => ({}))) as {
    sessionId?: string;
    characterIds?: string[];
  };
  const result = proposalSvc.applyProposalBatch(userId, {
    sessionId: body.sessionId,
    characterIds: body.characterIds,
  });
  return c.json(result);
});

cardAgentRoutes.get("/proposals/:id", (c) => {
  const userId = c.get("userId");
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "Invalid proposal id" }, 400);
  const proposal = proposalSvc.getProposal(userId, id);
  if (!proposal) return c.json({ error: "Proposal not found" }, 404);
  return c.json({ ...proposal, diff: proposalSvc.describeProposal(userId, proposal) });
});

cardAgentRoutes.post("/proposals/:id/apply", (c) => {
  const userId = c.get("userId");
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "Invalid proposal id" }, 400);
  try {
    const result = proposalSvc.applyProposal(userId, id);
    return c.json({
      character: result.character,
      revision: result.revision,
      proposal: result.proposal,
    });
  } catch (err) {
    return c.json({ error: errorMessage(err, "Could not apply the proposal") }, errorStatus(err));
  }
});

cardAgentRoutes.post("/proposals/:id/reject", (c) => {
  const userId = c.get("userId");
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "Invalid proposal id" }, 400);
  try {
    return c.json(proposalSvc.rejectProposal(userId, id));
  } catch (err) {
    return c.json({ error: errorMessage(err, "Could not reject the proposal") }, errorStatus(err));
  }
});

// ─── Revisions ─────────────────────────────────────────────────────────────

cardAgentRoutes.get("/characters/:characterId/revisions", (c) => {
  const userId = c.get("userId");
  const characterId = c.req.param("characterId");
  const limit = Number(c.req.query("limit") ?? 50);
  return c.json(
    revisionSvc.listRevisions(userId, characterId, Number.isFinite(limit) ? limit : 50),
  );
});

cardAgentRoutes.get("/characters/:characterId/revisions/:revisionId", (c) => {
  const userId = c.get("userId");
  const characterId = c.req.param("characterId");
  const revisionId = Number(c.req.param("revisionId"));
  if (!Number.isFinite(revisionId)) return c.json({ error: "Invalid revision id" }, 400);
  const revision = revisionSvc.getRevision(userId, characterId, revisionId);
  if (!revision) return c.json({ error: "Revision not found" }, 404);
  return c.json(revision);
});

cardAgentRoutes.post("/characters/:characterId/revisions/:revisionId/revert", (c) => {
  const userId = c.get("userId");
  const characterId = c.req.param("characterId");
  const revisionId = Number(c.req.param("revisionId"));
  if (!Number.isFinite(revisionId)) return c.json({ error: "Invalid revision id" }, 400);
  try {
    const result = revisionSvc.revertToRevision(userId, characterId, revisionId);
    return c.json(result);
  } catch (err) {
    return c.json({ error: errorMessage(err, "Could not revert the revision") }, errorStatus(err));
  }
});
