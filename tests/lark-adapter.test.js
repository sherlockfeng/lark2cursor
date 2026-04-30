import assert from "node:assert/strict";
import test from "node:test";
import {
  createLarkCliAdapter,
  normalizeLarkEventToBridgeMessage
} from "../src/lark-adapter.js";

test("normalizes compact Lark message events to bridge messages", () => {
  const message = normalizeLarkEventToBridgeMessage({
    type: "im.message.receive_v1",
    chat_id: "oc_chat",
    message_id: "om_message",
    thread_id: "omt_thread",
    content: "继续实现真实飞书接入"
  });

  assert.deepEqual(message, {
    type: "lark_message",
    chat_id: "oc_chat",
    thread_id: "omt_thread",
    message_id: "om_message",
    reply_message_id: "om_message",
    text: "继续实现真实飞书接入"
  });
});

test("prefers Lark root_id over reply thread_id when both are present", () => {
  const message = normalizeLarkEventToBridgeMessage({
    type: "im.message.receive_v1",
    chat_id: "oc_chat",
    message_id: "om_reply",
    thread_id: "om_reply",
    root_id: "om_root",
    content: "@bot /unbind"
  });

  assert.equal(message.thread_id, "om_root");
  assert.equal(message.reply_message_id, "om_root");
});

test("ignores non-message or empty Lark events", () => {
  assert.equal(normalizeLarkEventToBridgeMessage({ type: "contact.user.created_v3" }), undefined);
  assert.equal(normalizeLarkEventToBridgeMessage({
    type: "im.message.receive_v1",
    chat_id: "oc_chat",
    message_id: "om_message",
    content: ""
  }), undefined);
});

test("prefers parsed text field over JSON-stringified content", () => {
  const message = normalizeLarkEventToBridgeMessage({
    type: "im.message.receive_v1",
    chat_id: "oc_chat",
    message_id: "om_message",
    thread_id: "omt_thread",
    content: "{\"text\":\"@_user_1 /allow!\"}",
    text: "@贺云风's Feishu CLI /allow!"
  });

  assert.equal(message.text, "@贺云风's Feishu CLI /allow!");
});

test("unwraps JSON-stringified content when text is missing", () => {
  const message = normalizeLarkEventToBridgeMessage({
    type: "im.message.receive_v1",
    chat_id: "oc_chat",
    message_id: "om_message",
    thread_id: "omt_thread",
    content: "{\"text\":\"@_user_1 /allow!\"}"
  });

  assert.equal(message.text, "@_user_1 /allow!");
});

test("strips Lark <at> markup from message text", () => {
  const message = normalizeLarkEventToBridgeMessage({
    type: "im.message.receive_v1",
    chat_id: "oc_chat",
    message_id: "om_message",
    thread_id: "omt_thread",
    content: "<at user_id=\"ou_xxx\">贺云风's Feishu CLI</at> /allow!"
  });

  assert.equal(message.text, "@贺云风's Feishu CLI /allow!");
});

test("strips self-closing <at /> markup", () => {
  const message = normalizeLarkEventToBridgeMessage({
    type: "im.message.receive_v1",
    chat_id: "oc_chat",
    message_id: "om_message",
    thread_id: "omt_thread",
    content: "<at user_id=\"ou_xxx\" /> /deny"
  });

  assert.equal(message.text, "/deny");
});

test("handles JSON content that wraps <at> markup inside text", () => {
  const message = normalizeLarkEventToBridgeMessage({
    type: "im.message.receive_v1",
    chat_id: "oc_chat",
    message_id: "om_message",
    thread_id: "omt_thread",
    content: "{\"text\":\"<at user_id=\\\"ou_xxx\\\">贺云风's Feishu CLI</at> /allow!\"}"
  });

  assert.equal(message.text, "@贺云风's Feishu CLI /allow!");
});

