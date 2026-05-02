# agent2lark-cursor 项目实现蓝图

本文是给另一个工程 Agent 使用的“从零实现”项目文档。目标不是只解释当前代码，而是把需求、架构、数据协议、模块边界、关键算法、测试矩阵和实现顺序写完整，让一个新 Agent 可以在空目录里按本文重建一个功能等价的 `@sherlockfeng/lark2cursor`。

本文以当前 `main` 分支的公开行为和源码为准。

## 1. 项目目标

`agent2lark-cursor` 是一个 Node.js CLI 工具，用 Cursor public hooks 和 `lark-cli` 把 Cursor IDE Agent Chat 与飞书 / Lark thread 连接起来。

项目提供两个主要能力：

1. **IDE Chat Relay**
   - 用户在飞书 thread 里发消息。
   - 本地 listener 收到消息并写入本地 bridge 队列。
   - Cursor Chat 在 `stop` hook 里长轮询队列，把飞书消息作为下一条 `followup_message` 注入 Chat。
   - Cursor 生成回复后，`afterAgentResponse` hook 把回复发回同一个飞书 thread。

2. **Remote Tool Approval**
   - Cursor 执行高风险工具前触发 approval hooks。
   - hook 把审批请求发给本地 bridge。
   - bridge 在绑定的飞书 thread 里发审批提示。
   - 用户在 thread 内回复 `/allow`、`/deny`、`/allow!`、`/deny!` 等命令。
   - bridge 解除阻塞中的 hook，并按需把“记住本次决策”的规则写入本地 policy 文件。

## 2. 非目标与约束

明确不要实现以下能力：

- 不做 Cursor UI 自动化，不使用 DOM/辅助功能模拟点击。
- 不依赖非公开 Cursor IPC。
- 不要求外部 `agent2lark` daemon，审批能力由本项目自包含实现。
- 不把完整 shell stdout/stderr 或工具返回值同步到飞书。
- 不把飞书消息主动注入已经完全 idle 的 Cursor Chat。public hooks 只能在 Cursor 触发生命周期事件时运行。

重要约束：

- Cursor `beforeSubmitPrompt` 可以允许或阻止当前 prompt，但不能主动创建另一个 prompt。
- Cursor `stop.followup_message` 只能在已有 Agent turn 结束后追加下一条消息。
- bridge 是本机 Unix domain socket 服务，不对外暴露网络端口。
- 飞书消息必须先被 `lark-cli event +subscribe` 收到；如果机器人没有事件权限，代码侧无法弥补。

## 3. 技术栈与运行环境

实现要求：

- Node.js `>=20.12.0`
- ESM 模块：`"type": "module"`
- 包管理：`pnpm`
- 测试框架：Node 内置 `node:test`
- 外部 CLI：`@larksuite/cli` 作为 npm dependency

`package.json` 必须包含：

- `bin.agent2lark-cursor`
- `bin.agent2lark-cursor-hook`
- `bin.agent2lark-cursor-bridge`
- `scripts.test = "node --test tests/*.test.js"`
- `scripts.start-relay`
- `scripts.stop-relay`
- `scripts.restart-relay`
- `scripts.status-relay`
- `scripts.install-hooks`
- `scripts.uninstall-hooks`
- `scripts.doctor`

## 4. 目录结构

建议从空项目创建以下结构：

```text
bin/
  agent2lark-cursor.js
  agent2lark-cursor-hook.js
  agent2lark-cursor-bridge.js

src/
  approval-policy.js
  bridge-client.js
  bridge-server.js
  cli.js
  constants.js
  cursor-runner.js
  hook.js
  installer.js
  io.js
  lark-adapter.js
  lark-cli-command.js
  lark-config.js
  lark-listener.js
  normalize.js
  relay-supervisor.js
  runtime-config.js
  session-store.js
  start-wizard.js
  thinking-heartbeat.js

tests/
  approval-policy.test.js
  bridge-client.test.js
  bridge-server.test.js
  cursor-runner.test.js
  hook.test.js
  installer.test.js
  lark-adapter.test.js
  lark-cli-command.test.js
  lark-config.test.js
  lark-listener.test.js
  normalize.test.js
  relay-normalize.test.js
  relay-supervisor.test.js
  runtime-config.test.js
  session-store.test.js
  start-wizard.test.js
  thinking-heartbeat.test.js

docs/
  ARCHITECTURE.md
  PROJECT_BLUEPRINT.md
```

## 5. 本地文件布局

所有运行态文件放在用户 home 下，避免污染项目仓库：

```text
~/.agent2lark/
  cursor-relay.sock
  cursor-relay-state.json
  cursor-relay-runtime.json
  cursor-approval-policy.json
  config.json
  logs/
    bridge.out.log
    bridge.err.log
    lark-listen.out.log
    lark-listen.err.log
```

Cursor hooks 配置写入：

```text
~/.cursor/hooks.json
```

## 6. 常量设计

在 `src/constants.js` 中集中定义：

```js
DEFAULT_BRIDGE_SOCKET_PATH = ~/.agent2lark/cursor-relay.sock
DEFAULT_RELAY_STATE_PATH = ~/.agent2lark/cursor-relay-state.json
DEFAULT_RELAY_RUNTIME_PATH = ~/.agent2lark/cursor-relay-runtime.json
DEFAULT_APPROVAL_POLICY_PATH = ~/.agent2lark/cursor-approval-policy.json
DEFAULT_RUNTIME_CONFIG_PATH = ~/.agent2lark/config.json
PROJECT_ROOT = repo root derived from import.meta.url
HOOK_BIN_PATH = PROJECT_ROOT/bin/agent2lark-cursor-hook.js
BRIDGE_BIN_PATH = PROJECT_ROOT/bin/agent2lark-cursor-bridge.js
USER_HOOKS_PATH = ~/.cursor/hooks.json
MARKER = "agent2lark-cursor-hook"
```

Approval-only default hooks：

```js
DEFAULT_EVENTS = [
  "beforeShellExecution",
  "beforeMCPExecution",
  "preToolUse"
]
```

Relay hooks：

```js
RELAY_EVENTS = [
  "sessionStart",
  "beforeSubmitPrompt",
  "afterAgentResponse",
  "postToolUse",
  "postToolUseFailure",
  "afterShellExecution",
  "stop"
]
```

## 7. 进程拓扑

