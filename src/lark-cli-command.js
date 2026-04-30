import path from "node:path";
import { PROJECT_ROOT } from "./constants.js";

export const LARK_CLI_COMMAND_ENV = "LARK_CLI_COMMAND";

export function bundledLarkCliCommand() {
  const binName = process.platform === "win32" ? "lark-cli.cmd" : "lark-cli";
  return path.join(PROJECT_ROOT, "node_modules", ".bin", binName);
}

export function resolveLarkCliCommand(options = {}) {
  const explicit = String(options.command || "").trim();
  if (explicit) return explicit;

  const env = options.env || process.env;
  const fromEnv = String(env[LARK_CLI_COMMAND_ENV] || "").trim();
  if (fromEnv) return fromEnv;

  return bundledLarkCliCommand();
}
