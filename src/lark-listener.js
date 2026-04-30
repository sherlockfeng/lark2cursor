import { spawn } from "node:child_process";
import { sendBridgeMessage } from "./bridge-client.js";
import { createLarkCliAdapter, normalizeLarkEventToBridgeMessage } from "./lark-adapter.js";
import { resolveLarkCliCommand } from "./lark-cli-command.js";

function normalizeOptions(options) {
  if (typeof options === "function") {
    return { send: options, log: () => {} };
  }
  return {
    send: sendBridgeMessage,
    echoMessageId: false,
    lark: createLarkCliAdapter(),
    log: () => {},
    ...options
  };
}

function isMentioned(event) {
  if (Array.isArray(event.mentions) && event.mentions.length > 0) {
    return true;
  }
  const content = typeof event.content === "string" ? event.content : "";
  return content.includes("@");
}

// English command keywords are the canonical surface; the Chinese aliases on
// the right of each pattern are kept for backward compatibility with users who
// already memorised them.
const BIND_CHAT_PATTERN = /\b(bind\s+chat)\b|绑定对话/i;
const CREATE_AGENT_PATTERN = /\b(create\s+(?:cursor\s+)?agent(?:\s+chat)?)\b|创建\s*Cursor\s*Agent\s*对话/i;
const DISABLE_WAIT_PATTERN = /\b(stop|disable|pause)\s+wait(?:ing)?\b|(停止|关闭)\s*等待/i;
const UNBIND_PATTERN = /\b(?:un\s*bind|unbind)(?:\s+(?:chat|thread))?\b|解除绑定|解绑/i;
const HELP_PATTERN = /(?:^|\s)(?:\/help|help|帮助)\s*$/i;

function isBindCommand(event) {
  const content = typeof event.content === "string" ? event.content : "";
  return isMentioned(event) && BIND_CHAT_PATTERN.test(content);
}

function isAgentCommand(event) {
  const content = typeof event.content === "string" ? event.content : "";
  return isMentioned(event) && CREATE_AGENT_PATTERN.test(content);
}

function isDisableWaitCommand(event) {
  const content = typeof event.content === "string" ? event.content : "";
  return isMentioned(event) && DISABLE_WAIT_PATTERN.test(content);
}

function isUnbindCommand(event) {
  const content = typeof event.content === "string" ? event.content : "";
  return isMentioned(event) && UNBIND_PATTERN.test(content);
}

function isHelpCommand(message, event) {
  const text = String(message.text || event?.content || "").trim();
  return text === "/help" || (isMentioned(event) && HELP_PATTERN.test(text));
}

function toCreateBindMessage(message) {
  return {
    type: "lark_create_bind",
    chat_id: message.chat_id,
    thread_id: message.thread_id,
    reply_message_id: message.reply_message_id || message.message_id,
    code: message.message_id
  };
}

function toCreateAgentBindMessage(message) {
  return {
    type: "lark_create_agent_bind",
    chat_id: message.chat_id,
    thread_id: message.thread_id,
    reply_message_id: message.reply_message_id || message.message_id
  };
}

function toDisableWaitMessage(message) {
  return {
    type: "lark_disable_wait",
    chat_id: message.chat_id,
    thread_id: message.thread_id,
    reply_message_id: message.reply_message_id || message.message_id
  };
}

function toUnbindMessage(message) {
  return {
    type: "lark_unbind_thread",
    chat_id: message.chat_id,
    thread_id: message.thread_id,
    reply_message_id: message.reply_message_id || message.message_id
  };
}

function buildHelpText() {
  return [
    "**agent2lark commands**",
    "",
    "**Binding**",
    "- `bind chat` - create an IDE Chat Relay bind code. Then send `bind lark thread message_id: <message_id>` in the target Cursor chat.",
    "- `unbind` / `un bind` - remove this Lark thread's current relay binding.",
    "",
    "**Waiting**",
    "- `stop wait` / `disable wait` / `pause wait` - disable the IDE Chat continuous-wait loop for this thread.",
    "",
    "**Approvals**",
    "- `/allow` / `/deny` - approve or deny the latest pending request once.",
    "- `/allow <request_id>` / `/deny <request_id>` - approve or deny a specific request.",
    "- `/allow!` / `/deny!` - approve or deny and remember the inferred scope.",
    "- `/allow pnpm!` - remember all `pnpm ...` Shell commands.",
    "- `/allow shell node!` - remember all `node ...` Shell commands.",
    "- `/allow shell!` - remember all Shell commands.",
    "- `/allow write!` / `/allow read!` / `/allow edit!` - remember tool-scoped file actions.",
    "- `/allow mcp__server__tool!` - remember one exact MCP tool.",
    "",
    "Chinese aliases still work for binding and wait commands."
  ].join("\n");
}

