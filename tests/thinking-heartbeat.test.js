import assert from "node:assert/strict";
import test from "node:test";
import { ThinkingHeartbeat } from "../src/thinking-heartbeat.js";

function makeRecorder() {
  const sent = [];
  return {
    sent,
    lark: {
      async sendThreadMessage(message) {
        sent.push(message);
      }
    }
  };
}

test("emits a thinking heartbeat while a turn is active", async () => {
  const { sent, lark } = makeRecorder();
  const heartbeat = new ThinkingHeartbeat({ intervalMs: 5, lark });

  heartbeat.start("session-1", {
    chatId: "oc_chat",
    threadId: "omt_thread",
    replyMessageId: "om_root"
  });

  await new Promise((resolve) => setTimeout(resolve, 18));
  heartbeat.stop("session-1");

  assert.ok(sent.length >= 2, `expected at least 2 ticks, got ${sent.length}`);
  assert.match(sent[0].text, /Thinking…/);
  assert.equal(sent[0].chatId, "oc_chat");
  assert.equal(sent[0].threadId, "omt_thread");
  assert.equal(sent[0].format, "text");
});

test("stop() prevents further heartbeats", async () => {
  const { sent, lark } = makeRecorder();
  const heartbeat = new ThinkingHeartbeat({ intervalMs: 5, lark });

  heartbeat.start("s1", { chatId: "oc", threadId: "omt", replyMessageId: "om" });
  assert.equal(heartbeat.isActive("s1"), true);
  await new Promise((resolve) => setTimeout(resolve, 12));
  heartbeat.stop("s1");
  assert.equal(heartbeat.isActive("s1"), false);
  const before = sent.length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sent.length, before);
});

test("touch() delays the next thinking heartbeat", async () => {
  const { sent, lark } = makeRecorder();
  const heartbeat = new ThinkingHeartbeat({ intervalMs: 20, lark });

  heartbeat.start("s1", { chatId: "oc", threadId: "omt", replyMessageId: "om" });
  await new Promise((resolve) => setTimeout(resolve, 12));
  heartbeat.touch("s1");
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(sent.length, 0);

  await new Promise((resolve) => setTimeout(resolve, 25));
  heartbeat.stop("s1");
  assert.ok(sent.length >= 1, "expected heartbeat after progress had been quiet for the interval");
});

test("ignores duplicate start calls for the same key", async () => {
  const { sent, lark } = makeRecorder();
  const heartbeat = new ThinkingHeartbeat({ intervalMs: 5, lark });

  heartbeat.start("s1", { chatId: "oc", threadId: "omt", replyMessageId: "om" });
  heartbeat.start("s1", { chatId: "oc", threadId: "omt", replyMessageId: "om" });
  await new Promise((resolve) => setTimeout(resolve, 12));
  heartbeat.stop("s1");

  assert.ok(sent.length <= 3, `expected single timer, but observed ${sent.length} ticks (looks doubled)`);
});

test("disabling via intervalMs <= 0 makes start() a no-op", async () => {
  const { sent, lark } = makeRecorder();
  const heartbeat = new ThinkingHeartbeat({ intervalMs: 0, lark });

  heartbeat.start("s1", { chatId: "oc", threadId: "omt", replyMessageId: "om" });
  await new Promise((resolve) => setTimeout(resolve, 15));
  heartbeat.stop("s1");

  assert.equal(sent.length, 0);
});
