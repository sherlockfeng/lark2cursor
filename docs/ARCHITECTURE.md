# Architecture

`agent2lark-cursor` connects Cursor IDE and Feishu / Lark without UI
automation or proprietary SDKs:

- **Cursor IDE** — invokes us through its public hooks
  (`sessionStart`, `beforeSubmitPrompt`, `afterAgentResponse`,
  `postToolUse`, `postToolUseFailure`, `afterShellExecution`, `stop`,
  `preToolUse`, `beforeShellExecution`, `beforeMCPExecution`).
- **Feishu / Lark** — reached via the `lark-cli` command-line client
  (`event +subscribe` for incoming, `im +messages-reply` for outgoing,
  `im reactions create` for read receipts).

Two public capabilities are layered on top:

1. **IDE Chat Relay** (Feishu thread ⇄ a specific open Cursor IDE Chat).
2. **Remote tool approval** — when Cursor wants to run a risky tool the
   bridge posts an interactive Feishu card into the bound thread,
   blocks on a click, and optionally caches the decision in a local
   policy file (`cursor-approval-policy.json`).

Both share one bridge daemon, one local message queue, one persistent
state file and one approval policy file. There is no
separate approval daemon.

## High-level diagrams

### Remote tool approval (text mode, default)

```text
Cursor preToolUse / beforeShellExecution / beforeMCPExecution
  -> agent2lark-cursor-hook (cursor_approval_request)
    -> bridge
      -> if no binding for session: { decision: "ask", reason: "no_binding" }
      -> if approval policy matches: { decision: cached.decision, reason: cached:<ruleId> }
      -> else:
           lark-cli im +messages-reply --markdown   (🔒 Cursor approval required + tool + command + /allow|/deny instructions)
           ApprovalRegistry.request(requestId, { thread })       (wait until reply or timeout)

Reviewer types /allow or /deny (with optional `!` for remember, and
optional `req_<id>` to disambiguate concurrent approvals) in the bound
thread.
  -> lark-cli event +subscribe delivers im.message.receive_v1
    -> lark-listen recognises the command grammar and forwards
       lark_approval_decision (carrying decision + remember + chat_id +
       thread_id, with request_id when present)
    -> bridge:
         if request_id: ApprovalRegistry.decide(requestId, ...)
         else:           ApprovalRegistry.decideLatest({chatId, threadId}, ...)
         if remember: ApprovalPolicy.add({ tool, commandPrefix, decision })

Hook returns to Cursor as { permission: "allow" | "deny" | "ask" }
```

### Remote tool approval (card mode, opt-in)

`AGENT2LARK_APPROVAL_MODE=card` swaps the markdown prompt for a
4-button interactive Feishu card via
`lark-cli im +messages-reply --msg-type interactive`. The decision
channel is unchanged: button clicks arrive as `card.action.trigger`
WebSocket events, the listener forwards them as
`lark_approval_decision`, and the bridge resolves the same
ApprovalRegistry entry.

Card mode has two requirements that text mode does not:

1. The Feishu app must subscribe to `card.action.trigger` (enable in
   the developer console — `--event-types` on `lark-cli` is only a
   client-side filter).
2. The bot must respond to each button click within a few seconds via
   the card-update API to clear the loading state. This project does
   not yet implement that response, so card clicks may surface
   "Something went wrong (200340)" in Feishu UI even when the
   underlying decision is recorded correctly. Text mode avoids this
   entirely.

Acknowledgement before processing:

```text
Lark message arrives -> bridge dequeue (IDE Chat Relay)
  -> lark-cli im reactions create  (👀 EYES on the user's message)
  -> lark-cli im +messages-reply   (text "Got it, processing…")
  -> normal processing path
```

Thinking heartbeat (Cursor exposes no token-stream introspection — this
is a "still working" liveness signal, not the actual reasoning):

