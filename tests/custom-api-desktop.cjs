// Production window/preload/tool bridge against an isolated OpenAI-compatible mock.
// No user API keys, router settings, paid calls or existing projects are accessed.
const {app,BrowserWindow} = require("electron");
const assert = require("node:assert/strict");
const http = require("node:http"), path = require("node:path");
const {mkdir,readFile,writeFile} = require("node:fs/promises");
process.env.CUTLINE_TEST_PROFILE = path.resolve(`work/custom-api-desktop-profile-${Date.now()}`);
process.env.CUTLINE_LAYOUT_TEST = "1";
process.env.CUTLINE_PLAYBACK_TEST = "1";
const requests=[];
const secret="mock-only-native-key";
let id=0;
const server=http.createServer(async(req,res)=>{
  res.setHeader("content-type","application/json");
  if(req.url === "/v1/models") {res.end(JSON.stringify({data:[{id:"mock-router/vision-editor"}]}));return;}
  let raw="";for await(const chunk of req)raw+=chunk;
  const body=JSON.parse(raw);requests.push(body);
  assert.equal(req.headers.authorization,"Bearer "+secret);
  const messages=body.messages;
  const previous=messages.filter(message=>message.role === "tool");
  let name=body.tool_choice?.function?.name,args={};
  if(!name && previous.length === 2){
    const snapshot=JSON.parse(JSON.parse(previous[0].content).contentItems[0].text);
    name="cutline_apply_edits";args={projectId:snapshot.projectId,expectedRevision:snapshot.revision,operations:[{op:"add_text",text:"Custom API connected",start:0,duration:2,track:1,patch:{fontSize:96,color:"#ffffff"}}]};
  } else if(!name && previous.length === 3){name="cutline_preview";args={time:1};}
  res.end(JSON.stringify({id:"mock-"+(++id),object:"chat.completion",created:1,model:body.model,choices:[{index:0,message:{role:"assistant",content:name ? null : "Added the title and verified its preview.",...(name ? {tool_calls:[{id:"tool-"+id,type:"function",function:{name,arguments:JSON.stringify(args)}}]}:{})},finish_reason:name ? "tool_calls":"stop"}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));
});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){for(let i=0;i<150;i++){const value=await check();if(value)return value;await wait(100);}throw new Error("Timed out: "+label);}
app.on("web-contents-created",(_event,contents)=>{
  contents.setFrameRate(60);contents.on("paint",()=>{});contents.startPainting();
  contents.once("did-finish-load",async()=>{
    const window=BrowserWindow.fromWebContents(contents);if(!window)return;
    const errors=[];contents.on("console-message",event=>{if(event.level === "error")errors.push(event.message);});
    try {
      await until(()=>contents.executeJavaScript('Boolean(document.querySelector(".codex-toggle") && !document.querySelector(".loading-project"))'),"editor ready");
      await contents.executeJavaScript('document.querySelector(".codex-toggle").click()');await wait(100);
      const setInput=(label,value,kind="input")=>contents.executeJavaScript(`(()=>{const el=document.querySelector('[aria-label=${JSON.stringify(label)}]');Object.getOwnPropertyDescriptor(${kind === "select" ? "HTMLSelectElement" : kind === "textarea" ? "HTMLTextAreaElement":"HTMLInputElement"}.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event(${JSON.stringify(kind === "select" ? "change":"input")},{bubbles:true}));})()`);
      await setInput("AI provider","custom","select");
      await until(()=>contents.executeJavaScript('Boolean(document.querySelector(".custom-api-fields fieldset:not([disabled])"))'),"settings loaded");
      assert.equal(await contents.executeJavaScript('document.querySelector("[aria-label=\\"API base URL\\"]").value'),"http://localhost:20128/v1");
      await setInput("API base URL",`http://127.0.0.1:${server.address().port}/v1`);
      await setInput("API connection name","Mock 9Router");await setInput("API key",secret);
      await contents.executeJavaScript('document.querySelector(".custom-api-fields input[type=checkbox]").checked || document.querySelector(".custom-api-fields input[type=checkbox]").click(); [...document.querySelectorAll(".custom-api-check")].find(el=>el.textContent.includes("image input")).querySelector("input").click()');
      await wait(50);
      await mkdir("work/custom-api-verification",{recursive:true});
      await contents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await wait(100);
      await writeFile("work/custom-api-verification/settings.png",(await contents.capturePage()).toPNG());
      await contents.executeJavaScript('document.querySelector(".custom-api-fields .codex-connect").click()');
      await until(()=>contents.executeJavaScript('Boolean(document.querySelector(".codex-composer textarea"))'),"custom chat connected");
      await until(()=>contents.executeJavaScript('document.querySelector("[aria-label=\\"API key\\"]").value === ""'),"key cleared from UI");
      const publicSettings=await contents.executeJavaScript('window.cutlineDesktop.apiSettings()');
      assert.equal(publicSettings.hasKey,true);assert.ok(!JSON.stringify(publicSettings).includes(secret));
      const saved=await readFile(path.join(process.env.CUTLINE_TEST_PROFILE,"custom-api.json"),"utf8");assert.ok(!saved.includes(secret));
      await setInput("Describe your video edit","Add a title and inspect it","textarea");await wait(50);
      await contents.executeJavaScript('document.querySelector(".codex-composer").requestSubmit()');
      await until(()=>contents.executeJavaScript('window.cutlineDesktop.codexStatus().then(state=>!state.busy && !!document.querySelector(".codex-message.assistant"))'),"native edit completed");
      const error=await contents.executeJavaScript('document.querySelector(".codex-error")?.textContent');assert.ok(!error,error);
      assert.ok(await contents.executeJavaScript('[...document.querySelectorAll(".timeline-clip")].some(el=>el.textContent.includes("Custom API connected"))'));
      assert.ok(requests.some(body=>body.messages.some(message=>message.role === "user" && Array.isArray(message.content) && message.content.some(part=>part.type === "image_url" && part.image_url.url.startsWith("data:image/jpeg")))));
      await contents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await wait(100);
      await writeFile("work/custom-api-verification/edited.png",(await contents.capturePage()).toPNG());
      await contents.executeJavaScript('document.querySelector(".codex-composer-footer button").click()');
      await until(()=>contents.executeJavaScript('!document.querySelector(".timeline-clip")'),"Undo removed title");
      await contents.executeJavaScript('document.querySelector("[aria-label=\\"Disconnect Codex\\"]").click()');
      await until(()=>contents.executeJavaScript('!document.querySelector(".custom-api-fields fieldset").disabled'),"settings unlocked");
      await contents.executeJavaScript('document.querySelector(".custom-api-forget").click()');
      await until(()=>contents.executeJavaScript('window.cutlineDesktop.apiSettings().then(value=>!value.hasKey)'),"key forgotten");
      await setInput("AI provider","codex","select");await wait(100);
      assert.ok(await contents.executeJavaScript('document.querySelector(".codex-connect")?.textContent.includes("Connect Codex")'));
      assert.deepEqual(errors,[]);
      console.log("CUSTOM_API_DESKTOP_PASSED",JSON.stringify({checks:["9Router preset","discovery through IPC","Windows encrypted key","key never returned","UI key cleared","atomic title edit","real preview image","Undo","forget key","Codex retained"],requests:requests.length}));
      server.closeAllConnections();server.close();app.exit(0);
    } catch(error){console.error(error.stack);server.closeAllConnections();server.close();app.exit(1);}
  });
});
server.listen(0,"127.0.0.1",()=>require(process.env.CUTLINE_TEST_APP_MAIN || "../electron/main.cjs"));
