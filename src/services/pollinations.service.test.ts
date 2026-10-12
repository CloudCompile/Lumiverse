import { afterEach, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import * as connSvc from "./connections.service";
import * as secretsSvc from "./secrets.service";
import { fetchAccountUsage, fetchDailyUsage, pollDeviceAuth, startDeviceAuth } from "./pollinations.service";
import { pollinationsRoutes } from "../routes/pollinations.routes";

const spies: { mockRestore(): void }[] = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });
function spy<T extends object, K extends keyof T>(target: T, key: K) {
  const result = spyOn(target, key);
  spies.push(result);
  return result;
}
function mockConnection(provider = "pollinations") {
  spy(connSvc, "getConnection").mockImplementation(((userId: string, id: string) => userId === "alice" && id === "connection" ? { id, provider, api_url: "" } : null) as any);
  spy(connSvc, "resolvePollinationsAppKey").mockResolvedValue("pk_test");
  spy(secretsSvc, "getSecret").mockResolvedValue("sk_user");
}

test("device start sends the App Key as client_id and mirrors restriction params", async () => {
  mockConnection();
  const fetchSpy = spy(globalThis, "fetch").mockResolvedValue(Response.json({
    device_code: "device", user_code: "ABCD-1234", verification_uri: "https://enter.pollinations.ai/device",
    verification_uri_complete: "https://enter.pollinations.ai/device?user_code=ABCD-1234", expires_in: 1800, interval: 5,
  }));
  const result = await startDeviceAuth("alice", { models: "openai/gpt-5.4-nano", budget: 10, expiry: 7, permissions: "usage" });
  expect(String(fetchSpy.mock.calls[0][0])).toBe("https://enter.pollinations.ai/api/device/code");
  expect(fetchSpy.mock.calls[0][1]?.method).toBe("POST");
  expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toEqual({
    client_id: "pk_test", models: "openai/gpt-5.4-nano", budget: 10, expiry: 7, scope: "usage",
  });
  expect(result.device_code).toBe("device");
});

test("device start omits the App Key when none is configured", async () => {
  mockConnection();
  spy(connSvc, "resolvePollinationsAppKey").mockResolvedValue("");
  const fetchSpy = spy(globalThis, "fetch").mockResolvedValue(Response.json({ device_code: "d", user_code: "u", verification_uri: "https://enter.pollinations.ai/device" }));
  await startDeviceAuth("alice", {});
  expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toEqual({});
});

test("device polling is pending until approved, then returns the scoped key", async () => {
  const fetchSpy = spy(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ error: "authorization_pending" }))
    .mockResolvedValueOnce(Response.json({ access_token: "sk_minted", token_type: "bearer" }));
  expect(await pollDeviceAuth("device")).toEqual({ status: "pending" });
  expect(await pollDeviceAuth("device")).toEqual({ status: "complete", api_key: "sk_minted" });
  expect(fetchSpy.mock.calls[1][1]?.body).toBe(JSON.stringify({ device_code: "device" }));
});

test("device polling surfaces an expired request distinctly", async () => {
  spy(globalThis, "fetch").mockResolvedValue(Response.json({ error: "expired_token", error_description: "expired" }));
  await expect(pollDeviceAuth("device")).rejects.toThrow("expired");
});

test("daily usage folds the per-key/model/billing rows into per-day totals", async () => {
  const fetchSpy = spy(globalThis, "fetch").mockResolvedValue(Response.json({
    usage: [
      { date: "2026-10-01", api_key_id: "k1", model: "a", meter_source: "tier", requests: 2, cost_usd: 0.5 },
      { date: "2026-10-01", api_key_id: "k1", model: "b", meter_source: "pack", requests: 1, cost_usd: 0.25 },
      { date: "2026-09-30", api_key_id: "k1", model: "a", meter_source: "tier", requests: 4, cost_usd: 1 },
    ],
    count: 3,
  }));
  const usage = await fetchDailyUsage("placeholder", 31, new Date("2026-10-01T12:00:00Z"));
  const url = new URL(String(fetchSpy.mock.calls[0][0]));
  expect(url.origin + url.pathname).toBe("https://gen.pollinations.ai/account/usage/daily");
  expect(url.searchParams.get("days")).toBe("31");
  expect(usage.daily).toEqual([
    { date: "2026-09-30", requests: 4, cost_usd: 1 },
    { date: "2026-10-01", requests: 3, cost_usd: 0.75 },
  ]);
  expect(usage.today_requests).toBe(3);
  expect(usage.today_cost_usd).toBeCloseTo(0.75);
  expect(usage.month_cost_usd).toBeCloseTo(0.75);
});

test("balance and usage fetch in parallel and report section errors independently", async () => {
  mockConnection();
  spy(globalThis, "fetch").mockImplementation((async (url) => String(url).includes("balance")
    ? Response.json({ balance: 12.5, accountBalance: { total: 20, tier: 5, paid: 15 } })
    : Response.json({ success: false, error: { message: "missing account:usage permission" } }, { status: 403 })) as typeof fetch);
  const account = await fetchAccountUsage("alice", "connection");
  expect(account.balance).toEqual({ balance: 12.5, account_balance: { total: 20, tier: 5, paid: 15 } });
  expect(account.usage).toBeNull();
  expect(account.errors.usage).toContain("account:usage permission");
});

test("a missing connection key is a typed 400 rather than a provider call", async () => {
  spy(connSvc, "getConnection").mockImplementation((() => null) as any);
  await expect(fetchAccountUsage("alice", "missing")).rejects.toMatchObject({ status: 404 });
});

// ── Routes ───────────────────────────────────────────────────────────────────

function routes(userId = "alice") {
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("userId", userId); await next(); });
  app.route("/pollinations", pollinationsRoutes);
  return app;
}

test("routes reject another user's connection before accessing credentials or upstream", async () => {
  mockConnection();
  const fetchSpy = spy(globalThis, "fetch");
  const app = routes("bob");
  expect((await app.request("/pollinations/account?connection_id=connection")).status).toBe(404);
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("routes validate required inputs", async () => {
  mockConnection("openrouter");
  const app = routes();
  expect((await app.request("/pollinations/account")).status).toBe(400);
  expect((await app.request("/pollinations/account?connection_id=connection")).status).toBe(400);
  expect((await app.request("/pollinations/device/poll", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ connection_id: "connection" }) })).status).toBe(400);
  expect((await app.request("/pollinations/device/poll", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device_code: "device" }) })).status).toBe(400);
});

test("routes expose a pending device poll and store the key once approved", async () => {
  mockConnection();
  const setKey = spy(connSvc, "setConnectionApiKey").mockResolvedValue(undefined);
  spy(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ error: "authorization_pending" }))
    .mockResolvedValueOnce(Response.json({ access_token: "sk_minted", token_type: "bearer" }));
  const app = routes();
  const body = JSON.stringify({ device_code: "device", connection_id: "connection" });
  const init = { method: "POST", headers: { "Content-Type": "application/json" }, body };
  expect(await (await app.request("/pollinations/device/poll", init)).json()).toEqual({ status: "pending" });
  const done = await (await app.request("/pollinations/device/poll", init)).json() as any;
  expect(done.status).toBe("complete");
  expect(done.created).toBe(false);
  expect(setKey).toHaveBeenCalledWith("alice", "connection", "sk_minted");
});
