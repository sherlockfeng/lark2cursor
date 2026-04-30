import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { ApprovalPolicy } from "./approval-policy.js";
import {
  DEFAULT_APPROVAL_POLICY_PATH,
  DEFAULT_BRIDGE_SOCKET_PATH,
  DEFAULT_RELAY_STATE_PATH
} from "./constants.js";
import { createCursorRunner } from "./cursor-runner.js";
import { createBindCode, createConsoleLarkAdapter } from "./lark-adapter.js";
import { inferRuleScope } from "./normalize.js";
import { ensureRuntimeConfigFile, readRuntimeConfig } from "./runtime-config.js";
import { SessionStore } from "./session-store.js";
import { ThinkingHeartbeat } from "./thinking-heartbeat.js";

// Canonical English form: `bind lark thread message_id: om_xxx`.
// Aliases kept for backward compatibility: `bind`, `绑定飞书话题`.
// Require an explicit `message_id:` marker so that echoed wait-loop followups
// like "you are bound to lark thread om_xxx" / "你已绑定飞书话题 om_xxx"
// never accidentally trigger bindCursorSession with the thread id as a stale code.
const BIND_PATTERN = /(?:bind\s+lark\s+thread|bind|绑定飞书话题)\s+(?:message_id|messageId|消息id|消息 ?ID)\s*[:：]\s*([A-Za-z0-9_-]+)/i;
const WAIT_HEARTBEAT = "AGENT2LARK_WAITING_FOR_LARK";
const ACK_TEXT = "Got it, processing…";
const DEFAULT_APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000;

function threadKey(chatId, threadId) {
  return chatId && threadId ? `${chatId}:${threadId}` : "";
}

export class ApprovalRegistry {
  constructor() {
    this.pendings = new Map();
    this.latestByThread = new Map();
    this.pendingByChat = new Map();
  }

  request(requestId, { timeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS, context, thread } = {}) {
    const key = threadKey(thread?.chatId, thread?.threadId);
    const chatId = thread?.chatId || "";
    return new Promise((resolve) => {
      const settle = (value) => {
        const entry = this.pendings.get(requestId);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pendings.delete(requestId);
        if (key && this.latestByThread.get(key) === requestId) {
          this.latestByThread.delete(key);
        }
        if (chatId) {
          const chatSet = this.pendingByChat.get(chatId);
          chatSet?.delete(requestId);
          if (chatSet?.size === 0) {
            this.pendingByChat.delete(chatId);
          }
        }
        resolve(value);
      };
      const timer = setTimeout(() => {
        settle({ decision: "ask", reason: "timeout" });
      }, timeoutMs);
      this.pendings.set(requestId, {
        context: { ...context, requestId },
        settle,
        timer,
        threadKey: key,
        thread: { chatId, threadId: thread?.threadId || "" }
      });
      if (key) this.latestByThread.set(key, requestId);
      if (chatId) {
        if (!this.pendingByChat.has(chatId)) {
          this.pendingByChat.set(chatId, new Set());
        }
        this.pendingByChat.get(chatId).add(requestId);
      }
    });
  }

  decide(requestId, value) {
    const entry = this.pendings.get(requestId);
    if (!entry) return undefined;
    entry.settle(value);
    return entry.context;
  }

  decideLatest({ chatId, threadId }, value) {
    const key = threadKey(chatId, threadId);
    if (!key) return undefined;
    const requestId = this.latestByThread.get(key);
    if (!requestId) return undefined;
    return this.decide(requestId, value);
  }

  decideOnlyPendingInChat({ chatId }, value) {
    const chatSet = this.pendingByChat.get(chatId);
    if (!chatSet || chatSet.size !== 1) return undefined;
    const [requestId] = chatSet;
    return this.decide(requestId, value);
  }

  countPendingInChat({ chatId }) {
    return this.pendingByChat.get(chatId)?.size || 0;
  }

  decideMatching({ chatId, tool }, value) {
    const requestIds = [];
    for (const [requestId, entry] of this.pendings.entries()) {
      if (entry.thread?.chatId === chatId && entry.context?.tool === tool) {
        requestIds.push(requestId);
      }
    }
    return requestIds
      .map((requestId) => this.decide(requestId, value))
      .filter(Boolean);
  }