`pnpm run start-relay` 完成后应有两个长期后台进程：

```text
node bin/agent2lark-cursor.js bridge --lark-cli
node bin/agent2lark-cursor.js lark-listen
  └─ lark-cli event +subscribe --event-types im.message.receive_v1,card.action.trigger --compact --quiet --as bot
```

Cursor 每次触发 hook 时还会短暂启动：

```text
node bin/agent2lark-cursor-hook.js --event <event>
```

### 7.1 bridge 进程

职责：

- 监听 Unix socket。
- 维护 `SessionStore`。
- 维护 `ApprovalRegistry`。
- 读取/写入 approval policy。
- 根据消息类型路由所有 bridge 请求。
- 使用 Lark adapter 发飞书消息、反应、审批提示。

### 7.2 lark-listen 进程

职责：

- 启动并监督 `lark-cli event +subscribe`。
- 逐行读取 compact JSON 事件。
- 解析命令消息：`bind chat`、`unbind`、`stop wait`、`/help`、`/allow`、`/deny`。
- 普通消息转为 `lark_message` 发给 bridge。
- `lark-cli` 子进程退出时自动 respawn。

### 7.3 hook 进程

职责：

- 从 stdin 读取 Cursor hook JSON。
- 根据 event 类型转换为 bridge message。
- 通过 Unix socket 发给 bridge。
- 把 bridge 响应转换成 Cursor hook stdout JSON。
- bridge 不可用时 fallback。

## 8. Cursor Hook 集成

### 8.1 Hook 安装

`installer.js` 读取 `~/.cursor/hooks.json`，删除已有本项目 hook，再写入新 hook。

每个 hook entry：

```json
{
  "command": "'/path/to/node' '/path/to/bin/agent2lark-cursor-hook.js' --event '<event>'",
  "timeout": 86400,
  "failClosed": false
}
```

`preToolUse` 需要 matcher：

```text
Shell|Bash|Write|Edit|Delete|ApplyPatch|MultiEdit|MCP:.*|mcp__.*
```

`stop` hook 设置：

```json
{ "loop_limit": null }
```

这样 Cursor 可以持续接受 `followup_message`。

### 8.2 Hook 输入归一化

在 `normalize.js` 中实现：

- `sessionStart` -> `cursor_session_start`
- `beforeSubmitPrompt` -> `cursor_prompt_submit`
- `afterAgentResponse` -> `cursor_agent_response`
- `stop` -> `cursor_stop`
- `afterShellExecution` -> `cursor_progress`
- `postToolUse` -> `cursor_progress`
- `postToolUseFailure` -> `cursor_progress`
- `beforeShellExecution` -> `cursor_approval_request`
- `beforeMCPExecution` -> `cursor_approval_request`
- `preToolUse` -> `cursor_approval_request`

所有消息都应带：

```js
session_id
cwd
```

`session_id` 从以下字段择一：

```text
session_id, sessionId, conversation_id, conversationId, thread_id, threadId, CURSOR_SESSION_ID
```

`cwd` 从以下字段择一：

```text
cwd, working_directory, workingDirectory, workspace_path, workspacePath, project_root, projectRoot, process.cwd()
```

### 8.3 Hook 输出

`hook.js` 对 relay events 输出：

`sessionStart`：

```json
{ "additional_context": "..." }
```

`beforeSubmitPrompt`：

```json
{ "continue": true }
```

或拦截 bind：

```json
{
  "continue": false,
  "user_message": "Bound to Lark thread ..."
}
```

`stop`：

```json
{ "followup_message": "..." }
```

没有消息时：

```json
{}
```

Approval hooks 输出：

```json
{ "permission": "allow", "agent_message": "Approved by agent2lark-cursor (...)" }
```

```json
{
  "permission": "deny",
  "user_message": "Denied by agent2lark-cursor (...)",
  "agent_message": "Denied by agent2lark-cursor (...)"
}
```

fallback：

```json
{
  "permission": "ask",
  "user_message": "Please review this Cursor action locally.",
  "agent_message": "agent2lark-cursor fell back to Cursor local approval."
}
```

### 8.4 Hook 超时

默认 bridge socket timeout：

```text
AGENT2LARK_BRIDGE_TIMEOUT_MS or 30000
```

`stop` hook 必须延长到：

```text
max(defaultTimeout, AGENT2LARK_WAIT_POLL_MS + 5000)
```

审批 hook 必须延长到：

```text
max(defaultTimeout, AGENT2LARK_APPROVAL_TIMEOUT_MS + 5000)
```

否则长轮询或审批等待会被 hook client 提前断开。

## 9. Bridge Wire Protocol

bridge 使用 Unix socket + JSON Lines。

每次请求：

```text
client connects
client writes JSON + "\n"
bridge writes one JSON response + "\n"
bridge closes connection
```

### 9.1 Message 类型总表

| Type | Sender | Purpose | Response |
| --- | --- | --- | --- |
| `cursor_session_start` | Cursor hook | 注册 Cursor session | `{additional_context}` |
| `cursor_prompt_submit` | Cursor hook | 检查 bind 命令 / 开始心跳 | `{continue, user_message?}` |
| `cursor_stop` | Cursor hook | 长轮询飞书队列 | `{followup_message?}` |
| `cursor_agent_response` | Cursor hook | 把 Cursor 回复发回飞书 | `{ok, suppressed?}` |
| `cursor_progress` | Cursor hooks | 同步短进度 | `{ok, sent, reason?}` |
| `cursor_approval_request` | Cursor approval hooks | 远程审批 | `{decision, reason}` |
| `lark_message` | lark-listen | 飞书普通消息入队 | `{ok, routed?}` |
| `lark_create_bind` | lark-listen | 创建 bind code | `{ok, code}` |
| `lark_create_agent_bind` | lark-listen | 创建内部 official agent binding | `{ok, binding}` |
| `lark_disable_wait` | lark-listen | 关闭等待循环 | `{ok}` |
| `lark_unbind_thread` | lark-listen | 解绑 thread | `{ok, removed}` |
| `lark_approval_decision` | lark-listen | 处理审批回复 | `{ok, ...}` |

## 10. 持久化状态模型

`SessionStore` 写入 `~/.agent2lark/cursor-relay-state.json`。

### 10.1 State schema

