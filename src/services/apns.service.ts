import { createPrivateKey, createHash, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect, type ClientHttp2Session } from "node:http2";
import type { PushPayload } from "../types/push";

export type APNsEnvironment = "development" | "production";
export interface APNsDestination {
  device_token: string;
  bundle_id: string;
  environment: APNsEnvironment;
  server_origin: string;
}
export interface APNsConfiguration { teamId: string; keyId: string; bundleId: string; privateKey: KeyObject }

let configuration: APNsConfiguration | undefined;
let jwt: { configuration: APNsConfiguration; value: string; issuedAt: number } | undefined;
const sessions = new Map<string, ClientHttp2Session>();

/** Keys belong on the server. Nothing returned by the public info route contains a key or token. */
export function getAPNsConfiguration(): APNsConfiguration | null {
  if (configuration) return configuration;
  const teamId = process.env.APNS_TEAM_ID, keyId = process.env.APNS_KEY_ID;
  const keyPath = process.env.APNS_PRIVATE_KEY_PATH;
  if (!teamId || !keyId || !keyPath) return null;
  const bundleId = process.env.APNS_BUNDLE_ID || "chat.lumiverse.ios";
  if (!/^[A-Z0-9]{10}$/.test(teamId) || !/^[A-Z0-9]{10}$/.test(keyId)
    || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundleId)) throw new Error("Invalid APNs configuration");
  const privateKey = createPrivateKey(readFileSync(keyPath));
  if (privateKey.asymmetricKeyType !== "ec" || privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1")
    throw new Error("APNs requires an ES256 (.p8) signing key");
  return configuration = { teamId, keyId, bundleId, privateKey };
}

export function getAPNsInfo(): { configured: boolean; bundleId: string; reason: string | null } {
  try {
    const config = getAPNsConfiguration();
    return { configured: !!config, bundleId: config?.bundleId || process.env.APNS_BUNDLE_ID || "chat.lumiverse.ios",
      reason: config ? null : "The server needs an APNs signing key before it can deliver iPhone notifications." };
  } catch {
    return { configured: false, bundleId: process.env.APNS_BUNDLE_ID || "chat.lumiverse.ios",
      reason: "The server's APNs configuration is invalid. Ask the server administrator to check it." };
  }
}

export function createAPNsJWT(config: APNsConfiguration, issuedAt = Math.floor(Date.now() / 1000)): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${encode({ alg: "ES256", kid: config.keyId })}.${encode({ iss: config.teamId, iat: issuedAt })}`;
  const signature = sign("sha256", Buffer.from(input), { key: config.privateKey, dsaEncoding: "ieee-p1363" });
  return `${input}.${signature.toString("base64url")}`;
}

/** An alert payload needs no background mode and remains deliverable while the app is suspended. */
export function buildAPNsPayload(notification: PushPayload, serverOrigin?: string): string {
  const limit = (text: string, bytes: number) => {
    let result = "", size = 0;
    for (const character of text) {
      size += Buffer.byteLength(character);
      if (size > bytes) break;
      result += character;
    }
    return result;
  };
  const chatId = notification.data?.chatId ?? notification.data?.url?.match(/^\/chat\/([A-Za-z0-9_-]{1,128})$/)?.[1];
  // Navigation is constructed from an identifier, never from an arbitrary push URL.
  const payload = { aps: { alert: { title: limit(notification.title, 256), body: limit(notification.body, 2048) }, sound: "default" },
    ...(chatId && /^[A-Za-z0-9_-]{1,128}$/.test(chatId) ? { chatId } : {}),
    ...(serverOrigin ? { serverOrigin: limit(serverOrigin, 512) } : {}) };
  while (Buffer.byteLength(JSON.stringify(payload)) > 4096) {
    if (payload.aps.alert.body) payload.aps.alert.body = Array.from(payload.aps.alert.body).slice(0, -128).join("");
    else payload.aps.alert.title = Array.from(payload.aps.alert.title).slice(0, -32).join("");
  }
  return JSON.stringify(payload);
}

export interface APNsDelivery { sent: boolean; invalidatedAt?: number }

export async function sendAPNsNotification(destination: APNsDestination, notification: PushPayload): Promise<APNsDelivery> {
  const config = getAPNsConfiguration();
  if (!config || destination.bundle_id !== config.bundleId) return { sent: false };
  const now = Math.floor(Date.now() / 1000);
  if (!jwt || jwt.configuration !== config || now - jwt.issuedAt >= 20 * 60 || now < jwt.issuedAt)
    jwt = { configuration: config, value: createAPNsJWT(config, now), issuedAt: now };
  const authority = destination.environment === "development"
    ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
  let session = sessions.get(authority);
  if (!session || session.destroyed || session.closed) {
    session = connect(authority);
    sessions.set(authority, session);
    const connection = session;
    const forget = () => { if (sessions.get(authority) === connection) sessions.delete(authority); };
    connection.on("error", () => { forget(); connection.destroy(); });
    connection.on("goaway", () => { forget(); connection.close(); });
    connection.on("close", forget);
    connection.setTimeout(60_000, () => { forget(); connection.close(); });
    // An idle provider connection should not keep command-line processes alive.
    connection.unref();
  }
  const payload = buildAPNsPayload(notification, destination.server_origin);
  return new Promise((resolve, reject) => {
    const stream = session!.request({ ":method": "POST", ":path": `/3/device/${destination.device_token}`,
      authorization: `bearer ${jwt!.value}`, "apns-topic": config.bundleId, "apns-push-type": "alert",
      "apns-priority": "10", "apns-expiration": String(now + 3600),
      ...(notification.tag ? { "apns-collapse-id": createHash("sha256").update(notification.tag).digest("hex") } : {}) });
    let status = 0, body = "", ended = false;
    const timer = setTimeout(() => stream.destroy(new Error("APNs request timed out")), 15_000);
    stream.on("response", headers => { status = Number(headers[":status"]); });
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => { if (body.length < 4096) body += chunk; });
    stream.on("error", reject);
    stream.on("close", () => { clearTimeout(timer); if (!ended) reject(new Error("APNs stream closed before a response")); });
    stream.on("end", () => {
      ended = true;
      if (status === 200) { resolve({ sent: true }); return; }
      let error: { reason?: string; timestamp?: number } = {};
      try { error = JSON.parse(body); } catch { /* Non-JSON errors are not logged. */ }
      if (status === 410 && error.reason === "Unregistered" && typeof error.timestamp === "number" && Number.isFinite(error.timestamp)) {
        resolve({ sent: false, invalidatedAt: error.timestamp });
      } else {
        // Never include device tokens, JWTs, or arbitrary response bodies in logs.
        console.warn(`[apns] Delivery rejected (${status}, ${String(error.reason || "unknown").replace(/[^A-Za-z]/g, "").slice(0, 80)})`);
        resolve({ sent: false });
      }
    });
    stream.end(payload);
  });
}