  decideCommandPrefix({ chatId, tool = "Shell", commandPrefix }, value) {
    const prefix = String(commandPrefix || "").trim();
    if (!prefix) return [];
    const requestIds = [];
    for (const [requestId, entry] of this.pendings.entries()) {
      const command = String(entry.context?.command || "");
      if (
        entry.thread?.chatId === chatId
        && entry.context?.tool === tool
        && (command === prefix || command.startsWith(`${prefix} `))
      ) {
        requestIds.push(requestId);
      }
    }
    return requestIds
      .map((requestId) => this.decide(requestId, value))
      .filter(Boolean);
  }
}


async function ackInboundLarkMessage(lark, { chatId, threadId, messageId, replyMessageId }) {
  if (!lark) return;
  const tasks = [];
  if (typeof lark.addReaction === "function" && messageId) {
    tasks.push(lark.addReaction({ messageId, emoji: "EYES" }));
  }
  if (typeof lark.sendThreadMessage === "function") {
    tasks.push(lark.sendThreadMessage({
      chatId,
      threadId,
      replyMessageId: replyMessageId || messageId,
      text: ACK_TEXT,
      format: "text"
    }));
  }
  await Promise.allSettled(tasks);
}

function rememberApprovalContext(approvalPolicy, context, decision, { forceToolScope = false } = {}) {
  if (!context || (decision !== "allow" && decision !== "deny")) return;
  if (forceToolScope) {
    approvalPolicy.add({
      tool: context.tool,
      toolScope: true,
      decision
    });
    return;
  }

  const scope = inferRuleScope({
    tool: context.tool,
    command: context.command,
    cwd: context.cwd
  });
  if (scope.toolScope) {
    approvalPolicy.add({
      tool: context.tool,
      toolScope: true,
      decision
    });
    return;
  }
  if (scope.pathPrefix || scope.commandPrefix) {
    approvalPolicy.add({
      tool: context.tool,
      commandPrefix: scope.commandPrefix,
      pathPrefix: scope.pathPrefix,
      decision
    });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bindCodeFromPrompt(prompt = "") {
  const text = String(prompt || "");
  // Defense in depth: never parse our own wait-heartbeat followup as user
  // intent, even if the regex stays loose enough to match the embedded
  // "你已绑定飞书话题 ..." line.
  if (text.includes(WAIT_HEARTBEAT)) return "";
  return text.match(BIND_PATTERN)?.[1] || "";
}

function normalizeMessage(input) {
  return input && typeof input === "object" && !Array.isArray(input) ? input : {};
}

function resolveInboundLarkThread(store, message) {
  const exactBinding = store.getBindingByLarkThread(message.chat_id, message.thread_id);
  if (exactBinding) {
    return {
      threadId: message.thread_id,
      replyMessageId: message.reply_message_id,
      binding: exactBinding
    };
  }

  const chatBindings = store.getBindingsByLarkChat(message.chat_id);
  if (chatBindings.length === 1) {
    return {
      threadId: chatBindings[0].threadId,
      replyMessageId: message.reply_message_id || chatBindings[0].replyMessageId,
      binding: chatBindings[0]
    };
  }

  return {
    threadId: message.thread_id,
    replyMessageId: message.reply_message_id,
    binding: undefined
  };
}

async function findBindingByCanonicalThread(store, lark, message) {
  if (!message?.chat_id || !message?.thread_id || typeof lark?.getMessageThreadId !== "function") {
    return undefined;
  }

  const checked = new Set();
  for (const binding of store.getBindingsByLarkChat(message.chat_id)) {
    for (const candidate of [binding.threadId, binding.replyMessageId]) {
      if (!candidate || checked.has(candidate)) continue;
      checked.add(candidate);
      const canonicalThreadId = await lark.getMessageThreadId(candidate);
      if (canonicalThreadId && canonicalThreadId === message.thread_id) {
        return binding;
      }
    }
  }
  return undefined;
}

async function resolveInboundLarkThreadWithCanonical(store, message, lark, log) {
  const resolved = resolveInboundLarkThread(store, message);
  if (resolved.binding) {
    return resolved;
  }

  const binding = await findBindingByCanonicalThread(store, lark, message);
  if (!binding) {
    return resolved;
  }

  log?.(`[bridge] resolved_lark_thread_alias chat=${message.chat_id || ""} input_thread=${message.thread_id || ""} routed_thread=${binding.threadId || ""}`);
  return {
    threadId: binding.threadId,
    replyMessageId: message.reply_message_id || binding.replyMessageId,
    binding
  };
}

function isWaitHeartbeat(text = "") {
  return String(text).trim() === WAIT_HEARTBEAT;
}

function progressRelayEnabled(runtimeConfig = {}) {
  return runtimeConfig.progressRelayEnabled !== false;
}

function redactSensitiveText(value = "") {
  return String(value)
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|API_KEY|ACCESS_KEY)[A-Z0-9_]*)=([^\s]+)/gi, "$1=[redacted]");
}

