const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
  session,
  safeStorage,
} = require("electron");
const { writeFile } = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { listInstalledFonts } = require("./fonts.cjs");
const { CodexConnection } = require("./codex.cjs");
const { APISettings } = require("./api-settings.cjs");
const { randomUUID } = require("node:crypto");
const { ExportFiles } = require("./export-files.cjs");
const exportFiles = new ExportFiles();
let codex = null;
let connectingAI = false;
const apiSettings = () => new APISettings(app.getPath("userData"), safeStorage);
const codexTools = new Map();
function cancelCodexTools() {
  for (const pending of codexTools.values()) { clearTimeout(pending.timer); pending.reject(new Error("Editing cancelled.")); }
  codexTools.clear();
}
function assistantOptions() {
  return {
    userData: app.getPath("userData"), version: app.getVersion(),
    emit: (event) => {
      if (event.type === "status" && !event.connected) cancelCodexTools();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("codex:event", event);
    },
    runTool: (name, args) => new Promise((resolve, reject) => {
      if (!mainWindow || mainWindow.isDestroyed()) { reject(new Error("The editor is closed.")); return; }
      const id = randomUUID();
      const timer = setTimeout(() => { codexTools.delete(id); reject(new Error("The editor did not respond. Retry the edit.")); }, name === "cutline_analyze_audio" ? 300000 : 60000);
      codexTools.set(id, { resolve, reject, timer });
      mainWindow.webContents.send("codex:tool-request", { id, name, args, projectId: codex.projectId });
    }),
  };
}
function getCodex() {
  if (!codex) codex = new CodexConnection(assistantOptions());
  return codex;
}

const APP_ID = "com.cutline.editor";
let mainWindow = null;
let closeApproved = false;
let closing = false;
if (process.env.CUTLINE_TEST_PROFILE)
  app.setPath("userData", path.resolve(process.env.CUTLINE_TEST_PROFILE));

app.setAppUserModelId(APP_ID);

function isTrustedSender(event) {
  const senderUrl = event.senderFrame?.url ?? "";
  if (
    event.sender !== mainWindow?.webContents ||
    event.senderFrame !== event.sender.mainFrame
  )
    return false;
  if (process.env.CUTLINE_DEV_URL)
    return (
      new URL(senderUrl).origin === new URL(process.env.CUTLINE_DEV_URL).origin
    );
  return (
    senderUrl ===
    pathToFileURL(path.join(__dirname, "..", "dist-desktop", "index.html")).href
  );
}

function requireTrustedSender(event) {
  if (!isTrustedSender(event))
    throw new Error("Untrusted desktop request blocked.");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    frame: false,
    backgroundColor: "#080a0e",
    icon: path.join(__dirname, "..", "public", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false,
      offscreen: process.env.CUTLINE_PLAYBACK_TEST === "1",
    },
  });

  mainWindow.once("ready-to-show", () => {
    if (
      process.env.CUTLINE_SMOKE_TEST !== "1" &&
      process.env.CUTLINE_LAYOUT_TEST !== "1"
    ) mainWindow?.show();
  });
  mainWindow.on("maximize", () =>
    mainWindow?.webContents.send("window:maximized-change", true),
  );
  mainWindow.on("unmaximize", () =>
    mainWindow?.webContents.send("window:maximized-change", false),
  );
  mainWindow.on("enter-full-screen", () =>
    mainWindow?.webContents.send("window:fullscreen-change", true),
  );
  mainWindow.on("leave-full-screen", () =>
    mainWindow?.webContents.send("window:fullscreen-change", false),
  );
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  const exportOwner = mainWindow.webContents.id;
  mainWindow.webContents.on("destroyed", () => { void exportFiles.abandon(exportOwner).catch(console.error); });
  mainWindow.webContents.on("render-process-gone", () => { void exportFiles.abandon(exportOwner).catch(console.error); });
  mainWindow.webContents.on("did-start-loading", () => { void exportFiles.abandon(exportOwner).catch(console.error); });
  mainWindow.on("close", (event) => {
    if (closeApproved || process.env.CUTLINE_SMOKE_TEST === "1") return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    mainWindow.webContents.send("app:before-close");
    setTimeout(async () => {
      if (!closing || closeApproved || !mainWindow) return;
      const result = await dialog.showMessageBox(mainWindow, {
        type: "warning",
        message: "Cutline is still saving your project.",
        detail: "Wait to keep your latest changes, or close without waiting.",
        buttons: ["Keep waiting", "Close anyway"],
        defaultId: 0,
        cancelId: 0,
      });
      closing = false;
      if (result.response === 1) {
        closeApproved = true;
        mainWindow?.close();
      }
    }, 5000);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowed = process.env.CUTLINE_DEV_URL
      ? new URL(url).origin === new URL(process.env.CUTLINE_DEV_URL).origin
      : url ===
        pathToFileURL(path.join(__dirname, "..", "dist-desktop", "index.html"))
          .href;
    if (!allowed) event.preventDefault();
  });

  if (process.env.CUTLINE_DEV_URL) {
    void mainWindow.loadURL(process.env.CUTLINE_DEV_URL);
  } else {
    void mainWindow.loadFile(
      path.join(__dirname, "..", "dist-desktop", "index.html"),
    );
  }

  if (process.env.CUTLINE_SMOKE_TEST === "1") {
    mainWindow.webContents.once("did-finish-load", () => {
      process.stdout.write("CUTLINE_DESKTOP_READY\n");
      setTimeout(() => app.quit(), 250);
    });
    mainWindow.webContents.once(
      "did-fail-load",
      (_event, code, description) => {
        process.stderr.write(
          `CUTLINE_DESKTOP_LOAD_FAILED ${code} ${description}\n`,
        );
        process.exitCode = 1;
        app.quit();
      },
    );
  }
}

