import readline from "node:readline/promises";
import { stdin as input, stdout as outputStream } from "node:process";
import { DEFAULT_RUNTIME_CONFIG_PATH } from "./constants.js";
import { installCursorHooks } from "./installer.js";
import { checkLarkCliConfig, createCursorConversationChat } from "./lark-config.js";
import { startRelayProcesses } from "./relay-supervisor.js";
import { ensureRuntimeConfigFile } from "./runtime-config.js";

function write(output, line = "") {
  if (Array.isArray(output)) {
    output.push(line);
    return;
  }
  output.write(`${line}\n`);
}

function normalizeChoice(value) {
  const lower = String(value || "").trim().toLowerCase();
  // Accept the legacy zh-CN alias 新建 for users who memorised the old prompt.
  if (["new", "n", "新建", "2"].includes(lower)) {
    return "new";
  }
  return "existing";
}

function printBindingGuide(output, chatId) {
  write(output, "");
  write(output, `chat_id: ${chatId}`);
  write(output, "");
  write(output, "IDE Chat Relay binding:");
  write(output, "1. In the Lark group, @ the bot with: bind chat");
  write(output, "2. The bot replies with: message_id: om_xxx");
  write(output, "3. In the target Cursor IDE Chat, send: bind lark thread message_id: om_xxx");
  write(output, "4. Subsequent Lark thread messages flow into that Chat on the next Cursor stop hook.");
  write(output, "");
  write(output, "Other Lark thread commands: /help — show command reference; unbind — remove this thread binding; stop wait | disable wait | pause wait — turn off the IDE Chat continuous-wait loop.");
  write(output, "(Legacy zh-CN aliases still work: 绑定对话 / 绑定飞书话题 / 停止等待 / 关闭等待.)");
}

export async function runStartWizard(options = {}) {
  const output = options.output || outputStream;
  const ask = options.ask;
  const checkConfig = options.checkConfig || checkLarkCliConfig;
  const installHooks = options.installHooks || (() => installCursorHooks({ relay: true }));
  const startProcesses = options.startProcesses || startRelayProcesses;
  const createChat = options.createChat || createCursorConversationChat;
  const ensureConfigFile = options.ensureConfigFile || ensureRuntimeConfigFile;
  const runtimeConfigPath = options.runtimeConfigPath || DEFAULT_RUNTIME_CONFIG_PATH;

  write(output, "agent2lark-cursor relay setup wizard");
  const config = await checkConfig();
  if (!config.configured) {
    write(output, `lark-cli is not configured yet. Run: ${config.initCommand}`);
    return { ok: false, reason: "lark_cli_not_configured" };
  }

  write(output, `Reusing lark-cli app: ${config.profile || config.appId}`);
  const wroteConfig = ensureConfigFile({ configPath: runtimeConfigPath });
  if (wroteConfig) {
    write(output, `Wrote runtime config defaults to ${runtimeConfigPath} (edit and run pnpm run restart-relay to apply).`);
  } else {
    write(output, `Runtime config: ${runtimeConfigPath} (edit and run pnpm run restart-relay to apply).`);
  }
  installHooks();
  const processes = startProcesses();
  if (processes.started?.length) {
    write(output, `Started background processes: ${processes.started.join(", ")}`);
  }
  if (processes.reused?.length) {
    write(output, `Reusing background processes: ${processes.reused.join(", ")}`);
  }

  const choice = normalizeChoice(await ask("Lark group: reuse an existing one or create a new one? Enter existing/new [existing]: "));
  if (choice === "new") {
    const groupName = String(await ask("New group name [Cursor Conversation]: ") || "").trim() || "Cursor Conversation";
    const chat = await createChat({ name: groupName, appId: config.appId });
    write(output, `Created Lark group: ${chat.name}`);
    printBindingGuide(output, chat.chatId);
    return { ok: true, chatId: chat.chatId, mode: "new" };
  }

  const chatId = String(await ask("Enter the existing Lark chat_id: ") || "").trim();
  if (!chatId) {
    write(output, "chat_id cannot be empty.");
    return { ok: false, reason: "missing_chat_id" };
  }
  printBindingGuide(output, chatId);
  return { ok: true, chatId, mode: "existing" };
}

export async function runInteractiveStartWizard(options = {}) {
  const rl = readline.createInterface({
    input: options.input || input,
    output: options.output || outputStream
  });
  try {
    return await runStartWizard({
      ...options,
      output: options.output || outputStream,
      ask: (question) => rl.question(question)
    });
  } finally {
    rl.close();
  }
}
