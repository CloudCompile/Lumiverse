import type { TtsRequest, TtsStreamChunk } from "../types";

/** Gemini text-to-speech models. TTS-only list: no text/generation models. */
export const GOOGLE_TTS_MODELS = [
  { id: "gemini-3.1-flash-tts-preview", label: "Gemini 3.1 Flash TTS (latest)" },
  { id: "gemini-2.5-pro-preview-tts", label: "Gemini 2.5 Pro TTS (high quality)" },
  { id: "gemini-2.5-flash-preview-tts", label: "Gemini 2.5 Flash TTS (fast)" },
];

/** Keep a model ID only when it names a speech/TTS model. */
export function isTtsModelId(id: string): boolean {
  return /(?:^|[-_./: ])(tts|speech)(?:$|[-_./: ])/i.test(id);
}

/**
 * Prebuilt Gemini voices, mapped to readable names with documented gender.
 * IDs are the API voice names; `language` marks the documented voice locale.
 */
export const GOOGLE_TTS_VOICES = [
  { id: "Achird", name: "Achird", language: "en-US", gender: "masculine" },
  { id: "Achernar", name: "Achernar", language: "en-US", gender: "feminine" },
  { id: "Algenib", name: "Algenib", language: "en-US", gender: "masculine" },
  { id: "Algieba", name: "Algieba", language: "en-US", gender: "feminine" },
  { id: "Alnilam", name: "Alnilam", language: "en-US", gender: "masculine" },
  { id: "Aoede", name: "Aoede", language: "en-US", gender: "feminine" },
  { id: "Autonoe", name: "Autonoe", language: "en-US", gender: "feminine" },
  { id: "Callirrhoe", name: "Callirrhoe", language: "en-US", gender: "feminine" },
  { id: "Charon", name: "Charon", language: "en-US", gender: "masculine" },
  { id: "Despina", name: "Despina", language: "en-US", gender: "feminine" },
  { id: "Enceladus", name: "Enceladus", language: "en-US", gender: "masculine" },
  { id: "Erinome", name: "Erinome", language: "en-US", gender: "feminine" },
  { id: "Fenrir", name: "Fenrir", language: "en-US", gender: "masculine" },
  { id: "Gacrux", name: "Gacrux", language: "en-US", gender: "feminine" },
  { id: "Iapetus", name: "Iapetus", language: "en-US", gender: "masculine" },
  { id: "Kore", name: "Kore", language: "en-US", gender: "feminine" },
  { id: "Laomedeia", name: "Laomedeia", language: "en-US", gender: "feminine" },
  { id: "Leda", name: "Leda", language: "en-US", gender: "feminine" },
  { id: "Orus", name: "Orus", language: "en-US", gender: "masculine" },
  { id: "Pulcherrima", name: "Pulcherrima", language: "en-US", gender: "feminine" },
  { id: "Puck", name: "Puck", language: "en-US", gender: "masculine" },
  { id: "Rasalgethi", name: "Rasalgethi", language: "en-US", gender: "masculine" },
  { id: "Sadachbia", name: "Sadachbia", language: "en-US", gender: "masculine" },
  { id: "Sadaltager", name: "Sadaltager", language: "en-US", gender: "masculine" },
  { id: "Schedar", name: "Schedar", language: "en-US", gender: "masculine" },
  { id: "Sulafat", name: "Sulafat", language: "en-US", gender: "feminine" },
  { id: "Umbriel", name: "Umbriel", language: "en-US", gender: "masculine" },
  { id: "Vindemiatrix", name: "Vindemiatrix", language: "en-US", gender: "feminine" },
  { id: "Zephyr", name: "Zephyr", language: "en-US", gender: "feminine" },
  { id: "Zubenelgenubi", name: "Zubenelgenubi", language: "en-US", gender: "masculine" },
];

export const GOOGLE_TTS_PARAMETERS = {
  language_code: {
    type: "string" as const,
    description: "BCP-47 language code for synthesis (e.g. en-US). Leave blank for the default.",
    group: "advanced",
  },
  temperature: {
    type: "number" as const,
    default: 1,
    min: 0,
    max: 2,
    step: 0.05,
    description: "Voice variation — higher values add expressiveness, lower values are more deterministic",
    group: "advanced",
  },
};

