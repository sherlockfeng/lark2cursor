#!/usr/bin/env node
import { startBridgeServer } from "../src/bridge-server.js";

const server = startBridgeServer();
console.error("agent2lark-cursor bridge started");

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
