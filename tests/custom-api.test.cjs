const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { mkdtemp,readFile,rm } = require("node:fs/promises");
const os = require("node:os"), path = require("node:path");
const { APISettings,validateAPI } = require("../electron/api-settings.cjs");
const modulePromise = import("../dist-native/custom-api.mjs");
const NAMES = ["get_project","get_catalog","apply_edits","preview","history","open_export","view_source","analyze_audio"].map(name=>"cutline_"+name);
const TOOLS = NAMES.map(name=>({name,description:name,inputSchema:{type:"object",properties:{},additionalProperties:true}}));
const CONFIG = {name:"Mock 9Router",baseURL:"http://localhost:20128/v1",model:"router/combo",images:false,reasoning:false};
const IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const textResult = text=>({success:true,contentItems:[{type:"inputText",text}]});
function completion(body,toolName,args={}) {
  return {id:"mock-"+Math.random(),object:"chat.completion",created:1,model:body.model,choices:[{index:0,message:{role:"assistant",content:toolName ? null : "Done.",...(toolName ? {tool_calls:[{id:"call-"+Math.random(),type:"function",function:{name:toolName,arguments:JSON.stringify(args)}}]} : {})},finish_reason:toolName ? "tool_calls" : "stop"}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}};
}
async function fixture(handler,runTool=async(name)=>textResult(name)) {
  const requests=[],events=[],calls=[];
  const server=http.createServer(async(req,res)=>{
    let raw="";for await(const chunk of req)raw+=chunk;
    const body=raw ? JSON.parse(raw):null;
    requests.push({url:req.url,method:req.method,authorization:req.headers.authorization,body});
    res.setHeader("content-type","application/json");
    if(req.url === "/v1/models") {res.end(JSON.stringify({data:[{id:"router/combo"},{id:"router/vision"},{id:"router/combo"}]}));return;}
    try {await handler(body,res,requests);} catch {res.statusCode=500;res.end("{}");}
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const {CustomAPIConnection}=await modulePromise;
  const connection=new CustomAPIConnection({emit:event=>events.push(event),runTool:async(name,args)=>{calls.push({name,args});return runTool(name,args);}});
  return {connection,requests,events,calls,config:{...CONFIG,baseURL:`http://127.0.0.1:${server.address().port}/v1`},async close(){connection.disconnect();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
test("custom endpoints reject unsafe protocols, URL secrets and incorrect route URLs",()=>{
  for(const baseURL of ["file:///etc/passwd","http://example.com/v1","https://user:key@example.com/v1","https://example.com/v1?key=secret","https://example.com/v1#key","https://example.com/v1/chat/completions"])assert.throws(()=>validateAPI({...CONFIG,baseURL}));
  assert.equal(validateAPI({...CONFIG,baseURL:"http://[::1]:20128/v1/"}).baseURL,"http://[::1]:20128/v1");
  assert.equal(validateAPI({...CONFIG,baseURL:"https://example.com/api/v1/"}).baseURL,"https://example.com/api/v1");
  assert.throws(()=>validateAPI({...CONFIG,apiKey:"a\nb"}),/API key/);
});
test("keys are encrypted, never returned publicly, scoped to endpoint, removable and session-only",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"cutline-api-test-"));
  const vault={isEncryptionAvailable:()=>true,encryptString:text=>Buffer.from(text.split("").reverse().join("")),decryptString:buffer=>buffer.toString().split("").reverse().join("")};
  const settings=new APISettings(dir,vault);
  try {
    const config={...CONFIG,apiKey:"mock-test-secret"};
    const safe=await settings.save(config,true);
    assert.equal(safe.hasKey,true);assert.ok(!JSON.stringify(safe).includes(config.apiKey));
    assert.ok(!(await readFile(settings.file,"utf8")).includes(config.apiKey));
    assert.equal((await settings.resolve(CONFIG)).apiKey,config.apiKey);
    assert.equal((await settings.resolve({...CONFIG,baseURL:"https://other.example/v1"})).apiKey,"");
    assert.equal((await settings.resolve({...CONFIG,apiKey:""})).apiKey,"");
    await settings.save(config,false);assert.equal((await settings.publicSettings()).hasKey,false);
    vault.isEncryptionAvailable=()=>false;
    await assert.rejects(settings.save(config,true),/encryption/);
    await settings.save(config,false);
    await settings.forget();await assert.rejects(readFile(settings.file),{code:"ENOENT"});
  } finally {await rm(dir,{recursive:true,force:true});}
});
test("9Router-compatible discovery, tool-only agent, serial tool batches, reasoning and follow-up history",async()=>{
  const f=await fixture(async(body,res)=>{
    const tool=body.tool_choice?.function?.name;
    const previous=body.messages.filter(m=>m.role === "tool");
    res.end(JSON.stringify(completion(body,tool || (previous.length === 2 ? "cutline_apply_edits":undefined),{example:true})));
  });
  try {
    const state=await f.connection.connect(TOOLS,{...f.config,model:"",reasoning:true,apiKey:"mock-test-key"});
    assert.equal(state.provider,"custom");assert.equal(state.models.length,2);assert.deepEqual(state.models[0].inputModalities,["text"]);
    assert.equal(f.requests[0].method,"GET");assert.equal(f.requests[0].authorization,"Bearer mock-test-key");
    await f.connection.send("Add a title","project",undefined,"high");
    assert.deepEqual(f.calls.map(c=>c.name),["cutline_get_project","cutline_get_catalog","cutline_apply_edits"]);
    for(const req of f.requests.filter(r=>r.method === "POST")){
      assert.equal(req.url,"/v1/chat/completions");assert.equal(req.body.model,"router/combo");assert.equal(req.body.reasoning_effort,"high");assert.equal(req.body.parallel_tool_calls,false);
      assert.deepEqual(req.body.tools.map(t=>t.function.name),NAMES);assert.ok(!JSON.stringify(req.body.messages).includes("mock-test-key"));
      assert.ok(!req.body.stream); // JSON works even with routers that do not implement SSE.
    }
    assert.ok(f.events.some(e=>e.type === "message" && e.text === "Done."));assert.equal(f.connection.state.busy,false);
    const before=f.requests.length;await f.connection.send("Now improve it","project");
    assert.ok(JSON.stringify(f.requests[before].body.messages).includes("Add a title"));
    assert.equal(f.requests[before].body.reasoning_effort,undefined);
    f.connection.reset();assert.equal(f.connection.projectId,null);
  } finally {await f.close();}
});
test("manual model IDs bypass missing discovery and arbitrary provider IDs are kept",async()=>{
  const f=await fixture(async(body,res)=>res.end(JSON.stringify(completion(body,body.tool_choice?.function?.name))));
  try {
    const state=await f.connection.connect(TOOLS,{...f.config,model:"my-custom-model"});
    assert.equal(state.models[0].id,"my-custom-model");assert.equal(f.requests.length,0);
    await assert.rejects(f.connection.send("Edit","p","unknown"),/available API model/);
    await assert.rejects(f.connection.send("Edit","p",undefined,"high"),/reasoning effort/);
    await assert.rejects(f.connection.connect([...TOOLS.slice(1),TOOLS[1]],f.config),/Invalid Cutline/);
  } finally {await f.close();}
});
test("vision tool frames become actual image_url inputs, not JSON or fake image descriptions",async()=>{
  const f=await fixture(async(body,res)=>{
    const tool=body.tool_choice?.function?.name,previous=body.messages.filter(m=>m.role === "tool");
    res.end(JSON.stringify(completion(body,tool || (previous.length === 2 ? "cutline_preview":undefined))));
  },async(name)=>name === "cutline_preview" ? {success:true,contentItems:[{type:"inputText",text:"Frame at 1s"},{type:"inputImage",imageUrl:IMAGE}]}:textResult(name));
  try {
    await f.connection.connect(TOOLS,{...f.config,images:true});
    await f.connection.send("Inspect","p",undefined,undefined,[{name:"reference.png",imageUrl:IMAGE}]);
    const last=f.requests.at(-1).body;
    assert.ok(last.messages.some(m=>m.role === "user" && Array.isArray(m.content) && m.content.some(p=>p.type === "image_url" && p.image_url.url === IMAGE)));
    assert.ok(last.messages.some(m=>m.role === "tool" && typeof m.content === "string" && m.content.includes("Frame at 1s")));
    assert.ok(last.messages.filter(m=>m.role === "tool").every(m=>!m.content.includes("base64")));
  } finally {await f.close();}
});
test("image-disabled APIs reject attachments and do not execute image tools",async()=>{
  const f=await fixture(async(body,res)=>{const count=body.messages.filter(m=>m.role === "tool").length;res.end(JSON.stringify(completion(body,body.tool_choice?.function?.name || (count === 2 ? "cutline_preview":undefined))));});
  try {
    await f.connection.connect(TOOLS,f.config);
    await assert.rejects(f.connection.send("Inspect","p",undefined,undefined,[{name:"ref",imageUrl:IMAGE}]),/image support/);
    await f.connection.send("Inspect","p");assert.ok(!f.calls.some(c=>c.name === "cutline_preview"));
    assert.ok(f.events.some(e=>e.type === "tool" && e.status === "error"));
  } finally {await f.close();}
});
test("HTTP auth/quota errors are actionable and never echo provider secrets",async()=>{
  for(const status of [401,403,404,429,500]){
    const f=await fixture(async(_body,res)=>{res.statusCode=status;res.end(JSON.stringify({error:{message:"do-not-echo-mock-secret"}}));});
    try {await f.connection.connect(TOOLS,f.config);await assert.rejects(f.connection.send("Edit","p"),error=>!error.message.includes("do-not-echo") && /authentication|not found|quota|provider failed/.test(error.message));assert.equal(f.connection.state.busy,false);}finally{await f.close();}
  }
});
test("plain text models cannot pretend to edit without supported tool calls",async()=>{
  const f=await fixture(async(body,res)=>res.end(JSON.stringify(completion(body))));
  try {await f.connection.connect(TOOLS,f.config);await assert.rejects(f.connection.send("Edit","p"),/tool calling support/);assert.equal(f.calls.length,0);assert.ok(!f.events.some(e=>e.type === "message"));}finally{await f.close();}
});
test("Stop aborts in-flight requests; concurrent sends and stale continuations are rejected",async()=>{
  let started;const ready=new Promise(resolve=>{started=resolve;});
  const f=await fixture(async(body,res)=>{started();setTimeout(()=>{if(!res.destroyed)res.end(JSON.stringify(completion(body,"cutline_apply_edits")));},150);});
  try {
    await f.connection.connect(TOOLS,f.config);
    const sending=f.connection.send("Edit","old-project");await ready;
    await assert.rejects(f.connection.send("Another","p"),/already editing/);
    f.connection.stop();await sending;assert.equal(f.calls.length,0);assert.equal(f.connection.state.busy,false);
    f.connection.reset();assert.equal(f.connection.projectId,null);
  } finally {await f.close();}
});
test("cross-origin redirects never forward authentication",async()=>{
  let leaked=false;
  const destination=http.createServer((_req,res)=>{leaked=true;res.end("{}");});
  await new Promise(resolve=>destination.listen(0,"127.0.0.1",resolve));
  const f=await fixture(async(_body,res)=>{res.statusCode=307;res.setHeader("location",`http://127.0.0.1:${destination.address().port}/capture`);res.end();});
  try {await f.connection.connect(TOOLS,{...f.config,apiKey:"mock-test-key"});await assert.rejects(f.connection.send("Edit","p"),/request failed/);assert.equal(leaked,false);}finally{await f.close();await new Promise(resolve=>destination.close(resolve));}
});
