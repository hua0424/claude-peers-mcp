# Server Stability & Peer Identity Optimization

## Summary

Optimize the local MCP server (server.ts) for connection resilience, peer identity persistence, and peer ID management. Fix the reconnect bug, add session persistence, and provide tools for custom/switchable peer IDs.

## Requirements

- Fix reconnect bug: try old token before re-registering on broker restart
- Persist peer identity (peer_id + token) to local files, survive both server.ts and broker restarts
- Auto-resume: on startup, find and reclaim a previous session matching cwd + group (if no active WS)
- `set_id` tool: set a custom peer ID (broker validates no conflict)
- `switch_id` tool: switch to a different existing peer ID (re-associate this session)
- `/resume` broker endpoint: validate token + confirm no active WS before allowing resume
- Graceful degradation: tools return friendly messages when broker is unreachable

## Session Persistence

### Session file structure

Each peer session is saved to `~/.claude-peers/sessions/{peer_id}.json`:

```json
{
  "peer_id": "abc12345",
  "instance_token": "a1b2c3...64chars",
  "cwd": "/home/user/project",
  "group_id": "f8e7d6c5a4b3c2d1",
  "hostname": "my-machine",
  "created_at": "2026-04-10T12:00:00Z",
  "last_used": "2026-04-10T15:30:00Z"
}
```

### Startup flow

```
server.ts starts
  │
  ├─ Scan ~/.claude-peers/sessions/*.json
  │  Filter by: cwd matches AND group_id matches
  │
  ├─ For each matching session file (newest last_used first):
  │    POST /resume {instance_token}
  │    ├─ 200 OK (token valid, no active WS) → claim it, done ✅
  │    ├─ 409 Conflict (token valid, WS active) → skip, try next
  │    └─ 401 Unauthorized (token invalid) → delete stale file, try next
  │
  └─ No session reclaimed → POST /register (new random ID) → save new session file
```

### Shutdown flow

- Clean shutdown (SIGINT/SIGTERM): unregister from broker, but **keep session file** (allows future resume)
- Session files older than 7 days with no successful resume are cleaned up on startup

## Broker Changes

### New endpoint: `POST /resume`

Request:
```json
{
  "instance_token": "a1b2c3..."
}
```

Response:
- `200 OK` with `{"id": "abc12345", "instance_token": "a1b2c3..."}` — token valid, no active WS, session resumed. Broker updates `last_seen`.
- `409 Conflict` with `{"error": "Peer has active connection"}` — token valid but another WS is connected (someone else is using this session).
- `401 Unauthorized` with `{"error": "Invalid token"}` — token not found in DB.

### Modified endpoint: `POST /set-id`

New endpoint for changing peer ID.

Request (authenticated via Bearer token):
```json
{
  "new_id": "my-custom-id"
}
```

Response:
- `200 OK` with `{"id": "my-custom-id"}` — ID updated. Broker updates `peers.id` and all references.
- `409 Conflict` with `{"error": "ID already taken"}` — another peer has this ID.
- `400 Bad Request` with `{"error": "Invalid ID format"}` — ID must be 1-16 lowercase alphanumeric characters.

Implementation: broker checks uniqueness within the same group, updates the peer record's `id` field, migrates undelivered messages, and updates the WebSocket connection pool mapping.

### Modified `/register` behavior

When registering, if a peer with the same hostname + pid already exists (re-registration), the old peer's session file on the client may become stale. The broker deletes the old peer record as before, but the old session file is handled client-side (orphan cleanup on next startup).

### Modified `/unregister` behavior

`/unregister` no longer deletes the peer record. Instead it sets `status = 'dormant'`, allowing future `/resume` to revive the session. The client keeps its session file for later reuse.

Peers table change:
```sql
ALTER TABLE peers ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
-- status: 'active' (registered + may have WS) | 'dormant' (cleanly disconnected, resumable)
```

- `/unregister`: sets `status = 'dormant'`, closes WS
- `/resume`: sets `status = 'active'`, returns peer info
- `/list-peers`: only returns `status = 'active'` peers
- Stale cleanup: deletes peers with `last_seen` older than 24h regardless of status

## Server.ts Changes

### Reconnect fix

Current bug: after 3 WS failures, server.ts calls `/register` (new ID). 

Fixed flow:
```
WS disconnects
  │
  ├─ Attempt WS reconnect with current token (exponential backoff)
  │  ├─ WS connects → resume OK ✅
  │  └─ WS fails (token rejected or broker down)
  │
  ├─ After 3 failures: try POST /resume with current token
  │  ├─ 200 OK → token still valid, retry WS connect
  │  └─ 401 → token invalid (DB wiped), re-register with /register
  │
  └─ Only /register as last resort → new ID, save new session file
```

### New MCP tools

**`set_id`** — Set a custom peer ID for this session.

```
Tool: set_id
Input: { id: string }
Action: POST /set-id { new_id: id } with Bearer token
Success: Update local session file with new ID (rename file), return "ID changed to: {id}"
Failure: Return error ("ID already taken" or "Invalid format")
```

**`switch_id`** — Switch to a different peer identity. Useful when startup auto-resumed the wrong session.

```
Tool: switch_id
Input: { id: string }
Action:
  1. Find session file for target ID in ~/.claude-peers/sessions/{id}.json
  2. POST /resume with target session's token
     - 200 OK → unregister current peer (set dormant), adopt target identity
     - 409 → "Peer {id} has an active connection, cannot switch"
     - 401 → "Session for {id} not found or expired"
  3. Update local state (myId, myToken), reconnect WS with new token
  4. Rename/update session files
Success: "Switched to peer {id}"
```

### Graceful degradation

All tool handlers wrap broker calls with a try/catch that returns user-friendly messages:

- Broker unreachable: "Broker is not reachable. Messages and peer discovery are temporarily unavailable."
- Auth failure (401): "Authentication failed. Check your API key and group secret."
- Other errors: "Broker error: {brief message}. Will retry automatically."

The WebSocket reconnect log messages are also simplified (no raw stack traces).

## File Changes

| File | Changes |
|------|---------|
| `broker.ts` | Add `status` column to peers table; add `/resume` endpoint; add `/set-id` endpoint; modify `/unregister` to set dormant; modify `/list-peers` to filter active only; modify stale cleanup to handle dormant peers |
| `server.ts` | Add session persistence (save/load/scan); fix reconnect flow; add `set_id` and `switch_id` tools; add graceful error handling; clean up stale session files on startup |
| `shared/types.ts` | Add `ResumeRequest`, `ResumeResponse`, `SetIdRequest`, `SetIdResponse`, `SwitchIdRequest` types; add `status` to `Peer` |

## Error Handling

| Scenario | Handling |
|----------|----------|
| Startup, matching session found, resume succeeds | Use existing peer ID, update last_used |
| Startup, matching session found, WS active (409) | Skip, try next session file |
| Startup, matching session found, token invalid (401) | Delete stale file, try next |
| Startup, no session found | Register new peer, save session file |
| Broker restart, DB intact | WS reconnect with old token succeeds |
| Broker restart, DB wiped | /resume fails 401 → re-register |
| set_id, ID taken | Return "ID already taken by another peer" |
| set_id, invalid format | Return "ID must be 1-16 lowercase alphanumeric" |
| switch_id, target active | Return "Peer {id} has an active connection" |
| switch_id, target not found | Return "No local session found for peer {id}" |
| Tool call, broker unreachable | Return friendly message, no stack trace |
