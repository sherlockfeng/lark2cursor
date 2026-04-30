import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SOURCE = "cursor";
export const DEFAULT_BRIDGE_SOCKET_PATH = path.join(os.homedir(), ".agent2lark", "cursor-relay.sock");
export const DEFAULT_RELAY_STATE_PATH = path.join(os.homedir(), ".agent2lark", "cursor-relay-state.json");
export const DEFAULT_RELAY_RUNTIME_PATH = path.join(os.homedir(), ".agent2lark", "cursor-relay-runtime.json");
export const DEFAULT_APPROVAL_POLICY_PATH = path.join(os.homedir(), ".agent2lark", "cursor-approval-policy.json");
export const DEFAULT_RUNTIME_CONFIG_PATH = path.join(os.homedir(), ".agent2lark", "config.json");
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const HOOK_BIN_PATH = path.join(PROJECT_ROOT, "bin", "agent2lark-cursor-hook.js");
export const BRIDGE_BIN_PATH = path.join(PROJECT_ROOT, "bin", "agent2lark-cursor-bridge.js");
export const USER_CURSOR_DIR = path.join(os.homedir(), ".cursor");
export const USER_HOOKS_PATH = path.join(USER_CURSOR_DIR, "hooks.json");
export const MARKER = "agent2lark-cursor-hook";

export const DEFAULT_EVENTS = [
  "beforeShellExecution",
  "beforeMCPExecution",
  "preToolUse"
];

export const RELAY_EVENTS = [
  "sessionStart",
  "beforeSubmitPrompt",
  "afterAgentResponse",
  "postToolUse",
  "postToolUseFailure",
  "afterShellExecution",
  "stop"
];
