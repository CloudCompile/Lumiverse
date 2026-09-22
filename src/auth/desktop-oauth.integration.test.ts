import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeJwt } from "jose";

const dataDir = mkdtempSync(join(tmpdir(), "lumiverse-desktop-oauth-"));
process.env.DATA_DIR = dataDir;
delete process.env.AUTH_BASE_URL;
process.env.TRUSTED_ORIGINS = "https://app.example.test";

const { initIdentity } = await import("../crypto/init");
const { initDatabase, closeDatabase, getDb } = await import("../db/connection");
const { runMigrations } = await import("../db/migrate");

await initIdentity();
const db = initDatabase(":memory:");
await runMigrations(db);
const { auth, allowCreation, CREATION_NONCE_HEADER } = await import("./index");
await auth.$context;
const { default: app } = await import("../app");
const { setDesktopJwksLoopbackPort } = await import("../routes/desktop-api.routes");
const jwksLoopbackServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/api/auth/jwks") {
      return new Response("Not Found", { status: 404 });
    }
    return app.fetch(new Request("http://127.0.0.1:7860/api/auth/jwks", {
      headers: { host: "127.0.0.1:7860" },
    }));
  },
});
if (jwksLoopbackServer.port === undefined) throw new Error("Failed to allocate JWKS test port");
setDesktopJwksLoopbackPort(jwksLoopbackServer.port);

afterAll(() => {
  jwksLoopbackServer.stop(true);
  closeDatabase();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("desktop OAuth provider integration", () => {
  test("boots against the migrated schema and seeds the protected resource", () => {
    expect(getDb().query(`
      SELECT identifier, accessTokenTtl, refreshTokenTtl, allowedScopes, disabled
      FROM "oauthResource" WHERE identifier = ?
    `).get("urn:lumiverse:desktop-api")).toEqual({
      identifier: "urn:lumiverse:desktop-api",
      accessTokenTtl: 300,
      refreshTokenTtl: 2_592_000,
      allowedScopes: '["openid","profile","offline_access","desktop:instance-status:read"]',
      disabled: 0,
    });
  });

  test("publishes OIDC metadata for the native client", async () => {
    const response = await app.request(
      "http://localhost:7860/api/auth/.well-known/openid-configuration",
      { headers: { host: "localhost:7860" } },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      issuer: "http://localhost:7860/api/auth",
      authorization_endpoint: "http://localhost:7860/api/auth/oauth2/authorize",
      token_endpoint: "http://localhost:7860/api/auth/oauth2/token",
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: expect.arrayContaining(["none"]),
    });

    const publicResponse = await app.request(
      "https://app.example.test/api/auth/.well-known/openid-configuration",
      { headers: { host: "app.example.test" } },
    );
    expect(publicResponse.status).toBe(200);
    expect(await publicResponse.json()).toMatchObject({
      issuer: "https://app.example.test/api/auth",
      authorization_endpoint: "https://app.example.test/api/auth/oauth2/authorize",
      token_endpoint: "https://app.example.test/api/auth/oauth2/token",
    });

    const tlsTerminatedResponse = await app.request(
      "http://app.example.test/api/auth/.well-known/openid-configuration",
      { headers: { host: "app.example.test" } },
    );
    expect(tlsTerminatedResponse.status).toBe(200);
    expect(await tlsTerminatedResponse.json()).toMatchObject({
      issuer: "https://app.example.test/api/auth",
      authorization_endpoint: "https://app.example.test/api/auth/oauth2/authorize",
      token_endpoint: "https://app.example.test/api/auth/oauth2/token",
    });
  });

  test("keeps dynamic client registration closed", async () => {
    const response = await auth.handler(new Request(
      "http://localhost:7860/api/auth/oauth2/register",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Untrusted client",
          redirect_uris: ["http://127.0.0.1/callback"],
          token_endpoint_auth_method: "none",
        }),
      },
    ));
    expect(response.status).toBe(403);
  });

  test("issues resource-bound PKCE tokens to the fixed desktop client", async () => {
    const signUp = await auth.handler(new Request(
      "http://localhost:7860/api/auth/sign-up/email",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [CREATION_NONCE_HEADER]: allowCreation(),
        },
        body: JSON.stringify({
          name: "Desktop Owner",
          username: "desktopowner",
          email: "desktop-owner@example.test",
          password: "correct-horse-battery-staple",
        }),
      },
    ));
    expect(signUp.status).toBe(200);
    const cookie = signUp.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toBeTruthy();

    const verifier = "v".repeat(64);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const redirectUri = "http://127.0.0.1:43124/callback";
    const query = new URLSearchParams({
      response_type: "code",
      client_id: "lumiverse-desktop",
      redirect_uri: redirectUri,
      scope: "openid profile offline_access desktop:instance-status:read",
      resource: "urn:lumiverse:desktop-api",
      state: "signed-in-state",
      nonce: "signed-in-nonce",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const authorize = await app.request(new Request(
      `http://localhost:7860/api/auth/oauth2/authorize?${query}`,
      { headers: { cookie: cookie!, host: "localhost:7860" } },
    ));
    expect(authorize.status).toBe(302);
    const callback = new URL(authorize.headers.get("location")!);
    expect(callback.origin + callback.pathname).toBe(redirectUri);
    expect(callback.searchParams.get("state")).toBe("signed-in-state");
    expect(callback.searchParams.get("iss")).toBe("http://localhost:7860/api/auth");

    const token = await app.request(new Request(
      "http://localhost:7860/api/auth/oauth2/token",
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          host: "localhost:7860",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: "lumiverse-desktop",
          code: callback.searchParams.get("code")!,
          code_verifier: verifier,
          redirect_uri: redirectUri,
          resource: "urn:lumiverse:desktop-api",
        }),
      },
    ));
    expect(token.status).toBe(200);
    const tokenBody = await token.json() as { access_token: string; refresh_token?: string };
    expect(tokenBody.refresh_token).toBeTruthy();
    expect(decodeJwt(tokenBody.access_token)).toMatchObject({
      iss: "http://localhost:7860/api/auth",
      aud: expect.arrayContaining(["urn:lumiverse:desktop-api"]),
      azp: "lumiverse-desktop",
    });

    const protectedResource = await app.request(new Request(
      "http://localhost:7860/api/desktop/v1/me",
      {
        headers: {
          authorization: `Bearer ${tokenBody.access_token}`,
          host: "localhost:7860",
        },
      },
    ));
    expect(protectedResource.status).toBe(200);
    expect(await protectedResource.json()).toMatchObject({
      account: { username: "desktopowner", role: "user" },
    });
  });

  test("accepts an ephemeral loopback port and redirects an unsigned-in user to login", async () => {
    const query = new URLSearchParams({
      response_type: "code",
      client_id: "lumiverse-desktop",
      redirect_uri: "http://127.0.0.1:43123/callback",
      scope: "openid profile offline_access desktop:instance-status:read",
      resource: "urn:lumiverse:desktop-api",
      state: "state-value",
      nonce: "nonce-value",
      code_challenge: "A".repeat(43),
      code_challenge_method: "S256",
    });
    const response = await auth.handler(new Request(
      `http://localhost:7860/api/auth/oauth2/authorize?${query}`,
      { headers: { accept: "text/html", "sec-fetch-mode": "navigate" } },
    ));
    expect(response.status).toBe(302);
    const location = response.headers.get("location") || "";
    expect(location).toContain("/login?");
    expect(location).toContain("client_id=lumiverse-desktop");
    expect(location).toContain("sig=");
  });
});