```text
Turn start (cursor_prompt_submit with binding,
           or cursor_stop returning a real Lark followup_message)
  -> ThinkingHeartbeat.start(key, binding)         setInterval(intervalMs)
       -> lark-cli im +messages-reply              "🤔 Thinking… (Ns)"
       (key = cursor session id)

Turn end (cursor_agent_response, cursor_stop returning empty or
         WAIT_HEARTBEAT)
  -> ThinkingHeartbeat.stop(key)                   clearInterval
```

`thinkingIntervalMs` in `~/.agent2lark/config.json` controls the cadence
(`0` disables the heartbeat without affecting the wait loop). The
`AGENT2LARK_THINKING_INTERVAL_MS` env var remains an ad-hoc override.

Safe progress relay is opt-in because most users want assistant text
replies mirrored, not tool-call lifecycle noise. When
`progressRelayEnabled` is `true`, it uses Cursor lifecycle hooks rather
than assistant streaming. `beforeShellExecution` / `preToolUse` can emit a
`Running: ...` message once approval resolves to `allow`;
`afterShellExecution`, `postToolUse`, and `postToolUseFailure` emit short
`Done:` / `Failed:` messages. These contain only the tool/command label,
optional duration, and exit code. Full shell output and tool output are
not sent to Lark. Each sent progress message calls
`ThinkingHeartbeat.touch(sessionId)`, so the generic `🤔 Thinking…`
heartbeat only appears after progress has been quiet for at least
`thinkingIntervalMs`. `progressRelayEnabled` in
`~/.agent2lark/config.json` controls this feature;
`AGENT2LARK_PROGRESS_RELAY` is the env override.

The acknowledgement runs through `Promise.allSettled`, so a failing
reaction (for example because the bot lacks the reaction scope) never
blocks the actual reply.

### IDE Chat Relay (passive)

```text
Feishu user @bot in thread
  -> lark-cli event +subscribe
    -> agent2lark-cursor lark-listen
      -> ~/.agent2lark/cursor-relay.sock (bridge)
        -> SessionStore.queues[chat:thread]

Cursor IDE Chat finishes a turn -> stop hook
  -> agent2lark-cursor-hook --event stop
    -> bridge cursor_stop (long-poll up to AGENT2LARK_WAIT_POLL_MS)
      -> if queued message: followup_message  "Lark thread ...:..."
      -> else if waitEnabled: followup_message  "AGENT2LARK_WAITING_FOR_LARK ..."
    -> Cursor injects followup as the next user prompt

Cursor afterAgentResponse hook
  -> bridge cursor_agent_response
    -> lark-cli im +messages-reply --reply-in-thread

Cursor tool/shell lifecycle hooks
  -> bridge cursor_progress
    -> lark-cli im +messages-reply --reply-in-thread  "Running/Done/Failed: ..."
```

## Module map

```text
src/
  constants.js          # paths, default events, env names
  io.js                 # stdin/stdout helpers for hook scripts
  normalize.js          # Cursor hook payload -> bridge approval / relay messages
  hook.js               # Cursor hook entrypoint (approval + relay over the bridge)
  installer.js          # writes / removes ~/.cursor/hooks.json entries
  bridge-server.js      # the bridge: socket server + ApprovalRegistry
  bridge-client.js      # JSON-line client for the bridge socket
  session-store.js      # JSON-backed persistence of binds / queues / sessions
  approval-policy.js    # JSON-backed approval rules (tool + command prefix)
  lark-adapter.js       # lark-cli senders: thread reply, reaction, approval card
  lark-listener.js      # spawns & supervises `lark-cli event +subscribe`
  lark-config.js        # reads `lark-cli config show`, creates the default "Cursor Conversation" group
  relay-supervisor.js   # spawn/stop/status of bridge + lark-listen, kill group
  start-wizard.js       # interactive `pnpm run start-relay` flow
  cli.js                # argv -> command dispatch

bin/
  agent2lark-cursor.js          # main CLI
  agent2lark-cursor-hook.js     # Cursor hook entrypoint script
  agent2lark-cursor-bridge.js   # back-compat alias for `bridge`

tests/                  # node:test suites (one per src/ module)
docs/ARCHITECTURE.md    # this file
```

