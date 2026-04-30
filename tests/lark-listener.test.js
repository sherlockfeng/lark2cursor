import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { handleLarkEventLine, startLarkEventListener } from "../src/lark-listener.js";

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = false;
  }
  kill() {
    this.killed = true;
  }
}

test("forwards compact Lark event lines to the bridge", async () => {
  const sent = [];
  const result = await handleLarkEventLine(JSON.stringify({
    type: "im.message.receive_v1",
    chat_id: "oc_chat",
    message_id: "om_message",
    thread_id: "omt_thread",
    content: "从飞书继续"
  }), async (message) => {
    sent.push(message);
    return { ok: true };
  });

  assert.equal(result, true);
  assert.deepEqual(sent, [{
    type: "lark_message",
    chat_id: "oc_chat",
    thread_id: "omt_thread",
    message_id: "om_message",
    reply_message_id: "om_message",
    text: "从飞书继续"
  }]);
});

test("creates a bind for the canonical English `bind chat` command", async () => {
  const sent = [];
  const replies = [];
  const result = await handleLarkEventLine(JSON.stringify({
    type: "im.message.receive_v1",
    chat_id: "oc_chat",
    message_id: "om_message",
    content: "@Feishu CLI bind chat",
    mentions: [{ id: "cli_test_app_id", name: "Feishu CLI" }]
  }), {
    send: async (message) => {
      sent.push(message);
      return { ok: true };
    },
    lark: {
      async sendThreadMessage(message) {
        replies.push(message);
      }
    }
  });

  assert.equal(result, true);
  assert.deepEqual(sent, [{
    type: "lark_create_bind",
    chat_id: "oc_chat",
    thread_id: "om_message",
    reply_message_id: "om_message",
    code: "om_message"
  }]);
  assert.deepEqual(replies, [{
    chatId: "oc_chat",
    threadId: "om_message",
    replyMessageId: "om_message",
    text: "message_id: om_message"
  }]);
});

test("does not create a bind for mentioned non-bind messages", async () => {
  const sent = [];
  const replies = [];
  await handleLarkEventLine(JSON.stringify({
    type: "im.message.receive_v1",
    chat_id: "oc_chat",
    message_id: "om_message",
    content: "@Feishu CLI 你好",
    mentions: [{ id: "cli_test_app_id", name: "Feishu CLI" }]
  }), {
    send: async (message) => {
      sent.push(message);
      return { ok: true };
    },
    lark: {
      async sendThreadMessage(message) {
        replies.push(message);
      }
    }
  });

  assert.deepEqual(sent, [{
    type: "lark_message",
    chat_id: "oc_chat",
    thread_id: "om_message",
    message_id: "om_message",
    reply_message_id: "om_message",
    text: "@Feishu CLI 你好"
  }]);
  assert.deepEqual(replies, []);
});

test("creates an official Cursor agent binding for the canonical English command", async () => {
  const sent = [];
  const replies = [];
  const result = await handleLarkEventLine(JSON.stringify({
    type: "im.message.receive_v1",
    chat_id: "oc_chat",
    message_id: "om_agent_root",
    content: "@Feishu CLI create cursor agent",
    mentions: [{ id: "cli_current_user_app", name: "Feishu CLI" }]
  }), {
    send: async (message) => {
      sent.push(message);
      return { ok: true };
    },
    lark: {
      async sendThreadMessage(message) {
        replies.push(message);
      }
    }
  });

  assert.equal(result, true);
  assert.deepEqual(sent, [{
    type: "lark_create_agent_bind",
    chat_id: "oc_chat",
    thread_id: "om_agent_root",
    reply_message_id: "om_agent_root"
  }]);
  assert.deepEqual(replies, [{
    chatId: "oc_chat",
    threadId: "om_agent_root",
    replyMessageId: "om_agent_root",
    text: "Cursor Agent chat created. @ the bot in this thread to keep the conversation going."
  }]);
});

test("sends a disable wait command for the canonical English `stop wait` form", async () => {
  const sent = [];
  const replies = [];
  const result = await handleLarkEventLine(JSON.stringify({
    type: "im.message.receive_v1",
    chat_id: "oc_chat",
    message_id: "om_stop_wait",
    thread_id: "omt_thread",
    content: "@Feishu CLI stop wait",
    mentions: [{ id: "cli_current_user_app", name: "Feishu CLI" }]
  }), {
    send: async (message) => {
      sent.push(message);
      return { ok: true };
    },
    lark: {
      async sendThreadMessage(message) {
        replies.push(message);
      }
    }
  });

  assert.equal(result, true);
  assert.deepEqual(sent, [{
    type: "lark_disable_wait",
    chat_id: "oc_chat",
    thread_id: "omt_thread",
    reply_message_id: "om_stop_wait"
  }]);
  assert.deepEqual(replies, [{
    chatId: "oc_chat",
    threadId: "omt_thread",
    replyMessageId: "om_stop_wait",
    text: "Continuous Cursor Chat waiting disabled for this thread."
  }]);
});

