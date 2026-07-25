// ─────────────────────────────────────────────────────────────────────────────
// Janitor Bridge — Proxy Service
//
// Forwards an OpenAI-format chat completion request to Janitor AI's real API
// and streams the response back transparently. This is what makes Lumiverse
// usable as an actual chat client for Janitor — the user points Janitor AI's
// UI at the bridge endpoint, the bridge extracts the card on the way through
// (via capture.service) and then proxies to Janitor's real LLM endpoint.
//
// Auth model:
//   - The incoming request from Janitor's UI carries `Authorization: Bearer
//     <bridgeKey>` — the bridge key the user generated in Lumiverse settings.
//   - We replace that header with `Authorization: Bearer <janitorApiKey>`
//     (the user's real Janitor AI API key, stored in Lumiverse's secrets
//     service) before forwarding.
//   - The user's real Janitor API key never leaves the Lumiverse process.
//
// Streaming:
//   - For SSE responses, we pipe the upstream ReadableStream directly to the
//     client. The client's AbortSignal (from Hono's c.req.raw.signal) is
//     wired through so a "Stop" click in Janitor's UI cancels the upstream
//     call too.
//   - For non-streaming JSON responses, we buffer the body so capture.service
//     can inspect the assistant message (extract image URLs, etc.) before
//     returning it to the client.
// ─────────────────────────────────────────────────────────────────────────────

import { validateHost, SSRFError } from "../../utils/safe-fetch";

/** Default Janitor AI OpenAI-compatible API base. */
export const DEFAULT_JANITOR_API_BASE = "https://api.janitorai.com/v1";

/** Hard ceiling on a single upstream LLM call. LLM streams can legitimately
 *  take minutes (long outputs, model overload, etc.) — 10 minutes matches
 *  what the generate.service pipeline effectively allows. */
const UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;

/** Headers that must NEVER be forwarded from the client request to the upstream. */
const STRIPPED_REQUEST_HEADERS = new Set([
  "authorization", "content-length", "host", "origin", "referer",
  "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor",
  "x-forwarded-for", "x-forwarded-proto", "x-real-ip",
  "x-vercel-forwarded-for", "x-vercel-ip-country", "x-vercel-ip-city",
]);

/** Headers stripped from the upstream response before sending to the client. */
const STRIPPED_RESPONSE_HEADERS = new Set([
  "set-cookie", "www-authenticate", "transfer-encoding",
  "content-encoding", "content-length",
]);

export interface ProxyRequestOptions {
  /** Real Janitor AI API key (from secrets service). */
  janitorApiKey: string;
  /** Janitor AI API base URL (no trailing slash). Default: api.janitorai.com/v1. */
  janitorApiBase?: string;
  /** The raw request body (already parsed JSON object). */
  body: any;
  /** The incoming Request's AbortSignal (so we cancel upstream when client cancels). */
  signal?: AbortSignal;
  /** Extra headers to forward. Authorization is always replaced. */
  passthroughHeaders?: Record<string, string>;
  /** Allow loopback/private IPs for the upstream URL. Default: false (SSRF protection). */
  allowPrivateUpstream?: boolean;
}

export interface ProxyResponse {
  /** HTTP status code from Janitor's API. */
  status: number;
  /** Response headers (sanitized). */
  headers: Record<string, string>;
  /** Body as a ReadableStream (for streaming responses) OR as a string (for non-streaming). */
  body: ReadableStream<Uint8Array> | string;
  /** Whether the response is streaming (SSE) or buffered JSON. */
  streaming: boolean;
}

/**
 * Validate the upstream URL is safe to call. Rejects private/loopback IPs
 * unless explicitly allowed (which is rare — only for local LLM setups).
 */
async function validateUpstreamUrl(url: string, allowPrivate: boolean): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid upstream URL: ${url}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Only http(s) upstream URLs allowed: ${parsed.protocol}`);
  }
  try {
    await validateHost(parsed.hostname, {
      allowLoopback: allowPrivate,
      allowPrivate,
    });
  } catch (err) {
    if (err instanceof SSRFError) {
      throw new Error(`Upstream host not allowed (SSRF protection): ${parsed.hostname}`);
    }
    throw err;
  }
}

/**
 * Forward an OpenAI-format chat completions request to Janitor AI's real API.
 *
 * Streaming responses are piped through as a ReadableStream. Non-streaming
 * responses are buffered and returned as a string so the caller can inspect
 * them (e.g. extract image URLs from the assistant message) before sending
 * them to the client.
 */
export async function proxyToJanitor(opts: ProxyRequestOptions): Promise<ProxyResponse> {
  const base = (opts.janitorApiBase || DEFAULT_JANITOR_API_BASE).replace(/\/+$/, "");
  const url = `${base}/chat/completions`;

  await validateUpstreamUrl(url, opts.allowPrivateUpstream ?? false);

  const isStreaming = opts.body?.stream === true;

  // Build outgoing headers. Replace Authorization with the real Janitor key.
  const outHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${opts.janitorApiKey}`,
    "Accept": isStreaming ? "text/event-stream" : "application/json",
    "User-Agent": "LumiverseJanitorBridge/1.0",
  };
  if (opts.passthroughHeaders) {
    for (const [k, v] of Object.entries(opts.passthroughHeaders)) {
      const lower = k.toLowerCase();
      if (STRIPPED_REQUEST_HEADERS.has(lower)) continue;
      outHeaders[k] = v;
    }
  }

  // Wire up abort signals: client signal + our own timeout.
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException("Upstream timeout", "TimeoutError"));
  }, UPSTREAM_TIMEOUT_MS);

  if (opts.signal) {
    if (opts.signal.aborted) {
      clearTimeout(timer);
      throw opts.signal.reason ?? new DOMException("Client aborted", "AbortError");
    }
    opts.signal.addEventListener("abort", () => {
      controller.abort(opts.signal!.reason ?? new DOMException("Client aborted", "AbortError"));
    }, { once: true });
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: outHeaders,
      body: JSON.stringify(opts.body),
      signal: controller.signal,
    });
  } catch (err: any) {
    if (err.name === "AbortError") {
      throw new Error(opts.signal?.aborted
        ? "Request cancelled by client"
        : `Upstream timeout after ${UPSTREAM_TIMEOUT_MS}ms`);
    }
    throw new Error(`Upstream fetch failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  // Sanitize response headers.
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    if (STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) return;
    if (key.toLowerCase().startsWith("x-")) return; // strip provider-specific internal headers
    responseHeaders[key] = value;
  });

  if (isStreaming && response.body) {
    // Pipe the upstream stream through. When the client aborts, our controller
    // aborts, which closes the upstream connection; the downstream stream
    // naturally errors out and the client Hono Response ends.
    return {
      status: response.status,
      headers: responseHeaders,
      body: response.body as ReadableStream<Uint8Array>,
      streaming: true,
    };
  }

  // Non-streaming — buffer the body so the caller can inspect it.
  const text = await response.text();
  return {
    status: response.status,
    headers: responseHeaders,
    body: text,
    streaming: false,
  };
}

/**
 * Try to parse a non-streaming response body as JSON. Returns null on parse failure.
 */
export function tryParseJsonBody(body: string): any | null {
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/**
 * Extract the assistant's text content from a non-streaming OpenAI chat
 * completion response. Returns "" if the shape doesn't match expectations.
 */
export function extractAssistantContent(responseJson: any): string {
  const choice = responseJson?.choices?.[0];
  if (!choice) return "";
  const message = choice.message || choice.delta;
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part: any) => part?.type === "text" && typeof part.text === "string")
      .map((part: any) => part.text)
      .join("");
  }
  return "";
}
