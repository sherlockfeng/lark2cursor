import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function createBindCode() {
  return crypto.randomBytes(4).toString("hex");
}

export function createConsoleLarkAdapter(output = process.stdout) {
  return {
    async sendThreadMessage({ chatId, threadId, replyMessageId, text, format = "markdown" }) {
      output.write(`${JSON.stringify({
        type: "lark_thread_message",
        chat_id: chatId,
        thread_id: threadId,
        reply_message_id: replyMessageId,
        format,
        text
      })}\n`);
    },
    async addReaction({ messageId, emoji = "EYES" }) {
      output.write(`${JSON.stringify({
        type: "lark_reaction",
        message_id: messageId,
        emoji
      })}\n`);
    },
    async sendApprovalCard({ threadId, replyMessageId, requestId, tool, command, payload, scope }) {
      output.write(`${JSON.stringify({
        type: "lark_approval_card",
        thread_id: threadId,
        reply_message_id: replyMessageId,
        request_id: requestId,
        tool,
        command,
        payload,
        scope
      })}\n`);
    },
    async sendApprovalPrompt({ threadId, replyMessageId, requestId, tool, command, scope }) {
      output.write(`${JSON.stringify({
        type: "lark_approval_prompt",
        thread_id: threadId,
        reply_message_id: replyMessageId,
        request_id: requestId,
        tool,
        command,
        scope
      })}\n`);
    }
  };
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return "";
}

function tryUnwrapJsonText(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return "";
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.text === "string") return parsed.text;
      if (typeof parsed.content === "string") return parsed.content;
    }
  } catch {
    return "";
  }
  return "";
}

function stripLarkMarkup(text) {
  if (!text) return "";
  let out = String(text);
  out = out.replace(/<at\b[^>]*>([\s\S]*?)<\/at>/gi, (_, inner) => `@${String(inner).trim()}`);
  out = out.replace(/<at_all\b[^>]*\/?>/gi, "@all");
  out = out.replace(/<at\b[^>]*\/>/gi, "");
  return out;
}

export function extractLarkEventText(event) {
  if (!event) return "";
  const candidates = [event.text, event.content];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const fromJson = tryUnwrapJsonText(candidate);
    const stripped = stripLarkMarkup(fromJson || candidate).trim();
    if (stripped) return stripped;
  }
  return "";
}

export function normalizeLarkEventToBridgeMessage(event) {
  if (!event || typeof event !== "object" || event.type !== "im.message.receive_v1") {
    return undefined;
  }

  const chatId = firstString(event.chat_id, event.chatId);
  const messageId = firstString(event.message_id, event.messageId, event.id);
  const threadId = firstString(event.root_id, event.rootId, event.parent_id, event.parentId, event.thread_id, event.threadId, messageId);
  const text = extractLarkEventText(event);
  if (!chatId || !messageId || !threadId || !text) {
    return undefined;
  }

  return {
    type: "lark_message",
    chat_id: chatId,
    thread_id: threadId,
    message_id: messageId,
    reply_message_id: firstString(event.reply_message_id, event.replyMessageId, event.root_id, event.rootId, event.parent_id, event.parentId, messageId),
    text
  };
}

export function createLarkCliAdapter(options = {}) {
  const command = options.command || "lark-cli";
  const identity = options.identity || "bot";
  const runCommand = options.runCommand || execFileAsync;

  return {
    async getMessageThreadId(messageId) {
      if (!messageId) return "";
      try {
        const { stdout } = await runCommand(command, [
          "im",
          "+messages-mget",
          "--message-ids",
          messageId,
          "--format",
          "json",
          "--as",
          identity
        ]);
        const parsed = JSON.parse(stdout || "{}");
        const message = parsed?.data?.messages?.[0] || parsed?.messages?.[0] || {};
        return firstString(message.thread_id, message.threadId, message.root_id, message.rootId);
      } catch {
        return "";
      }
    },
    async sendThreadMessage({ threadId, replyMessageId, text, format = "markdown" }) {
      const messageId = replyMessageId || threadId;
      if (!messageId) {
        throw new Error("Cannot reply to Lark thread without a reply message id");
      }

      const flag = format === "markdown" ? "--markdown" : "--text";
      await runCommand(command, [
        "im",
        "+messages-reply",
        "--message-id",
        messageId,
        flag,
        text,
        "--reply-in-thread",
        "--as",
        identity
      ]);
    },
    async addReaction({ messageId, emoji = "EYES" }) {
      if (!messageId) {
        throw new Error("Cannot add a reaction without a message id");
      }
      await runCommand(command, [
        "im",
        "reactions",
        "create",
        "--params",
        JSON.stringify({ message_id: messageId }),
        "--data",
        JSON.stringify({ reaction_type: { emoji_type: emoji } }),
        "--as",
        identity
      ]);
    },
    async sendApprovalCard({ threadId, replyMessageId, requestId, tool, command: toolCommand, payload, scope }) {
      const messageId = replyMessageId || threadId;
      if (!messageId) {
        throw new Error("Cannot send approval card without a reply message id");
      }
      const card = buildApprovalCard({ requestId, tool, command: toolCommand, payload, scope });
      await runCommand(command, [
        "im",
        "+messages-reply",
        "--message-id",
        messageId,
        "--msg-type",
        "interactive",
        "--content",
        JSON.stringify(card),
        "--reply-in-thread",
        "--as",
        identity
      ]);
    },
    async sendApprovalPrompt({ threadId, replyMessageId, requestId, tool, command: toolCommand, scope }) {
      const messageId = replyMessageId || threadId;
      if (!messageId) {
        throw new Error("Cannot send approval prompt without a reply message id");
      }
      const body = buildApprovalPrompt({ requestId, tool, command: toolCommand, scope });
      await runCommand(command, [
        "im",
        "+messages-reply",
        "--message-id",
        messageId,
        "--markdown",
        body,
        "--reply-in-thread",
        "--as",
        identity
      ]);
    }
  };
}

