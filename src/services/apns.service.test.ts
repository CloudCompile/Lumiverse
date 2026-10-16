import { afterAll, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const directory = mkdtempSync(join(tmpdir(), "lumiverse-apns-test-"));
const keyPath = join(directory, "AuthKey.p8");
writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
const variables = ["APNS_TEAM_ID", "APNS_KEY_ID", "APNS_PRIVATE_KEY_PATH", "APNS_BUNDLE_ID"];
const previous = Object.fromEntries(variables.map(key => [key, process.env[key]]));
Object.assign(process.env, { APNS_TEAM_ID: "TEAM123456", APNS_KEY_ID: "KEY1234567", APNS_PRIVATE_KEY_PATH: keyPath, APNS_BUNDLE_ID: "chat.lumiverse.ios" });
let responseStatus = 200, responseBody = "", authority = "", lastHeaders: Record<string, unknown> = {}, lastPayload = "";
let requestCount = 0;
class Session extends EventEmitter {
  closed = false; destroyed = false;
  setTimeout() {} unref() {} close() { this.closed = true } destroy() { this.destroyed = true }
  request(headers: Record<string, unknown>) {
    requestCount++; lastHeaders = headers;
    const stream = new EventEmitter() as EventEmitter & { setEncoding(): void; end(body: string): void; destroy(error: Error): void };
    stream.setEncoding = () => {};
    stream.destroy = error => { stream.emit("error", error); stream.emit("close") };
    stream.end = body => {
      lastPayload = body;
      queueMicrotask(() => { stream.emit("response", { ":status": responseStatus }); stream.emit("data", responseBody); stream.emit("end"); stream.emit("close") });
    };
    return stream;
  }
}
mock.module("node:http2", () => ({ connect: (url: string) => { authority = url; return new Session() } }));
const { createAPNsJWT, buildAPNsPayload, sendAPNsNotification, getAPNsInfo } = await import("./apns.service");
afterAll(() => {
  for (const key of variables) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key] }
  rmSync(directory, { recursive: true, force: true });
  mock.restore();
});

describe("native APNs provider", () => {
  test("creates a verifiable ES256 JWT with Apple's key and team fields", () => {
    const token = createAPNsJWT({ teamId: "TEAM123456", keyId: "KEY1234567", bundleId: "chat.lumiverse.ios", privateKey }, 1234567890);
    const [header, claims, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "ES256", kid: "KEY1234567" });
    expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toEqual({ iss: "TEAM123456", iat: 1234567890 });
    expect(verify("sha256", Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature!, "base64url"))).toBe(true);
    expect(JSON.stringify(getAPNsInfo())).not.toContain("PRIVATE KEY");
  });
  test("bounds the serialized UTF-8 payload and accepts only chat identifiers for navigation", () => {
    const payload = buildAPNsPayload({ title: "✨".repeat(1000), body: "\u0000😀\n".repeat(2000), data: { chatId: "../other", url: "https://evil.example" } }, "https://lumiverse.example.com");
    expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(4096);
    expect(JSON.parse(payload)).not.toHaveProperty("chatId");
    expect(payload).not.toContain("evil.example");
    expect(JSON.parse(buildAPNsPayload({ title: "Ready", body: "Done", data: { chatId: "chat-123" } }))).toHaveProperty("chatId", "chat-123");
  });
  test("uses HTTP/2 with the correct APNs environment and alert headers", async () => {
    const destination = { device_token: "ab".repeat(32), bundle_id: "chat.lumiverse.ios", environment: "development" as const, server_origin: "https://lumiverse.example.com" };
    expect(await sendAPNsNotification(destination, { title: "Ready", body: "Done" })).toEqual({ sent: true });
    expect(authority).toBe("https://api.sandbox.push.apple.com");
    expect(lastHeaders).toMatchObject({ ":method": "POST", ":path": `/3/device/${destination.device_token}`, "apns-topic": "chat.lumiverse.ios", "apns-push-type": "alert", "apns-priority": "10" });
    expect(lastHeaders.authorization).toMatch(/^bearer /);
    expect(JSON.parse(lastPayload)).toHaveProperty("serverOrigin", destination.server_origin);
    responseStatus = 410; responseBody = JSON.stringify({ reason: "Unregistered", timestamp: 1234567890000 });
    expect(await sendAPNsNotification({ ...destination, environment: "production" }, { title: "Ready", body: "Done" }))
      .toEqual({ sent: false, invalidatedAt: 1234567890000 });
    expect(authority).toBe("https://api.push.apple.com");
    const before = requestCount;
    expect(await sendAPNsNotification({ ...destination, bundle_id: "another.app" }, { title: "Ready", body: "Done" })).toEqual({ sent: false });
    expect(requestCount).toBe(before);
  });
});
