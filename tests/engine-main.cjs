const { app, BrowserWindow } = require("electron");
const { readFile, writeFile } = require("node:fs/promises");
const path = require("node:path");
app.setPath("userData", path.resolve("work/engine-profile"));
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  window.webContents.on("console-message", (_event, _level, message) =>
    process.stdout.write(String(message) + "\n"),
  );
  const timeout = setTimeout(() => {
    process.stderr.write("Rendering tests timed out\n");
    app.exit(1);
  }, 90000);
  try {
    await window.loadFile(path.resolve("tests/engine.html"));
    await window.webContents.executeJavaScript(
      await readFile("work/engine-tests/engine.js", "utf8"),
    );
    const result =
      await window.webContents.executeJavaScript(process.env.CUTLINE_ENGINE_SUITE === "scenes" ? "runSceneTests()" : "runEngineTests()");
    await writeFile(
      process.env.CUTLINE_ENGINE_SUITE === "scenes" ? "work/scene-engine-results.json" : "work/engine-results.json",
      JSON.stringify(result, null, 2),
    );
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    clearTimeout(timeout);
    app.exit(result.failures.length ? 1 : 0);
  } catch (error) {
    process.stderr.write(String(error.stack) + "\n");
    clearTimeout(timeout);
    app.exit(1);
  }
});
