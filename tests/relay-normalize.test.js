import assert from "node:assert/strict";
import test from "node:test";
import { isRelayEvent, toRelayMessage } from "../src/normalize.js";

test("maps sessionStart to a bridge session registration message", () => {
  const message = toRelayMessage({
    session_id: "cursor-session",
    cwd: "/tmp/project",
    composer_mode: "agent"
  }, "sessionStart");

  assert.equal(isRelayEvent("sessionStart"), true);
  assert.deepEqual(message, {
    type: "cursor_session_start",
    session_id: "cursor-session",
    cwd: "/tmp/project",
    composer_mode: "agent"
  });
});

test("maps beforeSubmitPrompt to a bridge prompt message", () => {
  const message = toRelayMessage({
    session_id: "cursor-session",
    cwd: "/tmp/project",
    prompt: "绑定飞书话题 abc123"
  }, "beforeSubmitPrompt");

  assert.deepEqual(message, {
    type: "cursor_prompt_submit",
    session_id: "cursor-session",
    cwd: "/tmp/project",
    prompt: "绑定飞书话题 abc123"
  });
});

test("maps afterAgentResponse and stop to bridge relay messages", () => {
  assert.deepEqual(toRelayMessage({
    session_id: "cursor-session",
    text: "完成了"
  }, "afterAgentResponse"), {
    type: "cursor_agent_response",
    session_id: "cursor-session",
    cwd: process.cwd(),
    text: "完成了"
  });

  assert.deepEqual(toRelayMessage({
    session_id: "cursor-session",
    loop_count: 2
  }, "stop"), {
    type: "cursor_stop",
    session_id: "cursor-session",
    cwd: process.cwd(),
    loop_count: 2,
    status: ""
  });
});

test("maps shell completion hooks to short cursor progress messages", () => {
  assert.equal(isRelayEvent("afterShellExecution"), true);
  assert.deepEqual(toRelayMessage({
    session_id: "cursor-session",
    command: "pnpm test",
    exit_code: 0,
    duration_ms: 1234,
    output: "large output must not be forwarded"
  }, "afterShellExecution"), {
    type: "cursor_progress",
    session_id: "cursor-session",
    cwd: process.cwd(),
    phase: "completed",
    tool: "Shell",
    command: "pnpm test",
    exit_code: 0,
    duration_ms: 1234
  });
});

test("maps failed tool hooks to short cursor progress messages", () => {
  assert.equal(isRelayEvent("postToolUseFailure"), true);
  assert.deepEqual(toRelayMessage({
    session_id: "cursor-session",
    tool_name: "ApplyPatch",
    tool_input: { patch: "*** Update File: /tmp/project/src/app.js\n" },
    error: "patch failed"
  }, "postToolUseFailure"), {
    type: "cursor_progress",
    session_id: "cursor-session",
    cwd: process.cwd(),
    phase: "failed",
    tool: "ApplyPatch",
    command: "/tmp/project/src/app.js",
    exit_code: undefined,
    duration_ms: 0
  });
});