test("sends an unbind command for the current thread", async () => {
  const sent = [];
  const replies = [];
  const result = await handleLarkEventLine(JSON.stringify({
    type: "im.message.receive_v1",
    chat_id: "oc_chat",
    message_id: "om_unbind",
    thread_id: "omt_thread",
    content: "@Feishu CLI unbind",
    mentions: [{ id: "cli_current_user_app", name: "Feishu CLI" }]
  }), {
    send: async (message) => {
      sent.push(message);
      return { ok: true, removed: true };
    },
    lark: {
      async sendThreadMessage(message) {
        replies.push(message);
      }
    }
  });

  assert.equal(result, true);
  assert.deepEqual(sent, [{
    type: "lark_unbind_thread",
    chat_id: "oc_chat",
    thread_id: "omt_thread",
    reply_message_id: "om_unbind"
  }]);
  assert.deepEqual(replies, [{
    chatId: "oc_chat",
    threadId: "omt_thread",
    replyMessageId: "om_unbind",
    text: "This Lark thread is now unbound."
  }]);
});

test("resolves command thread ids from Lark message metadata when available", async () => {
  const sent = [];
  const replies = [];
  const result = await handleLarkEventLine(JSON.stringify({
    type: "im.message.receive_v1",
    chat_id: "oc_chat",
    message_id: "om_unbind_reply",
    thread_id: "om_unbind_reply",
    content: "@Feishu CLI unbind",
    mentions: [{ id: "cli_current_user_app", name: "Feishu CLI" }]
  }), {
    send: async (message) => {
      sent.push(message);
      return { ok: true, removed: true };
    },
    lark: {
      async getMessageThreadId(messageId) {
        assert.equal(messageId, "om_unbind_reply");
        return "omt_real_thread";
      },
      async sendThreadMessage(message) {
        replies.push(message);
      }
    }
  });

  assert.equal(result, true);
  assert.equal(sent[0].thread_id, "omt_real_thread");
  assert.equal(sent[0].reply_message_id, "om_unbind_reply");
  assert.equal(replies[0].threadId, "omt_real_thread");
  assert.equal(replies[0].replyMessageId, "om_unbind_reply");
});

test("still recognises the legacy zh-CN aliases for backward compatibility", async () => {
  const cases = [
    { content: "@Feishu CLI 绑定对话", expected: "lark_create_bind" },
    { content: "@Feishu CLI 创建 Cursor Agent 对话", expected: "lark_create_agent_bind" },
    { content: "@Feishu CLI 停止等待", expected: "lark_disable_wait" },
    { content: "@Feishu CLI 解除绑定", expected: "lark_unbind_thread" },
    { content: "@Feishu CLI 关闭等待", expected: "lark_disable_wait" }
  ];

  for (const { content, expected } of cases) {
    const sent = [];
    await handleLarkEventLine(JSON.stringify({
      type: "im.message.receive_v1",
      chat_id: "oc_chat",
      message_id: "om_legacy",
      thread_id: "omt_thread",
      content,
      mentions: [{ id: "cli", name: "Feishu CLI" }]
    }), {
      send: async (message) => { sent.push(message); return { ok: true }; },
      lark: { async sendThreadMessage() {} }
    });
    assert.equal(sent[0].type, expected, `"${content}" should still produce ${expected}`);
  }
});

test("recognises 'pause wait' and 'disable wait' English variants", async () => {
  for (const variant of ["pause wait", "disable wait", "Stop Wait", "Pause Waiting"]) {
    const sent = [];
    await handleLarkEventLine(JSON.stringify({
      type: "im.message.receive_v1",
      chat_id: "oc_chat",
      message_id: "om_v",
      thread_id: "omt_thread",
      content: `@Feishu CLI ${variant}`,
      mentions: [{ id: "cli", name: "Feishu CLI" }]
    }), {
      send: async (message) => { sent.push(message); return { ok: true }; },
      lark: { async sendThreadMessage() {} }
    });
    assert.equal(sent[0].type, "lark_disable_wait", `variant "${variant}" should disable wait`);
  }
});

