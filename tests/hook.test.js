import assert from "node:assert/strict";
import test from "node:test";
import {
  approvalBridgeTimeoutMs,
  relayBridgeTimeoutMs,
  toCursorApprovalResponse,
  toRelayHookOutput
} from "../src/hook.js";

test("filters bridge responses to Cursor-supported relay hook output", () => {
  assert.deepEqual(toRelayHookOutput("afterAgentResponse", { ok: true }), {});
  assert.deepEqual(toRelayHookOutput("beforeSubmitPrompt", {
    continue: false,
    user_message: "已绑定"
  }), {
    continue: false,
    user_message: "已绑定"
  });
  assert.deepEqual(toRelayHookOutput("stop", {
    followup_message: "继续"
  }), {
    followup_message: "继续"
  });
});

test("uses a longer bridge timeout for stop wait loops", () => {
  assert.equal(relayBridgeTimeoutMs("beforeSubmitPrompt", {
    AGENT2LARK_BRIDGE_TIMEOUT_MS: "30000"
  }), 30_000);
  assert.equal(relayBridgeTimeoutMs("stop", {
    AGENT2LARK_BRIDGE_TIMEOUT_MS: "30000",
    AGENT2LARK_WAIT_POLL_MS: "600000"
  }), 605_000);
});

test("uses a longer bridge timeout while waiting for approval card decisions", () => {
  assert.equal(approvalBridgeTimeoutMs({
    AGENT2LARK_BRIDGE_TIMEOUT_MS: "30000",
    AGENT2LARK_APPROVAL_TIMEOUT_MS: "60000"
  }), 65_000);
});

test("translates bridge approval responses to Cursor permission output", () => {
  assert.deepEqual(toCursorApprovalResponse({ decision: "allow" }), {
    permission: "allow",
    agent_message: "Approved by agent2lark-cursor."
  });

  assert.deepEqual(toCursorApprovalResponse({ decision: "deny", reason: "policy" }), {
    permission: "deny",
    user_message: "Denied by agent2lark-cursor (policy).",
    agent_message: "Denied by agent2lark-cursor (policy)."
  });

  const ask = toCursorApprovalResponse({ decision: "ask", reason: "no_binding" });
  assert.equal(ask.permission, "ask");
  assert.match(ask.user_message, /no_binding/);
});
