import { Hono } from "hono";
import * as connSvc from "../services/connections.service";
import * as svc from "../services/pollinations.service";
import { describeProviderError } from "../utils/provider-errors";

const app = new Hono();

/**
 * Start the OAuth device-authorization flow for BYOP (Bring Your Own Pollen).
 * The backend keeps the App Key server-side and only returns the user-facing
 * verification details, so the key is never exposed to the browser.
 */
app.post("/device/start", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => ({}));
  try {
    const result = await svc.startDeviceAuth(userId, {
      models: body?.models ? String(body.models) : undefined,
      budget: typeof body?.budget === "number" ? body.budget : undefined,
      expiry: typeof body?.expiry === "number" ? body.expiry : undefined,
      permissions: body?.permissions ? String(body.permissions) : undefined,
    });
    return c.json(result);
  } catch (err) {
    return c.json({ error: describeProviderError(err, "Failed to start Pollinations sign-in") }, 502);
  }
});

/**
 * Poll once for the user-authorized key. Returns `{ status: "pending" }` until
 * the user approves, then `{ status: "complete", api_key, profile }` after
 * storing the key on the connection (auto-creating it when none was supplied).
 */
app.post("/device/poll", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => ({}));
  const deviceCode = String(body?.device_code || "").trim();
  if (!deviceCode) return c.json({ error: "device_code is required" }, 400);

  const connectionId = body?.connection_id ? String(body.connection_id) : undefined;
  const connectionName = body?.connection_name ? String(body.connection_name) : undefined;
  if (!connectionId && !connectionName) return c.json({ error: "connection_id or connection_name is required" }, 400);

  if (connectionId) {
    const conn = connSvc.getConnection(userId, connectionId);
    if (!conn) return c.json({ error: "Connection not found" }, 404);
    if (conn.provider !== "pollinations") return c.json({ error: "Connection is not a Pollinations profile" }, 400);
  }

  try {
    const result = await svc.pollDeviceAuth(deviceCode);
    if (result.status === "pending") return c.json({ status: "pending" });

    let id = connectionId;
    let created = false;
    if (!id) {
      const profile = await connSvc.createConnection(userId, {
        name: connectionName || "Pollinations",
        provider: "pollinations",
      });
      id = profile.id;
      created = true;
    }
    await connSvc.setConnectionApiKey(userId, id, result.api_key);
    const profile = connSvc.getConnection(userId, id)!;
    return c.json({ status: "complete", created, connection_id: id, profile });
  } catch (err) {
    return c.json({ error: describeProviderError(err, "Pollinations sign-in failed") }, 502);
  }
});

/**
 * Account balance and usage for a connection's user-authorized key. Requires
 * the `usage` scope to have been granted; section-level errors are reported
 * inline so a balance-only key still shows what it can.
 */
app.get("/account", async (c) => {
  c.header("Cache-Control", "private, no-store");
  const connectionId = c.req.query("connection_id");
  if (!connectionId) return c.json({ error: "connection_id is required" }, 400);
  try {
    return c.json(await svc.fetchAccountUsage(c.get("userId"), connectionId));
  } catch (err) {
    const status = err instanceof svc.PollinationsConnectionError ? err.status : 502;
    return c.json({ error: describeProviderError(err, "Failed to fetch Pollinations account") }, status);
  }
});

export { app as pollinationsRoutes };
