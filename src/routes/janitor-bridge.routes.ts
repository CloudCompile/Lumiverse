// ─────────────────────────────────────────────────────────────────────────────
// Janitor Bridge — Routes
//
// Two route groups, mounted at /api/v1/janitor-bridge:
//
//   1. OpenAI-compatible proxy endpoint (NO Lumiverse auth — Janitor's UI
//      can't have a Lumiverse session):
//        POST /api/v1/janitor-bridge/chat/completions
//        POST /api/v1/janitor-bridge/v1/chat/completions  (alias)
//        GET  /api/v1/janitor-bridge/v1/models             (returns dummy list)
//        OPTIONS *                                          (CORS preflight)
//
//      Auth: `Authorization: Bearer <bridgeKey>` — the bridge key the user
//      generated in Lumiverse settings. We compare against the stored key,
//      then replace it with the real Janitor AI API key when forwarding.
//
//   2. Card management endpoints (Lumiverse auth required — same requireAuth
//      as all other /api/v1 routes):
//        GET    /api/v1/janitor-bridge/cards       (list captured cards)
//        GET    /api/v1/janitor-bridge/cards/:id   (get one card with bridge metadata)
//        DELETE /api/v1/janitor-bridge/cards/:id   (delete captured card)
//        GET    /api/v1/janitor-bridge/stats       (capture statistics)
//        GET    /api/v1/janitor-bridge/config      (get bridge config — key redacted)
//        PUT    /api/v1/janitor-bridge/config      (update bridge config)
//        POST   /api/v1/janitor-bridge/config/key  (generate new bridge key)
//
// The route group is mounted BEFORE the requireAuth middleware in app.ts, but
// only the OpenAI-compatible proxy paths are exempted — the card management
// paths explicitly call requireAuth themselves.
// ─────────────────────────────────────────────────────────────────────────────

import { Hono } from "hono";
import type { Context, Next } from "hono";
import { getDb } from "../db/connection";
import { getFirstUserId } from "../auth/seed";
import { requireAuth } from "../auth/middleware";
import * as secretsSvc from "../services/secrets.service";
import * as charactersSvc from "../services/characters.service";
import {
  captureFromRequest,
  listCapturedCards,
  bumpCaptureStats,
  type CapturedCardRow,
} from "../services/janitor-bridge/capture.service";
import {
  proxyToJanitor,
  tryParseJsonBody,
  extractAssistantContent,
  DEFAULT_JANITOR_API_BASE,
} from "../services/janitor-bridge/proxy.service";
import { extractImageUrls, type JanitorMessage } from "../services/janitor-bridge/parser";

// ─── Settings keys (stored in the standard settings table) ──────────────────
//
// The bridge config is stored in the settings table under these keys, scoped
// to the owner (first) user. The Janitor AI API key is stored in the secrets
// table (encrypted) under SECRET_KEY.
const SETTING_ENABLED = "janitorBridge.enabled";          // boolean
const SETTING_AUTO_TAG = "janitorBridge.autoTag";         // boolean
const SETTING_API_BASE = "janitorBridge.apiBase";         // string (default DEFAULT_JANITOR_API_BASE)
const SETTING_BRIDGE_KEY_HASH = "janitorBridge.bridgeKeyHash"; // string (SHA-256 hex)
const SETTING_CAPTURE_COUNT = "janitorBridge.captureCount"; // number
const SETTING_LAST_CAPTURE_AT = "janitorBridge.lastCaptureAt"; // unix seconds

const SECRET_KEY = "janitorBridge.janitorApiKey";

// ─── Helpers ────────────────────────────────────────────────────────────────