test("sends thread replies through lark-cli as bot using markdown by default", async () => {
  const calls = [];
  const adapter = createLarkCliAdapter({
    runCommand: async (command, args) => {
      calls.push({ command, args });
      return { stdout: "{\"message_id\":\"om_reply\"}\n" };
    }
  });

  await adapter.sendThreadMessage({
    chatId: "oc_chat",
    threadId: "omt_thread",
    replyMessageId: "om_root",
    text: "**Cursor** 已完成\n\n```ts\nconsole.log('hi');\n```"
  });

  assert.deepEqual(calls, [{
    command: "lark-cli",
    args: [
      "im",
      "+messages-reply",
      "--message-id",
      "om_root",
      "--markdown",
      "**Cursor** 已完成\n\n```ts\nconsole.log('hi');\n```",
      "--reply-in-thread",
      "--as",
      "bot"
    ]
  }]);
});

test("falls back to --text when text option is set", async () => {
  const calls = [];
  const adapter = createLarkCliAdapter({
    runCommand: async (command, args) => {
      calls.push({ command, args });
      return { stdout: "{}\n" };
    }
  });

  await adapter.sendThreadMessage({
    chatId: "oc_chat",
    threadId: "omt_thread",
    replyMessageId: "om_root",
    text: "纯文本",
    format: "text"
  });

  assert.deepEqual(calls[0].args.slice(0, 6), [
    "im",
    "+messages-reply",
    "--message-id",
    "om_root",
    "--text",
    "纯文本"
  ]);
});

test("fetches a message's real Lark thread id via messages-mget", async () => {
  const calls = [];
  const adapter = createLarkCliAdapter({
    runCommand: async (command, args) => {
      calls.push({ command, args });
      return {
        stdout: JSON.stringify({
          ok: true,
          data: {
            messages: [{
              message_id: "om_reply",
              thread_id: "omt_real_thread"
            }]
          }
        })
      };
    }
  });

  const threadId = await adapter.getMessageThreadId("om_reply");

  assert.equal(threadId, "omt_real_thread");
  assert.deepEqual(calls[0].args, [
    "im",
    "+messages-mget",
    "--message-ids",
    "om_reply",
    "--format",
    "json",
    "--as",
    "bot"
  ]);
});

test("sends a text approval prompt as markdown with command summary, omitting full payload", async () => {
  const calls = [];
  const adapter = createLarkCliAdapter({
    runCommand: async (command, args) => {
      calls.push({ command, args });
      return { stdout: "{}\n" };
    }
  });

  await adapter.sendApprovalPrompt({
    threadId: "omt_thread",
    replyMessageId: "om_root",
    requestId: "req_abc12",
    tool: "Shell",
    command: "git push --force",
    payload: { command: "git push --force", description: "deploy", working_directory: "/tmp" }
  });

  assert.equal(calls.length, 1);
  const args = calls[0].args;
  assert.equal(args[0], "im");
  assert.equal(args[1], "+messages-reply");
  assert.equal(args[2], "--message-id");
  assert.equal(args[3], "om_root");
  assert.equal(args[4], "--markdown");

  const body = args[5];
  assert.match(body, /Cursor approval required/);
  assert.match(body, /Shell/);
  assert.match(body, /git push --force/);
  assert.match(body, /\/allow/);
  assert.match(body, /\/deny/);
  assert.match(body, /req_abc12/);
  assert.equal(body.includes("/tmp"), false, "should not leak working_directory full payload");

  assert.equal(args[6], "--reply-in-thread");
  assert.equal(args[7], "--as");
  assert.equal(args[8], "bot");
});

test("truncates long Shell commands inside the approval prompt", async () => {
  const calls = [];
  const adapter = createLarkCliAdapter({
    runCommand: async (command, args) => {
      calls.push({ command, args });
      return { stdout: "{}\n" };
    }
  });

  const longCommand = `${"ls -la ".repeat(80)}/tmp/end`;
  await adapter.sendApprovalPrompt({
    threadId: "omt_thread",
    replyMessageId: "om_root",
    requestId: "req_long",
    tool: "Shell",
    command: longCommand
  });

  const body = calls[0].args[5];
  assert.ok(body.length < 1500, `prompt body unexpectedly long: ${body.length}`);
  assert.match(body, /…/);
});