```jsonc
{
  "pendingBinds": {
    "<code>": {
      "code": "<code>",
      "chatId": "oc_xxx",
      "threadId": "om_xxx or omt_xxx",
      "replyMessageId": "om_xxx",
      "expiresAt": 1700000000000
    }
  },
  "bindings": {
    "byCursorSession": {
      "<cursor-session-id>": {
        "chatId": "oc_xxx",
        "threadId": "om_xxx",
        "replyMessageId": "om_xxx",
        "sessionId": "<cursor-session-id>",
        "cwd": "/path/to/project",
        "waitEnabled": false
      }
    },
    "byLarkThread": {
      "oc_xxx:om_xxx": {
        "chatId": "oc_xxx",
        "threadId": "om_xxx",
        "replyMessageId": "om_xxx",
        "sessionId": "<cursor-session-id>",
        "cwd": "/path/to/project"
      }
    }
  },
  "queues": {
    "oc_xxx:om_xxx": [
      {
        "chatId": "oc_xxx",
        "threadId": "om_xxx",
        "messageId": "om_msg",
        "replyMessageId": "om_reply",
        "text": "@bot please do something"
      }
    ]
  },
  "cursorSessions": {
    "<cursor-session-id>": {
      "sessionId": "<cursor-session-id>",
      "cwd": "/path",
      "composerMode": "agent",
      "updatedAt": 1700000000000
    }
  },
  "cursorResponses": [
    {
      "sessionId": "<cursor-session-id>",
      "text": "assistant response",
      "createdAt": 1700000000000
    }
  ]
}
```

### 10.2 Store 方法

必须实现：

- `createPendingBind({ code, chatId, threadId, replyMessageId, expiresAt })`
- `registerCursorSession({ sessionId, cwd, composerMode })`
- `bindCursorSession({ code, sessionId, cwd })`
- `getBindingByCursorSession(sessionId)`
- `getBindingByLarkThread(chatId, threadId)`
- `getBindingsByLarkChat(chatId)`
- `unbindLarkThread({ chatId, threadId })`
- `enqueueLarkMessage({ chatId, threadId, messageId, replyMessageId, text })`
- `dequeueForCursorSession(sessionId)`
- `setCursorBindingWait({ chatId, threadId, waitEnabled })`
- `createAgentBinding(...)`
- `updateAgentBinding(...)`
- `recordCursorResponse({ sessionId, text })`

### 10.3 Binding invariants

- 一个 Cursor session 只能绑定一个 Lark thread。
- 一个 Lark thread 只能绑定一个 Cursor session。
- 新绑定同一个 session 时，要删除旧 thread 反向索引。
- 新绑定同一个 thread 时，要删除旧 session 正向索引。
- pending bind 成功后必须删除。
- expired pending bind 不能使用，且要删除。
- unbind 时必须删除同 thread 队列。

## 11. IDE Chat Relay 详细流程

### 11.1 创建绑定码

用户在飞书 thread 中：

```text
@bot bind chat
```

`lark-listener` 判断：

- 事件必须是 bot 被 mention。
- `content` 匹配 `bind chat` 或中文 `绑定对话`。

然后：

1. 将事件归一化成 `lark_message`。
2. 构造 `lark_create_bind`：

```json
{
  "type": "lark_create_bind",
  "chat_id": "oc_xxx",
  "thread_id": "om_root",
  "reply_message_id": "om_root",
  "code": "om_root"
}
```

3. bridge 写入 `pendingBinds[code]`，默认 10 分钟过期。
4. listener 回复：

```text
message_id: om_xxx
```

### 11.2 在 Cursor Chat 中绑定

用户在目标 Cursor IDE Agent Chat 输入：

```text
bind lark thread message_id: om_xxx
```

`beforeSubmitPrompt` hook 发送 `cursor_prompt_submit`。

bridge 用正则识别 bind code：

```js
/(?:bind\s+lark\s+thread|bind|绑定飞书话题)\s+(?:message_id|messageId|消息id|消息 ?ID)\s*[:：]\s*([A-Za-z0-9_-]+)/i
```

必须要求显式 `message_id:`，防止 wait-loop 自己的 followup 文本误触发绑定。

成功后：

- `SessionStore.bindCursorSession(...)`
- 返回：

```json
{
  "continue": false,
  "user_message": "Bound to Lark thread <threadId>."
}
```

当前 `main` 的行为是 bind prompt 被拦截，所以 bind 本身不会创建一次 Agent turn。也就是说，绑定后真正开始等待飞书消息，需要 Cursor Chat 后续完成一次正常 turn，触发 `stop` hook。

### 11.3 飞书消息入队

用户在已绑定 thread 中发消息。

`lark-cli event +subscribe` 输出 compact JSON。

`lark-adapter.normalizeLarkEventToBridgeMessage(event)`：

- 只接受 `event.type === "im.message.receive_v1"`。
- 提取 `chat_id`。
- 提取 `message_id`。
- `thread_id` 优先级：

```text
root_id, rootId, parent_id, parentId, thread_id, threadId, message_id
```

- `reply_message_id` 优先级：

```text
reply_message_id, replyMessageId, root_id, rootId, parent_id, parentId, message_id
```

- 文本提取：
  - 优先 `event.text`。
  - 再看 `event.content`。
  - 如果是 JSON string，解出 `text` 或 `content`。
  - 移除 `<at ...>`、`<at_all/>` 等 Lark markup。

listener 发给 bridge：

```json
{
  "type": "lark_message",
  "chat_id": "oc_xxx",
  "thread_id": "om_or_omt",
  "message_id": "om_msg",
  "reply_message_id": "om_reply",
  "text": "@bot do something"
}
```

bridge 解析 thread：

1. 精确匹配 `chatId:threadId`。
2. 如果当前 chat 只有一个 binding，fallback 到唯一 binding。
3. 如果仍找不到，调用 `lark.getMessageThreadId` 对 binding root message 反查 canonical thread id，处理 `om_*` 与 `omt_*` 不一致。

最后写入：

```js
SessionStore.enqueueLarkMessage(...)
```

### 11.4 Cursor stop hook 拉消息

Cursor Chat 结束一轮后触发 `stop`。

hook 发：

```json
{
  "type": "cursor_stop",
  "session_id": "...",
  "loop_count": 0,
  "status": "completed"
}
```

bridge 执行 `dequeueForCursorWithWait`：