## Process topology

When `pnpm run start-relay` finishes, you have:

```text
agent2lark-cursor.js bridge --lark-cli      # PID A (server, long-running)
   listens: ~/.agent2lark/cursor-relay.sock
   stdout:  ~/.agent2lark/logs/bridge.out.log
   stderr:  ~/.agent2lark/logs/bridge.err.log

agent2lark-cursor.js lark-listen            # PID B (long-running)
   spawns:  lark-cli event +subscribe ...   # PID C (auto-restarted)
                  └── @larksuite/cli/...    # PID D
   stdout:  ~/.agent2lark/logs/lark-listen.out.log
   stderr:  ~/.agent2lark/logs/lark-listen.err.log
```

The supervisor (`relay-supervisor.js`) spawns A and B with `detached: true`,
so each forms its own process group. `stopRelayProcesses` kills the whole
group via `process.kill(-pid, 'SIGTERM')`, preventing orphaned `lark-cli`
subscribers from holding `~/.lark-cli/locks/subscribe_cli_*.lock`.

Transient processes:

```text
agent2lark-cursor-hook.js --event <event>   # spawned by Cursor per event
```

## Bridge wire protocol

The bridge listens on `~/.agent2lark/cursor-relay.sock` and speaks
JSON-lines. Every request gets exactly one response line, then the
connection is closed.

| `message.type` | Sender | Purpose | Response |
| --- | --- | --- | --- |
| `cursor_session_start` | hook (`sessionStart`) | register Cursor session | `{additional_context}` |
| `cursor_prompt_submit` | hook (`beforeSubmitPrompt`) | detect bind code in prompt | `{continue, user_message}` |
| `cursor_stop` | hook (`stop`) | long-poll for queued Lark messages | `{followup_message?}` |
| `cursor_agent_response` | hook (`afterAgentResponse`) | mirror Cursor reply to Lark | `{ok, suppressed?}` |
| `cursor_progress` | hook (`postToolUse`/`postToolUseFailure`/`afterShellExecution`) and allowed approval hooks | mirror safe short progress | `{ok, sent}` |
| `cursor_approval_request` | hook (`preToolUse`/`beforeShellExecution`/`beforeMCPExecution`) | request remote approval | `{decision: "allow"\|"deny"\|"ask", reason}` |
| `lark_message` | `lark-listen` | enqueue Lark message | `{ok, routed?}` |
| `lark_create_bind` | `lark-listen` | create pending IDE Chat bind code | `{ok, code}` |
| `lark_disable_wait` | `lark-listen` | turn off the IDE Chat wait loop | `{ok}` |
| `lark_unbind_thread` | `lark-listen` | remove the current thread binding and queued messages | `{ok, removed}` |
| `lark_approval_decision` | `lark-listen` | resolve a pending approval request | `{ok}` |

`cursor_stop` long-polls inside the bridge for up to
`AGENT2LARK_WAIT_POLL_MS` (default 10 minutes). `cursor_approval_request`
blocks for up to `AGENT2LARK_APPROVAL_TIMEOUT_MS` (default 24 hours).
The hook (`hook.js`) automatically extends its socket timeout for both
events so the client never disconnects before the bridge.

## State store

`SessionStore` writes JSON to `~/.agent2lark/cursor-relay-state.json`:

