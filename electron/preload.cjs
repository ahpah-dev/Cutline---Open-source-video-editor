const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cutlineDesktop", {
  isDesktop: true,
  platform: process.platform,
  version: () => ipcRenderer.invoke("app:version"),
  codexConnect: (tools) => ipcRenderer.invoke("codex:connect", tools),
  codexStatus: () => ipcRenderer.invoke("codex:status"),
  codexLogin: () => ipcRenderer.invoke("codex:login"),
  codexSend: (prompt, projectId, model, effort, images) => ipcRenderer.invoke("codex:send", { prompt, projectId, model, effort, images }),
  codexStop: () => ipcRenderer.invoke("codex:stop"),
  codexReset: () => ipcRenderer.invoke("codex:reset"),
  codexDisconnect: () => ipcRenderer.invoke("codex:disconnect"),
  codexToolActive: (id) => ipcRenderer.invoke("codex:tool-active", id),
  onCodexEvent: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("codex:event", listener);
    return () => ipcRenderer.removeListener("codex:event", listener);
  },
  onCodexTool: (callback) => {
    const listener = async (_event, request) => {
      let result;
      try { result = await callback(request); }
      catch (error) { result = { success: false, contentItems: [{ type: "inputText", text: String(error.message || error) }] }; }
      ipcRenderer.send("codex:tool-response", { id: request.id, result });
    };
    ipcRenderer.on("codex:tool-request", listener);
    return () => ipcRenderer.removeListener("codex:tool-request", listener);
  },
  listInstalledFonts: (refresh = false) =>
    ipcRenderer.invoke("fonts:list", Boolean(refresh)),
  minimize: () => ipcRenderer.send("window:minimize"),
  maximize: () => ipcRenderer.send("window:maximize"),
  toggleFullscreen: () => ipcRenderer.send("window:fullscreen"),
  isFullscreen: () => ipcRenderer.invoke("window:is-fullscreen"),
  onFullscreenChange: (callback) => {
    const listener = (_event, fullscreen) => callback(Boolean(fullscreen));
    ipcRenderer.on("window:fullscreen-change", listener);
    return () => ipcRenderer.removeListener("window:fullscreen-change", listener);
  },
  close: () => ipcRenderer.send("window:close"),
  isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
  onMaximizedChange: (callback) => {
    const listener = (_event, maximized) => callback(Boolean(maximized));
    ipcRenderer.on("window:maximized-change", listener);
    return () =>
      ipcRenderer.removeListener("window:maximized-change", listener);
  },
  saveFile: (suggestedName, bytes) =>
    ipcRenderer.invoke("file:save", { suggestedName, bytes }),
  confirmNewProject: () => ipcRenderer.invoke("project:confirm-new"),
  onBeforeClose: (callback) => {
    const listener = async () => {
      try {
        await callback();
        ipcRenderer.send("app:ready-close", null);
      } catch (error) {
        ipcRenderer.send("app:ready-close", String(error.message || error));
      }
    };
    ipcRenderer.on("app:before-close", listener);
    return () => ipcRenderer.removeListener("app:before-close", listener);
  },
});
