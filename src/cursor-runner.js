import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function responseText(response) {
  if (typeof response === "string") {
    return response;
  }
  if (response && typeof response.text === "string") {
    return response.text;
  }
  if (response && typeof response.content === "string") {
    return response.content;
  }
  return response ? JSON.stringify(response) : "";
}

async function loadCursorSdk() {
  try {
    return await import("@cursor/sdk");
  } catch {
    return undefined;
  }
}

function extractAgentSessionId(text) {
  return String(text || "").match(/\b(?:agent|bc)[_-][A-Za-z0-9_-]+\b/)?.[0];
}

export function createCursorRunner(options = {}) {
  const sdkModule = Object.hasOwn(options, "sdkModule") ? options.sdkModule : undefined;
  const shouldAutoLoadSdk = !Object.hasOwn(options, "sdkModule");
  const runCommand = options.runCommand || execFileAsync;
  const command = options.command || process.env.CURSOR_AGENT_COMMAND || "cursor-agent";

  return {
    async runPrompt({ cwd = process.cwd(), prompt, agentSessionId = undefined }) {
      if (!prompt) {
        throw new Error("Cannot run Cursor agent without a prompt");
      }

      const loadedSdk = sdkModule || (shouldAutoLoadSdk ? await loadCursorSdk() : undefined);
      if (loadedSdk?.Agent) {
        const agent = agentSessionId && typeof loadedSdk.Agent.resume === "function"
          ? await loadedSdk.Agent.resume(agentSessionId)
          : await loadedSdk.Agent.create({ local: { cwd } });
        const response = typeof agent.send === "function"
          ? await agent.send(prompt)
          : await agent.run(prompt);
        return {
          text: responseText(response),
          agentSessionId: agent.id || agentSessionId
        };
      }

      const args = ["-p", prompt];
      if (agentSessionId) {
        args.push("--resume", agentSessionId);
      }
      args.push("--force");

      const { stdout } = await runCommand(command, args, { cwd });
      const text = String(stdout || "").trim();
      return {
        text,
        agentSessionId: agentSessionId || extractAgentSessionId(text)
      };
    }
  };
}
