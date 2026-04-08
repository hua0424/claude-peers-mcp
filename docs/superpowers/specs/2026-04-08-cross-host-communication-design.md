# Cross-Host Communication for claude-peers

## Summary

Extend claude-peers from localhost-only to cross-host communication. A self-hosted broker on a public server allows Claude Code instances on different machines to discover each other and exchange messages in real time via WebSocket push.

## Requirements

- Self-hosted central relay broker, accessible over the network
- Dual-layer authentication: API Key (broker access) + Group Secret (group membership)
- Group isolation: only instances sharing the same group secret can discover and communicate
- Same machine can have multiple instances in different groups (configured per `.mcp.json`)
- WebSocket long connection replaces HTTP polling for message push
- No backward compatibility with localhost-only mode; local use is just `CLAUDE_PEERS_BROKER_URL=http://127.0.0.1:7899`

## Architecture

```
  Host A                            Public Broker Server                Host B
  ┌─────────────────┐               ┌──────────────────────────┐       ┌─────────────────┐
  │ server.ts (MCP) │               │ broker.ts                │       │ server.ts (MCP) │
  │  (send/list)    │──HTTP──────>  │ 0.0.0.0:7899             │  <────│  (send/list)    │
  │                 │<──WS push──── │ ├─ HTTP API (commands)    │ ────> │                 │
  └─────────────────┘               │ └─ WebSocket (push)      │       └─────────────────┘
                                    │                          │
                                    │ SQLite                   │
                                    │ ├─ groups                │
                                    │ ├─ peers                 │
                                    │ └─ messages              │
                                    └──────────────────────────┘
```

- **HTTP**: all active commands (register, send-message, list-peers, set-summary, unregister)
- **WebSocket**: broker → instance message push only (replaces polling)

### Multi-group on one machine

```
Host X
├── /project1/.mcp.json  GROUP_SECRET=team-alpha  →  group-1
├── /project2/.mcp.json  GROUP_SECRET=team-beta   →  group-2
└── /project3/.mcp.json  GROUP_SECRET=team-alpha  →  group-1 (same as project1)
```

Group membership is determined entirely by `CLAUDE_PEERS_GROUP_SECRET` in each instance's MCP config.

## Authentication & Registration

### Dual-layer auth

| Layer | Purpose | When used |
|-------|---------|-----------|
| API Key (`CLAUDE_PEERS_API_KEY`) | Gates access to the broker itself | `/register` endpoint |
| Group Secret (`CLAUDE_PEERS_GROUP_SECRET`) | Determines group membership | `/register` endpoint |
| Instance Token | Authenticates all subsequent requests | All other endpoints + WebSocket |

### Database schema changes

**`groups` table (new):**

| Field | Type | Description |
|-------|------|-------------|
| `group_id` | TEXT PK | Derived from group_secret: `SHA-256(secret).slice(0, 16)` |
| `group_secret_hash` | TEXT NOT NULL | Full SHA-256 hash of group_secret for verification |
| `created_at` | TEXT NOT NULL | ISO timestamp |

Groups are auto-created on first registration with a given secret.

**`peers` table (modified):**

| Field | Change | Description |
|-------|--------|-------------|
| `group_id` | Added, TEXT NOT NULL | Group this peer belongs to |
| `instance_token` | Added, TEXT UNIQUE | Token issued by broker for this peer |
| `hostname` | Added, TEXT NOT NULL | Machine hostname (PIDs are not unique across hosts) |
| `tty` | Removed | Not meaningful across hosts |

### Registration flow

```
Instance                              Broker
   │                                     │
   │  POST /register                     │
   │  {api_key, group_secret,            │
   │   pid, cwd, git_root,              │
   │   summary, hostname}               │
   │ ──────────────────────────────────>  │
   │                                     │  1. Verify api_key matches configured key
   │                                     │  2. hash(group_secret) → group_id
   │                                     │  3. Verify secret hash (or create group if first use)
   │                                     │  4. Generate instance_token
   │                                     │  5. Insert peer record
   │  {peer_id, instance_token}          │
   │ <──────────────────────────────────  │
   │                                     │
   │  WS /ws?token=<instance_token>      │
   │ <═══════════════════════════════════>│  6. Establish WebSocket connection
```

### Auth rules

- `/register` is the only endpoint that uses `api_key` + `group_secret` instead of `instance_token`
- All other HTTP endpoints require `Authorization: Bearer <instance_token>` header
- WebSocket connection requires `token` query parameter
- Broker resolves token → peer_id + group_id → all operations scoped to that group automatically
- No need for callers to pass group parameters; isolation is enforced server-side

## WebSocket & Message Push

### Connection management

After registration, the instance connects:

```
WS ws://<broker_host>:7899/ws?token=<instance_token>
```

Broker validates the token, looks up peer_id and group_id, and adds the WebSocket to an in-memory connection pool (`Map<PeerId, ServerWebSocket>`).

