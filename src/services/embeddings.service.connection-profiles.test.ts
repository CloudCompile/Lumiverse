import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as settingsSvc from "./settings.service";
import * as secretsSvc from "./secrets.service";
import { embeddingCache, computeCacheKey } from "./embedding-cache";
import {
  EMBEDDING_ERROR_CODES,
  EMBEDDING_SETTINGS_KEY,
  EmbeddingError,
  areProfileDimensionsCompatible,
  cachedEmbedTexts,
  embedInBatches,
  embedQuery,
  embedTexts,
  embeddingProfileSecretKey,
  getEmbeddingConfig,
  isUsableProfileId,
  previewEmbeddingModels,
  selectFallbackChain,
  updateEmbeddingConfig,
} from "./embeddings.service";

const USER = "profile-user";
const PRIMARY_ID = "11111111-1111-4111-8111-111111111111";
const FALLBACK_ID = "22222222-2222-4222-8222-222222222222";
const INCOMPAT_ID = "33333333-3333-4333-8333-333333333333";
const UNKNOWN_ID = "44444444-4444-4444-8444-444444444444";

const settings = new Map<string, unknown>();
const secrets = new Map<string, string>();
const spies: Array<{ mockRestore(): void }> = [];

function sk(userId: string, key: string): string {
  return `${userId}::${key}`;
}

function putCfg(value: unknown): void {
  settings.set(sk(USER, EMBEDDING_SETTINGS_KEY), value);
}

function openaiBody(dims = 2): { data: Array<{ embedding: number[] }> } {
  return { data: [{ embedding: Array.from({ length: dims }, (_, i) => i + 0.25) }] };
}

type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** bun:test's spyOn(mockImplementation) requires the full Bun fetch shape,
 *  which carries a preconnect method the plain stubs below omit. */
function asFetchStub(fn: FetchStub): typeof fetch {
  const stub = Object.assign(fn.bind(globalThis), { preconnect() {} });
  return stub as typeof fetch;
}

function enabledProfiles(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    provider: "openai-compatible",
    api_url: "https://primary.test/v1/embeddings",
    model: "text-embedding-3-small",
    dimensions: 2,
    send_dimensions: false,
    request_timeout: 30,
    connectionProfiles: [
      {
        id: PRIMARY_ID,
        provider: "openai-compatible",
        model: "text-embedding-3-small",
        api_url: "https://primary.test/v1/embeddings",
        dimensions: 2,
        enabled: true,
      },
      {
        id: FALLBACK_ID,
        provider: "openai-compatible",
        model: "text-embedding-3-small",
        api_url: "https://fallback.test/v1/embeddings",
        dimensions: 2,
        enabled: true,
      },
    ],
    primaryProfileId: PRIMARY_ID,
    fallbackProfileIds: [FALLBACK_ID],
    ...overrides,
  };
}

beforeEach(() => {
  settings.clear();
  secrets.clear();
  embeddingCache.clear();
  spies.push(
    spyOn(settingsSvc, "getSetting").mockImplementation((userId: string, key: string) => {
      const value = settings.get(sk(userId, key));
      return value === undefined ? null : { key, value, updated_at: 0 };
    }),
    spyOn(settingsSvc, "putSetting").mockImplementation((userId: string, key: string, value: unknown) => {
      settings.set(sk(userId, key), value);
      return { key, value, updated_at: 0 };
    }),
    spyOn(secretsSvc, "getSecret").mockImplementation(async (userId: string, key: string) => {
      return secrets.get(sk(userId, key)) ?? null;
    }),
    spyOn(secretsSvc, "getSecretForStatus").mockImplementation(async (userId: string, key: string) => {
      return secrets.get(sk(userId, key)) ?? null;
    }),
    spyOn(secretsSvc, "putSecret").mockImplementation(async (userId: string, key: string, value: string) => {
      secrets.set(sk(userId, key), value);
    }),
    spyOn(secretsSvc, "deleteSecret").mockImplementation((userId: string, key: string) => {
      return secrets.delete(sk(userId, key));
    }),
  );
});

