import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installCursorHooks } from "../src/installer.js";

function tempHooksPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent2lark-hooks-")), "hooks.json");
}

test("installs relay hooks when relay mode is enabled", () => {
  const hooksPath = tempHooksPath();

  const result = installCursorHooks({ hooksPath, relay: true });
  const config = JSON.parse(fs.readFileSync(hooksPath, "utf8"));

  assert.deepEqual(result.events, [
    "beforeShellExecution",
    "beforeMCPExecution",
    "preToolUse",
    "sessionStart",
    "beforeSubmitPrompt",
    "afterAgentResponse",
    "postToolUse",
    "postToolUseFailure",
    "afterShellExecution",
    "stop"
  ]);
  assert.ok(config.hooks.sessionStart[0].command.includes("--event 'sessionStart'"));
  assert.ok(config.hooks.beforeSubmitPrompt[0].command.includes("--event 'beforeSubmitPrompt'"));
  assert.ok(config.hooks.afterAgentResponse[0].command.includes("--event 'afterAgentResponse'"));
  assert.equal(
    config.hooks.preToolUse[0].matcher,
    "Shell|Bash|Write|Edit|Delete|ApplyPatch|MultiEdit|MCP:.*|mcp__.*"
  );
  assert.equal(config.hooks.stop[0].loop_limit, null);
});
