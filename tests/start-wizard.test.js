import assert from "node:assert/strict";
import test from "node:test";
import { runStartWizard } from "../src/start-wizard.js";

test("start wizard reuses an existing chat and prints binding guidance", async () => {
  const prompts = ["existing", "oc_existing"];
  const output = [];
  const calls = [];
  const processStarts = [];
  const botInvites = [];

  const result = await runStartWizard({
    output,
    ask: async () => prompts.shift(),
    checkConfig: async () => ({ configured: true, appId: "cli_user_app", profile: "cli_user_app" }),
    ensureConfigFile: () => false,
    installHooks: () => calls.push("install-hooks"),
    startProcesses: (options) => {
      processStarts.push(options);
      return { started: ["bridge", "lark-listen"], reused: [] };
    },
    addBotToChat: async (input) => {
      botInvites.push(input);
    }
  });

  assert.deepEqual(result, {
    ok: true,
    chatId: "oc_existing",
    mode: "existing"
  });
  assert.deepEqual(processStarts, [undefined]);
  assert.deepEqual(botInvites, [{
    chatId: "oc_existing",
    appId: "cli_user_app"
  }]);
  assert.deepEqual(calls, ["install-hooks"]);
  assert.match(output.join("\n"), /Reusing lark-cli app: cli_user_app/);
  assert.match(output.join("\n"), /chat_id: oc_existing/);
  assert.match(output.join("\n"), /Ensured bot is invited to Lark group/);
  assert.match(output.join("\n"), /bind lark thread message_id: om_xxx/);
  assert.doesNotMatch(output.join("\n"), /create cursor agent/);
});

test("start wizard creates a default Cursor conversation chat", async () => {
  const prompts = ["new", ""];
  const output = [];
  const result = await runStartWizard({
    output,
    ask: async () => prompts.shift(),
    checkConfig: async () => ({ configured: true, appId: "cli_user_app", profile: "cli_user_app" }),
    ensureConfigFile: () => false,
    installHooks: () => {},
    startProcesses: () => ({ started: [], reused: ["bridge", "lark-listen"] }),
    createChat: async (input) => ({
      chatId: "oc_created",
      name: input.name
    })
  });

  assert.deepEqual(result, {
    ok: true,
    chatId: "oc_created",
    mode: "new"
  });
  assert.match(output.join("\n"), /Created Lark group: Cursor Conversation/);
});

test("start wizard rejects an empty existing chat id", async () => {
  const prompts = ["existing", ""];
  const output = [];
  const result = await runStartWizard({
    output,
    ask: async () => prompts.shift(),
    checkConfig: async () => ({ configured: true, appId: "cli_user_app", profile: "cli_user_app" }),
    ensureConfigFile: () => false,
    installHooks: () => {},
    startProcesses: () => ({ started: [], reused: [] })
  });

  assert.deepEqual(result, {
    ok: false,
    reason: "missing_chat_id"
  });
  assert.match(output.join("\n"), /chat_id cannot be empty/);
});

test("start wizard stops before mutating when lark-cli is not configured", async () => {
  const output = [];
  const result = await runStartWizard({
    output,
    ask: async () => {
      throw new Error("should not ask");
    },
    checkConfig: async () => ({ configured: false, initCommand: "lark-cli config init --new" }),
    installHooks: () => {
      throw new Error("should not install hooks");
    },
    startProcesses: () => {
      throw new Error("should not start processes");
    }
  });

  assert.deepEqual(result, {
    ok: false,
    reason: "lark_cli_not_configured"
  });
  assert.match(output.join("\n"), /lark-cli config init --new/);
});