```jsonc
{
  "pendingBinds": {
    // short-lived bind codes created by `bind chat` (or zh-CN alias `绑定对话`) in Feishu
    "<code>": {
      "code": "<code>",
      "chatId": "oc_xxx",
      "threadId": "om_xxx",
      "replyMessageId": "om_xxx",
      "expiresAt": 1700000000000
    }
  },
  "bindings": {
    "byCursorSession": {
      "<cursor session id>": {
        "chatId": "oc_xxx",
        "threadId": "om_xxx",
        "sessionId": "<cursor session id>",
        "cwd": "/path/to/project",
        "waitEnabled": false   // optional, true by default
      }
    },
    "byLarkThread": {
      "oc_xxx:om_xxx": { /* ide_chat binding */ }
    }
  },
  "queues": {
    "oc_xxx:om_xxx": [
      { "chatId": "oc_xxx", "threadId": "om_xxx", "messageId": "om_yyy", "text": "..." }
    ]
  },
  "cursorSessions": { "<sessionId>": { "cwd": "...", "composerMode": "..." } },
  "cursorResponses": [ { "sessionId": "...", "text": "...", "createdAt": 0 } ]
}
```

Notes:

- An IDE Chat binding has no `mode` field (`"ide_chat"` is implicit) and is
  indexed under both `byCursorSession` and `byLarkThread`.
- The bridge resolves inbound Lark messages with
  `resolveInboundLarkThread`. When `lark-cli`'s compact event omits the
  thread root and a chat has exactly one bound thread, the message is
  routed to that bound thread instead of being dropped.
- For command-like Lark messages, `lark-listener` asks
  `lark-cli im +messages-mget` for the current message's canonical
  `thread_id` before forwarding to the bridge. If the lookup fails (for
  example due to missing read permission), it falls back to the event
  fields and bridge-side chat fallback.
- `@bot unbind` / `@bot un bind` emits `lark_unbind_thread`, removing the
  current thread's IDE Chat binding and clearing queued messages for that
  thread. `@bot /help` prints the supported command
  reference in the same thread.

## IDE Chat wait loop

Binding a Lark thread is handled in `beforeSubmitPrompt` and returns
`continue: false`. That keeps the bind command out of the model, but it
also means the bind operation itself does not create an Agent turn and
therefore cannot start the `stop` hook wait loop. After a successful bind,
the user must send the wait-loop starter in the same Cursor Chat:

```text
AGENT2LARK_WAITING_FOR_LARK
Please reply with only: AGENT2LARK_WAITING_FOR_LARK
Do not invoke any tools and do not send a business reply to Lark.
```

That prompt asks the model to echo only the sentinel, avoiding accidental
file reads or tool calls. The end of that turn triggers the first
`cursor_stop` call and parks the Chat in the loop below.

The `cursor_stop` handler in `bridge-server.js`:

```text
queued = dequeueForCursorSession(sessionId)
if queued: return { followup_message: "Lark thread ...:..." }
binding = getBindingByCursorSession(sessionId)
if !binding or binding.waitEnabled === false: return {}
sleep(waitIntervalMs); repeat until deadline
on deadline: return { followup_message: WAIT_HEARTBEAT + instructions }
```

`WAIT_HEARTBEAT` is the literal string `AGENT2LARK_WAITING_FOR_LARK`. The
followup tells the agent to **only** echo this string back, which trips a
guard in `cursor_agent_response`:

```js
if (isWaitHeartbeat(text)) return { ok: true, suppressed: "wait_heartbeat" };
```

so the heartbeat is never forwarded to Feishu. The next stop hook then
re-enters the loop. From the user's perspective the Cursor Chat is "sitting
quietly, waiting for the next Feishu message".

To stop this loop, either:

- Send `@bot stop wait` (or `disable wait` / `pause wait`; legacy
  zh-CN aliases `停止等待` / `关闭等待` still recognised) inside the Feishu
  thread — `lark-listener` matches it and emits `lark_disable_wait`.
- Set `binding.waitEnabled = false` directly in the state file.

## Lark listener resilience

`startLarkEventListener` runs `lark-cli event +subscribe ... --quiet --as bot`
under a respawn loop:

- Each event line is parsed once and emitted to stdout as
  `[lark-listen] event chat=... msg=...`. Non-JSON lines are logged but not
  forwarded.
