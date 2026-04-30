import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { bundledLarkCliCommand, resolveLarkCliCommand } from "../src/lark-cli-command.js";

const binName = process.platform === "win32" ? "lark-cli.cmd" : "lark-cli";

test("uses the bundled lark-cli binary by default", () => {
  assert.equal(resolveLarkCliCommand(), bundledLarkCliCommand());
  assert.equal(path.basename(resolveLarkCliCommand()), binName);
});

test("lets LARK_CLI_COMMAND override the bundled lark-cli binary", () => {
  assert.equal(resolveLarkCliCommand({
    env: { LARK_CLI_COMMAND: "/usr/local/bin/lark-cli" }
  }), "/usr/local/bin/lark-cli");
});

test("prefers an explicit command over the environment override", () => {
  assert.equal(resolveLarkCliCommand({
    command: "custom-lark-cli",
    env: { LARK_CLI_COMMAND: "/usr/local/bin/lark-cli" }
  }), "custom-lark-cli");
});
