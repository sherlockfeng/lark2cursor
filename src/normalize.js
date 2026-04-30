import fs from "node:fs";
import path from "node:path";

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return "";
}

function firstObject(...values) {
  for (const value of values) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value;
    }
  }
  return {};
}

function normalizeToolName(name) {
  if (!name) {
    return "unknown";
  }

  if (name.startsWith("MCP:")) {
    return `mcp__${name.slice(4).trim().replace(/[^\w.-]+/g, "__")}`;
  }

  return name;
}

function getCursorEvent(input, explicitEvent) {
  return firstString(
    explicitEvent,
    input.hook_event_name,
    input.hookEventName,
    input.event_name,
    input.eventName,
    input.event,
    input.type
  );
}

function normalizeEventName(event) {
  return String(event || "").toLowerCase();
}

function getCwd(input) {
  return firstString(
    input.cwd,
    input.working_directory,
    input.workingDirectory,
    input.workspace_path,
    input.workspacePath,
    input.project_root,
    input.projectRoot,
    process.cwd()
  );
}

function getSessionId(input) {
  return firstString(
    input.session_id,
    input.sessionId,
    input.conversation_id,
    input.conversationId,
    input.thread_id,
    input.threadId,
    process.env.CURSOR_SESSION_ID
  );
}

function getPrompt(input) {
  return firstString(input.prompt, input.message, input.text);
}

function getAssistantText(input) {
  return firstString(input.text, input.agent_message, input.assistant_message, input.response);
}

function buildShellInput(input) {
  const nested = firstObject(input.tool_input, input.toolInput, input.input);
  const command = firstString(
    input.command,
    input.shell_command,
    input.shellCommand,
    nested.command
  );

  return {
    toolName: "Shell",
    toolInput: {
      command,
      description: firstString(input.description, nested.description),
      working_directory: getCwd(input)
    }
  };
}

function buildMcpInput(input) {
  const nested = firstObject(input.tool_input, input.toolInput, input.input);
  const args = firstObject(input.arguments, input.args, nested.arguments, nested.args, nested.input);
  const server = firstString(input.server, input.serverName, input.mcp_server, nested.server, nested.serverName);
  const tool = firstString(input.toolName, input.tool_name, input.name, input.tool, nested.toolName, nested.name);
  const suffix = [server, tool].filter(Boolean).join("__").replace(/[^\w.-]+/g, "__");

  return {
    toolName: suffix ? `mcp__${suffix}` : "mcp__unknown",
    toolInput: {
      server,
      tool,
      arguments: args
    }
  };
}

function buildGenericToolInput(input) {
  const nested = firstObject(input.tool_input, input.toolInput, input.input);
  const rawToolName = firstString(
    input.tool_name,
    input.toolName,
    input.name,
    input.tool,
    input.toolType,
    nested.tool_name,
    nested.toolName,
    nested.name
  );

  return {
    toolName: normalizeToolName(rawToolName),
    toolInput: firstObject(input.tool_input, input.toolInput, input.input, input.arguments, input.args)
  };
}

export function isRiskyPreToolUse(toolName) {
  return /^(Bash|Shell|Write|Edit|Delete|ApplyPatch|MultiEdit)$/i.test(toolName)
    || /^mcp__/i.test(toolName)
    || /^MCP:/i.test(toolName);
}

const PATH_BASED_TOOLS = new Set([
  "Write",
  "Edit",
  "Delete",
  "ApplyPatch",
  "MultiEdit"
]);
const PACKAGE_MANAGER_COMMANDS = new Set(["pnpm", "npm", "yarn", "bun"]);

export function isPathBasedTool(toolName) {
  return PATH_BASED_TOOLS.has(String(toolName || ""));
}

function ensureTrailingSlash(value) {
  const text = String(value || "");
  if (!text) return "";
  return text.endsWith("/") ? text : `${text}/`;
}

