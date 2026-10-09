import { Hono } from "hono";
import { getVapidPublicKey } from "../crypto/vapid";
import * as pushSvc from "../services/push.service";
import type { CreatePushSubscriptionInput } from "../types/push";
import { validateHost, SSRFError } from "../utils/safe-fetch";

const app = new Hono();

app.get("/vapid-public-key", (c) => {
  return c.json({ publicKey: getVapidPublicKey() });
});

app.get("/subscriptions", (c) => {
  const userId = c.get("userId");
  return c.json(pushSvc.listNotificationDestinations(userId));
});

app.get("/desktop/info", (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({ serverInstanceId: pushSvc.getDesktopNotificationServerInstanceId() });
});

app.post("/desktop", async (c) => {
  c.header("Cache-Control", "no-store");
  const userId = c.get("userId");
  const body = await c.req.json();
  try {
    return c.json(pushSvc.createDesktopDestination(userId, body), 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid desktop destination" }, 400);
  }
});

app.post("/subscriptions", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json()) as CreatePushSubscriptionInput;

  if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
    return c.json({ error: "Missing endpoint or keys" }, 400);
  }

  // Validate the push endpoint: real push services use HTTPS, and must not
  // resolve to private/internal addresses (SSRF protection — the stored
  // endpoint is POSTed to on every GENERATION_ENDED event).
  let parsed: URL;
  try {
    parsed = new URL(body.endpoint);
  } catch {
    return c.json({ error: "endpoint is not a valid URL" }, 400);
  }
  if (parsed.protocol !== "https:") {
    return c.json({ error: "Push endpoint must use HTTPS" }, 400);
  }
  try {
    await validateHost(parsed.hostname);
  } catch (err: any) {
    if (err instanceof SSRFError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }

  const sub = pushSvc.createSubscription(userId, body);
  return c.json(sub, 201);
});

app.delete("/subscriptions/:id", (c) => {
  const userId = c.get("userId");
  const deleted = pushSvc.deleteNotificationDestination(userId, c.req.param("id"));
  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

app.post("/subscriptions/test", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => ({})) as { destinationId?: unknown };
  const destinationId = typeof body.destinationId === "string" ? body.destinationId : undefined;
  const result = await pushSvc.dispatchGenerationEndedPush(userId, {
    content: "Automatic push notifications are working!",
  }, { bypassPresence: true, destinationId });
  return c.json({ success: result.sent > 0, ...result });
});

export { app as pushRoutes };
