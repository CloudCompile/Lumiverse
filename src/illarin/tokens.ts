/**
 * Credential lifecycle policy for Illarin linked instances.
 *
 * Protocol invariants enforced here:
 * - Only one refresh per installation is ever in flight; concurrent callers
 *   coalesce onto the same in-flight promise.
 * - The replacement pair is durably persisted (single committed UPDATE)
 *   before the new access token is released to any worker.
 * - Only an explicit terminal 401 removes unusable credentials and emits
 *   ILLARIN_LINK_STATE_CHANGED so every background worker stands down.
 * - Every non-401 failure leaves the stored link intact and propagates to the
 *   caller. Background workers back off and retry instead of turning a
 *   transient network/server/storage failure into a forced relink.
 */

import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import * as svc from "../services/illarin-instance.service";
import { IllarinUnauthorizedError, refreshTokens } from "./api";
import type { IllarinRequestOptions } from "./api";

/** Refresh this long before expiry to absorb clock skew. Access tokens last 15 minutes. */
const EXPIRY_SKEW_MS = 90_000;

export type LinkStateReason =
  | "unauthorized"
  | "unlinked";

const inflightRefreshes = new Map<string, Promise<string | null>>();

function isExpiringSoon(expiresAtIso: string): boolean {
  const expiresAtMs = Date.parse(expiresAtIso);
  if (!Number.isFinite(expiresAtMs)) return true;
  return expiresAtMs - Date.now() < EXPIRY_SKEW_MS;
}

/**
 * Emit link-state change so the UI resets and background workers stop.
 * Local unlink has no remote counterpart yet: the owner revokes the matching
 * instance (by ID + displayed names) in Illarin account settings themselves.
 */
export async function handleTerminalUnauthorized(userId: string, reason: LinkStateReason): Promise<void> {
  svc.deleteInstance(userId);
  eventBus.emit(EventType.ILLARIN_LINK_STATE_CHANGED, { linked: false, reason }, userId);
}

/**
 * Return a valid access token for authenticated Illarin calls, refreshing
 * first when the stored one is inside the skew window. Returns null when the
 * user is not linked or the installation was torn down during refresh.
 * Throws when a non-401 refresh attempt fails so the caller can back off.
 */
export async function getValidAccessToken(userId: string, options?: IllarinRequestOptions): Promise<string | null> {
  const record = await svc.getIllarinInstance(userId);
  if (!record) return null;
  if (!isExpiringSoon(record.accessTokenExpiresAt)) return record.accessToken;

  const existing = inflightRefreshes.get(userId);
  if (existing) return existing;

  const refreshPromise = doRefresh(userId, options).finally(() => inflightRefreshes.delete(userId));
  inflightRefreshes.set(userId, refreshPromise);
  return refreshPromise;
}

/** Force one serialized rotation after an ordinary access endpoint returns 401. */
export async function refreshAccessToken(userId: string, options?: IllarinRequestOptions): Promise<string | null> {
  const existing = inflightRefreshes.get(userId);
  if (existing) return existing;

  const refreshPromise = doRefresh(userId, options, true).finally(() => inflightRefreshes.delete(userId));
  inflightRefreshes.set(userId, refreshPromise);
  return refreshPromise;
}

export async function withAccessToken<T>(userId: string, call: (accessToken: string) => Promise<T>): Promise<T | null> {
  const accessToken = await getValidAccessToken(userId);
  if (!accessToken) return null;
  try {
    return await call(accessToken);
  } catch (err) {
    if (!(err instanceof IllarinUnauthorizedError)) throw err;
  }

  const refreshed = await refreshAccessToken(userId);
  if (!refreshed) return null;
  try {
    return await call(refreshed);
  } catch (err) {
    if (!(err instanceof IllarinUnauthorizedError)) throw err;
    await handleTerminalUnauthorized(userId, "unauthorized");
    return null;
  }
}

async function doRefresh(userId: string, options?: IllarinRequestOptions, force = false): Promise<string | null> {
  // Re-load under serialization: an earlier waiter may have already rotated.
  const record = await svc.getIllarinInstance(userId);
  if (!record) return null;
  if (!force && !isExpiringSoon(record.accessTokenExpiresAt)) return record.accessToken;

  try {
    const pair = await refreshTokens(record.illarinUrl, record.refreshToken, options);
    // Committed here BEFORE resolving — waiters never see a token whose
    // matching refresh token was not already durably stored.
    await svc.replaceTokens(userId, pair);
    return pair.accessToken;
  } catch (err) {
    if (err instanceof IllarinUnauthorizedError) {
      await handleTerminalUnauthorized(userId, "unauthorized");
      return null;
    }
    // A missing/invalid response is not proof that Illarin rejected the link.
    // Keep the last durable pair and let the caller apply its normal backoff.
    // This also preserves the row if local encryption/SQLite persistence fails.
    throw err;
  }
}
