import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureRuntimeConfigFile, readRuntimeConfig } from "../src/runtime-config.js";

function tempConfigPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent2lark-config-"));
  return path.join(dir, "config.json");
}

test("reads thinkingIntervalMs from runtime config file", () => {
  const configPath = tempConfigPath();
  fs.writeFileSync(configPath, JSON.stringify({ thinkingIntervalMs: 12_345 }), "utf8");

  assert.equal(
    readRuntimeConfig({ configPath, env: {} }).thinkingIntervalMs,
    12_345
  );
});

test("lets AGENT2LARK_THINKING_INTERVAL_MS override the config file", () => {
  const configPath = tempConfigPath();
  fs.writeFileSync(configPath, JSON.stringify({ thinkingIntervalMs: 12_345 }), "utf8");

  assert.equal(
    readRuntimeConfig({
      configPath,
      env: { AGENT2LARK_THINKING_INTERVAL_MS: "2222" }
    }).thinkingIntervalMs,
    2222
  );
});

test("writes default runtime config when missing", () => {
  const configPath = tempConfigPath();

  assert.equal(ensureRuntimeConfigFile({ configPath }), true);
  assert.equal(ensureRuntimeConfigFile({ configPath }), false);

  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(parsed.thinkingIntervalMs, 60_000);
  assert.equal(parsed.progressRelayEnabled, false);
});

test("reads progressRelayEnabled from runtime config and env", () => {
  const configPath = tempConfigPath();
  fs.writeFileSync(configPath, JSON.stringify({ progressRelayEnabled: false }), "utf8");

  assert.equal(
    readRuntimeConfig({ configPath, env: {} }).progressRelayEnabled,
    false
  );
  assert.equal(
    readRuntimeConfig({
      configPath,
      env: { AGENT2LARK_PROGRESS_RELAY: "1" }
    }).progressRelayEnabled,
    true
  );
  assert.equal(
    readRuntimeConfig({
      configPath,
      env: { AGENT2LARK_PROGRESS_RELAY: "false" }
    }).progressRelayEnabled,
    false
  );
});