afterEach(() => {
  while (spies.length > 0) spies.pop()?.mockRestore();
  embeddingCache.clear();
});

describe("embedding connection profiles", () => {
  for (const status of [429, 503, 413]) {
    test(`query embedding fails once on HTTP ${status} without shortening and resending`, async () => {
      putCfg(enabledProfiles({ fallbackProfileIds: [] }));
      secrets.set(sk(USER, embeddingProfileSecretKey(PRIMARY_ID)), "test-key");
      const sent: unknown[] = [];
      spies.push(spyOn(globalThis, "fetch").mockImplementation(asFetchStub(async (_input, init) => {
        sent.push(JSON.parse(String(init?.body)));
        return new Response("input too large or provider unavailable", { status });
      })));
      await expect(embedQuery(USER, "Long query. ".repeat(1000))).rejects.toBeInstanceOf(EmbeddingError);
      expect(sent).toHaveLength(1);
    });

    test(`embedding batches fail once on HTTP ${status} without splitting and resending`, async () => {
      putCfg(enabledProfiles({ fallbackProfileIds: [] }));
      secrets.set(sk(USER, embeddingProfileSecretKey(PRIMARY_ID)), "test-key");
      let calls = 0;
      spies.push(spyOn(globalThis, "fetch").mockImplementation(asFetchStub(async () => {
        calls++;
        return new Response("input too large or provider unavailable", { status });
      })));
      const failed: string[][] = [];
      const inputs = ["First passage", "Second passage", "Third passage"];
      await embedInBatches(USER, inputs, 3, (text) => text,
        async () => { throw new Error("Failed batches must not be persisted"); },
        (batch) => { failed.push(batch); });
      expect(calls).toBe(1);
      expect(failed).toEqual([inputs]);
    });
  }

  test("persists the generated default profile so its connection id is stable", async () => {
    const first = await getEmbeddingConfig(USER);
    const second = await getEmbeddingConfig(USER);

    expect(first.connectionProfiles[0]?.id).toBe(second.connectionProfiles[0]?.id);
    expect(first.connectionProfiles[0]?.name).toBe("OpenAI Compatible");
  });

  test("migrates old single-provider config into a UUID profile, not a literal default id", async () => {
    putCfg({
      enabled: true,
      provider: "openai",
      api_url: "https://api.openai.com/v1/embeddings",
      model: "text-embedding-3-small",
      dimensions: 1536,
    });

    const cfg = await getEmbeddingConfig(USER);
    expect(cfg.connectionProfiles).toHaveLength(1);
    const profile = cfg.connectionProfiles[0];
    expect(isUsableProfileId(profile.id)).toBe(true);
    expect(profile.id).not.toBe("default");
    expect(profile.provider).toBe("openai");
    expect(profile.model).toBe("text-embedding-3-small");
    expect(profile.dimensions).toBe(1536);
    expect(cfg.primaryProfileId).toBe(profile.id);
    expect(cfg.fallbackProfileIds).toEqual([]);

    const stored = settings.get(sk(USER, EMBEDDING_SETTINGS_KEY)) as { connectionProfiles?: Array<{ id: string }> };
    expect(stored.connectionProfiles?.[0]?.id).toBe(profile.id);
  });

  test("legacy flat saves update the active profile and keep its credential on the selected provider", async () => {
    putCfg(enabledProfiles({
      connectionProfiles: [enabledProfiles().connectionProfiles[0]],
      fallbackProfileIds: [],
    }));
    let requestUrl = "";
    let authorization = "";
    spies.push(spyOn(globalThis, "fetch").mockImplementation(asFetchStub(async (input, init) => {
      requestUrl = String(input);
      authorization = new Headers(init?.headers).get("authorization") || "";
      return Response.json(openaiBody(2));
    })));

    const updated = await updateEmbeddingConfig(USER, {
      provider: "bananabread",
      api_url: "http://localhost:8008/v1/embeddings",
      model: "mixedbread-ai/mxbai-embed-large-v1",
      api_key: "bananabread-user-key",
    });
    await embedTexts(USER, ["hello"]);

    expect(updated.provider).toBe("bananabread");
    expect(updated.api_url).toBe("http://localhost:8008/v1/embeddings");
    expect(updated.connectionProfiles[0]).toEqual(expect.objectContaining({
      id: PRIMARY_ID,
      provider: "bananabread",
      api_url: "http://localhost:8008/v1/embeddings",
      model: "mixedbread-ai/mxbai-embed-large-v1",
      hasSecret: true,
    }));
    expect(secrets.get(sk(USER, embeddingProfileSecretKey(PRIMARY_ID)))).toBe("bananabread-user-key");
    expect(requestUrl).toBe("http://localhost:8008/v1/embeddings");
    expect(authorization).toBe("Bearer bananabread-user-key");
  });

  test("copies a selected OpenAI-compatible LLM connection key into its dedicated embedding profile", async () => {
    const legacyKey = "shared-openai-compatible-key";
    putCfg(enabledProfiles());
    secrets.set(sk(USER, `connection_${PRIMARY_ID}_api_key`), legacyKey);

    const cfg = await getEmbeddingConfig(USER);

    expect(cfg.connectionProfiles[0]?.hasSecret).toBe(true);
    expect(secrets.get(sk(USER, embeddingProfileSecretKey(PRIMARY_ID)))).toBe(legacyKey);
    expect(secrets.get(sk(USER, `connection_${PRIMARY_ID}_api_key`))).toBe(legacyKey);
  });

  test("canonicalizes a general custom connection into a runnable OpenAI-compatible embedding connection", async () => {
    putCfg(enabledProfiles({
      provider: "custom",
      connectionProfiles: [{
        id: PRIMARY_ID,
        provider: "custom",
        model: "local-embed-model",
        api_url: "https://local.example/v1",
        dimensions: 1024,
        enabled: true,
      }],
      primaryProfileId: PRIMARY_ID,
      fallbackProfileIds: [],
    }));
    secrets.set(sk(USER, `connection_${PRIMARY_ID}_api_key`), "local-key");
    let requestUrl = "";
    spies.push(spyOn(globalThis, "fetch").mockImplementation(asFetchStub(async (input) => {
      requestUrl = String(input);
      return Response.json(openaiBody(2));
    })));

    const cfg = await getEmbeddingConfig(USER);
    const vectors = await embedTexts(USER, ["hello"]);
    const stored = settings.get(sk(USER, EMBEDDING_SETTINGS_KEY)) as { connectionProfiles: Array<{ provider: string }> };

    expect(cfg.provider).toBe("openai-compatible");
    expect(cfg.connectionProfiles[0]?.provider).toBe("openai-compatible");
    expect(cfg.connectionProfiles[0]?.api_url).toBe("https://local.example/v1");
    expect(stored.connectionProfiles[0]?.provider).toBe("openai-compatible");
    expect(requestUrl).toBe("https://local.example/v1/embeddings");
    expect(vectors[0]).toHaveLength(2);
  });

  test("browses models with the selected dedicated profile endpoint and key", async () => {
    putCfg(enabledProfiles());
    secrets.set(sk(USER, embeddingProfileSecretKey(FALLBACK_ID)), "fallback-key");
    let requestUrl = "";
    let authorization = "";
    spies.push(spyOn(globalThis, "fetch").mockImplementation(asFetchStub(async (input, init) => {
      requestUrl = String(input);
      authorization = new Headers(init?.headers).get("authorization") || "";
      return Response.json({ data: [{ id: "embed-b" }, { id: "embed-a" }] });
    })));

    const result = await previewEmbeddingModels(USER, { profile_id: FALLBACK_ID });

    expect(requestUrl).toBe("https://fallback.test/v1/models");
    expect(authorization).toBe("Bearer fallback-key");
    expect(result.models).toEqual(["embed-a", "embed-b"]);
  });

  test("uses Mistral's native embedding fields and OpenAI-shaped response", async () => {
    putCfg(enabledProfiles({
      provider: "mistral",
      api_url: "https://api.mistral.ai/v1/embeddings",
      model: "mistral-embed",
      dimensions: 512,
      send_dimensions: true,
      connectionProfiles: [{
        id: PRIMARY_ID,
        provider: "mistral",
        model: "mistral-embed",
        api_url: "https://api.mistral.ai/v1/embeddings",
        dimensions: 512,
        enabled: true,
      }],
      fallbackProfileIds: [],
    }));
    secrets.set(sk(USER, embeddingProfileSecretKey(PRIMARY_ID)), "mistral-key");
    let requestUrl = "";
    let body: Record<string, unknown> = {};
    spies.push(spyOn(globalThis, "fetch").mockImplementation(asFetchStub(async (input, init) => {
      requestUrl = String(input);
      body = JSON.parse(String(init?.body));
      return Response.json({ data: [{ embedding: [0.1, 0.2] }] });
    })));

    const vectors = await embedTexts(USER, ["hello"]);

    expect(requestUrl).toBe("https://api.mistral.ai/v1/embeddings");
    expect(body).toEqual({
      model: "mistral-embed",
      input: ["hello"],
      encoding_format: "float",
      output_dimension: 512,
    });
    expect(body).not.toHaveProperty("dimensions");
    expect(vectors).toEqual([[0.1, 0.2]]);
  });

  test("uses Cohere v2 query semantics, response shape, dimensions, and 96-text batches", async () => {
    putCfg(enabledProfiles({
      provider: "cohere",
      api_url: "https://api.cohere.com/v2/embed",
      model: "embed-v4.0",
      dimensions: 512,
      send_dimensions: true,
      connectionProfiles: [{
        id: PRIMARY_ID,
        provider: "cohere",
        model: "embed-v4.0",
        api_url: "https://api.cohere.com/v2/embed",
        dimensions: 512,
        enabled: true,
      }],
      fallbackProfileIds: [],
    }));
    secrets.set(sk(USER, embeddingProfileSecretKey(PRIMARY_ID)), "cohere-key");
    const bodies: Array<Record<string, any>> = [];
    spies.push(spyOn(globalThis, "fetch").mockImplementation(asFetchStub(async (input, init) => {
      expect(String(input)).toBe("https://api.cohere.com/v2/embed");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer cohere-key");
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      bodies.push(body);
      return Response.json({
        embeddings: { float: body.texts.map(() => [0.25, 0.75]) },
      });
    })));
    const texts = Array.from({ length: 97 }, (_, index) => `query ${index}`);

    const vectors = await embedTexts(USER, texts, { inputType: "query" });

    expect(bodies.map((body) => body.texts.length)).toEqual([96, 1]);
    expect(bodies[0]).toEqual(expect.objectContaining({
      model: "embed-v4.0",
      input_type: "search_query",
      embedding_types: ["float"],
      output_dimension: 512,
    }));
    expect(bodies[0]).not.toHaveProperty("input");
    expect(bodies[0]).not.toHaveProperty("dimensions");
    expect(vectors).toHaveLength(97);
  });

  test("browses only embedding models through Mistral and Cohere's native catalogues", async () => {
    putCfg(enabledProfiles({
      provider: "mistral",
      connectionProfiles: [
        {
          id: PRIMARY_ID,
          provider: "mistral",
          model: "mistral-embed",
          api_url: "https://api.mistral.ai/v1/embeddings",
          dimensions: 1024,
          enabled: true,
        },
        {
          id: FALLBACK_ID,
          provider: "cohere",
          model: "embed-v4.0",
          api_url: "https://api.cohere.com/v2/embed",
          dimensions: 1024,
          enabled: true,
        },
      ],
    }));
    secrets.set(sk(USER, embeddingProfileSecretKey(PRIMARY_ID)), "mistral-key");
    secrets.set(sk(USER, embeddingProfileSecretKey(FALLBACK_ID)), "cohere-key");
    const urls: string[] = [];
    spies.push(spyOn(globalThis, "fetch").mockImplementation(asFetchStub(async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("mistral.ai")) {
        return Response.json({ data: [{ id: "mistral-small-latest" }, { id: "new-embed-model" }] });
      }
      return Response.json({
        models: [
          { name: "embed-v4.0", is_deprecated: false },
          { name: "embed-old", is_deprecated: true },
        ],
      });
    })));

    const mistral = await previewEmbeddingModels(USER, { profile_id: PRIMARY_ID });
    const cohere = await previewEmbeddingModels(USER, { profile_id: FALLBACK_ID });

    expect(urls[0]).toBe("https://api.mistral.ai/v1/models");
    expect(mistral.models).toEqual(["codestral-embed-2505", "mistral-embed", "new-embed-model"]);
    expect(urls[1]).toBe("https://api.cohere.com/v1/models?endpoint=embed&page_size=1000");
    expect(cohere.models).toEqual(["embed-v4.0"]);
  });

  test("preserves unknown provider ids and Vertex project/region controls", async () => {
    putCfg({
      enabled: true,
      provider: "future-vendor",
      api_url: "https://future.example/v1/embeddings",
      model: "embed-x",
      dimensions: 1024,
    });
    const updated = await updateEmbeddingConfig(USER, {
      enabled: true,
      connectionProfiles: [
        {
          id: UNKNOWN_ID,
          provider: "future-vendor",
          model: "embed-x",
          api_url: "https://future.example/v1/embeddings",
          dimensions: 1024,
          enabled: true,
        },
        {
          id: PRIMARY_ID,
          provider: "google_vertex",
          model: "text-embedding-004",
          api_url: "https://aiplatform.googleapis.com",
          dimensions: 768,
          enabled: true,
          vertex_region: "us-central1",
          vertex_project: "lumiverse-proj",
        },
      ],
      primaryProfileId: UNKNOWN_ID,
      fallbackProfileIds: [PRIMARY_ID],
    });

    expect(updated.connectionProfiles[0].provider).toBe("future-vendor");
    const vertex = updated.connectionProfiles.find((p) => p.id === PRIMARY_ID);
    expect(vertex?.vertex_region).toBe("us-central1");
    expect(vertex?.vertex_project).toBe("lumiverse-proj");
    expect(JSON.stringify(updated)).not.toContain("embedding-profile/");
    expect((updated as { secretRef?: unknown }).secretRef).toBeUndefined();
  });

  test("DTO exposes hasSecret and never leaks secret refs or values", async () => {
    const secret = "sk-super-secret-value";
    secrets.set(sk(USER, embeddingProfileSecretKey(PRIMARY_ID)), secret);
    putCfg(enabledProfiles());

    const cfg = await getEmbeddingConfig(USER);
    const serialized = JSON.stringify(cfg);
    expect(cfg.connectionProfiles[0].hasSecret).toBe(true);
    expect(cfg.has_api_key).toBe(true);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("embedding-profile/");
    expect(serialized).not.toContain(embeddingProfileSecretKey(PRIMARY_ID));
  });

  test("selectFallbackChain skips dimension-incompatible fallbacks", () => {
    const chain = selectFallbackChain({
      connectionProfiles: [
        { id: PRIMARY_ID, provider: "openai", model: "a", api_url: "https://a", dimensions: 1536, enabled: true },
        { id: INCOMPAT_ID, provider: "openai", model: "b", api_url: "https://b", dimensions: 768, enabled: true },
        { id: FALLBACK_ID, provider: "openai", model: "c", api_url: "https://c", dimensions: 1536, enabled: true },
      ],
      primaryProfileId: PRIMARY_ID,
      fallbackProfileIds: [INCOMPAT_ID, FALLBACK_ID],
    });
    expect(chain.map((p) => p.id)).toEqual([PRIMARY_ID, FALLBACK_ID]);
    expect(areProfileDimensionsCompatible({ dimensions: 1536 }, { dimensions: 768 })).toBe(false);
  });

  test("falls back when primary is unavailable and reports embedding_fallback_exhausted", async () => {
    putCfg(enabledProfiles());
    secrets.set(sk(USER, embeddingProfileSecretKey(PRIMARY_ID)), "primary-key");
    secrets.set(sk(USER, embeddingProfileSecretKey(FALLBACK_ID)), "fallback-key");

    const urls: string[] = [];
    spies.push(spyOn(globalThis, "fetch").mockImplementation(asFetchStub(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("primary.test")) {
        return new Response("primary down", { status: 503 });
      }
      return new Response("fallback down", { status: 503 });
    })));

    try {
      await embedTexts(USER, ["hello"]);
      throw new Error("expected embedTexts to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(EmbeddingError);
      expect((err as EmbeddingError).code).toBe(EMBEDDING_ERROR_CODES.FALLBACK_EXHAUSTED);
      expect((err as Error).message).not.toContain("embedding-profile/");
    }
    expect(urls.some((url) => url.includes("primary.test"))).toBe(true);
    expect(urls.some((url) => url.includes("fallback.test"))).toBe(true);
  });

  test("reports embedding_provider_unavailable when the only profile cannot run", async () => {
    putCfg(enabledProfiles({
      connectionProfiles: [{
        id: PRIMARY_ID,
        provider: "future-vendor",
        model: "x",
        api_url: "https://primary.test/v1/embeddings",
        dimensions: 2,
        enabled: true,
      }],
      fallbackProfileIds: [],
    }));
    secrets.set(sk(USER, embeddingProfileSecretKey(PRIMARY_ID)), "primary-key");

    try {
      await embedTexts(USER, ["hello"]);
      throw new Error("expected embedTexts to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(EmbeddingError);
      expect((err as EmbeddingError).code).toBe(EMBEDDING_ERROR_CODES.PROVIDER_UNAVAILABLE);
    }
  });

  test("caller aborts primary without starting fallback", async () => {
    putCfg(enabledProfiles());
    secrets.set(sk(USER, embeddingProfileSecretKey(PRIMARY_ID)), "primary-key");
    secrets.set(sk(USER, embeddingProfileSecretKey(FALLBACK_ID)), "fallback-key");

    const controller = new AbortController();
    const urls: string[] = [];
    let releasePrimary: ((err: Error) => void) | undefined;
    spies.push(spyOn(globalThis, "fetch").mockImplementation(asFetchStub((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      return new Promise<Response>((_resolve, reject) => {
        const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
        init?.signal?.addEventListener("abort", onAbort, { once: true });
        if (url.includes("primary.test")) {
          releasePrimary = onAbort;
        }
      });
    })));

    const pending = embedTexts(USER, ["hello"], { signal: controller.signal });
    await Bun.sleep(10);
    controller.abort();
    try {
      await pending;
      throw new Error("expected abort");
    } catch (err) {
      expect(isEmbeddingAbort(err)).toBe(true);
    }
    releasePrimary?.(new DOMException("Aborted", "AbortError"));
    expect(urls.some((url) => url.includes("primary.test"))).toBe(true);
    expect(urls.some((url) => url.includes("fallback.test"))).toBe(false);
  });

  test("caller abort leaves no partial cache or write and returns stable cancellation", async () => {
    putCfg(enabledProfiles());
    secrets.set(sk(USER, embeddingProfileSecretKey(PRIMARY_ID)), "primary-key");
    secrets.set(sk(USER, embeddingProfileSecretKey(FALLBACK_ID)), "fallback-key");

    const controller = new AbortController();
    spies.push(spyOn(globalThis, "fetch").mockImplementation(asFetchStub((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
    })));

    const pending = cachedEmbedTexts(USER, ["cache-me"], { signal: controller.signal });
    await Bun.sleep(10);
    controller.abort();
    try {
      await pending;
      throw new Error("expected abort");
    } catch (err) {
      expect(isEmbeddingAbort(err)).toBe(true);
      expect((err as { name?: string }).name).toBe("AbortError");
    }

    const fp = { provider: "openai-compatible", model: "text-embedding-3-small", dimensions: 2, api_url: "https://primary.test/v1/embeddings" };
    expect(embeddingCache.get(computeCacheKey("cache-me", fp))).toBeNull();
  });

  test("resolves the opaque secret only at embedding driver invocation", async () => {
    putCfg(enabledProfiles());
    secrets.set(sk(USER, embeddingProfileSecretKey(PRIMARY_ID)), "primary-key");
    secrets.set(sk(USER, embeddingProfileSecretKey(FALLBACK_ID)), "fallback-key");

    const secretReads: string[] = [];
    const statusReads: string[] = [];
    spies[2]?.mockRestore();
    spies[3]?.mockRestore();
    spies[2] = spyOn(secretsSvc, "getSecret").mockImplementation(async (userId: string, key: string) => {
      secretReads.push(key);
      return secrets.get(sk(userId, key)) ?? null;
    });
    spies[3] = spyOn(secretsSvc, "getSecretForStatus").mockImplementation(async (userId: string, key: string) => {
      statusReads.push(key);
      return secrets.get(sk(userId, key)) ?? null;
    });

    await getEmbeddingConfig(USER);
    expect(secretReads).toEqual([]);
    expect(statusReads.length).toBeGreaterThan(0);

    spies.push(spyOn(globalThis, "fetch").mockImplementation(asFetchStub(async () => {
      expect(secretReads).toContain(embeddingProfileSecretKey(PRIMARY_ID));
      return new Response(JSON.stringify(openaiBody()), { status: 200, headers: { "Content-Type": "application/json" } });
    })));

    await embedTexts(USER, ["hello"]);
    expect(secretReads).toEqual([embeddingProfileSecretKey(PRIMARY_ID)]);
    expect(secretReads).not.toContain(embeddingProfileSecretKey(FALLBACK_ID));
  });

  test("redacts secret values and refs from provider errors", async () => {
    const secret = "sk-leak-me-now";
    putCfg(enabledProfiles({ fallbackProfileIds: [] }));
    secrets.set(sk(USER, embeddingProfileSecretKey(PRIMARY_ID)), secret);

    spies.push(spyOn(globalThis, "fetch").mockImplementation(asFetchStub(async () => {
      return new Response(
        `denied Bearer ${secret} at embedding-profile/${PRIMARY_ID}/apiKey`,
        { status: 401 },
      );
    })));

    try {
      await embedTexts(USER, ["hello"]);
      throw new Error("expected failure");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain(secret);
      expect(message).not.toContain("embedding-profile/");
      expect(message).toContain("[redacted]");
    }
  });

  test("uses fallback when primary fails and dimensions match", async () => {
    putCfg(enabledProfiles());
    secrets.set(sk(USER, embeddingProfileSecretKey(PRIMARY_ID)), "primary-key");
    secrets.set(sk(USER, embeddingProfileSecretKey(FALLBACK_ID)), "fallback-key");

    spies.push(spyOn(globalThis, "fetch").mockImplementation(asFetchStub(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("primary.test")) return new Response("nope", { status: 500 });
      return new Response(JSON.stringify(openaiBody()), { status: 200, headers: { "Content-Type": "application/json" } });
    })));

    const vectors = await embedTexts(USER, ["hello"]);
    expect(vectors[0]?.length).toBe(2);
  });
});

function isEmbeddingAbort(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  return name === "AbortError" || /abort/i.test((err as { message?: string }).message || "");
}
