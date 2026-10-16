/** XcodeGen regenerates the plist from this specification on every build. */
export function configureIOSPushEntitlements(spec: string, enabled: boolean): string {
  let matches = 0;
  const result = spec.replace(/(    entitlements:\n      path: lumiverse-ios-client_iOS\/lumiverse-ios-client_iOS.entitlements\n)((?:      properties:[^\n]*\n(?:        [^\n]*\n)*)*)/,
    (_match, path: string, blocks: string) => {
      matches++;
      const properties: Record<string, unknown> = {};
      for (const block of blocks.matchAll(/      properties:[^\n]*\n(?:        [^\n]*\n)*/g)) {
        const parsed = Bun.YAML.parse(block[0].replace(/^      /gm, "")) as { properties?: Record<string, unknown> };
        Object.assign(properties, parsed.properties || {});
      }
      if (enabled) properties["aps-environment"] = "development";
      else delete properties["aps-environment"];
      return `${path}      properties: ${JSON.stringify(properties)}\n`;
    });
  if (matches !== 1) throw new Error("The iOS project is missing its expected signing entitlement configuration.");
  return result;
}