test("parses /allow with a request id as a remembered allow decision when bang is set", async () => {
  const sent = [];
  const result = await handleLarkEventLine(JSON.stringify({
    type: "im.message.receive_v1",
    chat_id: "oc_chat",
    thread_id: "omt_thread",
    message_id: "om_cmd",
    content: "/allow! req_abc12"
  }), async (message) => {
    sent.push(message);
    return { ok: true };
  });

  assert.equal(result, true);
  assert.deepEqual(sent, [{
    type: "lark_approval_decision",
    request_id: "req_abc12",
    decision: "allow",
    remember: true,
    chat_id: "oc_chat",
    thread_id: "omt_thread",
    message_id: "om_cmd"
  }]);
});

test("parses bare /deny without a request id and forwards latest-thread hint", async () => {
  const sent = [];
  await handleLarkEventLine(JSON.stringify({
    type: "im.message.receive_v1",
    chat_id: "oc_chat",
    thread_id: "omt_thread",
    message_id: "om_cmd",
    content: "  /deny  "
  }), async (message) => {
    sent.push(message);
    return { ok: true };
  });

  assert.deepEqual(sent, [{
    type: "lark_approval_decision",
    decision: "deny",
    remember: false,
    chat_id: "oc_chat",
    thread_id: "omt_thread",
    message_id: "om_cmd"
  }]);
});

test("replies with the resolved approval id after a successful /allow command", async () => {
  const sent = [];
  const replies = [];
  await handleLarkEventLine(JSON.stringify({
    type: "im.message.receive_v1",
    chat_id: "oc_chat",
    thread_id: "omt_thread",
    message_id: "om_cmd",
    content: "/allow"
  }), {
    send: async (message) => {
      sent.push(message);
      return { ok: true, request_id: "cfd5d488", decision: "allow" };
    },
    lark: {
      async sendThreadMessage(message) {
        replies.push(message);
      }
    }
  });

  assert.equal(sent.length, 1);
  assert.equal(replies.length, 1);
  assert.deepEqual(replies[0], {
    chatId: "oc_chat",
    threadId: "omt_thread",
    replyMessageId: "om_cmd",
    text: "Approval cfd5d488 allowed successfully."
  });
});

test("replies with guidance when an approval command does not match a pending request", async () => {
  const replies = [];
  await handleLarkEventLine(JSON.stringify({
    type: "im.message.receive_v1",
    chat_id: "oc_chat",
    thread_id: "omt_thread",
    message_id: "om_cmd",
    content: "/allow!"
  }), {
    send: async () => ({ ok: false }),
    lark: {
      async sendThreadMessage(message) {
        replies.push(message);
      }
    }
  });

  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /No pending approval matched/);
  assert.match(replies[0].text, /\/allow <request_id>/);
});

test("parses tool-scoped approval commands like /allow shell!", async () => {
  const sent = [];
  await handleLarkEventLine(JSON.stringify({
    type: "im.message.receive_v1",
    chat_id: "oc_chat",
    thread_id: "omt_thread",
    message_id: "om_cmd",
    content: "/allow shell!"
  }), {
    send: async (message) => {
      sent.push(message);
      return { ok: true, decision: "allow", tool_scope: "Shell", count: 2 };
    },
    lark: { async sendThreadMessage() {} }
  });

  assert.deepEqual(sent, [{
    type: "lark_approval_decision",
    decision: "allow",
    remember: true,
    tool_scope: "Shell",
    chat_id: "oc_chat",
    thread_id: "omt_thread",
    message_id: "om_cmd"
  }]);
});

test("parses package-manager scoped approval commands like /allow pnpm!", async () => {
  const sent = [];
  await handleLarkEventLine(JSON.stringify({
    type: "im.message.receive_v1",
    chat_id: "oc_chat",
    thread_id: "omt_thread",
    message_id: "om_cmd",
    content: "/allow pnpm!"
  }), {
    send: async (message) => {
      sent.push(message);
      return { ok: true, decision: "allow", command_scope: "pnpm", count: 2 };
    },
    lark: { async sendThreadMessage() {} }
  });

  assert.deepEqual(sent, [{
    type: "lark_approval_decision",
    decision: "allow",
    remember: true,
    command_scope: "pnpm",
    chat_id: "oc_chat",
    thread_id: "omt_thread",
    message_id: "om_cmd"
  }]);
});

