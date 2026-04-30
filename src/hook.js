import { bridgeSocketExists, sendBridgeMessage } from "./bridge-client.js";
import { parseJsonObject, readStdin, writeJson } from "./io.js";
import {
  isRelayEvent,
  isRiskyPreToolUse,
  toApprovalRequest,
  toRelayMessage
} from "./normalize.js";

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--event") {
      result.event = argv[index + 1] || "";
      index += 1;
    } else if (arg.startsWith("--event=")) {
      result.event = arg.slice("--event=".length);
    }
  }
  return result;
}

function localAsk(reason) {
  return {
    permission: "ask",
    user_message: reason || "Please review this Cursor action locally.",
    agent_message: reason || "agent2lark-cursor fell back to Cursor local approval."
  };
}

export function toCursorApprovalResponse(bridgeResponse) {
  const decision = bridgeResponse?.decision || "ask";
  const reason = bridgeResponse?.reason || "";

  if (decision === "allow") {
    return {
      permission: "allow",
      agent_message: reason ? `Approved by agent2lark-cursor (${reason}).` : "Approved by agent2lark-cursor."
    };
  }

  if (decision === "deny") {
    return {
      permission: "deny",
      user_message: reason ? `Denied by agent2lark-cursor (${reason}).` : "Denied by agent2lark-cursor.",
      agent_message: reason ? `Denied by agent2lark-cursor (${reason}).` : "Denied by agent2lark-cursor."
    };
  }

  return localAsk(reason || "agent2lark-cursor returned ask; review locally.");
}

function relayFallback(event) {
  if (String(event || "").toLowerCase() === "beforesubmitprompt") {
    return { continue: true };
  }
  return {};
}

export function relayBridgeTimeoutMs(event, env = process.env) {
  const defaultTimeoutMs = Number(env.AGENT2LARK_BRIDGE_TIMEOUT_MS || 30_000);
  if (String(event || "").toLowerCase() !== "stop") {
    return defaultTimeoutMs;
  }

  const waitPollMs = Number(env.AGENT2LARK_WAIT_POLL_MS || 10 * 60 * 1000);
  return Math.max(defaultTimeoutMs, waitPollMs + 5_000);
}

export function approvalBridgeTimeoutMs(env = process.env) {
  const approvalTimeoutMs = Number(env.AGENT2LARK_APPROVAL_TIMEOUT_MS || 24 * 60 * 60 * 1000);
  const defaultTimeoutMs = Number(env.AGENT2LARK_BRIDGE_TIMEOUT_MS || 30_000);
  return Math.max(defaultTimeoutMs, approvalTimeoutMs + 5_000);
}

export function toRelayHookOutput(event, bridgeResponse = {}) {
  const lowerEvent = String(event || "").toLowerCase();
  if (lowerEvent === "sessionstart") {
    const output = {};
    if (bridgeResponse.additional_context) {
      output.additional_context = bridgeResponse.additional_context;
    }
    if (bridgeResponse.env && typeof bridgeResponse.env === "object") {
      output.env = bridgeResponse.env;
    }
    return output;
  }

  if (lowerEvent === "beforesubmitprompt") {
    return {
      continue: bridgeResponse.continue !== false,
      ...(bridgeResponse.user_message ? { user_message: bridgeResponse.user_message } : {})
    };
  }

  if (lowerEvent === "stop") {
    return bridgeResponse.followup_message
      ? { followup_message: bridgeResponse.followup_message }
      : {};
  }

  return {};
}

async function handleRelayEvent(input, event) {
  if (!bridgeSocketExists()) {
    writeJson(relayFallback(event));
    return;
  }

  try {
    const bridgeResponse = await sendBridgeMessage(toRelayMessage(input, event), {
      timeoutMs: relayBridgeTimeoutMs(event)
    });
    writeJson(toRelayHookOutput(event, bridgeResponse || relayFallback(event)));
  } catch {
    writeJson(relayFallback(event));
  }
}

async function handleApprovalEvent(input, event) {
  const approvalMessage = toApprovalRequest(input, event);

  if (approvalMessage.kind === "tool" && !isRiskyPreToolUse(approvalMessage.tool)) {
    writeJson({
      permission: "allow",
      agent_message: "agent2lark-cursor ignored a low-risk Cursor tool."
    });
    return;
  }

  if (!bridgeSocketExists()) {
    writeJson(localAsk("agent2lark-cursor bridge is not running. Please review this action locally."));
    return;
  }

  try {
    const bridgeResponse = await sendBridgeMessage(approvalMessage, {
      timeoutMs: approvalBridgeTimeoutMs()
    });
    writeJson(toCursorApprovalResponse(bridgeResponse));
  } catch (error) {
    writeJson(localAsk(`agent2lark-cursor approval bridge failed: ${error instanceof Error ? error.message : String(error)}`));
  }
}

export async function runHook(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const raw = await readStdin();
  const input = parseJsonObject(raw);
  const event = args.event || input.hook_event_name || input.hookEventName || input.event;

  if (isRelayEvent(event)) {
    await handleRelayEvent(input, event);
    return;
  }

  await handleApprovalEvent(input, event);
}
