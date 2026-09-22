export interface GenerationTimingSource {
  streamingStartedAt?: number;
  firstTokenAt?: number;
  firstContentTokenAt?: number;
  completedAt?: number;
  wasStreaming?: boolean;
}

export interface GenerationTimingMetrics {
  durationMs: number;
  wasStreaming: boolean;
  ttft?: number;
  tps?: number;
}

export interface GenerationTokenCounts {
  /** Authoritative generated-token count for message metadata. */
  messageTokenCount?: number;
  /** Generated-token count used for response throughput. */
  responseTokenCount?: number;
}

/**
 * Prefer the provider's final completion usage. Locally calculated message
 * tokens are a fallback for providers that do not return usable metadata.
 */
export function resolveGenerationTokenCounts(
  providerCompletionTokenCount: unknown,
  calculatedResponseTokenCount?: number,
): GenerationTokenCounts {
  const normalizedProviderCount =
    typeof providerCompletionTokenCount === "number" &&
    Number.isFinite(providerCompletionTokenCount) &&
    providerCompletionTokenCount > 0
      ? Math.floor(providerCompletionTokenCount)
      : undefined;

  const resolvedCount = normalizedProviderCount ?? calculatedResponseTokenCount;
  return {
    messageTokenCount: resolvedCount,
    responseTokenCount: resolvedCount,
  };
}

/**
 * Calculate response timings. TTFT retains its historical meaning (the first
 * provider token, including reasoning), while TPS starts at the first
 * response-content token and uses the resolved provider-or-local token count.
 */
export function calculateGenerationTimingMetrics(
  source: GenerationTimingSource,
  responseTokenCount?: number,
  observedAt = Date.now(),
): GenerationTimingMetrics {
  const wasStreaming = source.wasStreaming ?? true;
  const streamStart = source.streamingStartedAt;
  const responseEndedAt = source.completedAt ?? observedAt;
  const durationMs = streamStart
    ? Math.max(0, responseEndedAt - streamStart)
    : 0;

  let ttft: number | undefined;
  let tps: number | undefined;

  if (wasStreaming && streamStart) {
    if (source.firstTokenAt) {
      ttft = Math.max(0, source.firstTokenAt - streamStart);
    }

    if (source.firstContentTokenAt && responseTokenCount && responseTokenCount > 1) {
      const responseDurationSec =
        (responseEndedAt - source.firstContentTokenAt) / 1000;
      if (responseDurationSec > 0) {
        tps = Math.round((responseTokenCount / responseDurationSec) * 10) / 10;
      }
    }
  }

  return {
    durationMs,
    wasStreaming,
    ...(ttft != null ? { ttft } : {}),
    ...(tps != null ? { tps } : {}),
  };
}
