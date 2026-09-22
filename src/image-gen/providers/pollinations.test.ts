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

  test("filters video-only models out of the image model list", async () => {
    globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          data: [
            { id: "tongyi-mai/z-image-turbo", title: "Z-Image Turbo", output_modalities: ["image"] },
            { id: "google/veo-3.1-fast", title: "Veo 3.1 Fast", output_modalities: ["video"] },
            { id: "bytedance/seedance-2.0", title: "Seedance 2.0", output_modalities: ["video", "audio"] },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;

    const models = await new PollinationsImageProvider().listModels("pk_example", "https://gen.pollinations.ai/v1");

    expect(models).toEqual([{ id: "tongyi-mai/z-image-turbo", label: "Z-Image Turbo" }]);
  });

  test("sends only documented request fields and a spec-valid quality value", async () => {
    let body: any = null;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.body) body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ data: [{ b64_json: "aGVsbG8=" }] }), { status: 200 });
    }) as typeof fetch;

    await new PollinationsImageProvider().generate("pk_example", "https://gen.pollinations.ai/v1", {
      prompt: "test",
      model: "tongyi-mai/z-image-turbo",
      parameters: { quality: "hd", seed: 7, enhance: true, negative_prompt: "blurry", transparent: true },
    });

    expect(body.quality).toBe("hd");
    expect(body.seed).toBe(7);
    // Unsupported fields the API would reject must not be forwarded.
    expect(body.enhance).toBeUndefined();
    expect(body.negative_prompt).toBeUndefined();
    expect(body.transparent).toBeUndefined();
    expect(body.model).toBe("tongyi-mai/z-image-turbo");
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
