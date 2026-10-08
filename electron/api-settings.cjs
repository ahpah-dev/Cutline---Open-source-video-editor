const { readFile, mkdir, writeFile, rename, rm } = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_API = { name: "9Router", baseURL: "http://localhost:20128/v1", model: "", images: false, reasoning: false };
const invalidControl = value => value.includes("\0") || /[\r\n]/.test(value);
function validateAPI(value) {
  if (!value || typeof value !== "object") throw new Error("Enter custom API settings first.");
  let url;
  try { url = new URL(value.baseURL); } catch { throw new Error("Enter a valid API base URL, including /v1."); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("Use HTTPS for remote APIs. HTTP is allowed only on localhost.");
  if (url.username || url.password || url.search || url.hash || url.href.length > 2000) throw new Error("Keep credentials and query parameters out of the API URL. Use the API key field.");
  const baseURL = url.href.replace(/\/+$/, "");
  if (/\/(chat\/completions|models|responses)$/.test(url.pathname.replace(/\/+$/, ""))) throw new Error("Enter the base URL, not /chat/completions, /models or /responses.");
  if (typeof value.model !== "string" || value.model.length > 200 || invalidControl(value.model)) throw new Error("Enter a valid model ID.");
  if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 80 || invalidControl(value.name)) throw new Error("Enter a short connection name.");
  if (value.apiKey !== undefined && (typeof value.apiKey !== "string" || value.apiKey.length > 8192 || invalidControl(value.apiKey))) throw new Error("Invalid API key. Remove line breaks and try again.");
  return { name: value.name.trim(), baseURL, model: value.model.trim(), images: value.images === true, reasoning: value.reasoning === true };
}

// Desktop preferences only: never included in project serialization or backup.
// Electron safeStorage on Windows uses DPAPI; no plaintext secret fallback.
class APISettings {
  constructor(userData, safeStorage) { this.file = path.join(userData, "custom-api.json"); this.safeStorage = safeStorage; }
  async read() {
    try {
      const text = await readFile(this.file, "utf8");
      if (text.length > 24000) throw new Error("Invalid saved API settings.");
      const data = JSON.parse(text);
      return { ...validateAPI(data), encryptedKey: typeof data.encryptedKey === "string" ? data.encryptedKey : "" };
    } catch (error) {
      if (error.code === "ENOENT") return { ...DEFAULT_API, encryptedKey: "" };
      throw new Error("Saved API settings could not be read. Forget the connection and enter it again.");
    }
  }
  async publicSettings() {
    const { encryptedKey, ...settings } = await this.read();
    return { ...settings, hasKey: !!encryptedKey, encryptionAvailable: this.safeStorage.isEncryptionAvailable() };
  }
  async resolve(value) {
    const config = validateAPI(value);
    // Never forward a saved credential to a different endpoint.
    const saved = await this.read();
    let apiKey = value.apiKey?.trim() || "";
    if (value.apiKey === undefined && saved.baseURL === config.baseURL && saved.encryptedKey) {
      if (!this.safeStorage.isEncryptionAvailable()) throw new Error("Windows credential encryption is unavailable. Enter a session-only key.");
      try { apiKey = this.safeStorage.decryptString(Buffer.from(saved.encryptedKey, "base64")); }
      catch { throw new Error("The saved API key cannot be decrypted on this Windows account. Enter it again."); }
    }
    return { ...config, apiKey };
  }
  async save(config, rememberKey) {
    const settings = validateAPI(config);
    let encryptedKey = "";
    if (rememberKey && config.apiKey) {
      if (!this.safeStorage.isEncryptionAvailable()) throw new Error("Windows credential encryption is unavailable. Turn off Remember API key.");
      encryptedKey = this.safeStorage.encryptString(config.apiKey).toString("base64");
    }
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = this.file + ".tmp";
    await writeFile(temporary, JSON.stringify({ ...settings, encryptedKey }), { mode: 0o600 });
    await rename(temporary, this.file);
    return this.publicSettings();
  }
  async forget() { await rm(this.file, { force: true }); return this.publicSettings(); }
}
module.exports = { APISettings, DEFAULT_API, validateAPI };
