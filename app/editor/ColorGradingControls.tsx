import { useEffect, useId, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { ChevronDown, RotateCcw, Trash2 } from "lucide-react";
import { clamp, type Clip } from "./model";
import { CURVE_CHANNELS, curveValue, GRADE_RANGES, identityCurves, normalizeGrade,
  type ColorCurves, type CurveChannel, type CurvePoint, type GradeProperty } from "./colorGrading";

type Props = { clip: Clip; onChange: (patch: Partial<Clip>, group?: string) => void;
  keyframe: (name: string, value: number | string | boolean) => ReactNode; reset: () => void };
export function ColorGradingControls({ clip, onChange, keyframe, reset }: Props) {
  const [page, setPage] = useState<"Balance" | "Wheels" | "Curves">("Balance");
  const grade = normalizeGrade(clip), enabledId = useId();
  const slider = (name: GradeProperty, label: string, step = 1, suffix = "") => <GradeSlider key={name}
    label={label} value={grade[name]} min={GRADE_RANGES[name][0]} max={GRADE_RANGES[name][1]} step={step} suffix={suffix}
    keyframe={keyframe(name, grade[name])} onChange={(value) => onChange({ [name]: value })} />;
  return <div className="grading-controls">
    <div className="grading-heading"><div><h3>Color grading</h3></div>
      <button type="button" className="icon-button" aria-label="Reset color" title="Reset grading and color automation" onClick={reset}><RotateCcw size={15} /></button></div>
    <div className="grade-status"><label htmlFor={enabledId}><input id={enabledId} type="checkbox" checked={grade.gradingEnabled}
      onChange={(e) => onChange({ gradingEnabled: e.target.checked })} />Apply color grade</label>{keyframe("gradingEnabled", grade.gradingEnabled)}
      <span>{grade.gradingEnabled ? "On" : "Bypassed"}</span></div>
    <div className="grade-look"><span>Current look {keyframe("filter", clip.filter)}</span><strong>{clip.filter}</strong></div>
    <div className="grade-pages" role="group" aria-label="Color grading tools">{(["Balance", "Wheels", "Curves"] as const).map((name) => <button type="button" key={name} aria-pressed={page === name} onClick={() => setPage(name)}>{name}</button>)}</div>
    {page === "Balance" && <>
    <details className="grade-section" open><summary><span>Light & balance</span><ChevronDown size={13} /></summary><div className="grade-section-body">
      {slider("exposure", "Exposure", .05, " EV")}
      <GradeSlider label="Brightness" value={clip.brightness} min={0} max={200} suffix="%" keyframe={keyframe("brightness", clip.brightness)} onChange={(v) => onChange({ brightness: v })} />
      <GradeSlider label="Contrast" value={clip.contrast} min={0} max={200} suffix="%" keyframe={keyframe("contrast", clip.contrast)} onChange={(v) => onChange({ contrast: v })} />
      <GradeSlider label="Temperature" value={clip.temperature} min={-100} max={100} keyframe={keyframe("temperature", clip.temperature)} onChange={(v) => onChange({ temperature: v })} />
      {slider("tint", "Tint · green / magenta")}
    </div></details>
    <details className="grade-section"><summary><span>Tonal range</span><ChevronDown size={13} /></summary><div className="grade-section-body">
      {slider("highlights", "Highlights")}{slider("shadows", "Shadows")}{slider("whites", "Whites")}{slider("blacks", "Blacks")}
    </div></details>
    <details className="grade-section" open><summary><span>Color</span><ChevronDown size={13} /></summary><div className="grade-section-body">
      <GradeSlider label="Saturation" value={clip.saturation} min={0} max={200} suffix="%" keyframe={keyframe("saturation", clip.saturation)} onChange={(v) => onChange({ saturation: v })} />
      {slider("vibrance", "Vibrance")}{slider("hue", "Hue rotation", 1, "°")}
    </div></details>
    </>}
    {page === "Wheels" && <details className="grade-section" open><summary><span>Color wheels</span><ChevronDown size={13} /></summary><div className="grade-section-body">
      <div className="color-wheel-grid">{(["shadow", "midtone", "highlight"] as const).map((tone) => <ColorWheel key={tone}
        label={tone === "shadow" ? "Shadows" : tone === "midtone" ? "Midtones" : "Highlights"}
        hue={grade[`${tone}Hue`]} strength={grade[`${tone}Strength`]}
        onChange={(hue, strength) => onChange({ [`${tone}Hue`]: hue, [`${tone}Strength`]: strength }, `${tone}wheel`)} />)}</div>
      {(["shadow", "midtone", "highlight"] as const).map((tone) => <details className="wheel-values" key={tone}><summary>{tone === "shadow" ? "Shadows" : tone === "midtone" ? "Midtones" : "Highlights"} · precise controls<ChevronDown size={12} /></summary>
        {slider(`${tone}Hue`, "Hue", 1, "°")}{slider(`${tone}Strength`, "Strength", 1, "%")}{slider(`${tone}Luma`, "Luminance")}</details>)}
    </div></details>}
    {page === "Curves" && <details className="grade-section" open><summary><span>RGB curves</span><ChevronDown size={13} /></summary><div className="grade-section-body">
      <CurveEditor curves={grade.colorCurves} onChange={(colorCurves) => onChange({ colorCurves }, "colorCurves")} />
    </div></details>}
    <details className="grade-section" open><summary><span>Viewer scopes</span><ChevronDown size={13} /></summary><div className="grade-section-body"><ViewerScopes /></div></details>
    <p className="field-note grade-footnote">Display-referred, 8-bit sRGB / Rec.709. Color runs after chroma key, before effects. Curves are clip-wide; scalar controls support keyframes.</p>
  </div>;
}
export function GradeSlider({ label, value, min, max, step = 1, suffix = "", onChange, keyframe }: {
  label: string; value: number; min: number; max: number; step?: number; suffix?: string;
  onChange: (v: number) => void; keyframe?: ReactNode;
}) {
  const id = useId(), percent = (value - min) / (max - min) * 100;
  return <div className="grade-slider"><div className="grade-slider-heading"><label htmlFor={id}>{label}</label>{keyframe}
    <div className="grade-value"><input type="number" aria-label={`${label} value`} min={min} max={max} step={step} value={Number(value.toFixed(3))}
      onChange={(e) => { if (e.target.value !== "") onChange(clamp(Number(e.target.value), min, max)); }} /><span>{suffix}</span></div></div>
    <input id={id} type="range" min={min} max={max} step={step} value={value} aria-label={label} style={{ background: `linear-gradient(to right, var(--mint) ${percent}%, #353c40 ${percent}%)` }} onChange={(e) => onChange(Number(e.target.value))} />
  </div>;
}
function ColorWheel({ label, hue, strength, onChange }: { label: string; hue: number; strength: number; onChange: (hue: number, strength: number) => void }) {
  const [dragging, setDragging] = useState(false);
  const original = useRef({ hue, strength });
  const change = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect(), dx = (e.clientX - rect.left) / rect.width - .5, dy = (e.clientY - rect.top) / rect.height - .5;
    onChange(Math.hypot(dx, dy) < .015 ? hue : (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360, Math.min(100, Math.hypot(dx, dy) * 200));
  };
  return <div className="color-wheel"><span>{label}</span><div className="color-wheel-disc" role="slider" tabIndex={0} aria-label={`${label} color wheel`}
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(strength)} aria-valuetext={`${Math.round(hue)} degrees, ${Math.round(strength)} percent strength`}
    onPointerDown={(e) => { if (e.button !== 0) return; e.preventDefault(); original.current = { hue, strength }; e.currentTarget.setPointerCapture(e.pointerId); setDragging(true); change(e); }}
    onPointerMove={(e) => { if (dragging) change(e); }} onPointerUp={() => setDragging(false)}
    onPointerCancel={() => { onChange(original.current.hue, original.current.strength); setDragging(false); }}
    onDoubleClick={() => onChange(hue, 0)} onKeyDown={(e) => {
      if (!e.ctrlKey && !e.metaKey && !e.altKey && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home"].includes(e.key)) { e.preventDefault(); e.stopPropagation();
        onChange((hue + (e.key === "ArrowLeft" ? -5 : e.key === "ArrowRight" ? 5 : 0) + 360) % 360,
          e.key === "Home" ? 0 : clamp(strength + (e.key === "ArrowUp" ? 2 : e.key === "ArrowDown" ? -2 : 0), 0, 100)); }
    }}><i style={{ left: `${50 + Math.cos(hue * Math.PI / 180) * strength * .45}%`, top: `${50 + Math.sin(hue * Math.PI / 180) * strength * .45}%` }} /></div><small>{Math.round(strength)}%</small></div>;
}
const CHANNEL_COLORS = { master: "#d3e2e0", red: "#ee8e89", green: "#a1d5a5", blue: "#8bb9ee" };
function CurveEditor({ curves, onChange }: { curves: ColorCurves; onChange: (curves: ColorCurves) => void }) {
  const [channel, setChannel] = useState<CurveChannel>("master"), [selection, setSelection] = useState(0);
  const drag = useRef<{ index: number; curves: ColorCurves } | null>(null), svg = useRef<SVGSVGElement>(null);
  const points = curves[channel], index = Math.min(selection, points.length - 1), selected = points[index];
  const position = (e: PointerEvent<SVGElement>) => {
    const rect = svg.current!.getBoundingClientRect(); return { x: clamp((e.clientX - rect.left) / rect.width, 0, 1), y: clamp(1 - (e.clientY - rect.top) / rect.height, 0, 1) };
  };
  const update = (i: number, patch: Partial<CurvePoint>) => {
    const next = points.map((point, at) => at === i ? { x: i === 0 ? 0 : i === points.length - 1 ? 1 : clamp(patch.x ?? point.x, points[i - 1].x + .005, points[i + 1].x - .005), y: clamp(patch.y ?? point.y, 0, 1) } : point);
    onChange({ ...curves, [channel]: next });
  };
  const path = Array.from({ length: 101 }, (_, i) => `${i ? "L" : "M"}${i},${100 - curveValue(points, i / 100) * 100}`).join(" ");
  return <div className="curve-editor"><div className="curve-channels" role="group" aria-label="Curve channel">{CURVE_CHANNELS.map((name) => <button type="button" key={name} aria-pressed={name === channel}
    style={{ "--curve-color": CHANNEL_COLORS[name] } as React.CSSProperties} onClick={() => { setChannel(name); setSelection(0); }}>{name === "master" ? "RGB" : name.charAt(0).toUpperCase()}</button>)}
    <button type="button" className="curve-reset" aria-label={`Reset ${channel} curve`} onClick={() => { onChange({ ...curves, [channel]: identityCurves()[channel] }); setSelection(0); }}><RotateCcw size={12} /></button></div>
    <svg ref={svg} viewBox="0 0 100 100" preserveAspectRatio="none" className="curve-graph" role="img" aria-label={`${channel} tone curve; click to add a control point`}
      onPointerDown={(e) => {
        if (e.button !== 0 || e.target !== e.currentTarget || points.length >= 12) return;
        const point = position(e); if (point.x <= .005 || point.x >= .995 || points.some((p) => Math.abs(p.x - point.x) < .01)) return;
        const next = [...points, point].sort((a, b) => a.x - b.x), at = next.indexOf(point);
        drag.current = { index: at, curves }; setSelection(at); onChange({ ...curves, [channel]: next }); e.currentTarget.setPointerCapture(e.pointerId);
      }} onPointerMove={(e) => { if (drag.current) update(drag.current.index, position(e)); }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { if (drag.current) onChange(drag.current.curves); drag.current = null; }}>
      <path d="M25 0V100M50 0V100M75 0V100M0 25H100M0 50H100M0 75H100" className="curve-grid" pointerEvents="none" />
      <path d="M0 100L100 0" className="curve-diagonal" pointerEvents="none" />
      <path d={path} fill="none" stroke={CHANNEL_COLORS[channel]} strokeWidth="1.1" pointerEvents="none" />
      {points.map((point, i) => <circle key={i} cx={point.x * 100} cy={100 - point.y * 100} r={index === i ? 2.4 : 1.8} className={index === i ? "selected" : ""}
        onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); drag.current = { index: i, curves }; setSelection(i); svg.current!.setPointerCapture(e.pointerId); }} />)}
    </svg>
    <div className="curve-point-fields"><label>Point<select aria-label="Selected curve point" value={index} onChange={(e) => setSelection(Number(e.target.value))}>{points.map((_, i) => <option key={i} value={i}>{i + 1}</option>)}</select></label>
      <label>Input<input aria-label="Curve input" type="number" min={0} max={100} step={.1} disabled={index === 0 || index === points.length - 1} value={Number((selected.x * 100).toFixed(1))} onChange={(e) => { if (e.target.value !== "") update(index, { x: Number(e.target.value) / 100 }); }} /></label>
      <label>Output<input aria-label="Curve output" type="number" min={0} max={100} step={.1} value={Number((selected.y * 100).toFixed(1))} onChange={(e) => { if (e.target.value !== "") update(index, { y: Number(e.target.value) / 100 }); }} /></label>
      <button type="button" aria-label="Delete curve point" disabled={index === 0 || index === points.length - 1} onClick={() => { onChange({ ...curves, [channel]: points.filter((_, i) => i !== index) }); setSelection(Math.max(0, index - 1)); }}><Trash2 size={13} /></button></div>
    <p className="field-note">Click to add · drag to shape. Use the fields for precise or keyboard editing.</p></div>;
}
function ViewerScopes() {
  const canvas = useRef<HTMLCanvasElement>(null), [mode, setMode] = useState<"luma" | "rgb">("luma");
  useEffect(() => {
    const sampling = document.createElement("canvas"); sampling.width = 160; sampling.height = 90;
    const sample = sampling.getContext("2d", { willReadFrequently: true })!, context = canvas.current!.getContext("2d")!;
    let visible = true;
    const observer = typeof IntersectionObserver !== "undefined" ? new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; }) : null;
    observer?.observe(canvas.current!);
    const draw = () => {
      if (!visible || !canvas.current?.getBoundingClientRect().height) return;
      const preview = document.querySelector<HTMLCanvasElement>(".preview-panel canvas"); if (!preview || !preview.width) return;
      sample.clearRect(0, 0, 160, 90); sample.drawImage(preview, 0, 0, 160, 90);
      let pixels: Uint8ClampedArray; try { pixels = sample.getImageData(0, 0, 160, 90).data; } catch { return; }
      const bins = [new Uint32Array(64), new Uint32Array(64), new Uint32Array(64)];
      for (let i = 0; i < pixels.length; i += 4) {
        if (mode === "luma") bins[0][Math.min(63, Math.floor((pixels[i] * .2126 + pixels[i + 1] * .7152 + pixels[i + 2] * .0722) / 4))]++;
        else for (let c = 0; c < 3; c++) bins[c][Math.min(63, pixels[i + c] >> 2)]++;
      }
      context.clearRect(0, 0, 256, 84); context.strokeStyle = "#333d40"; context.lineWidth = 1;
      for (let i = 1; i < 4; i++) { context.beginPath(); context.moveTo(i * 64, 0); context.lineTo(i * 64, 84); context.stroke(); }
      const peak = Math.max(1, ...bins.flatMap((bin) => [...bin])), colors = mode === "luma" ? ["#a8cfc4"] : ["#e68786", "#91c49e", "#86ace0"];
      colors.forEach((color, c) => { context.beginPath(); context.moveTo(0, 84);
        for (let x = 0; x < 64; x++) context.lineTo(x * 4, 83 - Math.sqrt(bins[c][x] / peak) * 78);
        context.lineTo(256, 84); context.closePath(); context.globalAlpha = .48; context.fillStyle = color; context.fill(); context.globalAlpha = .9; context.strokeStyle = color; context.stroke(); context.globalAlpha = 1; });
    };
    draw(); const timer = window.setInterval(draw, 300);
    return () => { clearInterval(timer); observer?.disconnect(); sampling.width = sampling.height = 0; };
  }, [mode]);
  return <div className="viewer-scopes"><div className="scope-mode">{(["luma", "rgb"] as const).map((name) => <button type="button" key={name} aria-pressed={name === mode} onClick={() => setMode(name)}>{name === "luma" ? "Luma" : "RGB overlay"}</button>)}</div>
    <canvas ref={canvas} width={256} height={84} aria-label={`${mode} histogram of the full viewer composite`} /><div className="scope-axis"><span>0</span><span>128</span><span>255</span></div><p className="field-note">Full viewer composite · histogram</p></div>;
}
