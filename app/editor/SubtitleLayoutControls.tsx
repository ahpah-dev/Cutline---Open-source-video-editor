import { useId } from "react";
import { Field } from "./Inspector";
import { normalizeSubtitleWordsPerLine } from "./whisper";

export function SubtitleLayoutControls({ value, onChange, disabled }: {
  value: number; onChange: (value: number) => void; disabled: boolean;
}) {
  const helpId = useId();
  const sample = "Every word has a place in your story".split(" ").slice(0, value).join(" ");
  return <div className="subtitle-layout">
    <Field label="Words per line">
      <input type="number" aria-label="Words per line" aria-describedby={helpId} min={1} max={20} step={1}
        value={value} disabled={disabled} onChange={(event) => {
          if (event.target.value !== "") onChange(normalizeSubtitleWordsPerLine(Number(event.target.value)));
        }} />
    </Field>
    <div className="subtitle-word-presets" role="group" aria-label="Caption line length presets">
      {[1, 3, 5, 7].map((count) => <button key={count} type="button" disabled={disabled}
        aria-pressed={value === count} className={value === count ? "active" : ""}
        onClick={() => onChange(count)}>{count} {count === 1 ? "word" : "words"}</button>)}
    </div>
    <div className="subtitle-layout-preview" aria-label="Example caption line"><span>{sample}</span></div>
    <p className="field-note" id={helpId}>Maximum 1–20 words in each one-line caption. Pauses and timing can create shorter captions. This changes newly generated subtitles, not existing text clips.</p>
  </div>;
}
