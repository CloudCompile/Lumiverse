import { buildPushHTTPRequest } from "@pushforge/builder";
import { createHash, randomBytes } from "node:crypto";
import { getDb } from "../db/connection";
import { eventBus } from "../ws/bus";
import { invalidateDesktopNotificationTickets } from "../ws/tickets";
import { EventType } from "../ws/events";
import { getVapidPrivateJWK, getVapidPublicKey } from "../crypto/vapid";
import { validateHost, SSRFError } from "../utils/safe-fetch";
import { clampErrorMessage } from "../utils/provider-errors";
import { normalizePushNotificationPayload } from "../utils/notification-text";
import { getSetting } from "./settings.service";
import type {
  PushSubscriptionRecord,
  DesktopNotificationDestinationRecord,
  NotificationDestinationRecord,
  CreatePushSubscriptionInput,
  CreateDesktopNotificationDestinationInput,
  DesktopNotificationEnrollment,
  PushPayload,
  PushNotificationPreferences,
} from "../types/push";

interface GenerationEndedPushPayload {
  chatId?: string;
  content?: string;
  error?: string;
  errorCode?: string;
  errorMessage?: string;
  connectionName?: string;
}

export interface PushDispatchResult {
  sent: number;
  reason?: "no_subscriptions" | "disabled" | "event_disabled" | "user_active";
}

interface PushDeliveryOptions {
  bypassPresence?: boolean;
  destinationId?: string;
}

const DEFAULT_PREFERENCES: PushNotificationPreferences = {
  enabled: true,
  events: {
    generation_ended: true,
    generation_error: true,
  },
};

// PushForge derives the VAPID JWT exp from the message TTL. Using the exact
// 24h maximum is brittle because small clock skew between us and the push
// service can push exp over the spec limit and trigger a 403.
const PUSH_TTL_SECONDS = 23 * 60 * 60;
const PUSH_FETCH_TIMEOUT_MS = 15_000;

// ── Subscription CRUD ───────────────────────────────────────────────

export function listSubscriptions(userId: string): PushSubscriptionRecord[] {
  return (getDb()
    .query("SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC")
    .all(userId) as Array<Omit<PushSubscriptionRecord, "type">>)
    .map((row) => ({ ...row, type: "web_push" }));
}