ipcMain.on("window:minimize", (event) => {
  if (isTrustedSender(event))
    BrowserWindow.fromWebContents(event.sender)?.minimize();
});

ipcMain.on("app:ready-close", async (event, error) => {
  if (!isTrustedSender(event) || !closing) return;
  if (error) {
    const result = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      message: "Your latest changes could not be saved.",
      detail:
        String(error).slice(0, 500) +
        "\nKeep the app open to make a project backup.",
      buttons: ["Keep editing", "Close anyway"],
      defaultId: 0,
      cancelId: 0,
    });
    closing = false;
    if (result.response !== 1) return;
  }
  closeApproved = true;
  mainWindow?.close();
});

ipcMain.on("window:maximize", (event) => {
  if (!isTrustedSender(event)) return;
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return;
  if (window.isMaximized()) window.unmaximize();
  else window.maximize();
});

ipcMain.on("window:fullscreen", (event) => {
  if (!isTrustedSender(event)) return;
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window) window.setFullScreen(!window.isFullScreen());
});

ipcMain.handle("window:is-fullscreen", (event) => {
  requireTrustedSender(event);
  return BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false;
});

ipcMain.on("window:close", (event) => {
  if (isTrustedSender(event))
    BrowserWindow.fromWebContents(event.sender)?.close();
});

ipcMain.handle("window:is-maximized", (event) => {
  requireTrustedSender(event);
  return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
});

ipcMain.handle("app:version", (event) => {
  requireTrustedSender(event);
  return app.getVersion();
});

ipcMain.handle("fonts:list", (event, refresh = false) => {
  requireTrustedSender(event);
  return listInstalledFonts(refresh === true);
});

ipcMain.handle("codex:connect", async (event, tools, connection) => {
  requireTrustedSender(event);
  if (connectingAI || getCodex().state.busy) throw new Error("Stop or wait for the current AI operation first.");
  connectingAI = true;
  try {
    cancelCodexTools();
    getCodex().disconnect();
    if (connection?.provider === "custom") {
      const settings = apiSettings();
      const config = await settings.resolve(connection);
      const { CustomAPIConnection } = await import("../dist-native/custom-api.mjs");
      codex = new CustomAPIConnection(assistantOptions());
      const state = await codex.connect(tools, config);
      try { await settings.save(config, connection.rememberKey === true); }
      catch (error) { codex.disconnect(); throw error; }
      return state;
    }
    if (connection?.provider && connection.provider !== "codex") throw new Error("Unknown AI provider.");
    codex = new CodexConnection(assistantOptions());
    return await codex.connect(tools);
  } finally { connectingAI = false; }
});
ipcMain.handle("ai:settings", (event) => { requireTrustedSender(event); return apiSettings().publicSettings(); });
ipcMain.handle("ai:forget", async (event) => { requireTrustedSender(event); cancelCodexTools(); getCodex().disconnect(); return apiSettings().forget(); });
ipcMain.handle("codex:status", (event) => { requireTrustedSender(event); return getCodex().state; });
ipcMain.handle("codex:send", (event, payload) => { requireTrustedSender(event); return getCodex().send(payload?.prompt, payload?.projectId, payload?.model, payload?.effort, payload?.images); });
ipcMain.handle("codex:reset", (event) => { requireTrustedSender(event); cancelCodexTools(); getCodex().reset(); });
ipcMain.handle("codex:disconnect", (event) => { requireTrustedSender(event); cancelCodexTools(); getCodex().disconnect(); });
ipcMain.handle("codex:stop", (event) => { requireTrustedSender(event); cancelCodexTools(); return getCodex().stop(); });
ipcMain.handle("codex:tool-active", (event, id) => { requireTrustedSender(event); return codexTools.has(id); });
ipcMain.on("codex:tool-response", (event, payload) => {
  if (!isTrustedSender(event)) return;
  const pending = codexTools.get(payload?.id);
  if (!pending) return;
  clearTimeout(pending.timer); codexTools.delete(payload.id);
  const result = payload.result;
  if (typeof result?.success !== "boolean" || !Array.isArray(result.contentItems) || JSON.stringify(result).length > 10000000) pending.reject(new Error("Invalid editing result."));
  else pending.resolve(result);
});
ipcMain.handle("codex:login", async (event) => {
  requireTrustedSender(event);
  const url = new URL(await getCodex().login());
  if (url.protocol !== "https:" || !["auth.openai.com", "auth0.openai.com", "chatgpt.com"].includes(url.hostname)) throw new Error("Unexpected sign-in address.");
  await shell.openExternal(url.href);
});

