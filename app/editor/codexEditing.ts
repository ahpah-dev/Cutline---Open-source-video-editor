import { normalizeCrop } from "./crop";
import { CURVE_CHANNELS, GRADE_RANGES, normalizeGrade } from "./colorGrading";
import { BLEND_MODES, MASK_SHAPES, normalizeCompositing } from "./visualCompositing";
import {
  clipDuration, COMBO_ANIMATIONS, endOf, freezeFrame, makeClip, makeText, normalizeGradientStops,
  projectDuration, roundFrame, setJoinTransition, setPropertyKeyframe, splitItem, transitionSource,
  uid, type Clip, type Project, type TextClip,
} from "./model";
import { ANIMATIONS, EFFECTS, FILTERS, FONTS, TEXT_PRESETS, TRANSITIONS } from "./presets";
import { pruneEffectKeyframes } from "./effectStack";
import { defaultAnimationSettings } from "./textAnimation";

type Schema = {
  type?: string; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean;
  items?: Schema; enum?: readonly unknown[]; const?: unknown; oneOf?: Schema[];
  minimum?: number; maximum?: number; minItems?: number; maxItems?: number; maxLength?: number; pattern?: string;
  description?: string;
};
const string = (description = "", maxLength = 1000): Schema => ({ type: "string", description, maxLength });
const number = (minimum: number, maximum: number, description = ""): Schema => ({ type: "number", minimum, maximum, description });
const integer = (minimum: number, maximum: number, description = ""): Schema => ({ ...number(minimum, maximum, description), type: "integer" });
const choices = (values: readonly unknown[], description = ""): Schema => ({ type: "string", enum: values, description });
const object = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: "object", properties, required, additionalProperties: false });
const array = (items: Schema, maxItems = 100): Schema => ({ type: "array", items, maxItems });
const boolean: Schema = { type: "boolean" };
const color: Schema = { type: "string", pattern: "^#[0-9a-fA-F]{6}$", description: "Six-digit hex color." };
const seconds = number(0, 36000, "Timeline seconds, rounded to project frames.");
const track = integer(0, 63, "Universal layer index; larger indices appear in front.");
const id = string("Exact item ID from get_project, or @ref for an item created earlier in this batch.");
const animationNames = ANIMATIONS.filter((name) => name !== "None");
const sharedFields: Record<string, Schema> = {
  label: string(), start: seconds, track,
  snapToGuides: boolean,
  rotation: number(-3600, 3600, "Degrees."),
  opacity: number(0, 1), animationDuration: seconds, exitAnimationDuration: seconds,
  maskShape: choices(MASK_SHAPES), maskSpace: choices(["content", "canvas"]),
  maskX: number(-2, 3, "Fraction of the chosen reference width; 0.5 centers the mask."),
  maskY: number(-2, 3, "Fraction of the chosen reference height; 0.5 centers the mask."),
  maskWidth: number(0.01, 3, "Fraction of reference width."), maskHeight: number(0.01, 3, "Fraction of reference height; Mirror uses this as band thickness."),
  maskRotation: number(-3600, 3600, "Additional degrees relative to the reference."),
  maskFeather: number(0, 0.5, "Softness as a fraction of the reference's shorter dimension."),
  maskInvert: boolean, blendMode: choices(BLEND_MODES),
  chromaKey: boolean, chromaColor: color,
  chromaTolerance: number(0, 1), chromaSoftness: number(0, 1), chromaSpill: number(0, 1),
};
const textFields: Record<string, Schema> = {
  ...sharedFields, text: string("Visible text; use newline characters for multiple lines.", 20000),
  duration: number(1 / 60, 36000), kind: choices(["text", "caption", "sticker"]),
  x: number(-2, 3, "Canvas fraction; 0.5 is the horizontal center."),
  y: number(-2, 3, "Canvas fraction; 0.5 is the vertical center."),
  snapToGuides: boolean, fontSize: number(1, 1000, "Pixels at a 1920px-wide canvas."),
  fontFamily: string(), fontWeight: integer(100, 900), italic: boolean, color,
  align: choices(["left", "center", "right"]), lineHeight: number(0.5, 4),
  letterSpacing: number(-30, 100), strokeColor: color, strokeWidth: number(0, 40),
  shadowColor: color, shadowBlur: number(0, 150), shadowOffset: number(-100, 100),
  background: boolean, backgroundColor: color, backgroundOpacity: number(0, 1),
  padding: number(0, 200), radius: number(0, 200),
  fillMode: choices(["solid", "linear", "radial"]), gradientAngle: number(-360, 360),
  gradientCenterX: number(0, 1), gradientCenterY: number(0, 1), gradientRadius: number(0.1, 2),
  gradientStops: { ...array(object({ id: string(), color, position: number(0, 1) }, ["color", "position"]), 8), minItems: 2 },
};
const clipFields: Record<string, Schema> = {
  ...sharedFields,
  x: number(-2, 2, "Offset from canvas center as a fraction of canvas width; 0 is centered."),
  y: number(-2, 2, "Offset from canvas center as a fraction of canvas height; 0 is centered."),
  scale: number(0.01, 10), speed: number(0.1, 8), volume: number(0, 3), audioPan: number(-1, 1, "Stereo balance: -1 left, 0 centered, 1 right."),
  fadeIn: seconds, fadeOut: seconds, flipX: boolean, flipY: boolean,
  fit: choices(["cover", "contain"]), brightness: number(0, 200), contrast: number(0, 200),
  crop: object({ x: number(0, 0.99), y: number(0, 0.99), width: number(0.01, 1), height: number(0.01, 1) }, ["x", "y", "width", "height"]),
  saturation: number(0, 200), temperature: number(-100, 100),
  gradingEnabled: boolean,
  ...Object.fromEntries(Object.entries(GRADE_RANGES).map(([name, range]) => [name, number(range[0], range[1], name === "exposure" ? "Display-referred exposure in stops." : "Color grading control.")])),
  colorCurves: object(Object.fromEntries(CURVE_CHANNELS.map((channel) => [channel,
    { ...array(object({ x: number(0, 1), y: number(0, 1) }, ["x", "y"]), 12), minItems: 2 }])), [...CURVE_CHANNELS]),
  filter: choices(FILTERS.map((value) => value.name)),
};
const projectFields = {
  name: string(), ratio: choices(["16:9", "9:16", "1:1", "4:5"]),
  fps: { type: "integer", enum: [30, 60] } as Schema, background: color,
};
const animationSettings = object({
  angle: number(-360, 360), distance: number(0, 1), zoomAmount: number(0, 2),
  zoomDirection: choices(["in", "out"]), rotation: number(-720, 720),
  blur: number(0, 0.1), fade: boolean,
  easing: choices(["ease-out", "ease-in-out", "linear", "ease-in"]),
});
const operation = (op: string, properties: Record<string, Schema>, required: string[] = []) =>
  object({ op: { const: op }, ...properties }, ["op", ...required]);
