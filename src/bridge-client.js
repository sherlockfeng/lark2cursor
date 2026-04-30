import fs from "node:fs";
import net from "node:net";
import { DEFAULT_BRIDGE_SOCKET_PATH } from "./constants.js";

export function bridgeSocketExists(socketPath = DEFAULT_BRIDGE_SOCKET_PATH) {
  return fs.existsSync(socketPath);
}

export function sendBridgeMessage(message, options = {}) {
  const socketPath = options.socketPath || process.env.AGENT2LARK_BRIDGE_SOCKET || DEFAULT_BRIDGE_SOCKET_PATH;
  const timeoutMs = Number(options.timeoutMs || process.env.AGENT2LARK_BRIDGE_TIMEOUT_MS || 30_000);

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    let settled = false;

    const settle = (fn, value) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      fn(value);
    };

    socket.setTimeout(timeoutMs);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(message)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }

      const line = buffer.slice(0, newline).trim();
      try {
        settle(resolve, line ? JSON.parse(line) : {});
      } catch (error) {
        settle(reject, error);
      }
    });
    socket.on("timeout", () => settle(reject, new Error(`Timed out waiting for bridge response after ${timeoutMs}ms`)));
    socket.on("error", (error) => settle(reject, error));
    socket.on("end", () => {
      if (!settled && buffer.trim()) {
        try {
          settle(resolve, JSON.parse(buffer.trim()));
        } catch (error) {
          settle(reject, error);
        }
      }
    });
  });
}
