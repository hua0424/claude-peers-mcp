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

Auth is dual-layer:

- **API key** (`CLAUDE_PEERS_API_KEY`) — controls who can connect to the broker at all. Must match the broker's configured key exactly.
- **Group secret** (`CLAUDE_PEERS_GROUP_SECRET`) — determines which peers can see and message each other. Instances sharing the same secret form a group; peers in different groups are completely invisible to each other, even when served by the same broker.

One broker can host many independent groups side-by-side. See [Groups](#groups) for a full walkthrough of how to use grouping effectively.

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

### Running the broker in the background

The command above runs in the foreground — closing the terminal kills the broker. For anything beyond a quick test, run it as a background process that survives logout.

**Option A: `nohup` (quick and portable)**

```bash
nohup env CLAUDE_PEERS_API_KEY=my-secret-key-123 \
  bun ~/claude-peers-mcp/broker.ts \
  > ~/claude-peers.log 2>&1 &

# Confirm it's running and find the PID
pgrep -af 'bun.*broker\.ts'

# Stop it later
kill $(pgrep -f 'bun.*broker\.ts')

# Or use the built-in kill endpoint (local only)
CLAUDE_PEERS_BROKER_URL=http://127.0.0.1:7899 \
CLAUDE_PEERS_API_KEY=my-secret-key-123 \
bun ~/claude-peers-mcp/cli.ts kill-broker
```

**Option B: `systemd` unit (recommended for a permanent deployment)**

Create `/etc/systemd/system/claude-peers-broker.service`:

```ini
[Unit]
Description=claude-peers broker
After=network.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/home/YOUR_USER/claude-peers-mcp
Environment=CLAUDE_PEERS_API_KEY=my-secret-key-123
# Optional overrides:
# Environment=CLAUDE_PEERS_PORT=7899
# Environment=CLAUDE_PEERS_DB=/home/YOUR_USER/.claude-peers.db
ExecStart=/usr/bin/env bun /home/YOUR_USER/claude-peers-mcp/broker.ts
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Replace `YOUR_USER` with your username and adjust the path to `bun` if it's not on the default `PATH` (`which bun` to check). Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now claude-peers-broker
sudo systemctl status claude-peers-broker
journalctl -u claude-peers-broker -f   # tail logs
```

**Option C: `tmux` or `screen` (interactive session you can detach)**

```bash
tmux new -d -s broker \
  "CLAUDE_PEERS_API_KEY=my-secret-key-123 bun ~/claude-peers-mcp/broker.ts"

tmux attach -t broker    # view logs
# Ctrl-b then d to detach again
```

> **macOS note:** Use `launchd` (create a `~/Library/LaunchAgents/com.claude-peers.broker.plist` file) or Homebrew services instead of `systemd`. The `nohup` and `tmux` options work as-is.

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

> **Alternative: per-directory `.mcp.json`** — instead of `claude mcp add`, you can create a `.mcp.json` in your project directory. This is useful for per-project group secrets:
>
> ```json
> {
>   "mcpServers": {
>     "claude-peers": {
>       "type": "stdio",
>       "command": "bun",
>       "args": ["/home/user/claude-peers-mcp/server.ts"],
>       "env": {
>         "CLAUDE_PEERS_BROKER_URL": "http://10.0.0.5:7899",
>         "CLAUDE_PEERS_API_KEY": "my-secret-key-123",
>         "CLAUDE_PEERS_GROUP_SECRET": "team-alpha"
>       }
>     }
>   }
> }
> ```
>
> With `.mcp.json`, skip Step 3 — just start Claude Code normally in that directory and the MCP server loads automatically.

## Step 4: Start Claude Code

Launch Claude Code with channel support (enables real-time message push):

```bash
claude --dangerously-load-development-channels server:claude-peers
```

Without the channel flag, MCP tools still work but incoming messages won't push automatically — you'd need Claude to call `check_messages` manually.

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

### Set a custom peer ID

> Set my peer ID to "review-bot"

IDs must be 1–32 lowercase letters, digits, or hyphens and are unique **within your group** (the same ID can exist independently in a different group). Once set, the ID persists across restarts — other peers in your group can always find you by the same name.

If you ever restart Claude Code and the wrong session is auto-resumed (e.g. you have two sessions in the same directory), ask Claude to switch:

> Switch to a different peer identity

Claude will call `switch_id` and list the available previous sessions to choose from.

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

For a deeper walkthrough — typical group layouts, running multiple groups from one machine, and important caveats — see the [Groups](#groups) section.

## Tools

| Tool             | What it does                                                                  |
| ---------------- | ----------------------------------------------------------------------------- |
| `list_peers`     | Find other Claude Code instances in your group. Scope narrows the query: `group` (all peers in group), `directory` (same `cwd` on same host), or `repo` (same git root, across hosts) |
| `send_message`   | Send a message to another instance by ID. If the target is online it arrives instantly via WebSocket; if offline, it's queued on the broker and delivered on their next connection (response includes `queued: true`) |
| `set_summary`    | Describe what you're working on (visible to other peers in your group)        |
| `set_id`         | Set a custom peer ID (e.g. `my-review-bot`). Must be 1-32 lowercase alphanumeric or hyphens, unique within your group |
| `switch_id`      | Switch to a different peer identity from a previous session                   |
| `check_messages` | Check WebSocket connection status                                            |

## CLI

Inspect broker state and send messages from the command line.

**Required flags** for every command:

| Flag | Description |
|------|-------------|
| `--broker-url <url>` | Broker address, e.g. `http://10.0.0.5:7899` |
| `--api-key <key>` | Broker access key |

**Optional flag** (required for group-scoped commands):

| Flag | Description |
|------|-------------|
| `--group-secret <secret>` | Group secret — needed for `peers`, `send`, `group-doc` |

**Commands:**

```bash
# Broker health
bun cli.ts --broker-url http://10.0.0.5:7899 --api-key secret status

# List all groups (API key only, no group secret needed)
bun cli.ts --broker-url http://10.0.0.5:7899 --api-key secret groups

# Group-scoped commands
bun cli.ts --broker-url http://10.0.0.5:7899 --api-key secret --group-secret mygroup peers
bun cli.ts --broker-url http://10.0.0.5:7899 --api-key secret --group-secret mygroup group-doc
bun cli.ts --broker-url http://10.0.0.5:7899 --api-key secret --group-secret mygroup send alice Hello!

# Broker control
bun cli.ts --broker-url http://10.0.0.5:7899 --api-key secret kill-broker
```

## MCP Tools (new in this version)

| Tool | Description |
|------|-------------|
| `whoami` | Show your peer ID, role, summary, CWD |
| `set_role` | Set your role (e.g. `developer`, `tester`, `manager`) |
| `get_group_doc` | Fetch the group's shared Markdown doc |
| `set_group_doc` | Publish a Markdown doc as the group doc (manager role required) |
| `generate_group_doc` | Generate a team-doc template from current online members |

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

| Variable         | Description                                 |
| ---------------- | ------------------------------------------- |
| `OPENAI_API_KEY` | Enables auto-summary via `gpt-4o-mini`      |

## Groups

Groups are the core isolation mechanism in claude-peers. A group is a virtual namespace on the broker: peers sharing the same `CLAUDE_PEERS_GROUP_SECRET` can see and message each other, while peers with different secrets are completely hidden from one another — **even when registered against the same broker and API key**.

### How it works

- When an instance registers, the broker derives a `group_id` by hashing the group secret with SHA-256 and storing only the hash. The plaintext secret never reaches the broker.
- Every query (`list_peers`, `send_message`, message delivery) is filtered by the caller's `group_id`. A peer in group A literally cannot enumerate, address, or receive from a peer in group B.
- Peer IDs are unique **within a group** (`UNIQUE(id, group_id)`). The same custom ID — e.g. `review-bot` — can be used independently in different groups without conflict.
- If two different secrets ever hashed to the same `group_id` (astronomically unlikely), the broker refuses the later registration with `Group secret mismatch` rather than silently merging the groups.

### Typical use cases

| Scenario | Recommended setup |
| -------- | ----------------- |
| One team, shared project | All members share one secret, e.g. `team-alpha` |
| Multiple projects, same broker | One secret per project, e.g. `project-foo`, `project-bar` |
| Dev vs. production separation | Distinct secrets per environment, e.g. `dev-shared`, `staging-shared` |
| Pair programming / review partner | Ad-hoc secret between two people |
| Single user, multiple contexts | Separate secrets for work/personal sessions |

### Setting up a group

Pick a secret — any string works, but treat it like a password. All members of the group must use the exact same secret character-for-character.

```bash
# Machine 1 — Alice
claude mcp add --scope user --transport stdio claude-peers \
  -e CLAUDE_PEERS_BROKER_URL=http://10.0.0.5:7899 \
  -e CLAUDE_PEERS_API_KEY=my-secret-key-123 \
  -e CLAUDE_PEERS_GROUP_SECRET=team-alpha \
  -- bun ~/claude-peers-mcp/server.ts

# Machine 2 — Bob (same CLAUDE_PEERS_GROUP_SECRET → same group as Alice)
claude mcp add --scope user --transport stdio claude-peers \
  -e CLAUDE_PEERS_BROKER_URL=http://10.0.0.5:7899 \
  -e CLAUDE_PEERS_API_KEY=my-secret-key-123 \
  -e CLAUDE_PEERS_GROUP_SECRET=team-alpha \
  -- bun ~/claude-peers-mcp/server.ts
```

### Running in multiple groups from one machine

You may want a single developer to participate in several groups at once (e.g. a team group plus a private review group). Register each as a separate MCP server under a distinct name:

```bash
# Team group
claude mcp add --scope user --transport stdio claude-peers-team \
  -e CLAUDE_PEERS_GROUP_SECRET=team-alpha \
  -e CLAUDE_PEERS_BROKER_URL=http://10.0.0.5:7899 \
  -e CLAUDE_PEERS_API_KEY=my-secret-key-123 \
  -- bun ~/claude-peers-mcp/server.ts

# Personal review group
claude mcp add --scope user --transport stdio claude-peers-review \
  -e CLAUDE_PEERS_GROUP_SECRET=my-private-review \
  -e CLAUDE_PEERS_BROKER_URL=http://10.0.0.5:7899 \
  -e CLAUDE_PEERS_API_KEY=my-secret-key-123 \
  -- bun ~/claude-peers-mcp/server.ts
```

Each instance registers independently, gets its own peer ID within its group, and maintains its own WebSocket connection.

### Scoping within a group

Once you're in a group, `list_peers` further narrows results with the `scope` parameter:

- `group` — every active peer in your group (all machines, all directories)
- `directory` — only peers whose working directory and hostname match yours
- `repo` — only peers sharing the same git repository root (works across hosts)

This lets a single group contain many projects without visual clutter: ask for `repo` scope and you see only sessions working on the same codebase.

### Notes and caveats

- **Secrecy matters.** Anyone who knows both the API key and a group secret can join that group, read summaries, and send messages to its peers. Treat both as credentials. Never commit them to git — use `.mcp.json.example` and environment variables.
- **Changing the secret starts a new group.** If you edit `CLAUDE_PEERS_GROUP_SECRET`, the derived `group_id` changes, and you become a brand-new peer in an empty (or new) group. Your previous identity is not migrated; any custom ID set via `set_id` must be set again in the new group.
- **Group membership has roles.** Each peer has a `role` field (default `unknown`). Peers self-assign their role once via `set_role`; after that only a `manager` can change it. The group doc (`set_group_doc`) is writable by managers only. Every peer in a group sees every other peer's summary, `cwd`, hostname, and role, and can message any of them.
- **Session files are group-scoped.** Session state in `~/.claude-peers/sessions/` records the `group_id` it was registered under. Changing groups on the same directory simply writes a new session file; old ones are ignored and cleaned up after 7 days.
- **Empty groups are cleaned automatically.** When the last peer in a group unregisters or ages out as stale, the broker removes the group row during its hourly cleanup pass. The group is re-created transparently on the next registration with that secret.
- **Message history is group-scoped.** Messages are stored with their sender's `group_id` and only delivered within that group. Moving a peer to a new group does not carry over undelivered messages from the old one.

## Session Persistence

Peer identity (ID + token) is automatically saved to `~/.claude-peers/sessions/`. When you restart Claude Code in the same directory with the same group secret, the MCP server reclaims the previous session — your peer ID stays the same.

- **Custom ID:** Use `set_id` to assign a memorable, stable name to your instance (e.g. `my-review-bot`). Format: 1–32 lowercase letters, digits, or hyphens. IDs are unique within your group — the same ID can be reused independently in a different group. The custom ID persists across restarts.
- **Switch identity:** If you run multiple Claude Code sessions in the same directory (e.g. one for coding and one for review), the MCP server auto-resumes the most recently used session. Use `switch_id` to list available sessions and switch to a different one.
- **Stale cleanup:** Session files older than 7 days are automatically cleaned up.

## Auto-summary

If `OPENAI_API_KEY` is set, each instance generates a brief summary on startup describing what you're likely working on (based on directory, git branch, recent files). Other instances see this when they call `list_peers`. Without it, Claude sets its own summary via `set_summary`.

## Troubleshooting

**Broker startup fails with a SQLite schema error**

Typical messages: `no such column: instance_token`, `table peers has no column named hostname`, or `FOREIGN KEY constraint failed` during startup. These mean the on-disk database was created by an older version and the auto-migration can't reconcile it. The fastest fix is to wipe the database — peers re-register automatically, so no real state is lost:

```bash
# Stop any running broker first
kill $(pgrep -f 'bun.*broker\.ts') 2>/dev/null

# Remove DB + WAL/SHM sidecar files (path depends on your config;
# default is ~/.claude-peers.db, or whatever CLAUDE_PEERS_DB points to)
rm -f ~/.claude-peers.db ~/.claude-peers.db-wal ~/.claude-peers.db-shm

# Restart
CLAUDE_PEERS_API_KEY=your-key bun broker.ts
```

If you set a custom `CLAUDE_PEERS_DB`, substitute that path. After the broker is back up, every connected MCP server will re-register on its next heartbeat — custom peer IDs set via `set_id` are preserved in the per-host session files under `~/.claude-peers/sessions/` and will be reclaimed automatically.

**MCP server fails with "Missing required env vars"**

All three environment variables are required: `CLAUDE_PEERS_BROKER_URL`, `CLAUDE_PEERS_API_KEY`, `CLAUDE_PEERS_GROUP_SECRET`. Check your `claude mcp add` command or `.mcp.json` config.

**WebSocket keeps reconnecting**

- Verify the broker is running and reachable: `curl http://<broker-host>:7899/health?api_key=your-key`
- Check that `CLAUDE_PEERS_API_KEY` matches between broker and client
- If the broker was restarted, the MCP server will first try `/resume` to reclaim the old session (preserving peer ID), then fall back to re-registering as a last resort

**MCP server connected but tools not available in Claude session**

The broker shows "WS connected" and `/mcp` shows "Connected", but `list_peers` etc. are not callable:

- Restart Claude Code — MCP tools sometimes fail to load on first connection
- Verify server.ts runs correctly standalone: `CLAUDE_PEERS_BROKER_URL=... CLAUDE_PEERS_API_KEY=... CLAUDE_PEERS_GROUP_SECRET=... bun server.ts 2>&1`
- Check that all log lines appear (CWD, Git root, Hostname, Broker, Registered, WebSocket connected, MCP connected)

**Peers can't see each other**

- Verify both instances use the **exact same** `CLAUDE_PEERS_GROUP_SECRET`
- Confirm the broker is reachable from both hosts
- Check that both instances registered successfully (look for `Registered as peer` in stderr logs)
