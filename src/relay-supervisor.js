import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DEFAULT_RELAY_RUNTIME_PATH, PROJECT_ROOT } from "./constants.js";

const PROCESS_SPECS = {
  bridge: ["bridge", "--lark-cli"],
  "lark-listen": ["lark-listen"]
};

export const DEFAULT_RELAY_LOGS_DIR = path.join(os.homedir(), ".agent2lark", "logs");

function emptyRuntime() {
  return { processes: {} };
}

function readRuntime(runtimePath = DEFAULT_RELAY_RUNTIME_PATH) {
  if (!fs.existsSync(runtimePath)) {
    return emptyRuntime();
  }
  return {
    ...emptyRuntime(),
    ...JSON.parse(fs.readFileSync(runtimePath, "utf8"))
  };
}

function writeRuntime(runtimePath, runtime) {
  fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
  fs.writeFileSync(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`, "utf8");
}

function removeRuntime(runtimePath) {
  if (fs.existsSync(runtimePath)) {
    fs.unlinkSync(runtimePath);
  }
}

export function isProcessAlive(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function startRelayProcesses(options = {}) {
  const runtimePath = options.runtimePath || DEFAULT_RELAY_RUNTIME_PATH;
  const logsDir = options.logsDir || DEFAULT_RELAY_LOGS_DIR;
  const cwd = options.cwd || PROJECT_ROOT;
  const spawnProcess = options.spawnProcess || spawn;
  const isAlive = options.isAlive || isProcessAlive;
  const openLogFile = options.openLogFile
    || ((filePath) => fs.openSync(filePath, "a"));
  const env = { ...process.env, ...(options.env || {}) };
  const runtime = readRuntime(runtimePath);
  const started = [];
  const reused = [];

  fs.mkdirSync(logsDir, { recursive: true });

  for (const [name, args] of Object.entries(PROCESS_SPECS)) {
    const existing = runtime.processes[name];
    if (existing && isAlive(existing.pid)) {
      reused.push(name);
      continue;
    }

    const logFile = path.join(logsDir, `${name}.out.log`);
    const errFile = path.join(logsDir, `${name}.err.log`);
    const outFd = openLogFile(logFile);
    const errFd = openLogFile(errFile);

    const child = spawnProcess(process.execPath, [
      path.join(PROJECT_ROOT, "bin", "agent2lark-cursor.js"),
      ...args
    ], {
      cwd,
      detached: true,
      env,
      stdio: ["ignore", outFd, errFd]
    });
    if (typeof child.unref === "function") {
      child.unref();
    }

    runtime.processes[name] = {
      pid: child.pid,
      command: process.execPath,
      args,
      logFile,
      errFile,
      startedAt: Date.now()
    };
    started.push(name);
  }

  writeRuntime(runtimePath, runtime);
  return { started, reused, processes: runtime.processes };
}

export function getRelayStatus(options = {}) {
  const runtimePath = options.runtimePath || DEFAULT_RELAY_RUNTIME_PATH;
  const isAlive = options.isAlive || isProcessAlive;
  const runtime = readRuntime(runtimePath);
  const status = {};

  for (const [name, processInfo] of Object.entries(runtime.processes)) {
    status[name] = {
      pid: processInfo.pid,
      running: isAlive(processInfo.pid)
    };
  }

  return status;
}

export function stopRelayProcesses(options = {}) {
  const runtimePath = options.runtimePath || DEFAULT_RELAY_RUNTIME_PATH;
  const runtime = readRuntime(runtimePath);
  const killProcess = options.killProcess || ((pid, signal) => process.kill(pid, signal));
  const isAlive = options.isAlive || isProcessAlive;
  const sleep = options.sleep || ((ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // Cheap busy wait keeps stop synchronous; ms is small (default 500ms).
    }
  });
  const sigtermGraceMs = Number(options.sigtermGraceMs ?? 600);
  const stopped = [];

  const targets = [];
  for (const [name, processInfo] of Object.entries(runtime.processes)) {
    if (!processInfo.pid) continue;
    targets.push({ name, pid: processInfo.pid });
  }

  for (const { pid } of targets) {
    try { killProcess(-pid, "SIGTERM"); } catch { /* group may be gone */ }
    try { killProcess(pid, "SIGTERM"); } catch { /* process may be gone */ }
  }

  if (targets.length > 0) {
    sleep(sigtermGraceMs);
  }

  for (const { name, pid } of targets) {
    if (isAlive(pid)) {
      try { killProcess(-pid, "SIGKILL"); } catch { /* ignore */ }
      try { killProcess(pid, "SIGKILL"); } catch { /* ignore */ }
    }
    stopped.push(name);
  }

  removeRuntime(runtimePath);
  return stopped;
}
