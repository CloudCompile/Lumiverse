import { Hono } from "hono";
import * as charactersSvc from "../services/characters.service";
import * as proposalSvc from "../services/card-agent/proposal.service";
import * as revisionSvc from "../services/card-agent/revision.service";

/**
 * Card Creator routes.
 *
 * The creator is a normal character, so most of its surface is the ordinary
 * chat API — a chat is created against it and turns stream through the normal
 * generation path. What lives here is only what chat does not cover:
 *
 *  - resolving which character *is* the creator, so the UI can pin it
 *  - reading the proposals filed inside one chat, to render them inline
 *  - applying or rejecting those proposals
 *
 * Applying and rejecting deliberately reuse the review-queue endpoints'
 * service layer rather than reimplementing them, so the stale-card check and
 * revision bookkeeping behave identically.
 */
export const cardCreatorRoutes = new Hono();

function errorStatus(err: unknown): 400 | 409 {
  return err instanceof revisionSvc.StaleCharacterError ? 409 : 400;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/**
 * The caller's Card Creator, created on demand.
 *
 * Seeding normally happens at signup or startup; this is the backstop for an
 * account that predates both and has not been backfilled yet.
 */
cardCreatorRoutes.get("/creator", (c) => {
  const userId = c.get("userId");
  const character = charactersSvc.ensureCardCreator(userId);
  return c.json({ character });
});

cardCreatorRoutes.get("/proposals", (c) => {
  const userId = c.get("userId");
  const chatId = c.req.query("chatId") || undefined;
  const status = c.req.query("status") as proposalSvc.ProposalStatus | undefined;
  if (!chatId) return c.json({ error: "chatId is required" }, 400);
  const proposals = proposalSvc.listProposals(userId, { chatId, status });
  return c.json(
    proposals.map((proposal) => ({
      ...proposal,
      diff: proposalSvc.describeProposal(userId, proposal),
    })),
  );
});

cardCreatorRoutes.get("/proposals/:id", (c) => {
  const userId = c.get("userId");
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "Invalid proposal id" }, 400);
  const proposal = proposalSvc.getProposal(userId, id);
  if (!proposal) return c.json({ error: "Proposal not found" }, 404);
  return c.json({ ...proposal, diff: proposalSvc.describeProposal(userId, proposal) });
});

cardCreatorRoutes.post("/proposals/:id/apply", (c) => {
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

cardCreatorRoutes.post("/proposals/:id/reject", (c) => {
  const userId = c.get("userId");
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "Invalid proposal id" }, 400);
  try {
    return c.json(proposalSvc.rejectProposal(userId, id));
  } catch (err) {
    return c.json({ error: errorMessage(err, "Could not reject the proposal") }, errorStatus(err));
  }
});