```text
deadline = now + AGENT2LARK_WAIT_POLL_MS (default 10 min)
loop:
  queued = store.dequeueForCursorSession(sessionId)
  if queued: return queued
  binding = store.getBindingByCursorSession(sessionId)
  if !binding or binding.waitEnabled === false: return {}
  if now >= deadline: return waitBinding
  sleep(AGENT2LARK_WAIT_INTERVAL_MS)
```

拿到队列消息后：

1. `ackInboundLarkMessage`
   - 添加 👀 reaction。
   - 回复 `Got it, processing…`。
   - 使用 `Promise.allSettled`，ack 失败不能阻塞主流程。
2. 启动 thinking heartbeat。
3. 返回：

```json
{
  "followup_message": "Lark thread <threadId>:\n<text>"
}
```

Cursor 会把 `followup_message` 注入成下一条用户消息。

### 11.5 没消息时的 wait heartbeat

长轮询超时但 binding 仍存在时，返回：

```text
AGENT2LARK_WAITING_FOR_LARK
Bound to Lark thread <threadId>; no new Lark messages right now.
Please reply with only: AGENT2LARK_WAITING_FOR_LARK
Do not invoke any tools and do not send a business reply to Lark.
```

Agent 应只回复：

```text
AGENT2LARK_WAITING_FOR_LARK
```

`cursor_agent_response` 看到回复正好等于 sentinel，则：

```json
{ "ok": true, "suppressed": "wait_heartbeat" }
```

不要发回飞书。下一次 `stop` 继续长轮询。

### 11.6 Cursor 回复回飞书

`afterAgentResponse` hook 发送：

```json
{
  "type": "cursor_agent_response",
  "session_id": "...",
  "text": "assistant final answer"
}
```

bridge：

- 找到 session binding。
- 如果无 binding 或无 text，返回 `{ok:true}`。
- 如果 text 是 wait sentinel，suppress。
- 否则：
  - `recordCursorResponse({ sessionId, text })`
  - `lark.sendThreadMessage({ chatId, threadId, replyMessageId, text })`
  - 返回 `{ok:true}`

## 12. Thinking Heartbeat

`thinking-heartbeat.js` 实现一个状态管理类：

```js
new ThinkingHeartbeat({ intervalMs, lark })
```

方法：

- `start(key, binding)`
- `stop(key)`
- `stopAll()`
- `isActive(key)`
- `touch(key)`

语义：

- `intervalMs <= 0` 时禁用。
- 同一个 key 重复 start 是幂等的。
- 每次 tick 发送：

```text
🤔 Thinking… (Ns)
```

- `touch(key)` 更新最后活动时间，避免刚发过工具进度又马上发 Thinking。

启动时机：

- `cursor_prompt_submit`，当前 session 已绑定，且不是 bind 命令。
- `cursor_stop` 返回真实 Lark followup message。
- 内部 official agent relay 执行期间。

停止时机：

- `cursor_agent_response`
- `cursor_stop` 返回 wait heartbeat 或 `{}`。
- official agent runner finally。

## 13. Safe Short Progress Relay

当前 `main` 的默认配置：

```json
{
  "thinkingIntervalMs": 60000,
  "progressRelayEnabled": true
}
```

当 `progressRelayEnabled !== false` 时，bridge 会把 `cursor_progress` 发到 Lark。

`cursor_progress` 来源：

- `afterShellExecution`
- `postToolUse`
- `postToolUseFailure`
- approval 命中 allow 后的 `started` progress

消息格式：

```text
Running: `<label>`
Done: `<label>` (12s)
Failed: `<label>` (exit 1)
```

安全要求：

- 不发送完整 stdout。
- 不发送完整 stderr。
- 不发送完整 tool output。
- label 最长 160 字符。
- redact 常见敏感环境变量：

```text
TOKEN, SECRET, PASSWORD, PASS, API_KEY, ACCESS_KEY
```

## 14. Remote Tool Approval 详细流程

### 14.1 风险工具识别

低风险工具自动 allow。高风险工具：

```text
Bash
Shell
Write
Edit
Delete
ApplyPatch
MultiEdit
mcp__*
MCP:*
```

`preToolUse` 对非高风险工具直接输出：

```json
{
  "permission": "allow",
  "agent_message": "agent2lark-cursor ignored a low-risk Cursor tool."
}
```

### 14.2 审批请求归一化

approval hook -> `cursor_approval_request`：

```json
{
  "type": "cursor_approval_request",
  "kind": "shell|mcp|tool",
  "session_id": "...",
  "cwd": "/path",
  "tool": "Shell",
  "command": "git status -uno",
  "payload": {},
  "permission_mode": "...",
  "hook_event_name": "beforeShellExecution"
}
```

工具名规则：

- `beforeShellExecution` -> `Shell`
- `beforeMCPExecution` -> `mcp__<server>__<tool>`
- `MCP:<name>` -> `mcp__<name>`
- 其他读取 `tool_name/toolName/name/tool/toolType`

命令/路径规则：

- Shell/Bash：`payload.command`
- MCP：`JSON.stringify(arguments)` 或空
- Path-based tools：递归找 `path/file_path/target_file/...`
- `ApplyPatch`：从 patch header 提取 `*** Add File:` / `*** Update File:`
- `MultiEdit`：从 `edits[]` 递归提取路径

### 14.3 ApprovalPolicy

文件：

```text
~/.agent2lark/cursor-approval-policy.json
```

schema：

```jsonc
{
  "rules": [
    {
      "id": "rule_xxx",
      "tool": "Shell",
      "commandPrefix": "pnpm",
      "pathPrefix": "",
      "toolScope": true,
      "decision": "allow",
      "hits": 0,
      "createdAt": 1700000000000,
      "lastUsedAt": 0
    }
  ]
}
```

匹配逻辑：

1. `rule.tool === tool`，否则不匹配。
2. `toolScope === true` 直接匹配该 tool。
3. `pathPrefix` 非空：
   - 如果 command 看起来是绝对路径，检查 command startsWith pathPrefix。
   - 否则检查 cwd 是否在 pathPrefix 内。
4. `commandPrefix` 非空：检查 command startsWith prefix。
5. `commandPrefix` 空不能做 wildcard，只能匹配空 command。

多个规则命中时，按 specificity 排序：

```text
max(pathPrefix.length, commandPrefix.length)
```

最长者胜出。

### 14.4 `/allow!` scope 推断

