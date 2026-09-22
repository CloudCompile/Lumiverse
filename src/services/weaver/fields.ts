export type WeaverFieldKind =
  | "short"
  | "bundle"
  | "voice"
  | "scene"
  | "voiced"
  | "alichat"
  | "greetings";

export type WeaverFieldRender = "synthesize" | "direct";

export type WeaverCharlField =
  | "name"
  | "description"
  | "personality"
  | "scenario"
  | "first_mes"
  | "mes_example"
  | "alternate_greetings";

export interface WeaverFieldDef {
  id: string;
  label: string;
  charlField: WeaverCharlField;
  order: number;
  kind: WeaverFieldKind;
  render: WeaverFieldRender;
  directSlot?: string;
  primarySlots: string[];
  /**
   * Sibling fields this field is written on top of. Their rendered content is
   * passed in as established context, and renderAllFields defers this field
   * until they exist — a field cannot be written "in the scenario's moment"
   * while the scenario is still rendering.
   */
  dependsOn?: readonly string[];
  renderGuidance: string;
  usesVoiceMaterial?: boolean;
  narrated?: boolean;
  list?: { separator: string };
}

export function getField(defs: readonly WeaverFieldDef[], id: string): WeaverFieldDef | undefined {
  return defs.find((f) => f.id === id);
}

export function isFieldId(defs: readonly WeaverFieldDef[], id: unknown): id is string {
  return typeof id === "string" && defs.some((f) => f.id === id);
}

export function rankByOrder(defs: readonly WeaverFieldDef[]): WeaverFieldDef[] {
  return [...defs].sort((a, b) => a.order - b.order);
}

/**
 * Group fields into render waves so a field is never written before the fields
 * it declares in `dependsOn`. Wave 0 is everything dependency-free; each later
 * wave depends only on earlier ones. A field whose dependencies are absent from
 * `defs` is treated as unblocked, since nothing will ever satisfy it.
 */
export function groupFieldsIntoDependencyWaves(
  defs: readonly WeaverFieldDef[],
): WeaverFieldDef[][] {
  const byId = new Map(defs.map((def) => [def.id, def]));
  const depthOf = (def: WeaverFieldDef, seen: Set<string> = new Set()): number => {
    if (seen.has(def.id)) return 0;
    seen.add(def.id);
    const deps = (def.dependsOn ?? [])
      .map((id) => byId.get(id))
      .filter((dep): dep is WeaverFieldDef => !!dep);
    return deps.length === 0 ? 0 : 1 + Math.max(...deps.map((dep) => depthOf(dep, seen)));
  };

  const waves = new Map<number, WeaverFieldDef[]>();
  for (const def of rankByOrder(defs)) {
    const depth = depthOf(def);
    const wave = waves.get(depth);
    if (wave) wave.push(def);
    else waves.set(depth, [def]);
  }
  return [...waves.keys()].sort((a, b) => a - b).map((depth) => waves.get(depth)!);
}