const operationSchemas = [
  operation("project", { patch: object(projectFields) }, ["patch"]),
  operation("layer", { track, muted: boolean, hidden: boolean, locked: { ...boolean, description: "Protect or unlock this layer. Unlock only when the user explicitly requests it; never unlock automatically to bypass edit protection." } }, ["track"]),
  operation("add_text", { ...textFields, ref: string(), preset: choices(TEXT_PRESETS.map((p) => p.name)), patch: object(textFields) }, ["text", "start", "duration", "track"]),
  operation("add_clip", { ...clipFields, ref: string(), assetId: string(), sourceStart: seconds, sourceEnd: seconds, patch: object(clipFields) }, ["assetId", "start", "track"]),
  operation("update", { ...clipFields, ...textFields, id, patch: object({ ...clipFields, ...textFields }) }, ["id"]),
  operation("trim_clip", { id, sourceStart: seconds, sourceEnd: seconds }, ["id", "sourceStart", "sourceEnd"]),
  operation("split", { id, at: seconds, ref: string() }, ["id", "at"]),
  operation("freeze", { id, at: seconds, duration: number(1 / 60, 3600), ref: string() }, ["id", "at", "duration"]),
  operation("duplicate", { id, start: seconds, track, ref: string() }, ["id", "start"]),
  operation("remove", { id }, ["id"]),
  operation("effect", { id, name: choices(EFFECTS.map((e) => e.name)), amount: number(0, 100), waves: integer(1, 16), remove: boolean }, ["id", "name"]),
  operation("transition", { id, name: choices(TRANSITIONS.map((t) => t.name)), duration: number(1 / 60, 3) }, ["id", "name", "duration"]),
  operation("animation", { id, phase: choices(["Entrance", "Exit"]), duration: seconds, layers: array(object({ name: choices(animationNames), settings: animationSettings }, ["name"]), 20) }, ["id", "phase", "duration", "layers"]),
  operation("combo", { id, layers: array(object({ name: choices(COMBO_ANIMATIONS), speed: number(0.1, 4), amount: number(0, 100) }, ["name", "speed", "amount"]), 10) }, ["id", "layers"]),
  operation("keyframe", { id, property: string("An editable scalar property, or effect:Name for an applied effect."), at: seconds, value: { oneOf: [{ type: "number" }, { type: "string" }, boolean] } }, ["id", "property", "at", "value"]),
];
export const EDIT_SCHEMA = object({
  projectId: string("ID from the latest get_project snapshot."),
  expectedRevision: string("Revision from the latest get_project snapshot; prevents overwriting concurrent manual edits."),
  operations: { type: "array", minItems: 1, maxItems: 100, items: { oneOf: operationSchemas } },
}, ["projectId", "expectedRevision", "operations"]);
export const CODEX_TOOLS = [
  { type: "function", name: "cutline_get_project", description: "Read the current timeline, selected items, playhead, project revision, and imported media. Read before every edit batch.", inputSchema: object({}) },
  { type: "function", name: "cutline_get_catalog", description: "Read exact preset names, installed fonts, property units, and editing rules. Never invent preset names.", inputSchema: object({}) },
  { type: "function", name: "cutline_apply_edits", description: "Apply one atomic, undoable batch to the open timeline. No edits apply if any operation is invalid. IDs can refer to @ref aliases created in this batch. Higher tracks render in front. For example add_text ref:title, then animation id:@title. Returns IDs and a new revision.", inputSchema: EDIT_SCHEMA },
  { type: "function", name: "cutline_preview", description: "View an accurately rendered frame at a specified timeline time, including all media, text, effects, transitions and animations. Verify the result after editing.", inputSchema: object({ time: seconds }, ["time"]) },
  { type: "function", name: "cutline_history", description: "Undo or redo one entire edit batch in the current project.", inputSchema: object({ action: choices(["undo", "redo"]) }, ["action"]) },
  { type: "function", name: "cutline_open_export", description: "Open the normal video export dialog after the edit is complete. The user chooses export settings and a destination.", inputSchema: object({}) },
];

