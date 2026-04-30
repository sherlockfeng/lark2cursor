import assert from "node:assert/strict";
import test from "node:test";
import {
  checkLarkCliConfig,
  createCursorConversationChat
} from "../src/lark-config.js";
import { bundledLarkCliCommand } from "../src/lark-cli-command.js";

test("checks existing lark-cli app configuration without exposing secrets", async () => {
  const result = await checkLarkCliConfig({
    runCommand: async (command, args) => {
      assert.equal(command, bundledLarkCliCommand());
      assert.deepEqual(args, ["config", "show"]);
      return {
        stdout: `${JSON.stringify({
          appId: "cli_current_user_app",
          appSecret: "****",
          brand: "feishu",
          profile: "cli_current_user_app",
          users: "Test User (ou_xxx)"
        }, null, 2)}\n\nConfig file path: /tmp/config.json\n`
      };
    }
  });

  assert.deepEqual(result, {
    configured: true,
    appId: "cli_current_user_app",
    brand: "feishu",
    profile: "cli_current_user_app",
    users: "Test User (ou_xxx)"
  });
});

test("reports missing lark-cli configuration with init guidance", async () => {
  const result = await checkLarkCliConfig({
    runCommand: async () => {
      throw new Error("no config");
    }
  });

  assert.deepEqual(result, {
    configured: false,
    initCommand: `${bundledLarkCliCommand()} config init --new`
  });
});

test("creates a Cursor conversation group with the current app bot", async () => {
  const calls = [];
  const result = await createCursorConversationChat({
    name: "Cursor Conversation",
    appId: "cli_current_user_app",
    runCommand: async (command, args) => {
      calls.push({ command, args });
      return {
        stdout: JSON.stringify({
          chat_id: "oc_created",
          name: "Cursor Conversation"
        })
      };
    }
  });

  assert.deepEqual(calls, [{
    command: bundledLarkCliCommand(),
    args: [
      "im",
      "+chat-create",
      "--name",
      "Cursor Conversation",
      "--bots",
      "cli_current_user_app",
      "--format",
      "json",
      "--as",
      "user"
    ]
  }]);
  assert.deepEqual(result, {
    chatId: "oc_created",
    name: "Cursor Conversation"
  });
});

test("falls back to the default 'Cursor Conversation' group name when none is provided", async () => {
  const calls = [];
  await createCursorConversationChat({
    appId: "cli_current_user_app",
    runCommand: async (command, args) => {
      calls.push({ command, args });
      return {
        stdout: JSON.stringify({ chat_id: "oc_default", name: "Cursor Conversation" })
      };
    }
  });
  assert.deepEqual(calls[0].args.slice(0, 4), ["im", "+chat-create", "--name", "Cursor Conversation"]);
});
