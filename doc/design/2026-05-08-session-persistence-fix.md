# Session Persistence Fix — Design Document

> Date: 2026-05-08
> Issue: After long idle periods (12h+), peer reconnects with a random ID instead of the previously set custom ID. Immediate reconnect after set_id works fine.
> Review: code-reviewer agent (2026-05-08). Incorporated feedback: replaced raw `ws.close()` with `/disconnect` HTTP endpoint to eliminate race condition.

## Background

A peer's identity (custom ID set via `set_id`) is stored in two places:
- **Broker** (SQLite `peers` table) — the canonical record, referenced by `instance_token`
- **Client** (`~/.claude-peers/sessions/${group_id}_${peer_id}.json`) — cached session for `/resume` on restart

The two must agree. When they diverge, the peer loses its identity.

## Root Cause Analysis

### Primary Cause: `/unregister` on clean shutdown

When the MCP server process exits (SIGINT/SIGTERM), `server.ts:969-971` calls the broker's `/unregister` endpoint:

```typescript
// server.ts cleanup handler
if (myToken) {
  await brokerFetch("/unregister", {});
}
```

The broker's `handleUnregister` (`broker.ts:605`) **permanently deletes the peer row**:

```typescript
deletePeerByToken.run(callerPeer.instance_token);
```

But the client-side session file is **never deleted during shutdown**.

**Result on next startup:**

1. `tryResumeSession()` finds the session file with the old `instance_token`
2. Calls `POST /resume` → broker returns **401** ("Invalid token") because the peer row was deleted
3. 401 handler deletes the session file (`server.ts:882`)
4. Falls through to `register()` → generates a **random** 8-character ID via `generatePeerId()`

This explains why "immediate reconnect works": no shutdown means no `/unregister`, so the peer row survives and `/resume` succeeds.

### Secondary Cause: `last_seen` staleness during long idle

`last_seen` is only updated in two places:
- HTTP `authenticateRequest` (`broker.ts:832`) — on every authenticated API call
- WS `close` handler (`broker.ts:1073`) — when the WebSocket disconnects

It is **NOT** updated during:
- WS authentication (`broker.ts:1013-1053`) — the first message after reconnect
- Normal WS operation — heartbeats, message pushes

The broker's `cleanStale()` runs every hour (`broker.ts:389`) and deletes peers where `last_seen > 24h`. If a peer stays connected via WS but makes no HTTP tool calls for 24+ hours, `cleanStale` can delete it. The WS is forcibly closed (`broker.ts:369`), and the client's `scheduleReconnect` gets a 401 from `/resume` → `register()` → random ID.

## Design Decisions

### Why not just remove `/unregister` and rely on `ws.close()`?

`ws.close(1000)` sends a close frame **asynchronously**. The cleanup handler calls `process.exit(0)` immediately after, which may kill the process before the close frame reaches the broker. If the close frame is lost:

- Broker's WS close handler never fires
- Peer row stays "active" (not "dormant")
- Next startup: `/resume` returns **409** ("Peer is already active") → `register()` → random ID

The current code avoids this race because `/unregister` is a synchronous HTTP call that completes before `process.exit()`. The fix needs to preserve that HTTP-level reliability.

### Decision: New `/disconnect` endpoint

Add a `POST /disconnect` HTTP endpoint that does what the WS close handler does (set dormant + update `last_seen`) but does NOT delete the peer row. The cleanup handler calls this via HTTP (reliable, synchronous) instead of `/unregister`.

This explicitly communicates intent: "I'm disconnecting cleanly, preserve my identity for later resume."

The existing `/unregister` endpoint is kept for the `switch_id` tool (`server.ts:676`), which intentionally abandons an old identity and deletes its session file.

## Changes

### 1. Add `/disconnect` endpoint to broker (broker.ts)

**New endpoint**: `POST /disconnect` — authenticated, sets peer to "dormant" and updates `last_seen`. Does NOT delete the row.

```typescript
// broker.ts — new function
function handleDisconnect(callerPeer: Peer): void {
  updatePeerStatus.run("dormant", new Date().toISOString(), callerPeer.instance_token);
  const peerWs = wsPool.get(callerPeer.instance_token);
  wsPool.delete(callerPeer.instance_token);
  if (peerWs) peerWs.close(4000, "Peer disconnected");
}

// In the router, after /unregister case:
case "/disconnect":
  handleDisconnect(callerPeer);
  return Response.json({ ok: true });
```

### 2. Call `/disconnect` from client cleanup (server.ts)

**Change**: Replace `brokerFetch("/unregister", {})` with `brokerFetch("/disconnect", {})`.

```typescript
// Before (server.ts cleanup handler)
if (myToken) {
  try {
    await brokerFetch("/unregister", {});
    log("Unregistered from broker");
  } catch { /* Best effort */ }
}

// After
if (myToken) {
  try {
    await brokerFetch("/disconnect", {});
    log("Disconnected from broker");
  } catch { /* Best effort */ }
}
```

### 3. Update `last_seen` on WS auth (broker.ts)

**Change**: In the WS `message` handler, after successful auth, update `last_seen`.

```typescript
// broker.ts WS message handler, after wsPool.set()
wsPool.set(peer.instance_token, ws);
updateLastSeen.run(new Date().toISOString(), peer.instance_token);  // NEW
ws.send(JSON.stringify({ type: "auth_ok", id: peer.id }));
```

**Rationale**: Ensures `last_seen` stays current whenever a peer reconnects via WS, closing one path where `cleanStale` could delete an active peer.

## Testing

1. Set custom ID, trigger SIGTERM, restart — verify whoami shows the custom ID (not random)
2. Set custom ID, kill broker, restart broker — verify peer reconnects with custom ID
3. Regression: `bun test` — all tests pass

## Files Changed

- `broker.ts` — add `POST /disconnect` endpoint + update `last_seen` on WS auth
- `server.ts` — replace `/unregister` with `/disconnect` in cleanup handler