test("parses /allow! shell node as a Shell command-prefix approval", async () => {
  const sent = [];
  await handleLarkEventLine(JSON.stringify({
    type: "im.message.receive_v1",
    chat_id: "oc_chat",
    thread_id: "omt_thread",
    message_id: "om_cmd",
    content: "/allow! shell node"
  }), {
    send: async (message) => {
      sent.push(message);
      return { ok: true, decision: "allow", command_scope: "node", count: 1 };
    },
    lark: { async sendThreadMessage() {} }
  });

  assert.deepEqual(sent, [{
    type: "lark_approval_decision",
    decision: "allow",
    remember: true,
    command_scope: "node",
    chat_id: "oc_chat",
    thread_id: "omt_thread",
    message_id: "om_cmd"
  }]);
});

test("parses /allow! write and /allow! read as tool-scoped approvals", async () => {
  const sent = [];
  for (const content of ["/allow! write", "/allow! read"]) {
    await handleLarkEventLine(JSON.stringify({
      type: "im.message.receive_v1",
      chat_id: "oc_chat",
      thread_id: "omt_thread",
      message_id: `om_${content}`,
      content
    }), {
      send: async (message) => {
        sent.push(message);
        return { ok: true, decision: "allow", tool_scope: message.tool_scope, count: 1 };
      },
      lark: { async sendThreadMessage() {} }
    });
  }

  assert.equal(sent[0].tool_scope, "Write");
  assert.equal(sent[0].remember, true);
  assert.equal(sent[1].tool_scope, "ReadFile");
  assert.equal(sent[1].remember, true);
});

test("parses exact MCP tool scoped approval commands", async () => {
  const sent = [];
  await handleLarkEventLine(JSON.stringify({
    type: "im.message.receive_v1",
    chat_id: "oc_chat",
    thread_id: "omt_thread",
    message_id: "om_cmd",
    content: "/allow mcp__user-Playwright__open_page!"
  }), {
    send: async (message) => {
      sent.push(message);
      return { ok: true, decision: "allow", tool_scope: message.tool_scope, count: 1 };
    },
    lark: { async sendThreadMessage() {} }
  });

  assert.deepEqual(sent, [{
    type: "lark_approval_decision",
    decision: "allow",
    remember: true,
    tool_scope: "mcp__user-Playwright__open_page",
    chat_id: "oc_chat",
    thread_id: "omt_thread",
    message_id: "om_cmd"
  }]);
});

test("replies with help text for /help", async () => {
  const sent = [];
  const replies = [];
  await handleLarkEventLine(JSON.stringify({
    type: "im.message.receive_v1",
    chat_id: "oc_chat",
    thread_id: "omt_thread",
    message_id: "om_x",
    content: "/help"
  }), {
    send: async (message) => {
      sent.push(message);
      return { ok: true };
    },
    lark: {
      async sendThreadMessage(message) {
        replies.push(message);
      }
    }
  });

  assert.deepEqual(sent, []);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].chatId, "oc_chat");
  assert.equal(replies[0].threadId, "omt_thread");
  assert.equal(replies[0].replyMessageId, "om_x");
  assert.match(replies[0].text, /bind chat/);
  assert.match(replies[0].text, /unbind/);
  assert.match(replies[0].text, /\/allow!/);
  assert.doesNotMatch(replies[0].text, /create cursor agent/);
});

test("parses /allow! when the message starts with a multi-word @bot mention", async () => {
  const sent = [];
  const result = await handleLarkEventLine(JSON.stringify({
    type: "im.message.receive_v1",
    chat_id: "oc_chat",
    thread_id: "omt_thread",
    message_id: "om_cmd",
    content: "@贺云风's Feishu CLI /allow!"
  }), async (message) => {
    sent.push(message);
    return { ok: true };
  });

  assert.equal(result, true);
  assert.deepEqual(sent, [{
    type: "lark_approval_decision",
    decision: "allow",
    remember: true,
    chat_id: "oc_chat",
    thread_id: "omt_thread",
    message_id: "om_cmd"
  }]);
});

test("parses /allow with a short hex request id (no req_ prefix)", async () => {
  const sent = [];
  await handleLarkEventLine(JSON.stringify({
    type: "im.message.receive_v1",
    chat_id: "oc_chat",
    thread_id: "omt_thread",
    message_id: "om_cmd",
    content: "@bot /allow 77e6e968"
  }), async (message) => {
    sent.push(message);
    return { ok: true };
  });

  assert.deepEqual(sent, [{
    type: "lark_approval_decision",
    request_id: "77e6e968",
    decision: "allow",
    remember: false,
    chat_id: "oc_chat",
    thread_id: "omt_thread",
    message_id: "om_cmd"
  }]);
});

