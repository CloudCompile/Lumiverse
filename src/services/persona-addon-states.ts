import type { Persona } from "../types/persona";

export type PersonaAddonStateMap = Record<string, boolean>;

function sanitizeAddonStates(addonStates?: PersonaAddonStateMap): PersonaAddonStateMap | undefined {
  if (!addonStates || typeof addonStates !== "object") return undefined;
  const entries = Object.entries(addonStates).filter(
    ([id, enabled]) => !!id && typeof enabled === "boolean",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function applyPersonaAddonStates(
  persona: Persona | null,
  addonStates?: PersonaAddonStateMap,
): Persona | null {
  const states = sanitizeAddonStates(addonStates);
  if (!persona || !states) return persona;

  const metadata = persona.metadata || {};
  const addons = Array.isArray(metadata.addons)
    ? metadata.addons.map((addon: any) => (
        addon?.id in states ? { ...addon, enabled: states[addon.id] } : addon
      ))
    : metadata.addons;
  const attachedGlobalAddons = Array.isArray(metadata.attached_global_addons)
    ? metadata.attached_global_addons.map((ref: any) => (
        ref?.id in states ? { ...ref, enabled: states[ref.id] } : ref
      ))
    : metadata.attached_global_addons;

  return {
    ...persona,
    metadata: {
      ...metadata,
      ...(Array.isArray(metadata.addons) ? { addons } : {}),
      ...(Array.isArray(metadata.attached_global_addons) ? { attached_global_addons: attachedGlobalAddons } : {}),
    },
  };
}
