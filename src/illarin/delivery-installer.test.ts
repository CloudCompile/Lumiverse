import { describe, expect, test } from "bun:test";
import {
  characterInstallPayload,
  persistIllarinPresetCover,
  type PresetCoverDependencies,
} from "./delivery-installer";
import type { IllarinDelivery } from "./types";

function presetDelivery(artifacts: IllarinDelivery["artifacts"]): IllarinDelivery {
  return {
    id: "delivery-1",
    assetId: "asset-1",
    contentGeneration: 2,
    kind: "preset",
    name: "Night Shift",
    format: "preset_lumiverse",
    label: "Lumiverse preset",
    queuedAt: "2026-08-24T20:00:00Z",
    leaseExpiresAt: "2026-08-24T20:15:00Z",
    artifacts,
  };
}

describe("Illarin delivery installer", () => {
  test("does not import pictures twice when CharX already contains them", () => {
    const delivery: IllarinDelivery = {
      id: "delivery-1",
      assetId: "asset-1",
      contentGeneration: 2,
      kind: "character",
      name: "Aster",
      format: "charx",
      label: "Character Card Exchange",
      queuedAt: "2026-08-24T20:00:00Z",
      leaseExpiresAt: "2026-08-24T20:15:00Z",
      artifacts: [
        { kind: "export", url: "https://illarin.com/export" },
        { kind: "picture", url: "https://illarin.com/avatar", role: "avatar", isCover: true },
        { kind: "picture", url: "https://illarin.com/expression", role: "expression", isCover: false },
      ],
    };

    expect(characterInstallPayload(delivery).galleryImageUrls).toBeUndefined();
  });

  test("durably stores the designated preset cover and returns its local URL", async () => {
    const fetched: string[] = [];
    const uploaded: File[] = [];
    const dependencies: PresetCoverDependencies = {
      fetchArtifact: async (url) => {
        fetched.push(url);
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "Content-Type": "image/webp; charset=binary" },
        });
      },
      uploadImage: async (_userId, file) => {
        uploaded.push(file);
        return { url: "/api/v1/images/local-cover-id" };
      },
    };
    const delivery = presetDelivery([
      { kind: "export", url: "https://illarin.com/export" },
      { kind: "picture", url: "https://illarin.com/gallery", isCover: false },
      { kind: "picture", url: "https://illarin.com/cover", isCover: true },
    ]);

    const url = await persistIllarinPresetCover("user-1", delivery, dependencies);

    expect(url).toBe("/api/v1/images/local-cover-id");
    expect(fetched).toEqual(["https://illarin.com/cover"]);
    expect(uploaded[0]?.name).toBe("illarin-preset-cover.webp");
    expect(uploaded[0]?.type).toBe("image/webp");
    expect(uploaded[0]?.size).toBe(3);
  });

  test("does not mistake an ordinary preset picture for its cover", async () => {
    let fetched = false;
    const dependencies: PresetCoverDependencies = {
      fetchArtifact: async () => {
        fetched = true;
        return new Response();
      },
      uploadImage: async () => ({ url: "/unused" }),
    };

    const url = await persistIllarinPresetCover("user-1", presetDelivery([
      { kind: "picture", url: "https://illarin.com/gallery", isCover: false },
    ]), dependencies);

    expect(url).toBeNull();
    expect(fetched).toBe(false);
  });
});
