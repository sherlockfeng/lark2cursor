#!/usr/bin/env node
import { runHook } from "../src/hook.js";

runHook().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[agent2lark-cursor-hook] ${message}`);
  console.log(JSON.stringify({
    permission: "ask",
    user_message: "agent2lark-cursor failed. Please review this action locally.",
    agent_message: message
  }));
});
