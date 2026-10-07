import type { Clip, TextClip } from "./model";
import { EFFECTS } from "./presets";

/** Reordering never mutates the project array or a neighbouring effect. */
export function moveEffect(effects: Clip["effects"], index: number, direction: -1 | 1): Clip["effects"] {
  const target = index + direction;
  if (index < 0 || index >= effects.length || target < 0 || target >= effects.length) return effects;
  const result = [...effects];
  [result[index], result[target]] = [result[target], result[index]];
  return result;
}

/** Removing an effect must remove its automation too, including after re-adding it. */
export function pruneEffectKeyframes<T extends Clip | TextClip>(item: T, effects: Clip["effects"]): T {
  const active = new Set(effects.map((effect) => `effect:${effect.name}`));
  return {
    ...item,
    propertyKeyframes: Object.fromEntries(Object.entries(item.propertyKeyframes ?? {})
      .filter(([property]) => !property.startsWith("effect:") || active.has(property))),
  };
}

export function resetEffect<T extends Clip | TextClip>(item: T, name: Clip["effects"][number]["name"]): T {
  const definition = EFFECTS.find((effect) => effect.name === name);
  const propertyKeyframes = { ...item.propertyKeyframes };
  delete propertyKeyframes[`effect:${name}`];
  return {
    ...item,
    effects: item.effects.map((effect) => effect.name === name
      ? { ...effect, amount: definition?.defaultAmount ?? 50, ...(name === "Wavy" ? { waves: 4 } : {}) } : effect),
    propertyKeyframes,
  };
}