- When the `lark-cli` child exits, the parent logs
  `[lark-listen] lark-cli child exited code=X signal=Y`, sleeps
  `respawnDelayMs` (default 1s), then spawns a new child.
- `handle.stop()` flips a flag and kills the current child so respawn does
  not happen during shutdown.

`lark-cli` enforces "one subscriber per app" with a local lock at
`~/.lark-cli/locks/subscribe_cli_<appId>.lock`. If you ever see the listener
respawning rapidly with `code=2`, it almost always means a previous orphan
subscriber is still holding that lock; `pnpm run stop-relay` cleans it up.

## Cursor hooks integration

Hooks are written into `~/.cursor/hooks.json` by `installer.js`. The relay
mode adds:

```json
{
  "version": 1,
  "hooks": {
    "sessionStart":          [{ "command": "node .../agent2lark-cursor-hook.js --event sessionStart",          "timeout": 86400, "failClosed": false }],
    "beforeSubmitPrompt":    [{ "command": "node .../agent2lark-cursor-hook.js --event beforeSubmitPrompt",    "timeout": 86400, "failClosed": false }],
    "afterAgentResponse":    [{ "command": "node .../agent2lark-cursor-hook.js --event afterAgentResponse",    "timeout": 86400, "failClosed": false }],
    "postToolUse":           [{ "command": "node .../agent2lark-cursor-hook.js --event postToolUse",           "timeout": 86400, "failClosed": false }],
    "postToolUseFailure":    [{ "command": "node .../agent2lark-cursor-hook.js --event postToolUseFailure",    "timeout": 86400, "failClosed": false }],
    "afterShellExecution":   [{ "command": "node .../agent2lark-cursor-hook.js --event afterShellExecution",   "timeout": 86400, "failClosed": false }],
    "stop":                  [{ "command": "node .../agent2lark-cursor-hook.js --event stop",                  "timeout": 86400, "failClosed": false, "loop_limit": null }]
  }
}
```

`loop_limit: null` makes Cursor honour repeated `stop.followup_message`s
indefinitely, which is what powers the wait loop.

The hook script (`agent2lark-cursor-hook.js`) reads JSON from stdin,
routes to `handleRelayEvent` (relay events) or `handleApprovalEvent`
(approval events) in `src/hook.js`, and writes one JSON object to
stdout. Both paths talk to the same bridge socket.

## Approval policy file

Remembered approval decisions live in
`~/.agent2lark/cursor-approval-policy.json`:

```jsonc
{
  "rules": [
    {
      "id": "rule_<hex>",
      "tool": "Shell",                  // or "mcp__server__tool", "Write", ...
      "commandPrefix": "git status",    // shell scope: command.startsWith(prefix)
      "pathPrefix": "",                 // file-tool scope: project path prefix
      "toolScope": true,                // optional exact-tool scope, e.g. MCP tools
      "decision": "allow",              // "allow" | "deny"
      "hits": 7,
      "createdAt": 1700000000000,
      "lastUsedAt": 1700000900000
    }
  ]
}
```

For path-based tools (`Write`, `Edit`, `Delete`, `ApplyPatch`,
`MultiEdit`), `/allow!` stores `tool + project pathPrefix`, so a single
approval covers subsequent edits under the same project root without
approving every file. The project root is inferred from the target file
path by walking up to the nearest project marker (`.git`, `package.json`,
`pyproject.toml`, and similar), not from the Cursor hook process cwd.
Nested edit payloads and patch payloads are inspected for file paths
before falling back to the session cwd. MCP tools use `toolScope: true`
for the exact normalized MCP tool name because their argument JSON is
often empty or volatile; users can also resolve pending MCP approvals
with an explicit scoped command such as `/allow mcp__server__tool!`.
Shell tools store a command-prefix scope. Package manager commands
(`pnpm`, `npm`, `yarn`, `bun`) use the first token as the remembered
prefix; other Shell commands default to the first two tokens unless the
user supplies an explicit scoped approval such as `/allow shell node!` or
`/allow shell!`. When multiple rules match, the longest path/command
prefix wins (so a more specific rule takes precedence over a broader
one). On every match, `hits` and `lastUsedAt` are updated.

