import assert from "node:assert/strict";
import test from "node:test";
import { createCursorRunner } from "../src/cursor-runner.js";

test("runs prompts through an injected Cursor SDK agent when available", async () => {
  const calls = [];
  const runner = createCursorRunner({
    sdkModule: {
      Agent: {
        async create(options) {
          calls.push({ method: "create", options });
          return {
            id: "agent_123",
            async send(prompt) {
              calls.push({ method: "send", prompt });
              return { text: "SDK response" };
            }
          };
        }
      }
    }
  });

  const result = await runner.runPrompt({
    cwd: "/tmp/project",
    prompt: "实现需求"
  });

  assert.deepEqual(result, {
    text: "SDK response",
    agentSessionId: "agent_123"
  });
  assert.deepEqual(calls, [
    { method: "create", options: { local: { cwd: "/tmp/project" } } },
    { method: "send", prompt: "实现需求" }
  ]);
});

test("falls back to Cursor CLI headless mode", async () => {
  const calls = [];
  const runner = createCursorRunner({
    sdkModule: undefined,
    command: "cursor-agent",
    runCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: "CLI response\n" };
    }
  });

  const result = await runner.runPrompt({
    cwd: "/tmp/project",
    agentSessionId: "agent_existing",
    prompt: "继续"
  });

  assert.deepEqual(calls, [{
    command: "cursor-agent",
    args: ["-p", "继续", "--resume", "agent_existing", "--force"],
    options: { cwd: "/tmp/project" }
  }]);
  assert.deepEqual(result, {
    text: "CLI response",
    agentSessionId: "agent_existing"
  });
});

test("extracts a new Cursor CLI agent session id from output", async () => {
  const runner = createCursorRunner({
    sdkModule: undefined,
    command: "cursor-agent",
    runCommand: async () => ({
      stdout: "Created agent agent_new123\nCLI response\n"
    })
  });

  const result = await runner.runPrompt({
    cwd: "/tmp/project",
    prompt: "开始"
  });

  assert.deepEqual(result, {
    text: "Created agent agent_new123\nCLI response",
    agentSessionId: "agent_new123"
  });
});