function truncate(value, max = 240) {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function describeRememberScope(scope) {
  if (scope?.toolScope) {
    return "matched by tool";
  }
  if (scope?.pathPrefix) {
    return `matched by tool + project path \`${scope.pathPrefix}\``;
  }
  if (scope?.commandPrefix) {
    return `matched by tool + command prefix \`${scope.commandPrefix}\``;
  }
  return "matched by tool + command prefix";
}

function toolScopeCommandAlias(tool) {
  if (tool === "ReadFile") return "read";
  return String(tool || "").toLowerCase();
}

function buildApprovalPrompt({ requestId, tool, command: toolCommand, scope }) {
  const lines = [
    "🔒 **Cursor approval required**",
    "",
    `**Tool**: \`${tool}\``
  ];
  if (toolCommand) {
    const oneLine = String(toolCommand).split("\n", 1)[0];
    lines.push(`**Command**: \`${truncate(oneLine, 240)}\``);
  }
  lines.push("");
  lines.push("Reply in this thread (@-mention the bot):");
  lines.push(`- \`/allow\`  approve once`);
  lines.push(`- \`/deny\`   deny once`);
  lines.push(`- \`/allow!\` approve & remember (${describeRememberScope(scope)})`);
  lines.push(`- \`/deny!\`  deny & remember`);
  if (tool === "Shell" || tool === "Bash") {
    lines.push(`- \`/allow pnpm!\` approve & remember all pending/future \`pnpm ...\` Shell commands`);
    lines.push(`- \`/allow shell node!\` approve & remember all pending/future \`node ...\` Shell commands`);
    lines.push(`- \`/allow shell!\` approve & remember all Shell commands`);
  } else if (String(tool || "").startsWith("mcp__")) {
    lines.push(`- \`/allow ${tool}!\` approve & remember all pending/future \`${tool}\` calls`);
  } else if (["Write", "ReadFile", "Edit", "Delete", "ApplyPatch", "MultiEdit"].includes(tool)) {
    lines.push(`- \`/allow ${toolScopeCommandAlias(tool)}!\` approve & remember pending/future ${tool} actions in scope`);
  }
  lines.push("");
  lines.push(`> If multiple approvals are pending, append the request id: \`/allow ${requestId}\``);
  return lines.join("\n");
}

function buildApprovalCard({ requestId, tool, command: toolCommand, payload, scope }) {
  const lines = [`**Tool:** \`${tool}\``];
  if (toolCommand) {
    lines.push("\n**Command:**\n```");
    lines.push(toolCommand);
    lines.push("```");
  }
  if (payload) {
    lines.push("\n**Payload:**\n```");
    lines.push(typeof payload === "string" ? payload : JSON.stringify(payload, null, 2));
    lines.push("```");
  }
  lines.push(`\nRemember scope: ${describeRememberScope(scope)}`);
  lines.push(`Request ID: \`${requestId}\``);

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "Cursor approval required" },
      template: "blue"
    },
    elements: [
      {
        tag: "div",
        text: { tag: "lark_md", content: lines.join("\n") }
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "Approve" },
            type: "primary",
            value: { req: requestId, decision: "allow", remember: false }
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "Approve & remember" },
            type: "primary",
            value: { req: requestId, decision: "allow", remember: true }
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "Deny" },
            type: "danger",
            value: { req: requestId, decision: "deny", remember: false }
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "Deny & remember" },
            type: "danger",
            value: { req: requestId, decision: "deny", remember: true }
          }
        ]
      }
    ]
  };
}
