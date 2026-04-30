import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  getRelayStatus,
  startRelayProcesses,
  stopRelayProcesses
} from "../src/relay-supervisor.js";

function tempRuntimePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent2lark-runtime-")), "runtime.json");
}

test("starts bridge and listener once and reuses live processes", () => {
  const runtimePath = tempRuntimePath();
  const spawned = [];
  let nextPid = 1000;

  const first = startRelayProcesses({
    runtimePath,
    cwd: "/tmp/project",
    spawnProcess(command, args, options) {
      const child = {
        pid: nextPid++,
        unrefCalled: false,
        unref() {
          this.unrefCalled = true;
        }
      };
      spawned.push({ command, args, options, child });
      return child;
    },
    env: { AGENT2LARK_CURSOR_AGENT_CWD: "/tmp/project" },
    isAlive: () => false
  });

  assert.deepEqual(first.started, ["bridge", "lark-listen"]);
  assert.equal(spawned.length, 2);
  assert.equal(spawned[0].options.env.AGENT2LARK_CURSOR_AGENT_CWD, "/tmp/project");
  assert.equal(spawned[0].child.unrefCalled, true);

  const second = startRelayProcesses({
    runtimePath,
    cwd: "/tmp/project",
    spawnProcess() {
      throw new Error("should not spawn live processes again");
    },
    isAlive: () => true
  });

  assert.deepEqual(second.reused, ["bridge", "lark-listen"]);
  assert.deepEqual(second.started, []);
});

test("opens stdout/stderr log files and records their paths", () => {
  const runtimePath = tempRuntimePath();
  const logsDir = path.join(path.dirname(runtimePath), "logs");
  const opened = [];
  const spawned = [];

  startRelayProcesses({
    runtimePath,
    logsDir,
    cwd: "/tmp/project",
    spawnProcess(command, args, options) {
      spawned.push(options);
      return { pid: 4242, unref() {} };
    },
    isAlive: () => false,
    openLogFile(filePath) {
      opened.push(filePath);
      return 99;
    }
  });

  assert.equal(fs.existsSync(logsDir), true);
  assert.deepEqual(opened, [
    path.join(logsDir, "bridge.out.log"),
    path.join(logsDir, "bridge.err.log"),
    path.join(logsDir, "lark-listen.out.log"),
    path.join(logsDir, "lark-listen.err.log")
  ]);
  assert.deepEqual(spawned[0].stdio, ["ignore", 99, 99]);
  assert.deepEqual(spawned[1].stdio, ["ignore", 99, 99]);

  const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
  assert.equal(
    runtime.processes.bridge.logFile,
    path.join(logsDir, "bridge.out.log")
  );
  assert.equal(
    runtime.processes.bridge.errFile,
    path.join(logsDir, "bridge.err.log")
  );
  assert.equal(
    runtime.processes["lark-listen"].logFile,
    path.join(logsDir, "lark-listen.out.log")
  );
});

test("reports and stops relay processes from runtime state", () => {
  const runtimePath = tempRuntimePath();
  const killed = [];
  fs.writeFileSync(runtimePath, JSON.stringify({
    processes: {
      bridge: { pid: 2001, command: "node", args: ["bridge"] },
      "lark-listen": { pid: 2002, command: "node", args: ["lark-listen"] }
    }
  }), "utf8");

  assert.deepEqual(getRelayStatus({
    runtimePath,
    isAlive: (pid) => pid === 2001
  }), {
    bridge: { pid: 2001, running: true },
    "lark-listen": { pid: 2002, running: false }
  });

  const stopped = stopRelayProcesses({
    runtimePath,
    sigtermGraceMs: 0,
    sleep: () => {},
    isAlive: () => false,
    killProcess(pid) {
      killed.push(pid);
    }
  });

  assert.deepEqual(stopped, ["bridge", "lark-listen"]);
  assert.deepEqual(killed.sort((a, b) => a - b), [-2002, -2001, 2001, 2002]);
  assert.equal(fs.existsSync(runtimePath), false);
});

test("escalates to SIGKILL when targets still alive after SIGTERM grace period", () => {
  const runtimePath = tempRuntimePath();
  const killed = [];
  fs.writeFileSync(runtimePath, JSON.stringify({
    processes: {
      bridge: { pid: 3001, command: "node", args: ["bridge"] },
      "lark-listen": { pid: 3002, command: "node", args: ["lark-listen"] }
    }
  }), "utf8");

  let sleepCalled = 0;
  const stopped = stopRelayProcesses({
    runtimePath,
    sigtermGraceMs: 50,
    sleep: () => { sleepCalled += 1; },
    isAlive: (pid) => pid === 3002,
    killProcess(pid, signal) {
      killed.push({ pid, signal });
    }
  });

  assert.deepEqual(stopped, ["bridge", "lark-listen"]);
  assert.equal(sleepCalled, 1, "should wait once before escalating");

  const sigterms = killed.filter((entry) => entry.signal === "SIGTERM").map((entry) => entry.pid);
  const sigkills = killed.filter((entry) => entry.signal === "SIGKILL").map((entry) => entry.pid);
  assert.deepEqual(sigterms.sort((a, b) => a - b), [-3002, -3001, 3001, 3002]);
  assert.deepEqual(sigkills.sort((a, b) => a - b), [-3002, 3002], "lark-listen still alive should get SIGKILL");
  assert.equal(fs.existsSync(runtimePath), false);
});
