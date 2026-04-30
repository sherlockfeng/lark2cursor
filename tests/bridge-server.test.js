import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ApprovalRegistry, handleBridgeMessage } from "../src/bridge-server.js";
import { ApprovalPolicy } from "../src/approval-policy.js";
import { SessionStore } from "../src/session-store.js";
import { ThinkingHeartbeat } from "../src/thinking-heartbeat.js";

function tempStore() {
  return new SessionStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent2lark-bridge-")), "state.json"));
}

function tempPolicy() {
  return new ApprovalPolicy(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent2lark-policy-")), "policy.json"));
}

async function waitFor(assertion, { timeoutMs = 200, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  assertion();
  if (lastError) throw lastError;
}

test("binds a Cursor session for the canonical English `bind lark thread message_id:` form", async () => {
  const store = tempStore();
  store.createPendingBind({
    code: "abc123",
    chatId: "oc_chat",
    threadId: "omt_thread",
    expiresAt: Date.now() + 60_000
  });

  const response = await handleBridgeMessage({
    type: "cursor_prompt_submit",
    session_id: "cursor-session",
    cwd: "/tmp/project",
    prompt: "bind lark thread message_id: abc123"
  }, { store });

  assert.deepEqual(response, {
    continue: false,
    user_message: "Bound to Lark thread omt_thread."
  });
  assert.equal(store.getBindingByCursorSession("cursor-session").threadId, "omt_thread");
});

test("still accepts the legacy `绑定飞书话题 message_id:` zh-CN alias", async () => {
  const store = tempStore();
  store.createPendingBind({
    code: "abc123",
    chatId: "oc_chat",
    threadId: "omt_thread",
    expiresAt: Date.now() + 60_000
  });

  const response = await handleBridgeMessage({
    type: "cursor_prompt_submit",
    session_id: "cursor-session-zh",
    cwd: "/tmp/project",
    prompt: "绑定飞书话题 message_id: abc123"
  }, { store });

  assert.deepEqual(response, {
    continue: false,
    user_message: "Bound to Lark thread omt_thread."
  });
});

test("does not parse our own wait-loop followup as a fresh bind request", async () => {
  // Regression: the wait-loop followup mentions the bound thread; it must not
  // trigger bindCursorSession with the thread id as a stale code (which would
  // surface "Bind code ... was not found" in chat).
  const store = tempStore();
  store.createPendingBind({
    code: "abc123",
    chatId: "oc_chat",
    threadId: "omt_thread",
    expiresAt: Date.now() + 60_000
  });
  store.bindCursorSession({ code: "abc123", sessionId: "cursor-session", cwd: "/tmp/project" });

  const followupPrompt = [
    "AGENT2LARK_WAITING_FOR_LARK",
    "Bound to Lark thread omt_thread; no new Lark messages right now.",
    "Please reply with only: AGENT2LARK_WAITING_FOR_LARK",
    "Do not invoke any tools and do not send a business reply to Lark."
  ].join("\n");

  const response = await handleBridgeMessage({
    type: "cursor_prompt_submit",
    session_id: "cursor-session",
    cwd: "/tmp/project",
    prompt: followupPrompt
  }, { store });

  assert.deepEqual(response, { continue: true });
});

test("does not match 'bind' inside arbitrary prose without an explicit message_id label", async () => {
  // Loose phrasing like a status sentence should never be treated as bind intent.
  const store = tempStore();

  for (const prompt of [
    "你已绑定飞书话题 om_x100b50123e9840a0d45aae7969aad3c，请继续工作",
    "We are bound to Lark thread om_x100b50123e9840a0d45aae7969aad3c, please carry on"
  ]) {
    const response = await handleBridgeMessage({
      type: "cursor_prompt_submit",
      session_id: `cursor-session-${prompt.length}`,
      cwd: "/tmp/project",
      prompt
    }, { store });
    assert.deepEqual(response, { continue: true }, `prompt should not bind: ${prompt}`);
  }
});

test("binds a Cursor session when the prompt includes a message_id label", async () => {
  const store = tempStore();
  store.createPendingBind({
    code: "om_test_thread_root",
    chatId: "oc_chat",
    threadId: "om_test_thread_root",
    expiresAt: Date.now() + 60_000
  });

  const response = await handleBridgeMessage({
    type: "cursor_prompt_submit",
    session_id: "cursor-session",
    cwd: "/tmp/project",
    prompt: "bind lark thread message_id: om_test_thread_root"
  }, { store });

  assert.deepEqual(response, {
    continue: false,
    user_message: "Bound to Lark thread om_test_thread_root."
  });
  assert.equal(
    store.getBindingByCursorSession("cursor-session").threadId,
    "om_test_thread_root"
  );
});

test("returns a followup message for the next queued Lark message and acknowledges it", async () => {
  const store = tempStore();
  const reactions = [];
  const replies = [];
  store.createPendingBind({
    code: "abc123",
    chatId: "oc_chat",
    threadId: "omt_thread",
    expiresAt: Date.now() + 60_000
  });
  store.bindCursorSession({
    code: "abc123",
    sessionId: "cursor-session",
    cwd: "/tmp/project"
  });
  store.enqueueLarkMessage({
    chatId: "oc_chat",
    threadId: "omt_thread",
    messageId: "om_1",
    replyMessageId: "om_1",
    text: "请继续实现 bridge"
  });

  const response = await handleBridgeMessage({
    type: "cursor_stop",
    session_id: "cursor-session",
    loop_count: 0
  }, {
    store,
    lark: {
      async sendThreadMessage(message) {
        replies.push(message);
      },
      async addReaction(input) {
        reactions.push(input);
      }
    }
  });

  assert.deepEqual(response, {
    followup_message: "Lark thread omt_thread:\n请继续实现 bridge"
  });
  assert.deepEqual(reactions, [{ messageId: "om_1", emoji: "EYES" }]);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].chatId, "oc_chat");
  assert.equal(replies[0].threadId, "omt_thread");
  assert.equal(replies[0].replyMessageId, "om_1");
  assert.match(replies[0].text, /Got it/);
});

