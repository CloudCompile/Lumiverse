import { describe, expect, test } from "bun:test";
import { IllarinUnauthorizedError } from "./api";
import { runDeliveryCycle, type DeliveryCycleDependencies } from "./delivery-worker";
import type { IllarinDelivery } from "./types";

const DELIVERY: IllarinDelivery = {
  id: "delivery-1",
  assetId: "asset-1",
  contentGeneration: 3,
  kind: "character",
  name: "Aster",
  format: "chara_card_v3",
  label: "Character Card V3",
  queuedAt: "2026-08-24T20:00:00Z",
  leaseExpiresAt: "2026-08-24T20:15:00Z",
  artifacts: [{ kind: "export", url: "https://illarin.com/api/v1/delivery/export" }],
};

function dependencies(overrides: Partial<DeliveryCycleDependencies> = {}) {
  const calls = {
    acknowledged: [] as string[][],
    installed: [] as string[],
    recorded: [] as string[],
    queued: [] as string[],
    collectedWith: [] as string[][],
    withheld: [] as string[],
  };
  const deps: DeliveryCycleDependencies = {
    getInstance: async () => ({
      userId: "user-1",
      illarinUrl: "https://illarin.com",
      instanceId: "instance-1",
      instanceName: "test",
      applicationName: "Lumiverse",
      scopes: ["asset:receive"],
      accessToken: "access",
      accessTokenExpiresAt: "2099-01-01T00:00:00Z",
      refreshToken: "refresh",
      lastDeclaration: null,
      linkedAt: "2026-08-24T20:00:00Z",
      lastRefreshAt: null,
    }),
    getAccessToken: async () => "access",
    refreshAccessToken: async () => "refreshed",
    collect: async (_base, _token, acknowledge) => {
      calls.collectedWith.push([...acknowledge]);
      return { deliveries: [DELIVERY], withheld: [] };
    },
    recordWithheld: async (_user, notices) => {
      calls.withheld.push(...notices.map((notice) => notice.assetId));
    },
    pendingAcknowledgements: () => ["delivery-before"],
    markAcknowledged: (_user, _instance, ids) => calls.acknowledged.push([...ids]),
    hasReceipt: () => false,
    queueAcknowledgement: (_user, _instance, id) => calls.queued.push(id),
    install: async (_user, delivery) => { calls.installed.push(delivery.id); },
    recordInstalled: (_user, _instance, id) => calls.recorded.push(id),
    terminalUnauthorized: async () => {},
    ...overrides,
  };
  return { deps, calls };
}

describe("Illarin delivery pickup", () => {
  test("acknowledges prior receipts and records new work only after installation", async () => {
    const harness = dependencies();
    const result = await runDeliveryCycle("user-1", harness.deps);

    expect(result).toEqual({ status: "continue", installed: 1, failed: 0 });
    expect(harness.calls.collectedWith).toEqual([["delivery-before"]]);
    expect(harness.calls.acknowledged).toEqual([["delivery-before"]]);
    expect(harness.calls.installed).toEqual(["delivery-1"]);
    expect(harness.calls.recorded).toEqual(["delivery-1"]);
  });

  test("deduplicates a repeated delivery and queues its acknowledgement again", async () => {
    const harness = dependencies({ hasReceipt: () => true });
    const result = await runDeliveryCycle("user-1", harness.deps);

    expect(result.installed).toBe(0);
    expect(harness.calls.installed).toEqual([]);
    expect(harness.calls.queued).toEqual(["delivery-1"]);
  });

  test("refreshes once after an access 401 and retries collection once", async () => {
    let calls = 0;
    const harness = dependencies({
      collect: async () => {
        calls++;
        if (calls === 1) throw new IllarinUnauthorizedError(401, "/api/v1/deliveries/collect");
        return { deliveries: [], withheld: [] };
      },
    });

    const result = await runDeliveryCycle("user-1", harness.deps);
    expect(result.status).toBe("continue");
    expect(calls).toBe(2);
  });

  test("records withheld notices that arrive with a delivery wait", async () => {
    const harness = dependencies({
      collect: async () => ({
        deliveries: [],
        withheld: [{ assetId: "asset-9", name: "Quiet Toolbox", withheldAt: "2026-09-14T06:00:00Z" }],
      }),
    });
    await runDeliveryCycle("user-1", harness.deps);

    expect(harness.calls.withheld).toEqual(["asset-9"]);
  });

  test("does not acknowledge a delivery whose installation failed", async () => {
    const harness = dependencies({ install: async () => { throw new Error("disk full"); } });
    const result = await runDeliveryCycle("user-1", harness.deps);

    expect(result).toEqual({ status: "continue", installed: 0, failed: 1 });
    expect(harness.calls.recorded).toEqual([]);
  });
});
