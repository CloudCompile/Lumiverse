import { describe, expect, test } from "bun:test";
import { GoogleTtsProvider } from "./google-tts";
import { GoogleVertexTtsProvider } from "./google-vertex-tts";
import { resolveEffectiveTtsApiUrl } from "../../services/tts-connections.service";
import { GOOGLE_TTS_MODELS, GOOGLE_TTS_VOICES, buildGeminiTtsBody, wrapPcmInWav } from "./google-tts-shared";

const pcmB64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const wavText = (buf: ArrayBuffer) => Buffer.from(buf.slice(44)).toString("utf8");

describe("Google TTS providers", () => {
  const studio = new GoogleTtsProvider();
  const vertex = new GoogleVertexTtsProvider();

  test("TTS-only model lists with static fallback", async () => {
    (globalThis as any).fetch = async () => new Response("nope", { status: 500 });
    for (const p of [studio, vertex]) {
      const ids = (await p.listModels("", "")).map((m) => m.id);
      expect(ids).toEqual(GOOGLE_TTS_MODELS.map((m) => m.id));
      expect(ids).toContain("gemini-3.1-flash-tts-preview");
      for (const m of GOOGLE_TTS_MODELS) expect(m.id.toLowerCase()).toContain("tts");
    }
  });

  test("live model listing keeps TTS models only", async () => {
    (globalThis as any).fetch = async () =>
      new Response(JSON.stringify({ models: [
        { name: "models/gemini-2.0-flash" },
        { name: "models/gemini-2.5-flash-preview-tts" },
        { name: "models/gemini-3.1-flash-tts-preview" },
      ] }));
    const ids = (await studio.listModels("k", "")).map((m) => m.id);
    expect(ids).toEqual(["gemini-2.5-flash-preview-tts", "gemini-3.1-flash-tts-preview"]);
  });

  test("voice mapping is non-empty, unique, and gendered", async () => {
    for (const p of [studio, vertex]) {
      const voices = await p.listVoices("", "");
      expect(voices.length).toBeGreaterThanOrEqual(30);
      expect(new Set(voices.map((v) => v.id)).size).toBe(voices.length);
      for (const v of voices) {
        expect(v.name).toBeTruthy();
        expect(["masculine", "feminine"]).toContain((v as any).gender);
      }
      expect(voices.map((v) => v.id)).toContain("Kore");
      expect(voices.map((v) => v.id)).toContain("Charon");
    }
    expect(GOOGLE_TTS_VOICES.length).toBe((await studio.listVoices("", "")).length);
  });

  test("AI Studio posts key, model route, voice config, and wraps PCM as WAV", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    (globalThis as any).fetch = async (input: any, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [
        { inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: pcmB64("hello-audio") } },
      ] } }] }));
    };
    const res = await studio.synthesize("ai-studio-key", "", {
      text: "hello", model: "gemini-2.5-flash-preview-tts", voice: "Kore", parameters: {},
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=ai-studio-key");
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.generationConfig.responseModalities).toEqual(["AUDIO"]);
    expect(body.generationConfig.speech_config.voice_config.prebuilt_voice_config.voice_name).toBe("Kore");
    expect(res.contentType).toBe("audio/wav");
    expect(Buffer.from(res.audioData.slice(0, 4)).toString()).toBe("RIFF");
    expect(wavText(res.audioData)).toBe("hello-audio");
  });

  test("AI Studio strips pasted version path suffixes", async () => {
    const calls: string[] = [];
    (globalThis as any).fetch = async (input: any) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [
        { inlineData: { mimeType: "audio/L16;rate=24000", data: pcmB64("x") } },
      ] } }] }));
    };
    await studio.synthesize("k", "https://generativelanguage.googleapis.com/v1beta/", {
      text: "hi", model: "gemini-2.5-flash-preview-tts", voice: "Puck", parameters: {},
    });
    expect(calls[0].startsWith("https://generativelanguage.googleapis.com/v1beta/models/")).toBe(true);
  });

  test("Vertex uses service account token and regional host", async () => {
    const keyPair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true, ["sign"],
    );
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
    let pemBody = "";
    const b64 = Buffer.from(pkcs8).toString("base64");
    for (let i = 0; i < b64.length; i += 64) pemBody += b64.slice(i, i + 64) + "\n";
    const sa = JSON.stringify({ type: "service_account", project_id: "demo-proj", private_key_id: "k1", private_key: `-----BEGIN PRIVATE KEY-----\n${pemBody}-----END PRIVATE KEY-----\n`, client_email: "a@b.iam.gserviceaccount.com", token_uri: "https://oauth.test/token" });
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    (globalThis as any).fetch = async (input: any, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (String(input).includes("oauth.test")) {
        return new Response(JSON.stringify({ access_token: "vertex-token", expires_in: 3600 }));
      }
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [
        { inlineData: { mimeType: "audio/L16;rate=24000", data: pcmB64("v-audio") } },
      ] } }] }));
    };
    const res = await vertex.synthesize(sa, "https://us-central1-aiplatform.googleapis.com", {
      text: "hello", model: "gemini-2.5-pro-preview-tts", voice: "Charon",
      parameters: { language_code: "en-US", temperature: 0.8 },
    });
    expect(calls[1].url).toBe("https://us-central1-aiplatform.googleapis.com/v1/projects/demo-proj/locations/us-central1/publishers/google/models/gemini-2.5-pro-preview-tts:generateContent");
    expect((calls[1].init?.headers as any).Authorization).toBe("Bearer vertex-token");
    const body = JSON.parse(String(calls[1].init?.body));
    expect(body.generationConfig.speech_config.language_code).toBe("en-US");
    expect(body.generationConfig.temperature).toBe(0.8);
    expect(wavText(res.audioData)).toBe("v-audio");
  });

  test("Vertex rejects malformed service account JSON without network access", async () => {
    let calls = 0;
    (globalThis as any).fetch = async () => { calls++; return new Response("{}"); };
    await expect(vertex.synthesize("not-json", "", {
      text: "hi", model: "gemini-2.5-flash-preview-tts", voice: "Kore", parameters: {},
    })).rejects.toThrow("Invalid service account JSON");
    expect(calls).toBe(0);
  });

  test("request body carries text and voice", () => {
    const body = buildGeminiTtsBody({ text: "say this", model: "m", voice: "Zephyr", parameters: {} });
    expect(body.contents[0].role).toBe("user");
    expect(body.contents[0].parts[0].text).toBe("say this");
    expect(body.generationConfig.speech_config.voice_config.prebuilt_voice_config.voice_name).toBe("Zephyr");
  });

  test("WAV header encodes sample rate", () => {
    const wav = new Uint8Array(wrapPcmInWav(new Uint8Array([1, 2, 3, 4]), 16000));
    expect(Buffer.from(wav.slice(0, 4)).toString()).toBe("RIFF");
    expect(new DataView(wav.buffer).getUint32(24, true)).toBe(16000);
  });

  test("resolveEffectiveTtsApiUrl handles Vertex region metadata and fallbacks", () => {
    expect(resolveEffectiveTtsApiUrl({
      provider: "google_vertex_tts",
      metadata: { vertex_region: "us-central1" },
    })).toBe("https://us-central1-aiplatform.googleapis.com");

    expect(resolveEffectiveTtsApiUrl({
      provider: "google_vertex_tts",
      metadata: { vertex_region: "global" },
    })).toBe("https://aiplatform.googleapis.com");

    expect(resolveEffectiveTtsApiUrl({
      provider: "google_vertex_tts",
      api_url: "https://custom-host.example.com",
      metadata: {},
    })).toBe("https://custom-host.example.com");

    expect(resolveEffectiveTtsApiUrl({
      provider: "google_vertex_tts",
      metadata: {},
    })).toBe("https://aiplatform.googleapis.com");

    expect(resolveEffectiveTtsApiUrl({
      provider: "openai_tts",
      api_url: "https://api.openai.com/v1",
      metadata: {},
    })).toBe("https://api.openai.com/v1");
  });
  test("Vertex streams audio chunks via streamGenerateContent SSE", async () => {
    const keyPair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true, ["sign"],
    );
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
    let pemBody = "";
    const b64 = Buffer.from(pkcs8).toString("base64");
    for (let i = 0; i < b64.length; i += 64) pemBody += b64.slice(i, i + 64) + "\n";
    const sa = JSON.stringify({
      type: "service_account", project_id: "stream-proj", private_key_id: "k1",
      private_key: `-----BEGIN PRIVATE KEY-----\n${pemBody}-----END PRIVATE KEY-----\n`,
      client_email: "s@b.iam.gserviceaccount.com", token_uri: "https://oauth.test/token",
    });
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const sseBody = [
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;rate=24000", data: pcmB64("chunk-1") } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;rate=24000", data: pcmB64("chunk-2") } }] } }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");

    (globalThis as any).fetch = async (input: any, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (String(input).includes("oauth.test")) {
        return new Response(JSON.stringify({ access_token: "stream-token", expires_in: 3600 }));
      }
      return new Response(sseBody, { headers: { "content-type": "text/event-stream" } });
    };

    const chunks: any[] = [];
    for await (const chunk of vertex.synthesizeStream(sa, "https://us-central1-aiplatform.googleapis.com", {
      text: "stream this", model: "gemini-2.5-flash-preview-tts", voice: "Kore", parameters: {},
    })) {
      chunks.push(chunk);
    }

    expect(calls[1].url).toBe("https://us-central1-aiplatform.googleapis.com/v1/projects/stream-proj/locations/us-central1/publishers/google/models/gemini-2.5-flash-preview-tts:streamGenerateContent?alt=sse");
    expect((calls[1].init?.headers as any).Authorization).toBe("Bearer stream-token");
    expect(chunks.length).toBe(3);
    expect(chunks[0].done).toBe(false);
    expect(chunks[0].kind).toBe("audio_file");
    expect(chunks[0].mimeType).toBe("audio/wav");
    expect(wavText(chunks[0].data.buffer)).toBe("chunk-1");
    expect(wavText(chunks[1].data.buffer)).toBe("chunk-2");
    expect(chunks[2].done).toBe(true);
  });

  test("AI Studio streams audio chunks via streamGenerateContent SSE", async () => {
    const sseBody = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;rate=24000", data: pcmB64("studio-stream") } }] } }] })}\n\n`;
    const calls: string[] = [];
    (globalThis as any).fetch = async (input: any) => {
      calls.push(String(input));
      return new Response(sseBody, { headers: { "content-type": "text/event-stream" } });
    };

    const chunks: any[] = [];
    for await (const chunk of studio.synthesizeStream("my-api-key", "", {
      text: "hello", model: "gemini-3.1-flash-tts-preview", voice: "Puck", parameters: {},
    })) {
      chunks.push(chunk);
    }

    expect(calls[0]).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:streamGenerateContent?alt=sse&key=my-api-key");
    expect(chunks.length).toBe(2);
    expect(chunks[0].done).toBe(false);
    expect(wavText(chunks[0].data.buffer)).toBe("studio-stream");
    expect(chunks[1].done).toBe(true);
  });
});