function shortOneLine(value = "", maxLength = 160) {
  const text = redactSensitiveText(value).replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function inlineCode(value = "") {
  return `\`${String(value).replaceAll("`", "'")}\``;
}

function formatDuration(durationMs) {
  const num = Number(durationMs);
  if (!Number.isFinite(num) || num <= 0) return "";
  if (num < 1000) return `${Math.round(num)}ms`;
  return `${(num / 1000).toFixed(num < 10_000 ? 1 : 0)}s`;
}

function buildProgressText(message) {
  const tool = shortOneLine(message.tool || "Cursor");
  const command = shortOneLine(message.command || "");
  const label = command || tool;
  const phase = String(message.phase || "").toLowerCase();
  const verb = phase === "failed" ? "Failed" : phase === "started" ? "Running" : "Done";
  const details = [];
  const duration = formatDuration(message.duration_ms);
  if (duration) details.push(duration);
  if (message.exit_code !== undefined && message.exit_code !== null && message.exit_code !== "") {
    details.push(`exit ${message.exit_code}`);
  }
  const suffix = details.length ? ` (${details.join(", ")})` : "";
  return `${verb}: ${inlineCode(label)}${suffix}`;
}

async function sendCursorProgress({ store, lark, runtimeConfig, thinkingHeartbeat, message }) {
  if (!progressRelayEnabled(runtimeConfig)) {
    return { ok: true, sent: false, reason: "disabled" };
  }
  if (typeof lark?.sendThreadMessage !== "function") {
    return { ok: true, sent: false, reason: "no_lark_sender" };
  }

  const binding = store.getBindingByCursorSession(message.session_id);
  if (!binding) {
    return { ok: true, sent: false, reason: "no_binding" };
  }

  await lark.sendThreadMessage({
    chatId: binding.chatId,
    threadId: binding.threadId,
    ...(binding.replyMessageId ? { replyMessageId: binding.replyMessageId } : {}),
    text: buildProgressText(message),
    format: "text"
  });
  thinkingHeartbeat?.touch?.(message.session_id);
  return { ok: true, sent: true };
}

async function trySendCursorProgress(args, log) {
  try {
    return await sendCursorProgress(args);
  } catch (error) {
    log?.(`[bridge] progress_send_failed session=${args?.message?.session_id || ""} ${error?.message || error}`);
    return { ok: true, sent: false, reason: "send_failed" };
  }
}

function waitFollowupMessage(binding) {
  return [
    WAIT_HEARTBEAT,
    `Bound to Lark thread ${binding.threadId}; no new Lark messages right now.`,
    `Please reply with only: ${WAIT_HEARTBEAT}`,
    "Do not invoke any tools and do not send a business reply to Lark."
  ].join("\n");
}

async function dequeueForCursorWithWait(store, sessionId, options = {}) {
  const waitPollMs = Number(options.waitPollMs ?? process.env.AGENT2LARK_WAIT_POLL_MS ?? 10 * 60 * 1000);
  const waitIntervalMs = Number(options.waitIntervalMs ?? process.env.AGENT2LARK_WAIT_INTERVAL_MS ?? 1000);
  const deadline = Date.now() + Math.max(0, waitPollMs);

  while (true) {
    const queued = store.dequeueForCursorSession(sessionId);
    if (queued) {
      return { queued };
    }

    const binding = store.getBindingByCursorSession(sessionId);
    if (!binding || binding.waitEnabled === false) {
      return {};
    }

    if (Date.now() >= deadline) {
      return { waitBinding: binding };
    }

    await sleep(Math.min(Math.max(1, waitIntervalMs), Math.max(1, deadline - Date.now())));
  }
}

export async function handleBridgeMessage(input, options = {}) {
  const message = normalizeMessage(input);
  const store = options.store || new SessionStore(options.statePath || DEFAULT_RELAY_STATE_PATH);
  const lark = options.lark || createConsoleLarkAdapter();
  const cursorRunner = options.cursorRunner || createCursorRunner();
  const approvalPolicy = options.approvalPolicy
    || new ApprovalPolicy(options.approvalPolicyPath || DEFAULT_APPROVAL_POLICY_PATH);
  const approvalRegistry = options.approvalRegistry;
  const thinkingHeartbeat = options.thinkingHeartbeat;
  const runtimeConfig = options.runtimeConfig || {};
  const log = options.log || (() => {});

  if (message.type === "cursor_session_start") {
    store.registerCursorSession({
      sessionId: message.session_id,
      cwd: message.cwd,
      composerMode: message.composer_mode
    });
    return {
      additional_context: "This Cursor Chat can be linked to a Lark thread by replying with 'bind lark thread message_id: <code>'."
    };
  }

  if (message.type === "cursor_prompt_submit") {
    const code = bindCodeFromPrompt(message.prompt);
    if (!code) {
      const existing = store.getBindingByCursorSession(message.session_id);
      if (existing) {
        thinkingHeartbeat?.start(message.session_id, existing);
      }
      return { continue: true };
    }

    try {
      const binding = store.bindCursorSession({
        code,
        sessionId: message.session_id,
        cwd: message.cwd
      });
      return {
        continue: false,
        user_message: `Bound to Lark thread ${binding.threadId}.`
      };
    } catch (error) {
      return {
        continue: false,
        user_message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  if (message.type === "cursor_stop") {
    if (message.status && message.status !== "completed") {
      return {};
    }

    const { queued, waitBinding } = await dequeueForCursorWithWait(store, message.session_id, options);
    if (!queued) {
      if (waitBinding && thinkingHeartbeat?.isActive?.(message.session_id)) {
        log(`[bridge] skip_wait_heartbeat_while_thinking session=${message.session_id || ""}`);
        return {};
      }
      thinkingHeartbeat?.stop(message.session_id);
      if (waitBinding) {
        return {
          followup_message: waitFollowupMessage(waitBinding)
        };
      }
      return {};
    }

    await ackInboundLarkMessage(lark, {
      chatId: queued.chatId,
      threadId: queued.threadId,
      messageId: queued.messageId,
      replyMessageId: queued.replyMessageId
    });
    log(`[bridge] dequeued_lark_message session=${message.session_id || ""} chat=${queued.chatId || ""} thread=${queued.threadId || ""} msg=${queued.messageId || ""}`);

    const binding = store.getBindingByCursorSession(message.session_id);
    if (binding) {
      thinkingHeartbeat?.start(message.session_id, binding);
    }

    return {
      followup_message: `Lark thread ${queued.threadId}:\n${queued.text}`
    };
  }

  if (message.type === "cursor_agent_response") {
    const binding = store.getBindingByCursorSession(message.session_id);
    if (!binding || !message.text) {
      thinkingHeartbeat?.stop(message.session_id);
      return { ok: true };
    }
    if (isWaitHeartbeat(message.text)) {
      thinkingHeartbeat?.stop(message.session_id);
      return { ok: true, suppressed: "wait_heartbeat" };
    }

    thinkingHeartbeat?.stop(message.session_id);
    store.recordCursorResponse({ sessionId: message.session_id, text: message.text });
    await lark.sendThreadMessage({
      chatId: binding.chatId,
      threadId: binding.threadId,
      ...(binding.replyMessageId ? { replyMessageId: binding.replyMessageId } : {}),
      text: message.text
    });
    return { ok: true };
  }

  if (message.type === "cursor_progress") {
    return trySendCursorProgress({ store, lark, runtimeConfig, thinkingHeartbeat, message }, log);
  }

  if (message.type === "lark_message") {
    const resolved = await resolveInboundLarkThreadWithCanonical(store, message, lark, log);
    if (resolved.binding?.mode === "official_agent") {
      await ackInboundLarkMessage(lark, {
        chatId: message.chat_id,
        threadId: resolved.threadId,
        messageId: message.message_id,
        replyMessageId: message.reply_message_id || message.message_id
      });

      const heartbeatKey = `oa:${message.chat_id}:${resolved.threadId}:${message.message_id || Date.now()}`;
      thinkingHeartbeat?.start(heartbeatKey, {
        chatId: message.chat_id,
        threadId: resolved.threadId,
        replyMessageId: resolved.binding.replyMessageId || resolved.replyMessageId
      });
      let result;
      try {
        result = await cursorRunner.runPrompt({
          cwd: resolved.binding.cwd || message.cwd || process.cwd(),
          prompt: message.text,
          agentSessionId: resolved.binding.agentSessionId
        });
      } finally {
        thinkingHeartbeat?.stop(heartbeatKey);
      }
      store.updateAgentBinding({
        chatId: message.chat_id,
        threadId: resolved.threadId,
        agentSessionId: result.agentSessionId
      });
      await lark.sendThreadMessage({
        chatId: message.chat_id,
        threadId: resolved.threadId,
        replyMessageId: resolved.binding.replyMessageId || resolved.replyMessageId,
        text: result.text
      });
      return { ok: true, routed: "official_agent" };
    }

    store.enqueueLarkMessage({
      chatId: message.chat_id,
      threadId: resolved.threadId,
      messageId: message.message_id,
      replyMessageId: resolved.replyMessageId,
      text: message.text
    });
    log(`[bridge] enqueued_lark_message chat=${message.chat_id || ""} input_thread=${message.thread_id || ""} routed_thread=${resolved.threadId || ""} msg=${message.message_id || ""}`);
    return { ok: true };
  }

  if (message.type === "lark_disable_wait") {
    const resolved = await resolveInboundLarkThreadWithCanonical(store, message, lark, log);
    store.setCursorBindingWait({
      chatId: message.chat_id,
      threadId: resolved.threadId,
      waitEnabled: false
    });
    return { ok: true };
  }

  if (message.type === "lark_unbind_thread") {
    const resolved = await resolveInboundLarkThreadWithCanonical(store, message, lark, log);
    const removed = store.unbindLarkThread({
      chatId: message.chat_id,
      threadId: resolved.threadId || message.thread_id
    });
    return { ok: true, removed: Boolean(removed) };
  }

  if (message.type === "lark_create_agent_bind") {
    const binding = store.createAgentBinding({
      chatId: message.chat_id,
      threadId: message.thread_id,
      replyMessageId: message.reply_message_id,
      cwd: message.cwd || process.env.AGENT2LARK_CURSOR_AGENT_CWD || process.cwd()
    });
    return { ok: true, binding };
  }

  if (message.type === "cursor_approval_request") {
    const binding = store.getBindingByCursorSession(message.session_id);
    if (!binding) {
      return { decision: "ask", reason: "no_binding" };
    }

    const cwd = message.cwd || binding.cwd || "";
    const cached = approvalPolicy.match({ tool: message.tool, command: message.command, cwd });
    if (cached) {
      if (cached.decision === "allow") {
        await trySendCursorProgress({
          store,
          lark,
          runtimeConfig,
          thinkingHeartbeat,
          message: {
            type: "cursor_progress",
            session_id: message.session_id,
            phase: "started",
            tool: message.tool,
            command: message.command
          }
        }, log);
      }
      return { decision: cached.decision, reason: `cached:${cached.id}` };
    }

    if (!approvalRegistry) {
      return { decision: "ask", reason: "approval_registry_unavailable" };
    }

    const requestId = message.request_id || createBindCode();
    const mode = String(options.approvalMode ?? process.env.AGENT2LARK_APPROVAL_MODE ?? "text").toLowerCase();
    const scope = inferRuleScope({ tool: message.tool, command: message.command, cwd });
    try {
      if (mode === "card") {
        await lark.sendApprovalCard?.({
          threadId: binding.threadId,
          replyMessageId: binding.replyMessageId,
          requestId,
          tool: message.tool,
          command: message.command,
          payload: message.payload,
          scope
        });
      } else {
        await lark.sendApprovalPrompt?.({
          threadId: binding.threadId,
          replyMessageId: binding.replyMessageId,
          requestId,
          tool: message.tool,
          command: message.command,
          scope
        });
      }
    } catch (error) {
      return {
        decision: "ask",
        reason: `prompt_send_failed:${error instanceof Error ? error.message : String(error)}`
      };
    }

    const result = await approvalRegistry.request(requestId, {
      timeoutMs: Number(options.approvalTimeoutMs ?? process.env.AGENT2LARK_APPROVAL_TIMEOUT_MS ?? DEFAULT_APPROVAL_TIMEOUT_MS),
      context: { tool: message.tool, command: message.command, cwd, binding },
      thread: { chatId: binding.chatId, threadId: binding.threadId }
    });

    if (result?.decision === "allow") {
      await trySendCursorProgress({
        store,
        lark,
        runtimeConfig,
        thinkingHeartbeat,
        message: {
          type: "cursor_progress",
          session_id: message.session_id,
          phase: "started",
          tool: message.tool,
          command: message.command
        }
      }, log);
    }

    return result;
  }

  if (message.type === "lark_approval_decision") {
    if (!approvalRegistry) {
      return { ok: false, error: "approval_registry_unavailable" };
    }
    const value = {
      decision: message.decision,
      reason: message.remember ? "remembered" : "decided"
    };

    let context;
    if (message.tool_scope) {
      const contexts = approvalRegistry.decideMatching({
        chatId: message.chat_id,
        tool: message.tool_scope
      }, value);
      if (message.remember) {
        for (const item of contexts) {
          rememberApprovalContext(approvalPolicy, item, message.decision, {
            forceToolScope: message.tool_scope === "Shell"
          });
        }
      }
      return {
        ok: contexts.length > 0,
        count: contexts.length,
        tool_scope: message.tool_scope,
        decision: message.decision,
        ...(contexts.length === 0 ? { reason: "no_pending_matching_tool" } : {})
      };
    }

    if (message.command_scope) {
      const contexts = approvalRegistry.decideCommandPrefix({
        chatId: message.chat_id,
        tool: "Shell",
        commandPrefix: message.command_scope
      }, value);
      if (message.remember) {
        for (const item of contexts) {
          approvalPolicy.add({
            tool: item.tool,
            commandPrefix: message.command_scope,
            decision: message.decision
          });
        }
      }
      return {
        ok: contexts.length > 0,
        count: contexts.length,
        command_scope: message.command_scope,
        decision: message.decision,
        ...(contexts.length === 0 ? { reason: "no_pending_matching_command" } : {})
      };
    }

    if (message.request_id) {
      context = approvalRegistry.decide(message.request_id, value);
    } else {
      const resolved = await resolveInboundLarkThreadWithCanonical(store, message, lark, log);
      const threadId = resolved.threadId || message.thread_id;
      context = approvalRegistry.decideLatest({ chatId: message.chat_id, threadId }, value);
      if (!context) {
        if (approvalRegistry.countPendingInChat({ chatId: message.chat_id }) > 1) {
          return { ok: false, reason: "multiple_pending", decision: message.decision };
        }
        context = approvalRegistry.decideOnlyPendingInChat({ chatId: message.chat_id }, value);
      }
    }

    if (context && message.remember && (message.decision === "allow" || message.decision === "deny")) {
      rememberApprovalContext(approvalPolicy, context, message.decision);
    }
    return {
      ok: Boolean(context),
      ...(context?.requestId ? { request_id: context.requestId } : {}),
      decision: message.decision
    };
  }

  if (message.type === "lark_create_bind") {
    const code = message.code || createBindCode();
    store.createPendingBind({
      code,
      chatId: message.chat_id,
      threadId: message.thread_id,
      replyMessageId: message.reply_message_id,
      expiresAt: message.expires_at || Date.now() + 10 * 60 * 1000
    });
    return { ok: true, code };
  }

  return { ok: false, error: `Unknown bridge message type: ${message.type || "unknown"}` };
}

export function startBridgeServer(options = {}) {
  const socketPath = options.socketPath || process.env.AGENT2LARK_BRIDGE_SOCKET || DEFAULT_BRIDGE_SOCKET_PATH;
  const store = options.store || new SessionStore(options.statePath || DEFAULT_RELAY_STATE_PATH);
  const lark = options.lark || createConsoleLarkAdapter();
  const approvalPolicy = options.approvalPolicy
    || new ApprovalPolicy(options.approvalPolicyPath || DEFAULT_APPROVAL_POLICY_PATH);
  const approvalRegistry = options.approvalRegistry || new ApprovalRegistry();
  if (options.ensureRuntimeConfigFile !== false) {
    ensureRuntimeConfigFile({ configPath: options.runtimeConfigPath });
  }
  const runtimeConfig = options.runtimeConfig || readRuntimeConfig({ configPath: options.runtimeConfigPath });
  const thinkingHeartbeat = options.thinkingHeartbeat || new ThinkingHeartbeat({
    intervalMs: runtimeConfig.thinkingIntervalMs,
    lark
  });

  if (fs.existsSync(socketPath)) {
    fs.unlinkSync(socketPath);
  }
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });

  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }

      const line = buffer.slice(0, newline).trim();
      Promise.resolve()
        .then(() => handleBridgeMessage(JSON.parse(line || "{}"), {
          store,
          lark,
          approvalPolicy,
          approvalRegistry,
          thinkingHeartbeat,
          log: options.log || ((message) => process.stdout.write(`${message}\n`))
        }))
        .then((response) => {
          socket.write(`${JSON.stringify(response)}\n`);
          socket.end();
        })
        .catch((error) => {
          socket.write(`${JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          })}\n`);
          socket.end();
        });
    });
  });

  server.listen(socketPath);
  return server;
}