`inferRuleScope({ tool, command, cwd })`：

MCP：

```js
{ toolScope: true, commandPrefix: "", pathPrefix: "" }
```

Path-based tools：

1. 用 command/path 向上查找项目根。
2. 项目标记：

```text
.git
package.json
pnpm-workspace.yaml
yarn.lock
package-lock.json
pyproject.toml
go.mod
Cargo.toml
```

3. 规则写：

```js
{ pathPrefix: "<project-root>/", commandPrefix: "" }
```

Shell/Bash：

- package managers：`pnpm/npm/yarn/bun` 只记第一个 token。
- 其他命令记前两个 token。

### 14.5 ApprovalRegistry

`ApprovalRegistry` 是内存 pending map，不能持久化。

维护三份索引：

```js
pendings: Map<requestId, entry>
latestByThread: Map<chatId:threadId, requestId>
pendingByChat: Map<chatId, Set<requestId>>
```

方法：

- `request(requestId, { timeoutMs, context, thread })`
- `decide(requestId, value)`
- `decideLatest({ chatId, threadId }, value)`
- `decideOnlyPendingInChat({ chatId }, value)`
- `countPendingInChat({ chatId })`
- `decideMatching({ chatId, tool }, value)`
- `decideCommandPrefix({ chatId, tool, commandPrefix }, value)`

每个 pending 必须有 timer。超时返回：

```json
{ "decision": "ask", "reason": "timeout" }
```

settle 时必须：

- 清 timer。
- 删除 `pendings[requestId]`。
- 删除 `latestByThread` 中对应项。
- 从 `pendingByChat` 移除 request id。

### 14.6 文本审批模式

默认模式：

```text
AGENT2LARK_APPROVAL_MODE=text
```

bridge 用 `lark.sendApprovalPrompt` 发送 markdown：

```text
🔒 Cursor approval required

Tool: `Shell`
Command: `git status -uno`

Reply in this thread (@-mention the bot):
- `/allow`  approve once
- `/deny`   deny once
- `/allow!` approve & remember (...)
- `/deny!`  deny & remember
- `/allow pnpm!` ...
```

用户回复命令：

```text
/allow
/deny
/allow!
/deny!
/allow <request_id>
/deny <request_id>
/allow pnpm!
/allow shell node!
/allow shell!
/allow write!
/allow read!
/allow mcp__server__tool!
```

解析规则：

```js
/(?:^|\s)\/(?:cursor[:\s]+)?(allow|deny)(!)?(?:\s+(.+?))?\s*$/i
```

命令必须位于消息末尾，避免普通聊天误触。

### 14.7 Card 模式

可选：

```text
AGENT2LARK_APPROVAL_MODE=card
```

发送 interactive card：

- Approve
- Approve & remember
- Deny
- Deny & remember

按钮 value：

```json
{ "req": "<requestId>", "decision": "allow", "remember": true }
```

注意：

- Feishu app 必须订阅 `card.action.trigger`。
- 当前项目不实现 card click ack/update API，所以 Feishu UI 可能显示 200340。
- Text 模式更稳定，应作为默认。

## 15. Lark CLI Adapter

`lark-cli-command.js`：

优先级：

1. `options.command`
2. `process.env.LARK_CLI_COMMAND`
3. `PROJECT_ROOT/node_modules/.bin/lark-cli`（Windows 用 `.cmd`）

`createLarkCliAdapter` 方法：

### 15.1 `getMessageThreadId(messageId)`

```bash
lark-cli im +messages-mget \
  --message-ids <messageId> \
  --format json \
  --as bot
```

解析：

```text
data.messages[0].thread_id
messages[0].thread_id
root_id
```

失败时返回空字符串。

### 15.2 `sendThreadMessage`

```bash
lark-cli im +messages-reply \
  --message-id <replyMessageId || threadId> \
  --markdown <text> \
  --reply-in-thread \
  --as bot
```

如果 `format === "text"`，使用 `--text`。

### 15.3 `addReaction`

```bash
lark-cli im reactions create \
  --params '{"message_id":"om_xxx"}' \
  --data '{"reaction_type":{"emoji_type":"EYES"}}' \
  --as bot
```

### 15.4 `sendApprovalPrompt`

```bash
lark-cli im +messages-reply \
  --message-id <replyMessageId || threadId> \
  --markdown <approval markdown> \
  --reply-in-thread \
  --as bot
```

### 15.5 `sendApprovalCard`

```bash
lark-cli im +messages-reply \
  --message-id <replyMessageId || threadId> \
  --msg-type interactive \
  --content '<card-json>' \
  --reply-in-thread \
  --as bot
```

## 16. Lark Listener 命令面

`lark-listener.js` 需要支持：

| 命令 | 说明 |
| --- | --- |
| `bind chat` | 创建 IDE Chat Relay bind code |
| `绑定对话` | `bind chat` 中文兼容 |
| `unbind` / `un bind` | 解除当前 thread binding |
| `解绑` / `解除绑定` | unbind 中文兼容 |
| `/help` / `help` / `帮助` | 发送帮助 |
| `stop wait` / `disable wait` / `pause wait` | 关闭等待循环 |
| `停止等待` / `关闭等待` | wait 中文兼容 |
| `create cursor agent` | 内部 official agent binding |
| `创建 Cursor Agent 对话` | 内部兼容命令 |
| `/allow...` / `/deny...` | 审批决策 |

命令识别建议：

- `bind chat`、`stop wait`、`unbind` 等要求 bot mention。
- `/allow`、`/deny` 不强制 mention，因为用户常在审批 thread 里直接回复。
- `/help` 可以直接用，也可以 mention。

## 17. lark-config 与启动向导

### 17.1 `checkLarkCliConfig`

执行：

```bash
lark-cli config show
```

解析第一段 JSON。

如果没有 `appId` 或命令失败：

```js
{ configured: false, initCommand: "<lark-cli> config init --new" }
```

否则：

```js
{
  configured: true,
  appId,
  brand,
  profile,
  users
}
```

### 17.2 `createCursorConversationChat`

```bash
lark-cli im +chat-create \
  --name "Cursor Conversation" \
  --bots <appId> \
  --format json \
  --as user
```

必须返回 `chat_id`。

### 17.3 `addBotToChat`

