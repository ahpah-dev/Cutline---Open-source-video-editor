import { clamp, clipDuration, type AnimationLayer, type AnimationName, type Clip, type ComboAnimation, type TextAnimationOptions, type TextClip } from "./model";
import { easeAnimation, isTextSequenceAnimation, layerProgress, sequenceDefaults, type TextSequenceLayer } from "./textSequence";
import { sanitizeAnimationSettings } from "./customAnimationPresets";
type AnimationTarget = Clip | TextClip;
const durationOf = (item: AnimationTarget) => "sourceEnd" in item ? clipDuration(item) : item.duration;
export function letterPopProgress(progress: number, index: number, count: number) {
  return clamp((clamp(progress, 0, 1) * (count + 1) - index) / 2, 0, 1);
}

export type TextMotion = {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  opacity: number;
  blur: number;
  characters: number;
  letterPop: number;
  sequences: TextSequenceLayer[];
  reveals: { direction: string; amount: number }[];
};
export function animationLayers(t: AnimationTarget, phase: "Entrance" | "Exit"): AnimationLayer[] {
  const stack = phase === "Entrance" ? t.animationStack : t.exitAnimationStack;
  if (Array.isArray(stack)) return stack.filter((layer) => layer && layer.name !== "None");
  const name = phase === "Entrance" ? t.animation : (t.exitAnimation ?? (t.fadeOut > 0 ? "Fade" : "None"));
  if (!name || name === "None") return [];
  return [{ name, settings: (phase === "Entrance" ? t.animationSettings : t.exitAnimationSettings) ?? {} }];
}
export function defaultAnimationSettings(name: AnimationName, phase: "Entrance" | "Exit"): TextAnimationOptions {
  if (isTextSequenceAnimation(name)) return { ...sequenceDefaults(name), zoomDirection: phase === "Exit" ? "out" : "in", delay: 0, span: 1 };
  const exiting = phase === "Exit";
  const angle = name === "Rise" || name === "Bounce" ? (exiting ? 270 : 90)
    : name === "Drop" ? (exiting ? 90 : 270)
    : name === "Slide" ? 180
    : name === "Slide right" ? 0
    : name === "Drift" ? (exiting ? 322 : 142) : 270;
  const distance = name === "Drift" ? 0.057
    : name === "Slide" || name === "Slide right" ? 0.15
    : name === "Bounce" ? 0.15
    : name === "Rise" || name === "Drop" ? 0.1 : 0.08;
  return {
    angle, distance,
    zoomDirection: name === "Shrink" ? (exiting ? "out" : "out") : "in",
    zoomAmount: name === "Zoom" ? (exiting ? 0.9 : 0.7) : name === "Shrink" ? (exiting ? 0.85 : 0.9) : name === "Pop" ? 0.55 : name === "Elastic" ? 0.8 : 0,
    rotation: name === "Spin" ? (exiting ? 160 : -160) : 0,
    blur: name === "Blur" ? 0.018 : 0,
    fade: name !== "Typewriter" && name !== "Letter Pop In" && !name.startsWith("Wipe"),
    easing: "ease-out",
  };
}
export function textAnimationTiming(t: AnimationTarget) {
  const exit = t.exitAnimation ?? (t.fadeOut > 0 ? "Fade" : "None");
  let entranceDuration = animationLayers(t, "Entrance").length ? clamp(t.animationDuration ?? 0.5, 0, 36000) : 0;
  let exitDuration = animationLayers(t, "Exit").length ? clamp(t.exitAnimationDuration ?? t.fadeOut, 0, 36000) : 0;
  // Short clips still get BOTH animations, without running them over one another.
  const total = entranceDuration + exitDuration;
  const duration = durationOf(t);
  if (total > duration) {
    entranceDuration *= duration / total;
    exitDuration *= duration / total;
  }
  return { entranceDuration, exitDuration, exit };
}
const bounceOut = (p: number) => {
  const n = 7.5625,
    d = 2.75;
  if (p < 1 / d) return n * p * p;
  if (p < 2 / d) return n * (p -= 1.5 / d) * p + 0.75;
  if (p < 2.5 / d) return n * (p -= 2.25 / d) * p + 0.9375;
  return n * (p -= 2.625 / d) * p + 0.984375;
};
function pose(
  name: AnimationName,
  progress: number,
  exiting: boolean,
  options: TextAnimationOptions = {},
  textTarget = false,
): TextMotion {
  const p = clamp(progress, 0, 1),
    ease = easeAnimation(p, options.easing),
    hidden = 1 - ease;
  const drift = (angle: number, distance: number) => ({
    x: Math.cos(angle * Math.PI / 180) * distance * hidden,
    y: Math.sin(angle * Math.PI / 180) * distance * hidden,
  });
  const zoom = (amount: number, direction: "in" | "out") => {
    const smaller = exiting ? direction === "out" : direction === "in";
    return Math.max(0.02, 1 + (smaller ? -1 : 1) * amount * hidden);
  };
  const m: TextMotion = {
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    opacity: 1,
    blur: 0,
    characters: 1,
    letterPop: 1,
    sequences: [],
    reveals: [],
  };
  if (name === "None") return m;
  if (textTarget && isTextSequenceAnimation(name)) {
    m.sequences = [{ name, progress: p, exiting, settings: { ...sequenceDefaults(name), zoomDirection: exiting ? "out" : "in", ...options } }];
    if (name === "Typewriter") m.characters = p;
    if (name === "Letter Pop In") m.letterPop = p;
    return m;
  }
  m.opacity = options.fade === false ? 1 : clamp(options.easing ? ease : p, 0, 1);
  switch (name) {
    case "Rise":
      Object.assign(m, drift(options.angle ?? (exiting ? 270 : 90), options.distance ?? 0.1));
      break;
    case "Drop":
      Object.assign(m, drift(options.angle ?? (exiting ? 90 : 270), options.distance ?? 0.1));
      break;
    case "Slide":
      Object.assign(m, drift(options.angle ?? 180, options.distance ?? 0.15));
      break;
    case "Slide right":
      Object.assign(m, drift(options.angle ?? 0, options.distance ?? 0.15));
      break;
    case "Pop":
      m.scaleX = m.scaleY = 1 - (options.zoomAmount ?? 0.55) * hidden + Math.sin(p * Math.PI) * 0.12;
      break;
    case "Zoom":
      m.scaleX = m.scaleY = zoom(options.zoomAmount ?? (exiting ? 0.9 : 0.7), options.zoomDirection ?? "in");
      break;
    case "Shrink":
      m.scaleX = m.scaleY = options.zoomDirection
        ? zoom(options.zoomAmount ?? 0.9, options.zoomDirection)
        : exiting ? 0.15 + ease * 0.85 : 1 + hidden * 0.9;
      break;
    case "Spin":
      m.rotation = (options.rotation ?? ((exiting ? 1 : -1) * 160)) * hidden;
      m.scaleX = m.scaleY = 0.5 + ease * 0.5;
      break;
    case "Flip":
      m.scaleX = Math.max(0.001, Math.cos((hidden * Math.PI) / 2));
      break;
    case "Bounce":
      if (options.angle !== undefined || options.distance !== undefined) {
        const amplitude = 1 - bounceOut(options.easing ? ease : p);
        const angle = (options.angle ?? (exiting ? 270 : 90)) * Math.PI / 180;
        m.x = Math.cos(angle) * (options.distance ?? 0.15) * amplitude;
        m.y = Math.sin(angle) * (options.distance ?? 0.15) * amplitude;
      } else m.y = (exiting ? -1 : 1) * 0.15 * (1 - bounceOut(options.easing ? ease : p));
      break;
    case "Elastic": {
      const spring =
        p === 0 || p === 1
          ? p
          : 2 ** (-10 * p) * Math.sin(((p * 10 - 0.75) * 2 * Math.PI) / 3) + 1;
      m.scaleX = m.scaleY = Math.max(0.001, 1 - (options.zoomAmount ?? 0.8) * (1 - spring));
      break;
    }
    case "Blur":
      m.blur = hidden * (options.blur ?? 0.018);
      break;
    case "Typewriter":
      m.characters = clamp(options.easing ? ease : p, 0, 1);
      m.opacity = 1;
      break;
    case "Letter Pop In":
      m.letterPop = ease;
      m.opacity = 1;
      break;
    case "Wipe left":
    case "Wipe right":
    case "Wipe up":
    case "Wipe down":
      m.reveals = [{ direction: name, amount: ease }];
      m.opacity = 1;
      break;
    case "Drift":
      if (options.angle !== undefined || options.distance !== undefined)
        Object.assign(m, drift(options.angle ?? (exiting ? 322 : 142), options.distance ?? 0.057));
      else {
        m.x = (exiting ? 1 : -1) * 0.045 * hidden;
        m.y = (exiting ? -1 : 1) * 0.035 * hidden;
      }
      break;
    case "Custom":
      Object.assign(m, drift(options.angle ?? 270, options.distance ?? 0.08));
      m.scaleX = m.scaleY = zoom(options.zoomAmount ?? 0, options.zoomDirection ?? "in");
      m.rotation = (options.rotation ?? 0) * hidden;
      m.blur = (options.blur ?? 0) * hidden;
      break;
  }
  if (name !== "Custom") {
    if (options.rotation !== undefined && name !== "Spin") m.rotation = options.rotation * hidden;
    if (options.blur !== undefined && name !== "Blur") m.blur = options.blur * hidden;
  }
  return m;
}
export function textMotion(t: AnimationTarget, time: number, includeItemOpacity = true): TextMotion {
  const local = time - t.start;
  const duration = durationOf(t);
  const { entranceDuration, exitDuration } = textAnimationTiming(t);
  const entering = entranceDuration > 0 && local < entranceDuration;
  const leaving = exitDuration > 0 && local >= duration - exitDuration;
  const phase = entering ? "Entrance" : leaving ? "Exit" : null;
  const progress = entering ? local / entranceDuration : leaving ? (duration - local) / exitDuration : 1;
  const m = pose("None", 1, false);
  if (phase) for (const layer of animationLayers(t, phase)) {
    const settings = sanitizeAnimationSettings(layer.settings);
    const part = pose(layer.name, layerProgress(progress, phase === "Exit", settings), phase === "Exit", settings, "text" in t);
    m.x += part.x;
    m.y += part.y;
    m.scaleX *= part.scaleX;
    m.scaleY *= part.scaleY;
    m.rotation += part.rotation;
    m.opacity *= part.opacity;
    m.blur += part.blur;
    m.characters = Math.min(m.characters, part.characters);
    m.letterPop = Math.min(m.letterPop, part.letterPop);
    m.sequences.push(...part.sequences);
    m.reveals.push(...part.reveals);
  }
  const combo = comboMotion(t, time);
  m.x += combo.x;
  m.y += combo.y;
  m.scaleX *= combo.scaleX;
  m.scaleY *= combo.scaleY;
  m.rotation += combo.rotation;
  m.opacity *= combo.opacity;
  m.blur += combo.blur;
  m.characters = Math.min(m.characters, combo.characters);
  m.reveals.push(...combo.reveals);
  if (includeItemOpacity) m.opacity *= t.opacity;
  if (local < 0 || local >= duration) m.opacity = 0;
  return m;
}

