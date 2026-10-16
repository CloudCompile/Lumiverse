import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { clearOpenRouterMetadataCache, normalizeOpenRouterEndpointModel, OpenRouterProvider } from "./openrouter";
import { injectConnectionMetadataFlags } from "../../services/generation/connection-metadata";

const provider = new OpenRouterProvider();
let fetchSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => { fetchSpy?.mockRestore(); clearOpenRouterMetadataCache(); });

describe("OpenRouter endpoint discovery", () => {
  test("retains exact tier and region tags and caches by model and API URL", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ data: { endpoints: [
      { provider_name: "OpenAI", tag: "openai" },
      { provider_name: "OpenAI", tag: "openai/flex" },
      { provider_name: "OpenAI", tag: "openai/flex" },
      { provider_name: "Azure", tag: "azure/eu" },
    ] } })) as typeof fetch);
    const endpoints = await provider.fetchModelEndpoints("placeholder", "", " openai/gpt-5.4:floor ");
    expect(endpoints).toEqual([
      { name: "OpenAI", slug: "openai" },
      { name: "OpenAI", slug: "openai/flex" },
      { name: "Azure", slug: "azure/eu" },
    ]);
    expect(String(fetchSpy.mock.calls[0][0])).toBe("https://openrouter.ai/api/v1/models/openai/gpt-5.4/endpoints");
    expect(fetchSpy.mock.calls[0][1]?.headers).toHaveProperty("Authorization");
    await provider.fetchModelEndpoints("placeholder", "", "openai/gpt-5.4:nitro");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await provider.fetchModelEndpoints("placeholder", "", "openai/gpt-5");
    await provider.fetchModelEndpoints("placeholder", "https://proxy.test/v1", "openai/gpt-5.4");
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(String(fetchSpy.mock.calls[2][0])).toBe("https://proxy.test/v1/models/openai/gpt-5.4/endpoints");
    clearOpenRouterMetadataCache();
    await provider.fetchModelEndpoints("placeholder", "", "openai/gpt-5.4");
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  test("normalizes routing variants without stripping catalog variants", () => {
    expect(normalizeOpenRouterEndpointModel("vendor/model:free")).toBe("vendor/model:free");
    expect(normalizeOpenRouterEndpointModel("vendor/model:free:floor")).toBe("vendor/model:free");
    for (const model of ["", "model", "vendor/", "../model", "vendor/..", "vendor/model?url=other", "vendor/model/extra"]) {
      expect(normalizeOpenRouterEndpointModel(model)).toBeNull();
    }
  });

  test("reports discovery failures and allows a subsequent retry", async () => {
    fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ error: { message: "Unavailable" } }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ data: { endpoints: [] } }));
    await expect(provider.fetchModelEndpoints("placeholder", "", "vendor/model")).rejects.toThrow("Unavailable");
    expect(await provider.fetchModelEndpoints("placeholder", "", "vendor/model")).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("OpenRouter Flex routing at dispatch", () => {
  for (const stream of [false, true]) {
    test(`${stream ? "streaming" : "JSON"} retains a saved Flex restriction`, async () => {
      let sent: any;
      fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return stream
          ? new Response('data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } })
          : Response.json({ choices: [{ message: { content: "Hello" }, finish_reason: "stop" }] });
      }) as typeof fetch);
      const parameters = {};
      injectConnectionMetadataFlags({ provider: "openrouter", metadata: { openrouter: {
        provider_routing: { only: ["openai/flex"], order: ["openai/flex"], allow_fallbacks: true },
      } } }, parameters);
      const request = { model: "openai/gpt-5.4", messages: [{ role: "user" as const, content: "Hello" }], parameters };
      if (stream) { for await (const _chunk of provider.generateStream("placeholder", "", request)) { /* drain */ } }
      else await provider.generate("placeholder", "", request);
      expect(sent.provider).toEqual({ only: ["openai/flex"], order: ["openai/flex"], allow_fallbacks: true });
      expect(sent._openrouter).toBeUndefined();
      expect(sent.stream).toBe(stream);
    });
  }
});
