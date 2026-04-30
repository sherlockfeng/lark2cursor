import fs from "node:fs";
import net from "node:net";
import { DEFAULT_BRIDGE_SOCKET_PATH, DEFAULT_EVENTS, DEFAULT_RELAY_STATE_PATH, DEFAULT_RUNTIME_CONFIG_PATH, USER_HOOKS_PATH } from "./constants.js";
import { sendBridgeMessage } from "./bridge-client.js";
import { startBridgeServer } from "./bridge-server.js";
import { doctor, installCursorHooks, uninstallCursorHooks } from "./installer.js";
import { createLarkCliAdapter } from "./lark-adapter.js";
import { startLarkEventListener } from "./lark-listener.js";
import { getRelayStatus, startRelayProcesses, stopRelayProcesses } from "./relay-supervisor.js";
import { runInteractiveStartWizard } from "./start-wizard.js";

function printHelp() {
  console.log(`agent2lark-cursor

Usage:
  agent2lark-cursor install [--events beforeShellExecution,beforeMCPExecution,preToolUse] [--fail-closed] [--relay]
  agent2lark-cursor uninstall [--events beforeShellExecution,beforeMCPExecution,preToolUse]
  agent2lark-cursor bridge [--lark-cli] [--socket-path ~/.agent2lark/cursor-relay.sock] [--state-path ~/.agent2lark/cursor-relay-state.json]
  agent2lark-cursor lark-listen [--echo-message-id] [--socket-path ~/.agent2lark/cursor-relay.sock]
  agent2lark-cursor start
  agent2lark-cursor status-relay
  agent2lark-cursor stop-relay
  agent2lark-cursor restart-relay
  agent2lark-cursor relay-bind --chat-id oc_xxx --thread-id omt_xxx [--reply-message-id om_xxx] [--code abc123]
  agent2lark-cursor relay-send --chat-id oc_xxx --thread-id omt_xxx --text "message"
  agent2lark-cursor doctor

Environment:
  AGENT2LARK_BRIDGE_SOCKET     Override ~/.agent2lark/cursor-relay.sock
  AGENT2LARK_BRIDGE_TIMEOUT_MS Override the bridge round-trip timeout (default 30s)
  AGENT2LARK_WAIT_POLL_MS      Maximum IDE-Chat-Relay long-poll window (default 10min)
  AGENT2LARK_WAIT_INTERVAL_MS  IDE-Chat-Relay polling interval (default 250ms)
  AGENT2LARK_APPROVAL_TIMEOUT_MS Override approval card wait timeout (default 24h)
  AGENT2LARK_RELAY_STATE       Override ~/.agent2lark/cursor-relay-state.json
  AGENT2LARK_APPROVAL_POLICY   Override ~/.agent2lark/cursor-approval-policy.json
  AGENT2LARK_THINKING_INTERVAL_MS Override ${DEFAULT_RUNTIME_CONFIG_PATH} thinkingIntervalMs
  AGENT2LARK_PROGRESS_RELAY    Override ${DEFAULT_RUNTIME_CONFIG_PATH} progressRelayEnabled (1/0)
`);
}

function parseOptions(argv) {
  const options = {
    events: undefined,
    hooksPath: USER_HOOKS_PATH,
    failClosed: false,
    relay: false,
    socketPath: DEFAULT_BRIDGE_SOCKET_PATH,
    statePath: DEFAULT_RELAY_STATE_PATH,
    chatId: "",
    threadId: "",
    messageId: "",
    replyMessageId: "",
    text: "",
    code: "",
    larkCli: false,
    echoMessageId: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--events") {
      options.events = splitEvents(argv[index + 1] || "");
      index += 1;
    } else if (arg.startsWith("--events=")) {
      options.events = splitEvents(arg.slice("--events=".length));
    } else if (arg === "--hooks-path") {
      options.hooksPath = argv[index + 1] || USER_HOOKS_PATH;
      index += 1;
    } else if (arg.startsWith("--hooks-path=")) {
      options.hooksPath = arg.slice("--hooks-path=".length);
    } else if (arg === "--fail-closed") {
      options.failClosed = true;
    } else if (arg === "--relay") {
      options.relay = true;
    } else if (arg === "--socket-path") {
      options.socketPath = argv[index + 1] || DEFAULT_BRIDGE_SOCKET_PATH;
      index += 1;
    } else if (arg.startsWith("--socket-path=")) {
      options.socketPath = arg.slice("--socket-path=".length);
    } else if (arg === "--state-path") {
      options.statePath = argv[index + 1] || DEFAULT_RELAY_STATE_PATH;
      index += 1;
    } else if (arg.startsWith("--state-path=")) {
      options.statePath = arg.slice("--state-path=".length);
    } else if (arg === "--chat-id") {
      options.chatId = argv[index + 1] || "";
      index += 1;
    } else if (arg.startsWith("--chat-id=")) {
      options.chatId = arg.slice("--chat-id=".length);
    } else if (arg === "--thread-id") {
      options.threadId = argv[index + 1] || "";
      index += 1;
    } else if (arg.startsWith("--thread-id=")) {
      options.threadId = arg.slice("--thread-id=".length);
    } else if (arg === "--message-id") {
      options.messageId = argv[index + 1] || "";
      index += 1;
    } else if (arg.startsWith("--message-id=")) {
      options.messageId = arg.slice("--message-id=".length);
    } else if (arg === "--reply-message-id") {
      options.replyMessageId = argv[index + 1] || "";
      index += 1;
    } else if (arg.startsWith("--reply-message-id=")) {
      options.replyMessageId = arg.slice("--reply-message-id=".length);
    } else if (arg === "--text") {
      options.text = argv[index + 1] || "";
      index += 1;
    } else if (arg.startsWith("--text=")) {
      options.text = arg.slice("--text=".length);
    } else if (arg === "--code") {
      options.code = argv[index + 1] || "";
      index += 1;
    } else if (arg.startsWith("--code=")) {
      options.code = arg.slice("--code=".length);
    } else if (arg === "--lark-cli") {
      options.larkCli = true;
    } else if (arg === "--echo-message-id") {
      options.echoMessageId = true;
    }
  }

  return options;
}

