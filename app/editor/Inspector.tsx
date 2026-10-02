import { useCallback, useEffect, useState, type ReactNode } from "react";
import { CropDialog } from "./CropDialog";
import { FULL_CROP, normalizeCrop } from "./crop";
import {
  SlidersHorizontal,
  RotateCcw,
  Diamond,
  Plus,
  X,
  AlignLeft,
  AlignCenter,
  AlignRight,
  FlipHorizontal2,
  FlipVertical2,
  ChevronDown,
  Type,
  Film,
  Music2,
  Play,
  Save,
  Trash2,
  RefreshCw,
  Crop,
} from "lucide-react";
import {
  ANIMATIONS,
  BUNDLED_FONTS,
  COMMON_SYSTEM_FONTS,
  FONTS,
  TRANSITIONS,
} from "./presets";
import { animationLayers, defaultAnimationSettings, textAnimationTiming } from "./textAnimation";
import {
  createCustomAnimationPreset,
  readCustomAnimationPresets,
  writeCustomAnimationPresets,
  type CustomAnimationPreset,
} from "./customAnimationPresets";
import {
  clamp,
  animatedItem,
  clipDuration,
  clock,
  interpolatedTransform,
  normalizeGradientStops,
  setPropertyKeyframe,
  togglePropertyKeyframe,
  transitionSource,
  type Clip,
  type ComboAnimation,
  type ComboAnimationName,
  COMBO_ANIMATIONS,
  makeComboAnimation,
  type GradientStop,
  type Project,
  type Selection,
  type TextClip,
  type TextAnimationOptions,
  type AnimationLayer,
} from "./model";
type Props = {
  project: Project;
  selection: Selection;
  time: number;
  edit: (fn: (p: Project) => Project, group?: string) => void;
  clear: () => void;
  focusEffects?: boolean;
  previewAnimation?: (phase: "Entrance" | "Exit", item: Clip | TextClip) => void;
};
export function Inspector({
  project,
  selection,
  time,
  edit,
  clear,
  focusEffects,
  previewAnimation,
}: Props) {
  const isDesktop = typeof window !== "undefined" && Boolean(window.cutlineDesktop);
  const [tab, setTab] = useState("Basic");
  const [cropping, setCropping] = useState<string | null>(null);
  const [animationPhase, setAnimationPhase] = useState<"Entrance" | "Exit" | "Combo">(
    "Entrance",
  );
  const [selectedAnimationName, setSelectedAnimationName] = useState<string | null>(null);
  const [selectedComboName, setSelectedComboName] = useState<ComboAnimationName | null>(null);
  const [customPresets, setCustomPresets] = useState<CustomAnimationPreset[]>(readCustomAnimationPresets);
  const [newPresetName, setNewPresetName] = useState("");
  const [deletePresetId, setDeletePresetId] = useState<string | null>(null);
  const [presetError, setPresetError] = useState("");
  const [installedFonts, setInstalledFonts] = useState<string[]>([]);
  const [fontsLoading, setFontsLoading] = useState(isDesktop);
  const refreshInstalledFonts = useCallback(async (refresh = false) => {
    const listFonts = window.cutlineDesktop?.listInstalledFonts;
    if (!listFonts) return;
    setFontsLoading(true);
    try {
      setInstalledFonts(await listFonts(refresh));
    } catch {
      // Keep the bundled and common font choices available if system scanning fails.
    } finally {
      setFontsLoading(false);
    }
  }, []);
  useEffect(() => {
    if (!isDesktop) return;
    let active = true;
    void window.cutlineDesktop?.listInstalledFonts().then((fonts) => {
      if (active) setInstalledFonts(fonts);
    }).catch(() => {}).finally(() => {
      if (active) setFontsLoading(false);
    });
    return () => {
      active = false;
    };
  }, [isDesktop]);
  const sourceClip =
    selection?.kind === "clip"
      ? project.clips.find((c) => c.id === selection.id)
      : undefined;
  const sourceText =
    selection?.kind === "text"
      ? project.texts.find((t) => t.id === selection.id)
      : undefined;
  const clip = sourceClip ? animatedItem(sourceClip, time) : undefined;
  const text = sourceText ? animatedItem(sourceText, time) : undefined;
  const commonFontNames = new Set(FONTS.map((font) => font.toLocaleLowerCase()));
  const extraInstalledFonts = installedFonts.filter(
    (font) => !commonFontNames.has(font.toLocaleLowerCase()),
  );
  const selectedFontIsListed = [
    ...FONTS,
    ...installedFonts,
  ].some((font) => font.toLocaleLowerCase() === text?.fontFamily.toLocaleLowerCase());
  const effectsTab = text ? "Effects" : "Basic";
  useEffect(() => {
    if (!focusEffects) return;
    const frame = requestAnimationFrame(() => setTab(effectsTab));
    return () => cancelAnimationFrame(frame);
  }, [focusEffects, effectsTab, selection?.id]);
  const updateClip = (
    patch: Partial<Clip>,
    group = Object.keys(patch).join(),
  ) =>
    edit(
      (p) => ({
        ...p,
        clips: p.clips.map((c) => c.id === clip?.id ? applyPatch(c, patch, time, p.fps) : c),
      }),
      clip?.id + ":" + group,
    );
  const updateText = (
    patch: Partial<TextClip>,
    group = Object.keys(patch).join(),
  ) =>
    edit(
      (p) => ({
        ...p,
        texts: p.texts.map((t) => t.id === text?.id ? applyPatch(t, patch, time, p.fps) : t),
      }),
      text?.id + ":" + group,
    );
  const updateGradientStop = (id: string, patch: Partial<Pick<GradientStop, "color" | "position">>) => {
    if (!text) return;
    edit((p) => ({ ...p, texts: p.texts.map((item) => {
      if (item.id !== text.id) return item;
      let next = { ...item };
      const stopPatch: typeof patch = {};
      for (const [field, value] of Object.entries(patch)) {
        const key = `gradientStop:${id}:${field}`;
        if (item.propertyKeyframes?.[key]?.length)
          next = setPropertyKeyframe(next, key, time - item.start, value, p.fps);
        else (stopPatch as Record<string, unknown>)[field] = value;
      }
      if (Object.keys(stopPatch).length)
        next.gradientStops = item.gradientStops.map((stop) => stop.id === id ? { ...stop, ...stopPatch } : stop);
      return next;
    }) }), `${text.id}:gradientStop:${id}:${Object.keys(patch).join()}`);
  };
  const replaceGradientStops = (stops: GradientStop[]) => {
    if (!text) return;
    edit((p) => ({ ...p, texts: p.texts.map((item) => item.id === text.id ? {
      ...item,
      gradientStops: normalizeGradientStops(stops),
      propertyKeyframes: Object.fromEntries(Object.entries(item.propertyKeyframes ?? {})
        .filter(([name]) => !name.startsWith("gradientStop:"))),
    } : item) }), `${text.id}:gradientStops`);
  };
  const transform = clip
    ? interpolatedTransform(clip, time - clip.start)
    : null;
  const previousClip = clip ? transitionSource(project, clip) : undefined;
  const updateTransform = (patch: Partial<Clip>) => {
    if (!clip || !transform) return;
    if (!clip.keyframes.length || Object.keys(patch).some((name) => clip.propertyKeyframes?.[name]?.length)) updateClip(patch);
    else {
      const t = clamp(
        Math.round((time - clip.start) * project.fps) / project.fps,
        0,
        clipDuration(clip),
      );
      updateClip(
        {
          keyframes: [
            ...clip.keyframes.filter(
              (k) => Math.abs(k.time - t) > 0.5 / project.fps,
            ),
            { time: t, ...transform, ...patch },
          ].sort((a, b) => a.time - b.time),
        },
        "keyframes",
      );
    }
  };
  const keyAtTime = clip?.keyframes.find(
    (k) => Math.abs(k.time - (time - clip.start)) < 1 / project.fps,
  );
  const keyButton = (item: Clip | TextClip | undefined, name: string, value: number | string | boolean) => {
    if (!item) return undefined;
    const current = Math.round((time - item.start) * project.fps) / project.fps;
    const active = item.propertyKeyframes?.[name]?.some((key) => Math.abs(key.time - current) < 0.5 / project.fps);
    return <button type="button" className={"property-keyframe" + (active ? " active" : "")}
      aria-label={`${active ? "Remove" : "Add"} ${name} keyframe`}
      title={`${active ? "Remove" : "Add"} ${name} keyframe at playhead`}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        edit((p) => ({ ...p,
          clips: p.clips.map((c) => c.id === item.id ? togglePropertyKeyframe(c, name, time - c.start, value, p.fps) : c),
          texts: p.texts.map((t) => t.id === item.id ? togglePropertyKeyframe(t, name, time - t.start, value, p.fps) : t),
        }));
      }}><Diamond size={12} fill={active ? "currentColor" : "none"} /></button>;
  };
  const ck = (name: keyof Clip, value: number | string | boolean) => keyButton(clip, String(name), value);
  const tk = (name: keyof TextClip, value: number | string | boolean) => keyButton(text, String(name), value);
  const animationItem = text ?? (clip?.kind === "video" ? clip : undefined);
  const animationLength = animationItem ? ("sourceEnd" in animationItem ? clipDuration(animationItem) : animationItem.duration) : 0;
  const phaseStack = animationItem && animationPhase !== "Combo" ? animationLayers(animationItem, animationPhase) : [];
  const selectedLayer = phaseStack.find((layer) => layer.name === selectedAnimationName) ?? phaseStack[0];
  const phaseBase = selectedLayer?.name ?? "None";
  const phaseSettings = selectedLayer?.settings ?? {};
  const phaseDefaults = animationPhase === "Combo" ? {} : defaultAnimationSettings(phaseBase, animationPhase);
  const phaseOptions = { ...phaseDefaults, ...phaseSettings };
  const comboStack = animationItem?.comboAnimations ?? [];
  const selectedCombo = comboStack.find((layer) => layer.name === selectedComboName) ?? comboStack[0];
  const phaseDuration = animationItem && (animationPhase === "Entrance" ? animationItem.animationDuration : animationItem.exitAnimationDuration) || 0.5;
  const activePresetName = animationItem && animationPhase !== "Combo" ? (animationPhase === "Entrance" ? animationItem.animationPresetName : animationItem.exitAnimationPresetName) : undefined;
  const updateAnimationItem = (patch: Partial<Clip> & Partial<TextClip>) => {
    if (text) updateText(patch);
    else if (clip) updateClip(patch);
  };
  const setAnimationStack = (layers: AnimationLayer[], presetName?: string, duration?: number) => {
    if (animationPhase === "Combo") return;
    const first = layers[0];
    const patch = {
      animation: first?.name ?? "None",
      animationSettings: first?.settings ?? {},
      animationStack: layers,
      animationPresetName: presetName,
    };
    if (animationPhase === "Entrance") updateAnimationItem({ ...patch, ...(duration === undefined ? {} : { animationDuration: duration }) });
    else updateAnimationItem({
      exitAnimation: patch.animation,
      exitAnimationSettings: patch.animationSettings,
      exitAnimationStack: patch.animationStack,
      exitAnimationPresetName: patch.animationPresetName,
      ...(duration === undefined ? {} : { exitAnimationDuration: duration }),
    });
  };
  const updateAnimationOptions = (patch: TextAnimationOptions) => {
    if (!selectedLayer) return;
    setAnimationStack(phaseStack.map((layer) => layer === selectedLayer
      ? { ...layer, settings: { ...layer.settings, ...patch } } : layer));
  };
  const chooseAnimation = (name: TextClip["animation"]) => {
    if (animationPhase === "Combo") return;
    if (name === "None") { setAnimationStack([]); setSelectedAnimationName(null); return; }
    const exists = phaseStack.some((layer) => layer.name === name);
    setAnimationStack(exists ? phaseStack.filter((layer) => layer.name !== name)
      : [...phaseStack, { name, settings: {} }]);
    setSelectedAnimationName(exists ? null : name);
  };
  const chooseComboAnimation = (name: ComboAnimationName) => {
    const exists = comboStack.some((layer) => layer.name === name);
    updateAnimationItem({ comboAnimations: exists
      ? comboStack.filter((layer) => layer.name !== name)
      : [...comboStack, makeComboAnimation(name)] });
    setSelectedComboName(exists ? null : name);
  };
  const updateComboAnimation = (patch: Partial<Pick<ComboAnimation, "speed" | "amount">>) => {
    if (!selectedCombo) return;
    updateAnimationItem({ comboAnimations: comboStack.map((layer) => layer.name === selectedCombo.name ? { ...layer, ...patch } : layer) });
  };
  const applyCustomPreset = (preset: CustomAnimationPreset, append = false) => {
    const incoming = (preset.layers ?? [{ name: preset.base, settings: preset.settings }])
      .map((layer) => ({ name: layer.name, settings: { ...layer.settings } }));
    const layers = append ? [...phaseStack, ...incoming.filter((layer) => !phaseStack.some((current) => current.name === layer.name))] : incoming;
    setAnimationStack(layers, append ? undefined : preset.name,
      append ? undefined : Math.min(preset.duration, animationLength));
    setSelectedAnimationName(incoming[0]?.name ?? null);
  };
  const saveCustomPreset = () => {
    if (!animationItem || animationPhase === "Combo" || !phaseStack.length || !newPresetName.trim()) return;
    const preset = createCustomAnimationPreset(newPresetName, animationPhase, phaseStack[0].name, phaseDuration, phaseStack[0].settings, phaseStack);
    const next = [...customPresets, preset].slice(-50);
    if (!writeCustomAnimationPresets(next)) { setPresetError("Could not save presets on this device."); return; }
    setCustomPresets(next);
    setNewPresetName("");
    setPresetError("");
    applyCustomPreset(preset);
  };
  const deleteCustomPreset = (id: string) => {
    if (deletePresetId !== id) { setDeletePresetId(id); return; }
    const next = customPresets.filter((preset) => preset.id !== id);
    if (!writeCustomAnimationPresets(next)) { setPresetError("Could not delete the saved preset."); return; }
    setCustomPresets(next);
    setDeletePresetId(null);
  };
  const activeTab = (text
    ? ["Basic", "Style", "Animation", "Effects"]
    : clip?.kind === "audio" ? ["Basic", "Audio"] : ["Basic", "Animation", "Color", "Audio"]
  ).includes(tab)
    ? tab
    : "Basic";
  return (
    <aside className="inspector">
      <div className="panel-heading">
        <span>
          <SlidersHorizontal size={15} /> Inspector
        </span>
        {selection && (
          <button title="Deselect" aria-label="Deselect clip" onClick={clear}>
            <X size={15} />
          </button>
        )}
      </div>
      {!clip && !text ? (
        <div className="inspector-scroll">
          <div className="inspector-empty">
            <div className="empty-icon">
              <SlidersHorizontal size={24} />
            </div>
            <h3>Make every detail yours</h3>
            <p>
              Select a clip or text layer to adjust its look, motion, and sound.
            </p>
          </div>
          <Section title="Project settings">
            <Field label="Canvas">
              <select
                value={project.ratio}
                onChange={(e) =>
                  edit((p) => ({
                    ...p,
                    ratio: e.target.value as Project["ratio"],
                  }))
                }
              >
                {["16:9", "9:16", "1:1", "4:5"].map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </Field>
            <Field label="Frame rate">
              <select
                value={project.fps}
                onChange={(e) => edit((p) => ({ ...p, fps: +e.target.value }))}
              >
                <option value="30">30 fps</option>
                <option value="60">60 fps</option>
              </select>
            </Field>
            <Color
              label="Background"
              value={project.background}
              onChange={(v) =>
                edit((p) => ({ ...p, background: v }), "background")
              }
            />
          </Section>
          <div className="inspector-tip">
            Everything stays on your device. Make a project backup to move your
            edit and its media to another computer.
          </div>
        </div>
      ) : (
        <>
          <div className="selected-heading">
            <span
              className={
                "selected-kind " +
                (text
                  ? "text-kind"
                  : clip?.kind === "audio"
                    ? "audio-kind"
                    : "")
              }
            >
              {text ? (
                <Type size={17} />
              ) : clip?.kind === "audio" ? (
                <Music2 size={17} />
              ) : (
                <Film size={17} />
              )}
            </span>
            <div>
              <strong>{text ? "Text layer" : clip?.label}</strong>
              <span>
                {text
                  ? clock(text.duration, true)
                  : clock(clipDuration(clip!), true)}{" "}
                duration
              </span>
            </div>
          </div>
          <div className="inspector-tabs">
            {(text
              ? ["Basic", "Style", "Animation", "Effects"]
              : clip?.kind === "audio"
                ? ["Basic", "Audio"]
                : ["Basic", "Animation", "Color", "Audio"]
            ).map((t) => (
              <button
                className={activeTab === t ? "active" : ""}
                key={t}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="inspector-scroll">
            {text && activeTab === "Basic" && (
              <>
                <Section title="Content">
                  <div className="field-label">Text {tk("text", text.text)}</div>
                  <textarea
                    aria-label="Text content"
                    value={text.text}
                    rows={3}
                    onChange={(e) => updateText({ text: e.target.value })}
                  />
                  <div className="font-picker-field field">
                    <span className="field-label">
                      Font {tk("fontFamily", text.fontFamily)}
                      {isDesktop && (
                        <button
                          className="font-refresh-button"
                          type="button"
                          title="Refresh fonts installed on this PC"
                          aria-label="Refresh installed fonts"
                          disabled={fontsLoading}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => void refreshInstalledFonts(true)}
                        >
                          <RefreshCw size={12} className={fontsLoading ? "spinning" : ""} />
                        </button>
                      )}
                    </span>
                    <select
                      aria-label="Font"
                      value={text.fontFamily}
                      onFocus={() => {
                        if (isDesktop) void refreshInstalledFonts(true);
                      }}
                      onChange={(e) =>
                        updateText({ fontFamily: e.target.value })
                      }
                    >
                      {!selectedFontIsListed && (
                        <optgroup label="Saved in this project">
                          <option value={text.fontFamily}>{text.fontFamily}</option>
                        </optgroup>
                      )}
                      <optgroup label="Included with Cutline · works offline">
                        {BUNDLED_FONTS.map((font) => (
                          <option key={font} value={font} style={{ fontFamily: font }}>
                            {font.replace(/ Variable$/, "")}
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label="Popular system fonts">
                        {COMMON_SYSTEM_FONTS.map((font) => (
                          <option key={font} value={font} style={{ fontFamily: font }}>
                            {font}
                          </option>
                        ))}
                      </optgroup>
                      {isDesktop && (
                        <optgroup label={`Installed on this PC (${installedFonts.length})`}>
                          {extraInstalledFonts.map((font) => (
                            <option key={font} value={font} style={{ fontFamily: font }}>
                              {font}
                            </option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                    <small className="font-picker-note">
                      {isDesktop
                        ? fontsLoading
                          ? "Scanning Windows fonts…"
                          : `${installedFonts.length} fonts found on this PC. New installs appear after refresh.`
                        : "The desktop app also lists fonts installed on your PC."}
                    </small>
                  </div>
                  <div className="field-grid">
                    <NumberField
                      label="Size"
                      keyframe={tk("fontSize", text.fontSize)}
                      value={text.fontSize}
                      min={12}
                      max={400}
                      onChange={(v) => updateText({ fontSize: v })}
                    />
                    <Field label="Weight" keyframe={tk("fontWeight", text.fontWeight)}>
                      <select
                        value={text.fontWeight}
                        onChange={(e) =>
                          updateText({ fontWeight: +e.target.value })
                        }
                      >
                        {[400, 500, 600, 700, 800, 900].map((w) => (
                          <option key={w}>{w}</option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <div className="text-format">
                    <div className="field-label">{tk("italic", text.italic)}<button
                      className={text.italic ? "active italic" : "italic"}
                      title="Italic"
                      onClick={() => updateText({ italic: !text.italic })}
                    >
                      I
                    </button></div>
                    <div className="segmented">
                      {tk("align", text.align)}
                      {(["left", "center", "right"] as const).map(
                        (align, i) => (
                          <button
                            key={align}
                            title={"Align " + align}
                            aria-label={"Align " + align}
                            className={text.align === align ? "active" : ""}
                            onClick={() => updateText({ align })}
                          >
                            {i === 0 ? (
                              <AlignLeft size={16} />
                            ) : i === 1 ? (
                              <AlignCenter size={16} />
                            ) : (
                              <AlignRight size={16} />
                            )}
                          </button>
                        ),
                      )}
                    </div>
                  </div>
                </Section>
                <TextFillControls
                  text={text}
                  onChange={updateText}
                  onStopChange={updateGradientStop}
                  onReplaceStops={replaceGradientStops}
                  keyframe={(name, value) => keyButton(text, name, value)}
                />
                <Section title="Position & timing">
                  <Toggle
                    label="Snap to center guides"
                    value={text.snapToGuides !== false}
                    onChange={(v) => updateText({ snapToGuides: v })}
                  />
                  <div className="field-grid">
                    <NumberField
                      label="X (%)"
                      keyframe={tk("x", text.x)}
                      value={text.x * 100}
                      min={-50}
                      max={150}
                      onChange={(v) => updateText({ x: v / 100 })}
                    />
                    <NumberField
                      label="Y (%)"
                      keyframe={tk("y", text.y)}
                      value={text.y * 100}
                      min={-50}
                      max={150}
                      onChange={(v) => updateText({ y: v / 100 })}
                    />
                  </div>
                  <Range
                    label="Rotation"
                    value={text.rotation}
                    keyframe={tk("rotation", text.rotation)}
                    min={-180}
                    max={180}
                    suffix="°"
                    onChange={(v) => updateText({ rotation: v })}
                  />
                  <Range
                    label="Opacity"
                    value={text.opacity * 100}
                    keyframe={tk("opacity", text.opacity)}
                    min={0}
                    max={100}
                    suffix="%"
                    onChange={(v) => updateText({ opacity: v / 100 })}
                  />
                  <div className="field-grid">
                    <NumberField
                      label="Start (s)"
                      value={text.start}
                      min={0}
                      max={36000}
                      step={0.1}
                      onChange={(v) => updateText({ start: v })}
                    />
                    <NumberField
                      label="Duration (s)"
                      value={text.duration}
                      min={1 / project.fps}
                      max={36000}
                      step={0.1}
                      onChange={(v) => updateText({ duration: v })}
                    />
                  </div>
                </Section>
              </>
            )}
            {text && activeTab === "Style" && (
              <>
                <Section title="Spacing">
                  <Range
                    label="Letter spacing"
                    keyframe={tk("letterSpacing", text.letterSpacing)}
                    value={text.letterSpacing}
                    min={-5}
                    max={30}
                    onChange={(v) => updateText({ letterSpacing: v })}
                  />
                  <Range
                    label="Line height"
                    keyframe={tk("lineHeight", text.lineHeight)}
                    value={text.lineHeight}
                    min={0.7}
                    max={2.5}
                    step={0.05}
                    onChange={(v) => updateText({ lineHeight: v })}
                  />
                </Section>
                <Section title="Outline">
                  <Range
                    label="Thickness"
                    keyframe={tk("strokeWidth", text.strokeWidth)}
                    value={text.strokeWidth}
                    min={0}
                    max={16}
                    onChange={(v) => updateText({ strokeWidth: v })}
                  />
                  <Color
                    label="Outline color"
                    keyframe={tk("strokeColor", text.strokeColor)}
                    value={text.strokeColor}
                    onChange={(v) => updateText({ strokeColor: v })}
                  />
                </Section>
                <Section title="Shadow & glow">
                  <Color
                    label="Shadow color"
                    keyframe={tk("shadowColor", text.shadowColor)}
                    value={text.shadowColor}
                    onChange={(v) => updateText({ shadowColor: v })}
                  />
                  <Range
                    label="Blur"
                    keyframe={tk("shadowBlur", text.shadowBlur)}
                    value={text.shadowBlur}
                    min={0}
                    max={60}
                    onChange={(v) => updateText({ shadowBlur: v })}
                  />
                  <Range
                    label="Offset"
                    keyframe={tk("shadowOffset", text.shadowOffset)}
                    value={text.shadowOffset}
                    min={0}
                    max={30}
                    onChange={(v) => updateText({ shadowOffset: v })}
                  />
                </Section>
                <Section title="Background">
                  <Toggle
                    label="Text background"
                    keyframe={tk("background", text.background)}
                    value={text.background}
                    onChange={(v) => updateText({ background: v })}
                  />
                  {text.background && (
                    <>
                      <Color
                        label="Fill"
                        keyframe={tk("backgroundColor", text.backgroundColor)}
                        value={text.backgroundColor}
                        onChange={(v) => updateText({ backgroundColor: v })}
                      />
                      <Range
                        label="Opacity"
                        keyframe={tk("backgroundOpacity", text.backgroundOpacity)}
                        value={text.backgroundOpacity * 100}
                        min={0}
                        max={100}
                        suffix="%"
                        onChange={(v) =>
                          updateText({ backgroundOpacity: v / 100 })
                        }
                      />
                      <Range
                        label="Padding"
                        keyframe={tk("padding", text.padding)}
                        value={text.padding}
                        min={0}
                        max={60}
                        onChange={(v) => updateText({ padding: v })}
                      />
                      <Range
                        label="Corner radius"
                        keyframe={tk("radius", text.radius)}
                        value={text.radius}
                        min={0}
                        max={80}
                        onChange={(v) => updateText({ radius: v })}
                      />
                    </>
                  )}
                </Section>
              </>
            )}
            {text && activeTab === "Effects" && (
              <EffectsControls
                effects={text.effects ?? []}
                keyframe={(name, amount) => keyButton(text, `effect:${name}`, amount)}
                onChange={(effects, group) => updateText({ effects }, group)}
              />
            )}
            {animationItem && activeTab === "Animation" && (
              <>
                <div
                  className="animation-phase"
                  role="group"
                  aria-label="Animation phase"
                >
                  {(["Entrance", "Exit", "Combo"] as const).map((phase) => (
                    <button
                      key={phase}
                      aria-pressed={animationPhase === phase}
                      className={animationPhase === phase ? "active" : ""}
                      onClick={() => { setAnimationPhase(phase); setDeletePresetId(null); }}
                    >
                      {phase}
                    </button>
                  ))}
                </div>
                {animationPhase === "Entrance" && (
                  <Section title="Entrance">
                    <div className="choice-grid">
                      {ANIMATIONS.filter((a) => text || a !== "Letter Pop In").map((a) => (
                        <button
                          key={a}
                          aria-label={"Entrance " + a}
                          aria-pressed={a === "None" ? phaseStack.length === 0 : phaseStack.some((layer) => layer.name === a)}
                          className={(a === "None" ? phaseStack.length === 0 : phaseStack.some((layer) => layer.name === a)) ? "active" : ""}
                          onClick={() => chooseAnimation(a)}
                        >
                          {a}
                        </button>
                      ))}
                    </div>
                    <Range
                      label="Entrance duration"
                      value={animationItem.animationDuration ?? 0.5}
                      min={0}
                      max={animationLength}
                      step={0.1}
                      suffix="s"
                      onChange={(v) => updateAnimationItem({ animationDuration: v })}
                    />
                  </Section>
                )}
                {animationPhase === "Exit" && (
                  <Section title="Exit">
                    <div className="choice-grid">
                      {ANIMATIONS.filter((a) => text || a !== "Letter Pop In").map((a) => (
                        <button
                          key={a}
                          aria-label={"Exit " + (a === "Letter Pop In" ? "Letter Pop Out" : a)}
                          aria-pressed={a === "None" ? phaseStack.length === 0 : phaseStack.some((layer) => layer.name === a)}
                          className={(a === "None" ? phaseStack.length === 0 : phaseStack.some((layer) => layer.name === a)) ? "active" : ""}
                          onClick={() => chooseAnimation(a)}
                        >
                          {a === "Typewriter" ? "Erase" : animationPhase === "Exit" && a === "Letter Pop In" ? "Letter Pop Out" : a}
                        </button>
                      ))}
                    </div>
                    <Range
                      label="Exit duration"
                      value={animationItem.exitAnimationDuration ?? 0.5}
                      min={0}
                      max={animationLength}
                      step={0.1}
                      suffix="s"
                      onChange={(v) => updateAnimationItem({ exitAnimationDuration: v })}
                    />
                  </Section>
                )}
                {animationPhase === "Combo" && (
                  <>
                    <Section title={`Combo · ${comboStack.length} active`}>
                      <p className="field-note">These loops stay active for the full clip, between and underneath its entrance and exit animations.</p>
                      <div className="choice-grid combo-choice-grid">
                        {COMBO_ANIMATIONS.map((name) => (
                          <button key={name} aria-label={`Combo ${name}`} aria-pressed={comboStack.some((layer) => layer.name === name)}
                            className={comboStack.some((layer) => layer.name === name) ? "active" : ""}
                            onClick={() => chooseComboAnimation(name)}>{name}</button>
                        ))}
                      </div>
                    </Section>
                    {comboStack.length > 0 && <div className="animation-stack-list" aria-label="Combo animation stack">
                      {comboStack.map((layer, index) => <button key={layer.name} className={selectedCombo?.name === layer.name ? "active" : ""}
                        aria-label={`Edit ${layer.name} combo`} onClick={() => setSelectedComboName(layer.name)}>{index + 1}. {layer.name}</button>)}
                    </div>}
                    {selectedCombo && <Section title={`Fine tune · ${selectedCombo.name}`}>
                      <Range label="Intensity" value={selectedCombo.amount} min={0} max={100} suffix="%" onChange={(value) => updateComboAnimation({ amount: value })} />
                      <Range label="Loop speed" value={selectedCombo.speed} min={0.1} max={3} step={0.1} suffix="×" onChange={(value) => updateComboAnimation({ speed: value })} />
                    </Section>}
                  </>
                )}
                {animationPhase !== "Combo" && <p className="field-note animation-stack-hint">Select more than one animation to stack them. Click a selected animation again to remove it.</p>}
                {phaseStack.length > 0 && <div className="animation-stack-list" aria-label={`${animationPhase} animation stack`}>
                  {phaseStack.map((layer, index) => <button key={index} className={selectedLayer === layer ? "active" : ""}
                    aria-label={`Edit ${layer.name} in ${animationPhase.toLowerCase()} stack`}
                    onClick={() => setSelectedAnimationName(layer.name)}>{index + 1}. {layer.name}</button>)}
                </div>}
                {selectedLayer && (
                  <Section title={`Fine tune · ${phaseBase}`} action={previewAnimation ? <button title={`Preview ${animationPhase.toLowerCase()}`} aria-label={`Preview ${animationPhase.toLowerCase()} animation`} onClick={() => previewAnimation(animationPhase === "Exit" ? "Exit" : "Entrance", animationItem)}><Play size={14} /></button> : undefined}>
                    {activePresetName && <p className="animation-preset-label">Using “{activePresetName}” · edits here only change this clip.</p>}
                    <AnimationTuner name={phaseBase} options={phaseOptions} onChange={updateAnimationOptions} />
                    <p className="field-note">These settings change only {phaseBase} in the stack. Preview or scrub to see the combined motion.</p>
                  </Section>
                )}
                {animationPhase !== "Combo" && <Section title={`My ${animationPhase.toLowerCase()} presets`}>
                  {customPresets.filter((preset) => preset.phase === animationPhase).length ? (
                    <div className="custom-animation-list">
                      {customPresets.filter((preset) => preset.phase === animationPhase).map((preset) => (
                        <div className="custom-animation-item" key={preset.id}>
                          <button className="custom-animation-apply" onClick={() => applyCustomPreset(preset)} title={`Replace stack with ${preset.name}`}>
                            <strong>{preset.name}</strong><small>{(preset.layers ?? [{name: preset.base}]).map((layer) => layer.name).join(" + ")} · {preset.duration.toFixed(1)}s</small>
                          </button>
                          <button aria-label={`Add ${preset.name} to stack`} title={`Add ${preset.name} to this stack`} onClick={() => applyCustomPreset(preset, true)}>+</button>
                          <button className={deletePresetId === preset.id ? "danger" : ""} aria-label={deletePresetId === preset.id ? `Confirm delete ${preset.name}` : `Delete ${preset.name}`} title={deletePresetId === preset.id ? "Click again to delete" : "Delete saved preset"} onClick={() => deleteCustomPreset(preset.id)}><Trash2 size={14} /></button>
                        </div>
                      ))}
                    </div>
                  ) : <p className="field-note">No saved {animationPhase.toLowerCase()} animations yet.</p>}
                  <div className="animation-save-row">
                    <input aria-label="New animation preset name" value={newPresetName} maxLength={42} placeholder="Name this animation" onChange={(event) => setNewPresetName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") saveCustomPreset(); }} />
                    <button className="button secondary" title="Save current animation stack" disabled={!newPresetName.trim() || !phaseStack.length} onClick={saveCustomPreset}><Save size={14} /> Save</button>
                  </div>
                  {presetError && <p className="field-note" role="alert">{presetError}</p>}
                  <p className="field-note">Click a preset to replace this phase, or + to add it to the stack. Saved locally; applied motion stays in your project backup.</p>
                </Section>}
                {animationPhase !== "Combo" && <div className="inspector-tip">
                  Scrub the start or end of this clip to preview. On short
                  clips, durations scale together so entrance and exit never
                  overlap. Effective timing:{" "}
                  {textAnimationTiming(animationItem).entranceDuration.toFixed(2)}s in
                  {" / "}
                  {textAnimationTiming(animationItem).exitDuration.toFixed(2)}s out.
                </div>}
              </>
            )}
            {clip && activeTab === "Basic" && (
              <>
                <Section title="Clip">
                  <Field label="Name">
                    <input
                      value={clip.label}
                      aria-label="Clip name"
                      onChange={(e) => updateClip({ label: e.target.value })}
                    />
                  </Field>
                  <div className="field-grid">
                    <NumberField
                      label="Start (s)"
                      value={clip.start}
                      min={0}
                      max={36000}
                      step={1 / project.fps}
                      onChange={(v) => updateClip({ start: v })}
                    />
                    <Field label="Speed">
                      <select
                        value={clip.speed}
                        onChange={(e) => updateClip({ speed: +e.target.value })}
                      >
                        {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map((v) => (
                          <option key={v} value={v}>
                            {v}×
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <p className="field-note">
                    Speed changes this clip’s duration. Other clips stay in
                    place.
                  </p>
                </Section>
                {clip.kind === "video" && transform && (
                  <>
                    <Section
                      title="Transform"
                      action={
                        <button
                          title="Reset transform and keyframes"
                          aria-label="Reset transform"
                          onClick={() => edit((p) => ({ ...p, clips: p.clips.map((c) => {
                            if (c.id !== clip.id) return c;
                            const propertyKeyframes = { ...c.propertyKeyframes };
                            for (const name of ["x", "y", "scale", "rotation", "opacity", "flipX", "flipY", "fit"]) delete propertyKeyframes[name];
                            return { ...c, x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, flipX: false, flipY: false, fit: (p.assets.find((a) => a.id === c.assetId)?.kind === "image" ? "contain" : "cover") as Clip["fit"], fitExplicit: false, keyframes: [], propertyKeyframes };
                          }) }))}
                        >
                          <RotateCcw size={14} />
                        </button>
                      }
                    >
                      <div className="keyframe-row">
                        <span>Motion keyframe</span>
                        <button
                          title={
                            keyAtTime
                              ? "Remove keyframe here"
                              : "Add keyframe here"
                          }
                          className={keyAtTime ? "active" : ""}
                          onClick={() => {
                            const t = clamp(
                              Math.round((time - clip.start) * project.fps) /
                                project.fps,
                              0,
                              clipDuration(clip),
                            );
                            updateClip(
                              {
                                keyframes: keyAtTime
                                  ? clip.keyframes.filter(
                                      (k) => k !== keyAtTime,
                                    )
                                  : [
                                      ...clip.keyframes,
                                      { time: t, ...transform },
                                    ].sort((a, b) => a.time - b.time),
                              },
                              "",
                            );
                          }}
                        >
                          <Diamond
                            size={14}
                            fill={keyAtTime ? "currentColor" : "none"}
                          />
                          {keyAtTime ? "Remove" : "Add"}
                        </button>
                      </div>
                      <Range
                        label="Scale"
                        keyframe={ck("scale", transform.scale)}
                        value={transform.scale * 100}
                        min={5}
                        max={300}
                        suffix="%"
                        onChange={(v) => updateTransform({ scale: v / 100 })}
                      />
                      <Toggle
                        label="Snap to center guides"
                        value={clip.snapToGuides !== false}
                        onChange={(v) => updateClip({ snapToGuides: v })}
                      />
                      <div className="field-grid">
                        <NumberField
                          label="X (%)"
                          keyframe={ck("x", transform.x)}
                          value={transform.x * 100}
                          min={-200}
                          max={200}
                          onChange={(v) => updateTransform({ x: v / 100 })}
                        />
                        <NumberField
                          label="Y (%)"
                          keyframe={ck("y", transform.y)}
                          value={transform.y * 100}
                          min={-200}
                          max={200}
                          onChange={(v) => updateTransform({ y: v / 100 })}
                        />
                      </div>
                      <Range
                        label="Rotation"
                        value={transform.rotation}
                        keyframe={ck("rotation", transform.rotation)}
                        min={-180}
                        max={180}
                        suffix="°"
                        onChange={(v) => updateTransform({ rotation: v })}
                      />
                      <Range
                        label="Opacity"
                        value={transform.opacity * 100}
                        keyframe={ck("opacity", transform.opacity)}
                        min={0}
                        max={100}
                        suffix="%"
                        onChange={(v) => updateTransform({ opacity: v / 100 })}
                      />
                      <div className="field-grid">
                        <Field label="Fit" keyframe={ck("fit", clip.fit)}>
                          <select
                            value={clip.fit}
                            onChange={(e) =>
                              updateClip({ fit: e.target.value as Clip["fit"], fitExplicit: true })
                            }
                          >
                            <option value="cover">Fill frame</option>
                            <option value="contain">Fit inside</option>
                          </select>
                        </Field>
                        <div className="flip-controls">
                          {ck("flipX", clip.flipX)}
                          <button
                            className={clip.flipX ? "active" : ""}
                            title="Flip horizontal"
                            aria-label="Flip horizontal"
                            onClick={() => updateClip({ flipX: !clip.flipX })}
                          >
                            <FlipHorizontal2 size={17} />
                          </button>
                          {ck("flipY", clip.flipY)}
                          <button
                            className={clip.flipY ? "active" : ""}
                            title="Flip vertical"
                            aria-label="Flip vertical"
                            onClick={() => updateClip({ flipY: !clip.flipY })}
                          >
                            <FlipVertical2 size={17} />
                          </button>
                        </div>
                      </div>
                      {clip.keyframes.length > 0 && (
                        <p className="field-note">
                          {clip.keyframes.length} keyframes · adjustments add a
                          keyframe at the playhead. Motion eases between them.
                        </p>
                      )}
                    </Section>
                    <Section title="Crop">
                      <button type="button" className="button" onClick={() => setCropping(clip.id)}><Crop size={15} /> Crop media</button>
                      <button type="button" className="button" onClick={() => updateClip({ crop: { ...FULL_CROP } }, "crop-reset")}><RotateCcw size={14} /> Reset crop</button>
                      <p className="field-note">{Math.round(normalizeCrop(clip.crop).width * 100)}% × {Math.round(normalizeCrop(clip.crop).height * 100)}% of the source · non-destructive</p>
                    </Section>
                    <Section title="Incoming transition">
                      <Field label="Style">
                        <select
                          value={clip.transition}
                          onChange={(e) => {
                            if (!previousClip && e.target.value !== "None") return;
                            updateClip({ transition: e.target.value as Clip["transition"] });
                          }}
                        >
                          {TRANSITIONS.map((t) => (
                            <option key={t.name} disabled={!previousClip && t.name !== "None"}>{t.name}</option>
                          ))}
                        </select>
                      </Field>
                      {previousClip && (
                        <Range
                          label="Duration"
                          value={clip.transitionDuration}
                          min={1 / project.fps}
                          max={Math.min(3, clipDuration(clip), previousClip ? clipDuration(previousClip) : 3)}
                          step={1 / project.fps}
                          suffix="s"
                          onChange={(v) =>
                            updateClip({ transitionDuration: v })
                          }
                        />
                      )}
                      <p className="field-note">
                        {previousClip
                          ? "Set the duration, then choose a style. Both clips animate across the cut; source handles play through when available, otherwise the edge frame is held."
                          : "Place another visual clip immediately before this one on the same layer to add a transition."}
                      </p>
                    </Section>
                    <Section title={"Effects · " + clip.effects.length}>
                      {clip.effects.length === 0 ? (
                        <p className="field-note">
                          Add effects from the Effects library. Stack them and
                          tune each amount here.
                        </p>
                      ) : (
                        clip.effects.map((effect) => (
                          <div className="effect-control-wrap" key={effect.name}>
                            <div className="effect-control">
                              <Range
                                label={effect.name}
                                keyframe={keyButton(clip, `effect:${effect.name}`, effect.amount)}
                                value={effect.amount}
                                min={0}
                                max={100}
                                suffix="%"
                                onChange={(v) =>
                                  updateClip(
                                    {
                                      effects: clip.effects.map((e) =>
                                        e.name === effect.name
                                          ? { ...e, amount: v }
                                          : e,
                                      ),
                                    },
                                    effect.name,
                                  )
                                }
                              />
                              <button
                                title={"Remove " + effect.name}
                                aria-label={"Remove " + effect.name}
                                onClick={() =>
                                  updateClip(
                                    {
                                      effects: clip.effects.filter(
                                        (e) => e.name !== effect.name,
                                      ),
                                    },
                                    "",
                                  )
                                }
                              >
                                <X size={13} />
                              </button>
                            </div>
                            {effect.name === "Wavy" && <Range
                              label="Wave count"
                              value={effect.waves ?? 4}
                              min={1}
                              max={16}
                              step={1}
                              suffix=" waves"
                              onChange={(waves) => updateClip({ effects: clip.effects.map((e) => e.name === effect.name ? { ...e, waves } : e) }, `${effect.name}:waves`)}
                            />}
                          </div>
                        ))
                      )}
                    </Section>
                  </>
                )}
              </>
            )}
            {clip && activeTab === "Color" && (
              <Section
                title="Color adjustments"
                action={
                  <button
                    title="Reset color"
                    aria-label="Reset color"
                    onClick={() => edit((p) => ({ ...p, clips: p.clips.map((c) => {
                      if (c.id !== clip.id) return c;
                      const propertyKeyframes = { ...c.propertyKeyframes };
                      for (const name of ["brightness", "contrast", "saturation", "temperature", "filter"]) delete propertyKeyframes[name];
                      return { ...c, brightness: 100, contrast: 100, saturation: 100, temperature: 0, filter: "Original", propertyKeyframes };
                    }) }))}
                  >
                    <RotateCcw size={14} />
                  </button>
                }
              >
                <div className="current-look">
                  Look {ck("filter", clip.filter)} <span>{clip.filter}</span>
                </div>
                <Range
                  label="Brightness"
                  keyframe={ck("brightness", clip.brightness)}
                  value={clip.brightness}
                  min={0}
                  max={200}
                  onChange={(v) => updateClip({ brightness: v })}
                />
                <Range
                  label="Contrast"
                  keyframe={ck("contrast", clip.contrast)}
                  value={clip.contrast}
                  min={0}
                  max={200}
                  onChange={(v) => updateClip({ contrast: v })}
                />
                <Range
                  label="Saturation"
                  keyframe={ck("saturation", clip.saturation)}
                  value={clip.saturation}
                  min={0}
                  max={200}
                  onChange={(v) => updateClip({ saturation: v })}
                />
                <Range
                  label="Temperature"
                  keyframe={ck("temperature", clip.temperature)}
                  value={clip.temperature}
                  min={-100}
                  max={100}
                  onChange={(v) => updateClip({ temperature: v })}
                />
              </Section>
            )}
            {clip && activeTab === "Audio" && (
              <Section title="Audio">
                <Range
                  label="Volume"
                  keyframe={ck("volume", clip.volume)}
                  value={clip.volume * 100}
                  min={0}
                  max={200}
                  suffix="%"
                  onChange={(v) => updateClip({ volume: v / 100 })}
                />
                <Range
                  label="Fade in"
                  value={clip.fadeIn}
                  min={0}
                  max={Math.min(10, clipDuration(clip))}
                  step={0.1}
                  suffix="s"
                  onChange={(v) => updateClip({ fadeIn: v })}
                />
                <Range
                  label="Fade out"
                  value={clip.fadeOut}
                  min={0}
                  max={Math.min(10, clipDuration(clip))}
                  step={0.1}
                  suffix="s"
                  onChange={(v) => updateClip({ fadeOut: v })}
                />
                <p className="field-note">
                  Volume and fades are included in export. Muted and hidden
                  tracks stay silent.
                </p>
              </Section>
            )}
          </div>
        </>
      )}
      {clip && cropping === clip.id && project.assets.find((asset) => asset.id === clip.assetId) && <CropDialog key={clip.id} clip={clip} asset={project.assets.find((asset) => asset.id === clip.assetId)!} time={time} cancel={() => setCropping(null)} apply={(crop) => { updateClip({ crop, fit: "contain", fitExplicit: true }, "crop"); setCropping(null); }} />}
    </aside>
  );
}
const GRADIENT_PALETTES = [
  { name: "Mint", colors: ["#ffffff", "#80efc1"], angle: 0 },
  { name: "Sunset", colors: ["#ffd37d", "#f06aa6", "#8b6dff"], angle: 30 },
  { name: "Ocean", colors: ["#9cefff", "#4d87e7", "#9485f9"], angle: 0 },
  { name: "Gold", colors: ["#fff8ce", "#f5bd62", "#c67830"], angle: 90 },
] as const;
function TextFillControls({ text, onChange, onStopChange, onReplaceStops, keyframe }: {
  text: TextClip;
  onChange: (patch: Partial<TextClip>, group?: string) => void;
  onStopChange: (id: string, patch: Partial<Pick<GradientStop, "color" | "position">>) => void;
  onReplaceStops: (stops: GradientStop[]) => void;
  keyframe: (name: string, value: number | string | boolean) => ReactNode;
}) {
  const stops = normalizeGradientStops(text.gradientStops);
  const addStop = () => {
    if (stops.length >= 8) return;
    const gaps = stops.slice(0, -1).map((stop, index) => ({
      index, gap: stops[index + 1].position - stop.position,
    })).sort((a, b) => b.gap - a.gap);
    const index = gaps[0]?.index ?? 0;
    const first = stops[index], second = stops[index + 1];
    const midpoint = (first.position + second.position) / 2;
    const color = "#" + [1, 3, 5].map((offset) =>
      Math.round((parseInt(first.color.slice(offset, offset + 2), 16) +
        parseInt(second.color.slice(offset, offset + 2), 16)) / 2)
        .toString(16).padStart(2, "0")).join("");
    onReplaceStops([...stops, { id: crypto.randomUUID(), position: midpoint, color }]);
  };
  const ramp = `linear-gradient(90deg, ${stops.map((stop) =>
    `${stop.color} ${Math.round(stop.position * 100)}%`).join(", ")})`;
  return <Section title="Text fill">
    <div className="field-label gradient-fill-label">Fill type {keyframe("fillMode", text.fillMode)}</div>
    <div className="fill-mode-switch" role="group" aria-label="Text fill type">
      {(["solid", "linear", "radial"] as const).map((mode) =>
        <button type="button" key={mode} className={text.fillMode === mode ? "active" : ""}
          aria-pressed={text.fillMode === mode} onClick={() => onChange({ fillMode: mode })}>
          {mode === "solid" ? "Solid" : mode === "linear" ? "Linear" : "Radial"}
        </button>)}
    </div>
    {text.fillMode === "solid" ? <Color label="Text color" keyframe={keyframe("color", text.color)}
      value={text.color} onChange={(color) => onChange({ color })} /> : <>
      <div className="gradient-ramp" role="img" aria-label="Gradient color ramp" style={{ background: ramp }} />
      <p className="field-note gradient-help">Add up to eight stops. Colors blend across the whole text block, including multiple lines.</p>
      <div className="gradient-presets" aria-label="Gradient palettes">
        {GRADIENT_PALETTES.map((palette) => <button type="button" key={palette.name}
          onClick={() => {
            onReplaceStops(palette.colors.map((color, index) => ({
              id: `palette-${index}`, position: index / (palette.colors.length - 1), color,
            })));
            onChange({ gradientAngle: palette.angle });
          }}>
          <span style={{ background: `linear-gradient(90deg, ${palette.colors.join(", ")})` }} />{palette.name}
        </button>)}
      </div>
      {text.fillMode === "linear" ? <Range label="Angle" value={text.gradientAngle} min={0} max={360}
        suffix="°" keyframe={keyframe("gradientAngle", text.gradientAngle)}
        onChange={(gradientAngle) => onChange({ gradientAngle })} /> : <>
        <Range label="Center X" value={text.gradientCenterX * 100} min={0} max={100} suffix="%"
          keyframe={keyframe("gradientCenterX", text.gradientCenterX)}
          onChange={(value) => onChange({ gradientCenterX: value / 100 })} />
        <Range label="Center Y" value={text.gradientCenterY * 100} min={0} max={100} suffix="%"
          keyframe={keyframe("gradientCenterY", text.gradientCenterY)}
          onChange={(value) => onChange({ gradientCenterY: value / 100 })} />
        <Range label="Radius" value={text.gradientRadius * 100} min={10} max={200} suffix="%"
          keyframe={keyframe("gradientRadius", text.gradientRadius)}
          onChange={(value) => onChange({ gradientRadius: value / 100 })} />
      </>}
      <div className="gradient-stop-heading"><strong>Color stops</strong><div>
        <button type="button" onClick={() => onReplaceStops(stops.map((stop) => ({
          ...stop, position: 1 - stop.position,
        })))} title="Reverse gradient colors">Reverse</button>
        <button type="button" onClick={addStop} disabled={stops.length >= 8} title="Add color stop">
          <Plus size={13} /> Add
        </button>
      </div></div>
      <div className="gradient-stops">{stops.map((stop, index) => <GradientStopRow key={stop.id}
        stop={stop} index={index} removable={stops.length > 2}
        keyframe={keyframe} onChange={(patch) => onStopChange(stop.id, patch)}
        onRemove={() => onReplaceStops(stops.filter((item) => item.id !== stop.id))} />)}</div>
    </>}
  </Section>;
}
function GradientStopRow({ stop, index, removable, keyframe, onChange, onRemove }: {
  stop: GradientStop;
  index: number;
  removable: boolean;
  keyframe: (name: string, value: number | string | boolean) => ReactNode;
  onChange: (patch: Partial<Pick<GradientStop, "color" | "position">>) => void;
  onRemove: () => void;
}) {
  const [edit, setEdit] = useState<{ source: string; value: string } | null>(null);
  const draft = edit?.source === stop.color ? edit.value : stop.color.toUpperCase();
  const commit = () => {
    const value = draft.startsWith("#") ? draft : `#${draft}`;
    if (/^#[0-9a-f]{6}$/i.test(value)) onChange({ color: value.toLowerCase() });
    setEdit(null);
  };
  return <div className="gradient-stop-row">
    <div className="gradient-stop-title"><span>Stop {index + 1}</span>
      <button type="button" aria-label={`Remove stop ${index + 1}`} title="Remove stop"
        disabled={!removable} onClick={onRemove}><Trash2 size={13} /></button></div>
    <div className="gradient-stop-fields">
      <div className="gradient-stop-color">
        <span className="field-label">Color {keyframe(`gradientStop:${stop.id}:color`, stop.color)}</span>
        <div><input type="color" aria-label={`Stop ${index + 1} color`} value={stop.color}
          onChange={(event) => onChange({ color: event.target.value })} />
          <input type="text" aria-label={`Stop ${index + 1} hex color`} value={draft} maxLength={7}
            onChange={(event) => setEdit({ source: stop.color, value: event.target.value })} onBlur={commit}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></div>
      </div>
      <NumberField label="Position (%)" value={stop.position * 100} min={0} max={100} step={1}
        keyframe={keyframe(`gradientStop:${stop.id}:position`, stop.position)}
        onChange={(value) => onChange({ position: value / 100 })} />
    </div>
  </div>;
}
function AnimationTuner({ name, options, onChange }: {
  name: TextClip["animation"];
  options: TextAnimationOptions;
  onChange: (patch: TextAnimationOptions) => void;
}) {
  const directional = ["Rise", "Drop", "Slide", "Slide right", "Bounce", "Drift", "Custom"].includes(name);
  const scalable = ["Zoom", "Shrink", "Pop", "Elastic", "Custom"].includes(name);
  const zoomDirection = ["Zoom", "Shrink", "Custom"].includes(name);
  const angle = (((options.angle ?? 0) % 360) + 360) % 360;
  return <div className="animation-tuner">
    {directional && <>
      <div className="animation-directions" role="group" aria-label="Motion direction">
        {([["Right", 0, "→"], ["Down", 90, "↓"], ["Left", 180, "←"], ["Up", 270, "↑"]] as const).map(([label, value, icon]) =>
          <button key={label} type="button" aria-label={`Move ${label.toLowerCase()}`} className={Math.abs(angle - value) < 0.01 ? "active" : ""} onClick={() => onChange({ angle: value })}>{icon}</button>)}
      </div>
      <Range label="Direction" value={angle} min={0} max={360} suffix="°" onChange={(value) => onChange({ angle: value })} />
      <Range label="Distance" value={(options.distance ?? 0) * 100} min={0} max={100} suffix="%" onChange={(value) => onChange({ distance: value / 100 })} />
    </>}
    {scalable && <>
      {zoomDirection && <div className="animation-zoom-choice" role="group" aria-label="Zoom direction">
        <button type="button" className={options.zoomDirection !== "out" ? "active" : ""} onClick={() => onChange({ zoomDirection: "in" })}>Zoom in</button>
        <button type="button" className={options.zoomDirection === "out" ? "active" : ""} onClick={() => onChange({ zoomDirection: "out" })}>Zoom out</button>
      </div>}
      <Range label={zoomDirection ? "Zoom strength" : "Scale strength"} value={(options.zoomAmount ?? 0) * 100} min={0} max={zoomDirection && options.zoomDirection !== "out" ? 200 : 95} suffix="%" onChange={(value) => onChange({ zoomAmount: value / 100 })} />
    </>}
    <Range label="Rotation" value={options.rotation ?? 0} min={-360} max={360} suffix="°" onChange={(value) => onChange({ rotation: value })} />
    <Range label="Blur" value={(options.blur ?? 0) * 100} min={0} max={10} step={0.1} suffix="%" onChange={(value) => onChange({ blur: value / 100 })} />
    {!(["Typewriter", "Letter Pop In", "Wipe left", "Wipe right", "Wipe up", "Wipe down"].includes(name)) &&
      <Toggle label="Fade in / disappear" value={options.fade !== false} onChange={(value) => onChange({ fade: value })} />}
    <Field label="Easing">
      <select value={options.easing ?? "ease-out"} onChange={(event) => onChange({ easing: event.target.value as TextAnimationOptions["easing"] })}>
        <option value="ease-out">Ease out</option><option value="ease-in-out">Ease in & out</option>
        <option value="ease-in">Ease in</option><option value="linear">Linear</option>
      </select>
    </Field>
  </div>;
}
function applyPatch<T extends Clip | TextClip>(item: T, patch: Partial<T>, time: number, fps: number): T {
  let next = { ...item };
  for (const [name, value] of Object.entries(patch)) {
    if (name === "effects" && Array.isArray(value)) {
      const incoming = value as Clip["effects"];
      next.effects = incoming.map((effect) => {
        const track = `effect:${effect.name}`;
        if (!item.propertyKeyframes?.[track]?.length) return effect;
        next = setPropertyKeyframe(next, track, time - item.start, effect.amount, fps);
        return item.effects.find((old) => old.name === effect.name) ?? effect;
      });
    } else if ((typeof value === "number" || typeof value === "string" || typeof value === "boolean") && item.propertyKeyframes?.[name]?.length) {
      next = setPropertyKeyframe(next, name, time - item.start, value, fps);
    } else {
      (next as unknown as Record<string, unknown>)[name] = value;
    }
  }
  return next;
}
function EffectsControls({
  effects,
  onChange,
  keyframe,
}: {
  effects: Clip["effects"];
  onChange: (effects: Clip["effects"], group: string) => void;
  keyframe?: (name: string, amount: number) => ReactNode;
}) {
  return (
    <Section title={"Effects · " + effects.length}>
      {!effects.length && (
        <p className="field-note">
          Add effects from the Effects library. They apply only to this text
          clip, including its outline and background.
        </p>
      )}
      {effects.map((effect) => (
        <div className="effect-control-wrap" key={effect.name}>
          <div className="effect-control">
            <Range
              label={effect.name}
              keyframe={keyframe?.(effect.name, effect.amount)}
              value={effect.amount}
              min={0}
              max={100}
              suffix="%"
              onChange={(amount) =>
                onChange(
                  effects.map((e) =>
                    e.name === effect.name ? { ...e, amount } : e,
                  ),
                  effect.name,
                )
              }
            />
            <button
              title={"Remove " + effect.name}
              aria-label={"Remove " + effect.name}
              onClick={() =>
                onChange(
                  effects.filter((e) => e.name !== effect.name),
                  "",
                )
              }
            >
              <X size={13} />
            </button>
          </div>
          {effect.name === "Wavy" && <Range
            label="Wave count"
            value={effect.waves ?? 4}
            min={1}
            max={16}
            step={1}
            suffix=" waves"
            onChange={(waves) => onChange(effects.map((e) => e.name === effect.name ? { ...e, waves } : e), `${effect.name}:waves`)}
          />}
        </div>
      ))}
    </Section>
  );
}
function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="inspector-section">
      <div className="section-heading">
        <h3>{title}</h3>
        {action ?? <ChevronDown size={13} />}
      </div>
      {children}
    </section>
  );
}
export function Field({
  label,
  children,
  keyframe,
}: {
  label: string;
  children: ReactNode;
  keyframe?: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}{keyframe}</span>
      {children}
    </label>
  );
}
function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  keyframe,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  keyframe?: ReactNode;
}) {
  return (
    <Field label={label} keyframe={keyframe}>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={Math.round(value * 1000) / 1000}
        onChange={(e) => {
          if (e.target.value !== "") onChange(clamp(+e.target.value, min, max));
        }}
      />
    </Field>
  );
}
function Range({
  label,
  value,
  min,
  max,
  step = 1,
  suffix = "",
  onChange,
  keyframe,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (v: number) => void;
  keyframe?: ReactNode;
}) {
  return (
    <div className="range-field">
      <div>
        <label>{label}{keyframe}</label>
        <span>
          <input
            aria-label={label + " value"}
            type="number"
            value={Math.round(value * 100) / 100}
            min={min}
            max={max}
            step={step}
            onChange={(e) => {
              if (e.target.value !== "")
                onChange(clamp(+e.target.value, min, max));
            }}
          />
          {suffix}
        </span>
      </div>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(+e.target.value)}
        style={
          {
            "--range-fill":
              ((value - min) / Math.max(0.000001, max - min)) * 100 + "%",
          } as React.CSSProperties
        }
      />
    </div>
  );
}
function Color({
  label,
  value,
  onChange,
  keyframe,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  keyframe?: ReactNode;
}) {
  return (
    <label className="color-field">
      <span className="field-label">{label}{keyframe}</span>
      <div>
        <input
          type="color"
          aria-label={label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <span>{value.toUpperCase()}</span>
      </div>
    </label>
  );
}
function Toggle({
  label,
  value,
  onChange,
  keyframe,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  keyframe?: ReactNode;
}) {
  return (
    <label className="toggle-field">
      <span className="field-label">{label}{keyframe}</span>
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="switch" />
    </label>
  );
}
