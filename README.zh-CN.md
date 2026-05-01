# agent2lark-cursor

[English](README.md) | [中文](README.zh-CN.md)

[![CI](https://github.com/sherlockfeng/lark2cursor/actions/workflows/ci.yml/badge.svg)](https://github.com/sherlockfeng/lark2cursor/actions/workflows/ci.yml)

把飞书 / Lark 话题和 Cursor IDE 连接起来，支持双向对话、后台 Agent 调用和远程工具审批，不依赖 UI 自动化。

`agent2lark-cursor` 基于 Cursor public hooks 和 [`lark-cli`](https://www.npmjs.com/package/@larksuite/cli) 实现本地桥接服务。它主要提供两类能力：

1. **IDE Chat Relay**：把某个飞书话题绑定到一个已经打开的 Cursor IDE Agent Chat。飞书消息会作为下一条用户输入进入 Cursor Chat，Cursor 的回复会发回同一个飞书话题。
2. **远程工具审批**：当 Cursor 要执行高风险操作（Shell、写文件、MCP 工具等）时，桥接服务会把审批请求发到绑定的飞书话题。你可以在飞书里回复 `/allow`、`/deny`、`/allow!` 等命令完成审批。

架构、协议和状态文件细节见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

## 工作原理

Cursor 会在固定生命周期调用 hooks，例如：

- `sessionStart`
- `beforeSubmitPrompt`
- `afterAgentResponse`
- `stop`
- `preToolUse`
- `beforeShellExecution`
- `beforeMCPExecution`
- `postToolUse`
- `postToolUseFailure`
- `afterShellExecution`

本项目安装这些 hook 后，hook 脚本会把事件通过本地 UNIX socket 发给桥接服务：

```text
Cursor hook -> ~/.agent2lark/cursor-relay.sock -> bridge-server -> lark-cli -> 飞书话题
```

飞书侧由 `lark-cli event +subscribe` 监听消息事件：

```text
飞书消息 -> lark-listen -> bridge-server -> Cursor followup_message
```

这里没有 DOM 抓取、没有模拟鼠标键盘、也没有逆向 Cursor 内部 IPC。

## 适用场景

- 你在 Cursor 里开发，希望飞书里能远程继续同一个 Agent Chat。
- Cursor 要执行命令或改文件时，你希望在飞书里审批。
- 希望团队成员能通过飞书话题查看 Agent 最终回复和安全的进度摘要。

## 前置要求

- Node.js `>=20.12.0`
- `pnpm`
- 已启用 hooks 的 Cursor IDE
- [`@larksuite/cli`](https://www.npmjs.com/package/@larksuite/cli) 已作为本项目依赖内置；你只需要为自己的飞书 / Lark 应用完成一次配置
- 一个飞书 / Lark 自建应用，开启机器人能力，并至少具备以下权限：
  - `im:message:receive_as_bot`
  - `im:message:send_as_bot`
  - `im:chat`
  - `im:chat:create`
  - `im:chat:create_by_user`
  - `im:chat.members:write_only`
- 飞书应用订阅长连接事件：
  - `im.message.receive_v1`

初始化检查：

```bash
pnpm install
pnpm test
pnpm run doctor
```

## 快速开始

推荐直接运行交互式向导：

```bash
pnpm run start-relay
```

向导会完成这些事情：

1. 读取内置 `lark-cli` 的当前应用配置。如果还没配置，会输出需要运行的 `lark-cli config init --new` 命令。
2. 安装 Cursor hooks 到 `~/.cursor/hooks.json`。
3. 后台启动 `bridge --lark-cli` 和 `lark-listen`。
4. 询问复用已有飞书群，还是创建默认的 "Cursor Conversation" 群，并确保当前机器人已在群内。
5. 输出 IDE Chat Relay 绑定说明。

管理后台进程：

```bash
pnpm run status-relay
pnpm run stop-relay
pnpm run restart-relay
```

修改源码或 `~/.agent2lark/config.json` 后，使用：

```bash
pnpm run restart-relay
```

它会重新启动 bridge 和 lark-listen，让新代码生效。

默认情况下，relay 使用依赖内置的 `node_modules/.bin/lark-cli`。如果你确实想使用单独安装的 CLI，可以设置 `LARK_CLI_COMMAND=/path/to/lark-cli` 覆盖。

## IDE Chat Relay

适合你正在使用 Cursor IDE，希望飞书消息进入某个具体 Cursor Chat，并保留 Cursor UI 里的上下文历史。

### 绑定步骤

在飞书目标话题里 @ 机器人：

```text
@bot bind chat
```

机器人会回复：

```text
message_id: om_xxx
```

然后在目标 Cursor IDE Agent Chat 中输入：

```text
bind lark thread message_id: om_xxx
```

绑定命令会被 hook 拦截，不会发送给模型。看到绑定成功提示后，
还需要在同一个 Cursor Chat 中发送下面这段精确的等待循环启动消息：

```text
AGENT2LARK_WAITING_FOR_LARK
Please reply with only: AGENT2LARK_WAITING_FOR_LARK
Do not invoke any tools and do not send a business reply to Lark.
```

这段消息会要求模型只回固定哨兵字符串，不应该读文件或调用工具。
这一轮结束时会触发 Cursor 的 `stop` hook，之后飞书消息才会被 bridge
拉进这个 Cursor Chat。否则飞书消息可能已经进入 bridge 队列，但 idle
的 Cursor Chat 没有 hook 连接去取它。

兼容中文旧命令：

```text
@bot 绑定对话
```

Cursor Chat 中也仍可使用：

```text
绑定飞书话题 message_id: om_xxx
```

### 持续等待循环

绑定后需要先在 Cursor Chat 里发送一条短消息启动连续等待循环。启动后流程是：

1. Cursor 完成一轮回复。
2. `stop` hook 触发。
3. bridge 长轮询飞书消息队列，默认最多等 10 分钟。
4. 如果飞书有新消息，bridge 返回 `followup_message`，Cursor 自动继续下一轮。
5. 如果没有消息，bridge 返回内部保活消息 `AGENT2LARK_WAITING_FOR_LARK`，让 Chat 继续等待。

这个内部保活不会发送回飞书。

如果想停止等待循环，在同一个飞书话题里发送：

```text
@bot stop wait
```

也支持：

```text
@bot disable wait
@bot pause wait
@bot 停止等待
@bot 关闭等待
```

### 思考心跳

Agent 正在工作时，bridge 会按 `thinkingIntervalMs` 发送：

```text
🤔 Thinking… (60s)
```

配置位置：

```json
{
  "thinkingIntervalMs": 60000
}
```

文件路径：

```text
~/.agent2lark/config.json
```

设置为 `0` 可关闭。也可以临时用环境变量覆盖：

```bash
AGENT2LARK_THINKING_INTERVAL_MS=30000 pnpm run restart-relay
```

### 安全简短进度同步

默认关闭。开启后，bridge 会把 Cursor 工具生命周期同步为一行短消息，例如：

```text
Running: `pnpm test`
Done: `pnpm test` (12s)
Failed: `ApplyPatch`
```

注意：

- 不转发完整 stdout / stderr。
- 不转发完整 tool output。
- 会对常见 `TOKEN`、`SECRET`、`PASSWORD`、`API_KEY` 等环境变量片段做简单脱敏。
- 每条进度摘要都会重置思考心跳计时；只有进度摘要超过 `thinkingIntervalMs` 没有更新时，才会再发 `🤔 Thinking…`。

默认不会同步工具调用生命周期，只同步助手在 Cursor Chat 里输出的文字回复。
如需打开这种一行式工具进度摘要，可以配置：

```json
{
  "progressRelayEnabled": true
}
```

或临时环境变量：

```bash
AGENT2LARK_PROGRESS_RELAY=1 pnpm run restart-relay
```

### IDE Chat Relay 限制

- Cursor IDE 和绑定的 Chat 必须保持可用。
- public hooks 不能主动唤醒已经完全 idle 或关闭的 Cursor Chat。
- 连续等待循环会占用一个 Chat，并消耗少量模型 token。
- 一条飞书话题只能绑定一个 Cursor Chat，一个 Cursor Chat 也只能绑定一条飞书话题。

## 远程工具审批

当 Cursor 要执行高风险操作时，bridge 会在绑定话题中发送审批请求：

```text
🔒 Cursor approval required

Tool: Shell
Command: git push --force

Reply in this thread:
- /allow
- /deny
- /allow!
- /deny!
```

### 基础命令

```text
/allow
/deny
/allow <request_id>
/deny <request_id>
```

不带 request id 时，会尝试审批当前话题里最新的 pending 请求。

### 记住规则

带 `!` 的命令会持久化规则：

```text
/allow!
/deny!
```

规则保存到：

```text
~/.agent2lark/cursor-approval-policy.json
```

### 常用显式 scope

```text
/allow pnpm!
/allow npm!
/allow yarn!
/allow bun!
/allow shell node!
/allow shell!
/allow write!
/allow read!
/allow edit!
/allow mcp__server__tool!
```

规则粒度：

- 文件类工具（`Write`、`Edit`、`Delete`、`ApplyPatch`、`MultiEdit`）：按 `工具 + 项目根目录` 记住。
- Shell：包管理器命令按首 token 记住，例如 `pnpm`；其他命令默认按前两个 token 记住。
- MCP：按完整 MCP 工具名记住，例如 `mcp__user-Playwright__open_page`。

项目根目录会从目标文件路径向上寻找 `.git`、`package.json`、`pnpm-workspace.yaml`、`pyproject.toml` 等标记推断，不使用 hook 进程当前工作目录作为主要依据。

### 文本审批与卡片审批

默认是文本审批，最稳定：

```bash
AGENT2LARK_APPROVAL_MODE=text
```

也支持实验性的卡片模式：

```bash
AGENT2LARK_APPROVAL_MODE=card
```

卡片模式需要飞书应用额外订阅 `card.action.trigger`，并且后续还需要完善卡片点击 ack 路径。因此当前推荐使用文本审批。

## 飞书命令

在飞书话题中 @ 机器人：

```text
@bot bind chat
@bot stop wait
@bot unbind
@bot /help
```

说明：

- `bind chat`：创建 IDE Chat Relay 绑定码。
- `stop wait`：停止 IDE Chat Relay 的连续等待循环。
- `unbind` / `un bind`：解绑当前飞书话题。
- `/help`：输出命令帮助。

中文别名仍可使用：

```text
绑定对话
停止等待
关闭等待
解除绑定
解绑
帮助
```

## 本地 dry-run

不接入飞书也可以本地模拟：

```bash
# Terminal 1
pnpm run bridge

# Terminal 2：创建绑定码
node ./bin/agent2lark-cursor.js relay-bind \
  --chat-id oc_demo \
  --thread-id omt_demo \
  --code abc123

# Cursor Chat 中输入
bind lark thread message_id: abc123

# Terminal 2：模拟飞书消息
node ./bin/agent2lark-cursor.js relay-send \
  --chat-id oc_demo \
  --thread-id omt_demo \
  --text "请继续处理这个任务"
```

下一次 Cursor Chat 触发 `stop` hook 时，会把这条消息作为 `followup_message` 拉进 Chat。

## 常用命令

```bash
# 测试
pnpm test

# 检查 hook / socket / bridge 状态
pnpm run doctor

# 推荐：交互式启动
pnpm run start-relay

# 管理后台进程
pnpm run status-relay
pnpm run stop-relay
pnpm run restart-relay

# 安装 / 卸载 hooks
pnpm run install-hooks
pnpm run install-relay-hooks
pnpm run uninstall-hooks

# 前台运行 bridge
pnpm run bridge
pnpm run bridge:lark

# 前台运行飞书监听器
pnpm run lark-listen
pnpm run lark-listen:debug
```

## 配置项

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `AGENT2LARK_BRIDGE_SOCKET` | `~/.agent2lark/cursor-relay.sock` | bridge UNIX socket 路径 |
| `AGENT2LARK_BRIDGE_TIMEOUT_MS` | `30000` | hook 调 bridge 的默认超时 |
| `AGENT2LARK_WAIT_POLL_MS` | `600000` | `stop` hook 每轮最长等待时间 |
| `AGENT2LARK_WAIT_INTERVAL_MS` | `1000` | bridge 检查队列的间隔 |
| `AGENT2LARK_APPROVAL_MODE` | `text` | 审批模式：`text` 或 `card` |
| `AGENT2LARK_APPROVAL_TIMEOUT_MS` | `86400000` | 审批等待超时 |
| `AGENT2LARK_APPROVAL_POLICY` | `~/.agent2lark/cursor-approval-policy.json` | 审批规则文件路径 |
| `AGENT2LARK_THINKING_INTERVAL_MS` | unset | 覆盖 `thinkingIntervalMs` |
| `AGENT2LARK_PROGRESS_RELAY` | unset | 覆盖 `progressRelayEnabled` |
| `LARK_CLI_COMMAND` | 内置 `node_modules/.bin/lark-cli` | 覆盖 Lark CLI 可执行文件 |
| `AGENT2LARK_RELAY_STATE` | `~/.agent2lark/cursor-relay-state.json` | SessionStore 路径 |

运行时配置文件：

```text
~/.agent2lark/config.json
```

示例：

```json
{
  "thinkingIntervalMs": 60000,
  "progressRelayEnabled": false
}
```

## 状态文件

```text
~/.agent2lark/cursor-relay.sock
~/.agent2lark/cursor-relay-state.json
~/.agent2lark/cursor-relay-runtime.json
~/.agent2lark/cursor-approval-policy.json
~/.agent2lark/config.json
~/.agent2lark/logs/bridge.out.log
~/.agent2lark/logs/bridge.err.log
~/.agent2lark/logs/lark-listen.out.log
~/.agent2lark/logs/lark-listen.err.log
```

这些文件都在用户 home 目录下，不应该提交到仓库。

## 排障

| 现象 | 常见原因 | 处理 |
| --- | --- | --- |
| 飞书消息没有进入 Cursor | `lark-listen` 没收到事件或断开 | 查看 `~/.agent2lark/logs/lark-listen.out.log` |
| Cursor Chat 没继续 | Chat 没触发 `stop` hook，或等待循环被关闭 | 在 Agent 模式运行一轮，或重新绑定/恢复等待 |
| 审批一直没有响应 | 绑定不存在、消息不在同一话题、或 request id 不匹配 | 用 `/help` 查看命令，必要时带 request id |
| 反复要求 allow | 规则 scope 太窄或旧规则没命中 | 使用 `/allow pnpm!`、`/allow shell!`、`/allow write!` 等 |
| `lark-cli event +subscribe` 报锁 | 有旧订阅进程残留 | `pnpm run stop-relay` 后再 `pnpm run start-relay` |
| bridge socket 不存在 | bridge 没启动 | `pnpm run start-relay` 或 `pnpm run bridge:lark` |

## 安全说明

- 本项目不会读取或提交飞书 app secret。认证信息由 `lark-cli` 自己管理。
- 不要提交 `.env`、`~/.agent2lark/*`、日志、socket、state 文件。
- 远程审批会让飞书用户影响 Cursor 的工具权限，请只在可信群和可信账号中使用。
- `AGENT2LARK_APPROVAL_MODE=card` 目前是实验能力；默认文本审批更稳定。

## 限制

- public hooks 不能把消息主动注入一个已经完全 idle 或关闭的 Cursor IDE Chat。
- IDE Chat Relay 依赖 Cursor IDE、目标 Chat、bridge 和 lark-listen 同时运行。
- 状态存储是单个 JSON 文件，适合单用户低并发使用。
- 结构化进度摘要来自 hook 生命周期，不是 assistant token 流；无法原样同步 Cursor UI 中所有中间自然语言。

## License

MIT — 见 [`LICENSE`](LICENSE)。
