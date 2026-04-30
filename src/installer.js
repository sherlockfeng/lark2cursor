import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  BRIDGE_BIN_PATH,
  DEFAULT_BRIDGE_SOCKET_PATH,
  DEFAULT_EVENTS,
  DEFAULT_RELAY_STATE_PATH,
  DEFAULT_APPROVAL_POLICY_PATH,
  HOOK_BIN_PATH,
  MARKER,
  RELAY_EVENTS,
  USER_CURSOR_DIR,
  USER_HOOKS_PATH
} from "./constants.js";
import { resolveLarkCliCommand } from "./lark-cli-command.js";

function quote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function hookCommand(event) {
  return `${quote(process.execPath)} ${quote(HOOK_BIN_PATH)} --event ${quote(event)}`;
}

function readHooksConfig(hooksPath = USER_HOOKS_PATH) {
  if (!fs.existsSync(hooksPath)) {
    return { version: 1, hooks: {} };
  }

  const config = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`${hooksPath} must contain a JSON object`);
  }

  if (config.version === undefined) {
    config.version = 1;
  }

  if (!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks)) {
    config.hooks = {};
  }

  return config;
}

function writeHooksConfig(config, hooksPath = USER_HOOKS_PATH) {
  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  fs.writeFileSync(hooksPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function hasAgent2LarkCursorHook(entry) {
  return typeof entry?.command === "string" && entry.command.includes(MARKER);
}

function removeFromEvent(config, event) {
  if (!Array.isArray(config.hooks[event])) {
    return;
  }

  config.hooks[event] = config.hooks[event].filter((entry) => !hasAgent2LarkCursorHook(entry));
  if (config.hooks[event].length === 0) {
    delete config.hooks[event];
  }
}

function desiredHook(event, options = {}) {
  const hook = {
    command: hookCommand(event),
    timeout: options.timeoutSeconds || 86400,
    failClosed: Boolean(options.failClosed)
  };

  if (event === "preToolUse") {
    hook.matcher = "Shell|Bash|Write|Edit|Delete|ApplyPatch|MultiEdit|MCP:.*|mcp__.*";
  }
  if (event === "stop") {
    hook.loop_limit = null;
  }

  return hook;
}

export function installCursorHooks(options = {}) {
  const hooksPath = options.hooksPath || USER_HOOKS_PATH;
  const defaultEvents = options.relay ? [...DEFAULT_EVENTS, ...RELAY_EVENTS] : DEFAULT_EVENTS;
  const events = options.events?.length ? options.events : defaultEvents;
  const config = readHooksConfig(hooksPath);

  for (const event of events) {
    removeFromEvent(config, event);
    if (!Array.isArray(config.hooks[event])) {
      config.hooks[event] = [];
    }
    config.hooks[event].push(desiredHook(event, options));
  }

  writeHooksConfig(config, hooksPath);
  return { hooksPath, events };
}

export function uninstallCursorHooks(options = {}) {
  const hooksPath = options.hooksPath || USER_HOOKS_PATH;
  const config = readHooksConfig(hooksPath);
  const events = options.events?.length ? options.events : Object.keys(config.hooks);

  for (const event of events) {
    removeFromEvent(config, event);
  }

  writeHooksConfig(config, hooksPath);
  return { hooksPath, events };
}

export function doctor() {
  return {
    node: process.version,
    cursorDir: USER_CURSOR_DIR,
    hooksPath: USER_HOOKS_PATH,
    hookBinPath: HOOK_BIN_PATH,
    hookBinExists: fs.existsSync(HOOK_BIN_PATH),
    bridgeBinPath: BRIDGE_BIN_PATH,
    bridgeBinExists: fs.existsSync(BRIDGE_BIN_PATH),
    bridgeSocketPath: process.env.AGENT2LARK_BRIDGE_SOCKET || DEFAULT_BRIDGE_SOCKET_PATH,
    bridgeSocketExists: fs.existsSync(process.env.AGENT2LARK_BRIDGE_SOCKET || DEFAULT_BRIDGE_SOCKET_PATH),
    larkCliCommand: resolveLarkCliCommand(),
    relayStatePath: process.env.AGENT2LARK_RELAY_STATE || DEFAULT_RELAY_STATE_PATH,
    approvalPolicyPath: process.env.AGENT2LARK_APPROVAL_POLICY || DEFAULT_APPROVAL_POLICY_PATH
  };
}