## Filesystem layout

```text
~/.agent2lark/
  cursor-relay.sock                # bridge UNIX socket
  cursor-relay-state.json          # SessionStore
  cursor-relay-runtime.json        # supervisor PIDs + log paths
  cursor-approval-policy.json      # remembered approval rules
  config.json                      # runtime config, e.g. thinkingIntervalMs, progressRelayEnabled
  logs/
    bridge.out.log
    bridge.err.log
    lark-listen.out.log
    lark-listen.err.log
~/.cursor/
  hooks.json                       # owned by Cursor; we add/remove our entries
~/.lark-cli/
  locks/subscribe_cli_<appId>.lock # owned by lark-cli; we just observe
```

## Configuration

| Env var | Default | Effect |
| --- | --- | --- |
| `AGENT2LARK_BRIDGE_SOCKET` | `~/.agent2lark/cursor-relay.sock` | relay bridge socket |
| `AGENT2LARK_BRIDGE_TIMEOUT_MS` | `30000` | hook client default socket timeout (auto-extended for `stop` + approval) |
| `AGENT2LARK_WAIT_POLL_MS` | `600000` | max bridge long-poll per `cursor_stop` |
| `AGENT2LARK_WAIT_INTERVAL_MS` | `1000` | bridge queue poll interval inside long-poll |
| `AGENT2LARK_APPROVAL_MODE` | `text` | `text` markdown-prompt approval (default) or `card` interactive card |
| `AGENT2LARK_APPROVAL_TIMEOUT_MS` | `86400000` | bridge wait limit per approval prompt before falling back to `ask` |
| `AGENT2LARK_APPROVAL_POLICY` | `~/.agent2lark/cursor-approval-policy.json` | override approval rules path |
| `AGENT2LARK_THINKING_INTERVAL_MS` | unset | optional env override for `thinkingIntervalMs` in `~/.agent2lark/config.json` |
| `AGENT2LARK_PROGRESS_RELAY` | unset | optional env override for `progressRelayEnabled` in `~/.agent2lark/config.json` |
| `LARK_CLI_COMMAND` | bundled `node_modules/.bin/lark-cli` | override the Lark CLI executable |
| `AGENT2LARK_RELAY_STATE` | `~/.agent2lark/cursor-relay-state.json` | override SessionStore path |

## Failure modes & how the system reacts

| Failure | Effect | Mitigation already in code |
| --- | --- | --- |
| `lark-cli` WebSocket disconnects silently | `lark-listen` keeps running but receives no events | listener respawns child on exit; logs to `lark-listen.{out,err}.log` |
| Stale `lark-cli` subscriber holds the app lock | new subscriber dies with `code=2` | `stopRelayProcesses` now SIGTERMs the whole process group |
| `stop` hook longer than client default timeout | premature disconnect, wait loop dies | `relayBridgeTimeoutMs` extends `stop` timeout to `WAIT_POLL_MS + 5s` |
| Bridge socket read times out | silent empty response (`{}`) | `bridge-client` rejects with an explicit error |
| Cursor IDE Chat is closed while bound | next Lark message stays queued | manual `pnpm run status-relay` + open the chat to drain queue |

## Security notes

- The bridge socket lives under `~/.agent2lark/` with default user
  permissions. Anyone with read/write access to that directory can talk to
  the bridge and inject Cursor prompts.
- Hooks run with **your** Cursor permissions. The relay mode is intended
  for trusted local environments. Combine it with the approval mode if
  remote senders should not be able to run arbitrary tools.
- This project does not store any Feishu tokens. Tokens live in
  `lark-cli`'s own config and stay there. State files only contain
  Feishu IDs (`chat_id`, `thread_id`, `message_id`), Cursor session ids,
  and message text exchanged through the relay.