test("keeps a bound Cursor chat waiting when no Lark message is queued", async () => {
  const store = tempStore();
  store.createPendingBind({
    code: "abc123",
    chatId: "oc_chat",
    threadId: "omt_thread",
    expiresAt: Date.now() + 60_000
  });
  store.bindCursorSession({
    code: "abc123",
    sessionId: "cursor-session",
    cwd: "/tmp/project"
  });

  const response = await handleBridgeMessage({
    type: "cursor_stop",
    session_id: "cursor-session",
    loop_count: 0
  }, {
    store,
    waitPollMs: 0
  });

  assert.match(response.followup_message, /AGENT2LARK_WAITING_FOR_LARK/);
  assert.match(response.followup_message, /Please reply with only/);
});

test("skips wait heartbeat while a real turn is still thinking", async () => {
  const store = tempStore();
  store.createPendingBind({
    code: "abc123",
    chatId: "oc_chat",
    threadId: "omt_thread",
    expiresAt: Date.now() + 60_000
  });
  store.bindCursorSession({
    code: "abc123",
    sessionId: "cursor-session",
    cwd: "/tmp/project"
  });

  const heartbeat = new ThinkingHeartbeat({
    intervalMs: 60_000,
    lark: { async sendThreadMessage() {} }
  });
  heartbeat.start("cursor-session", { chatId: "oc_chat", threadId: "omt_thread" });

  const response = await handleBridgeMessage({
    type: "cursor_stop",
    session_id: "cursor-session",
    loop_count: 0
  }, {
    store,
    thinkingHeartbeat: heartbeat,
    waitPollMs: 0
  });

  assert.deepEqual(response, {});
  assert.equal(heartbeat.isActive("cursor-session"), true);
  heartbeat.stop("cursor-session");
});