export function validate(value: unknown, schema: Schema, path = "input"): void {
  if (schema.oneOf) {
    const op = value && typeof value === "object" ? (value as Record<string, unknown>).op : undefined;
    const match = schema.oneOf.find((choice) => choice.properties?.op?.const === op && op !== undefined);
    if (match) return validate(value, match, path);
    if (schema.oneOf.some((choice) => { try { validate(value, choice, path); return true; } catch { return false; } })) return;
    throw new Error(path + " does not match a supported value or operation.");
  }
  if (schema.const !== undefined && value !== schema.const) throw new Error(path + " has an invalid operation.");
  if (schema.enum && !schema.enum.includes(value)) throw new Error(path + " must be one of " + schema.enum.join(", "));
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(path + " must be an object.");
    const fields = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in fields)) throw new Error(path + "." + key + " is required.");
    for (const [key, item] of Object.entries(fields)) {
      if (!Object.hasOwn(schema.properties ?? {}, key)) throw new Error(path + "." + key + " is not editable.");
      validate(item, schema.properties![key], path + "." + key);
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? 100)) throw new Error(path + " has an invalid array length.");
    value.forEach((item, index) => validate(item, schema.items!, path + "[" + index + "]"));
  } else if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity) || (schema.type === "integer" && !Number.isInteger(value))) throw new Error(path + " is outside its allowed numeric range.");
  } else if (schema.type === "string") {
    if (typeof value !== "string" || value.length > (schema.maxLength ?? 20000) || (schema.pattern && !new RegExp(schema.pattern).test(value))) throw new Error(path + " is not a valid string.");
  } else if (schema.type === "boolean" && typeof value !== "boolean") throw new Error(path + " must be true or false.");
}
export function projectRevision(project: Project) {
  const data = JSON.stringify(project);
  let hash = 2166136261, second = 5381;
  for (let i = 0; i < data.length; i++) { hash = Math.imul(hash ^ data.charCodeAt(i), 16777619); second = Math.imul(second, 33) ^ data.charCodeAt(i); }
  return (hash >>> 0).toString(36) + "-" + (second >>> 0).toString(36);
}
export function projectSnapshot(project: Project) {
  return {
    projectId: project.id, revision: projectRevision(project), name: project.name,
    ratio: project.ratio, fps: project.fps, background: project.background,
    duration: projectDuration(project), layerCount: project.layerCount,
    mutedTracks: project.mutedTracks, hiddenTracks: project.hiddenTracks, lockedTracks: project.lockedTracks ?? [],
    assets: project.assets.map(({ id, name, kind, duration, width, height, audioPeak }) => ({ id, name, kind, duration, width, height, audioPeak })),
    clips: project.clips.map((clip) => ({ ...clip, duration: clipDuration(clip), end: endOf(clip) })),
    texts: project.texts.map((text) => ({ ...text, end: endOf(text) })),
    markers: project.markers,
  };
}
export function editingCatalog(fonts = FONTS) {
  return {
    locking: "Respect lockedTracks from get_project. Item edits, additions, removals and moves into locked layers reject atomically. Never unlock a layer just to complete another edit; only use layer locked:false when the user explicitly requests unlocking.",
    units: { time: "Seconds on the timeline, aligned to project frames.", markers: "The get_project snapshot includes markers [{kind:'beat'|'moment', time: seconds}]. These are user-placed timing guides.", tracks: "0-based universal layers; higher tracks are in front. Video, text and audio may share any layer. lockedTracks lists protected layer:N keys.", textPosition: "x/y are fractions of canvas dimensions; 0.5/0.5 centers text.", clipPosition: "x/y are offsets from canvas center; 0/0 centers media.", mask: "maskSpace content (default) follows the item's rendered bounds, rotation, scale, animation and flips; canvas uses the output frame. maskX/Y .5/.5 centers; maskWidth/Height are reference fractions; maskRotation adds degrees; maskFeather is a fraction of the shorter reference dimension. Linear reveals below its rotated center; Mirror reveals a band of maskHeight.", chroma: "Chroma key compares original media colors before grading/effects. chromaTolerance and chromaSoftness are normalized RGB distance; chromaSpill suppresses key color in partially transparent edges.", audioPan: "-1 left, 0 center, 1 right.", opacity: "0–1", fontSize: "Pixels at 1920px canvas width", color: "#RRGGBB" },
    rules: ["Use get_project immediately before apply_edits.", "Existing project markers identify user-marked song beats and important moments; preserve and use their kind and time as timing guides when planning edits and animations.", "Use exact IDs, or @ref for creations earlier in a batch.", "For add_text, add_clip and update, styling properties can be placed directly on the operation. A nested patch is also accepted; direct properties win.", "All operations in a batch commit together and undo together.", "A transition attaches to an incoming visual clip touching a preceding clip on the same track. Duration is at most 3 seconds and cannot exceed either clip length.", "Freeze inserts a held frame inside a video and shifts subsequent items on that layer by its duration.", "Overlapping visuals on the same track use the later-starting clip; use different tracks for overlays.", "Gradient stops can be keyframed with gradientStop:STOP_ID:color or gradientStop:STOP_ID:position.", "Only already imported assets can be inserted. Ask the user to import missing media.", "No shell commands, source-code edits, downloads, or filesystem access are needed to edit the video."],
    examples: [{ op: "add_text", ref: "title", text: "Hello", start: 0, duration: 3, track: 1, x: 0.5, y: 0.5, fontSize: 96, color: "#ffffff" }, { op: "animation", id: "@title", phase: "Entrance", duration: 0.6, layers: [{ name: "Letter Pop In" }] }, { op: "update", id: "EXACT_ITEM_ID", opacity: 0.75 }],
    textPresets: TEXT_PRESETS.map((preset) => preset.name), animations: ANIMATIONS,
    comboAnimations: COMBO_ANIMATIONS, effects: EFFECTS.map((effect) => effect.name), masks: MASK_SHAPES, blendModes: BLEND_MODES,
    transitions: TRANSITIONS.map((transition) => transition.name), filters: FILTERS.map((filter) => filter.name),
    colorGrading: { ranges: GRADE_RANGES, units: "Exposure is display-referred stops. Wheel hue uses degrees and strength 0–100; tonal/luminance/tint controls use −100–100. Curves use 0–1 input/output points, up to 12 per channel. Scalar controls support keyframes. gradingEnabled bypasses all color controls and look, but not effects/chroma/masks. This is 8-bit sRGB/Rec.709 grading, not scene-linear HDR/RAW." },
    fonts, textProperties: textFields, clipProperties: clipFields,
  };
}
type Operation = Record<string, unknown> & { op: string; id?: string; ref?: string; patch?: Record<string, unknown> };
export function applyCodexEdits(project: Project, input: unknown) {
  validate(input, EDIT_SCHEMA);
  const request = input as { projectId: string; expectedRevision: string; operations: Operation[] };
  if (request.projectId !== project.id || request.expectedRevision !== projectRevision(project)) throw new Error("The project changed. Read get_project again before editing.");
  let next = structuredClone(project);
  const aliases: Record<string, string> = Object.create(null);
  const changes: { operation: string; id?: string; ref?: string }[] = [];
  const assertEditableLayer = (track: number) => {
    if ((next.lockedTracks ?? []).includes(`layer:${track}`)) throw new Error(`Layer ${track + 1} is locked. Unlock it before editing.`);
  };
  const properties = (op: Operation, fields: Record<string, Schema>) => ({ ...op.patch, ...Object.fromEntries(Object.keys(fields).filter((key) => Object.hasOwn(op, key)).map((key) => [key, op[key]])) });
  const locate = (raw: string) => {
    const key = raw.startsWith("@") ? aliases[raw.slice(1)] : raw;
    const item = next.clips.find((clip) => clip.id === key) ?? next.texts.find((text) => text.id === key);
    if (!item) throw new Error("Unknown item ID: " + raw);
    return item;
  };
  const replace = (item: Clip | TextClip) => {
    Object.assign(item, normalizeCompositing(item));
    if ("sourceEnd" in item) next.clips = next.clips.map((clip) => clip.id === item.id ? item : clip);
    else next.texts = next.texts.map((text) => text.id === item.id ? item : text);
    next.layerCount = Math.max(next.layerCount, item.track + 1);
  };
  const checkClip = (clip: Clip) => {
    clip.crop = normalizeCrop(clip.crop);
    Object.assign(clip, normalizeCompositing(clip));
    Object.assign(clip, normalizeGrade(clip));
    const asset = next.assets.find((value) => value.id === clip.assetId)!;
    if (clip.sourceEnd <= clip.sourceStart || (clip.sourceEnd - clip.sourceStart) / clip.speed < 1 / next.fps - 1e-8) throw new Error("A clip must contain at least one frame.");
    if (clip.frozenAt === undefined && asset.kind !== "image" && asset.kind !== "demo" && clip.sourceEnd > asset.duration + 1 / next.fps) throw new Error("The clip trim extends beyond its source media.");
  };
  request.operations.forEach((op, index) => {
    try {
      let resultId: string | undefined;
      if (op.ref && Object.hasOwn(aliases, op.ref)) throw new Error("Duplicate ref: " + op.ref);
      if (op.op === "project") {
        next = { ...next, ...op.patch } as Project;
      } else if (op.op === "layer") {
        const layer = "layer:" + op.track;
        if (op.locked !== false && (op.muted !== undefined || op.hidden !== undefined)) assertEditableLayer(op.track as number);
        if (op.locked !== undefined) next.lockedTracks = [...(next.lockedTracks ?? []).filter((value) => value !== layer), ...(op.locked ? [layer] : [])];
        next.layerCount = Math.max(next.layerCount, (op.track as number) + 1);
        if (op.muted !== undefined) next.mutedTracks = [...next.mutedTracks.filter((value) => value !== layer), ...(op.muted ? [layer] : [])];
        if (op.hidden !== undefined) next.hiddenTracks = [...next.hiddenTracks.filter((value) => value !== layer), ...(op.hidden ? [layer] : [])];
      } else if (op.op === "add_text") {
        assertEditableLayer(op.track as number);
        const preset = TEXT_PRESETS.find((value) => value.name === op.preset);
        const item = makeText(roundFrame(op.start as number, next.fps), {
          ...preset?.style, ...properties(op, textFields), start: roundFrame(op.start as number, next.fps), text: op.text as string, track: op.track as number,
          duration: Math.max(1 / next.fps, roundFrame(op.duration as number, next.fps)),
        });
        item.gradientStops = normalizeGradientStops(item.gradientStops);
        Object.assign(item, normalizeCompositing(item));
        next.texts.push(item); next.layerCount = Math.max(next.layerCount, item.track + 1); resultId = item.id;
      } else if (op.op === "add_clip") {
        assertEditableLayer(op.track as number);
        const asset = next.assets.find((value) => value.id === op.assetId);
        if (!asset) throw new Error("Import this media first; asset ID was not found.");
        const patch = properties(op, clipFields);
        const item = { ...makeClip(asset, 0, 0), ...patch, start: roundFrame(op.start as number, next.fps), track: op.track as number } as Clip;
        if (patch.fit) item.fitExplicit = true;
        if (op.sourceStart !== undefined) item.sourceStart = op.sourceStart as number;
        if (op.sourceEnd !== undefined) item.sourceEnd = op.sourceEnd as number;
        checkClip(item); next.clips.push(item); next.layerCount = Math.max(next.layerCount, item.track + 1); resultId = item.id;
      } else {
        const item = locate(op.id!); resultId = item.id;
        assertEditableLayer(item.track);
        if (op.op === "update") {
          const patch = properties(op, { ...clipFields, ...textFields });
          validate(patch, object("sourceEnd" in item ? clipFields : textFields), "patch");
          if (!Object.keys(patch).length) throw new Error("Provide at least one property to update.");
          const updated = { ...item, ...patch } as typeof item;
          assertEditableLayer(updated.track);
          if (patch.fit) (updated as Clip).fitExplicit = true;
          updated.start = roundFrame(updated.start, next.fps);
          if ("sourceEnd" in updated) checkClip(updated);
          else { updated.duration = Math.max(1 / next.fps, roundFrame(updated.duration, next.fps)); updated.gradientStops = normalizeGradientStops(updated.gradientStops); }
          replace(updated);
        } else if (op.op === "trim_clip") {
          if (!("sourceEnd" in item)) throw new Error("Use update duration for text.");
          const updated = { ...item, sourceStart: op.sourceStart as number, sourceEnd: op.sourceEnd as number };
          checkClip(updated); replace(updated);
        } else if (op.op === "split") {
          const at = roundFrame(op.at as number, next.fps);
          if (at <= item.start || at >= endOf(item)) throw new Error("Split time must be inside the clip.");
          const result = splitItem(next, { id: item.id, kind: "sourceEnd" in item ? "clip" : "text" }, at);
          next = result.project; resultId = result.selection?.id;
        } else if (op.op === "duplicate") {
          assertEditableLayer((op.track ?? item.track) as number);
          const duplicated = { ...structuredClone(item), id: uid("sourceEnd" in item ? "clip" : "text"), start: roundFrame(op.start as number, next.fps), track: (op.track ?? item.track) as number };
          if ("sourceEnd" in duplicated) next.clips.push(duplicated); else next.texts.push(duplicated);
          next.layerCount = Math.max(next.layerCount, duplicated.track + 1); resultId = duplicated.id;
        } else if (op.op === "freeze") {
          if (!("sourceEnd" in item)) throw new Error("Freeze requires a video clip.");
          const result = freezeFrame(next, { id: item.id, kind: "clip" }, roundFrame(op.at as number, next.fps), op.duration as number);
          if (result.project === next) throw new Error("Freeze time must be inside a non-frozen video clip.");
          next = result.project; resultId = result.selection?.id;
        } else if (op.op === "remove") {
          next.clips = next.clips.filter((clip) => clip.id !== item.id); next.texts = next.texts.filter((text) => text.id !== item.id);
        } else if (op.op === "effect") {
          if ("assetId" in item && item.kind === "audio") throw new Error("Visual effects require a video, image or text clip, not an audio clip.");
          const existing = item.effects.find((effect) => effect.name === op.name);
          const definition = EFFECTS.find((effect) => effect.name === op.name);
          const updated = { name: op.name as Clip["effects"][number]["name"], amount: (op.amount ?? existing?.amount ?? definition?.defaultAmount ?? 50) as number,
            ...(op.name === "Wavy" ? { waves: (op.waves ?? existing?.waves ?? 4) as number } : {}) };
          const effects = op.remove ? item.effects.filter((effect) => effect.name !== op.name)
            : existing ? item.effects.map((effect) => effect.name === op.name ? updated : effect) : [...item.effects, updated];
          replace({ ...pruneEffectKeyframes(item, effects), effects });
        } else if (op.op === "transition") {
          if (!("sourceEnd" in item) || item.kind !== "video") throw new Error("Transitions require an incoming visual clip.");
          const previous = transitionSource(next, item);
          if (op.name !== "None" && !previous) throw new Error("This clip does not touch a preceding visual clip on the same layer.");
          if (previous && (op.duration as number) > Math.min(clipDuration(item), clipDuration(previous)) + 1e-8) throw new Error("Transition duration exceeds an adjacent clip's duration.");
          replace({ ...item, transitionDuration: roundFrame(op.duration as number, next.fps) });
          next = setJoinTransition(next, item.id, op.name as Clip["transition"]);
        } else if (op.op === "animation") {
          const layers = (op.layers as NonNullable<TextClip["animationStack"]>).map((layer) => ({ ...layer, settings: { ...defaultAnimationSettings(layer.name, op.phase as "Entrance" | "Exit"), ...layer.settings } }));
          if ("sourceEnd" in item && layers.some((layer) => layer.name === "Letter Pop In")) throw new Error("Letter Pop In is a text animation.");
          const entrance = op.phase === "Entrance";
          replace({ ...item, ...(entrance ? { animationStack: layers, animation: layers[0]?.name ?? "None", animationDuration: op.duration as number, animationPresetName: undefined } : { exitAnimationStack: layers, exitAnimation: layers[0]?.name ?? "None", exitAnimationDuration: op.duration as number, exitAnimationPresetName: undefined }) });
        } else if (op.op === "combo") {
          const layers = op.layers as NonNullable<TextClip["comboAnimations"]>;
          if (new Set(layers.map((layer) => layer.name)).size !== layers.length) throw new Error("Each combo animation may appear once.");
          replace({ ...item, comboAnimations: layers });
        } else if (op.op === "keyframe") {
          const property = op.property as string;
          const fields = "sourceEnd" in item ? clipFields : textFields;
          const effect = item.effects.find((value) => property === "effect:" + value.name);
          const stop = "gradientStops" in item ? item.gradientStops.find((value) => property === `gradientStop:${value.id}:color` || property === `gradientStop:${value.id}:position`) : undefined;
          const schema = effect ? number(0, 100) : stop ? (property.endsWith(":color") ? color : number(0, 1)) : fields[property];
          if (!schema || ["start", "track", "duration", "label", "text", "kind", "gradientStops"].includes(property)) throw new Error("This property cannot be keyframed.");
          validate(op.value, schema, "keyframe value");
          const local = roundFrame((op.at as number) - item.start, next.fps);
          if (local < 0 || local > endOf(item) - item.start) throw new Error("Keyframe time must be inside this item.");
          replace(setPropertyKeyframe(item, property, local, op.value as number | string | boolean, next.fps));
        }
      }
      if (op.ref && resultId) aliases[op.ref] = resultId;
      changes.push({ operation: op.op, id: resultId, ...(op.ref ? { ref: op.ref } : {}) });
    } catch (error) { throw new Error("Operation " + (index + 1) + " (" + op.op + "): " + (error as Error).message); }
  });
  return { project: next, result: { projectId: next.id, revision: projectRevision(next), changes, refs: aliases, duration: projectDuration(next) } };
}
