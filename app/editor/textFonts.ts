import type { Project, TextClip } from "./model";

/** Use the same CSS font shorthand for font loading and canvas rendering. */
export function textFont(text: Pick<TextClip, "fontFamily" | "fontWeight" | "italic">, size: number) {
  const family = text.fontFamily.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n\f]/g, " ");
  return `${text.italic ? "italic " : ""}${text.fontWeight} ${size}px "${family}"`;
}

const pending = new WeakMap<FontFaceSet, Map<string, Promise<void>>>();

/** Canvas does not initiate CSS font downloads like a DOM text element does.
 * Load every font/style used by the project, including discrete keyframes and
 * the actual characters (so non-Latin font subsets are fetched as well).
 */
export async function ensureTextFonts(project: Pick<Project, "texts">, fonts = document.fonts) {
  if (!fonts) return;
  let requests = pending.get(fonts);
  if (!requests) { requests = new Map(); pending.set(fonts, requests); }
  const jobs: Promise<void>[] = [];
  for (const text of project.texts) {
    const keys = text.propertyKeyframes ?? {};
    const families = new Set([text.fontFamily, ...(keys.fontFamily ?? []).map(k => k.value).filter((v): v is string => typeof v === "string")]);
    const weights = new Set([text.fontWeight, ...(keys.fontWeight ?? []).map(k => k.value).filter((v): v is number => typeof v === "number")]);
    const italics = new Set([text.italic, ...(keys.italic ?? []).map(k => k.value).filter((v): v is boolean => typeof v === "boolean")]);
    const sample = [text.text, ...(keys.text ?? []).map(k => k.value).filter((v): v is string => typeof v === "string")].join("\n") || "New Text";
    for (const fontFamily of families) for (const fontWeight of weights) for (const italic of italics) {
      const font = textFont({fontFamily, fontWeight, italic}, 32);
      if (fonts.check(font, sample)) continue;
      const key = JSON.stringify([font, sample]);
      let job = requests.get(key);
      if (!job) {
        job = fonts.load(font, sample).then(() => {}).catch(() => {
          throw new Error(`Could not load the text font “${fontFamily}”. Try selecting another font, then retry.`);
        }).finally(() => requests!.delete(key));
        requests.set(key, job);
      }
      jobs.push(job);
    }
  }
  await Promise.all(jobs);
}