test("long-polls for queued Lark messages before returning a wait heartbeat", async () => {
  const store = tempStore();
  store.createPendingBind({
    code: "abc123",
    chatId: "oc_chat",
    threadId: "omt_thread",
    expiresAt: Date.now() + 60_000
  });
  store.bindCursorSession({
    code: "abc123",
    sessionId: "cursor-session",
    cwd: "/tmp/project"
  });

  const responsePromise = handleBridgeMessage({
    type: "cursor_stop",
    session_id: "cursor-session",
    loop_count: 0
  }, {
    store,
    waitPollMs: 100,
    waitIntervalMs: 5
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  store.enqueueLarkMessage({
    chatId: "oc_chat",
    threadId: "omt_thread",
    messageId: "om_1",
    text: "新飞书消息"
  });

  assert.deepEqual(await responsePromise, {
    followup_message: "Lark thread omt_thread:\n新飞书消息"
  });
});

test("suppresses Cursor wait heartbeat responses from Lark", async () => {
  const sent = [];
  const store = tempStore();
  store.createPendingBind({
    code: "abc123",
    chatId: "oc_chat",
    threadId: "omt_thread",
    expiresAt: Date.now() + 60_000
  });
  store.bindCursorSession({
    code: "abc123",
    sessionId: "cursor-session",
    cwd: "/tmp/project"
  });

  const response = await handleBridgeMessage({
    type: "cursor_agent_response",
    session_id: "cursor-session",
    text: "AGENT2LARK_WAITING_FOR_LARK"
  }, {
    store,
    lark: {
      async sendThreadMessage(message) {
        sent.push(message);
      }
    }
  });

  assert.deepEqual(response, { ok: true, suppressed: "wait_heartbeat" });
  assert.deepEqual(sent, []);
});

test("disables wait mode for a bound Cursor chat from Lark", async () => {
  const store = tempStore();
  store.createPendingBind({
    code: "abc123",
    chatId: "oc_chat",
    threadId: "omt_thread",
    expiresAt: Date.now() + 60_000
  });
  store.bindCursorSession({
    code: "abc123",
    sessionId: "cursor-session",
    cwd: "/tmp/project"
  });

  assert.deepEqual(await handleBridgeMessage({
    type: "lark_disable_wait",
    chat_id: "oc_chat",
    thread_id: "omt_thread"
  }, { store }), { ok: true });

  assert.equal(store.getBindingByCursorSession("cursor-session").waitEnabled, false);
  assert.deepEqual(await handleBridgeMessage({
    type: "cursor_stop",
    session_id: "cursor-session",
    loop_count: 0
  }, {
    store,
    waitPollMs: 0
  }), {});
});

test("unbinds the resolved Lark thread from Lark", async () => {
  const store = tempStore();
  store.createPendingBind({
    code: "abc123",
    chatId: "oc_chat",
    threadId: "omt_thread",
    expiresAt: Date.now() + 60_000
  });
  store.bindCursorSession({
    code: "abc123",
    sessionId: "cursor-session",
    cwd: "/tmp/project"
  });

  const response = await handleBridgeMessage({
    type: "lark_unbind_thread",
    chat_id: "oc_chat",
    thread_id: "omt_thread"
  }, { store });

  assert.equal(response.ok, true);
  assert.equal(response.removed, true);
  assert.equal(store.getBindingByLarkThread("oc_chat", "omt_thread"), undefined);
  assert.equal(store.getBindingByCursorSession("cursor-session"), undefined);
});

test("unbind resolves canonical Lark thread ids when a chat has multiple bindings", async () => {
  const store = tempStore();
  store.createPendingBind({
    code: "om_root_a",
    chatId: "oc_chat",
    threadId: "om_root_a",
    replyMessageId: "om_root_a",
    expiresAt: Date.now() + 60_000
  });
  store.createPendingBind({
    code: "om_root_b",
    chatId: "oc_chat",
    threadId: "om_root_b",
    replyMessageId: "om_root_b",
    expiresAt: Date.now() + 60_000
  });
  store.bindCursorSession({
    code: "om_root_a",
    sessionId: "cursor-session-a",
    cwd: "/tmp/project"
  });
  store.bindCursorSession({
    code: "om_root_b",
    sessionId: "cursor-session-b",
    cwd: "/tmp/project"
  });

  const response = await handleBridgeMessage({
    type: "lark_unbind_thread",
    chat_id: "oc_chat",
    thread_id: "omt_canonical_a",
    reply_message_id: "om_unbind"
  }, {
    store,
    lark: {
      async getMessageThreadId(messageId) {
        return {
          om_root_a: "omt_canonical_a",
          om_root_b: "omt_canonical_b"
        }[messageId] || "";
      }
    }
  });

  assert.equal(response.ok, true);
  assert.equal(response.removed, true);
  assert.equal(store.getBindingByLarkThread("oc_chat", "om_root_a"), undefined);
  assert.equal(store.getBindingByCursorSession("cursor-session-a"), undefined);
  assert.ok(store.getBindingByLarkThread("oc_chat", "om_root_b"));
  assert.ok(store.getBindingByCursorSession("cursor-session-b"));
});

test("routes Lark messages to the only bound thread when compact events omit thread root", async () => {
  const store = tempStore();
  store.createPendingBind({
    code: "om_root",
    chatId: "oc_chat",
    threadId: "om_root",
    replyMessageId: "om_root",
    expiresAt: Date.now() + 60_000
  });
  store.bindCursorSession({
    code: "om_root",
    sessionId: "cursor-session",
    cwd: "/tmp/project"
  });

  await handleBridgeMessage({
    type: "lark_message",
    chat_id: "oc_chat",
    thread_id: "om_reply_message",
    message_id: "om_reply_message",
    reply_message_id: "om_reply_message",
    text: "thread 中的新回复"
  }, { store });

  const response = await handleBridgeMessage({
    type: "cursor_stop",
    session_id: "cursor-session",
    loop_count: 0
  }, { store });

  assert.deepEqual(response, {
    followup_message: "Lark thread om_root:\nthread 中的新回复"
  });
});

test("sends Cursor responses back to the bound Lark thread", async () => {
  const sent = [];
  const store = tempStore();
  store.createPendingBind({
    code: "abc123",
    chatId: "oc_chat",
    threadId: "omt_thread",
    expiresAt: Date.now() + 60_000
  });
  store.bindCursorSession({
    code: "abc123",
    sessionId: "cursor-session",
    cwd: "/tmp/project"
  });

  const response = await handleBridgeMessage({
    type: "cursor_agent_response",
    session_id: "cursor-session",
    text: "已经完成。"
  }, {
    store,
    lark: {
      async sendThreadMessage(message) {
        sent.push(message);
      }
    }
  });

  assert.deepEqual(response, { ok: true });
  assert.deepEqual(sent, [{
    chatId: "oc_chat",
    threadId: "omt_thread",
    text: "已经完成。"
  }]);
});

test("sends short cursor progress messages to the bound Lark thread", async () => {
  const sent = [];
  const touched = [];
  const store = tempStore();
  store.createPendingBind({
    code: "abc123",
    chatId: "oc_chat",
    threadId: "omt_thread",
    replyMessageId: "om_root",
    expiresAt: Date.now() + 60_000
  });
  store.bindCursorSession({
    code: "abc123",
    sessionId: "cursor-session",
    cwd: "/tmp/project"
  });

  const response = await handleBridgeMessage({
    type: "cursor_progress",
    session_id: "cursor-session",
    phase: "completed",
    tool: "Shell",
    command: "pnpm test",
    duration_ms: 1234,
    output: "this full output must not be sent"
  }, {
    store,
    runtimeConfig: { progressRelayEnabled: true },
    thinkingHeartbeat: {
      touch(key) {
        touched.push(key);
      }
    },
    lark: {
      async sendThreadMessage(message) {
        sent.push(message);
      }
    }
  });

  assert.deepEqual(response, { ok: true, sent: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, "oc_chat");
  assert.equal(sent[0].threadId, "omt_thread");
  assert.equal(sent[0].replyMessageId, "om_root");
  assert.match(sent[0].text, /Done: `pnpm test`/);
  assert.match(sent[0].text, /1\.2s/);
  assert.doesNotMatch(sent[0].text, /full output/);
  assert.deepEqual(touched, ["cursor-session"]);
});

test("does not send cursor progress when progress relay is disabled", async () => {
  const sent = [];
  const store = tempStore();
  store.createPendingBind({
    code: "abc123",
    chatId: "oc_chat",
    threadId: "omt_thread",
    expiresAt: Date.now() + 60_000
  });
  store.bindCursorSession({
    code: "abc123",
    sessionId: "cursor-session",
    cwd: "/tmp/project"
  });

  const response = await handleBridgeMessage({
    type: "cursor_progress",
    session_id: "cursor-session",
    phase: "completed",
    tool: "Shell",
    command: "pnpm test"
  }, {
    store,
    runtimeConfig: { progressRelayEnabled: false },
    lark: {
      async sendThreadMessage(message) {
        sent.push(message);
      }
    }
  });

  assert.deepEqual(response, { ok: true, sent: false, reason: "disabled" });
  assert.deepEqual(sent, []);
});

test("starts a thinking heartbeat on prompt_submit and stops on agent_response", async () => {
  const store = tempStore();
  store.createPendingBind({ code: "abc", chatId: "oc", threadId: "omt", expiresAt: Date.now() + 60_000 });
  store.bindCursorSession({ code: "abc", sessionId: "session-1", cwd: "/tmp/p" });

  const sent = [];
  const lark = { async sendThreadMessage(message) { sent.push(message); } };
  const heartbeat = new ThinkingHeartbeat({ intervalMs: 5, lark });

  await handleBridgeMessage({
    type: "cursor_prompt_submit",
    session_id: "session-1",
    prompt: "do the thing"
  }, { store, lark, thinkingHeartbeat: heartbeat });

  await waitFor(() => {
    const thinkingTicks = sent.filter((m) => /Thinking…/.test(m.text || "")).length;
    assert.ok(thinkingTicks >= 2, `expected at least 2 heartbeats, got ${thinkingTicks}`);
  });

  await handleBridgeMessage({
    type: "cursor_agent_response",
    session_id: "session-1",
    text: "done"
  }, { store, lark, thinkingHeartbeat: heartbeat });

  const before = sent.length;
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(sent.length, before, "heartbeat should have stopped after agent_response");
});

test("does not heartbeat when prompt_submit has no binding for the session", async () => {
  const store = tempStore();
  const sent = [];
  const lark = { async sendThreadMessage(message) { sent.push(message); } };
  const heartbeat = new ThinkingHeartbeat({ intervalMs: 5, lark });

  await handleBridgeMessage({
    type: "cursor_prompt_submit",
    session_id: "ghost",
    prompt: "hi"
  }, { store, lark, thinkingHeartbeat: heartbeat });

  await new Promise((resolve) => setTimeout(resolve, 12));
  heartbeat.stopAll();
  assert.equal(sent.length, 0);
});

test("returns ask when there is no binding for an approval request", async () => {
  const response = await handleBridgeMessage({
    type: "cursor_approval_request",
    session_id: "unknown-session",
    tool: "Shell",
    command: "rm -rf /tmp/foo"
  }, {
    store: tempStore(),
    approvalPolicy: tempPolicy(),
    approvalRegistry: new ApprovalRegistry()
  });

  assert.equal(response.decision, "ask");
  assert.match(String(response.reason || ""), /binding/);
});

test("returns a cached approval decision without sending a card", async () => {
  const sent = [];
  const store = tempStore();
  store.createPendingBind({
    code: "abc",
    chatId: "oc_chat",
    threadId: "omt_thread",
    expiresAt: Date.now() + 60_000
  });
  store.bindCursorSession({ code: "abc", sessionId: "cursor-session", cwd: "/tmp/project" });

  const policy = tempPolicy();
  policy.add({ tool: "Shell", commandPrefix: "git status", decision: "allow" });

  const lark = {
    async sendApprovalCard() {
      throw new Error("should not send card when policy already matches");
    },
    async sendThreadMessage(message) {
      sent.push(message);
    }
  };

  const response = await handleBridgeMessage({
    type: "cursor_approval_request",
    session_id: "cursor-session",
    tool: "Shell",
    command: "git status -uno"
  }, {
    store,
    lark,
    approvalPolicy: policy,
    approvalRegistry: new ApprovalRegistry()
  });

  assert.equal(response.decision, "allow");
  assert.match(String(response.reason || ""), /cached/);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Running: `git status -uno`/);
});

test("remembered MCP approvals are scoped to the exact MCP tool, not empty args", async () => {
  const store = tempStore();
  store.createPendingBind({
    code: "abc",
    chatId: "oc_chat",
    threadId: "omt_thread",
    expiresAt: Date.now() + 60_000
  });
  store.bindCursorSession({ code: "abc", sessionId: "cursor-session", cwd: "/tmp/project" });
  const policy = tempPolicy();
  const registry = new ApprovalRegistry();
  const promptCalls = [];
  const lark = { async sendApprovalPrompt(input) { promptCalls.push(input); } };

  const requestPromise = handleBridgeMessage({
    type: "cursor_approval_request",
    session_id: "cursor-session",
    tool: "mcp__update_doc_first",
    command: ""
  }, { store, lark, approvalPolicy: policy, approvalRegistry: registry });

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(promptCalls[0].scope, {
    commandPrefix: "",
    pathPrefix: "",
    toolScope: true
  });

  const decisionResponse = await handleBridgeMessage({
    type: "lark_approval_decision",
    request_id: promptCalls[0].requestId,
    decision: "allow",
    remember: true
  }, { store, lark, approvalPolicy: policy, approvalRegistry: registry });

  assert.equal(decisionResponse.ok, true);
  assert.equal((await requestPromise).decision, "allow");
  assert.equal(
    policy.match({ tool: "mcp__update_doc_first", command: "{}" })?.decision,
    "allow"
  );
  assert.equal(
    policy.match({ tool: "mcp__other_tool", command: "{}" }),
    undefined
  );
});

test("default text mode posts a markdown approval prompt and resolves on lark_approval_decision", async () => {
  const store = tempStore();
  store.createPendingBind({
    code: "abc",
    chatId: "oc_chat",
    threadId: "omt_thread",
    expiresAt: Date.now() + 60_000
  });
  store.bindCursorSession({ code: "abc", sessionId: "cursor-session", cwd: "/tmp/project" });
  const policy = tempPolicy();
  const registry = new ApprovalRegistry();

  const promptCalls = [];
  const cardCalls = [];
  const lark = {
    async sendApprovalPrompt(input) { promptCalls.push(input); },
    async sendApprovalCard(input) { cardCalls.push(input); }
  };

  const requestPromise = handleBridgeMessage({
    type: "cursor_approval_request",
    session_id: "cursor-session",
    tool: "Shell",
    command: "git push --force"
  }, { store, lark, approvalPolicy: policy, approvalRegistry: registry });

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(promptCalls.length, 1, "default mode should send a markdown prompt, not a card");
  assert.equal(cardCalls.length, 0);
  const requestId = promptCalls[0].requestId;
  assert.ok(requestId);

  const decisionResponse = await handleBridgeMessage({
    type: "lark_approval_decision",
    request_id: requestId,
    decision: "allow",
    remember: true
  }, { store, lark, approvalPolicy: policy, approvalRegistry: registry });

  assert.equal(decisionResponse.ok, true);
  const finalResponse = await requestPromise;
  assert.equal(finalResponse.decision, "allow");

  const matched = policy.match({ tool: "Shell", command: "git push --force-with-lease" });
  assert.equal(matched?.decision, "allow");
});

test("card mode (opt-in) posts an interactive card and still resolves on the same decision channel", async () => {
  const store = tempStore();
  store.createPendingBind({
    code: "abc",
    chatId: "oc_chat",
    threadId: "omt_thread",
    expiresAt: Date.now() + 60_000
  });
  store.bindCursorSession({ code: "abc", sessionId: "cursor-session", cwd: "/tmp/project" });
  const policy = tempPolicy();
  const registry = new ApprovalRegistry();

  const promptCalls = [];
  const cardCalls = [];
  const lark = {
    async sendApprovalPrompt(input) { promptCalls.push(input); },
    async sendApprovalCard(input) { cardCalls.push(input); }
  };

  const requestPromise = handleBridgeMessage({
    type: "cursor_approval_request",
    session_id: "cursor-session",
    tool: "Shell",
    command: "ls"
  }, {
    store, lark, approvalPolicy: policy, approvalRegistry: registry,
    approvalMode: "card"
  });

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(cardCalls.length, 1);
  assert.equal(promptCalls.length, 0);
  const requestId = cardCalls[0].requestId;

  await handleBridgeMessage({
    type: "lark_approval_decision",
    request_id: requestId,
    decision: "deny",
    remember: false
  }, { store, lark, approvalPolicy: policy, approvalRegistry: registry });

  const finalResponse = await requestPromise;
  assert.equal(finalResponse.decision, "deny");
});

test("decides the latest pending approval in a thread when the user sends /allow without a request id", async () => {
  const store = tempStore();
  store.createPendingBind({
    code: "abc",
    chatId: "oc_chat",
    threadId: "omt_thread",
    expiresAt: Date.now() + 60_000
  });
  store.bindCursorSession({ code: "abc", sessionId: "cursor-session", cwd: "/tmp/project" });
  const policy = tempPolicy();
  const registry = new ApprovalRegistry();

  const promptCalls = [];
  const lark = { async sendApprovalPrompt(input) { promptCalls.push(input); } };

  const requestPromise = handleBridgeMessage({
    type: "cursor_approval_request",
    session_id: "cursor-session",
    tool: "Shell",
    command: "rm -rf /tmp/scratch"
  }, { store, lark, approvalPolicy: policy, approvalRegistry: registry });

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(promptCalls[0].scope, {
    commandPrefix: "rm -rf",
    pathPrefix: ""
  });

  const decisionResponse = await handleBridgeMessage({
    type: "lark_approval_decision",
    chat_id: "oc_chat",
    thread_id: "omt_thread",
    decision: "allow",
    remember: false
  }, { store, lark, approvalPolicy: policy, approvalRegistry: registry });
  assert.equal(decisionResponse.ok, true);
  assert.equal(decisionResponse.request_id, promptCalls[0].requestId);
  assert.equal(decisionResponse.decision, "allow");

  const finalResponse = await requestPromise;
  assert.equal(finalResponse.decision, "allow");
});

test("falls back to chat-only routing when /allow's thread_id is the new reply message id (single binding)", async () => {
  const store = tempStore();
  store.createPendingBind({
    code: "abc",
    chatId: "oc_chat",
    threadId: "omt_thread_root",
    expiresAt: Date.now() + 60_000
  });
  store.bindCursorSession({ code: "abc", sessionId: "cursor-session", cwd: "/tmp/project" });
  const policy = tempPolicy();
  const registry = new ApprovalRegistry();

  const promptCalls = [];
  const lark = { async sendApprovalPrompt(input) { promptCalls.push(input); } };

  const requestPromise = handleBridgeMessage({
    type: "cursor_approval_request",
    session_id: "cursor-session",
    tool: "Shell",
    command: "git push --force"
  }, { store, lark, approvalPolicy: policy, approvalRegistry: registry });

  await new Promise((resolve) => setTimeout(resolve, 5));

  // Compact event for the user's reply often lacks root_id, so listener falls back
  // to the new reply message_id as thread_id. Bridge must still route this to the
  // correct binding when there is exactly one binding for this chat.
  const decisionResponse = await handleBridgeMessage({
    type: "lark_approval_decision",
    chat_id: "oc_chat",
    thread_id: "om_new_reply_id",
    decision: "allow",
    remember: true
  }, { store, lark, approvalPolicy: policy, approvalRegistry: registry });

  assert.equal(decisionResponse.ok, true, "decision should be matched to the single chat binding");
  const finalResponse = await requestPromise;
  assert.equal(finalResponse.decision, "allow");

  const matched = policy.match({ tool: "Shell", command: "git push --force-with-lease" });
  assert.equal(matched?.decision, "allow", "remember should produce a policy rule");
});

test("resolves bare /allow by the only pending approval in the chat when thread ids do not line up", async () => {
  const store = tempStore();
  store.createPendingBind({
    code: "abc1",
    chatId: "oc_chat",
    threadId: "omt_thread_root",
    expiresAt: Date.now() + 60_000
  });
  store.bindCursorSession({ code: "abc1", sessionId: "cursor-session-1", cwd: "/tmp/project" });
  store.createPendingBind({
    code: "abc2",
    chatId: "oc_chat",
    threadId: "omt_other_thread",
    expiresAt: Date.now() + 60_000
  });
  store.bindCursorSession({ code: "abc2", sessionId: "cursor-session-2", cwd: "/tmp/project" });
  const policy = tempPolicy();
  const registry = new ApprovalRegistry();
  const lark = { async sendApprovalPrompt() {} };

  const requestPromise = handleBridgeMessage({
    type: "cursor_approval_request",
    session_id: "cursor-session-1",
    tool: "Shell",
    command: "git push --force"
  }, { store, lark, approvalPolicy: policy, approvalRegistry: registry });

  await new Promise((resolve) => setTimeout(resolve, 5));

  const decisionResponse = await handleBridgeMessage({
    type: "lark_approval_decision",
    chat_id: "oc_chat",
    thread_id: "om_approval_reply_message_id",
    decision: "allow",
    remember: true
  }, { store, lark, approvalPolicy: policy, approvalRegistry: registry });

  assert.equal(decisionResponse.ok, true);
  assert.ok(decisionResponse.request_id);
  const finalResponse = await requestPromise;
  assert.equal(finalResponse.decision, "allow");
});

test("tool-scoped /allow shell! resolves all pending Shell approvals and remembers Shell-wide", async () => {
  const store = tempStore();
  store.createPendingBind({ code: "abc", chatId: "oc_chat", threadId: "omt_thread", expiresAt: Date.now() + 60_000 });
  store.bindCursorSession({ code: "abc", sessionId: "cursor-session", cwd: "/tmp/project" });
  const policy = tempPolicy();
  const registry = new ApprovalRegistry();
  const lark = { async sendApprovalPrompt() {} };

  const first = handleBridgeMessage({
    type: "cursor_approval_request",
    session_id: "cursor-session",
    tool: "Shell",
    command: "git status --short"
  }, { store, lark, approvalPolicy: policy, approvalRegistry: registry });
  const second = handleBridgeMessage({
    type: "cursor_approval_request",
    session_id: "cursor-session",
    tool: "Shell",
    command: "git diff --stat"
  }, { store, lark, approvalPolicy: policy, approvalRegistry: registry });

  await new Promise((resolve) => setTimeout(resolve, 5));

  const decisionResponse = await handleBridgeMessage({
    type: "lark_approval_decision",
    chat_id: "oc_chat",
    thread_id: "omt_unrelated_reply_thread",
    decision: "allow",
    remember: true,
    tool_scope: "Shell"
  }, { store, lark, approvalPolicy: policy, approvalRegistry: registry });

  assert.equal(decisionResponse.ok, true);
  assert.equal(decisionResponse.count, 2);
  assert.equal((await first).decision, "allow");
  assert.equal((await second).decision, "allow");

  assert.equal(policy.match({ tool: "Shell", command: "npm test" })?.decision, "allow");
});

test("command-scoped /allow pnpm! resolves all pending pnpm Shell approvals and remembers pnpm", async () => {
  const store = tempStore();
  store.createPendingBind({ code: "abc", chatId: "oc_chat", threadId: "omt_thread", expiresAt: Date.now() + 60_000 });
  store.bindCursorSession({ code: "abc", sessionId: "cursor-session", cwd: "/tmp/project" });
  const policy = tempPolicy();
  const registry = new ApprovalRegistry();
  const lark = { async sendApprovalPrompt() {} };

  const first = handleBridgeMessage({
    type: "cursor_approval_request",
    session_id: "cursor-session",
    tool: "Shell",
    command: "pnpm rebuild sqlite3"
  }, { store, lark, approvalPolicy: policy, approvalRegistry: registry });
  const second = handleBridgeMessage({
    type: "cursor_approval_request",
    session_id: "cursor-session",
    tool: "Shell",
    command: "pnpm exec tsx --version"
  }, { store, lark, approvalPolicy: policy, approvalRegistry: registry });

  await new Promise((resolve) => setTimeout(resolve, 5));

  const decisionResponse = await handleBridgeMessage({
    type: "lark_approval_decision",
    chat_id: "oc_chat",
    thread_id: "omt_unrelated_reply_thread",
    decision: "allow",
    remember: true,
    command_scope: "pnpm"
  }, { store, lark, approvalPolicy: policy, approvalRegistry: registry });

  assert.equal(decisionResponse.ok, true);
  assert.equal(decisionResponse.count, 2);
  assert.equal((await first).decision, "allow");
  assert.equal((await second).decision, "allow");

  assert.equal(policy.match({ tool: "Shell", command: "pnpm test" })?.decision, "allow");
  assert.equal(policy.match({ tool: "Shell", command: "npm test" }), undefined);
});

test("command-scoped /allow! shell node resolves node Shell approvals and remembers node", async () => {
  const store = tempStore();
  store.createPendingBind({ code: "abc", chatId: "oc_chat", threadId: "omt_thread", expiresAt: Date.now() + 60_000 });
  store.bindCursorSession({ code: "abc", sessionId: "cursor-session", cwd: "/tmp/project" });
  const policy = tempPolicy();
  const registry = new ApprovalRegistry();
  const lark = { async sendApprovalPrompt() {} };

  const first = handleBridgeMessage({
    type: "cursor_approval_request",
    session_id: "cursor-session",
    tool: "Shell",
    command: "node --test tests/foo.test.js"
  }, { store, lark, approvalPolicy: policy, approvalRegistry: registry });
  const other = handleBridgeMessage({
    type: "cursor_approval_request",
    session_id: "cursor-session",
    tool: "Shell",
    command: "pnpm test"
  }, { store, lark, approvalPolicy: policy, approvalRegistry: registry });

  await new Promise((resolve) => setTimeout(resolve, 5));

  const decisionResponse = await handleBridgeMessage({
    type: "lark_approval_decision",
    chat_id: "oc_chat",
    thread_id: "omt_unrelated_reply_thread",
    decision: "allow",
    remember: true,
    command_scope: "node"
  }, { store, lark, approvalPolicy: policy, approvalRegistry: registry });

  assert.equal(decisionResponse.ok, true);
  assert.equal(decisionResponse.count, 1);
  assert.equal((await first).decision, "allow");
  assert.equal(policy.match({ tool: "Shell", command: "node --version" })?.decision, "allow");
  assert.equal(policy.match({ tool: "Shell", command: "pnpm --version" }), undefined);

  await handleBridgeMessage({
    type: "lark_approval_decision",
    chat_id: "oc_chat",
    thread_id: "omt_thread",
    decision: "deny",
    remember: false
  }, { store, lark, approvalPolicy: policy, approvalRegistry: registry });
  assert.equal((await other).decision, "deny");
});

test("tool-scoped /allow mcp__tool! resolves matching MCP approvals and remembers that tool", async () => {
  const store = tempStore();
  store.createPendingBind({ code: "abc", chatId: "oc_chat", threadId: "omt_thread", expiresAt: Date.now() + 60_000 });
  store.bindCursorSession({ code: "abc", sessionId: "cursor-session", cwd: "/tmp/project" });
  const policy = tempPolicy();
  const registry = new ApprovalRegistry();
  const lark = { async sendApprovalPrompt() {} };

  const first = handleBridgeMessage({
    type: "cursor_approval_request",
    session_id: "cursor-session",
    tool: "mcp__user-Playwright__open_page",
    command: "{\"url\":\"https://example.com\"}"
  }, { store, lark, approvalPolicy: policy, approvalRegistry: registry });
  const second = handleBridgeMessage({
    type: "cursor_approval_request",
    session_id: "cursor-session",
    tool: "mcp__user-Playwright__open_page",
    command: "{}"
  }, { store, lark, approvalPolicy: policy, approvalRegistry: registry });
  const other = handleBridgeMessage({
    type: "cursor_approval_request",
    session_id: "cursor-session",
    tool: "mcp__user-Playwright__click",
    command: "{}"
  }, { store, lark, approvalPolicy: policy, approvalRegistry: registry });

  await new Promise((resolve) => setTimeout(resolve, 5));

  const decisionResponse = await handleBridgeMessage({
    type: "lark_approval_decision",
    chat_id: "oc_chat",
    thread_id: "omt_thread",
    decision: "allow",
    remember: true,
    tool_scope: "mcp__user-Playwright__open_page"
  }, { store, lark, approvalPolicy: policy, approvalRegistry: registry });

  assert.equal(decisionResponse.ok, true);
  assert.equal(decisionResponse.count, 2);
  assert.equal((await first).decision, "allow");
  assert.equal((await second).decision, "allow");
  assert.equal(policy.match({ tool: "mcp__user-Playwright__open_page", command: "{\"url\":\"https://cursor.com\"}" })?.decision, "allow");
  assert.equal(policy.match({ tool: "mcp__user-Playwright__click", command: "{}" }), undefined);

  await handleBridgeMessage({
    type: "lark_approval_decision",
    chat_id: "oc_chat",
    thread_id: "omt_thread",
    decision: "deny",
    remember: false
  }, { store, lark, approvalPolicy: policy, approvalRegistry: registry });
  assert.equal((await other).decision, "deny");
});

test("remembered path-based tool approvals are scoped to the bound project cwd", async () => {
  const store = tempStore();
  store.createPendingBind({
    code: "abc",
    chatId: "oc_chat",
    threadId: "omt_thread",
    expiresAt: Date.now() + 60_000
  });
  store.bindCursorSession({ code: "abc", sessionId: "cursor-session", cwd: "/tmp/project" });
  const policy = tempPolicy();
  const registry = new ApprovalRegistry();

  const promptCalls = [];
  const lark = { async sendApprovalPrompt(input) { promptCalls.push(input); } };

  const requestPromise = handleBridgeMessage({
    type: "cursor_approval_request",
    session_id: "cursor-session",
    tool: "Write",
    command: "" // simulate hook input that does not surface a path field
  }, { store, lark, approvalPolicy: policy, approvalRegistry: registry });

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(promptCalls[0].scope, {
    commandPrefix: "",
    pathPrefix: "/tmp/project/"
  });

  const decisionResponse = await handleBridgeMessage({
    type: "lark_approval_decision",
    chat_id: "oc_chat",
    thread_id: "omt_thread",
    decision: "allow",
    remember: true
  }, { store, lark, approvalPolicy: policy, approvalRegistry: registry });

  assert.equal(decisionResponse.ok, true);
  const finalResponse = await requestPromise;
  assert.equal(finalResponse.decision, "allow");

  const [rule] = policy.list();
  assert.equal(rule.tool, "Write");
  assert.equal(rule.commandPrefix, "");
  assert.equal(rule.pathPrefix, "/tmp/project/");

  const cachedResponse = await handleBridgeMessage({
    type: "cursor_approval_request",
    session_id: "cursor-session",
    tool: "Write",
    command: "/tmp/project/src/another-file.js"
  }, { store, lark, approvalPolicy: policy, approvalRegistry: registry });
  assert.equal(cachedResponse.decision, "allow");
  assert.match(String(cachedResponse.reason || ""), /cached/);
});

test("times out approval requests with ask when no decision arrives", async () => {
  const store = tempStore();
  store.createPendingBind({
    code: "abc",
    chatId: "oc_chat",
    threadId: "omt_thread",
    expiresAt: Date.now() + 60_000
  });
  store.bindCursorSession({ code: "abc", sessionId: "cursor-session", cwd: "/tmp/project" });

  const lark = { async sendApprovalCard() {} };
  const response = await handleBridgeMessage({
    type: "cursor_approval_request",
    session_id: "cursor-session",
    tool: "Shell",
    command: "rm -rf /tmp/scratch"
  }, {
    store,
    lark,
    approvalPolicy: tempPolicy(),
    approvalRegistry: new ApprovalRegistry(),
    approvalTimeoutMs: 30
  });

  assert.equal(response.decision, "ask");
  assert.match(String(response.reason || ""), /timeout/);
});

test("runs official agent bindings without waiting for Cursor hooks", async () => {
  const sent = [];
  const reactions = [];
  const prompts = [];
  const store = tempStore();

  await handleBridgeMessage({
    type: "lark_create_agent_bind",
    chat_id: "oc_chat",
    thread_id: "om_agent_root",
    reply_message_id: "om_agent_root",
    cwd: "/tmp/project"
  }, { store });

  const response = await handleBridgeMessage({
    type: "lark_message",
    chat_id: "oc_chat",
    thread_id: "om_agent_root",
    message_id: "om_followup",
    text: "远程继续实现"
  }, {
    store,
    lark: {
      async sendThreadMessage(message) {
        sent.push(message);
      },
      async addReaction(input) {
        reactions.push(input);
      }
    },
    cursorRunner: {
      async runPrompt(input) {
        prompts.push(input);
        return { text: "agent done", agentSessionId: "agent_123" };
      }
    }
  });

  assert.deepEqual(response, { ok: true, routed: "official_agent" });
  assert.deepEqual(prompts, [{
    cwd: "/tmp/project",
    prompt: "远程继续实现",
    agentSessionId: undefined
  }]);
  assert.deepEqual(reactions, [{ messageId: "om_followup", emoji: "EYES" }]);
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /Got it/);
  assert.equal(sent[1].text, "agent done");
  assert.equal(
    store.getBindingByLarkThread("oc_chat", "om_agent_root").agentSessionId,
    "agent_123"
  );
});
