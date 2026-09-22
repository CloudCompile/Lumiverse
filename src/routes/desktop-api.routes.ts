import { Hono, type Context, type Next } from "hono";
import { isInsufficientScopeError } from "better-auth/oauth2";
import type { JWTPayload } from "jose";
import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import { getDb } from "../db/connection";
import { env } from "../env";
import {
  DESKTOP_OAUTH_CLIENT_ID,
  DESKTOP_OAUTH_RESOURCE,
  DESKTOP_STATUS_SCOPE,
  getDesktopOAuthIssuer,
  getDesktopServerInstanceId,
} from "../auth/desktop-oauth";
import { resolveDesktopRequestOrigin } from "../auth/request-origin";
import { isConnectionFromExplicitTrustedProxy } from "../utils/client-ip";

export interface DesktopPrincipal {
  id: string;
  name: string;
  email: string;
  username: string | null;
  role: string;
}

declare module "hono" {
  interface ContextVariableMap {
    desktopPrincipal: DesktopPrincipal;
    desktopIssuer: string;
  }
}

export interface DesktopApiDependencies {
  verify: (request: Request, issuer: string) => Promise<JWTPayload>;
  loadPrincipal: (userId: string) => DesktopPrincipal | null;
  getStatus: () => Promise<unknown>;
  getInstance: (issuer: string) => { id: string; name: string };
}

export function canReadDesktopStatus(role: string): boolean {
  return role === "admin" || role === "owner";
}

let verifierActions: ReturnType<typeof oauthProviderResourceClient>["getActions"] extends () => infer T ? T : never;
let desktopJwksUrl = `http://127.0.0.1:${env.port}/api/auth/jwks`;

/** Use an internal plaintext-only JWKS listener when the public listener is HTTPS-only. */
export function setDesktopJwksLoopbackPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid desktop JWKS loopback port: ${port}`);
  }
  desktopJwksUrl = `http://127.0.0.1:${port}/api/auth/jwks`;
}

async function verifyDesktopToken(request: Request, issuer: string): Promise<JWTPayload> {
  if (!verifierActions) {
    const { auth } = await import("../auth");
    verifierActions = oauthProviderResourceClient(auth).getActions();
  }
  return verifierActions.verifyAccessTokenRequest(request, {
    verifyOptions: { audience: DESKTOP_OAUTH_RESOURCE, issuer },
    requiredScopes: [DESKTOP_STATUS_SCOPE],
    // Verify locally through the loopback server rather than depending on the
    // deployment's public DNS supporting hairpin requests.
    jwksUrl: desktopJwksUrl,
  });
}

function loadDesktopPrincipal(userId: string): DesktopPrincipal | null {
  return getDb().query(`
    SELECT id, name, email, username, COALESCE(role, 'user') AS role
    FROM "user" WHERE id = ? LIMIT 1
  `).get(userId) as DesktopPrincipal | null;
}

function instanceIdentity(issuer: string) {
  const name = new URL(issuer).hostname || "Lumiverse";
  return { id: getDesktopServerInstanceId(), name };
}

const defaultDependencies: DesktopApiDependencies = {
  verify: verifyDesktopToken,
  loadPrincipal: loadDesktopPrincipal,
  getStatus: async () => (await import("../services/operator.service")).operatorService.getFullStatus(),
  getInstance: instanceIdentity,
};

export function createDesktopApiRoutes(
  dependencies: DesktopApiDependencies = defaultDependencies,
) {
  const app = new Hono();

  async function requireDesktopToken(c: Context, next: Next) {
    const origin = resolveDesktopRequestOrigin(
      c.req.raw,
      isConnectionFromExplicitTrustedProxy(c),
    );
    const issuer = getDesktopOAuthIssuer(origin);
    let payload: JWTPayload;
    try {
      payload = await dependencies.verify(c.req.raw, issuer);
    } catch (error) {
      c.header("Cache-Control", "no-store");
      if (isInsufficientScopeError(error)) {
        c.header(
          "WWW-Authenticate",
          `Bearer error="insufficient_scope", scope="${DESKTOP_STATUS_SCOPE}"`,
        );
        return c.json({ error: "Desktop status scope is required", code: "INSUFFICIENT_SCOPE" }, 403);
      }
      c.header("WWW-Authenticate", 'Bearer error="invalid_token"');
      return c.json({ error: "Invalid or expired desktop access token", code: "INVALID_TOKEN" }, 401);
    }

    // RFC 9068 identifies the authorized OAuth client with `azp`; do not
    // accept a correctly scoped token minted for a different public client.
    if (payload.azp !== DESKTOP_OAUTH_CLIENT_ID || typeof payload.sub !== "string") {
      c.header("WWW-Authenticate", 'Bearer error="invalid_token"');
      return c.json({ error: "Invalid desktop access token", code: "INVALID_TOKEN" }, 401);
    }
    const principal = dependencies.loadPrincipal(payload.sub);
    if (!principal) {
      c.header("WWW-Authenticate", 'Bearer error="invalid_token"');
      return c.json({ error: "Desktop account no longer exists", code: "INVALID_TOKEN" }, 401);
    }
    c.set("desktopPrincipal", principal);
    c.set("desktopIssuer", issuer);
    return next();
  }

  app.use("*", requireDesktopToken);
  app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  app.get("/me", (c) => {
    const principal = c.get("desktopPrincipal");
    return c.json({
      instance: dependencies.getInstance(c.get("desktopIssuer")),
      account: {
        id: principal.id,
        name: principal.name,
        username: principal.username,
        role: principal.role,
      },
      capabilities: {
        canReadStatus: canReadDesktopStatus(principal.role),
      },
    });
  });

  app.get("/status", async (c) => {
    const principal = c.get("desktopPrincipal");
    if (!canReadDesktopStatus(principal.role)) {
      return c.json({
        error: "Instance status is restricted to administrators and owners",
        code: "ROLE_REQUIRED",
      }, 403);
    }
    return c.json(await dependencies.getStatus());
  });

  return app;
}

export const desktopApiRoutes = createDesktopApiRoutes();