```bash
lark-cli im chat.members create \
  --params '{"chat_id":"oc_xxx","member_id_type":"app_id"}' \
  --data '{"id_list":["cli_xxx"]}' \
  --format json \
  --as user
```

失败时错误信息必须包含：

```text
Required app scopes: im:chat and im:chat.members:write_only.
The authorized user must be in the target group and allowed to invite members.
After changing scopes in Feishu/Lark Developer Console, publish the app change and rerun lark-cli config init --new if needed.
```

### 17.4 `start-relay` wizard

流程：

1. 打印 `agent2lark-cursor relay setup wizard`。
2. 检查 lark-cli config。
3. 确保 `~/.agent2lark/config.json` 存在。
4. 安装 Cursor relay hooks。
5. 启动 bridge 和 lark-listen 后台进程。
6. 询问复用已有群还是新建群。
7. 复用已有群：
   - 输入 `chat_id`。
   - 调用 `addBotToChat`。
8. 新建群：
   - 输入群名，默认 `Cursor Conversation`。
   - 调用 `createCursorConversationChat`。
9. 打印 binding guide。

## 18. Relay Supervisor

`relay-supervisor.js` 负责后台进程。

runtime 文件：

```text
~/.agent2lark/cursor-relay-runtime.json
```

schema：

```jsonc
{
  "processes": {
    "bridge": {
      "pid": 123,
      "command": "/path/to/node",
      "args": ["bridge", "--lark-cli"],
      "logFile": ".../bridge.out.log",
      "errFile": ".../bridge.err.log",
      "startedAt": 1700000000000
    },
    "lark-listen": {
      "pid": 124,
      "command": "/path/to/node",
      "args": ["lark-listen"],
      "logFile": ".../lark-listen.out.log",
      "errFile": ".../lark-listen.err.log",
      "startedAt": 1700000000000
    }
  }
}
```

启动：

- 如果 runtime 中已有 pid 且存活，reuse。
- 否则 `spawn(process.execPath, [bin/agent2lark-cursor.js, ...args])`。
- `detached: true`
- stdout/stderr append 到 logs。
- `child.unref()`。

停止：

1. 收集 runtime 中 pid。
2. 对每个 pid：
   - `process.kill(-pid, "SIGTERM")`
   - `process.kill(pid, "SIGTERM")`
3. 等 600ms。
4. 仍存活则：
   - `process.kill(-pid, "SIGKILL")`
   - `process.kill(pid, "SIGKILL")`
5. 删除 runtime 文件。

这样能避免 orphaned `lark-cli event +subscribe` 继续持有 lock。

## 19. Runtime Config

`runtime-config.js` 管理：

```json
{
  "thinkingIntervalMs": 60000,
  "progressRelayEnabled": true
}
```

优先级：

```text
env var > config file > built-in default
```

环境变量：

```text
AGENT2LARK_THINKING_INTERVAL_MS
AGENT2LARK_PROGRESS_RELAY
```

布尔值支持：

```text
true: 1, true, yes, on, enabled
false: 0, false, no, off, disabled
```

`ensureRuntimeConfigFile`：

- 文件存在：返回 `false`。
- 文件不存在：创建目录，写入默认 JSON，返回 `true`。

## 20. CLI 命令

`cli.js` 需要实现：

```text
agent2lark-cursor install [--events ...] [--fail-closed] [--relay]
agent2lark-cursor uninstall [--events ...]
agent2lark-cursor bridge [--lark-cli] [--socket-path ...] [--state-path ...]
agent2lark-cursor lark-listen [--echo-message-id] [--socket-path ...]
agent2lark-cursor start
agent2lark-cursor status-relay
agent2lark-cursor stop-relay
agent2lark-cursor restart-relay
agent2lark-cursor relay-bind --chat-id oc_xxx --thread-id omt_xxx [--reply-message-id om_xxx] [--code abc123]
agent2lark-cursor relay-send --chat-id oc_xxx --thread-id omt_xxx --text "message"
agent2lark-cursor doctor
```

### 20.1 `install`

调用：

```js
installCursorHooks(options)
```

输出 hooks path 和 events。

### 20.2 `bridge`

启动 `startBridgeServer`。

如果 `--lark-cli`，使用真实 `createLarkCliAdapter()`；否则用 console adapter。

启动后：

```js
await new Promise(() => {})
```

保持进程不退出。

### 20.3 `lark-listen`

启动 `startLarkEventListener`，可传 `echoMessageId`。

保持进程不退出。

### 20.4 `restart-relay`

1. `stopRelayProcesses()`
2. sleep 500ms
3. `startRelayProcesses()`
4. 尝试连接 bridge socket，最多 5 秒。
5. 输出：

```json
{
  "stopped": [],
  "started": [],
  "reused": [],
  "bridge_ready": true,
  "processes": {
    "bridge": { "pid": 1, "logFile": "...", "errFile": "..." }
  }
}
```

### 20.5 `relay-bind`

发送 `lark_create_bind` 给 bridge，便于调试。

### 20.6 `relay-send`

发送 `lark_message` 给 bridge，便于本地模拟飞书消息。

### 20.7 `doctor`

返回：

```json
{
  "node": "v22.x",
  "cursorDir": "~/.cursor",
  "hooksPath": "~/.cursor/hooks.json",
  "hookBinPath": "...",
  "hookBinExists": true,
  "bridgeBinPath": "...",
  "bridgeBinExists": true,
  "bridgeSocketPath": "...",
  "bridgeSocketExists": true,
  "larkCliCommand": ".../node_modules/.bin/lark-cli",
  "relayStatePath": "...",
  "approvalPolicyPath": "..."
}
```

## 21. 内部 Official Agent Relay

当前公开 README 不重点暴露这个能力，但代码里存在：

- `SessionStore.createAgentBinding`
- `SessionStore.updateAgentBinding`
- `bridge-server` 的 `lark_create_agent_bind`
- `cursor-runner.js`
- `lark-listener` 的 `create cursor agent` 命令

实现语义：

1. 飞书 thread 发 `create cursor agent`。
2. listener 发送 `lark_create_agent_bind`。
3. bridge 在该 thread 创建 `mode: "official_agent"` binding。
4. 后续 `lark_message` 如果命中 official agent binding：
   - ack 飞书消息。
   - 启动 thinking heartbeat，key 使用 `oa:<chat>:<thread>:<message>`.
   - 调用 `cursorRunner.runPrompt({ cwd, prompt, agentSessionId })`。
   - 保存新的 `agentSessionId`。
   - 把 runner 输出发回飞书。

