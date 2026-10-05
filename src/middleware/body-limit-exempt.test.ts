import { describe, expect, test } from "bun:test";
import { isLargeUploadBodyLimitExemptPath } from "./body-limit-exempt";

describe("isLargeUploadBodyLimitExemptPath", () => {
  test("allows the wallpaper upload endpoint through the global 10MB guard", () => {
    expect(isLargeUploadBodyLimitExemptPath("/api/v1/images/wallpapers")).toBe(true);
  });

  test("allows chat audio uploads through the global 10MB guard", () => {
    expect(isLargeUploadBodyLimitExemptPath("/api/v1/audio")).toBe(true);
  });

  test("allows saved theme packs with embedded assets through the global 10MB guard", () => {
    expect(isLargeUploadBodyLimitExemptPath("/api/v1/settings/saved-themes")).toBe(true);
  });

  test("still rejects unrelated image routes", () => {
    expect(isLargeUploadBodyLimitExemptPath("/api/v1/images/rebuild-thumbnails")).toBe(false);
  });

  test("allows Qwen custom voice uploads through the global 10MB guard", () => {
    expect(isLargeUploadBodyLimitExemptPath("/api/v1/tts-connections/abc/qwen/custom-voices")).toBe(true);
  });

  test("allows character-card replacements through the global 10MB guard", () => {
    expect(isLargeUploadBodyLimitExemptPath("/api/v1/characters/character-1/replace-card")).toBe(true);
  });

  test("allows only raw character-job file uploads through the global 10MB guard", () => {
    expect(isLargeUploadBodyLimitExemptPath("/api/v1/characters/import-jobs/job-1/files/12")).toBe(true);
    expect(isLargeUploadBodyLimitExemptPath("/api/v1/characters/import-jobs/job-1/start")).toBe(false);
    expect(isLargeUploadBodyLimitExemptPath("/api/v1/characters/import-jobs")).toBe(false);
  });

  test("allows SillyTavern ZIP backups through the global 10MB guard", () => {
    expect(isLargeUploadBodyLimitExemptPath("/api/v1/st-migration/backup")).toBe(true);
  });

  test("allows full preset writes through the global 10MB guard", () => {
    expect(isLargeUploadBodyLimitExemptPath("/api/v1/presets", "POST")).toBe(true);
    expect(isLargeUploadBodyLimitExemptPath("/api/v1/presets/preset-1", "PUT")).toBe(true);
    expect(isLargeUploadBodyLimitExemptPath("/api/v1/presets", "GET")).toBe(false);
    expect(isLargeUploadBodyLimitExemptPath("/api/v1/presets/preset-1", "POST")).toBe(false);
    expect(isLargeUploadBodyLimitExemptPath("/api/v1/presets/stash", "POST")).toBe(false);
    expect(isLargeUploadBodyLimitExemptPath("/api/v1/presets/stash", "PUT")).toBe(true);
  });
});
