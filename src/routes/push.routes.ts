import { Hono } from "hono";
import { getVapidPublicKey } from "../crypto/vapid";
import * as pushSvc from "../services/push.service";
import type { CreatePushSubscriptionInput } from "../types/push";

const app = new Hono();

app.get("/vapid-public-key", (c) => {
  return c.json({ publicKey: getVapidPublicKey() });
});

app.get("/subscriptions", (c) => {
  const userId = c.get("userId");
  return c.json(pushSvc.listSubscriptions(userId));
});

app.post("/subscriptions", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json()) as CreatePushSubscriptionInput;

  if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
    return c.json({ error: "Missing endpoint or keys" }, 400);
  }

  const sub = pushSvc.createSubscription(userId, body);
  return c.json(sub, 201);
});

app.delete("/subscriptions/:id", (c) => {
  const userId = c.get("userId");
  const deleted = pushSvc.deleteSubscription(userId, c.req.param("id"));
  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

app.post("/subscriptions/test", async (c) => {
  const userId = c.get("userId");
  const sent = await pushSvc.sendPushToUser(userId, {
    title: "Lumiverse",
    body: "Push notifications are working!",
    tag: "test",
    data: { url: "/" },
  });
  return c.json({ success: sent > 0, sent });
});

export { app as pushRoutes };
