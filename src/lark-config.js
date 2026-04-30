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