`cursor-runner.js` 优先使用 `@cursor/sdk`：

```js
const agent = agentSessionId ? Agent.resume(agentSessionId) : Agent.create({ local: { cwd } })
const response = agent.send(prompt) or agent.run(prompt)
```

如果 SDK 不存在，fallback 到 CLI：

```bash
cursor-agent -p <prompt> [--resume <agentSessionId>] --force
```

`CURSOR_AGENT_COMMAND` 可覆盖 CLI 名称。

如果产品决定不对外提供此能力，可以保留内部代码但不要在 README 中宣传。

## 22. 错误处理与失败模式

### 22.1 bridge 不存在

relay hook：

- `beforeSubmitPrompt` fallback `{continue:true}`
- 其他 relay events fallback `{}`

approval hook：

```json
{
  "permission": "ask",
  "user_message": "agent2lark-cursor bridge is not running. Please review this action locally."
}
```

### 22.2 Lark listener 断线

表现：

- 飞书消息不再进入 `lark-listen.out.log`。
- bridge 里没有 `enqueued_lark_message`。

处理：

- `lark-listener` child exit 后 respawn。
- `stop-relay` 必须杀整个 process group，避免 orphan `lark-cli` 抢事件。

### 22.3 thread id 不一致

飞书可能混用：

- root message id: `om_*`
- canonical thread id: `omt_*`

处理：

- 先 exact match。
- 单 chat 单 binding fallback。
- 多 binding 时用 `lark-cli im +messages-mget` 对 binding root/reply message 反查 canonical id。

### 22.4 审批找不到 pending

可能原因：

- request id 错误。
- `/allow` 所在 thread id 与 pending thread id 不一致。
- 同一 chat 有多个 pending，无法猜测。

处理：

- 有 request id 时直接 `decide(requestId)`。
- 无 request id 时先 `decideLatest(chat, thread)`。
- 如果失败且 chat 只有一个 pending，则 `decideOnlyPendingInChat`。
- 如果 chat 多 pending，返回 `multiple_pending`，提示用户加 request id 或 scoped command。

### 22.5 wait loop 不启动

原因：

- bind 被 `beforeSubmitPrompt` 拦截，不会自己产生 Agent turn。
- 当前 Chat 不是 Agent mode。
- `stop` hook 未安装或未触发。
- wait 被 `stop wait` 关闭。

处理：

- 用户在绑定后的 Cursor Chat 中发送一个最小 turn，触发 `stop`。
- `doctor` 检查 hooks/socket。
- 检查 state 中 binding 和 queue。

### 22.6 approval card UI 200340

原因：

- `card.action.trigger` 未订阅。
- WebSocket 模式下未对 card click 及时 ack/update。

处理：

- 默认使用 text approval。
- card mode 仅 opt-in。

## 23. 安全与隐私

必须遵守：

- 不读取或打印 lark app secret。
- 不把 `.env`、token、credential 文件写入 git。
- progress relay 不发送完整 stdout/stderr。
- approval prompt 只显示工具名、命令首行或截断内容。
- bridge socket 只放本机用户目录。
- policy 文件只记录审批规则，不记录完整 payload。
- lark-cli app config 由 `lark-cli` 自己管理。

敏感信息脱敏：

```js
/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|API_KEY|ACCESS_KEY)[A-Z0-9_]*)=([^\s]+)/gi
```

替换为：

```text
NAME=[redacted]
```

## 24. 测试矩阵

用 Node 内置 test。

### 24.1 Unit tests

`approval-policy.test.js`

- 无规则返回 undefined。
- command prefix 命中并更新 hits。
- longest prefix 优先。
- 空 prefix 不做 wildcard。
- pathPrefix 覆盖项目目录。
- toolScope 覆盖整个 tool。
- remove rule。
- 持久化。

`bridge-client.test.js`

- socket 超时应 reject，不能静默成功。
- JSON line response 正常解析。

`hook.test.js`

- bridge response 转 Cursor hook output。
- stop timeout 使用 wait poll + 5000。
- approval timeout 使用 approval timeout + 5000。
- allow/deny/ask 输出格式。

`normalize.test.js` / `relay-normalize.test.js`

- 每个 Cursor hook event 转正确 bridge message。
- Shell/MCP/tool input 正确提取。
- low-risk tool 自动 allow。
- path-based tool 识别。
- ApplyPatch/MultiEdit 路径提取。
- progress hooks 转 `cursor_progress`。

`lark-adapter.test.js`

- compact event -> bridge message。
- JSON content unwrap。
- `<at>` markup strip。
- sendThreadMessage 生成正确 CLI args。
- sendApprovalPrompt/Card 生成正确 CLI args。
- getMessageThreadId 解析 mget。

`lark-listener.test.js`

- `bind chat` 创建 bind 并回复 message_id。
- `/help` 回复帮助。
- `unbind` 发送解绑 message。
- `stop wait` 发送 disable wait。
- `/allow` grammar。
- `/allow!`、`/allow shell!`、`/allow pnpm!`、MCP scoped command。
- card action trigger 转 approval decision。
- child exit respawn。
- malformed event ignore。

`bridge-server.test.js`

- bind code flow。
- wait loop dequeue/heartbeat。
- ack inbound Lark message。
- response back to Lark。
- progress relay。
- approval policy cached decision。
- text approval prompt -> decision resolve。
- card mode decision resolve。
- approval timeout。
- canonical thread id fallback。
- unbind。
- official agent path。

`session-store.test.js`

- pending bind -> binding。
- dequeue only once。
- list bindings by chat。
- expired bind rejected。
- unbind clears queues。
- official agent binding clears IDE binding。

`relay-supervisor.test.js`

- start two background specs。
- reuse alive process。
- log file path。
- stop process group。
- SIGKILL escalation。

`runtime-config.test.js`

- config file values。
- env override。
- default file creation。
- boolean parse。

`start-wizard.test.js`

- existing chat flow。
- bot invite called。
- new chat flow。
- empty chat id rejected。
- lark-cli unconfigured exits before mutation。

### 24.2 Integration-ish tests

不需要真实 Cursor 或真实 Lark。

用 fake store、fake lark adapter、fake runner、fake spawn、fake execFile 覆盖：