const APPROVAL_COMMAND_PATTERN = /(?:^|\s)\/(?:cursor[:\s]+)?(allow|deny)(!)?(?:\s+(.+?))?\s*$/i;
const TOOL_SCOPE_ALIASES = new Map([
  ["shell", "Shell"],
  ["bash", "Shell"],
  ["write", "Write"],
  ["read", "ReadFile"],
  ["readfile", "ReadFile"],
  ["read-file", "ReadFile"],
  ["edit", "Edit"],
  ["delete", "Delete"],
  ["applypatch", "ApplyPatch"],
  ["apply-patch", "ApplyPatch"],
  ["multiedit", "MultiEdit"],
  ["multi-edit", "MultiEdit"]
]);
const COMMAND_SCOPE_ALIASES = new Set(["pnpm", "npm", "yarn", "bun"]);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_]+$/;
const COMMAND_PREFIX_PATTERN = /^[A-Za-z0-9_.:-]+$/;

export function looksLikeApprovalCommand(text) {
  return /\/(allow|deny)\b/i.test(String(text || ""));
}

function normalizeMcpToolScope(target) {
  const text = String(target || "").trim();
  if (!text) return "";
  if (text.startsWith("mcp__")) return text;
  if (text.startsWith("MCP:")) {
    return `mcp__${text.slice(4).trim().replace(/[^\w.-]+/g, "__")}`;
  }
  return "";
}

function toApprovalCommandMessage(message) {
  const text = String(message.text || "").trim();
  const match = text.match(APPROVAL_COMMAND_PATTERN);
  if (!match) return undefined;

  const [, decisionRaw, bangAfterDecision, targetRaw] = match;
  const targetParts = String(targetRaw || "").trim().split(/\s+/).filter(Boolean);
  let bangAfterTarget = false;
  if (targetParts.length > 0 && targetParts[targetParts.length - 1].endsWith("!")) {
    bangAfterTarget = true;
    targetParts[targetParts.length - 1] = targetParts[targetParts.length - 1].slice(0, -1);
  }
  const target = targetParts.join(" ");
  const firstTarget = targetParts[0] || "";
  const secondTarget = targetParts[1] || "";
  const explicitMcpToolScope = targetParts.length === 1 ? normalizeMcpToolScope(firstTarget) : "";
  const toolScope = targetParts.length === 1
    ? explicitMcpToolScope || TOOL_SCOPE_ALIASES.get(firstTarget.toLowerCase())
    : "";
  const explicitTool = TOOL_SCOPE_ALIASES.get(firstTarget.toLowerCase());
  const commandScope = targetParts.length === 1 && COMMAND_SCOPE_ALIASES.has(firstTarget.toLowerCase())
    ? firstTarget.toLowerCase()
    : explicitTool === "Shell" && COMMAND_PREFIX_PATTERN.test(secondTarget)
      ? secondTarget
      : "";
  const payload = {
    type: "lark_approval_decision",
    decision: decisionRaw.toLowerCase(),
    remember: Boolean(bangAfterDecision || bangAfterTarget),
    chat_id: message.chat_id,
    thread_id: message.thread_id,
    message_id: message.message_id
  };
  if (toolScope) {
    payload.tool_scope = toolScope;
  } else if (commandScope) {
    payload.command_scope = commandScope;
  } else if (target && REQUEST_ID_PATTERN.test(target)) {
    payload.request_id = target;
  } else if (target) {
    return undefined;
  }
  return payload;
}

