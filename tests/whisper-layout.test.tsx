import assert from "node:assert/strict";
import test from "node:test";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { SubtitleLayoutControls } from "../app/editor/SubtitleLayoutControls";
import { normalizeSubtitleWordsPerLine, readSubtitleWordsPerLine, saveSubtitleWordsPerLine, wordsToCaptions, type WhisperChunk } from "../app/editor/whisper";
import { migrateProject, newProject } from "../app/editor/model";

const words: WhisperChunk[] = "One two three four five six seven eight nine ten eleven twelve thirteen fourteen".split(" ")
  .map((text, i) => ({ text, timestamp: [i * .2, (i + 1) * .2] }));
test("Whisper line length accepts 1–20 words, retains every word and real timestamps, and avoids caption overlap", () => {
  for (const wordsPerLine of [1, 2, 3, 5, 7, 20]) {
    const captions = wordsToCaptions(words, 12, 4, 3, { wordsPerLine });
    assert.equal(captions.map(c => c.text).join(" "), words.map(w => w.text).join(" "));
    assert.equal(captions.length, Math.ceil(words.length / wordsPerLine));
    captions.forEach((caption, index) => {
      assert.ok(caption.text.split(/\s+/u).length <= wordsPerLine);
      assert.equal(caption.start, 12 + words[index * wordsPerLine].timestamp[0]);
      assert.equal(caption.track, 3); assert.equal(caption.kind, "caption");
      assert.ok(caption.duration > 0 && caption.start + caption.duration <= 16);
      if (index < captions.length - 1) assert.ok(caption.start + caption.duration <= captions[index + 1].start + 1e-9);
    });
  }
  assert.equal(wordsToCaptions(words, 0, 4, 1)[0].text.split(" ").length, 7);
});
test("Large segment and fallback transcription obey word limits with bounded estimated timings", () => {
  const captions = wordsToCaptions([{ text: "Hello world, this is a longer Whisper segment.", timestamp: [1, 5] }], 20, 6, 4, { wordsPerLine: 3 });
  assert.deepEqual(captions.map(c => c.text), ["Hello world, this", "is a longer", "Whisper segment."]);
  assert.deepEqual(captions.map(c => c.start), [21, 22.5, 24]);
  assert.ok(captions.every(c => c.start + c.duration <= 26));
  const unknown = wordsToCaptions([{ text: "A full sentence with missing end", timestamp: [0, null] }], 5, 3, 2, { wordsPerLine: 1 });
  assert.equal(unknown.length, 6); assert.equal(unknown.at(-1)!.start, 7.5);
  assert.equal(unknown.at(-1)!.start + unknown.at(-1)!.duration, 8);
});
test("Caption grouping retains pauses, punctuation, Unicode, limits and backup text", () => {
  const chunks: WhisperChunk[] = [{ text: "  Hello ,  👋🏽 café  ", timestamp: [0, 1] }, { text: "Добро јутро", timestamp: [3, 4] }];
  const captions = wordsToCaptions(chunks, 4, 4, 2, { wordsPerLine: 2 });
  assert.deepEqual(captions.map(c => c.text), ["Hello, 👋🏽", "café", "Добро јутро"]);
  const p = { ...newProject(), texts: captions };
  assert.deepEqual(migrateProject(JSON.parse(JSON.stringify(p)), []).texts.map(c => c.text), captions.map(c => c.text));
  assert.deepEqual(wordsToCaptions(words, 0, 0, 0), []);
  assert.equal(normalizeSubtitleWordsPerLine(NaN), 7); assert.equal(normalizeSubtitleWordsPerLine(Infinity), 7);
  assert.equal(normalizeSubtitleWordsPerLine(0), 1); assert.equal(normalizeSubtitleWordsPerLine(100), 20);
  assert.equal(normalizeSubtitleWordsPerLine(3.4), 3);
});
test("Subtitle controls offer accessible presets, remember preferences, and lock during transcription", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://unit.test" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(dom.window.document.getElementById("root")!);
  let observed = 7;
  function Harness({ disabled = false }: { disabled?: boolean }) {
    const [value, setValue] = useState(readSubtitleWordsPerLine); observed = value;
    return <SubtitleLayoutControls value={value} disabled={disabled} onChange={next => { setValue(next); saveSubtitleWordsPerLine(next); }} />;
  }
  try {
    await act(() => root.render(<Harness />));
    const button = [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "3 words")!;
    await act(() => button.click()); assert.equal(observed, 3); assert.equal(readSubtitleWordsPerLine(), 3);
    assert.equal(button.getAttribute("aria-pressed"), "true");
    assert.equal(dom.window.document.querySelector('[aria-label="Example caption line"]')!.textContent, "Every word has");
    const input = dom.window.document.querySelector<HTMLInputElement>('[aria-label="Words per line"]')!;
    assert.equal(input.value, "3"); assert.ok(input.getAttribute("aria-describedby"));
    await act(() => root.render(<Harness disabled />)); assert.equal(input.disabled, true);
    assert.ok([...dom.window.document.querySelectorAll<HTMLButtonElement>("button")].every(b => b.disabled));
    await act(() => root.render(<Harness key="reload" />)); assert.equal(observed, 3);
  } finally { await act(() => root.unmount()); dom.window.close(); }
});
