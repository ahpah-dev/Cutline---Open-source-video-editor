const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const path = require("node:path");
const { CodexConnection, extractCodex } = require("../electron/codex.cjs");
const TOOLS = ["get_project", "get_catalog", "apply_edits", "preview", "history", "open_export"].map((name) => ({ type: "function", name: "cutline_" + name, inputSchema: { type: "object", properties: {} } }));
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
function fixture() {
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
        : message.method === "model/list" ? { data: [{ model: "test-model", displayName: "Test", isDefault: true }] }
        : message.method === "config/read" ? { config: { mcp_servers: { other_service: { command: "example", tool_timeout_sec: null } } } }
        : message.method === "thread/start" ? { thread: { id: "thread" } }
        : message.method === "turn/start" ? { turn: { id: "turn" } }
        : message.method === "account/login/start" ? { authUrl: "https://auth.openai.com/login", loginId: "login" } : {};
      send({ id: message.id, result: response });
      if (message.method === "turn/interrupt") send({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "interrupted" } } });
    }
  });
  const connection = new CodexConnection({ userData: path.resolve("work/mock-codex"), version: "0.4.0", executable: "mock", spawnServer: () => child, emit: (event) => events.push(event), runTool: async (...args) => { called.push(args); return { success: true, contentItems: [{ type: "inputText", text: "ok" }] }; } });
  return { connection, requests, results, events, called, send };
}
test("Codex handshake, model list, ephemeral tool-only thread and message streaming", async () => {
  const f = fixture();
  try {
    const status = await f.connection.connect(TOOLS);
    assert.equal(status.connected, true); assert.equal(status.needsLogin, false);
    assert.equal(status.models[0].id, "test-model");
    assert.equal(f.requests[0].params.capabilities.experimentalApi, true);
    await f.connection.send("Edit my video", "project", "test-model");
    const thread = f.requests.find((request) => request.method === "thread/start").params;
    assert.equal(thread.ephemeral, true); assert.equal(thread.sandbox, "read-only");
    assert.deepEqual(thread.environments, []); assert.equal(thread.config["features.shell_tool"], false);
    assert.equal(thread.config.mcp_servers.other_service.enabled, false);
    assert.equal(thread.config.mcp_servers.other_service.command, "example");
    assert.ok(!("tool_timeout_sec" in thread.config.mcp_servers.other_service));
    assert.equal(thread.config["features.apps"], false);
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
  assert.throws(() => extractCodex(archive.subarray(0, 514)), /Invalid Codex/);
  assert.throws(() => extractCodex(Buffer.alloc(512)), /did not contain/);
});
