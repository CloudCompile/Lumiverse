import * as connSvc from "./connections.service";
import * as secretsSvc from "./secrets.service";
import { describeProviderError, fetchProviderJson } from "../utils/provider-errors";

const API_TIMEOUT_MS = 15_000;
const ENTER_BASE_URL = "https://enter.pollinations.ai";
const GEN_BASE_URL = "https://gen.pollinations.ai";

/**
 * Pollinations splits its surface across two hosts: `enter.pollinations.ai`
 * owns the OAuth/device authorization flow, while `gen.pollinations.ai` serves
 * account state (balance, usage) and generation.
 */
export class PollinationsConnectionError extends Error {
  constructor(message: string, readonly status: 400 | 404) { super(message); }
}

async function resolveApiKey(userId: string, connectionId: string): Promise<string> {
  const profile = connSvc.getConnection(userId, connectionId);
  if (!profile) throw new PollinationsConnectionError("Connection not found", 404);
  if (profile.provider !== "pollinations") throw new PollinationsConnectionError("Connection is not a Pollinations profile", 400);
  const apiKey = (await secretsSvc.getSecret(userId, connSvc.connectionSecretKey(connectionId)))?.trim() || "";
  if (!apiKey) throw new PollinationsConnectionError("A Pollinations API key is required", 400);
  return apiKey;
}

/** Provider display name used for `describeProviderError` messages. */
const PROVIDER = "Pollinations";

// ── Device Flow ──────────────────────────────────────────────────────────────

export interface PollinationsDeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

/**
 * Start the OAuth device-authorization flow. The App Key (`pk_...`) is sent as
 * `client_id` so the consent screen is attributed to the app; the user approves
 * out-of-band and the returned `sk_...` user key is polled for separately.
 */
export async function startDeviceAuth(
  userId: string,
  input: { models?: string; budget?: number; expiry?: number; permissions?: string },
): Promise<PollinationsDeviceCode> {
  const clientId = await connSvc.resolvePollinationsAppKey(userId);
  const body: Record<string, string | number> = {};
  if (clientId) body.client_id = clientId;
  // The device endpoint mirrors the authorize query params (camelCase aliases).
  if (input.models?.trim()) body.models = input.models.trim();
  if (typeof input.budget === "number" && Number.isFinite(input.budget) && input.budget > 0) body.budget = Math.floor(input.budget);
  if (typeof input.expiry === "number" && Number.isFinite(input.expiry) && input.expiry > 0) body.expiry = Math.floor(input.expiry);
  if (input.permissions?.trim()) body.scope = input.permissions.trim();

  const raw = await fetchProviderJson<any>(PROVIDER, "device authorization", `${ENTER_BASE_URL}/api/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });

  if (typeof raw?.device_code !== "string" || !raw.device_code) {
    throw new Error("Pollinations did not return a device code");
  }
  return {
    device_code: raw.device_code,
    user_code: typeof raw.user_code === "string" ? raw.user_code : "",
    verification_uri: typeof raw.verification_uri === "string" ? raw.verification_uri : `${ENTER_BASE_URL}/device`,
    verification_uri_complete: typeof raw.verification_uri_complete === "string" ? raw.verification_uri_complete : "",
    expires_in: Number.isFinite(raw.expires_in) ? raw.expires_in : 1800,
    interval: Number.isFinite(raw.interval) && raw.interval > 0 ? raw.interval : 5,
  };
}

export type PollinationsDeviceTokenResult =
  | { status: "pending" }
  | { status: "complete"; api_key: string };

/**
 * Poll the device token endpoint once. Returns `pending` until the user approves
 * on the verification page, then the scoped user key (`sk_...`).
 */
export async function pollDeviceAuth(deviceCode: string): Promise<PollinationsDeviceTokenResult> {
  const res = await fetch(`${ENTER_BASE_URL}/api/device/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_code: deviceCode }),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });

  const raw = await res.json().catch(() => null) as any;

  if (res.ok && typeof raw?.access_token === "string" && raw.access_token) {
    return { status: "complete", api_key: raw.access_token };
  }

  const error = typeof raw?.error === "string" ? raw.error : "";
  if (error === "authorization_pending" || error === "slow_down") return { status: "pending" };

  throw new Error(
    error === "expired_token"
      ? "The Pollinations sign-in request expired. Start again."
      : typeof raw?.error_description === "string" && raw.error_description
        ? raw.error_description
        : `Pollinations sign-in failed${res.status ? ` (${res.status})` : ""}`,
  );
}

