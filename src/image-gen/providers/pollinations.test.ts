import { afterEach, describe, expect, test } from "bun:test";
import { PollinationsImageProvider } from "./pollinations";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("PollinationsImageProvider", () => {
  test("normalizes a pasted Bearer key and accepts base64 backend responses", async () => {
    let authorization = "";
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get("authorization") || "";
      return new Response(JSON.stringify({ data: [{ base64: "aGVsbG8=" }] }), { status: 200 });
    }) as typeof fetch;

    const provider = new PollinationsImageProvider();
    const result = await provider.generate("Bearer pk_example", "https://gen.pollinations.ai/v1/", {
      prompt: "test",
      model: "zimage",
      parameters: {},
    });

    expect(authorization).toBe("Bearer pk_example");
    expect(result.imageDataUrl).toBe("data:image/png;base64,aGVsbG8=");
  });

  test("uses the current OpenAI-style model endpoint before the legacy fallback", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (url: string | URL | Request) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify({ data: [{ id: "zimage", name: "Z-Image" }] }), { status: 200 });
    }) as typeof fetch;

    const models = await new PollinationsImageProvider().listModels("pk_example", "https://gen.pollinations.ai/v1");

    expect(requestedUrl).toBe("https://gen.pollinations.ai/v1/models");
    expect(models).toEqual([{ id: "zimage", label: "Z-Image" }]);
  });

  test("uses the image edits endpoint when a source image is supplied", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (url: string | URL | Request) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify({ data: [{ b64_json: "aGVsbG8=" }] }), { status: 200 });
    }) as typeof fetch;

    await new PollinationsImageProvider().generate("pk_example", "https://gen.pollinations.ai/v1", {
      prompt: "turn this into a watercolor portrait",
      model: "kontext",
      parameters: { resolvedSourceImages: [{ data: "aGVsbG8=", mimeType: "image/png" }] },
    });

    expect(requestedUrl).toBe("https://gen.pollinations.ai/v1/images/edits");
  });
});