export function listDesktopDestinations(userId: string): DesktopNotificationDestinationRecord[] {
  return (getDb().query(`
    SELECT id, user_id, device_id, user_agent, label, platform,
           created_at, updated_at, last_seen_at
    FROM desktop_notification_destinations
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(userId) as Array<Omit<DesktopNotificationDestinationRecord, "type">>)
    .map((row) => ({ ...row, type: "tauri_desktop" }));
}

export function listNotificationDestinations(userId: string): NotificationDestinationRecord[] {
  return [...listDesktopDestinations(userId), ...listSubscriptions(userId)]
    .sort((a, b) => b.created_at - a.created_at);
}

function hashDesktopCredential(credential: string): string {
  return createHash("sha256").update(credential, "utf8").digest("hex");
}

export function getDesktopNotificationServerInstanceId(): string {
  return `lvdi_${createHash("sha256").update(getVapidPublicKey(), "utf8").digest("base64url").slice(0, 32)}`;
}

export function createDesktopDestination(
  userId: string,
  input: CreateDesktopNotificationDestinationInput,
): DesktopNotificationEnrollment {
  const deviceId = input.deviceId.trim();
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(deviceId)) {
    throw new Error("Invalid desktop device ID");
  }

  const credential = `lvd_${randomBytes(32).toString("base64url")}`;
  const tokenHash = hashDesktopCredential(credential);
  const now = Math.floor(Date.now() / 1000);
  const existing = getDb().query(`
    SELECT id, created_at FROM desktop_notification_destinations
    WHERE user_id = ? AND device_id = ?
  `).get(userId, deviceId) as { id: string; created_at: number } | null;
  const id = existing?.id ?? crypto.randomUUID();
  const label = input.label?.trim().slice(0, 100) || "Lumiverse Desktop";
  const platform = input.platform?.trim().slice(0, 80) || "";
  const userAgent = input.userAgent?.trim().slice(0, 500) || "";

  getDb().query(`
    INSERT INTO desktop_notification_destinations
      (id, user_id, device_id, token_hash, token_prefix, label, platform,
       user_agent, created_at, updated_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(user_id, device_id) DO UPDATE SET
      token_hash = excluded.token_hash,
      token_prefix = excluded.token_prefix,
      label = excluded.label,
      platform = excluded.platform,
      user_agent = excluded.user_agent,
      updated_at = excluded.updated_at,
      last_seen_at = NULL
  `).run(
    id,
    userId,
    deviceId,
    tokenHash,
    credential.slice(0, 12),
    label,
    platform,
    userAgent,
    existing?.created_at ?? now,
    now,
  );

  if (existing) {
    invalidateDesktopNotificationTickets(userId, id);
    eventBus.disconnectDesktopNotificationDestination(userId, id);
  }

  const destination = listDesktopDestinations(userId).find((row) => row.id === id);
  if (!destination) throw new Error("Desktop notification destination was not saved");
  return {
    destination,
    credential,
    serverInstanceId: getDesktopNotificationServerInstanceId(),
  };
}

export function authenticateDesktopDestinationCredential(
  credential: string,
): { userId: string; destinationId: string } | null {
  if (!credential.startsWith("lvd_") || credential.length < 40) return null;
  const row = getDb().query(`
    SELECT id, user_id, last_seen_at
    FROM desktop_notification_destinations
    WHERE token_hash = ?
  `).get(hashDesktopCredential(credential)) as {
    id: string;
    user_id: string;
    last_seen_at: number | null;
  } | null;
  if (!row) return null;

  const now = Math.floor(Date.now() / 1000);
  if (row.last_seen_at === null || now - row.last_seen_at >= 60) {
    getDb().query(`
      UPDATE desktop_notification_destinations SET last_seen_at = ? WHERE id = ?
    `).run(now, row.id);
  }
  return { userId: row.user_id, destinationId: row.id };
}

export function createSubscription(
  userId: string,
  input: CreatePushSubscriptionInput
): PushSubscriptionRecord {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  getDb()
    .query(
      `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, label, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, endpoint) DO UPDATE SET
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         user_agent = excluded.user_agent,
         updated_at = excluded.updated_at`
    )
    .run(
      id,
      userId,
      input.endpoint,
      input.keys.p256dh,
      input.keys.auth,
      input.userAgent ?? "",
      input.label ?? "",
      now,
      now
    );

  // Return the actual row (may be the upserted one with a different id)
  const row = getDb()
    .query("SELECT * FROM push_subscriptions WHERE user_id = ? AND endpoint = ?")
    .get(userId, input.endpoint) as Omit<PushSubscriptionRecord, "type">;
  return { ...row, type: "web_push" };
}

export function deleteSubscription(userId: string, id: string): boolean {
  const result = getDb()
    .query("DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?")
    .run(id, userId);
  return result.changes > 0;
}

export function deleteNotificationDestination(userId: string, id: string): boolean {
  if (deleteSubscription(userId, id)) return true;
  const deleted = getDb().query(`
    DELETE FROM desktop_notification_destinations WHERE id = ? AND user_id = ?
  `).run(id, userId).changes > 0;
  if (deleted) {
    invalidateDesktopNotificationTickets(userId, id);
    eventBus.disconnectDesktopNotificationDestination(userId, id);
  }
  return deleted;
}

// ── Push Sending (PushForge — uses Web Crypto + fetch) ──────────────

export async function sendPushToUser(
  userId: string,
  notification: PushPayload,
  options: PushDeliveryOptions = {},
): Promise<number> {
  if (!options.bypassPresence && eventBus.isUserVisible(userId)) return 0;

  const subs = listSubscriptions(userId).filter(
    (sub) => !options.destinationId || sub.id === options.destinationId,
  );
  const desktopDestinations = listDesktopDestinations(userId).filter(
    (destination) => !options.destinationId || destination.id === options.destinationId,
  );
  if (subs.length === 0 && desktopDestinations.length === 0) return 0;
  const normalizedNotification = normalizePushNotificationPayload(notification);

  let sent = 0;
  if (options.bypassPresence || !eventBus.isUserVisible(userId)) {
    sent += eventBus.sendDesktopNotification(
      userId,
      desktopDestinations.map((destination) => destination.id),
      normalizedNotification,
    );
  }

  if (subs.length === 0) return sent;
  const privateJWK = getVapidPrivateJWK();

  const results = await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        // Build the encrypted push request via PushForge
        const request = await buildPushHTTPRequest({
          privateJWK,
          subscription: {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          message: {
            payload: normalizedNotification as any,
            adminContact: "mailto:noreply@lumiverse.app",
            options: {
              ttl: PUSH_TTL_SECONDS,
              urgency: "high",
            },
          },
        });
        // Re-validate at send time. Registration-time validation (HTTPS +
        // private-range block) can be defeated later by DNS rebinding: a
        // public hostname that flips to an internal address after signup
        // would otherwise turn every generation into an internal POST.
        try {
          const parsedEndpoint = new URL(request.endpoint);
          if (parsedEndpoint.protocol !== "https:") {
            throw new SSRFError("Push endpoint must use HTTPS");
          }
          await validateHost(parsedEndpoint.hostname);
        } catch (err) {
          if (err instanceof SSRFError) {
            console.warn(`[push] Skipping ${sub.id}: endpoint failed SSRF validation (${err.message})`);
            return;
          }
          throw err;
        }

        // Presence can change while encryption and DNS validation are in
        // flight. Suppress before delivery: WebKit requires every received
        // push to display a notification, even if the PWA is now foregrounded.
        if (!options.bypassPresence && eventBus.isUserVisible(userId)) return;

        // Send via fetch (Bun-native, no Node http/https needed)
        const response = await fetch(request.endpoint, {
          method: "POST",
          headers: request.headers,
          body: request.body,
          signal: AbortSignal.timeout(PUSH_FETCH_TIMEOUT_MS),
        });

        if (response.ok || response.status === 201) {
          // Drain the body so the pooled socket is released promptly instead of
          // lingering until GC.
          void response.body?.cancel().catch(() => {});
          sent++;
        } else if (response.status === 410 || response.status === 404) {
          void response.body?.cancel().catch(() => {});
          // Subscription expired — auto-cleanup
          getDb()
            .query("DELETE FROM push_subscriptions WHERE id = ?")
            .run(sub.id);
          console.log(`[push] Removed stale subscription ${sub.id} (${response.status})`);
        } else {
          const body = await response.text().catch(() => "");
          console.error(
            `[push] Push service returned ${response.status} for ${sub.id}: ${body.slice(0, 200)}`
          );
        }
      } catch (err: any) {
        console.error(`[push] Failed to send to ${sub.id}:`, err.message || err);
      }
    })
  );

  return sent;
}

// ── Preferences Helper ──────────────────────────────────────────────

function getPreferences(userId: string): PushNotificationPreferences {
  const setting = getSetting(userId, "pushNotificationPreferences");
  if (!setting) return DEFAULT_PREFERENCES;
  const stored = setting.value as Partial<PushNotificationPreferences> | null | undefined;
  return {
    ...DEFAULT_PREFERENCES,
    ...stored,
    events: {
      ...DEFAULT_PREFERENCES.events,
      ...(stored?.events ?? {}),
    },
  };
}

async function buildGenerationEndedNotification(
  userId: string,
  payload: GenerationEndedPushPayload
): Promise<PushPayload> {
  const chatId = payload.chatId;
  const isError = !!(payload.error || payload.errorMessage || payload.errorCode);

  // Resolve character name for the notification title when the chat still exists.
  let characterName = "Lumiverse";
  let characterId: string | undefined;
  if (chatId) {
    try {
      const chat = getDb()
        .query("SELECT character_id FROM chats WHERE id = ? AND user_id = ?")
        .get(chatId, userId) as { character_id: string | null } | undefined;
      if (chat?.character_id) {
        const char = getDb()
          .query("SELECT name FROM characters WHERE id = ? AND user_id = ?")
          .get(chat.character_id, userId) as { name: string } | undefined;
        if (char) {
          characterId = chat.character_id;
          if (char.name) characterName = char.name;
        }
      }
    } catch {
      // Fallback to the generic app title.
    }
  }

  const targetUrl = chatId ? `/chat/${chatId}` : "/";
  const icon = characterId
    ? `/api/v1/characters/${encodeURIComponent(characterId)}/avatar?size=sm`
    : undefined;

  if (isError) {
    const connectionName = notificationText(payload.connectionName, 60);
    const errorCode = notificationText(payload.errorCode, 80);
    const errorMessage = notificationText(
      payload.errorMessage || payload.error || "The generation ended with an unknown error.",
      240,
    );
    const body = notificationText(
      `${errorCode ? `[${errorCode}] ` : ""}${errorMessage}`,
      240,
    );
    return {
      title: notificationText(
        connectionName ? `Generation Failed · ${connectionName}` : "Generation Failed",
        100,
      ),
      body,
      tag: chatId ? `generation-error-${chatId}` : "generation-error-test",
      data: {
        url: targetUrl,
        chatId,
        characterName,
        ...(connectionName ? { connectionName } : {}),
        ...(errorCode ? { errorCode } : {}),
        errorMessage,
      },
      ...(icon ? { icon } : {}),
    };
  }

  return {
    title: characterName,
    body: (payload.content ?? "Your generation finished.").slice(0, 120),
    tag: chatId ? `generation-${chatId}` : "generation-test",
    data: { url: targetUrl, chatId, characterName },
    ...(icon ? { icon } : {}),
  };
}

function notificationText(value: string | undefined, maxLength: number): string {
  const normalized = clampErrorMessage(value).replace(/\s+/g, " ").trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, Math.max(0, maxLength - 1))}…`
    : normalized;
}

export async function dispatchGenerationEndedPush(
  userId: string,
  payload: GenerationEndedPushPayload,
  options: PushDeliveryOptions = {},
): Promise<PushDispatchResult> {
  const prefs = getPreferences(userId);
  if (!prefs.enabled) return { sent: 0, reason: "disabled" };

  // Presence is user-wide, not device-local: if any Lumiverse session is
  // currently visible, suppress push fanout to every device.
  if (!options.bypassPresence && eventBus.isUserVisible(userId)) {
    return { sent: 0, reason: "user_active" };
  }

  const isError = !!(payload.error || payload.errorMessage || payload.errorCode);
  if (isError && !prefs.events.generation_error) {
    return { sent: 0, reason: "event_disabled" };
  }
  if (!isError && !prefs.events.generation_ended) {
    return { sent: 0, reason: "event_disabled" };
  }

  const destinations = listNotificationDestinations(userId).filter(
    (destination) => !options.destinationId || destination.id === options.destinationId,
  );
  if (destinations.length === 0) {
    return { sent: 0, reason: "no_subscriptions" };
  }

  const notification = await buildGenerationEndedNotification(userId, payload);
  const sent = await sendPushToUser(userId, notification, options);
  return { sent };
}

// ── EventBus Integration ────────────────────────────────────────────

export function initPushListeners(): void {
  eventBus.on(EventType.GENERATION_ENDED, async (event) => {
    const userId = event.userId;
    if (!userId) return;

    await dispatchGenerationEndedPush(userId, event.payload as GenerationEndedPushPayload).catch((err) => {
      console.error("[push] Failed to send push notifications:", err);
    });
  });

  console.log("[push] EventBus listeners registered");
}