/** Single-speaker generateContent body requesting AUDIO output. */
export function buildGeminiTtsBody(request: TtsRequest): Record<string, any> {
  const speechConfig: Record<string, any> = {
    voice_config: {
      prebuilt_voice_config: { voice_name: request.voice },
    },
  };
  if (typeof request.parameters.language_code === "string" && request.parameters.language_code.trim()) {
    speechConfig.language_code = request.parameters.language_code.trim();
  }
  const generationConfig: Record<string, any> = {
    responseModalities: ["AUDIO"],
    speech_config: speechConfig,
  };
  if (typeof request.parameters.temperature === "number") {
    generationConfig.temperature = request.parameters.temperature;
  }
  return {
    contents: [{ role: "user", parts: [{ text: request.text }] }],
    generationConfig,
  };
}

function parsePcmRate(mimeType: string | undefined): number {
  const match = /rate=(\d+)/i.exec(mimeType || "");
  const rate = match ? Number.parseInt(match[1], 10) : 24000;
  return Number.isFinite(rate) && rate > 0 ? rate : 24000;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Wrap raw 16-bit mono PCM in a WAV container so browsers can play it. */
export function wrapPcmInWav(pcm: Uint8Array, sampleRate: number): ArrayBuffer {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, pcm.length, true);
  const out = new Uint8Array(44 + pcm.length);
  out.set(new Uint8Array(header), 0);
  out.set(pcm, 44);
  return out.buffer;
}

/** Extract the first inline audio payload from a generateContent response. */
export function extractGeminiTtsAudio(data: any): { audioData: ArrayBuffer; contentType: string } {
  const parts: any[] = data?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    const inline = part?.inlineData || part?.inline_data;
    if (inline?.data) {
      const mimeType: string | undefined = inline.mimeType || inline.mime_type;
      const audioData = wrapPcmInWav(base64ToBytes(inline.data), parsePcmRate(mimeType));
      return { audioData, contentType: "audio/wav" };
    }
  }
  throw new Error("No audio payload in Gemini TTS response");
}

/** Extract inline audio payloads from a candidate part. */
export function* extractGeminiTtsAudioChunks(data: any): Generator<TtsStreamChunk, void, unknown> {
  const parts: any[] = data?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    const inline = part?.inlineData || part?.inline_data;
    if (inline?.data) {
      const mimeType: string | undefined = inline.mimeType || inline.mime_type;
      const audioData = wrapPcmInWav(base64ToBytes(inline.data), parsePcmRate(mimeType));
      yield {
        data: new Uint8Array(audioData),
        done: false,
        kind: "audio_file",
        mimeType: "audio/wav",
      };
    }
  }
}

/** Consume an SSE response from Gemini streamGenerateContent and yield audio WAV chunks. */
export async function* streamGeminiTtsAudio(
  res: Response,
  signal?: AbortSignal,
): AsyncGenerator<TtsStreamChunk, void, unknown> {
  if (!res.body) {
    throw new Error("No response body for streaming");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let emittedAny = false;

  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true }).replace(/\r/g, "");
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const payload = trimmed.slice(6).trim();
        if (payload === "[DONE]") continue;

        try {
          const data = JSON.parse(payload);
          for (const chunk of extractGeminiTtsAudioChunks(data)) {
            emittedAny = true;
            yield chunk;
          }
        } catch {
          // Ignore unparseable line
        }
      }
    }

    buffer += decoder.decode().replace(/\r/g, "");
    if (buffer.trim().startsWith("data: ")) {
      const payload = buffer.trim().slice(6).trim();
      if (payload && payload !== "[DONE]") {
        try {
          const data = JSON.parse(payload);
          for (const chunk of extractGeminiTtsAudioChunks(data)) {
            emittedAny = true;
            yield chunk;
          }
        } catch {}
      }
    }

    if (!emittedAny) {
      throw new Error("No audio payload in Gemini TTS stream");
    }

    yield {
      data: new Uint8Array(0),
      done: true,
      kind: "audio_file",
      mimeType: "audio/wav",
    };
  } finally {
    reader.cancel().catch(() => {});
  }
}
