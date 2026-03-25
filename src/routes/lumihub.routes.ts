import { Hono } from "hono";
import { requireOwner } from "../auth/middleware";
import * as linkSvc from "../services/lumihub-link.service";
import { getLumiHubClient } from "../lumihub/client";

// --- PKCE state storage (in-memory, same pattern as spindle/oauth-state.ts) ---

interface PKCEState {
  codeVerifier: string;
  lumihubUrl: string;
  instanceName: string;
  expiresAt: number;
}

const pkceStateMap = new Map<string, PKCEState>();
const PKCE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Sweep expired entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of pkceStateMap) {
    if (now > entry.expiresAt) pkceStateMap.delete(key);
  }
}, 60_000);

// --- Callback route (unauthenticated — placed before requireAuth) ---

export const lumihubCallbackRoute = new Hono();

lumihubCallbackRoute.get("/callback", async (c) => {
  const code = c.req.query("code");
  if (!code) {
    return c.html(errorHtml("Missing Code", "No authorization code received from LumiHub."), 400);
  }

  // Find the PKCE state — we only ever have one pending link
  let pkceState: PKCEState | undefined;
  let stateKey: string | undefined;
  for (const [key, entry] of pkceStateMap) {
    if (Date.now() <= entry.expiresAt) {
      pkceState = entry;
      stateKey = key;
      break;
    }
  }

  if (!pkceState || !stateKey) {
    return c.html(errorHtml("Expired", "The linking session has expired. Please try again from settings."), 400);
  }

  // Consume the state
  pkceStateMap.delete(stateKey);

  // Exchange the code for a link token
  try {
    const tokenUrl = `${pkceState.lumihubUrl}/api/v1/link/token`;
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        code_verifier: pkceState.codeVerifier,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: "Unknown error" }));
      return c.html(errorHtml("Token Exchange Failed", (err as any).error || "Failed to exchange code for token."), 400);
    }

    const data = (await response.json()) as { token: string; instance_id: string; ws_url: string };

    // Save the link config (encrypted)
    await linkSvc.saveLinkConfig(
      pkceState.lumihubUrl,
      data.ws_url,
      data.token,
      data.instance_id,
      pkceState.instanceName
    );

    // Start the WebSocket connection
    const client = getLumiHubClient();
    client.connect(data.ws_url, data.token);

    return c.html(successHtml("Linked Successfully", "Your Lumiverse instance is now linked to LumiHub. You can close this window."));
  } catch (err: any) {
    console.error("[LumiHub] Token exchange error:", err);
    return c.html(errorHtml("Connection Error", "Could not reach LumiHub to complete the link."), 502);
  }
});

// --- Authenticated routes (after requireAuth) ---

export const lumihubRoutes = new Hono();

/** Initiate a link to LumiHub (owner only). */
lumihubRoutes.post("/link", requireOwner, async (c) => {
  const body = await c.req.json();
  const lumihubUrl = body.lumihub_url?.replace(/\/+$/, "");
  const instanceName = body.instance_name || "My Lumiverse";
  const redirectOrigin = body.redirect_origin?.replace(/\/+$/, "");

  if (!lumihubUrl || typeof lumihubUrl !== "string") {
    return c.json({ error: "lumihub_url is required" }, 400);
  }
  if (!redirectOrigin || typeof redirectOrigin !== "string") {
    return c.json({ error: "redirect_origin is required" }, 400);
  }

  // Generate PKCE
  const { codeVerifier, codeChallenge } = await linkSvc.generatePKCE();

  // Store PKCE state
  const stateId = crypto.randomUUID();
  pkceStateMap.set(stateId, {
    codeVerifier,
    lumihubUrl,
    instanceName,
    expiresAt: Date.now() + PKCE_TTL_MS,
  });

  // Build the authorization URL
  const params = new URLSearchParams({
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    instance_name: instanceName,
    redirect_origin: redirectOrigin,
  });

  const authorizeUrl = `${lumihubUrl}/api/v1/link/authorize?${params.toString()}`;

  return c.json({ authorize_url: authorizeUrl });
});

/** Get LumiHub connection status. */
lumihubRoutes.get("/status", async (c) => {
  const config = await linkSvc.getLinkConfig();
  if (!config) {
    return c.json({ linked: false });
  }

  const client = getLumiHubClient();
  return c.json({
    linked: true,
    lumihub_url: config.lumihubUrl,
    instance_name: config.instanceName,
    connected: client.isConnected(),
    last_connected_at: config.lastConnectedAt,
  });
});

/** Unlink from LumiHub (owner only). */
lumihubRoutes.post("/unlink", requireOwner, async (c) => {
  const client = getLumiHubClient();
  client.disconnect();
  linkSvc.deleteLinkConfig();
  return c.json({ success: true });
});

// --- HTML helpers ---

function successHtml(title: string, message: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a0f;color:#e0e0e8}
.card{text-align:center;padding:2rem;border-radius:12px;background:#14141e;border:1px solid #7c3aed}
h1{margin:0 0 .5rem;font-size:1.5rem;color:#a78bfa}p{margin:0;opacity:.8}</style></head>
<body><div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div>
<script>setTimeout(()=>window.close(),3000)</script></body></html>`;
}

function errorHtml(title: string, message: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a0f;color:#e0e0e8}
.card{text-align:center;padding:2rem;border-radius:12px;background:#14141e;border:1px solid #e74c3c}
h1{margin:0 0 .5rem;font-size:1.5rem;color:#e74c3c}p{margin:0;opacity:.8}</style></head>
<body><div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div></body></html>`;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
