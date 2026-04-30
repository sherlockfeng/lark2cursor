import fs from "node:fs";
import path from "node:path";
import { DEFAULT_RUNTIME_CONFIG_PATH } from "./constants.js";

// Built-in defaults applied when neither the config file nor an env var
// supplies a value. Keep this object flat-and-friendly so users can edit the
// generated file in place.
export const RUNTIME_CONFIG_DEFAULTS = Object.freeze({
  thinkingIntervalMs: 60_000,
  progressRelayEnabled: true
});

function readFile(configPath) {
  try {
    if (!fs.existsSync(configPath)) return {};
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function pickPositiveNumber(...candidates) {
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === "") continue;
    const num = Number(candidate);
    if (Number.isFinite(num) && num >= 0) return num;
  }
  return undefined;
}

function pickBoolean(...candidates) {
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === "") continue;
    if (typeof candidate === "boolean") return candidate;
    const text = String(candidate).trim().toLowerCase();
    if (["1", "true", "yes", "on", "enabled"].includes(text)) return true;
    if (["0", "false", "no", "off", "disabled"].includes(text)) return false;
  }
  return undefined;
}

// Resolve the effective runtime config. Precedence: env var > config file >
// built-in default. Env wins so an ad-hoc override (e.g. when running tests)
// stays predictable, while the file gives users a stable place to keep their
// preferences across restarts.
export function readRuntimeConfig({
  configPath = DEFAULT_RUNTIME_CONFIG_PATH,
  env = process.env
} = {}) {
  const fileConfig = readFile(configPath);
  const config = { ...RUNTIME_CONFIG_DEFAULTS };

  const thinking = pickPositiveNumber(
    env.AGENT2LARK_THINKING_INTERVAL_MS,
    fileConfig.thinkingIntervalMs
  );
  if (thinking !== undefined) {
    config.thinkingIntervalMs = thinking;
  }

  const progressRelayEnabled = pickBoolean(
    env.AGENT2LARK_PROGRESS_RELAY,
    fileConfig.progressRelayEnabled
  );
  if (progressRelayEnabled !== undefined) {
    config.progressRelayEnabled = progressRelayEnabled;
  }

  return config;
}

// Create the config file with documented defaults if it does not exist yet.
// Returns true when the file was just written, false when it already existed.
export function ensureRuntimeConfigFile({
  configPath = DEFAULT_RUNTIME_CONFIG_PATH
} = {}) {
  if (fs.existsSync(configPath)) return false;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const body = `${JSON.stringify(RUNTIME_CONFIG_DEFAULTS, null, 2)}\n`;
  fs.writeFileSync(configPath, body, "utf8");
  return true;
}