### Message delivery

```
Instance A                     Broker                         Instance B
    │                            │                                │
    │ POST /send-message         │                                │
    │ {to_id, text}              │                                │
    │ Bearer <tokenA>            │                                │
    │ ─────────────────────────> │                                │
    │                            │ 1. Verify tokenA → peerA, groupX
    │                            │ 2. Verify to_id is in groupX   │
    │                            │ 3. Write to messages table      │
    │                            │ 4. Check connection pool        │
    │                            │                                │
    │                            │──── WS push {from_id,text} ──> │  Online: push directly
    │                            │     Mark delivered=1            │
    │                            │                                │
    │  {ok: true}                │                                │
    │ <───────────────────────── │                                │
```

If target is **offline** (no WebSocket connection): message stored in DB with `delivered=0`. When the target reconnects, broker immediately pushes all undelivered messages.

### Heartbeat & disconnect detection

- **WebSocket ping/pong**: broker sends ping every 30 seconds (Bun handles pong automatically)
- **Timeout cleanup**: no pong within 60 seconds → broker closes connection, marks peer offline
- **Auto-reconnect**: server.ts uses exponential backoff on disconnect (1s → 2s → 4s → max 30s)
- On reconnect with invalid token: re-execute full `/register` flow

### Removed endpoints

| Removed | Replaced by |
|---------|-------------|
| `POST /heartbeat` | WebSocket ping/pong |
| `POST /poll-messages` | WebSocket push |

`GET /health` is kept for CLI health checks. Health endpoint requires `api_key` query parameter.

### list_peers scope semantics

The existing `scope` parameter (`machine`, `directory`, `repo`) changes meaning in cross-host context:

| Scope | Old behavior (localhost) | New behavior (cross-host) |
|-------|--------------------------|---------------------------|
| `machine` | All peers on this computer | All peers in this group (regardless of host) |
| `directory` | Same CWD | Same CWD + same hostname |
| `repo` | Same git_root | Same git_root (across hosts, useful for shared repos) |

Rename `machine` to `group` in the tool definition. Keep `directory` and `repo` as-is but their filtering includes hostname awareness where needed.

## File Change Scope

| File | Changes |
|------|---------|
| `broker.ts` | Rewrite. Listen on `0.0.0.0`, groups table, API Key verification, instance_token auth middleware, WebSocket endpoint + connection pool, all queries scoped by group_id, ping/pong heartbeat, disconnect cleanup |
| `server.ts` | Rewrite startup. Remove `ensureBroker()`, read broker URL / group secret / API key from env, register then establish WebSocket, auto-reconnect logic, remove HTTP polling |
| `shared/types.ts` | Update types. Peer adds `group_id`, `instance_token`, `hostname`; remove `tty`. RegisterRequest adds `api_key`, `group_secret`, `hostname`; remove HeartbeatRequest, PollMessagesRequest/Response |
| `cli.ts` | Support `CLAUDE_PEERS_BROKER_URL` + `CLAUDE_PEERS_API_KEY` + `CLAUDE_PEERS_GROUP_SECRET`. CLI temporarily registers as a peer for operations, unregisters after. `kill-broker` only needs API Key |
| `shared/summarize.ts` | No changes |
| `index.ts` | No changes |

## Environment Variables

### Broker side

| Variable | Required | Description |
|----------|----------|-------------|
| `CLAUDE_PEERS_PORT` | No (default 7899) | Listen port |
| `CLAUDE_PEERS_DB` | No (default `~/.claude-peers.db`) | SQLite path |
| `CLAUDE_PEERS_API_KEY` | Yes | Broker access key |

### Instance side (server.ts / cli.ts)

| Variable | Required | Description |
|----------|----------|-------------|
| `CLAUDE_PEERS_BROKER_URL` | Yes | Broker address, e.g. `http://10.0.0.5:7899` |
| `CLAUDE_PEERS_API_KEY` | Yes | Must match broker's configured key |
| `CLAUDE_PEERS_GROUP_SECRET` | Yes | Group secret; determines group membership |

## Error Handling

| Scenario | Handling |
|----------|----------|
| Broker unreachable | server.ts fails to start, MCP does not connect, logs error |
| API Key wrong | `/register` returns 401, server.ts fails to start |
| Group Secret first use | Auto-create group, register normally |
| WebSocket disconnect | Exponential backoff reconnect (1s→2s→4s→...→30s), push backlog on reconnect |
| Send to nonexistent peer | `{ok: false, error: "Peer not found"}` |
| Send to peer in different group | `{ok: false, error: "Peer not found"}` (peer invisible from caller's group) |
| Instance token invalid/expired | 401 response, server.ts re-executes `/register` |
| Broker restart | All WebSockets drop → instances auto-reconnect → token invalid → re-register |