function ownerUserId(): string {
  const id = getFirstUserId();
  if (!id) throw new Error("No owner user found — complete first-run setup");
  return id;
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function getSetting(userId: string, key: string): any | null {
  const row = getDb()
    .query("SELECT value FROM settings WHERE key = ? AND user_id = ?")
    .get(key, userId) as { value: string } | null;
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

function putSetting(userId: string, key: string, value: any): void {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  const now = Math.floor(Date.now() / 1000);
  getDb()
    .query(
      `INSERT INTO settings (key, value, user_id, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key, user_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, serialized, userId, now);
}

function getBridgeConfig(userId: string) {
  return {
    enabled: getSetting(userId, SETTING_ENABLED) ?? false,
    autoTag: getSetting(userId, SETTING_AUTO_TAG) ?? true,
    apiBase: getSetting(userId, SETTING_API_BASE) ?? DEFAULT_JANITOR_API_BASE,
    hasBridgeKey: !!getSetting(userId, SETTING_BRIDGE_KEY_HASH),
    hasJanitorApiKey: false, // populated below
    captureCount: getSetting(userId, SETTING_CAPTURE_COUNT) ?? 0,
    lastCaptureAt: getSetting(userId, SETTING_LAST_CAPTURE_AT) ?? null,
  };
}

async function getBridgeConfigWithSecretStatus(userId: string) {
  const cfg = getBridgeConfig(userId);
  cfg.hasJanitorApiKey = await secretsSvc.validateSecret(userId, SECRET_KEY);
  return cfg;
}

function randomBridgeKey(): string {
  // 32 random bytes → base64url → ~43 chars. Sufficient for a bearer token.
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return "jb_" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ─── CORS for OpenAI-compatible endpoints ───────────────────────────────────
//
// Janitor AI's UI runs in a browser, so it sends preflight OPTIONS requests
// and expects permissive CORS headers. We allow all origins — the bridge key
// is the auth, not the origin.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
  "Access-Control-Max-Age": "86400",
};

function corsResponse(c: Context, status: number, body: any, headers: Record<string, string> = {}): Response {
  const response = c.json(body, status as any);
  for (const [k, v] of Object.entries(CORS_HEADERS)) response.headers.set(k, v);
  for (const [k, v] of Object.entries(headers)) response.headers.set(k, v);
  return response;
}

// ─── Hono app ───────────────────────────────────────────────────────────────

const app = new Hono();

// ─── CORS preflight (catch-all OPTIONS) ─────────────────────────────────────
app.options("*", (c) => {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
});

// ─── OpenAI-compatible proxy endpoints (NO requireAuth) ─────────────────────

/**
 * Bridge auth middleware for the OpenAI-compatible endpoints.
 *
 * Checks `Authorization: Bearer <key>` against the stored bridge key hash.
 * On success, sets c.set("userId", ownerUserId) so downstream handlers can
 * use the same pattern as other Lumiverse routes.
 */
async function bridgeAuth(c: Context, next: Next) {
  const auth = c.req.header("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

  if (!token) {
    return corsResponse(c, 401, {
      error: { message: "Missing Authorization header. Expected: Bearer <bridge_key>", type: "invalid_request_error", code: "invalid_api_key" },
    });
  }

  let userId: string;
  try {
    userId = ownerUserId();
  } catch {
    return corsResponse(c, 500, { error: { message: "Lumiverse not initialized", type: "server_error" } });
  }

  const storedHash = getSetting(userId, SETTING_BRIDGE_KEY_HASH);
  if (!storedHash) {
    return corsResponse(c, 401, {
      error: { message: "Bridge key not generated. Generate one in Lumiverse Settings → Janitor Bridge.", type: "invalid_request_error", code: "bridge_not_configured" },
    });
  }

  const tokenHash = await sha256Hex(token);
  if (!constantTimeEqual(tokenHash, storedHash)) {
    return corsResponse(c, 401, {
      error: { message: "Invalid bridge key.", type: "invalid_request_error", code: "invalid_api_key" },
    });
  }

  const enabled = getSetting(userId, SETTING_ENABLED) ?? false;
  if (!enabled) {
    return corsResponse(c, 503, {
      error: { message: "Janitor Bridge is disabled. Enable it in Lumiverse Settings → Janitor Bridge.", type: "server_error", code: "bridge_disabled" },
    });
  }

  c.set("userId", userId);
  await next();
}

/**
 * POST /chat/completions
 * POST /v1/chat/completions  (alias)
 *
 * OpenAI-compatible chat completions endpoint. Extracts the character card
 * from the request, then forwards to Janitor AI's real API and streams the
 * response back.
 */
async function handleChatCompletions(c: Context) {
  const userId = c.get("userId");

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return corsResponse(c, 400, { error: { message: "Invalid JSON body", type: "invalid_request_error" } });
  }

  const messages: JanitorMessage[] = Array.isArray(body?.messages) ? body.messages : [];
  if (messages.length === 0) {
    return corsResponse(c, 400, { error: { message: "No messages in request", type: "invalid_request_error" } });
  }

  // Fetch the real Janitor API key from secrets.
  const janitorApiKey = await secretsSvc.getSecret(userId, SECRET_KEY);
  if (!janitorApiKey) {
    return corsResponse(c, 500, {
      error: { message: "Janitor AI API key not configured. Set it in Lumiverse Settings → Janitor Bridge.", type: "server_error", code: "missing_janitor_api_key" },
    });
  }

  const apiBase = getSetting(userId, SETTING_API_BASE) ?? DEFAULT_JANITOR_API_BASE;
  const autoTag = getSetting(userId, SETTING_AUTO_TAG) ?? true;

  // Extract & save the card BEFORE forwarding. Don't let capture failures
  // block the chat — log and continue.
  let captureInfo: { captured: boolean; characterName: string | null; isNew: boolean } = {
    captured: false,
    characterName: null,
    isNew: false,
  };
  try {
    const result = captureFromRequest(userId, messages, { autoTag });
    captureInfo = {
      captured: result.captured,
      characterName: result.characterName,
      isNew: result.isNew,
    };
    if (result.captured) {
      // Bump global capture stats.
      const current = getSetting(userId, SETTING_CAPTURE_COUNT) ?? 0;
      putSetting(userId, SETTING_CAPTURE_COUNT, current + 1);
      putSetting(userId, SETTING_LAST_CAPTURE_AT, Math.floor(Date.now() / 1000));

      console.log(
        `[janitor-bridge] ${result.isNew ? "Captured new" : "Bumped"} card "${result.characterName}" (hash ${result.personaHash?.slice(0, 8)})`,
      );
    }
  } catch (err: any) {
    console.error("[janitor-bridge] capture failed (continuing):", err.message);
  }

  // Forward to Janitor AI's real API.
  let proxyResponse;
  try {
    proxyResponse = await proxyToJanitor({
      janitorApiKey,
      janitorApiBase: apiBase,
      body,
      signal: c.req.raw.signal,
      passthroughHeaders: pickPassthroughHeaders(c.req.raw.headers),
    });
  } catch (err: any) {
    console.error("[janitor-bridge] upstream fetch failed:", err.message);
    return corsResponse(c, 502, {
      error: { message: `Janitor AI upstream error: ${err.message}`, type: "upstream_error" },
    });
  }

  // For non-streaming responses, inspect the assistant message and capture
  // any image URLs found in the response (Janitor's LLM often returns cards'
  // gallery images inline).
  if (!proxyResponse.streaming) {
    try {
      const json = tryParseJsonBody(proxyResponse.body as string);
      if (json) {
        const assistantContent = extractAssistantContent(json);
        if (assistantContent) {
          const imageUrls = extractImageUrls([
            { role: "assistant", content: assistantContent },
            ...messages,
          ]);
          if (imageUrls.length > 0 && captureInfo.captured) {
            // Log for now — image storage integration comes in a follow-up.
            console.log(
              `[janitor-bridge] Found ${imageUrls.length} image(s) in response for "${captureInfo.characterName}"`,
            );
          }
        }
      }
    } catch (err: any) {
      console.error("[janitor-bridge] response inspection failed (continuing):", err.message);
    }
  }

  // Build the response. For streaming, pipe the ReadableStream through. For
  // non-streaming, return the buffered body as-is.
  const responseHeaders: Record<string, string> = {
    ...CORS_HEADERS,
    ...proxyResponse.headers,
    "X-Janitor-Bridge-Captured": captureInfo.captured ? "1" : "0",
    "X-Janitor-Bridge-Is-New": captureInfo.isNew ? "1" : "0",
  };
  if (captureInfo.characterName) {
    responseHeaders["X-Janitor-Bridge-Card-Name"] = encodeURIComponent(captureInfo.characterName);
  }

  if (proxyResponse.streaming) {
    return new Response(proxyResponse.body, {
      status: proxyResponse.status,
      headers: responseHeaders,
    });
  }

  return new Response(proxyResponse.body as string, {
    status: proxyResponse.status,
    headers: {
      ...responseHeaders,
      "Content-Type": responseHeaders["Content-Type"] || responseHeaders["content-type"] || "application/json",
    },
  });
}

function pickPassthroughHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  // Only pass through a small allowlist of headers that Janitor AI's API
  // might legitimately want (e.g. X-Title for some OpenAI-compatible APIs).
  const allow = ["X-Title", "X-Request-ID", "X-Session-ID"];
  for (const k of allow) {
    const v = headers.get(k);
    if (v) out[k] = v;
  }
  return out;
}

// Register the same handler at both paths (different Janitor UI versions
// configure base URLs differently — some include /v1, some don't).
app.post("/chat/completions", bridgeAuth, handleChatCompletions);
app.post("/v1/chat/completions", bridgeAuth, handleChatCompletions);

/**
 * GET /v1/models — OpenAI-compatible models list.
 *
 * Janitor AI's UI fetches this on first connect. We return a static list
 * (the models Janitor AI's API typically exposes). This is purely cosmetic
 * — the actual model the user picks in the UI gets passed through to
 * Janitor's API in the chat completions request body.
 */
app.get("/v1/models", bridgeAuth, (c) => {
  const now = Math.floor(Date.now() / 1000);
  const models = [
    "gpt-4-turbo",
    "gpt-4o",
    "gpt-4o-mini",
    "claude-3-5-sonnet",
    "claude-3-opus",
    "claude-3-haiku",
    "llama-3.1-70b",
    "llama-3.1-405b",
    "mistral-large",
    "deepseek-v3",
    "janitorllm",
  ].map((id) => ({
    id,
    object: "model",
    created: now,
    owned_by: "janitor-ai",
  }));
  return corsResponse(c, 200, { object: "list", data: models });
});

// ─── Card management endpoints (requireAuth) ────────────────────────────────

/**
 * GET /cards — list captured cards (with pagination + search + tag filter).
 *
 * Returns only cards captured by the bridge (filter on
 * extensions.janitor_bridge.persona_hash IS NOT NULL).
 */
app.get("/cards", requireAuth, (c) => {
  const userId = c.get("userId");
  const limit = parseInt(c.req.query("limit") || "50", 10);
  const offset = parseInt(c.req.query("offset") || "0", 10);
  const search = c.req.query("search") || undefined;
  const tag = c.req.query("tag") || undefined;
  const result = listCapturedCards(userId, { limit, offset, search, tag });
  return c.json(result);
});

/**
 * GET /cards/:id — single captured card with bridge metadata.
 */
app.get("/cards/:id", requireAuth, (c) => {
  const userId = c.get("userId");
  const cardId = c.req.param("id");
  const { data } = listCapturedCards(userId, { limit: 200, offset: 0 });
  const card = data.find((x) => x.id === cardId);
  if (!card) return c.json({ error: "Not found" }, 404);
  return c.json(card);
});

/**
 * DELETE /cards/:id — delete a captured card.
 *
 * Deletes the underlying character (via characters.service) — this also
 * cleans up the bridge metadata in extensions.
 */
app.delete("/cards/:id", requireAuth, (c) => {
  const userId = c.get("userId");
  const cardId = c.req.param("id");
  if (!cardId) return c.json({ error: "Missing card id" }, 400);
  // Verify this is actually a bridge-captured card before allowing delete
  // through this endpoint (otherwise we're just a duplicate of /api/v1/characters/:id).
  const { data } = listCapturedCards(userId, { limit: 200, offset: 0 });
  if (!data.find((x) => x.id === cardId)) {
    return c.json({ error: "Not a captured card" }, 404);
  }
  const deleted = charactersSvc.deleteCharacter(userId, cardId);
  if (!deleted) return c.json({ error: "Failed to delete" }, 500);
  return c.json({ success: true });
});

/**
 * GET /stats — capture statistics.
 */
app.get("/stats", requireAuth, (c) => {
  const userId = c.get("userId");
  const { total } = listCapturedCards(userId, { limit: 1, offset: 0 });
  return c.json({
    totalCaptured: total,
    captureCount: getSetting(userId, SETTING_CAPTURE_COUNT) ?? 0,
    lastCaptureAt: getSetting(userId, SETTING_LAST_CAPTURE_AT) ?? null,
    enabled: getSetting(userId, SETTING_ENABLED) ?? false,
  });
});

/**
 * GET /config — bridge config (key is redacted).
 */
app.get("/config", requireAuth, async (c) => {
  const userId = c.get("userId");
  const cfg = await getBridgeConfigWithSecretStatus(userId);
  return c.json(cfg);
});

/**
 * PUT /config — update bridge config (enabled, autoTag, apiBase).
 *
 * The Janitor API key is updated separately via /config/janitor-key.
 * The bridge key is generated via /config/key.
 */
app.put("/config", requireAuth, async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (typeof body?.enabled === "boolean") putSetting(userId, SETTING_ENABLED, body.enabled);
  if (typeof body?.autoTag === "boolean") putSetting(userId, SETTING_AUTO_TAG, body.autoTag);
  if (typeof body?.apiBase === "string" && body.apiBase.trim()) {
    putSetting(userId, SETTING_API_BASE, body.apiBase.trim());
  }
  const cfg = await getBridgeConfigWithSecretStatus(userId);
  return c.json(cfg);
});

/**
 * POST /config/key — generate a new bridge key. Returns the key ONCE.
 *
 * The key is stored as a SHA-256 hash — like a password, we never store the
 * plaintext. If the user loses it, they generate a new one (which invalidates
 * the old one).
 */
app.post("/config/key", requireAuth, async (c) => {
  const userId = c.get("userId");
  const key = randomBridgeKey();
  const hash = await sha256Hex(key);
  putSetting(userId, SETTING_BRIDGE_KEY_HASH, hash);
  return c.json({ key, message: "Store this key securely — it will not be shown again." });
});

/**
 * PUT /config/janitor-key — set the real Janitor AI API key (stored encrypted).
 */
app.put("/config/janitor-key", requireAuth, async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body?.api_key || typeof body.api_key !== "string") {
    return c.json({ error: "api_key required" }, 400);
  }
  await secretsSvc.putSecret(userId, SECRET_KEY, body.api_key.trim());
  return c.json({ success: true });
});

/**
 * DELETE /config/janitor-key — clear the stored Janitor API key.
 */
app.delete("/config/janitor-key", requireAuth, async (c) => {
  const userId = c.get("userId");
  secretsSvc.deleteSecret(userId, SECRET_KEY);
  return c.json({ success: true });
});

export { app as janitorBridgeRoutes };
export {
  SETTING_ENABLED,
  SETTING_AUTO_TAG,
  SETTING_API_BASE,
  SETTING_BRIDGE_KEY_HASH,
  SETTING_CAPTURE_COUNT,
  SETTING_LAST_CAPTURE_AT,
  SECRET_KEY,
};