ipcMain.handle("project:confirm-new", async (event) => {
  requireTrustedSender(event);
  const window = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showMessageBox(window, {
    type: "question",
    title: "Start a new project?",
    message: "Start a new Cutline project?",
    detail:
      "Your current project and its imported media will remain in My projects on this device.",
    buttons: ["Cancel", "Start new project"],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
  });
  return result.response === 1;
});

ipcMain.handle("file:save", async (event, payload) => {
  requireTrustedSender(event);
  const window = BrowserWindow.fromWebContents(event.sender);
  const safeName = path.basename(
    String(payload?.suggestedName || "cutline-export.webm"),
  );
  const extension = path.extname(safeName).slice(1).toLowerCase();
  const fileTypes = {
    webm: "WebM video",
    mp4: "MP4 video",
    cutline: "Cutline project backup",
  };
  if (!fileTypes[extension]) throw new Error("Unsupported save format.");
  const result = await dialog.showSaveDialog(window, {
    title:
      extension === "cutline"
        ? "Save Cutline project backup"
        : "Export Cutline video",
    defaultPath: path.join(
      app.getPath(extension === "cutline" ? "documents" : "videos"),
      safeName,
    ),
    filters: [{ name: fileTypes[extension], extensions: [extension] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  const bytes = payload?.bytes;
  if (!(bytes instanceof ArrayBuffer)) throw new Error("Invalid export data.");
  await writeFile(result.filePath, Buffer.from(bytes));
  return { canceled: false, filePath: result.filePath };
});

ipcMain.handle("export:begin", async (event, suggestedName) => {
  requireTrustedSender(event);
  const owner = event.sender.id;
  if (exportFiles.jobs.has(owner)) throw new Error("Finish or cancel the current export first.");
  const name = path.basename(String(suggestedName || "Cutline.mp4"));
  const extension = path.extname(name).slice(1).toLowerCase();
  if (!["mp4", "webm"].includes(extension)) throw new Error("Unsupported export format.");
  const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
    title: "Choose where to export — writes directly to disk",
    defaultPath: path.join(app.getPath("videos"), name),
    filters: [{ name: extension === "mp4" ? "MP4 video" : "WebM video", extensions: [extension] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  requireTrustedSender(event);
  return { canceled: false, ...await exportFiles.begin(owner, result.filePath) };
});
ipcMain.handle("export:write", (event, payload) => {
  requireTrustedSender(event);
  return exportFiles.write(event.sender.id, payload?.token, payload?.position, payload?.bytes);
});
ipcMain.handle("export:finish", (event, payload) => {
  requireTrustedSender(event);
  return exportFiles.commit(event.sender.id, payload?.token, payload?.size);
});
ipcMain.handle("export:cancel", (event, token) => {
  requireTrustedSender(event);
  return exportFiles.abort(event.sender.id, token);
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", () => { cancelCodexTools(); codex?.disconnect(); });
let exportShutdown = false;
app.on("before-quit", event => {
  if (exportShutdown || !exportFiles.jobs.size) return;
  event.preventDefault(); exportShutdown = true;
  void Promise.all([...exportFiles.jobs.keys()].map(owner => exportFiles.abandon(owner)))
    .catch(console.error).finally(() => app.quit());
});
