import { describe, expect, test } from "bun:test";
import { RequestHistoryStore, REQUEST_HISTORY_MAX_BODY_BYTES } from "./request-history-store";
import { redactRequestValue } from "../utils/redact-request";

const context = { origin: { kind: "chat" as const, name: "Chat", operation: "normal" }, generationId: "generation-1" };
const snapshot = (body: unknown, credentials: string[] = []) => ({ body: JSON.stringify(body), provider: "custom", model: "model-1", credentials });

describe("request history retention", () => {
  test("retains exactly the newest 20 dispatches, with separate user buffers and detached results", () => {
    const store = new RequestHistoryStore();
    store.record("alice", context, snapshot({ sequence: 0 }));
    const oldestId = store.list("alice")[0].id;
    for (let sequence = 1; sequence < 25; sequence++) store.record("alice", context, snapshot({ sequence }));
    store.record("bob", context, snapshot({ private: "bob" }));
    expect(store.list("alice")).toHaveLength(20);
    expect(store.list("alice").map((row) => JSON.parse(store.get("alice", row.id)!.bodyJson!).sequence)).toEqual(
      Array.from({ length: 20 }, (_, i) => 24 - i),
    );
    expect(store.get("alice", oldestId)).toBeNull();
    const bob = store.list("bob")[0];
    expect(store.get("alice", bob.id)).toBeNull();
    expect("bodyJson" in bob).toBe(false);
    bob.origin.name = "modified";
    expect(store.get("bob", bob.id)!.origin.name).toBe("Chat");
    store.clear("alice");
    expect(store.list("alice")).toEqual([]);
    expect(store.list("bob")).toHaveLength(1);
  });

  test("marks oversized and invalid bodies unavailable without storing fragments", () => {
    const store = new RequestHistoryStore();
    store.record("alice", context, snapshot({ text: "x".repeat(REQUEST_HISTORY_MAX_BODY_BYTES) }));
    let row = store.get("alice", store.list("alice")[0].id)!;
    expect(row.bodyJson).toBeNull();
    expect(row.bodyUnavailable).toBe("too_large");
    store.record("alice", context, { ...snapshot({}), body: '{"api_key":"never-display-this"' });
    row = store.get("alice", store.list("alice")[0].id)!;
    expect(row.bodyJson).toBeNull();
    expect(row.bodyUnavailable).toBe("unavailable");
    expect(JSON.stringify(row)).not.toContain("never-display-this");
  });

  test("records tool rounds and concurrent sends individually under a shared generation", async () => {
    const store = new RequestHistoryStore();
    await Promise.all(Array.from({ length: 40 }, async (_, round) => {
      await Promise.resolve();
      store.record("alice", context, snapshot({ round }));
    }));
    const rows = store.list("alice");
    expect(rows).toHaveLength(20);
    expect(new Set(rows.map((row) => row.id)).size).toBe(20);
    expect(rows.every((row) => row.generationId === "generation-1")).toBe(true);
    expect(rows.every((row) => row.sentAt <= Date.now())).toBe(true);
  });
});

describe("credential redaction", () => {
  test("redacts nested fields, embedded JSON, keys, URL values, and metadata without changing input", () => {
    const credential = 'provider-secret-with-"quotes"/and+symbols';
    const other = "unrelated-custom-secret";
    const body = {
      api_key: other, max_tokens: 100, top_p: 0.9,
      messages: [{ role: "user", content: `value ${credential} and ${other}` }],
      tools: [{ arguments: JSON.stringify({ credentials: { key: other }, value: credential }) }],
      nested: [{ "X-Api-Key": other, clientSecret: other, Authorization: `Bearer ${other}` }],
      url: `https://example.test?key=${other}&page=1`,
      [credential]: "secret property name",
    };
    const original = JSON.stringify(body);
    const store = new RequestHistoryStore();
    store.record("alice", { ...context, origin: { kind: "extension", name: credential, extensionId: credential } }, {
      ...snapshot(body, [credential]), model: credential,
    });
    const row = store.get("alice", store.list("alice")[0].id)!;
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(other);
    expect(serialized).not.toContain("provider-secret");
    expect(serialized).toContain("[REDACTED]");
    expect(row.redacted).toBe(true);
    expect(JSON.parse(row.bodyJson!).max_tokens).toBe(100);
    expect(JSON.parse(row.bodyJson!).top_p).toBe(0.9);
    expect(JSON.stringify(body)).toBe(original);
    expect(JSON.parse(JSON.parse(row.bodyJson!).tools[0].arguments).credentials).toBe("[REDACTED]");
  });

  test("redacts service-account private keys and encoded resolved credentials", () => {
    const secret = "a/private+credential=with-symbols";
    const account = JSON.stringify({ project_id: "demo", private_key: secret, client_email: "test@example.test" });
    const safe = redactRequestValue({ text: secret, encoded: encodeURIComponent(secret), account, project: "demo" }, [account]);
    expect(JSON.stringify(safe)).not.toContain("credential");
    expect((safe as any).project).toBe("demo");
  });

  test("recognizes credentials inside plain text even without a named object field", () => {
    const safe = redactRequestValue({ text: "api_key=unknown-credential Bearer bearer-credential https://example.test?access_token=url-credential" }, []);
    expect(JSON.stringify(safe)).not.toContain("credential");
  });

  test("redacts provider-prefixed credential fields and their copies without changing token limits", () => {
    const safe = redactRequestValue({
      google_api_key: "custom-google-credential", providerAccessToken: "custom-provider-credential",
      text: "custom-google-credential api_key=custom-provider-credential",
      max_output_tokens: 4000, token_limit: 100,
    }, []) as any;
    expect(safe.google_api_key).toBe("[REDACTED]");
    expect(safe.providerAccessToken).toBe("[REDACTED]");
    expect(safe.text).toBe("[REDACTED] api_key=[REDACTED]");
    expect(safe.max_output_tokens).toBe(4000);
    expect(safe.token_limit).toBe(100);
  });
});
