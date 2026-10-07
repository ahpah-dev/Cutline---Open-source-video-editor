// Explicit opt-in integration test: uses the signed-in Codex account for one small edit.
// Runs the actual production window/preload/app-server bridge in an isolated profile.
const { app, BrowserWindow } = require("electron");
const { mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");
process.env.CUTLINE_TEST_PROFILE = path.resolve("work/codex-desktop-profile");
process.env.CUTLINE_LAYOUT_TEST = "1";
require("../electron/main.cjs");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.on("web-contents-created", (_event, contents) => {
  contents.once("did-finish-load", async () => {
    const window = BrowserWindow.fromWebContents(contents);
    if (!window) return;
    const errors = [];
    contents.on("console-message", (event) => { if (event.level === "error") errors.push(event.message); });
    try {
      for (let i = 0; i < 150; i++) {
        if (await contents.executeJavaScript('Boolean(document.querySelector(".codex-toggle") && !document.querySelector(".loading-project"))')) break;
        await wait(100);
      }
      await contents.executeJavaScript('document.querySelector(".codex-toggle").click()'); await wait(500);
      await mkdir("work/codex-verification", { recursive: true });
      await writeFile("work/codex-verification/setup.png", (await contents.capturePage()).toPNG());
      await contents.executeJavaScript('document.querySelector(".codex-connect").click()');
      let connected = false;
      for (let i = 0; i < 120; i++) {
        connected = await contents.executeJavaScript('Boolean(document.querySelector(".codex-composer textarea"))');
        if (connected) break;
        const error = await contents.executeJavaScript('document.querySelector(".codex-error")?.textContent || ""');
        if (error) throw new Error(error);
        await wait(500);
      }
      if (!connected) throw new Error("Codex did not connect with the existing sign-in.");
      const modelList = await contents.executeJavaScript('[...document.querySelector("[aria-label=\\"Codex model\\"]").options].map(option=>({id:option.value,name:option.textContent}))');
      if (modelList.some(({ id }) => /^gpt-5\.(5|6)(-|$)/.test(id))) throw new Error("Removed GPT-5 models are still in the picker.");
      console.log("CUTLINE_CODEX_MODEL_PICKER", JSON.stringify(modelList));
      const efforts = await contents.executeJavaScript('[...document.querySelector("[aria-label=\\"Codex reasoning effort\\"]").options].map(option=>option.value)');
      const capabilities = await contents.executeJavaScript('window.cutlineDesktop.codexStatus().then(state=>state.models.map(model=>({id:model.id,efforts:model.reasoningEfforts,defaultEffort:model.defaultEffort,inputModalities:model.inputModalities})))');
      if (!efforts.includes("low") || !efforts.includes("high")) throw new Error("Supported reasoning levels did not reach the UI.");
      console.log("CUTLINE_CODEX_MODEL_CAPABILITIES",JSON.stringify(capabilities));
      if (process.env.CUTLINE_TEST_MODEL) {
        await contents.executeJavaScript(`(() => { const select=document.querySelector('[aria-label="Codex model"]'); select.value=${JSON.stringify(process.env.CUTLINE_TEST_MODEL)}; if (!select.value) throw new Error('Requested model missing'); select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
      }
      await contents.executeJavaScript(`void window.cutlineDesktop.onCodexEvent(event => console.log('CODEX_TEST_EVENT', JSON.stringify({type:event.type,name:event.name,status:event.status,busy:event.busy,message:event.message})))`);
      contents.on("console-message", (event) => { if (event.message?.startsWith("CODEX_TEST_EVENT")) console.log(event.message); });
      if (process.env.CUTLINE_LIVE_CODEX !== "1") { console.log("CUTLINE_CODEX_CONNECTED"); app.exit(0); return; }
      await contents.executeJavaScript(`(() => {
        const input = document.querySelector('.codex-composer textarea');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,
          'In this isolated test project only: add one centered text clip reading Codex connected at 0 seconds for 2 seconds, white text, font size 96, layer 1. Do not add any other items. Read the project/catalog, apply one batch, verify a preview at 1 second, and finish.');
        input.dispatchEvent(new Event('input',{bubbles:true}));
      })()`);
      await wait(100);
      await contents.executeJavaScript('document.querySelector(".codex-composer").requestSubmit()');
      let completed = false;
      for (let i = 0; i < 480; i++) {
        await wait(500);
        const result = await contents.executeJavaScript(`(async () => ({ error: document.querySelector('.codex-error')?.textContent,
          done: Boolean(document.querySelector('.codex-message.assistant') && !(await window.cutlineDesktop.codexStatus()).busy),
          clips: [...document.querySelectorAll('.timeline-clip')].map(el=>el.textContent),
          text: document.querySelector('.codex-messages')?.textContent }))()`);
        if (result.error) throw new Error(result.error);
        if (i % 40 === 0) console.log("CODEX_TEST_PROGRESS", JSON.stringify({ clips: result.clips.length, done: result.done }));
        if (result.done) { if (!result.clips.some((text) => text.includes("Codex connected"))) throw new Error("AI finished without adding the requested clip: " + result.text); completed = true; break; }
      }
      if (!completed) throw new Error("Codex edit timed out.");
      for (let i = 0; i < 40; i++) {
        if (await contents.executeJavaScript('!document.querySelector("[aria-label=\\"Stop Codex edit\\"]")')) break;
        await wait(100);
      }
      await contents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      await writeFile("work/codex-verification/edited.png", (await contents.capturePage()).toPNG());
      await contents.executeJavaScript(`document.querySelector('.codex-composer-footer button').click()`); await wait(300);
      const undone = await contents.executeJavaScript('!document.querySelector(".timeline-clip")');
      if (!undone) throw new Error("Undo did not remove the edit.");
      console.log("CUTLINE_CODEX_LIVE_EDIT_AND_UNDO_PASSED", JSON.stringify({ errors }));
      app.exit(errors.length ? 1 : 0);
    } catch (error) { console.error(error.stack); app.exit(1); }
  });
});
