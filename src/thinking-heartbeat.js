const DEFAULT_THINKING_INTERVAL_MS = 60_000;

export class ThinkingHeartbeat {
  constructor({ intervalMs = DEFAULT_THINKING_INTERVAL_MS, lark, log } = {}) {
    this.intervalMs = Number(intervalMs) || 0;
    this.lark = lark;
    this.log = log || (() => {});
    this.timers = new Map();
  }

  start(key, binding) {
    if (this.intervalMs <= 0) return;
    if (!key || !binding || !this.lark) return;
    if (this.timers.has(key)) return;

    const startedAt = Date.now();
    const entry = { binding, startedAt, lastActivityAt: startedAt };
    const timer = setInterval(() => {
      this.tick(key).catch((error) => {
        this.log(`[thinking-heartbeat] tick failed key=${key} ${error?.message || error}`);
      });
    }, this.intervalMs);
    if (typeof timer.unref === "function") timer.unref();

    entry.timer = timer;
    this.timers.set(key, entry);
  }

  stop(key) {
    const entry = this.timers.get(key);
    if (!entry) return;
    clearInterval(entry.timer);
    this.timers.delete(key);
  }

  isActive(key) {
    return this.timers.has(key);
  }

  touch(key) {
    const entry = this.timers.get(key);
    if (!entry) return;
    entry.lastActivityAt = Date.now();
  }

  stopAll() {
    for (const key of [...this.timers.keys()]) {
      this.stop(key);
    }
  }

  async tick(key) {
    const entry = this.timers.get(key);
    if (!entry) return;
    const now = Date.now();
    if (now - entry.lastActivityAt < this.intervalMs) return;

    const elapsedMs = now - entry.startedAt;
    const seconds = Math.round(elapsedMs / 1000);
    const text = `🤔 Thinking… (${seconds}s)`;
    await this.lark.sendThreadMessage({
      chatId: entry.binding.chatId,
      threadId: entry.binding.threadId,
      replyMessageId: entry.binding.replyMessageId,
      text,
      format: "text"
    });
    entry.lastActivityAt = now;
  }
}
