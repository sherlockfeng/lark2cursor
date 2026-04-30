import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sendBridgeMessage } from "../src/bridge-client.js";

test("rejects instead of silently succeeding when the bridge response times out", async () => {
  const socketPath = path.join(os.tmpdir(), `agent2lark-timeout-${process.pid}-${Date.now()}.sock`);
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  try {
    await assert.rejects(
      () => sendBridgeMessage({ type: "ping" }, { socketPath, timeoutMs: 10 }),
      /timed out/i
    );
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => server.close(resolve));
  }
});