function splitEvents(value) {
  const events = value.split(",").map((item) => item.trim()).filter(Boolean);
  return events.length ? events : DEFAULT_EVENTS;
}

async function waitForBridgeReady(socketPath, { timeoutMs = 5_000, intervalMs = 100 } = {}) {
  const target = socketPath || DEFAULT_BRIDGE_SOCKET_PATH;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(target)) {
      const reachable = await new Promise((resolve) => {
        const socket = net.createConnection(target);
        const cleanup = (value) => {
          socket.removeAllListeners();
          socket.destroy();
          resolve(value);
        };
        socket.once("connect", () => cleanup(true));
        socket.once("error", () => cleanup(false));
      });
      if (reachable) return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

export async function runCli(argv) {
  const command = argv[0] || "help";
  const options = parseOptions(argv.slice(1));

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "install") {
    const result = installCursorHooks(options);
    console.log(`Installed Cursor hooks into ${result.hooksPath}`);
    console.log(`Events: ${result.events.join(", ")}`);
    return;
  }

  if (command === "uninstall") {
    const result = uninstallCursorHooks(options);
    console.log(`Removed Cursor hooks from ${result.hooksPath}`);
    console.log(`Events checked: ${result.events.join(", ")}`);
    return;
  }

  if (command === "bridge") {
    startBridgeServer({
      socketPath: options.socketPath,
      statePath: options.statePath,
      ...(options.larkCli ? { lark: createLarkCliAdapter() } : {})
    });
    console.log(`agent2lark-cursor bridge listening on ${options.socketPath}`);
    await new Promise(() => {});
    return;
  }

  if (command === "lark-listen") {
    startLarkEventListener({
      socketPath: options.socketPath,
      echoMessageId: options.echoMessageId
    });
    console.log(`agent2lark-cursor listening for Lark messages and forwarding to ${options.socketPath}`);
    await new Promise(() => {});
    return;
  }

  if (command === "start") {
    await runInteractiveStartWizard();
    return;
  }

  if (command === "status-relay") {
    console.log(JSON.stringify(getRelayStatus(), null, 2));
    return;
  }

  if (command === "stop-relay") {
    console.log(JSON.stringify({ stopped: stopRelayProcesses() }, null, 2));
    return;
  }

  if (command === "restart-relay") {
    const stopped = stopRelayProcesses();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const result = startRelayProcesses();
    const ready = await waitForBridgeReady(options.socketPath, { timeoutMs: 5_000 });
    console.log(JSON.stringify({
      stopped,
      started: result.started,
      reused: result.reused,
      bridge_ready: ready,
      processes: Object.fromEntries(
        Object.entries(result.processes).map(([name, info]) => [
          name,
          { pid: info.pid, logFile: info.logFile, errFile: info.errFile }
        ])
      )
    }, null, 2));
    return;
  }

  if (command === "relay-bind") {
    const result = await sendBridgeMessage({
      type: "lark_create_bind",
      chat_id: options.chatId,
      thread_id: options.threadId,
      reply_message_id: options.replyMessageId || undefined,
      code: options.code || undefined
    }, { socketPath: options.socketPath });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "relay-send") {
    const result = await sendBridgeMessage({
      type: "lark_message",
      chat_id: options.chatId,
      thread_id: options.threadId,
      message_id: options.messageId || `local-${Date.now()}`,
      reply_message_id: options.replyMessageId || undefined,
      text: options.text
    }, { socketPath: options.socketPath });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "doctor") {
    console.log(JSON.stringify(doctor(), null, 2));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}
