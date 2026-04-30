import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveLarkCliCommand } from "./lark-cli-command.js";

const execFileAsync = promisify(execFile);

function parseFirstJsonObject(text = "") {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return {};
  }
  return JSON.parse(text.slice(start, end + 1));
}

function larkCliErrorText(error) {
  if (!error) return "";
  return [
    error.message,
    error.stderr,
    error.stdout
  ].filter(Boolean).join("\n");
}

function withBotInviteGuidance(error) {
  const text = larkCliErrorText(error);
  const hint = [
    "Bot invite failed.",
    "Required app scopes: im:chat and im:chat.members:write_only.",
    "The authorized user must be in the target group and allowed to invite members.",
    "After changing scopes in Feishu/Lark Developer Console, publish the app change and rerun lark-cli config init --new if needed."
  ].join(" ");
  const message = text ? `${text}\n${hint}` : hint;
  return new Error(message);
}

export async function checkLarkCliConfig(options = {}) {
  const command = resolveLarkCliCommand(options);
  const runCommand = options.runCommand || execFileAsync;
  const initCommand = `${command} config init --new`;

  try {
    const { stdout } = await runCommand(command, ["config", "show"]);
    const parsed = parseFirstJsonObject(stdout);
    if (!parsed.appId) {
      return { configured: false, initCommand };
    }

    return {
      configured: true,
      appId: parsed.appId,
      brand: parsed.brand || "",
      profile: parsed.profile || parsed.appId,
      users: parsed.users || ""
    };
  } catch {
    return { configured: false, initCommand };
  }
}

export async function createCursorConversationChat(options = {}) {
  const command = resolveLarkCliCommand(options);
  const runCommand = options.runCommand || execFileAsync;
  const name = options.name || "Cursor Conversation";
  if (!options.appId) {
    throw new Error("Cannot create a Cursor conversation chat without a lark-cli app id");
  }

  const { stdout } = await runCommand(command, [
    "im",
    "+chat-create",
    "--name",
    name,
    "--bots",
    options.appId,
    "--format",
    "json",
    "--as",
    "user"
  ]);
  const parsed = parseFirstJsonObject(stdout);
  const chatId = parsed.chat_id || parsed.data?.chat_id;
  if (!chatId) {
    throw new Error("lark-cli did not return a chat_id for the new Cursor conversation chat");
  }

  return {
    chatId,
    name: parsed.name || parsed.data?.name || name
  };
}

export async function addBotToChat(options = {}) {
  const command = resolveLarkCliCommand(options);
  const runCommand = options.runCommand || execFileAsync;
  if (!options.chatId) {
    throw new Error("Cannot invite a bot without a Lark chat id");
  }
  if (!options.appId) {
    throw new Error("Cannot invite a bot without a lark-cli app id");
  }

  try {
    const { stdout } = await runCommand(command, [
      "im",
      "chat.members",
      "create",
      "--params",
      JSON.stringify({ chat_id: options.chatId, member_id_type: "app_id" }),
      "--data",
      JSON.stringify({ id_list: [options.appId] }),
      "--format",
      "json",
      "--as",
      "user"
    ]);

    return parseFirstJsonObject(stdout);
  } catch (error) {
    throw withBotInviteGuidance(error);
  }
}