test("recognises /allow! when content arrives as Lark <at> markup (real compact shape)", async () => {
  const sent = [];
  await handleLarkEventLine(JSON.stringify({
    type: "im.message.receive_v1",
    chat_id: "oc_chat",
    thread_id: "omt_thread",
    message_id: "om_cmd",
    content: "<at user_id=\"ou_xxx\">贺云风's Feishu CLI</at> /allow!"
  }), async (message) => {
    sent.push(message);
    return { ok: true };
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "lark_approval_decision");
  assert.equal(sent[0].decision, "allow");
  assert.equal(sent[0].remember, true);
});

test("recognises /allow inside JSON-string content (real compact shape)", async () => {
  const sent = [];
  await handleLarkEventLine(JSON.stringify({
    type: "im.message.receive_v1",
    chat_id: "oc_chat",
    thread_id: "omt_thread",
    message_id: "om_cmd",
    content: "{\"text\":\"<at user_id=\\\"ou_xxx\\\">贺云风's Feishu CLI</at> /allow 6d0e78fa\"}"
  }), async (message) => {
    sent.push(message);
    return { ok: true };
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "lark_approval_decision");
  assert.equal(sent[0].decision, "allow");
  assert.equal(sent[0].request_id, "6d0e78fa");
});

test("does not treat /allow inside a sentence as a decision", async () => {
  const sent = [];
  await handleLarkEventLine(JSON.stringify({
    type: "im.message.receive_v1",
    chat_id: "oc_chat",
    thread_id: "omt_thread",
    message_id: "om_x",
    content: "use /allow when you want to approve"
  }), async (message) => {
    sent.push(message);
    return { ok: true };
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "lark_message");
});

test("forwards card.action.trigger events as approval decisions", async () => {
  const sent = [];
  const result = await handleLarkEventLine(JSON.stringify({
    type: "card.action.trigger",
    schema: "2.0",
    event: {
      operator: { open_id: "ou_user" },
      action: {
        tag: "button",
        value: { req: "req_abc", decision: "allow", remember: true }
      },
      context: {
        open_message_id: "om_card",
        open_chat_id: "oc_chat"
      }
    }
  }), async (message) => {
    sent.push(message);
    return { ok: true };
  });

  assert.equal(result, true);
  assert.deepEqual(sent, [{
    type: "lark_approval_decision",
    request_id: "req_abc",
    decision: "allow",
    remember: true,
    operator_open_id: "ou_user",
    chat_id: "oc_chat",
    message_id: "om_card"
  }]);
});

test("forwards approval card events that ship as compact event objects", async () => {
  const sent = [];
  await handleLarkEventLine(JSON.stringify({
    type: "card.action.trigger",
    operator: { open_id: "ou_user" },
    action: { value: { req: "req_xyz", decision: "deny", remember: false } },
    open_chat_id: "oc_chat",
    open_message_id: "om_card"
  }), async (message) => {
    sent.push(message);
    return { ok: true };
  });

  assert.deepEqual(sent, [{
    type: "lark_approval_decision",
    request_id: "req_xyz",
    decision: "deny",
    remember: false,
    operator_open_id: "ou_user",
    chat_id: "oc_chat",
    message_id: "om_card"
  }]);
});

test("respawns the lark-cli child process when it exits", async () => {
  const spawned = [];
  const sleeps = [];
  const logs = [];
  const child1 = new FakeChild();
  const child2 = new FakeChild();
  const queue = [child1, child2];

  const handle = startLarkEventListener({
    spawnProcess(command, args) {
      spawned.push({ command, args });
      return queue.shift() || new FakeChild();
    },
    send: async () => ({ ok: true }),
    log(message) {
      logs.push(message);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    respawnDelayMs: 250
  });

  assert.equal(spawned.length, 1);
  child1.emit("exit", 1, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spawned.length, 2);
  assert.deepEqual(sleeps, [250]);
  assert.ok(logs.some((line) => line.includes("lark-cli child exited")));

  handle.stop();
  assert.equal(child2.killed, true);
});

test("ignores malformed or unsupported Lark event lines", async () => {
  assert.equal(await handleLarkEventLine("{bad json", async () => {
    throw new Error("should not send");
  }), false);

  assert.equal(await handleLarkEventLine(JSON.stringify({
    type: "im.message.receive_v1",
    chat_id: "oc_chat",
    message_id: "om_message",
    content: ""
  }), async () => {
    throw new Error("should not send");
  }), false);
});
