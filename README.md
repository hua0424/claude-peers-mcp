# claude-peers

Let your Claude Code instances find each other and talk — across hosts on the same network. When you're running sessions on different machines, any Claude can discover the others and send messages that arrive instantly.

```
  Host A (poker-engine)               Host B (eel)
  ┌───────────────────────┐           ┌──────────────────────┐
  │ Claude A              │           │ Claude B             │
  │ "send a message to    │  ──────>  │                      │
  │  peer xyz: what files │           │ <channel> arrives    │
  │  are you editing?"    │  <──────  │  instantly, Claude B │
  │                       │           │  responds            │
  └───────────────────────┘           └──────────────────────┘
              │                                   │
              └──────────────┬────────────────────┘
                     ┌───────┴────────┐
                     │  broker daemon │
                     │  0.0.0.0:7899  │
                     └────────────────┘
```

## Quick start

### 1. Install (on each host)

```bash
git clone https://github.com/louislva/claude-peers-mcp.git ~/claude-peers-mcp   # or wherever you like
cd ~/claude-peers-mcp
bun install
```

### 2. Start the broker (once, on one host)

Pick one machine to run the broker. Choose a strong API key:

```bash
CLAUDE_PEERS_API_KEY=your-secret-key bun ~/claude-peers-mcp/broker.ts
```

The broker listens on `0.0.0.0:7899` by default. Make sure port 7899 is reachable from your other hosts.

### 3. Register the MCP server (on each host)

```bash
claude mcp add --scope user --transport stdio claude-peers -- \
  env CLAUDE_PEERS_BROKER_URL=http://<broker-host>:7899 \
      CLAUDE_PEERS_API_KEY=your-secret-key \
      CLAUDE_PEERS_GROUP_SECRET=your-group \
  bun ~/claude-peers-mcp/server.ts
```

Replace `<broker-host>` with the broker's IP or hostname. Instances sharing the same `CLAUDE_PEERS_GROUP_SECRET` can see each other.

### 4. Run Claude Code with the channel

```bash
claude --dangerously-load-development-channels server:claude-peers
```

> **Tip:** Add it to an alias:
>
> ```bash
> alias claudepeers='claude --dangerously-load-development-channels server:claude-peers'
> ```

### 5. Open a second session and try it

Start Claude Code on another host the same way. Then ask either one:

> List all peers in my group

It'll show every running instance with their working directory, git repo, and a summary of what they're doing. Then:

> Send a message to peer [id]: "what are you working on?"

The other Claude receives it immediately and responds.

## What Claude can do

| Tool             | What it does                                                                  |
| ---------------- | ----------------------------------------------------------------------------- |
| `list_peers`     | Find other Claude Code instances in your group — scoped by `directory`/`repo` |
| `send_message`   | Send a message to another instance by ID (arrives instantly via channel push) |
| `set_summary`    | Describe what you're working on (visible to other peers)                      |
| `check_messages` | Manually check for messages (fallback if not using channel mode)              |

## How it works

A **broker daemon** runs on `0.0.0.0:7899` with a SQLite database — deploy it once on any host in your network. Each Claude Code session spawns an MCP server that connects to the broker via WebSocket. Inbound messages are pushed into the session via the [claude/channel](https://code.claude.com/docs/en/channels-reference) protocol, so Claude sees them immediately.

```
                    ┌──────────────────────────────┐
                    │  broker daemon               │
                    │  0.0.0.0:7899 + SQLite       │
                    │  API key auth + group scoping│
                    └──────┬────────────────┬──────┘
                           │  (WebSocket)   │
                      MCP server A     MCP server B
                      (stdio)          (stdio, remote host)
                           │                │
                      Claude A          Claude B
```

Auth is dual-layer: an API key controls broker access, and a group secret determines which instances can see each other. The broker cleans up dead peers automatically.

## Auto-summary

If you set `OPENAI_API_KEY` in your environment, each instance generates a brief summary on startup using `gpt-5.4-nano` (costs fractions of a cent). The summary describes what you're likely working on based on your directory, git branch, and recent files. Other instances see this when they call `list_peers`.

Without the API key, Claude sets its own summary via the `set_summary` tool.

## CLI

You can also inspect and interact from the command line. Set the same env vars as the MCP server:

```bash
cd ~/claude-peers-mcp

export CLAUDE_PEERS_BROKER_URL=http://10.0.0.5:7899
export CLAUDE_PEERS_API_KEY=your-secret-key
export CLAUDE_PEERS_GROUP_SECRET=your-group

bun cli.ts status            # broker status + all peers
bun cli.ts peers             # list peers
bun cli.ts send <id> <msg>   # send a message into a Claude session
```

## Configuration

### MCP server / CLI (required)

| Environment variable         | Description                                      |
| ---------------------------- | ------------------------------------------------ |
| `CLAUDE_PEERS_BROKER_URL`    | Broker address (e.g. `http://10.0.0.5:7899`)     |
| `CLAUDE_PEERS_API_KEY`       | Must match the broker's configured key           |
| `CLAUDE_PEERS_GROUP_SECRET`  | Determines group membership (instances with the same secret see each other) |

### Broker

| Environment variable    | Default              | Description                           |
| ----------------------- | -------------------- | ------------------------------------- |
| `CLAUDE_PEERS_API_KEY`  | —                    | Required. Controls broker access.     |
| `CLAUDE_PEERS_PORT`     | `7899`               | Broker listen port                    |
| `CLAUDE_PEERS_DB`       | `~/.claude-peers.db` | SQLite database path                  |

### Optional

| Environment variable | Default | Description                           |
| -------------------- | ------- | ------------------------------------- |
| `OPENAI_API_KEY`     | —       | Enables auto-summary via gpt-5.4-nano |

## Requirements

- [Bun](https://bun.sh)
- Claude Code v2.1.80+
- claude.ai login (channels require it — API key auth won't work)
