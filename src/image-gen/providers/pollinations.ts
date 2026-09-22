import type { ImageProvider } from "../provider";
import type { ImageProviderCapabilities } from "../param-schema";
import type { ImageGenRequest, ImageGenResponse } from "../types";
import { applyRawOverride } from "../types";
import { fetchProviderJson, ProviderRequestError, throwProviderResponseError } from "../../utils/provider-errors";

export class PollinationsImageProvider implements ImageProvider {
  readonly name = "pollinations";
  readonly displayName = "Pollinations";

  readonly capabilities: ImageProviderCapabilities = {
    parameters: {
      width: {
        type: "integer",
        min: 256,
        max: 2048,
        default: 1024,
        step: 2,
        description: "Image width in pixels",
      },
      height: {
        type: "integer",
        min: 256,
        max: 2048,
        default: 1024,
        step: 2,
        description: "Image height in pixels",
      },
      seed: {
        type: "integer",
        description: "Random seed for reproducible images",
        group: "advanced",
      },
      quality: {
        type: "select",
        default: "medium",
        description: "Generation quality tier",
        group: "advanced",
        options: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
          { id: "hd", label: "HD" },
        ],
      },
      rawRequestOverride: {
        type: "string",
        description: "Raw JSON merged into the request body",
        group: "advanced",
      },
    },
    apiKeyRequired: true,
    modelListStyle: "dynamic",
    // Canonical `publisher/model` IDs. Older short aliases (e.g. `zimage`)
    // still resolve server-side, but new selections should use the canonical ID.
    staticModels: [
      { id: "tongyi-mai/z-image-turbo", label: "Z-Image Turbo" },
      { id: "black-forest-labs/flux.1-schnell", label: "Flux.1 Schnell" },
      { id: "black-forest-labs/flux.2-pro", label: "Flux.2 Pro" },
      { id: "black-forest-labs/flux.1-kontext-pro", label: "Flux.1 Kontext Pro" },
      { id: "openai/gpt-image-1-mini", label: "GPT Image 1 Mini" },
      { id: "google/gemini-2.5-flash-image", label: "Gemini 2.5 Flash Image" },
      { id: "bytedance/seedream-4.0", label: "Seedream 4.0" },
      { id: "qwen/qwen-image", label: "Qwen Image" },
      { id: "amazon/nova-canvas-v1", label: "Nova Canvas" },
    ],
    defaultUrl: "https://gen.pollinations.ai/v1",
  };

  async generate(apiKey: string, apiUrl: string, request: ImageGenRequest): Promise<ImageGenResponse> {
    const base = this.baseUrl(apiUrl);
    const width = Number(request.parameters.width || 1024);
    const height = Number(request.parameters.height || 1024);

    const body: Record<string, any> = {
      prompt: request.prompt,
      model: request.model || "tongyi-mai/z-image-turbo",
      n: 1,
      size: `${width}x${height}`,
      response_format: "b64_json",
    };

    if (request.parameters.seed != null && Number.isFinite(Number(request.parameters.seed))) {
      body.seed = Number(request.parameters.seed);
    }
    // `enhance`, `negative_prompt`, and `transparent` are not part of the
    // OpenAI-shaped request schema (negative_prompt is audio-only), so they are
    // not forwarded; use rawRequestOverride for provider extensions.
    if (request.parameters.quality) body.quality = String(request.parameters.quality);

    const finalBody = applyRawOverride(body, request.parameters.rawRequestOverride);

    const sources: Array<{ data: string; mimeType?: string }> =
      request.parameters.resolvedSourceImages || request.parameters.referenceImages || [];
    const usableSources = sources.filter((source) => !!source?.data);
    const res = usableSources.length > 0
      ? await this.requestEdit(base, apiKey, finalBody, usableSources, request.signal)
      : await fetch(`${base}/images/generations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Connections sometimes contain a key pasted with its Bearer prefix.
        // Sending that prefix twice causes an opaque 401 from Pollinations.
        Authorization: `Bearer ${apiKey.trim().replace(/^Bearer\s+/i, "")}`,
      },
      body: JSON.stringify(finalBody),
      signal: request.signal,
    });

    if (!res.ok) await throwProviderResponseError(this.displayName, "image generate", res);

    const data = (await res.json()) as any;
    const item = data?.data?.[0];
    // Pollinations has returned both OpenAI's b64_json field and base64 from
    // different image backends. Supporting both keeps the connection working
    // when the selected model is routed to a different backend.
    const b64 = item?.b64_json || item?.base64;
    const imageUrl = item?.url;

    if (b64) {
      return {
        imageDataUrl: `data:image/png;base64,${b64}`,
        model: body.model,
        provider: this.name,
      };
    }

    if (imageUrl) {
      const imageRes = await fetch(imageUrl, { signal: request.signal });
      if (!imageRes.ok) {
        throw new Error(`Pollinations image fetch failed ${imageRes.status}`);
      }
      const contentType = imageRes.headers.get("content-type") || "image/png";
      const bytes = new Uint8Array(await imageRes.arrayBuffer());
      const base64 = Buffer.from(bytes).toString("base64");
      return {
        imageDataUrl: `data:${contentType};base64,${base64}`,
        model: body.model,
        provider: this.name,
      };
    }

    throw new Error("Pollinations returned no image data");
  }

  /** Pollinations supports the OpenAI-compatible image edit surface. */
  private async requestEdit(
    base: string,
    apiKey: string,
    body: Record<string, any>,
    sources: Array<{ data: string; mimeType?: string }>,
    signal?: AbortSignal,
  ): Promise<Response> {
    const form = new FormData();
    for (const [key, value] of Object.entries(body)) {
      if (key === "response_format" || value == null) continue;
      form.append(key, String(value));
    }
    for (const [index, source] of sources.entries()) {
      const match = source.data.match(/^data:([^;,]+)?;base64,(.*)$/s);
      const mimeType = source.mimeType || match?.[1] || "image/png";
      const base64 = match ? match[2] : source.data;
      const ext = mimeType.split("/")[1] || "png";
      form.append(sources.length > 1 ? "image[]" : "image", new Blob([Buffer.from(base64, "base64")], { type: mimeType }), `source-${index}.${ext}`);
    }
    return fetch(`${base}/images/edits`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey.trim().replace(/^Bearer\s+/i, "")}` },
      body: form,
      signal,
    });
  }

  async validateKey(apiKey: string, apiUrl: string): Promise<boolean> {
    if (!apiKey) return false;
    try {
      const base = this.baseUrl(apiUrl).replace(/\/v1\/?$/, "");
      const res = await fetch(`${base}/account/key`, {
        headers: { Authorization: `Bearer ${apiKey.trim().replace(/^Bearer\s+/i, "")}` },
      });
      if (!res.ok) await throwProviderResponseError(this.displayName, "authentication", res);
      return res.ok;
    } catch (err) {
      if (err instanceof ProviderRequestError) throw err;
      throw new ProviderRequestError({ provider: this.displayName, operation: "authentication", detail: err instanceof Error ? err.message : "network request failed", retryable: true });
    }
  }

  async listModels(apiKey: string, apiUrl: string): Promise<Array<{ id: string; label: string }>> {
    const base = this.baseUrl(apiUrl);
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey.trim().replace(/^Bearer\s+/i, "")}`;

    // The current API exposes OpenAI-style models at /v1/models. Older
    // deployments used /image/models at the host root, so retain it as a
    // compatibility fallback instead of making model selection unavailable.
    let data: any;
    try {
      data = await fetchProviderJson<any>(this.displayName, "model listing", `${base}/models`, { headers });
    } catch {
      try {
        data = await fetchProviderJson<any>(this.displayName, "model listing", `${base.replace(/\/v1\/?$/, "")}/image/models`, { headers });
      } catch {
        return this.capabilities.staticModels || [];
      }
    }
    const list = Array.isArray(data)
      ? data
      : Array.isArray(data?.models)
        ? data.models
        : Array.isArray(data?.data)
          ? data.data
          : [];

    // `/image/models` also returns video models. Keep only entries that output
    // an image so the image picker never offers a video-only model.
    const modelList = list.filter((m: any) => {
      const outputs = m?.output_modalities;
      if (!Array.isArray(outputs) || outputs.length === 0) return true;
      return outputs.includes("image");
    });

    const models = modelList
      .map((m: any) => ({
        id: String(m?.id || m?.model || m?.name || "").trim(),
        label: String(m?.title || m?.name || m?.label || m?.id || m?.model || "").trim(),
      }))
      .filter((m: { id: string; label: string }) => !!m.id)
      .map((m: { id: string; label: string }) => ({ id: m.id, label: m.label || m.id }));

    return models.length > 0 ? models : this.capabilities.staticModels || [];
  }

  private baseUrl(apiUrl: string): string {
    let url = (apiUrl || this.capabilities.defaultUrl).replace(/\/+$/, "");
    url = url.replace(/\/images\/generations$/, "");
    url = url.replace(/\/image\/models$/, "");
    if (!url.endsWith("/v1")) {
      url = url.replace(/\/v1\/?$/, "");
      url += "/v1";
    }
    return url;
  }
}