test("describes path-scoped remembered approval prompts", async () => {
  const calls = [];
  const adapter = createLarkCliAdapter({
    runCommand: async (command, args) => {
      calls.push({ command, args });
      return { stdout: "{}\n" };
    }
  });

  await adapter.sendApprovalPrompt({
    threadId: "omt_thread",
    replyMessageId: "om_root",
    requestId: "req_write",
    tool: "Write",
    command: "/Users/bytedance/projects/agent2lark-cursor/src/file.js",
    scope: {
      commandPrefix: "",
      pathPrefix: "/Users/bytedance/projects/agent2lark-cursor/"
    }
  });

  const body = calls[0].args[5];
  assert.match(body, /tool \+ project path/);
  assert.match(body, /\/Users\/bytedance\/projects\/agent2lark-cursor\//);
});

test("suggests exact MCP tool scoped approval prompts", async () => {
  const calls = [];
  const adapter = createLarkCliAdapter({
    runCommand: async (command, args) => {
      calls.push({ command, args });
      return { stdout: "{}\n" };
    }
  });

  await adapter.sendApprovalPrompt({
    threadId: "omt_thread",
    replyMessageId: "om_root",
    requestId: "req_mcp",
    tool: "mcp__user-Playwright__open_page",
    command: "{}",
    scope: {
      commandPrefix: "",
      pathPrefix: "",
      toolScope: true
    }
  });

  const body = calls[0].args[5];
  assert.match(body, /matched by tool/);
  assert.match(body, /\/allow mcp__user-Playwright__open_page!/);
});

test("sends an interactive approval card with four buttons via messages-reply", async () => {
  const calls = [];
  const adapter = createLarkCliAdapter({
    runCommand: async (command, args) => {
      calls.push({ command, args });
      return { stdout: "{}\n" };
    }
  });

  await adapter.sendApprovalCard({
    threadId: "omt_thread",
    replyMessageId: "om_root",
    requestId: "req_abc",
    tool: "Shell",
    command: "git push --force",
    payload: "{ \"branch\": \"main\" }"
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "lark-cli");
  const args = calls[0].args;
  assert.equal(args[0], "im");
  assert.equal(args[1], "+messages-reply");
  assert.equal(args[2], "--message-id");
  assert.equal(args[3], "om_root");
  assert.equal(args[4], "--msg-type");
  assert.equal(args[5], "interactive");
  assert.equal(args[6], "--content");

  const card = JSON.parse(args[7]);
  assert.equal(card.header.title.content, "Cursor approval required");
  const buttonAction = card.elements.find((element) => element.tag === "action");
  assert.ok(buttonAction);
  assert.equal(buttonAction.actions.length, 4);
  assert.deepEqual(
    buttonAction.actions.map((action) => action.value),
    [
      { req: "req_abc", decision: "allow", remember: false },
      { req: "req_abc", decision: "allow", remember: true },
      { req: "req_abc", decision: "deny", remember: false },
      { req: "req_abc", decision: "deny", remember: true }
    ]
  );

  assert.equal(args[8], "--reply-in-thread");
  assert.equal(args[9], "--as");
  assert.equal(args[10], "bot");
});

test("adds an emoji reaction via lark-cli reactions create", async () => {
  const calls = [];
  const adapter = createLarkCliAdapter({
    runCommand: async (command, args) => {
      calls.push({ command, args });
      return { stdout: "{}\n" };
    }
  });

  await adapter.addReaction({ messageId: "om_root", emoji: "EYES" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "lark-cli");
  assert.deepEqual(calls[0].args, [
    "im",
    "reactions",
    "create",
    "--params",
    JSON.stringify({ message_id: "om_root" }),
    "--data",
    JSON.stringify({ reaction_type: { emoji_type: "EYES" } }),
    "--as",
    "bot"
  ]);
});
