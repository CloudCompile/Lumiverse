import { expect, test } from "bun:test";
import { configureIOSPushEntitlements } from "./ios-entitlements";

test("push signing survives project regeneration and can be removed for Personal Teams", () => {
  let spec = `targets:
  app:
    entitlements:
      path: lumiverse-ios-client_iOS/lumiverse-ios-client_iOS.entitlements
    settings:
      base:
        PRODUCT_NAME: Lumiverse
`;
  for (const enabled of [true, true, false, false, true, false]) {
    spec = configureIOSPushEntitlements(spec, enabled);
    const parsed = Bun.YAML.parse(spec) as { targets: { app: { entitlements: { properties: Record<string, unknown> } } } };
    expect(parsed.targets.app.entitlements.properties).toEqual(enabled ? { "aps-environment": "development" } : {});
    expect(spec.match(/      properties:/g)).toHaveLength(1);
    expect(spec).toContain("PRODUCT_NAME: Lumiverse");
  }
});

test("toggling push preserves other signing capabilities", () => {
  const spec = `    entitlements:
      path: lumiverse-ios-client_iOS/lumiverse-ios-client_iOS.entitlements
      properties:
        keychain-access-groups: [other.group]
        aps-environment: development
    settings: {}
`;
  const parsed = Bun.YAML.parse(configureIOSPushEntitlements(spec, false)) as { entitlements: { properties: Record<string, unknown> } };
  expect(parsed.entitlements.properties).toEqual({ "keychain-access-groups": ["other.group"] });
});