function buildApprovalAckText(response) {
  if (response?.tool_scope) {
    const count = Number(response.count || 0);
    const plural = count === 1 ? "approval" : "approvals";
    const verb = response?.decision === "deny" ? "denied" : "allowed";
    return `${count} pending ${response.tool_scope} ${plural} ${verb} successfully.`;
  }
  if (response?.command_scope) {
    const count = Number(response.count || 0);
    const plural = count === 1 ? "approval" : "approvals";
    const verb = response?.decision === "deny" ? "denied" : "allowed";
    return `${count} pending ${response.command_scope} ${plural} ${verb} successfully.`;
  }
  const requestId = response?.request_id ? ` ${response.request_id}` : "";
  const verb = response?.decision === "deny" ? "denied" : "allowed";
  return `Approval${requestId} ${verb} successfully.`;
}

function buildApprovalMissText(response) {
  if (response?.reason === "multiple_pending") {
    return "Multiple pending approvals matched this chat. Include the request id (for example: /allow <request_id>) or use a scoped command such as /allow shell! or /allow pnpm!.";
  }
  return "No pending approval matched. Include the request id (for example: /allow <request_id>) or use a scoped command such as /allow shell! or /allow pnpm!.";
}

async function resolveCommandThreadFromLark(message, event, lark, log) {
  const shouldResolve = isMentioned(event)
    || looksLikeApprovalCommand(message.text)
    || isHelpCommand(message, event);
  if (!shouldResolve || typeof lark?.getMessageThreadId !== "function") {
    return message;
  }
  const resolvedThreadId = await lark.getMessageThreadId(message.message_id);
  if (!resolvedThreadId || resolvedThreadId === message.thread_id) {
    return message;
  }
  log?.(`[lark-listen] resolved thread via mget msg=${message.message_id} thread=${resolvedThreadId}`);
  return {
    ...message,
    thread_id: resolvedThreadId
  };
}

function isCardActionEvent(event) {
  return event && (event.type === "card.action.trigger" || event.event_type === "card.action.trigger");
}

function readCardActionValue(event) {
  const fromV2 = event?.event?.action?.value;
  if (fromV2 && typeof fromV2 === "object") return fromV2;
  const fromCompact = event?.action?.value;
  if (fromCompact && typeof fromCompact === "object") return fromCompact;
  return undefined;
}

function toApprovalDecisionMessage(event) {
  const value = readCardActionValue(event);
  if (!value || typeof value.req !== "string") return undefined;
  if (value.decision !== "allow" && value.decision !== "deny" && value.decision !== "ask") return undefined;

  const operatorId = event?.event?.operator?.open_id || event?.operator?.open_id || "";
  const chatId = event?.event?.context?.open_chat_id || event?.open_chat_id || event?.chat_id || "";
  const messageId = event?.event?.context?.open_message_id || event?.open_message_id || event?.message_id || "";

  return {
    type: "lark_approval_decision",
    request_id: value.req,
    decision: value.decision,
    remember: Boolean(value.remember),
    operator_open_id: operatorId,
    chat_id: chatId,
    message_id: messageId
  };
}

