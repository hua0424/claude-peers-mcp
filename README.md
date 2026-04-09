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

Auth is dual-layer: an **API key** controls broker access, and a **group secret** determines which instances can see each other. Instances sharing the same group secret form a group — only members of the same group can discover and message each other.

## Prerequisites

- [Bun](https://bun.sh)
- Claude Code v2.1.80+
- claude.ai login (channels require it — API key auth won't work)

## Step 1: Deploy the Broker

Choose one machine to run the broker. It can be any server reachable by all hosts (a VPS, a machine on your LAN, or localhost for single-machine use).

```bash
git clone https://github.com/hua0424/claude-peers-mcp.git ~/claude-peers-mcp
cd ~/claude-peers-mcp
bun install

# Start the broker (pick a strong API key)
CLAUDE_PEERS_API_KEY=my-secret-key-123 bun broker.ts
```

You should see:

```
[claude-peers broker] listening on 0.0.0.0:7899 (db: /home/user/.claude-peers.db)
```

Make sure port 7899 is reachable from your other hosts. Note the broker host's IP address (e.g. `10.0.0.5`). For single-machine use, the IP is `127.0.0.1`.

## Step 2: Install on Each Host

On every machine that will run Claude Code:

```bash
git clone https://github.com/hua0424/claude-peers-mcp.git ~/claude-peers-mcp
cd ~/claude-peers-mcp
bun install
```

## Step 3: Register the MCP Server

On each host, register claude-peers as an MCP server. Replace the IP and keys with your actual values:

```bash
claude mcp add --scope user --transport stdio claude-peers \
  -e CLAUDE_PEERS_BROKER_URL=http://10.0.0.5:7899 \
  -e CLAUDE_PEERS_API_KEY=my-secret-key-123 \
  -e CLAUDE_PEERS_GROUP_SECRET=team-alpha \
  -- bun ~/claude-peers-mcp/server.ts
```

- `CLAUDE_PEERS_BROKER_URL` — the broker's address from Step 1
- `CLAUDE_PEERS_API_KEY` — must match the broker's key exactly
- `CLAUDE_PEERS_GROUP_SECRET` — any string; instances with the same secret form a group

> **Multiple groups on one machine:** Different projects can use different group secrets. Configure per-directory via `.mcp.json`:
>
> ```json
> {
>   "claude-peers": {
>     "command": "bun",
>     "args": ["~/claude-peers-mcp/server.ts"],
>     "env": {
>       "CLAUDE_PEERS_BROKER_URL": "http://10.0.0.5:7899",
>       "CLAUDE_PEERS_API_KEY": "my-secret-key-123",
>       "CLAUDE_PEERS_GROUP_SECRET": "team-alpha"
>     }
>   }
> }
> ```

## Step 4: Start Claude Code

Launch Claude Code with channel support:

```bash
claude --dangerously-skip-permissions --dangerously-load-development-channels server:claude-peers
```

> **Tip:** Add an alias so you don't have to type it every time:
>
> ```bash
> alias claudepeers='claude --dangerously-load-development-channels server:claude-peers'
> ```

## Step 5: Try It

### Discover peers

In any Claude Code session, say:

> List all peers in my group

If you're the only session running, you'll see "No other Claude Code instances found." Start a second session (same or different host, same group secret) and try again — you'll see the other instance with its ID, hostname, working directory, and summary.

### Send a message

> Send a message to peer [id]: "what are you working on?"

The other Claude receives it **immediately** via WebSocket push and responds.

### Verify group isolation (optional)

Start a third instance with a **different** group secret:

```bash
claude mcp add --scope user --transport stdio claude-peers-beta \
  -e CLAUDE_PEERS_BROKER_URL=http://10.0.0.5:7899 \
  -e CLAUDE_PEERS_API_KEY=my-secret-key-123 \
  -e CLAUDE_PEERS_GROUP_SECRET=team-beta \
  -- bun ~/claude-peers-mcp/server.ts
```

This instance should **not** see the `team-alpha` peers when listing.

## Tools

| Tool             | What it does                                                                  |
| ---------------- | ----------------------------------------------------------------------------- |
| `list_peers`     | Find other Claude Code instances — scoped by `group`, `directory`, or `repo`  |
| `send_message`   | Send a message to another instance by ID (arrives instantly via WebSocket)    |
| `set_summary`    | Describe what you're working on (visible to other peers)                      |
| `check_messages` | Check WebSocket connection status                                            |

## CLI

Inspect broker state and send messages from the command line:

```bash
export CLAUDE_PEERS_BROKER_URL=http://10.0.0.5:7899
export CLAUDE_PEERS_API_KEY=my-secret-key-123
export CLAUDE_PEERS_GROUP_SECRET=team-alpha

bun cli.ts status            # broker status
bun cli.ts peers             # list peers in your group
bun cli.ts send <id> <msg>   # send a message to a peer
bun cli.ts kill-broker        # stop the broker (local only)
```

## Configuration

### Broker

| Variable               | Default              | Description             |
| ---------------------- | -------------------- | ----------------------- |
| `CLAUDE_PEERS_API_KEY` | (required)           | Controls broker access  |
| `CLAUDE_PEERS_PORT`    | `7899`               | Listen port             |
| `CLAUDE_PEERS_DB`      | `~/.claude-peers.db` | SQLite database path    |

### MCP Server / CLI

| Variable                      | Description                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `CLAUDE_PEERS_BROKER_URL`     | Broker address, e.g. `http://10.0.0.5:7899`                                 |
| `CLAUDE_PEERS_API_KEY`        | Must match the broker's configured key                                       |
| `CLAUDE_PEERS_GROUP_SECRET`   | Determines group membership; same secret = same group                        |

### Optional

| Variable         | Description                            |
| ---------------- | -------------------------------------- |
| `OPENAI_API_KEY` | Enables auto-summary via gpt-5.4-nano |

## Auto-summary

If `OPENAI_API_KEY` is set, each instance generates a brief summary on startup describing what you're likely working on (based on directory, git branch, recent files). Other instances see this when they call `list_peers`. Without it, Claude sets its own summary via `set_summary`.