// ── Account Balance & Usage ──────────────────────────────────────────────────

export interface PollinationsBalance {
  /** Pollen remaining for this caller (key budget when budgeted, else account total). */
  balance: number;
  /** Full account balances; only present when the key carries the `usage` scope. */
  account_balance: { total: number; tier: number; paid: number } | null;
}

export interface PollinationsDailyUsage {
  /** Per-day totals across the rolling window, keyed by UTC date (YYYY-MM-DD). */
  daily: { date: string; requests: number; cost_usd: number }[];
  today_requests: number;
  today_cost_usd: number;
  month_cost_usd: number;
  /** Days covered by the query window. */
  window_days: number;
}

export interface PollinationsAccountUsage {
  balance: PollinationsBalance | null;
  usage: PollinationsDailyUsage | null;
  errors: Partial<Record<"balance" | "usage", string>>;
}

async function fetchBalance(apiKey: string): Promise<PollinationsBalance> {
  const raw = await fetchProviderJson<any>(PROVIDER, "balance", `${GEN_BASE_URL}/account/balance`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const balance = typeof raw?.balance === "number" ? raw.balance : Number(raw?.balance);
  if (!Number.isFinite(balance)) throw new Error("Pollinations returned an invalid balance");
  const account = raw?.accountBalance;
  return {
    balance,
    account_balance: account && typeof account === "object"
      ? {
          total: Number(account.total) || 0,
          tier: Number(account.tier) || 0,
          paid: Number(account.paid) || 0,
        }
      : null,
  };
}

/**
 * Fetch daily-aggregated usage for a rolling window. Grouping is by date, key,
 * model, and billing source, so the same day can appear multiple times; the
 * rows are folded into a per-day total for the panel.
 */
export async function fetchDailyUsage(apiKey: string, days = 31, now = new Date()): Promise<PollinationsDailyUsage> {
  const url = new URL(`${GEN_BASE_URL}/account/usage/daily`);
  url.searchParams.set("days", String(days));
  const raw = await fetchProviderJson<any>(PROVIDER, "usage", url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const rows = Array.isArray(raw?.usage) ? raw.usage : [];
  if (!raw || !Array.isArray(raw.usage)) throw new Error("Pollinations returned invalid usage");

  const byDate = new Map<string, { requests: number; cost_usd: number }>();
  for (const row of rows) {
    const date = typeof row?.date === "string" ? row.date.slice(0, 10) : "";
    if (!date) continue;
    const entry = byDate.get(date) ?? { requests: 0, cost_usd: 0 };
    entry.requests += Number(row.requests) || 0;
    entry.cost_usd += Number(row.cost_usd) || 0;
    byDate.set(date, entry);
  }

  const daily = [...byDate.entries()]
    .map(([date, entry]) => ({ date, requests: entry.requests, cost_usd: entry.cost_usd }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const today = now.toISOString().slice(0, 10);
  const monthPrefix = today.slice(0, 7);
  const todayRow = byDate.get(today);
  const month_cost_usd = daily.reduce((sum, entry) => entry.date.startsWith(monthPrefix) ? sum + entry.cost_usd : sum, 0);

  return {
    daily,
    today_requests: todayRow?.requests ?? 0,
    today_cost_usd: todayRow?.cost_usd ?? 0,
    month_cost_usd,
    window_days: days,
  };
}

/** Fetch balance and usage in parallel, recording per-section errors. */
export async function fetchAccountUsage(userId: string, connectionId: string): Promise<PollinationsAccountUsage> {
  const apiKey = await resolveApiKey(userId, connectionId);
  const results = await Promise.allSettled([
    fetchBalance(apiKey),
    fetchDailyUsage(apiKey),
  ]);
  const account: PollinationsAccountUsage = { balance: null, usage: null, errors: {} };
  const keys = ["balance", "usage"] as const;
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      Object.assign(account, { [keys[index]]: result.value });
    } else {
      account.errors[keys[index]] = describeProviderError(result.reason, "Pollinations usage unavailable");
    }
  });
  return account;
}