- `handleBridgeMessage` 端到端。
- listener 事件行端到端。
- hook stdout JSON。
- supervisor process lifecycle。

## 25. 从零实现顺序

建议按以下顺序实现，每一步都写测试。

### Phase 1: 项目骨架

1. 创建 ESM package。
2. 添加 bin scripts。
3. 添加 constants。
4. 添加 io helpers。
5. 配置 `pnpm test`。

验收：

```bash
pnpm test
node ./bin/agent2lark-cursor.js help
```

### Phase 2: bridge socket

1. 实现 `bridge-client.js`。
2. 实现 `startBridgeServer` 最小版本。
3. 支持 JSON-line request/response。
4. 支持 unknown type error。

验收：

- socket client 可以发送消息并收到 JSON。
- timeout reject。

### Phase 3: SessionStore

1. 实现 state 文件读写。
2. 实现 pending bind。
3. 实现 bind 双向索引。
4. 实现 queue enqueue/dequeue。
5. 实现 unbind。

验收：

- session-store tests 全通过。

### Phase 4: Cursor hook normalization

1. 实现 event name extraction。
2. 实现 session/cwd extraction。
3. 实现 relay message mapping。
4. 实现 approval request mapping。
5. 实现 risky tool detection。

验收：

- normalize tests 全通过。

### Phase 5: hook entrypoint

1. 读取 stdin。
2. parse JSON。
3. 判断 relay vs approval。
4. bridge 不存在 fallback。
5. bridge timeout。
6. Cursor output mapping。

验收：

- hook tests 全通过。

### Phase 6: IDE Chat Relay

1. `cursor_session_start` 注册 session。
2. `lark_create_bind` 创建 pending bind。
3. `cursor_prompt_submit` 解析 bind。
4. `lark_message` 入队。
5. `cursor_stop` 长轮询和 followup。
6. `cursor_agent_response` 发回 Lark。
7. wait heartbeat suppress。

验收：

- bridge-server relay tests 全通过。

### Phase 7: Lark adapter

1. console adapter 便于测试。
2. bundled lark-cli resolver。
3. CLI adapter sendThreadMessage。
4. addReaction。
5. getMessageThreadId。
6. event normalization。

验收：

- lark-adapter tests 全通过。

### Phase 8: Lark listener

1. spawn lark-cli event subscribe。
2. stdout line buffer。
3. command matching。
4. bind/help/unbind/stop wait。
5. approval command matching。
6. child respawn。

验收：

- lark-listener tests 全通过。

### Phase 9: Remote approval

1. ApprovalRegistry。
2. ApprovalPolicy。
3. cached decision fast path。
4. text prompt。
5. decision resolve。
6. remember scope inference。
7. scoped approval commands。
8. approval timeout。

验收：

- approval and bridge approval tests 全通过。

### Phase 10: Hooks installer

1. read/write `~/.cursor/hooks.json`。
2. remove old entries by marker。
3. install default approval hooks。
4. install relay hooks with `--relay`。
5. preToolUse matcher。
6. stop loop limit。
7. doctor。

验收：

- installer tests 全通过。

### Phase 11: supervisor and wizard

1. relay runtime file。
2. start background bridge/listener。
3. status。
4. stop with group kill + SIGKILL。
5. lark-cli config check。
6. create/reuse chat。
7. bot invite。
8. print binding guide。

验收：

- relay-supervisor, lark-config, start-wizard tests 全通过。

### Phase 12: runtime config and heartbeat

1. config defaults。
2. env override。
3. ThinkingHeartbeat。
4. bridge integration。
5. progress relay with redact。

验收：

- runtime-config and thinking-heartbeat tests 全通过。

### Phase 13: docs and packaging

1. README English。
2. README Chinese。
3. ARCHITECTURE。
4. LICENSE。
5. `files` package list。
6. CI。

验收：

```bash
pnpm test
npm pack --dry-run
```

## 26. Definition of Done

项目完成标准：

- `pnpm test` 全通过。
- `pnpm run doctor` 返回 hook/bin/socket/config 可诊断信息。
- `pnpm run start-relay` 可完成向导。
- 复用已有 Lark 群时会邀请 bot。
- `bind chat` -> Cursor bind -> Lark message -> Cursor followup -> Lark reply 主链路可跑。
- risky Shell/Write/MCP approval 可通过 `/allow` 解除。
- `/allow!` 可生成 policy 并让后续相同范围自动通过。
- `stop-relay` 不留下 orphan `lark-cli event`。
- README 和架构文档覆盖安装、绑定、审批、故障排查、限制。

## 27. 常见调试命令

```bash
pnpm run status-relay
pnpm run restart-relay
pnpm run doctor
pnpm test
```

查看日志：

```bash
tail -f ~/.agent2lark/logs/bridge.out.log
tail -f ~/.agent2lark/logs/lark-listen.out.log
tail -f ~/.agent2lark/logs/lark-listen.err.log
```

查看 socket：

```bash
lsof -U | rg cursor-relay.sock
```

模拟创建 bind：

```bash
pnpm exec agent2lark-cursor relay-bind \
  --chat-id oc_xxx \
  --thread-id om_xxx \
  --reply-message-id om_xxx \
  --code test-code
```

模拟 Lark 消息：

```bash
pnpm exec agent2lark-cursor relay-send \
  --chat-id oc_xxx \
  --thread-id om_xxx \
  --message-id local-1 \
  --text "hello from lark"
```

开启原始 Lark 事件日志：

```bash
AGENT2LARK_LOG_RAW_EVENTS=1 pnpm run restart-relay
```

## 28. Agent 实现注意事项

给从零实现的 Agent：

- 先写测试再写实现，特别是 bridge flow 和 approval flow。
- 不要一次性实现所有命令；按 Phase 顺序推进。
- 不要把真实飞书 ID、用户姓名、公司域名写进测试快照。
- 测试中用 fake `runCommand`，不要真实调用 lark-cli。
- bridge server 和 listener 都要支持依赖注入，便于测试。
- 任何长等待都要可配置 timeout，并在测试中设置很小的时间。
- 不要用字符串拼接解析 JSON；使用 `JSON.parse`。
- 处理 Lark text 时必须兼容 JSON-string content 与 `<at>` markup。
- 处理 Cursor hook payload 时要兼容 snake_case 和 camelCase。
- 所有本地状态文件都要 JSON pretty print，便于用户手动排查。
