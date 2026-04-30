import fs from "node:fs";
import path from "node:path";
import { DEFAULT_RELAY_STATE_PATH } from "./constants.js";

function emptyState() {
  return {
    pendingBinds: {},
    bindings: {
      byCursorSession: {},
      byLarkThread: {}
    },
    queues: {},
    cursorSessions: {},
    cursorResponses: []
  };
}

function threadKey(chatId, threadId) {
  return `${chatId}:${threadId}`;
}

function normalizeBinding({ chatId, threadId, replyMessageId = "", sessionId, cwd = "", mode = "ide_chat", agentSessionId = "", waitEnabled = true }) {
  return {
    chatId,
    threadId,
    ...(replyMessageId ? { replyMessageId } : {}),
    ...(sessionId ? { sessionId } : {}),
    cwd,
    ...(mode === "ide_chat" && waitEnabled === false ? { waitEnabled: false } : {}),
    ...(mode !== "ide_chat" ? { mode } : {}),
    ...(agentSessionId ? { agentSessionId } : {})
  };
}

export class SessionStore {
  constructor(statePath = DEFAULT_RELAY_STATE_PATH) {
    this.statePath = statePath;
  }

  read() {
    if (!fs.existsSync(this.statePath)) {
      return emptyState();
    }

    const parsed = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
    return {
      ...emptyState(),
      ...parsed,
      bindings: {
        ...emptyState().bindings,
        ...(parsed.bindings || {})
      }
    };
  }

  write(state) {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    fs.writeFileSync(this.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  createPendingBind({ code, chatId, threadId, replyMessageId = "", expiresAt }) {
    const state = this.read();
    state.pendingBinds[code] = { code, chatId, threadId, replyMessageId, expiresAt };
    this.write(state);
    return state.pendingBinds[code];
  }

  registerCursorSession({ sessionId, cwd = "", composerMode = "" }) {
    const state = this.read();
    state.cursorSessions[sessionId] = { sessionId, cwd, composerMode, updatedAt: Date.now() };
    this.write(state);
    return state.cursorSessions[sessionId];
  }

  bindCursorSession({ code, sessionId, cwd = "" }) {
    const state = this.read();
    const pending = state.pendingBinds[code];
    if (!pending) {
      throw new Error(`Bind code ${code} was not found`);
    }
    if (Number(pending.expiresAt) < Date.now()) {
      delete state.pendingBinds[code];
      this.write(state);
      throw new Error(`Bind code ${code} expired`);
    }

    const binding = normalizeBinding({
      chatId: pending.chatId,
      threadId: pending.threadId,
      replyMessageId: pending.replyMessageId,
      sessionId,
      cwd
    });
    const key = threadKey(binding.chatId, binding.threadId);
    const previousForSession = state.bindings.byCursorSession[sessionId];
    if (previousForSession) {
      delete state.bindings.byLarkThread[threadKey(previousForSession.chatId, previousForSession.threadId)];
    }

    const previousForThread = state.bindings.byLarkThread[key];
    if (previousForThread) {
      delete state.bindings.byCursorSession[previousForThread.sessionId];
    }

    state.bindings.byCursorSession[sessionId] = binding;
    state.bindings.byLarkThread[key] = binding;
    delete state.pendingBinds[code];
    this.write(state);
    return binding;
  }

  getBindingByCursorSession(sessionId) {
    return this.read().bindings.byCursorSession[sessionId];
  }

  getBindingByLarkThread(chatId, threadId) {
    return this.read().bindings.byLarkThread[threadKey(chatId, threadId)];
  }

  getBindingsByLarkChat(chatId) {
    return Object.values(this.read().bindings.byLarkThread)
      .filter((binding) => binding.chatId === chatId);
  }

  unbindLarkThread({ chatId, threadId }) {
    const state = this.read();
    let key = threadKey(chatId, threadId);
    let binding = state.bindings.byLarkThread[key];
    if (!binding) {
      const chatBindings = Object.values(state.bindings.byLarkThread)
        .filter((item) => item.chatId === chatId);
      if (chatBindings.length === 1) {
        binding = chatBindings[0];
        key = threadKey(binding.chatId, binding.threadId);
      }
    }
    if (!binding) {
      return undefined;
    }

    delete state.bindings.byLarkThread[key];
    if (binding.sessionId) {
      delete state.bindings.byCursorSession[binding.sessionId];
    }
    delete state.queues[key];
    this.write(state);
    return binding;
  }

  enqueueLarkMessage({ chatId, threadId, messageId, replyMessageId = "", text }) {
    const state = this.read();
    const key = threadKey(chatId, threadId);
    if (!Array.isArray(state.queues[key])) {
      state.queues[key] = [];
    }
    state.queues[key].push({
      chatId,
      threadId,
      messageId,
      ...(replyMessageId ? { replyMessageId } : {}),
      text
    });
    this.write(state);
  }

  setCursorBindingWait({ chatId, threadId, waitEnabled }) {
    const state = this.read();
    const key = threadKey(chatId, threadId);
    const binding = state.bindings.byLarkThread[key];
    if (!binding || binding.mode === "official_agent") {
      return undefined;
    }

    const updated = {
      ...binding,
      waitEnabled: Boolean(waitEnabled),
      updatedAt: Date.now()
    };
    state.bindings.byLarkThread[key] = updated;
    if (updated.sessionId) {
      state.bindings.byCursorSession[updated.sessionId] = updated;
    }
    this.write(state);
    return updated;
  }

  createAgentBinding({ chatId, threadId, replyMessageId = "", cwd = process.cwd(), agentSessionId = "" }) {
    const state = this.read();
    const key = threadKey(chatId, threadId);
    const previousForThread = state.bindings.byLarkThread[key];
    if (previousForThread?.sessionId) {
      delete state.bindings.byCursorSession[previousForThread.sessionId];
    }

    const binding = normalizeBinding({
      chatId,
      threadId,
      replyMessageId,
      cwd,
      mode: "official_agent",
      agentSessionId
    });
    state.bindings.byLarkThread[key] = binding;
    this.write(state);
    return binding;
  }

  updateAgentBinding({ chatId, threadId, agentSessionId = "", lastError = "" }) {
    const state = this.read();
    const key = threadKey(chatId, threadId);
    const binding = state.bindings.byLarkThread[key];
    if (!binding) {
      return undefined;
    }
    state.bindings.byLarkThread[key] = {
      ...binding,
      ...(agentSessionId ? { agentSessionId } : {}),
      ...(lastError ? { lastError } : {}),
      updatedAt: Date.now()
    };
    this.write(state);
    return state.bindings.byLarkThread[key];
  }

  dequeueForCursorSession(sessionId) {
    const state = this.read();
    const binding = state.bindings.byCursorSession[sessionId];
    if (!binding) {
      return undefined;
    }

    const key = threadKey(binding.chatId, binding.threadId);
    const queue = state.queues[key] || [];
    const message = queue.shift();
    if (queue.length === 0) {
      delete state.queues[key];
    } else {
      state.queues[key] = queue;
    }
    this.write(state);
    return message;
  }

  recordCursorResponse({ sessionId, text }) {
    const state = this.read();
    state.cursorResponses.push({ sessionId, text, createdAt: Date.now() });
    this.write(state);
  }
}