export function comboMotion(t: AnimationTarget, time: number): TextMotion {
  const motion = pose("None", 1, false);
  const local = time - t.start;
  if (local < 0 || local >= durationOf(t)) return motion;
  for (const animation of t.comboAnimations ?? []) {
    const layer = animation as ComboAnimation;
    const amount = clamp(layer.amount, 0, 100) / 100;
    const cycle = local * Math.PI * 2 * clamp(layer.speed, 0.1, 4);
    const wave = Math.sin(cycle);
    switch (layer.name) {
      case "Zoom": {
        const scale = 1 + wave * 0.16 * amount;
        motion.scaleX *= scale;
        motion.scaleY *= scale;
        break;
      }
      case "Wave":
        motion.x += Math.sin(cycle) * 0.035 * amount;
        motion.y += Math.sin(cycle * 2 + Math.PI / 3) * 0.035 * amount;
        motion.rotation += wave * 7 * amount;
        break;
      case "Pulse": {
        const scale = 1 + Math.max(0, wave) * 0.14 * amount;
        motion.scaleX *= scale;
        motion.scaleY *= scale;
        break;
      }
      case "Float":
        motion.y += wave * 0.055 * amount;
        motion.x += Math.cos(cycle) * 0.012 * amount;
        break;
      case "Rock":
        motion.rotation += wave * 12 * amount;
        break;
      case "Shake":
        motion.x += Math.sin(cycle * 7) * 0.012 * amount;
        motion.y += Math.cos(cycle * 9) * 0.009 * amount;
        motion.rotation += Math.sin(cycle * 6) * 2.5 * amount;
        break;
      case "Heartbeat": {
        const beat = Math.max(0, wave);
        const afterbeat = Math.max(0, Math.sin(cycle * 2 - 0.9));
        const scale = 1 + (beat * beat + afterbeat * afterbeat * 0.55) * 0.16 * amount;
        motion.scaleX *= scale;
        motion.scaleY *= scale;
        break;
      }
      case "Spin":
        motion.rotation += local * 360 * clamp(layer.speed, 0.1, 4) * amount;
        break;
      case "Breathe": {
        const scale = 1 + wave * 0.09 * amount;
        motion.scaleX *= scale;
        motion.scaleY *= scale;
        break;
      }
      case "Jelly":
        motion.scaleX *= 1 + wave * 0.13 * amount;
        motion.scaleY *= 1 - wave * 0.13 * amount;
        motion.rotation += Math.sin(cycle * 2) * 4 * amount;
        break;
    }
  }
  return motion;
}