function absolutePathFromCommand(command = "") {
  const text = String(command || "").trim();
  if (!text) return "";
  if (path.isAbsolute(text)) return text;
  const firstToken = text.split(/\s+/, 1)[0] || "";
  return path.isAbsolute(firstToken) ? firstToken : "";
}

function safeIsDirectory(targetPath) {
  try {
    return fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function hasProjectMarker(directory) {
  return [
    ".git",
    "package.json",
    "pnpm-workspace.yaml",
    "yarn.lock",
    "package-lock.json",
    "pyproject.toml",
    "go.mod",
    "Cargo.toml"
  ].some((marker) => fs.existsSync(path.join(directory, marker)));
}

function findProjectRootForPath(targetPath) {
  const absolutePath = absolutePathFromCommand(targetPath);
  if (!absolutePath) return "";

  let current = safeIsDirectory(absolutePath) ? absolutePath : path.dirname(absolutePath);
  while (current && current !== path.dirname(current)) {
    if (hasProjectMarker(current)) return current;
    current = path.dirname(current);
  }
  return "";
}

const PATH_FIELD_NAMES = [
  "path",
  "target_file",
  "targetFile",
  "file_path",
  "filePath",
  "filepath",
  "absolute_path",
  "absolutePath",
  "notebook_path",
  "notebookPath",
  "target",
  "uri"
];
const PATH_COLLECTION_FIELD_NAMES = ["edits", "changes", "files", "operations", "items"];

function pathFromPatchText(value) {
  const text = String(value || "");
  if (!text) return "";
  for (const line of text.split(/\r?\n/)) {
    const applyPatchMatch = line.match(/^\*\*\* (?:Add|Update|Delete) File:\s+(.+)$/);
    if (applyPatchMatch) return applyPatchMatch[1].trim();
    const unifiedDiffMatch = line.match(/^(?:---|\+\+\+)\s+(?:[ab]\/)?(.+)$/);
    if (unifiedDiffMatch) {
      const candidate = unifiedDiffMatch[1].trim();
      if (candidate && candidate !== "/dev/null") return candidate;
    }
  }
  return "";
}

function firstPathFromToolInput(value, seen = new Set()) {
  if (!value || typeof value !== "object") return "";
  if (seen.has(value)) return "";
  seen.add(value);

  const direct = firstString(...PATH_FIELD_NAMES.map((field) => value[field]));
  if (direct) return direct;

  const patchPath = pathFromPatchText(firstString(value.patch, value.diff));
  if (patchPath) return patchPath;

  for (const field of PATH_COLLECTION_FIELD_NAMES) {
    const nested = value[field];
    if (Array.isArray(nested)) {
      for (const item of nested) {
        const nestedPath = firstPathFromToolInput(item, seen);
        if (nestedPath) return nestedPath;
      }
    } else {
      const nestedPath = firstPathFromToolInput(nested, seen);
      if (nestedPath) return nestedPath;
    }
  }

  return "";
}

// Decide what scope a `/allow!` / `/deny!` rule should remember for a given
// approval request. Path-based tools (Write/Edit/Delete/...) remember by the
// session's project root so the user does not have to /allow! every single
// file. Shell commands remember a command prefix; MCP tools remember the exact
// MCP tool name because their arguments are often empty or volatile JSON.
export function inferRuleScope({ tool, command, cwd } = {}) {
  if (String(tool || "").startsWith("mcp__")) {
    return { commandPrefix: "", pathPrefix: "", toolScope: true };
  }
  if (isPathBasedTool(tool)) {
    const projectRoot = findProjectRootForPath(command) || cwd;
    if (projectRoot) {
      return { pathPrefix: ensureTrailingSlash(projectRoot), commandPrefix: "" };
    }
  }
  const tokens = String(command || "").trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { commandPrefix: "", pathPrefix: "" };
  if ((tool === "Shell" || tool === "Bash") && PACKAGE_MANAGER_COMMANDS.has(tokens[0])) {
    return { commandPrefix: tokens[0], pathPrefix: "" };
  }
  if (tokens.length === 1) return { commandPrefix: tokens[0], pathPrefix: "" };
  return { commandPrefix: `${tokens[0]} ${tokens[1]}`, pathPrefix: "" };
}

function getToolCommand(toolName, toolInput) {
  if (!toolInput) return "";
  if (toolName === "Shell" || toolName === "Bash") {
    return firstString(toolInput.command);
  }
  if (toolName.startsWith("mcp__")) {
    const args = toolInput.arguments;
    return args ? JSON.stringify(args) : "";
  }
  return firstPathFromToolInput(toolInput);
}

function getDurationMs(input) {
  const value = input.duration_ms ?? input.durationMs ?? input.duration;
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : 0;
}

function getExitCode(input) {
  const value = input.exit_code ?? input.exitCode ?? input.code;
  if (value === undefined || value === null || value === "") return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

export function isRelayEvent(event) {
  return [
    "sessionstart",
    "beforesubmitprompt",
    "afteragentresponse",
    "posttooluse",
    "posttoolusefailure",
    "aftershellexecution",
    "stop"
  ].includes(normalizeEventName(event));
}

export function toRelayMessage(input, explicitEvent) {
  const cursorEvent = getCursorEvent(input, explicitEvent);
  const lowerEvent = normalizeEventName(cursorEvent);
  const base = {
    session_id: getSessionId(input),
    cwd: getCwd(input)
  };

  if (lowerEvent === "sessionstart") {
    return {
      type: "cursor_session_start",
      ...base,
      composer_mode: firstString(input.composer_mode, input.composerMode)
    };
  }

  if (lowerEvent === "beforesubmitprompt") {
    return {
      type: "cursor_prompt_submit",
      ...base,
      prompt: getPrompt(input)
    };
  }

  if (lowerEvent === "afteragentresponse") {
    return {
      type: "cursor_agent_response",
      ...base,
      text: getAssistantText(input)
    };
  }

  if (lowerEvent === "stop") {
    return {
      type: "cursor_stop",
      ...base,
      loop_count: Number(input.loop_count ?? input.loopCount ?? 0),
      status: firstString(input.status)
    };
  }

  if (lowerEvent === "aftershellexecution") {
    const exitCode = getExitCode(input);
    return {
      type: "cursor_progress",
      ...base,
      phase: exitCode && exitCode !== 0 ? "failed" : "completed",
      tool: "Shell",
      command: firstString(input.command, input.shell_command, input.shellCommand),
      exit_code: exitCode,
      duration_ms: getDurationMs(input)
    };
  }

  if (lowerEvent === "posttooluse" || lowerEvent === "posttoolusefailure") {
    const mapped = buildGenericToolInput(input);
    return {
      type: "cursor_progress",
      ...base,
      phase: lowerEvent === "posttoolusefailure" ? "failed" : "completed",
      tool: mapped.toolName,
      command: getToolCommand(mapped.toolName, mapped.toolInput),
      exit_code: getExitCode(input),
      duration_ms: getDurationMs(input)
    };
  }

  return {
    type: "unknown",
    ...base,
    hook_event_name: cursorEvent
  };
}

export function toApprovalRequest(input, explicitEvent) {
  const cursorEvent = getCursorEvent(input, explicitEvent);
  const lowerEvent = normalizeEventName(cursorEvent);
  let mapped;
  let kind;

  if (lowerEvent === "beforeshellexecution") {
    kind = "shell";
    mapped = buildShellInput(input);
  } else if (lowerEvent === "beforemcpexecution") {
    kind = "mcp";
    mapped = buildMcpInput(input);
  } else {
    kind = "tool";
    mapped = buildGenericToolInput(input);
  }

  return {
    type: "cursor_approval_request",
    kind,
    session_id: getSessionId(input),
    cwd: getCwd(input),
    tool: mapped.toolName,
    command: getToolCommand(mapped.toolName, mapped.toolInput),
    payload: mapped.toolInput,
    permission_mode: firstString(input.permission_mode, input.permissionMode),
    hook_event_name: cursorEvent || "preToolUse"
  };
}
