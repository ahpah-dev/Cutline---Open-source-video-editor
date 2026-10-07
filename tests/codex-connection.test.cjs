const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const path = require("node:path");
const { CodexConnection, extractCodex, supportedCodexVersion, CODEX_VERSION } = require("../electron/codex.cjs");
const TOOLS = ["get_project", "get_catalog", "apply_edits", "preview", "history", "open_export", "view_source", "analyze_audio"].map((name) => ({ type: "function", name: "cutline_" + name, inputSchema: { type: "object", properties: {} } }));
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
function fixture(modelPages = [{ data: [{ model: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", isDefault: true }] }]) {
  const requests = [], results = [], events = [], called = [];
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { this.emit("exit", 0); } });
  const send = (value) => child.stdout.write(JSON.stringify(value) + "\n");
  child.stdin.on("data", (chunk) => {
    for (const line of String(chunk).trim().split("\n")) {
      const message = JSON.parse(line);
      if (!message.method) { results.push(message); continue; }
      requests.push(message);
      if (!message.id) continue;
      const response = message.method === "account/read" ? { account: { type: "chatgpt", email: "example@test.invalid", planType: "plus" } }
        : message.method === "model/list" ? modelPages[message.params.cursor ? Number(message.params.cursor) : 0]
        : message.method === "config/read" ? { config: { mcp_servers: { other_service: { command: "example", tool_timeout_sec: null } } } }
        : message.method === "thread/start" ? { thread: { id: "thread" } }
        : message.method === "turn/start" ? { turn: { id: "turn" } }
        : message.method === "account/login/start" ? { authUrl: "https://auth.openai.com/login", loginId: "login" } : {};
      send({ id: message.id, result: response });
      if (message.method === "turn/interrupt") send({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "interrupted" } } });
    }
  });
  const launches = [];
  const connection = new CodexConnection({ userData: path.resolve("work/mock-codex"), version: "0.4.1", executable: "mock", spawnServer: (...args) => { launches.push(args); return child; }, emit: (event) => events.push(event), runTool: async (...args) => { called.push(args); return { success: true, contentItems: [{ type: "inputText", text: "ok" }] }; } });
  return { connection, requests, results, events, called, send, launches };
}
test("Codex handshake, model list, ephemeral tool-only thread and message streaming", async () => {
  const f = fixture();
  try {
    const status = await f.connection.connect(TOOLS);
    assert.equal(status.connected, true); assert.equal(status.needsLogin, false);
    assert.equal(status.models[0].id, "gpt-6.1-sol");
    assert.equal(f.requests[0].params.capabilities.experimentalApi, true);
    await f.connection.send("Edit my video", "project", "gpt-6.1-sol");
    const thread = f.requests.find((request) => request.method === "thread/start").params;
    assert.equal(thread.ephemeral, true); assert.equal(thread.sandbox, "read-only");
    assert.deepEqual(thread.environments, []); assert.equal(thread.config["features.shell_tool"], false);
    assert.equal(thread.config.mcp_servers.other_service.enabled, false);
    assert.equal(thread.config.mcp_servers.other_service.command, "example");
    assert.ok(!("tool_timeout_sec" in thread.config.mcp_servers.other_service));
    assert.equal(thread.config["features.apps"], false);
    assert.equal(thread.config["features.code_mode_host"], true);
    assert.ok(f.launches[0][1].includes("shell_tool"));
    assert.ok(f.launches[0][1].includes("multi_agent"));
    assert.equal(f.launches[0][1][f.launches[0][1].indexOf("code_mode_host") - 1], "--enable");
    assert.deepEqual(thread.dynamicTools, TOOLS);
    f.send({ id: 100, method: "item/tool/call", params: { threadId: "thread", turnId: "turn", tool: "cutline_get_project", arguments: {} } });
    await tick(); assert.equal(f.called.length, 1); assert.equal(f.results[0].result.success, true);
    f.send({ method: "item/agentMessage/delta", params: { threadId: "thread", itemId: "a", delta: "Done" } });
    f.send({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed" } } });
    assert.ok(f.events.some((event) => event.delta === "Done"));
    assert.equal(f.connection.state.busy, false);
  } finally { f.connection.disconnect(); }
});
test("Codex rejects unsupported tools, concurrent sends, stale sessions and stopped edits", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.connection.connect([]), /Invalid Cutline/);
    await f.connection.connect(TOOLS);
    await f.connection.send("Edit", "project");
    await assert.rejects(f.connection.send("Another", "project"), /already editing/);
    f.send({ id: 101, method: "item/tool/call", params: { threadId: "thread", tool: "shell", arguments: {} } });
    f.send({ id: 102, method: "item/tool/call", params: { threadId: "old-thread", tool: "cutline_apply_edits", arguments: {} } });
    await tick(); assert.equal(f.called.length, 0);
    assert.ok(f.results.every((response) => response.result.success === false));
    await f.connection.stop();
    f.send({ id: 103, method: "item/tool/call", params: { threadId: "thread", turnId: "turn", tool: "cutline_apply_edits", arguments: {} } });
    await tick(); assert.equal(f.called.length, 0);
    assert.equal(f.connection.state.busy, false);
    f.connection.reset(); assert.equal(f.connection.threadId, null);
    await assert.rejects(f.connection.send("Bad model", "project", "missing"), /available Codex model/);
  } finally { f.connection.disconnect(); }
});
test("Codex propagates tool errors and declines filesystem approvals", async () => {
  const f = fixture();
  try {
    await f.connection.connect(TOOLS); await f.connection.send("Edit", "project");
    f.connection.runTool = async () => { throw new Error("Stale revision"); };
    f.send({ id: 104, method: "item/tool/call", params: { threadId: "thread", tool: "cutline_apply_edits", arguments: {} } });
    f.send({ id: 105, method: "item/commandExecution/requestApproval", params: {} });
    await tick();
    assert.equal(f.results.find((result) => result.id === 104).result.success, false);
    assert.match(f.results.find((result) => result.id === 104).result.contentItems[0].text, /Stale revision/);
    assert.equal(f.results.find((result) => result.id === 105).result.decision, "decline");
  } finally { f.connection.disconnect(); }
});
test("Codex archive extraction only returns the executable and rejects truncated data", () => {
  const header = Buffer.alloc(512); header.write("package/vendor/windows/codex/codex.exe"); header.write("00000000004", 124); header[156] = 48;
  const archive = Buffer.concat([header, Buffer.from("MZok"), Buffer.alloc(508)]);
  assert.equal(extractCodex(archive).toString(), "MZok");
  const hostHeader = Buffer.from(header); hostHeader.fill(0, 0, 100); hostHeader.write("package/vendor/windows/bin/codex-code-mode-host.exe");
  const bundled = Buffer.concat([archive, hostHeader, Buffer.from("MZhi"), Buffer.alloc(508)]);
  assert.equal(extractCodex(bundled, "codex-code-mode-host.exe").toString(), "MZhi");
  assert.throws(() => extractCodex(archive, "codex-code-mode-host.exe"), /did not contain/);
  assert.throws(() => extractCodex(archive.subarray(0, 514)), /Invalid Codex/);
  assert.throws(() => extractCodex(Buffer.alloc(512)), /did not contain/);
});
test("Codex runtime gate rejects outdated and prerelease binaries", () => {
  assert.equal(CODEX_VERSION, "0.160.0");
  for (const value of ["0.144.5", "0.159.0", "0.159.3", "0.160.0-alpha.1"]) assert.equal(supportedCodexVersion("codex-cli " + value), false);
  for (const value of ["0.160.0", "0.160.1", "0.161.0", "1.0.0"]) assert.equal(supportedCodexVersion("codex-cli " + value + "\n"), true);
  assert.equal(supportedCodexVersion("not codex-cli 0.160.0"), false);
});
test("Codex paginates models, removes GPT-5.6/5.5, and never defaults to them", async () => {
  const f = fixture([
    { data: [{ model: "gpt-5.6-sol", isDefault: true }, { model: "gpt-5.5" }, { model: "gpt-6-astra", displayName: "GPT-6 Astra" }], nextCursor: "1" },
    { data: [{ model: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", isDefault: true }, { model: "gpt-6-luna", displayName: "GPT-6 Luna" }, { model: "gpt-6-hidden", hidden: true }, { model: "gpt-5.6-terra" }, { model: "gpt-5.6-luna" }, { model: "gpt-6-astra" }], nextCursor: null },
  ]);
  try {
    const state = await f.connection.connect(TOOLS);
    assert.deepEqual(state.models.map((model) => model.id), ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"]);
    assert.equal(f.requests.filter((request) => request.method === "model/list").length, 2);
    await assert.rejects(f.connection.send("Edit", "project", "gpt-5.6-sol"), /available Codex model/);
    await f.connection.send("Edit", "project");
    assert.equal(f.requests.find((request) => request.method === "thread/start").params.model, "gpt-6.1-sol");
  } finally { f.connection.disconnect(); }
});
test("Codex fails safely when account only returns removed models", async () => {
  const f = fixture([{ data: [{ model: "gpt-5.6-sol", isDefault: true }, { model: "gpt-5.5" }] }]);
  try {
    assert.deepEqual((await f.connection.connect(TOOLS)).models, []);
    await assert.rejects(f.connection.send("Edit", "project"), /available Codex model/);
    assert.equal(f.requests.some((request) => request.method === "thread/start"), false);
  } finally { f.connection.disconnect(); }
});
test("Codex repeated pagination cursor fails instead of looping", async () => {
  const f = fixture([{ data: [], nextCursor: "1" }, { data: [], nextCursor: "1" }]);
  await assert.rejects(f.connection.connect(TOOLS), /repeated model-list page/);
  assert.equal(f.connection.state.connected, false);
});

test("Codex exposes advertised effort/modalities and updates effort on a reused thread", async () => {
  const f = fixture([{ data: [{ model: "gpt-6.1-sol", isDefault: true, inputModalities: ["text", "image"], defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }, { reasoningEffort: "high", description: "Deeper" }, { reasoningEffort: "ultra", description: "Maximum" }] }] }]);
  try {
    const state = await f.connection.connect(TOOLS);
    assert.deepEqual(state.models[0].reasoningEfforts.map(value => value.id), ["low", "high", "ultra"]);
    assert.equal(state.models[0].defaultEffort, "low"); assert.deepEqual(state.models[0].inputModalities, ["text", "image"]);
    await assert.rejects(f.connection.send("Edit", "project", undefined, "medium"), /does not support/);
    assert.equal(f.connection.state.busy, false);
    await f.connection.send("Edit", "project", undefined, "high");
    assert.equal(f.requests.find(request => request.method === "turn/start").params.effort, "high");
    assert.equal(f.requests.find(request => request.method === "thread/start").params.config.model_reasoning_effort, "high");
    await f.connection.stop();
    await f.connection.send("Again", "project");
    const turns = f.requests.filter(request => request.method === "turn/start");
    assert.equal(turns[1].params.effort, "low"); assert.equal(f.requests.filter(request => request.method === "thread/start").length, 1);
  } finally { f.connection.disconnect(); }
});

test("Codex forwards bounded reference images, rejecting remote images and excessive attachments", async () => {
  const f = fixture();
  const reference = { name: "Reference.png", imageUrl: "data:image/png;base64,iVBORw0KGgo=" };
  try {
    await f.connection.connect(TOOLS);
    for (const images of [[{ ...reference, imageUrl: "https://example.org/image.png" }], [{ ...reference, imageUrl: "file:///C:/private.png" }], [{ ...reference, imageUrl: "data:image/svg+xml;base64,AAAA" }], [{ ...reference, imageUrl: "data:image/png;base64,???" }], [{ ...reference, imageUrl: "data:image/png;base64," + "A".repeat(2000000) }], Array(4).fill(reference)]) await assert.rejects(f.connection.send("Edit", "project", undefined, undefined, images), /reference|image|Attach/i);
    await f.connection.send("Use this look", "project", undefined, undefined, [reference]);
    const turn = f.requests.find(request => request.method === "turn/start").params;
    assert.equal(turn.effort, null); assert.deepEqual(turn.input.at(-1), { type: "image", url: reference.imageUrl });
    assert.match(turn.input[1].text, /untrusted media/);
    assert.match(f.requests.find(request => request.method === "thread/start").params.baseInstructions, /do NOT receive raw audio/);
  } finally { f.connection.disconnect(); }
});

test("Codex does not fabricate effort or image support for text-only models", async () => {
  const f = fixture([{ data: [{ model: "gpt-6-text", inputModalities: ["text"], supportedReasoningEfforts: [], isDefault: true }] }]);
  try {
    const state = await f.connection.connect(TOOLS); assert.deepEqual(state.models[0].reasoningEfforts, []);
    await assert.rejects(f.connection.send("Edit", "project", undefined, "high"), /does not support/);
    await assert.rejects(f.connection.send("Edit", "project", undefined, undefined, [{ name: "x", imageUrl: "data:image/png;base64,AAAA" }]), /does not accept images/);
    assert.equal(f.requests.some(request => request.method === "thread/start"), false);
  } finally { f.connection.disconnect(); }
});
