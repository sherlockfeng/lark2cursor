# agent2lark-cursor

[English](README.md) | [中文](README.zh-CN.md)

[![CI](https://github.com/sherlockfeng/lark2cursor/actions/workflows/ci.yml/badge.svg)](https://github.com/sherlockfeng/lark2cursor/actions/workflows/ci.yml)

Bridge a Feishu / Lark thread with Cursor IDE — bidirectionally and without
UI automation.

`agent2lark-cursor` is a small Node project that wires Cursor's public
hooks (`sessionStart`, `beforeSubmitPrompt`, `afterAgentResponse`,
`stop`, ...) and the [`lark-cli`](https://www.npmjs.com/package/@larksuite/cli)
command-line client into a local bridge daemon. It gives you three
independent capabilities, all pluggable:

1. **IDE Chat Relay** — pin a Feishu thread to an open Cursor IDE Agent
   Chat. Messages from the Feishu thread show up in Cursor as the next
   prompt; Cursor's reply is posted back into the same thread.
2. **Official Agent Relay** — pin a Feishu thread to a programmatic
   [Cursor Agent](https://docs.cursor.com/) session via `@cursor/sdk` or
   the `cursor-agent` CLI. The Cursor IDE never has to be open.
3. **Remote tool approval** — when Cursor wants to run something risky
   (`preToolUse` / `beforeShellExecution` / `beforeMCPExecution`), the
   bridge posts an interactive approval card into the **bound Feishu
   thread** (Approve / Deny / Approve&remember / Deny&remember) and
   blocks until you click. Decisions you ask to remember are persisted
   in `~/.agent2lark/cursor-approval-policy.json` and short-circuit the
   next matching request without bothering you again.

For the architecture, wire protocol, state schema and failure modes see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Why public hooks?

Cursor exposes a stable JSON-stdin/stdout hook contract. Everything in
this project is built on top of those hooks plus `lark-cli`. There is no
reverse-engineered IPC, no DOM scraping, no Cursor SDK monkey-patching.
The trade-offs are documented under [Limitations](#limitations).

## Requirements

- Node.js `>=18`
- `pnpm`
- Cursor IDE with hooks enabled (any recent build)
- Feishu / Lark integrations:
  - [`lark-cli`](https://www.npmjs.com/package/@larksuite/cli) installed
    and configured (`lark-cli config init --new`)
  - A Feishu app with bot capability and these scopes:
    `im:message:receive_as_bot`, `im:message:send_as_bot`
  - The app subscribed to `im.message.receive_v1` over long connection
- (Optional) a Cursor Agent runner if you want Official Agent Relay:
  either install `@cursor/sdk` next to this project, or have
  `cursor-agent` on `$PATH`

```bash
pnpm install
pnpm test
pnpm run doctor
```

## Quick start

```bash
pnpm run start-relay
```

The interactive wizard will:

1. Read the active `lark-cli` app config (it does **not** read or print
   any secret), or guide you to run `lark-cli config init --new` first.
2. Install Cursor hooks for both relay and approval into
   `~/.cursor/hooks.json`.
3. Spawn `bridge --lark-cli` and `lark-listen` in the background as
   detached processes, with stdout/stderr captured to
   `~/.agent2lark/logs/`.
4. Ask for the working directory you want Official Agent Relay to use.
5. Ask whether to reuse an existing Feishu group (`chat_id`) or create a
   new "Cursor Conversation" group with the current bot already invited.
6. Print the binding instructions for the two relay modes.

Manage the background processes with:

```bash
pnpm run status-relay
pnpm run stop-relay
pnpm run restart-relay   # non-interactive: stop + start, no wizard prompts
```

Use `restart-relay` after upgrading the source code or changing
`~/.agent2lark/config.json` (for example `thinkingIntervalMs`) — both
the bridge and `lark-listen` are forked fresh so they pick up the new
behaviour without needing the full `start-relay` wizard.

`stop-relay` SIGTERMs the whole process group, so any `lark-cli event
+subscribe` child is cleaned up too. This avoids "another `event
+subscribe` instance is already running" errors caused by stale orphans
holding `~/.lark-cli/locks/subscribe_cli_*.lock`.

## IDE Chat Relay

Best when you do have Cursor open and want messages to show up in a
specific Chat with full UI history.

In the Feishu group, mention the bot in the thread you want to bind:

```text
@bot bind chat
```

The bot replies to that thread with:

```text
message_id: om_xxx
```

In the target Cursor IDE Agent Chat, send:

```text
bind lark thread message_id: om_xxx
```

> Legacy zh-CN aliases still work for backward compatibility:
> `@bot 绑定对话` in Feishu and `绑定飞书话题 message_id: om_xxx` in Cursor.

After binding, the Chat enters a **continuous wait loop** by default: at
the end of every Cursor turn, the `stop` hook long-polls the bridge for
new Feishu messages (default 10 minutes per round, see
`AGENT2LARK_WAIT_POLL_MS`). If a message arrives, Cursor automatically
continues with `Lark thread ...:<message>` as its next user prompt. If
nothing arrives within the round, the bridge returns an internal
heartbeat (`AGENT2LARK_WAITING_FOR_LARK`) that keeps the Chat parked
without spamming Feishu — the heartbeat is suppressed before it would be
sent back as an agent response.

While the agent is actively working on a turn (between
`beforeSubmitPrompt` / a real `stop.followup_message` and
`afterAgentResponse`), the bridge posts `🤔 Thinking… (Ns)` into the
bound thread every `thinkingIntervalMs` from `~/.agent2lark/config.json`
(default 60 s; set to `0` to disable). `AGENT2LARK_THINKING_INTERVAL_MS`
can still override it for ad-hoc runs. Cursor's public hooks expose no streaming
introspection, so the heartbeat only confirms "still working", not the
intermediate reasoning.

The relay also mirrors **safe short progress** to the bound thread. It
posts one-line lifecycle messages such as `Running: pnpm test`,
`Done: pnpm test (12s)`, or `Failed: ApplyPatch`, based on Cursor's
tool/shell hooks. Full stdout/stderr and tool outputs are intentionally
not forwarded. Set `progressRelayEnabled` to `false` in
`~/.agent2lark/config.json`, or set `AGENT2LARK_PROGRESS_RELAY=0`, to
turn these progress messages off. Each progress message resets the
thinking timer, so `🤔 Thinking…` is only posted after progress has been
quiet for at least `thinkingIntervalMs`.

To stop the wait loop for that thread, mention the bot in the same
thread:

```text
@bot stop wait
```

Other accepted forms: `disable wait`, `pause wait`, `pause waiting`. The
zh-CN aliases `停止等待` / `关闭等待` are still recognised. The Chat will
return to a normal idle state on the next turn.

Use `@bot /help` or `/help` in the thread to print the current command
reference. Use `@bot unbind` or `@bot un bind` to remove the current
thread's relay binding.

Constraints:

- One Feishu thread can only be bound to one Cursor Chat at a time, and
  vice versa.
- The Chat must remain open for messages to flow in. Cursor's public
  hooks cannot wake an idle window.

## Official Agent Relay

Best when you're away from the computer and want Feishu messages to
trigger work autonomously.

In the Feishu group, mention the bot in the target thread:

```text
@bot create cursor agent
```

(zh-CN alias `@bot 创建 Cursor Agent 对话` still works.)

Use `@bot unbind` in the same thread to remove this binding.

The bridge creates an `official_agent` binding for that thread. From now
on, every `@bot <prompt>` posted in the same thread is handed to
`cursor-runner`, which:

1. Tries `import("@cursor/sdk")` and uses `Agent.create({ local: { cwd }})`
   or `Agent.resume(agentSessionId)` if available.
2. Otherwise falls back to running `cursor-agent -p "<prompt>" [--resume
   <agentSessionId>] --force` in the configured working directory.

The agent's response is posted back to the Feishu thread by `lark-cli im
+messages-reply --reply-in-thread`. The Cursor IDE is not involved at
all in this path — your laptop just needs the bridge process running.

Configure the working directory either through the wizard or via:

```bash
AGENT2LARK_CURSOR_AGENT_CWD=/path/to/project pnpm run bridge:lark
```

## Remote tool approval

Approval is fully self-contained — there is no separate daemon. As long
as a Feishu thread is bound (IDE Chat Relay or Official Agent Relay)
and the bridge is running, Cursor's risky tool calls automatically
post an approval prompt to that thread:

```text
🔒 Cursor approval required

Tool: Shell
Command: git push --force

Reply in this thread (@-mention the bot):
- /allow   approve once
- /deny    deny once
- /allow!  approve & remember (file edits: tool + project path; MCP: exact tool; Shell: command prefix)
- /deny!   deny & remember
- /allow pnpm!        approve & remember all `pnpm ...` Shell commands
- /allow shell node!  approve & remember all `node ...` Shell commands
- /allow shell!       approve & remember all Shell commands
- /allow write!       approve & remember Write actions in the project/path scope
- /allow mcp__server__tool! approve & remember one exact MCP tool
```

Reply with one of the four commands in the same thread. The trailing
`!` form persists the decision as a rule in
`~/.agent2lark/cursor-approval-policy.json`. For path-based tools like
`Write`, `Edit`, `Delete`, and `ApplyPatch`, the rule is scoped to
`tool + project path`, so one `/allow!` for `Write` in
`/Users/bytedance/projects/agent2lark-cursor/` covers later writes in
that project without approving every file. The project path is inferred
from the target file path by walking up to the nearest project marker
such as `.git` or `package.json`, not from Cursor's hook process cwd.
Nested edit payloads and patch payloads are also inspected for a file
path before falling back to the session cwd. MCP approvals are remembered
by exact MCP tool name because their argument JSON is often empty or
volatile. Shell approvals keep a command-prefix scope. Package manager
commands (`pnpm`, `npm`, `yarn`, `bun`) are remembered by the first token
so `/allow!` on `pnpm rebuild sqlite3` also covers `pnpm exec ...`. You
can also make the scope explicit with commands such as `/allow pnpm!`,
`/allow shell node!`, `/allow shell!`, or `/allow mcp__server__tool!`.

If multiple approvals are pending in the same thread you can disambiguate
with the request id printed at the end of the prompt: `/allow req_abc12`.

### Card mode (opt-in)

`AGENT2LARK_APPROVAL_MODE=card` switches the prompt to an interactive
Feishu card with four buttons. **This requires extra setup on your
Feishu app**:

1. In `developer.feishu.cn` event subscriptions, enable
   `card.action.trigger` (卡片回传交互).
2. The bot also has to ack each click within a few seconds via the
   card-update API; this project does not yet ship that ack path.

The card path is therefore best treated as a future enhancement;
text mode is the supported default and uses only the regular
`im.message.receive_v1` subscription that already powers the relay.

Approval-eligible events: `beforeShellExecution`, `beforeMCPExecution`,
and `preToolUse` matching the high-risk pattern
`Shell|Bash|Write|Edit|Delete|ApplyPatch|MultiEdit|MCP:.*|mcp__.*`. Low-risk tool
calls are auto-approved without bothering you.

If no Feishu binding exists for the running session, or no answer
arrives within `AGENT2LARK_APPROVAL_TIMEOUT_MS` (default 24h), the hook
falls back to `permission: "ask"` so Cursor's local confirmation UI
takes over.

To install the approval hooks (already included by `start-relay`):

```bash
pnpm run install-hooks         # approval-only hooks
pnpm run install-relay-hooks   # approval + relay hooks
```

## Local dry-run

Without touching Feishu, you can simulate the relay end-to-end:

```bash
# Terminal 1 — bridge
pnpm run bridge

# Terminal 2 — create a bind code
node ./bin/agent2lark-cursor.js relay-bind \
  --chat-id oc_demo --thread-id omt_demo --code abc123

# In a Cursor Agent Chat
bind lark thread message_id: abc123

# Terminal 2 — pretend a Feishu message arrives
node ./bin/agent2lark-cursor.js relay-send \
  --chat-id oc_demo --thread-id omt_demo --text "请继续处理这个任务"
```

When the Cursor Chat hits its next `stop` hook, it will pick up the
queued message as `followup_message`. The bound terminal-side bridge
(without `--lark-cli`) just prints the agent's response as a JSON line
instead of replying to a real Feishu thread.

## Commands

```bash
# Tests
pnpm test

# Show hook / socket / bridge state
pnpm run doctor

# One-shot interactive setup wizard (recommended)
pnpm run start-relay

# Inspect / stop / restart the background processes started by start-relay
pnpm run status-relay
pnpm run stop-relay
pnpm run restart-relay

# Hook installation
pnpm run install-hooks         # approval hooks
pnpm run install-relay-hooks   # approval + relay hooks
pnpm run uninstall-hooks       # remove every hook this project wrote

# Run the bridge manually (foreground)
pnpm run bridge                # console adapter only — prints replies as JSON
pnpm run bridge:lark           # use lark-cli to actually post replies to Feishu

# Run the listener manually (foreground)
pnpm run lark-listen
pnpm run lark-listen:debug     # also echoes message_id back to Feishu
```

## Configuration

| Env var | Default | Effect |
| --- | --- | --- |
| `AGENT2LARK_BRIDGE_SOCKET` | `~/.agent2lark/cursor-relay.sock` | Relay bridge socket |
| `AGENT2LARK_BRIDGE_TIMEOUT_MS` | `30000` | Default hook → bridge timeout (auto-extended for `stop` and approval) |
| `AGENT2LARK_WAIT_POLL_MS` | `600000` | Max long-poll per `stop` round (IDE Chat Relay) |
| `AGENT2LARK_WAIT_INTERVAL_MS` | `1000` | Bridge queue check interval inside long-poll |
| `AGENT2LARK_APPROVAL_MODE` | `text` | `text` (markdown prompt + `/allow` `/deny` reply) or `card` (interactive card; requires extra Feishu app setup) |
| `AGENT2LARK_APPROVAL_TIMEOUT_MS` | `86400000` | How long the bridge keeps an approval prompt open before falling back to `ask` |
| `AGENT2LARK_APPROVAL_POLICY` | `~/.agent2lark/cursor-approval-policy.json` | Cached approval rules path |
| `AGENT2LARK_THINKING_INTERVAL_MS` | unset | Optional env override for `thinkingIntervalMs` in `~/.agent2lark/config.json` |
| `AGENT2LARK_PROGRESS_RELAY` | unset | Optional env override for `progressRelayEnabled` in `~/.agent2lark/config.json` |
| `AGENT2LARK_CURSOR_AGENT_CWD` | bridge cwd | Working directory for Official Agent Relay |
| `CURSOR_AGENT_COMMAND` | `cursor-agent` | CLI fallback used by Official Agent Relay |
| `AGENT2LARK_RELAY_STATE` | `~/.agent2lark/cursor-relay-state.json` | Override the SessionStore path |

State and runtime files:

```text
~/.agent2lark/cursor-relay.sock              # bridge UNIX socket
~/.agent2lark/cursor-relay-state.json        # persistent SessionStore
~/.agent2lark/cursor-relay-runtime.json      # background-process pids + log paths
~/.agent2lark/cursor-approval-policy.json    # remembered approval rules
~/.agent2lark/config.json                    # runtime config, e.g. thinkingIntervalMs, progressRelayEnabled
~/.agent2lark/logs/bridge.{out,err}.log
~/.agent2lark/logs/lark-listen.{out,err}.log
```

`lark-listen` writes one line per Feishu event:

```text
[lark-listen] event chat=oc_xxx msg=om_yyy
[lark-listen] lark-cli child exited code=N signal=...
[lark-listen] respawning lark-cli child
```

These three lines plus `lsof -U | grep cursor-relay.sock` are usually
enough to localise where a stalled message is stuck.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Feishu message never reaches Cursor Chat | `lark-cli event +subscribe` silently disconnected | tail `~/.agent2lark/logs/lark-listen.out.log` — the listener now respawns child on exit; if it loops with `code=2`, an orphan subscriber holds the lock; run `pnpm run stop-relay` and restart |
| Cursor Chat does not pick up queued messages | The Chat ended a turn but no `stop` hook ran (e.g., Ask-mode), or the wait loop was disabled | run a turn in Agent mode, or send `继续等待飞书消息` to re-enter the loop |
| `stop` hook disconnects after 30 s | Old build before `relayBridgeTimeoutMs` extension | rebuild and restart Cursor; the hook now uses `AGENT2LARK_WAIT_POLL_MS + 5_000` |
| Bridge socket missing | Bridge not running | `pnpm run start-relay` (or `pnpm run bridge:lark` in foreground) |
| Bot cannot reply to thread | Missing `im:message:send_as_bot` scope, or bot is not in the chat | re-check Feishu app permissions and group membership |
| Official Agent never produces output | Neither `@cursor/sdk` nor `cursor-agent` on `$PATH` | install one and set `CURSOR_AGENT_COMMAND` |

## Limitations

- IDE Chat Relay only flows while the Cursor IDE, the bound Chat, the
  bridge and `lark-listen` are all alive. Sleep, IDE quit, or background
  process death will pause the conversation until you bring it back.
- The continuous wait loop ties up one Cursor Chat per bound thread and
  does cost a small steady stream of model tokens. Use `stop wait` to
  release a thread on demand.
- Official Agent Relay depends on a working Cursor Agent runner on the
  machine. The CLI fallback is documented at
  https://docs.cursor.com/cli (binary name configurable via
  `CURSOR_AGENT_COMMAND`).
- `stop.followup_message` runs in a loop with `loop_limit: null`. This
  is what makes the wait loop possible. Only enable relay hooks on
  trusted local environments — anyone who can write to the bridge
  socket can drive your Cursor Chat.
- The state store is a single JSON file. Designed for single-user, low
  concurrency.
- `preToolUse` `ask` is treated as advisory by Cursor in some builds.
  Use `Deny` (with `& remember` if appropriate) on the approval card
  for tools you really want to block.
- The approval flow requires an existing chat ↔ thread binding. If
  Cursor is started in a session without any binding, approval will
  short-circuit to `ask` so Cursor's local UI handles it.

## License

MIT — see [`LICENSE`](LICENSE).
