import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionStore } from "../src/session-store.js";

function tempStatePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent2lark-store-")), "state.json");
}

test("binds a pending Lark thread to one Cursor session", () => {
  const store = new SessionStore(tempStatePath());
  store.createPendingBind({
    code: "abc123",
    chatId: "oc_chat",
    threadId: "omt_thread",
    expiresAt: Date.now() + 60_000
  });

  const binding = store.bindCursorSession({
    code: "abc123",
    sessionId: "cursor-session",
    cwd: "/tmp/project"
  });

  assert.deepEqual(binding, {
    chatId: "oc_chat",
    threadId: "omt_thread",
    sessionId: "cursor-session",
    cwd: "/tmp/project"
  });
  assert.deepEqual(store.getBindingByCursorSession("cursor-session"), binding);
  assert.deepEqual(store.getBindingByLarkThread("oc_chat", "omt_thread"), binding);
});

test("dequeues Lark messages for the bound Cursor session only once", () => {
  const store = new SessionStore(tempStatePath());
  store.createPendingBind({
    code: "abc123",
    chatId: "oc_chat",
    threadId: "omt_thread",
    expiresAt: Date.now() + 60_000
  });
  store.bindCursorSession({
    code: "abc123",
    sessionId: "cursor-session",
    cwd: "/tmp/project"
  });

  store.enqueueLarkMessage({
    chatId: "oc_chat",
    threadId: "omt_thread",
    messageId: "om_1",
    text: "继续修复测试"
  });

  assert.deepEqual(store.dequeueForCursorSession("cursor-session"), {
    chatId: "oc_chat",
    threadId: "omt_thread",
    messageId: "om_1",
    text: "继续修复测试"
  });
  assert.equal(store.dequeueForCursorSession("cursor-session"), undefined);
});

test("lists bindings for a Lark chat", () => {
  const store = new SessionStore(tempStatePath());
  store.createPendingBind({
    code: "abc123",
    chatId: "oc_chat",
    threadId: "om_root",
    expiresAt: Date.now() + 60_000
  });
  store.bindCursorSession({
    code: "abc123",
    sessionId: "cursor-session",
    cwd: "/tmp/project"
  });

  assert.deepEqual(store.getBindingsByLarkChat("oc_chat"), [{
    chatId: "oc_chat",
    threadId: "om_root",
    sessionId: "cursor-session",
    cwd: "/tmp/project"
  }]);
});

test("rejects expired bind codes", () => {
  const store = new SessionStore(tempStatePath());
  store.createPendingBind({
    code: "expired",
    chatId: "oc_chat",
    threadId: "omt_thread",
    expiresAt: Date.now() - 1
  });

  assert.throws(
    () => store.bindCursorSession({ code: "expired", sessionId: "cursor-session" }),
    /expired/i
  );
});

test("creating an official agent binding clears an existing Cursor binding for the same thread", () => {
  const store = new SessionStore(tempStatePath());
  store.createPendingBind({
    code: "abc123",
    chatId: "oc_chat",
    threadId: "om_root",
    expiresAt: Date.now() + 60_000
  });
  store.bindCursorSession({
    code: "abc123",
    sessionId: "cursor-session",
    cwd: "/tmp/project"
  });

  store.createAgentBinding({
    chatId: "oc_chat",
    threadId: "om_root",
    replyMessageId: "om_root",
    cwd: "/tmp/project"
  });

  assert.equal(store.getBindingByCursorSession("cursor-session"), undefined);
  assert.deepEqual(store.getBindingByLarkThread("oc_chat", "om_root"), {
    chatId: "oc_chat",
    threadId: "om_root",
    replyMessageId: "om_root",
    cwd: "/tmp/project",
    mode: "official_agent"
  });
});

test("removes a Lark thread binding and clears related queues", () => {
  const store = new SessionStore(tempStatePath());
  store.createPendingBind({
    code: "abc123",
    chatId: "oc_chat",
    threadId: "om_root",
    expiresAt: Date.now() + 60_000
  });
  store.bindCursorSession({
    code: "abc123",
    sessionId: "cursor-session",
    cwd: "/tmp/project"
  });
  store.enqueueLarkMessage({
    chatId: "oc_chat",
    threadId: "om_root",
    messageId: "om_queued",
    text: "queued"
  });

  const removed = store.unbindLarkThread({ chatId: "oc_chat", threadId: "om_root" });

  assert.equal(removed.threadId, "om_root");
  assert.equal(store.getBindingByLarkThread("oc_chat", "om_root"), undefined);
  assert.equal(store.getBindingByCursorSession("cursor-session"), undefined);
  assert.equal(store.dequeueForCursorSession("cursor-session"), undefined);
});

test("unbind falls back to the only binding in a chat when reply root is missing", () => {
  const store = new SessionStore(tempStatePath());
  store.createPendingBind({
    code: "abc123",
    chatId: "oc_chat",
    threadId: "om_root",
    expiresAt: Date.now() + 60_000
  });
  store.bindCursorSession({
    code: "abc123",
    sessionId: "cursor-session",
    cwd: "/tmp/project"
  });

  const removed = store.unbindLarkThread({ chatId: "oc_chat", threadId: "om_reply_message" });

  assert.equal(removed.threadId, "om_root");
  assert.equal(store.getBindingByLarkThread("oc_chat", "om_root"), undefined);
  assert.equal(store.getBindingByCursorSession("cursor-session"), undefined);
});
