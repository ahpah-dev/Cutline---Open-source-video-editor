import { runTextFontChecks } from "./text-fonts-engine";
globalThis.runTextFontTests = async () => {
  const passed:string[] = [], failures:string[] = [];
  await runTextFontChecks(async (name,fn) => {try{await fn();passed.push(name);}catch(e){failures.push(`${name}: ${String((e as Error).stack)}`);}});
  return {passed,failures};
};
declare global {var runTextFontTests: () => Promise<{passed:string[];failures:string[]}>;}