export async function handleLarkEventLine(line, options = sendBridgeMessage) {
  const { send, echoMessageId, lark, log } = normalizeOptions(options);
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return false;
  }

  if (isCardActionEvent(event)) {
    const decision = toApprovalDecisionMessage(event);
    if (!decision) return false;
    await send(decision);
    return true;
  }

  let message = normalizeLarkEventToBridgeMessage(event);
  if (!message) {
    return false;
  }
  message = await resolveCommandThreadFromLark(message, event, lark, log);
  log(`[lark-listen] normalized type=${message.type} chat=${message.chat_id || ""} thread=${message.thread_id || ""} msg=${message.message_id || ""}`);

  const approvalCommand = toApprovalCommandMessage(message);
  if (approvalCommand) {
    const response = await send(approvalCommand);
    if (typeof lark?.sendThreadMessage === "function") {
      await lark.sendThreadMessage({
        chatId: message.chat_id,
        threadId: message.thread_id,
        replyMessageId: message.reply_message_id || message.message_id,
        text: response?.ok ? buildApprovalAckText(response) : buildApprovalMissText(response)
      });
    }
    return true;
  }

  if (looksLikeApprovalCommand(message.text)) {
    log(`[lark-listen] approval-like text not matched, dropping into chat queue: ${JSON.stringify(message.text).slice(0, 240)}`);
  }

  if (isHelpCommand(message, event)) {
    await lark.sendThreadMessage({
      chatId: message.chat_id,
      threadId: message.thread_id,
      replyMessageId: message.reply_message_id || message.message_id,
      text: buildHelpText()
    });
    return true;
  }

  if (isBindCommand(event)) {
    await send(toCreateBindMessage(message));
    await lark.sendThreadMessage({
      chatId: message.chat_id,
      threadId: message.thread_id,
      replyMessageId: message.reply_message_id || message.message_id,
      text: `message_id: ${message.message_id}`
    });
    return true;
  }

  if (isAgentCommand(event)) {
    await send(toCreateAgentBindMessage(message));
    await lark.sendThreadMessage({
      chatId: message.chat_id,
      threadId: message.thread_id,
      replyMessageId: message.reply_message_id || message.message_id,
      text: "Cursor Agent chat created. @ the bot in this thread to keep the conversation going."
    });
    return true;
  }

  if (isUnbindCommand(event)) {
    const response = await send(toUnbindMessage(message));
    await lark.sendThreadMessage({
      chatId: message.chat_id,
      threadId: message.thread_id,
      replyMessageId: message.reply_message_id || message.message_id,
      text: response?.removed
        ? "This Lark thread is now unbound."
        : "No active binding was found for this Lark thread."
    });
    return true;
  }

  if (isDisableWaitCommand(event)) {
    await send(toDisableWaitMessage(message));
    await lark.sendThreadMessage({
      chatId: message.chat_id,
      threadId: message.thread_id,
      replyMessageId: message.reply_message_id || message.message_id,
      text: "Continuous Cursor Chat waiting disabled for this thread."
    });
    return true;
  }

  await send(message);
  if (echoMessageId && isMentioned(event)) {
    await lark.sendThreadMessage({
      chatId: message.chat_id,
      threadId: message.thread_id,
      replyMessageId: message.reply_message_id || message.message_id,
      text: `message_id: ${message.message_id}`
    });
  }
  return true;
}

export function startLarkEventListener(options = {}) {
  const command = resolveLarkCliCommand(options);
  const args = options.args || [
    "event",
    "+subscribe",
    "--event-types",
    "im.message.receive_v1,card.action.trigger",
    "--compact",
    "--quiet",
    "--as",
    "bot"
  ];
  const spawnProcess = options.spawnProcess || spawn;
  const send = options.send || ((message) => sendBridgeMessage(message, { socketPath: options.socketPath }));
  const lark = options.lark || createLarkCliAdapter(options);
  const log = options.log || ((message) => process.stdout.write(`${message}\n`));
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const respawnDelayMs = Number(options.respawnDelayMs ?? 1000);
  const echoMessageId = Boolean(options.echoMessageId);

  let stopped = false;
  let currentChild;

  const spawnOnce = () => {
    const child = spawnProcess(command, args, {
      stdio: ["ignore", "pipe", "inherit"]
    });
    currentChild = child;
    let buffer = "";

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          const messageId = parsed.message_id || parsed.messageId || "";
          const chatId = parsed.chat_id || parsed.chatId || "";
          log(`[lark-listen] event chat=${chatId} msg=${messageId}`);
        } catch {
          log(`[lark-listen] non-json line: ${line.slice(0, 200)}`);
        }
        if (process.env.AGENT2LARK_LOG_RAW_EVENTS === "1") {
          log(`[lark-listen] raw line: ${line.slice(0, 800)}`);
        }
        handleLarkEventLine(line, {
          send,
          lark,
          echoMessageId,
          log
        }).catch((error) => {
          log(`[lark-listen] forward error: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    });

    child.on("exit", async (code, signal) => {
      log(`[lark-listen] lark-cli child exited code=${code} signal=${signal}`);
      if (stopped) return;
      await sleep(respawnDelayMs);
      if (stopped) return;
      log(`[lark-listen] respawning lark-cli child`);
      spawnOnce();
    });

    return child;
  };

  spawnOnce();

  return {
    get child() {
      return currentChild;
    },
    stop() {
      stopped = true;
      if (currentChild && typeof currentChild.kill === "function") {
        currentChild.kill();
      }
    }
  };
}
