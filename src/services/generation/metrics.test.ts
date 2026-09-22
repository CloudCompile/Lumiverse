import { expect, test } from "bun:test";
import {
  calculateGenerationTimingMetrics,
  resolveGenerationTokenCounts,
} from "./metrics";

test("message token count prefers provider usage over local tokenization", () => {
  expect(resolveGenerationTokenCounts(128, 40)).toEqual({
    messageTokenCount: 128,
    responseTokenCount: 128,
  });
});

test("provider usage supplies token counts without local tokenization", () => {
  expect(resolveGenerationTokenCounts(128)).toEqual({
    messageTokenCount: 128,
    responseTokenCount: 128,
  });
});

test("message token count ignores invalid provider usage", () => {
  expect(resolveGenerationTokenCounts(undefined, 40)).toEqual({
    messageTokenCount: 40,
    responseTokenCount: 40,
  });
  expect(resolveGenerationTokenCounts(0, 40).messageTokenCount).toBe(40);
});

test("TPS starts at visible response content and excludes reasoning time", () => {
  const metrics = calculateGenerationTimingMetrics(
    {
      streamingStartedAt: 1_000,
      firstTokenAt: 2_000,
      firstContentTokenAt: 5_000,
      completedAt: 7_000,
      wasStreaming: true,
    },
    40,
  );

  expect(metrics).toEqual({
    durationMs: 6_000,
    wasStreaming: true,
    ttft: 1_000,
    tps: 20,
  });
});

test("reasoning-only generations do not report visible-response TPS", () => {
  const metrics = calculateGenerationTimingMetrics(
    {
      streamingStartedAt: 1_000,
      firstTokenAt: 2_000,
      completedAt: 7_000,
      wasStreaming: true,
    },
    40,
  );

  expect(metrics.ttft).toBe(1_000);
  expect(metrics.tps).toBeUndefined();
});

test("deferred metric work does not extend generation duration", () => {
  const metrics = calculateGenerationTimingMetrics(
    {
      streamingStartedAt: 1_000,
      firstTokenAt: 2_000,
      firstContentTokenAt: 3_000,
      completedAt: 5_000,
      wasStreaming: true,
    },
    10,
    50_000,
  );

  expect(metrics.durationMs).toBe(4_000);
  expect(metrics.tps).toBe(5);
});
